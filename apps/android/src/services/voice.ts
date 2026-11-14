import { NativeModules, PermissionsAndroid, Platform } from 'react-native'
import { getActiveLanguage, strings } from '../locales/i18n'
import { supportsVoiceInput, transcribeVoice } from '../state/store'

export type VoiceCaptureResult = {
  path: string
  base64: string
  bytes: number
  durationMs: number
}

type NativeRecorder = {
  start(): Promise<boolean>
  stop(): Promise<VoiceCaptureResult>
  cancel(): Promise<boolean>
}

function nativeRecorder(): NativeRecorder | undefined {
  const module = (NativeModules as Record<string, unknown>).DshRemoteAudioRecorder as NativeRecorder | undefined
  return module
}

/** Recording needs the rebuilt Android module; older APKs simply hide the entry. */
export function voiceCaptureAvailable(): boolean {
  return Platform.OS === 'android' && nativeRecorder() !== undefined
}

/** Ask for the microphone permission once; a denied request keeps the entry disabled. */
export async function requestVoicePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  if (typeof Platform.Version === 'number' && Platform.Version < 23) return true
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: strings.chat.voiceInput,
        message: strings.chat.voicePermissionMessage,
        buttonPositive: strings.chat.voicePermissionAllow,
        buttonNegative: strings.common.cancel,
      },
    )
    return granted === PermissionsAndroid.RESULTS.GRANTED
  } catch {
    return false
  }
}

export async function startVoiceCapture(): Promise<void> {
  const recorder = nativeRecorder()
  if (recorder === undefined) throw new Error(strings.chat.voiceUnavailable)
  await recorder.start()
}

export async function cancelVoiceCapture(): Promise<void> {
  await nativeRecorder()?.cancel().catch(() => undefined)
}

/** Language hint for the recognizer; the Host defaults to automatic detection. */
function voiceLanguage(): string | undefined {
  const language = getActiveLanguage()
  return language === 'zh-CN' ? 'zh' : language === 'zh-TW' ? 'zh' : language.slice(0, 2)
}

/**
 * Stops the recording and asks the Host to transcribe it through the official
 * experimental speech namespace. Audio never leaves the computer and the phone
 * holds no API key.
 */
export async function stopVoiceCaptureAndTranscribe(): Promise<string> {
  const recorder = nativeRecorder()
  if (recorder === undefined) throw new Error(strings.chat.voiceUnavailable)
  const capture = await recorder.stop()
  if (!supportsVoiceInput()) throw new Error(strings.chat.voiceUnavailable)
  return transcribeVoice(capture.base64, voiceLanguage())
}
