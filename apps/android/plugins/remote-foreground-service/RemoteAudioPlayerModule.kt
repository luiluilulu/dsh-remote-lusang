package io.github.liguobao.dshremote

import android.media.MediaPlayer
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Plays a WAV that the Host synthesized (Windows SAPI TTS) straight from base64.
 * Nothing is persisted: the cache file is deleted when playback stops or ends.
 */
class RemoteAudioPlayerModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private var player: MediaPlayer? = null
  private var file: File? = null

  override fun getName(): String = "DshRemoteAudioPlayer"

  @ReactMethod
  fun play(base64: String, promise: Promise) {
    try {
      stopInternal()
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      if (bytes.isEmpty()) {
        promise.reject("AUDIO_EMPTY", "The synthesized audio is empty")
        return
      }
      val target = File(reactContext.cacheDir, "tts-${System.currentTimeMillis()}.wav")
      target.writeBytes(bytes)
      val media = MediaPlayer()
      media.setDataSource(target.absolutePath)
      media.setOnCompletionListener { stopInternal() }
      media.setOnErrorListener { _, _, _ ->
        stopInternal()
        true
      }
      media.prepare()
      media.start()
      player = media
      file = target
      promise.resolve(true)
    } catch (error: Exception) {
      stopInternal()
      promise.reject("AUDIO_PLAYBACK_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopInternal()
    promise.resolve(true)
  }

  private fun stopInternal() {
    player?.let { media ->
      try {
        if (media.isPlaying) media.stop()
      } catch (_: Exception) {
        // A finished or failed player may already be stopped.
      }
      try {
        media.release()
      } catch (_: Exception) {
        // Release races are harmless.
      }
    }
    player = null
    file?.delete()
    file = null
  }

  override fun invalidate() {
    stopInternal()
    super.invalidate()
  }
}
