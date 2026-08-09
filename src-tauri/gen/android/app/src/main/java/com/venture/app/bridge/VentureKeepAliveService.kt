package com.venture.app.bridge

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
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * 后台保活前台服务（Foreground Service）。
 *
 * 职责：Agent 任务（AI 生成 / 自动化脚本执行）进行期间把进程提升为前台优先级，
 * 显著降低被系统或 ROM 清理的概率。任务结束后停止，通知随之消失。
 *
 * 设计约束（targetSdk 36 / Android 14+）：
 *  - 应用在后台时**不能启动**前台服务 → 只能由 ToolServer（任务启动于前台时）
 *    或 MainActivity 触发，且 start 必须在进程处于前台的时间窗口内完成。
 *  - Android 14+ 必须声明 foregroundServiceType，这里用 specialUse（特殊用途），
 *    并在 Manifest 中提供用途说明。
 *  - Android 13+ 的通知需 POST_NOTIFICATIONS 权限；未授权时服务照常运行，
 *    仅通知不可见（前台服务本身仍生效）。
 *  - 空闲兜底：超过 IDLE_TIMEOUT_MS 无心跳自动停止（Rust 端异常崩溃时防泄漏）。
 */
class VentureKeepAliveService : Service() {

    companion object {
        private const val TAG = "VentureKeepAlive"
        const val CHANNEL_ID = "venture_keepalive"
        const val NOTIFICATION_ID = 0x2A1E
        const val IDLE_TIMEOUT_MS = 90_000L

        private val LOCK = Any()
        @Volatile private var running = false
        private val lastHeartbeatAt = AtomicLong(0)

        @Volatile
        private var currentService: VentureKeepAliveService? = null

        @Volatile
        var active: Boolean = false
            private set

        /** 当前通知文本（onStartCommand 重建通知用） */
        @Volatile
        private var currentText: String = "任务执行中…"

        /** 幂等启动（须在应用前台时调用，由 ToolServer/MainActivity 触发） */
        fun ensureStarted(context: Context, text: String = "任务执行中…") {
            val first = synchronized(LOCK) {
                if (running) {
                    currentText = text
                    false
                } else {
                    running = true
                    active = true
                    currentText = text
                    true
                }
            }
            lastHeartbeatAt.set(System.currentTimeMillis())
            if (first) {
                runCatching {
                    val intent = Intent(context, VentureKeepAliveService::class.java)
                    if (Build.VERSION.SDK_INT >= 26) {
                        context.startForegroundService(intent)
                    } else {
                        context.startService(intent)
                    }
                }.onFailure {
                    Log.e(TAG, "startForegroundService failed", it)
                    synchronized(LOCK) { running = false; active = false }
                }
            } else {
                currentService?.updateNotification(text)
            }
        }

        /** 心跳：续期保活 + 更新通知文本 */
        fun heartbeat(text: String? = null) {
            lastHeartbeatAt.set(System.currentTimeMillis())
            if (running) active = true
            text?.let {
                currentText = it
                currentService?.updateNotification(it)
            }
        }

        /** 停止保活（任务结束后调用） */
        fun stop(context: Context? = null) {
            val ctx = context ?: ToolServer.appContext
            synchronized(LOCK) {
                if (!running) return
                running = false
                active = false
            }
            ctx?.let {
                runCatching { it.stopService(Intent(it, VentureKeepAliveService::class.java)) }
            }
        }

        /** 空闲检查：无心跳超时自动停止（服务内定时调度调用） */
        fun checkIdle(context: Context) {
            if (running && System.currentTimeMillis() - lastHeartbeatAt.get() > IDLE_TIMEOUT_MS) {
                Log.w(TAG, "keepalive idle timeout, stopping")
                stop(context)
            }
        }

        private fun buildNotification(context: Context, text: String): Notification {
            // 无 POST_NOTIFICATIONS 权限时 startForeground 会抛 SecurityException，
            // 调用方已 runCatching 兜底（服务仍运行，仅通知不可见）。
            // Android 13+ 未授权时 Notification.Builder 仍可构建，发送时才被忽略。
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                val channel = NotificationChannel(
                    CHANNEL_ID, "后台任务保活",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Agent 任务执行期间的保活通知"
                    setShowBadge(false)
                }
                nm.createNotificationChannel(channel)
            }
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val contentIntent = launchIntent?.let {
                PendingIntent.getActivity(
                    context, 0, it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }
            return Notification.Builder(context, CHANNEL_ID)
                .setContentTitle("Venture 任务执行中")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .setContentIntent(contentIntent)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build()
        }
    }

    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "venture-keepalive-idle").apply { isDaemon = true }
    }
    private var idleFuture: ScheduledFuture<*>? = null

    override fun onCreate() {
        super.onCreate()
        currentService = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification(this, currentText)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // 空闲兜底定时检查
        idleFuture?.cancel(false)
        idleFuture = scheduler.scheduleWithFixedDelay(
            { checkIdle(this) },
            IDLE_TIMEOUT_MS, IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS,
        )
        return START_STICKY
    }

    private fun updateNotification(text: String) {
        runCatching {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIFICATION_ID, buildNotification(this, text))
        }
    }

    override fun onDestroy() {
        currentService = null
        idleFuture?.cancel(false)
        scheduler.shutdownNow()
        synchronized(LOCK) { running = false; active = false }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
