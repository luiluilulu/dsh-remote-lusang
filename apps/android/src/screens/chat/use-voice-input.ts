import { useCallback, useEffect, useRef, useState } from 'react'
import { strings } from '../../locales/i18n'
import {
  cancelVoiceCapture,
  requestVoicePermission,
  startVoiceCapture,
  stopVoiceCaptureAndTranscribe,
  voiceCaptureAvailable,
} from '../../services/voice'
import { supportsVoiceInput } from '../../state/store'

export type VoiceInputPhase = 'idle' | 'recording' | 'transcribing'

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : strings.chat.voiceFailed
}

/**
 * Records one voice clip through the rebuilt Android module and asks the Host to
 * transcribe it with the official experimental speech namespace. The transcript
 * lands in the composer; audio never leaves the computer.
 */
export function useVoiceInput(options: {
  enabled: boolean
  onTranscript: (text: string) => void
  onError: (message: string) => void
}) {
  const { enabled, onTranscript, onError } = options
  const [phase, setPhase] = useState<VoiceInputPhase>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const startedAt = useRef(0)

  const stopTimer = useCallback(() => {
    if (timer.current !== undefined) {
      clearInterval(timer.current)
      timer.current = undefined
    }
  }, [])

  useEffect(() => () => {
    mounted.current = false
    stopTimer()
    void cancelVoiceCapture()
  }, [stopTimer])

  const reset = useCallback(() => {
    stopTimer()
    startedAt.current = 0
    setElapsedMs(0)
    setPhase('idle')
  }, [stopTimer])

  const toggle = useCallback(async () => {
    if (!enabled) return
    if (phase === 'recording') {
      stopTimer()
      setPhase('transcribing')
      try {
        const text = await stopVoiceCaptureAndTranscribe()
        if (mounted.current) {
          if (text !== '') onTranscript(text)
          else onError(strings.chat.voiceEmpty)
        }
      } catch (error) {
        if (mounted.current) onError(errorMessage(error))
      } finally {
        if (mounted.current) reset()
      }
      return
    }
    if (phase !== 'idle') return
    if (!voiceCaptureAvailable() || !supportsVoiceInput()) {
      onError(strings.chat.voiceUnavailable)
      return
    }
    const granted = await requestVoicePermission()
    if (!granted) {
      onError(strings.chat.voicePermissionDenied)
      return
    }
    try {
      await startVoiceCapture()
      if (!mounted.current) {
        await cancelVoiceCapture()
        return
      }
      startedAt.current = Date.now()
      setElapsedMs(0)
      setPhase('recording')
      timer.current = setInterval(() => {
        if (mounted.current && startedAt.current > 0) setElapsedMs(Date.now() - startedAt.current)
      }, 250)
    } catch (error) {
      onError(errorMessage(error))
      reset()
    }
  }, [enabled, onError, onTranscript, phase, reset, stopTimer])

  const cancel = useCallback(async () => {
    reset()
    await cancelVoiceCapture()
  }, [reset])

  return { phase, elapsedMs, toggle, cancel, available: voiceCaptureAvailable() }
}
