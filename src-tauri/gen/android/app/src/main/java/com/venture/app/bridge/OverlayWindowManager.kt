package com.venture.app.bridge

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.TextView

/**
 * AI 活动悬浮窗（规格书 6.4：report_progress 的悬浮展示；本实现为自主活动追踪）。
 *
 * 状态机（由 Rust 后端经 ToolServer /overlay 驱动）：
 *  - thinking：显示「AI 正在思考」+ 省略号滚动动画（"AI 正在思考" → "AI 正在思考." → ".." → "..."）
 *  - streaming：实时显示 AI 回复内容，最多两行，显示满则清空继续
 *  - tool：按分类显示「AI 正在分析布局 / 操控屏幕 / 使用脚本 / 定制脚本 / 使用工具」
 *  - idle：移除悬浮窗
 *
 * 位置：屏幕上部居中。未授权悬浮窗权限时静默不显示（不抛错）。
 */
object OverlayWindowManager {

    private const val TAG = "VentureOverlay"
    /** 流式文本两行清空阈值（字符数，近似两行宽度） */
    private const val STREAM_RESET_CHARS = 42
    private const val THINKING_DOT_INTERVAL_MS = 500L

    @Volatile private var appContext: Context? = null
    private var windowManager: WindowManager? = null
    private var overlayView: TextView? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile private var state = "idle" // idle | thinking | streaming | tool
    @Volatile private var appForeground = true // 应用在前台时不显示悬浮窗（应用内已有 AI 活动 UI），只记忆状态
    @Volatile private var lastToolText = ""
    private var streamBuffer = StringBuilder()
    /** AI 活动期间保持屏幕常亮（后台任务防息屏）；随 hide（任务结束/停止）释放 */
    @Volatile private var wakeLock: PowerManager.WakeLock? = null
    private val thinkingRunnable = object : Runnable {
        override fun run() {
            val view = overlayView ?: return
            view.text = "AI 正在思考${".".repeat(dotCount)}"
            dotCount = (dotCount + 1) % 4
            mainHandler.postDelayed(this, THINKING_DOT_INTERVAL_MS)
        }
    }
    private var dotCount = 0

    private fun ensureInit(context: Context) {
        if (appContext == null) {
            appContext = context.applicationContext
            windowManager = appContext!!.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        }
    }

    private fun canDraw(context: Context): Boolean =
        Settings.canDrawOverlays(context)

    // ─── 屏幕常亮（AI 活动期间） ────────────────────────────────────────────
    //
    // 后台任务时屏幕自动息屏会让用户看不到悬浮窗进度；AI 活动开始 acquire，
    // 结束/停止（hide）时 release。10 分钟硬超时兜底防泄漏。

    private fun acquireScreenOn() {
        if (wakeLock?.isHeld == true) return
        val pm = appContext?.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        runCatching {
            val wl = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "$TAG:ai-activity",
            )
            wl.setReferenceCounted(false)
            wl.acquire(10 * 60 * 1000L)
            wakeLock = wl
        }
    }

    private fun releaseScreenOn() {
        runCatching {
            wakeLock?.let { if (it.isHeld) it.release() }
        }
        wakeLock = null
    }

    // ─── 公开 API（ToolServer /overlay 调用） ───────────────────────────────
    //
    // 注意：ToolServer 在池线程处理请求，而 WindowManager.addView / View 读写
    // 必须在主线程（有 Looper）执行，否则 ViewRootImpl 创建抛异常且被 runCatching
    // 静默吞掉（曾导致权限已开也不显示）。故所有 UI 操作一律经 mainHandler 切主线程。

    fun showThinking(context: Context) {
        if (!canDraw(context)) return
        ensureInit(context)
        state = "thinking"
        acquireScreenOn() // AI 活动开始：屏幕常亮（无论前后台）
        if (appForeground) return // 前台只记忆状态，不显示悬浮窗
        mainHandler.post {
            if (appForeground) return@post
            dotCount = 0
            ensureView("AI 正在思考")
            mainHandler.removeCallbacks(thinkingRunnable)
            mainHandler.post(thinkingRunnable)
        }
    }

    fun showStreaming(context: Context, text: String) {
        if (!canDraw(context)) return
        ensureInit(context)
        acquireScreenOn() // 流式输出期间保持屏幕常亮
        if (state != "streaming") {
            state = "streaming"
            mainHandler.post {
                if (appForeground) return@post
                streamBuffer = StringBuilder()
                mainHandler.removeCallbacks(thinkingRunnable)
                ensureView("")
            }
        }
        if (appForeground) return
        mainHandler.post {
            if (appForeground) return@post
            val view = overlayView ?: return@post
            streamBuffer.append(text)
            // 显示满两行（阈值）→ 清空继续（保留最近字符避免断句突兀）
            if (streamBuffer.length > STREAM_RESET_CHARS) {
                val tail = streamBuffer.substring(streamBuffer.length - 12)
                streamBuffer = StringBuilder(tail)
            }
            view.text = streamBuffer.toString()
        }
    }

    fun showTool(context: Context, text: String) {
        if (!canDraw(context)) return
        ensureInit(context)
        state = "tool"
        lastToolText = text
        acquireScreenOn() // 工具操作期间保持屏幕常亮
        if (appForeground) return
        mainHandler.post {
            if (appForeground) return@post
            mainHandler.removeCallbacks(thinkingRunnable)
            ensureView(text)
        }
    }

    fun hide(context: Context) {
        ensureInit(context)
        state = "idle"
        releaseScreenOn() // AI 活动结束/停止：恢复自动息屏
        mainHandler.post {
            mainHandler.removeCallbacks(thinkingRunnable)
            removeView()
        }
    }

    fun isActive(): Boolean = state != "idle" && overlayView != null

    // ─── 应用前后台（MainActivity 生命周期挂钩） ─────────────────────────────
    //
    // 语义：应用在前台时悬浮窗不显示（应用内已有 AI 活动 UI）；退到后台且 AI
    // 仍在活动时恢复显示，让用户不打开应用也能看到任务进度。

    /** 应用回到前台：移除悬浮窗，保留状态记忆（AI 可能仍在运行，回后台时恢复显示） */
    fun onAppForeground() {
        appForeground = true
        mainHandler.post {
            mainHandler.removeCallbacks(thinkingRunnable)
            removeView()
        }
    }

    /** 应用退到后台：若 AI 正在活动，立即恢复显示悬浮窗 */
    fun onAppBackground() {
        appForeground = false
        if (state == "idle") return
        mainHandler.post {
            when (state) {
                "thinking" -> {
                    dotCount = 0
                    ensureView("AI 正在思考")
                    mainHandler.removeCallbacks(thinkingRunnable)
                    mainHandler.post(thinkingRunnable)
                }
                "streaming" -> ensureView(streamBuffer.toString())
                "tool" -> ensureView(lastToolText.ifEmpty { "AI 正在使用工具" })
            }
        }
    }

    // ─── 悬浮窗权限 ─────────────────────────────────────────────────────────

    fun hasPermission(context: Context): Boolean =
        Settings.canDrawOverlays(context)

    fun openPermissionSettings(context: Context): Boolean = runCatching {
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    }.getOrDefault(false)

    // ─── 内部实现 ───────────────────────────────────────────────────────────

    private fun ensureView(text: String) {
        if (overlayView != null) {
            overlayView!!.text = text
            return
        }
        val ctx = appContext ?: return
        val tv = TextView(ctx).apply {
            this.text = text
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(14), dp(8), dp(14), dp(8))
            // 自绘深色半透明圆角背景：系统 toast_frame 在 MIUI 等 ROM 上是浅色卡片，
            // 白色文字会看不见；自绘保证任意 ROM 下文字清晰
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(0xE6000000.toInt())
            }
            maxLines = 2
            maxWidth = dp(280)
            ellipsize = null
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(56) // 屏幕上部（状态栏下方）
        }
        runCatching {
            windowManager?.addView(tv, lp)
            overlayView = tv
        }.onFailure {
            Log.e(TAG, "addView 失败", it)
            overlayView = null
        }
    }

    private fun removeView() {
        overlayView?.let {
            runCatching { windowManager?.removeView(it) }
        }
        overlayView = null
        streamBuffer = StringBuilder()
    }

    private fun dp(value: Int): Int =
        (value * (appContext?.resources?.displayMetrics?.density ?: 1f)).toInt()
}
