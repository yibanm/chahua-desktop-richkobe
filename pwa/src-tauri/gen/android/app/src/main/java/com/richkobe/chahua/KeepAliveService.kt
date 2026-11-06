package com.richkobe.chahua

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 前台保活服务：Android 要后台不被杀必须挂前台服务，而前台服务必须有常驻通知（系统硬规定）。
 * 常驻通知走低打扰通道（无横幅无铃声），消息通知走 HIGH 通道（横幅+铃声，用户要求默认带）。
 * 本轮只做保活骨架；WS 接收链下一轮接入。
 */
class KeepAliveService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannels()
    startForegroundCompat()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // 经 startForegroundService 到达必须先 startForeground，否则系统判超时杀进程
    startForegroundCompat()
    return START_STICKY
  }

  private fun createChannels() {
    val manager = getSystemService(NotificationManager::class.java)
    // 常驻保活通知：低打扰，无横幅无铃声，避免骚扰
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_KEEPALIVE, getString(R.string.channel_keepalive_name), NotificationManager.IMPORTANCE_LOW)
        .apply {
          description = getString(R.string.channel_keepalive_desc)
          setShowBadge(false)
        },
    )
    // 消息通知：用户要求默认带横幅+铃声 => IMPORTANCE_HIGH（系统默认即横幅+铃声）
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_MESSAGES, getString(R.string.channel_messages_name), NotificationManager.IMPORTANCE_HIGH)
        .apply { description = getString(R.string.channel_messages_desc) },
    )
  }

  private fun startForegroundCompat() {
    val openApp = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_KEEPALIVE)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(getString(R.string.keepalive_title))
      .setContentText(getString(R.string.keepalive_text))
      .setContentIntent(openApp)
      .setOngoing(true)
      .setSilent(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  companion object {
    const val CHANNEL_KEEPALIVE = "keepalive"
    const val CHANNEL_MESSAGES = "messages"
    private const val NOTIFICATION_ID = 1001

    fun start(context: Context) {
      val intent = Intent(context, KeepAliveService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    /** 消息通知是否被系统允许（权限+通道开关都算）。 */
    fun messagesAllowed(context: Context): Boolean {
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
      val channel = context.getSystemService(NotificationManager::class.java)
        .getNotificationChannel(CHANNEL_MESSAGES) ?: return true
      return channel.importance != NotificationManager.IMPORTANCE_NONE
    }
  }
}
