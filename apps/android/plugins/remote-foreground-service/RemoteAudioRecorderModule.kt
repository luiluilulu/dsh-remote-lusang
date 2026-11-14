package io.github.liguobao.dshremote

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Records 16 kHz mono PCM16 into a canonical WAV for the official speech Remote
 * namespace (`speech/transcribe` only accepts validated WAV). MediaRecorder cannot
 * emit PCM, so this module uses AudioRecord and writes the 44-byte header itself.
 */
class RemoteAudioRecorderModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val recording = AtomicBoolean(false)
  private var recorder: AudioRecord? = null
  @Volatile private var capture: ByteArrayOutputStream? = null
  @Volatile private var startedAt = 0L
  private var worker: Thread? = null

  override fun getName(): String = "DshRemoteAudioRecorder"

  @ReactMethod
  fun start(promise: Promise) {
    if (recording.get()) {
      promise.reject("VOICE_BUSY", "A recording is already running")
      return
    }
    val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer <= 0) {
      promise.reject("VOICE_UNAVAILABLE", "This device exposes no 16 kHz mono recorder")
      return
    }
    val audio = try {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minBuffer * 2, SAMPLE_RATE / 5 * 2),
      )
    } catch (error: Exception) {
      promise.reject("VOICE_UNAVAILABLE", error.message, error)
      return
    }
    if (audio.state != AudioRecord.STATE_INITIALIZED) {
      audio.release()
      promise.reject("VOICE_UNAVAILABLE", "The recorder could not be initialized")
      return
    }
    if (audio.recordingState != AudioRecord.RECORDSTATE_STOPPED) {
      audio.release()
      promise.reject("VOICE_BUSY", "The recorder is already in use")
      return
    }
    try {
      audio.startRecording()
    } catch (error: Exception) {
      audio.release()
      promise.reject("VOICE_CONTROL_DENIED", error.message, error)
      return
    }
    val buffer = ByteArrayOutputStream()
    capture = buffer
    recorder = audio
    startedAt = SystemClock.elapsedRealtime()
    recording.set(true)
    worker = Thread({ captureLoop(audio, buffer) }, "dsh-remote-audio-recorder").also { it.start() }
    promise.resolve(true)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    if (!recording.getAndSet(false)) {
      promise.reject("VOICE_NOT_RECORDING", "No recording is running")
      return
    }
    recorder?.let { audio ->
      try {
        audio.stop()
      } catch (_: Exception) {
        // A short or interrupted capture may already be stopped.
      }
      try {
        audio.release()
      } catch (_: Exception) {
        // Ignore release races; the capture thread has already stopped reading.
      }
    }
    recorder = null
    worker?.join(600)
    worker = null
    val pcm = synchronized(captureLock) { capture?.toByteArray() ?: ByteArray(0) }
    capture = null
    if (pcm.isEmpty()) {
      promise.reject("VOICE_EMPTY", "The recording contains no audio")
      return
    }
    val wav = wavWithHeader(pcm)
    if (wav.size > MAX_AUDIO_BYTES) {
      promise.reject("VOICE_TOO_LONG", "The recording exceeds the 4 MiB speech limit")
      return
    }
    val file = File(reactContext.cacheDir, "voice-${System.currentTimeMillis()}.wav")
    file.writeBytes(wav)
    val result = Arguments.createMap()
    result.putString("path", file.absolutePath)
    result.putString("base64", Base64.encodeToString(wav, Base64.NO_WRAP))
    result.putInt("bytes", wav.size)
    result.putInt("durationMs", pcm.size / 2 * 1000 / SAMPLE_RATE)
    promise.resolve(result)
  }

  @ReactMethod
  fun cancel(promise: Promise) {
    if (recording.getAndSet(false)) {
      recorder?.let { audio ->
        try { audio.stop() } catch (_: Exception) {}
        try { audio.release() } catch (_: Exception) {}
      }
      recorder = null
      worker?.join(300)
      worker = null
      synchronized(captureLock) { capture?.reset() }
      capture = null
    }
    promise.resolve(true)
  }

  override fun invalidate() {
    recording.set(false)
    recorder?.let { audio ->
      try { audio.stop() } catch (_: Exception) {}
      try { audio.release() } catch (_: Exception) {}
    }
    recorder = null
    super.invalidate()
  }

  private fun captureLoop(audio: AudioRecord, buffer: ByteArrayOutputStream) {
    val chunk = ByteArray(4096)
    try {
      while (recording.get()) {
        val read = audio.read(chunk, 0, chunk.size)
        if (read > 0) {
          synchronized(captureLock) { buffer.write(chunk, 0, read) }
        }
        if (SystemClock.elapsedRealtime() - startedAt >= MAX_DURATION_MS) break
        if (buffer.size() >= MAX_AUDIO_BYTES - 44) break
      }
    } catch (_: Exception) {
      // Permission revocation or another recorder taking the device ends capture.
    }
  }

  private val captureLock = Any()

  companion object {
    private const val SAMPLE_RATE = 16000
    private const val MAX_DURATION_MS = 120_000L
    private const val MAX_AUDIO_BYTES = 4 * 1024 * 1024

    /** Canonical 44-byte RIFF/WAVE header followed by 16-bit little-endian PCM. */
    @SuppressLint("DefaultLocale")
    private fun wavWithHeader(pcm: ByteArray): ByteArray {
      val total = pcm.size + 44
      val header = ByteArray(44)
      fun putAscii(offset: Int, value: String) {
        value.forEachIndexed { index, char -> header[offset + index] = char.code.toByte() }
      }
      fun putInt(offset: Int, value: Int) {
        header[offset] = (value and 0xff).toByte()
        header[offset + 1] = (value shr 8 and 0xff).toByte()
        header[offset + 2] = (value shr 16 and 0xff).toByte()
        header[offset + 3] = (value shr 24 and 0xff).toByte()
      }
      fun putShort(offset: Int, value: Int) {
        header[offset] = (value and 0xff).toByte()
        header[offset + 1] = (value shr 8 and 0xff).toByte()
      }
      putAscii(0, "RIFF")
      putInt(4, total - 8)
      putAscii(8, "WAVE")
      putAscii(12, "fmt ")
      putInt(16, 16)
      putShort(20, 1) // PCM
      putShort(22, 1) // mono
      putInt(24, SAMPLE_RATE)
      putInt(28, SAMPLE_RATE * 2) // byte rate
      putShort(32, 2) // block align
      putShort(34, 16) // bits per sample
      putAscii(36, "data")
      putInt(40, pcm.size)
      val out = ByteArray(total)
      header.copyInto(out, 0)
      pcm.copyInto(out, 44)
      return out
    }
  }
}
