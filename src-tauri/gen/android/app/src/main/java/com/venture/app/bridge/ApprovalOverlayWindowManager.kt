package com.venture.app.bridge

import com.venture.app.R
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 授权悬浮窗（后台工具权限询问，规格书工具授权场景）。
 *
 * 触发链路：前端工具循环遇到 needs_approval → 后端 /api/approval/notify
 *   → ToolServer /approval(show) → 本对象在屏幕下方显示授权卡片；
 *   用户点击按钮 → POST http://127.0.0.1:49527/api/approval/result
 *   → 后端存储 → 前端轮询消费 → 恢复工具执行流程。
 *
 * 用户约束（实现要点）：
 * 1. 不干扰无障碍布局树：窗口根 view 设 IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
 *    （该窗口对无障碍服务不可见，get_layout 布局树不含本窗口）；
 *    另加 FLAG_SECURE 使窗口不出现在截屏/录屏中（避免视觉识别被悬浮窗遮挡）。
 * 2. 返回键不绑定弹窗：FLAG_NOT_FOCUSABLE（窗口不接收按键与焦点，返回键自然
 *    走前台应用），不注册任何 BackCallback / onKeyDown。
 *
 * 与 OverlayWindowManager（AI 活动悬浮窗，屏幕上部的只读进度条）互不干扰：
 * 两个独立窗口。应用回前台时收起（应用内已有授权卡片 UI），退后台且仍有
 * 待授权请求时恢复显示（重放最后一条请求）。
 */
object ApprovalOverlayWindowManager {

    private const val TAG = "VentureApproval"
    /** 后端本地端口（与 MainActivity 中 WebView 混合内容注释一致） */
    private const val BACKEND_URL = "http://127.0.0.1:49527"
    /** 无操作自动收起（授权在应用内卡片仍可处理，不强制） */
    private const val TIMEOUT_MS = 10 * 60 * 1000L
    private const val ENTER_ANIM_MS = 340L
    private const val EXIT_ANIM_MS = 200L

    @Volatile private var appContext: Context? = null
    private var windowManager: WindowManager? = null
    private var cardView: View? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    /** 应用前后台：前台不显示（应用内已有授权卡片 UI），退后台且有待授权请求时补显 */
    @Volatile private var appForeground = true
    /** 最近一次待授权请求（退后台时重放显示；悬浮窗权限缺失时也可重试） */
    @Volatile private var lastRequest: JSONObject? = null
    private var timeoutRunnable: Runnable? = null

    // ─── 初始化与权限 ───────────────────────────────────────────────────────

    private fun ensureInit(context: Context) {
        if (appContext == null) {
            appContext = context.applicationContext
            windowManager = appContext!!.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        }
    }

    private fun canDraw(context: Context): Boolean = Settings.canDrawOverlays(context)

    fun hasPermission(context: Context): Boolean = Settings.canDrawOverlays(context)

    // ─── 公开 API（ToolServer /approval 与 MainActivity 生命周期调用） ──────

    /** 显示授权卡片（payload: chatId/messageId/toolId/toolName/input/description） */
    fun show(context: Context, payload: JSONObject) {
        if (!canDraw(context)) return
        ensureInit(context)
        lastRequest = payload
        if (appForeground) return // 前台由应用内授权卡片处理
        mainHandler.post { showCard() }
    }

    /** 收起授权卡片（授权完成 / 后端主动 hide / 超时） */
    fun hide(context: Context) {
        ensureInit(context)
        lastRequest = null
        mainHandler.post { dismissCard() }
    }

    /** 应用回前台：收起悬浮窗（应用内卡片已可见） */
    fun onAppForeground() {
        appForeground = true
        mainHandler.post { dismissCard() }
    }

    /** 应用退后台：若仍有待授权请求，恢复显示悬浮窗 */
    fun onAppBackground() {
        appForeground = false
        val req = lastRequest ?: return
        if (!canDraw(appContext ?: return)) return
        mainHandler.post { showCard() }
    }

    // ─── 卡片构建与显示 ─────────────────────────────────────────────────────

    private fun showCard() {
        if (appForeground) return
        val ctx = appContext ?: return
        val req = lastRequest ?: return
        if (cardView != null) return // 已在显示（或正在收起动画，由 dismiss 后重放）

        val card = buildCard(ctx, req)
        val lp = WindowManager.LayoutParams(
            dp(300), // 固定卡片宽度（避免 vivo 上 WRAP_CONTENT 子视图 MATCH_PARENT 撑满全屏）
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_SECURE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            // 距屏幕底部留出导航栏/手势条空间。
            // 注意：不能设置 horizontalMargin——vivo 上与 BOTTOM CENTER 组合时
            // 会把窗口错误平移到屏幕外（x≈margin×屏宽），导致窗口不可见、触摸失效
            y = dp(96)
        }
        runCatching {
            windowManager?.addView(card, lp)
            cardView = card
        }.onFailure {
            Log.e(TAG, "addView 失败", it)
            cardView = null
            return
        }

        // 滑入动画：底部上移 + 淡入
        card.alpha = 0f
        card.translationY = dp(56).toFloat()
        card.animate()
            .alpha(1f)
            .translationY(0f)
            .setDuration(ENTER_ANIM_MS)
            .setInterpolator(DecelerateInterpolator())
            .start()

        // 无操作超时自动收起（授权状态持久化，应用内卡片仍可处理）
        timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        timeoutRunnable = Runnable { dismissCard() }.also {
            mainHandler.postDelayed(it, TIMEOUT_MS)
        }
    }

    private fun dismissCard() {
        timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        timeoutRunnable = null
        val view = cardView ?: return
        cardView = null
        view.animate()
            .alpha(0f)
            .translationY(dp(20).toFloat())
            .setDuration(EXIT_ANIM_MS)
            .withEndAction {
                runCatching { windowManager?.removeView(view) }
            }
            .start()
    }

    // ─── UI 构建（代码布局，风格对齐应用内 ToolApprovalCard：深色卡片 + amber 强调） ──

    private fun buildCard(ctx: Context, req: JSONObject): View {
        val toolName = req.optString("toolName", "工具调用")
        val description = req.optString("description").ifEmpty { "该操作需要你的授权" }
        val input = req.optString("input").ifEmpty { "{}" }
        val chatId = req.optString("chatId")
        val messageId = req.optString("messageId")
        val toolId = req.optString("toolId")

        // 浅色主题（对齐应用内 ToolApprovalCard 风格）：
        // 白色卡片 + 半透明黑边框 + 柔和阴影；amber 强调；主按钮深色底白字
        val COLOR_TEXT = Color.rgb(0x23, 0x23, 0x23)      // foreground ≈ oklch(0.145 0 0)
        val COLOR_MUTED_TEXT = Color.rgb(0x71, 0x71, 0x82) // muted-foreground
        val COLOR_MUTED_BG = Color.rgb(0xEC, 0xEC, 0xF0)   // muted
        val COLOR_BORDER = 0x1A000000.toInt()              // rgba(0,0,0,0.1)
        val COLOR_AMBER = Color.rgb(0xF5, 0x9E, 0x0B)      // amber-500
        val COLOR_PRIMARY = Color.rgb(0x03, 0x02, 0x13)     // primary

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(Color.WHITE)
                setStroke(dp(1), COLOR_BORDER)
            }
            elevation = dp(12).toFloat()
        }

        // 头部：amber 锁图标 + 标题 + 工具名
        val header = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, dp(8))
        }
        val iconWrap = LinearLayout(ctx).apply {
            setPadding(dp(7), dp(5), dp(7), dp(5))
            background = GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setColor(0x26F59E0B.toInt()) // amber-500/15
            }
        }
        val icon = ImageView(ctx).apply {
            setImageResource(android.R.drawable.ic_lock_lock)
            setColorFilter(COLOR_AMBER)
        }
        iconWrap.addView(icon, LinearLayout.LayoutParams(dp(14), dp(14)))
        header.addView(iconWrap)

        val title = TextView(ctx).apply {
            text = "权限请求"
            setTextColor(COLOR_MUTED_TEXT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = Typeface.DEFAULT
            setPadding(dp(8), 0, 0, 0)
        }
        header.addView(title)

        val name = TextView(ctx).apply {
            text = toolName
            setTextColor(COLOR_TEXT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(dp(10), 0, 0, 0)
        }
        header.addView(name, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        // 描述
        val desc = TextView(ctx).apply {
            text = description
            setTextColor(COLOR_MUTED_TEXT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
            setLineSpacing(0f, 1.15f)
            setPadding(0, 0, 0, dp(6))
        }
        root.addView(desc, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        // 传入参数（单行摘要，浅灰块）
        val paramBox = LinearLayout(ctx).apply {
            setPadding(dp(10), dp(7), dp(10), dp(7))
            background = GradientDrawable().apply {
                cornerRadius = dp(9).toFloat()
                setColor(0x33ECECF0.toInt()) // muted/20
            }
        }
        val inputText = TextView(ctx).apply {
            text = input.replace('\n', ' ').take(96)
            setTextColor(0xCC232323.toInt()) // foreground/80
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            typeface = Typeface.MONOSPACE
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        paramBox.addView(inputText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(paramBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        // 按钮行：拒绝 / 一律同意 / 同意
        // 按钮行（对齐 ToolApprovalCard：拒绝文字按钮 / 一律同意描边 / 同意实心，
        // 图标为 lucide 风格矢量（x / check-check / check），小号 padding；
        // 用 TextView 避免系统 Button 的默认 minHeight/大写样式）
        val buttonRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(10), 0, 0)
        }

        fun textButton(
            label: String,
            iconRes: Int,
            textColor: Int,
            bg: GradientDrawable?,
            bold: Boolean = false,
        ): TextView = TextView(ctx).apply {
            text = label
            setTextColor(textColor)
            textSize = 11f // 对齐卡片 text-[11px]
            if (bold) typeface = Typeface.DEFAULT_BOLD
            // 按钮内边距：左右 11dp、上下 4dp（与既有样式一致，勿改小）
            setPadding(dp(11), dp(4), dp(11), dp(4))
            background = bg
            gravity = Gravity.CENTER
            minWidth = 0
            minHeight = 0
            includeFontPadding = false
            if (iconRes != 0) {
                val d = ctx.getDrawable(iconRes)
                d?.setTint(textColor) // 图标随按钮文字色
                setCompoundDrawablesWithIntrinsicBounds(d, null, null, null)
                compoundDrawablePadding = dp(6) // 对齐卡片 gap-1.5（6px = 6dp）
            }
        }

        val rejectBtn = textButton("拒绝", R.drawable.ic_x, COLOR_MUTED_TEXT, null)
        buttonRow.addView(rejectBtn)

        // 中间弹性空隙：拒绝靠左、一律同意+同意紧凑靠右（对齐卡片 justify-between）
        buttonRow.addView(Space(ctx), LinearLayout.LayoutParams(0, 0, 1f))

        val alwaysBtn = textButton(
            "一律同意", R.drawable.ic_check_check, COLOR_TEXT,
            GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setColor(Color.TRANSPARENT)
                setStroke(dp(1), COLOR_BORDER)
            },
        )
        buttonRow.addView(alwaysBtn)

        val approveBtn = textButton(
            "同意", R.drawable.ic_check, Color.WHITE,
            GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setColor(COLOR_PRIMARY) // 深色主按钮（bg-primary）
            },
            bold = true,
        )
        buttonRow.addView(
            approveBtn,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                // 与"一律同意"保持卡片同等间隙（gap-1.5 = 6dp）
                marginStart = dp(6)
            },
        )
        root.addView(buttonRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        // 点击反馈（按压缩放）+ 回传
        fun pressFeedback(v: View) {
            v.setOnTouchListener { view, event ->
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> view.animate().scaleX(0.96f).scaleY(0.96f).setDuration(80L).start()
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                        view.animate().scaleX(1f).scaleY(1f).setDuration(120L).start()
                }
                false
            }
        }
        pressFeedback(rejectBtn); pressFeedback(alwaysBtn); pressFeedback(approveBtn)

        rejectBtn.setOnClickListener { submitDecision(chatId, messageId, toolId, "reject") }
        alwaysBtn.setOnClickListener { submitDecision(chatId, messageId, toolId, "always_approve") }
        approveBtn.setOnClickListener { submitDecision(chatId, messageId, toolId, "approve") }

        // 约束 1：整个窗口对无障碍服务不可见（不干扰 get_layout 布局树）
        root.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        return root
    }

    /** 回传授权结果到后端（后台线程；失败静默，应用内卡片仍可处理） */
    private fun submitDecision(chatId: String, messageId: String, toolId: String, decision: String) {
        lastRequest = null
        mainHandler.post { dismissCard() }
        Thread {
            runCatching {
                val payload = JSONObject()
                    .put("chatId", chatId)
                    .put("messageId", messageId)
                    .put("toolId", toolId)
                    .put("decision", decision)
                val conn = URL("$BACKEND_URL/api/approval/result").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 3000
                conn.readTimeout = 3000
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Content-Length", payload.toString().toByteArray().size.toString())
                conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                conn.inputStream.close()
                conn.disconnect()
            }.onFailure { Log.w(TAG, "回传授权结果失败（前端轮询无法消费，应用内卡片仍可处理）", it) }
        }.start()
    }

    private fun dp(value: Int): Int =
        (value * (appContext?.resources?.displayMetrics?.density ?: 1f)).toInt()
}
