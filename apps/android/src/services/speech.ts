import { NativeModules } from 'react-native'
import { strings } from '../locales/i18n'
import { supportsAppApis, synthesizeSpeech } from '../state/store'

type NativePlayer = {
  play(base64: string): Promise<boolean>
  stop(): Promise<boolean>
}

function nativePlayer(): NativePlayer | undefined {
  return (NativeModules as Record<string, unknown>).DshRemoteAudioPlayer as NativePlayer | undefined
}

/** Read-aloud needs a Host with the Windows app APIs and the rebuilt player module. */
export function speechPlaybackAvailable(): boolean {
  return supportsAppApis() && nativePlayer() !== undefined
}

/**
 * Sends the text to the computer, which synthesizes a WAV with Windows SAPI and
 * returns it for local playback. Returns the estimated playback duration.
 */
export async function speakText(text: string): Promise<number> {
  const player = nativePlayer()
  if (player === undefined) throw new Error(strings.messageActions.unavailable)
  // The Host caps one synthesis request at 2000 characters.
  const audio = await synthesizeSpeech(text.slice(0, 2_000))
  await player.play(audio.audioBase64)
  return audio.durationMs > 0 ? audio.durationMs : 4_000
}

export async function stopSpeaking(): Promise<void> {
  await nativePlayer()?.stop().catch(() => undefined)
}
