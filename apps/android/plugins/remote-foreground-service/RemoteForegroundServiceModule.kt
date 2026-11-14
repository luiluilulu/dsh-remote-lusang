package io.github.liguobao.dshremote

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class RemoteForegroundServiceModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "DshRemoteForegroundService"

  @ReactMethod
  fun start(promise: Promise) {
    context.runOnUiQueueThread { RemoteForegroundService.start(context, promise) }
  }

  @ReactMethod
  fun notifyTask(hostId: String, sessionId: String, title: String, body: String) {
    RemoteForegroundService.notifyTask(context, hostId, sessionId, title, body)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    context.runOnUiQueueThread {
      RemoteForegroundService.stop(context)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun setStatus(status: String, promise: Promise) {
    context.runOnUiQueueThread {
      RemoteForegroundService.setStatus(status)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun updateLiveTask(
    hostId: String,
    sessionId: String,
    badge: String,
    title: String,
    statusText: String,
    isWaitingInput: Boolean,
    updatedAtMs: Double,
    summary: String,
    promise: Promise,
  ) {
    context.runOnUiQueueThread {
      try {
        val boundedTitle = title.take(150)
        val boundedBadge = badge.take(10)
        val boundedStatus = statusText.take(50)
        val safeTime = if (updatedAtMs.isFinite() && updatedAtMs > 0) updatedAtMs.toLong() else 0L
        val boundedSummary = summary.take(400)
        RemoteForegroundService.updateLiveTask(
          hostId, sessionId, boundedBadge, boundedTitle, boundedStatus, isWaitingInput, safeTime, boundedSummary
        )
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("UPDATE_LIVE_TASK_FAILED", e.message, e)
      }
    }
  }

  @ReactMethod
  fun clearLiveTask(promise: Promise) {
    context.runOnUiQueueThread {
      try {
        RemoteForegroundService.clearLiveTask()
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CLEAR_LIVE_TASK_FAILED", e.message, e)
      }
    }
  }

  @ReactMethod
  fun waitUntilStopped(lifetimeId: String, promise: Promise) {
    context.runOnUiQueueThread { RemoteForegroundService.waitUntilStopped(lifetimeId, promise) }
  }

  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      promise.resolve(pm?.isIgnoringBatteryOptimizations(context.packageName) ?: false)
    } else {
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun requestIgnoreBatteryOptimizations(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      promise.resolve(true)
      return
    }
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    val alreadyIgnoring = pm?.isIgnoringBatteryOptimizations(context.packageName) == true
    // Already exempt: the request dialog is a silent no-op there, so land the user on
    // a system battery page instead of resolving without any visible result.
    if (!alreadyIgnoring && openSystemIntent(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
      })) {
      promise.resolve(true)
      return
    }
    if (openSystemIntent(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) {
      promise.resolve(true)
      return
    }
    if (openSystemIntent(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.parse("package:${context.packageName}")
      })) {
      promise.resolve(true)
      return
    }
    promise.reject("BATTERY_SETTING_FAILED", "No system battery settings activity is available")
  }

  /** Starts a settings activity from the app context and reports whether a handler existed. */
  private fun openSystemIntent(intent: Intent): Boolean = try {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
    true
  } catch (_: Exception) {
    false
  }

  override fun invalidate() {
    context.runOnUiQueueThread { RemoteForegroundService.stop(context) }
    super.invalidate()
  }
}

