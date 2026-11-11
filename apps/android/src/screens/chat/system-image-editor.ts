import { cacheDirectory, getContentUriAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy'
import * as IntentLauncher from 'expo-intent-launcher'
import { Image } from 'react-native'
import type { ImageMediaType } from '../../types'
import { sanitizeBase64, sniffImageMediaType } from '../chat-images'

/** `android.app.Activity.RESULT_OK`. */
const RESULT_OK = -1
/** FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION. */
const GRANT_READ_WRITE = 1 | 2
const EDIT_ACTION = 'android.intent.action.EDIT'
const STREAM_EXTRA = 'android.intent.extra.STREAM'

export type SystemImageEdit =
  | { kind: 'edited'; uri: string; base64: string; mediaType: ImageMediaType; width: number; height: number }
  | { kind: 'canceled' }
  /** No installed editor, unreadable result, or a revoked content-URI grant. */
  | { kind: 'unavailable' }

/**
 * Hand a staged image to the phone's own editor (ACTION_EDIT) so the user gets the
 * gallery app they already know (crop/rotate/filters/markup) without bundling one.
 *
 * The staged copy is exposed through the app's FileProvider with read+write grants.
 * Editors usually return a new URI in `result.data` (or EXTRA_STREAM), while some
 * modify the granted content URI in place, so both are re-read and compared with the
 * bytes we staged. Anything we cannot read or launch yields `unavailable` and the
 * caller falls back to the bundled canvas editor.
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
  try {
    result = await IntentLauncher.startActivityAsync(EDIT_ACTION, {
      data: contentUri,
      type: input.mediaType,
      flags: GRANT_READ_WRITE,
    })
  } catch {
    // ActivityNotFoundException (no gallery editor) or a provider that refused the grant.
    return { kind: 'unavailable' }
  }
  let readAny = false
  for (const candidate of [result.data, streamUri(result.extra), contentUri]) {
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
  // A successful return we cannot read is an anomaly -> let the caller fall back.
  return result.resultCode === RESULT_OK && !readAny ? { kind: 'unavailable' } : { kind: 'canceled' }
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
