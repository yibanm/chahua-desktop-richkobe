package com.richkobe.chahua

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {

  private val notificationPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      // 无论允许与否都起保活服务：通知被拒时至少保持在线，设置页可再引导
      if (granted) requestBatteryExemption()
      KeepAliveService.start(this)
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestRuntimePermissions()
  }

  /** 必要权限：Android 13+ 通知权限；电池优化豁免走系统设置页（用户点一次）。 */
  private fun requestRuntimePermissions() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
      ) {
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        return
      }
    }
    requestBatteryExemption()
    KeepAliveService.start(this)
  }

  /** 请求忽略电池优化：不请求则后台 WS 会被 Doze 掐断，收不到消息。 */
  private fun requestBatteryExemption() {
    val pm = getSystemService(PowerManager::class.java)
    if (pm.isIgnoringBatteryOptimizations(packageName)) return
    runCatching {
      startActivity(
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.parse("package:$packageName")),
      )
    }
  }
}
