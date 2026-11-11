import { cacheDirectory, getContentUriAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy'
import * as IntentLauncher from 'expo-intent-launcher'
import { Image } from 'react-native'
import type { ImageMediaType } from '../../types'
import { sanitizeBase64, sniffImageMediaType } from '../chat-images'

/** `android.app.Activity.RESULT_OK`. */
const RESULT_OK = -1
/** `android.app.Activity.RESULT_CANCELED`. */
const RESULT_CANCELED = 0
/**
 * A handler that returns this soon with no result never really opened the image; the
 * emulator's Photos answers our FileProvider URI with "Editing is not supported"
 * after ~0.86 s. Kept at 2.5 s so slow devices/emulators still fall back instead of
 * looking unresponsive. Tradeoff: a real user who backs out within 2.5 s is treated
 * as "not supported" and sees the bundled editor once more (an extra step, never a
 * lost edit); a cancel after 2.5 s stays a plain cancel.
 */
const UNSUPPORTED_RETURN_MS = 2500
/** FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION. */
const GRANT_READ_WRITE = 1 | 2
const EDIT_ACTION = 'android.intent.action.EDIT'
const STREAM_EXTRA = 'android.intent.extra.STREAM'
const TITLE_EXTRA = 'android.intent.extra.TITLE'
const FALLBACK_FILE_NAME = 'image.jpg'

export type SystemImageEdit =
  | { kind: 'edited'; uri: string; base64: string; mediaType: ImageMediaType; width: number; height: number }
  | { kind: 'canceled' }
  /**
   * No installed editor, unreadable result, a revoked content-URI grant, or an editor
   * that bounced straight back without accepting the image. The caller then opens the
   * bundled canvas editor.
   */
  | { kind: 'unavailable' }

/**
 * Hand a staged image to the phone's own editor (ACTION_EDIT) so the user gets the
 * gallery app they already know (crop/rotate/filters/markup) without bundling one.
 *
 * The staged copy is exposed through the app's FileProvider with read+write grants,
 * and the Intent carries the content URI both as `data` and as EXTRA_STREAM plus a
 * display title, because some OEM galleries only look at EXTRA_STREAM. A real
 * ClipData URI list would need a native module and Expo does not expose one, so this
 * round keeps data + grant + EXTRA_STREAM; real-device gallery editors that accept
 * data+grant work as-is.
 *
 * Editors usually return a new URI in `result.data` (or EXTRA_STREAM), while some
 * modify the granted content URI in place, so every candidate is re-read and compared
 * with the bytes we staged. A RESULT_CANCELED without any result URI inside
 * UNSUPPORTED_RETURN_MS means the editor does not support this image (e.g. emulator
 * Photos, which bounces back at ~0.86 s) and we fall back to the bundled editor; a
 * cancel after UNSUPPORTED_RETURN_MS keeps the staged image untouched.
 */
export async function editImageWithSystemEditor(input: {
  uri: string
  mediaType: ImageMediaType
  /** Current staged bytes; used to detect in-place edits and no-op saves. */
  base64: string
  width: number
  height: number
}): Promise<SystemImageEdit> {
  let contentUri: string
  try {
    contentUri = input.uri.startsWith('content://') ? input.uri : await getContentUriAsync(input.uri)
  } catch {
    return { kind: 'unavailable' }
  }
  let result: IntentLauncher.IntentLauncherResult
  const startedAt = Date.now()
  try {
    result = await IntentLauncher.startActivityAsync(EDIT_ACTION, {
      data: contentUri,
      type: input.mediaType,
      flags: GRANT_READ_WRITE,
      // EXTRA_STREAM is what some OEM galleries resolve the image from. Read/write
      // grants cover both the data URI and this extra; no ClipData is attached.
      extra: { [STREAM_EXTRA]: contentUri, [TITLE_EXTRA]: stagedFileName(input.uri) },
    })
  } catch {
    // ActivityNotFoundException (no gallery editor) or a provider that refused the grant.
    return { kind: 'unavailable' }
  }
  const launchedMs = Date.now() - startedAt
  const stream = streamUri(result.extra)
  const returnedUri = typeof result.data === 'string' && result.data.length > 0 ? result.data : undefined
  let readAny = false
  for (const candidate of [returnedUri, stream, contentUri]) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const base64 = await readBase64(candidate)
    if (base64 === undefined) continue
    readAny = true
    if (base64 === input.base64) continue
    const mediaType = sniffImageMediaType(base64) ?? input.mediaType
    const dataUri = `data:${mediaType};base64,${base64}`
    const size = await imageSize(candidate) ?? await imageSize(dataUri)
    const uri = await persistPendingEdit(base64, mediaType) ?? dataUri
    return {
      kind: 'edited',
      uri,
      base64,
      mediaType,
      width: size?.width ?? input.width,
      height: size?.height ?? input.height,
    }
  }
  // Photos on the emulator rejects our FileProvider image and returns RESULT_CANCELED
  // without any result URI at ~0.86 s; anything inside UNSUPPORTED_RETURN_MS that came
  // back empty is "editor does not support this image", so let the caller silently open
  // the bundled editor instead of doing nothing. Read-back above already runs first, so
  // a quick return that wrote the file in place is still reported as `edited`.
  if (launchedMs < UNSUPPORTED_RETURN_MS && result.resultCode === RESULT_CANCELED && returnedUri === undefined && stream === undefined) {
    return { kind: 'unavailable' }
  }
  // A successful return we cannot read is an anomaly -> let the caller fall back.
  return result.resultCode === RESULT_OK && !readAny ? { kind: 'unavailable' } : { kind: 'canceled' }
}

/** Display title for EXTRA_TITLE; the staged URI ends with the picker's file name. */
function stagedFileName(uri: string): string {
  const raw = uri.split(/[\\/]/).pop()?.split(/[?#]/, 1)[0] ?? ''
  if (raw.length === 0) return FALLBACK_FILE_NAME
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** EXTRA_STREAM may arrive as a string or as a marshalled object exposing a `uri`. */
function streamUri(extra: object | undefined): string | undefined {
  if (extra === null || extra === undefined) return undefined
  const value = (extra as Record<string, unknown>)[STREAM_EXTRA]
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  const uri = (value as Record<string, unknown>).uri
  return typeof uri === 'string' ? uri : undefined
}

async function readBase64(uri: string): Promise<string | undefined> {
  try {
    const value = sanitizeBase64(await readAsStringAsync(uri, { encoding: 'base64' }))
    return value.length === 0 ? undefined : value
  } catch {
    // The legacy file API reads file:// and content:// URIs; providers can still refuse.
    return undefined
  }
}

/**
 * Cache the editor's result as a new staged file. A file URI keeps the tray image
 * and a later ACTION_EDIT pass cheap; the data URI is only a fallback.
 */
async function persistPendingEdit(base64: string, mediaType: ImageMediaType): Promise<string | undefined> {
  const directory = cacheDirectory
  if (directory === null) return undefined
  const extension = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : mediaType === 'image/gif' ? 'gif' : 'jpg'
  const uri = `${directory}pending-image-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`
  try {
    await writeAsStringAsync(uri, base64, { encoding: 'base64' })
    return uri
  } catch {
    return undefined
  }
}

function imageSize(uri: string): Promise<{ width: number; height: number } | undefined> {
  return new Promise(resolve => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve(undefined))
  })
}
