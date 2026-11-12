import * as ImagePicker from 'expo-image-picker'
import { strings as zhCN } from '../locales/i18n'
import type { ImageAttachmentLimits, ImageMediaType, PromptImage, RemoteSession } from '../types'

const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 4

/**
 * Capability defaults for a Harness session whose snapshot omits `imageLimits`.
 *
 * `imageLimits` is an optional projection: an absent value means "unknown", not "no
 * images". Falling back here keeps the camera/gallery actions reachable instead of
 * collapsing the attachment menu to Files only. The numbers mirror the image spec
 * already shared by the other image-capable backends (docs/acp-integration.md):
 * PNG/JPEG/WebP/GIF, 8 MiB per image, 4 images per message, 32 MiB total, 40 MP and
 * an 8192 px side. A projection that is present but explicitly unsupported still
 * hides the pickers, and a Host rejection at send time keeps the existing error.
 */
export const DEFAULT_HARNESS_IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 8 * 1024 * 1024,
  maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
  maxMessageImageBytes: 32 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 8_192,
  mediaTypes: IMAGE_MEDIA_TYPES,
}

export function sessionImageLimits(session: RemoteSession): ImageAttachmentLimits | undefined {
  const value = session.projections?.values?.imageLimits
  if (value === undefined || value === null) {
    // Harness snapshots often omit the projection; default to the documented image
    // capability. Other backends keep their current behavior (their own projections
    // are authoritative; missing means no extra attachment support). An explicitly
    // unsupported projection still parses to `undefined` in `parseImageLimits`.
    return session.backend === undefined || session.backend === 'harness'
      ? DEFAULT_HARNESS_IMAGE_LIMITS
      : undefined
  }
  return parseImageLimits(value)
}

function parseImageLimits(value: unknown): ImageAttachmentLimits | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const limits = value as Partial<ImageAttachmentLimits>
  if (!positiveNumber(limits.maxImageBytes)
    || !positiveNumber(limits.maxMessageImageBytes)
    || !positiveNumber(limits.maxImagePixels)
    || !positiveNumber(limits.maxImageDimension)
    || !Array.isArray(limits.mediaTypes)) return undefined
  const mediaTypes = limits.mediaTypes.filter((mediaType): mediaType is ImageMediaType =>
    typeof mediaType === 'string' && IMAGE_MEDIA_TYPES.includes(mediaType as ImageMediaType))
  if (mediaTypes.length === 0) return undefined
  return {
    maxImageBytes: limits.maxImageBytes,
    maxImagesPerMessage: positiveInteger(limits.maxImagesPerMessage)
      ? limits.maxImagesPerMessage
      : DEFAULT_MAX_IMAGES_PER_MESSAGE,
    maxMessageImageBytes: limits.maxMessageImageBytes,
    maxImagePixels: limits.maxImagePixels,
    maxImageDimension: limits.maxImageDimension,
    mediaTypes,
  }
}

export function sanitizeBase64(value: string): string {
  return value.replace(/\s+/g, '').replace(/^data:image\/[a-zA-Z+.-]+;base64,/, '')
}

export function promptImageFromAsset(asset: ImagePicker.ImagePickerAsset): PromptImage {
  if (asset.base64 === undefined || asset.base64 === null || asset.base64.length === 0) {
    throw new Error('missing-image-data')
  }
  const base64 = sanitizeBase64(asset.base64)
  if (base64.length === 0) throw new Error('missing-image-data')
  const mediaType = imageMediaType(asset.mimeType, asset.fileName ?? asset.uri, base64)
  if (mediaType === undefined) throw new Error('unsupported-image-type')
  return {
    uri: asset.uri,
    mediaType,
    data: base64,
    bytes: decodedBase64Bytes(base64),
    width: asset.width,
    height: asset.height,
    ...(asset.fileName === undefined || asset.fileName === null ? {} : { name: asset.fileName.split(/[\\/]/).at(-1)?.slice(0, 255) }),
  }
}

/** Build one staged image from base64 bytes read outside expo-image-picker (the document picker). */
export function promptImageFromBase64(input: {
  uri: string
  base64: string
  mimeType?: string
  name?: string
  width: number
  height: number
}): PromptImage {
  if (input.base64.length === 0) throw new Error('missing-image-data')
  const base64 = sanitizeBase64(input.base64)
  if (base64.length === 0) throw new Error('missing-image-data')
  const mediaType = imageMediaType(input.mimeType, input.name ?? input.uri, base64)
  if (mediaType === undefined) throw new Error('unsupported-image-type')
  return {
    uri: input.uri,
    mediaType,
    data: base64,
    bytes: decodedBase64Bytes(base64),
    width: input.width,
    height: input.height,
    ...(input.name === undefined ? {} : { name: input.name.split(/[\\/]/).at(-1)?.slice(0, 255) }),
  }
}

export function validatePromptImages(images: PromptImage[], limits?: ImageAttachmentLimits): string | undefined {
  if (limits === undefined) return undefined
  if (images.length > limits.maxImagesPerMessage) return zhCN.chat.tooManyImages(limits.maxImagesPerMessage)
  let totalBytes = 0
  for (const image of images) {
    const label = image.name ?? zhCN.chat.unnamedImage
    if (!limits.mediaTypes.includes(image.mediaType)) return zhCN.chat.unsupportedImage(label)
    if (image.bytes > limits.maxImageBytes) return zhCN.chat.imageTooLarge(label, formatBytes(limits.maxImageBytes))
    if (image.width > limits.maxImageDimension || image.height > limits.maxImageDimension) {
      return zhCN.chat.imageDimensionsTooLarge(label, limits.maxImageDimension)
    }
    if (image.width * image.height > limits.maxImagePixels) return zhCN.chat.imagePixelsTooLarge(label)
    totalBytes += image.bytes
  }
  return totalBytes > limits.maxMessageImageBytes
    ? zhCN.chat.imagesTooLarge(formatBytes(limits.maxMessageImageBytes))
    : undefined
}

export function sniffImageMediaType(base64: string): ImageMediaType | undefined {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('R0lGODlh') || base64.startsWith('R0lGODdh') || base64.startsWith('R0lGOD')) return 'image/gif'
  if (base64.startsWith('UklGR')) {
    try {
      const header = atob(base64.slice(0, 32))
      if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp'
    } catch {
      return 'image/webp'
    }
  }
  return undefined
}

export function imageMediaType(
  mimeType: string | undefined,
  name: string,
  base64?: string,
): ImageMediaType | undefined {
  const normalized = mimeType?.toLowerCase()
  if (normalized === 'image/x-png') return 'image/png'
  if (IMAGE_MEDIA_TYPES.includes(normalized as ImageMediaType)) return normalized as ImageMediaType
  const extension = name.split(/[?#]/, 1)[0]?.split('.').at(-1)?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (base64 !== undefined) return sniffImageMediaType(base64)
  return undefined
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.floor(bytes / (1024 * 1024))} MB`
    : `${Math.floor(bytes / 1024)} KB`
}

