import { readAsStringAsync } from 'expo-file-system/legacy'
import { strings } from '../locales/i18n'
import { recognizeImage, supportsAppApis } from '../state/store'

/** OCR needs the Host Windows app APIs (`app-api.v1`); older hosts hide the entry. */
export function imageOcrAvailable(): boolean {
  return supportsAppApis()
}

/**
 * Reads one local image and asks the computer to recognize its text with
 * Windows.Media.Ocr. The image never goes to a third-party service and the phone
 * holds no key.
 */
export async function extractTextFromImage(uri: string): Promise<string> {
  if (!supportsAppApis()) throw new Error(strings.chat.ocrUnavailable)
  const base64 = await imageUriToBase64(uri)
  const result = await recognizeImage(base64)
  return result.text.trim()
}

async function imageUriToBase64(uri: string): Promise<string> {
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',')
    if (comma >= 0) return uri.slice(comma + 1)
  }
  if (uri.startsWith('file:') || uri.startsWith('content:') || uri.startsWith('/')) {
    return readAsStringAsync(uri, { encoding: 'base64' })
  }
  // Remote http(s) images are loaded by the chat image provider, not readable here.
  throw new Error(strings.chat.ocrUnavailable)
}
