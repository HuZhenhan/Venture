package com.venture.app.bridge

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.DisplayMetrics
import android.view.WindowManager
import com.venture.app.accessibility.AccessibilityBridge
import com.venture.app.accessibility.Capture
import com.venture.app.accessibility.LayoutInspector
import com.venture.app.accessibility.LayoutV3
import com.venture.app.accessibility.NodeInfo
import com.venture.app.accessibility.VentureAccessibilityService
import com.venture.app.accessibility.automator.ActionExecutor
import com.venture.app.accessibility.automator.AppLauncher
import com.venture.app.accessibility.automator.AppStopper
import com.venture.app.accessibility.automator.GestureExecutor
import com.venture.app.accessibility.automator.GlobalActionExecutor
import com.venture.app.accessibility.automator.KeyEventInjector
import com.venture.app.accessibility.automator.NodeFinder
import com.venture.app.accessibility.automator.ScreenMetrics
import com.venture.app.accessibility.automator.ScreenshotHandler
import com.venture.app.accessibility.automator.TextInputHandler
import kotlin.math.hypot
import kotlin.math.max
import org.json.JSONArray
import org.json.JSONObject

/**
 * 原生工具路由（对应规格书 6.6 tool_router 的原生侧）。
 *
 * - 入参校验：必须字段缺失 → 明确错误（LLM 可自我纠正重调）
 * - 全部返回结构化 JSON，失败带 error:{code,message}
 * - 维护"最近一次布局快照"（v3 简化结果：编号 → PNode + rev + anchor），供 get_node / click(node_id) 查表转坐标
 * - wait_for_*：500ms 轮询直至命中或超时（规格书 6.3）
 */
class NativeToolRouter(private val context: Context) {

    companion object {
        const val WAIT_POLL_INTERVAL_MS = 500L
        const val DEFAULT_WAIT_TIMEOUT_MS = 10_000L

        /** get_layout 返回大小上限（20kB）：超过不返回布局树，引导切换模式 */
        const val LAYOUT_MAX_BYTES = 20 * 1024
    }

    private val bridge = AccessibilityBridge()
    private val layoutInspector = LayoutInspector(context)
    private val screenMetrics = ScreenMetrics.from(context)
    private val actionExecutor = ActionExecutor(bridge)
    private val gestureExecutor = GestureExecutor({ VentureAccessibilityService.instance }, screenMetrics)
    private val globalActions = GlobalActionExecutor({ VentureAccessibilityService.instance })
    private val textInput = TextInputHandler(context, bridge, actionExecutor, gestureExecutor)
    private val appLauncher = AppLauncher(context)
    private val appStopper = AppStopper(context)
    private val keyEventInjector = KeyEventInjector(context, bridge, globalActions, actionExecutor)
    private val screenshotHandler = ScreenshotHandler(context) { VentureAccessibilityService.instance }

    /** 最近一次布局快照（v3 简化结果：行式 DSL + 编号表 + anchor），click(node_id)/get_node 查表用 */
    @Volatile
    private var lastSnapshot: LayoutV3.Result? = null

    @Volatile
    private var lastCapture: Capture? = null

    /** 最近一次动作执行时间（抓树时机：动作后静默再抓树，避免过渡动画中间态） */
    @Volatile
    private var lastActionAt = 0L

    fun dispatch(tool: String, args: JSONObject): JSONObject {
        if (tool == "__health__") return health()
        // 权限引导（规格书 8.3）：三态检测 + 跳转系统无障碍设置
        if (tool == "__permission_state__") {
            val state = AccessibilityPermissionHelper.stateSnapshot(context)
            return ok()
                .put("granted", state["granted"] == true)
                .put("connected", state["connected"] == true)
                .put("operational", state["operational"] == true)
        }
        if (tool == "__open_accessibility_settings__") {
            runCatching { AccessibilityPermissionHelper.openAccessibilitySettings(context) }
            return ok()
        }
        // 后台保活引导（设置页「后台保活」区块）
        if (tool == "__battery_exempt__") {
            return ok().put("exempt", BatteryOptimizationHelper.isExempt(context))
        }
        if (tool == "__request_battery_exempt__") {
            val requested = BatteryOptimizationHelper.requestExempt(context)
            return ok().put("requested", requested).put("exempt", BatteryOptimizationHelper.isExempt(context))
        }
        if (tool == "__open_battery_settings__") {
            val opened = BatteryOptimizationHelper.openSettings(context)
            return ok().put("opened", opened)
        }
        if (tool == "__keepalive_active__") {
            return ok().put("active", VentureKeepAliveService.active)
        }
        // AI 活动悬浮窗（规格书 6.4）：权限检测 + 跳转授权
        if (tool == "__overlay_permission__") {
            return ok().put("granted", OverlayWindowManager.hasPermission(context))
        }
        if (tool == "__open_overlay_settings__") {
            val opened = OverlayWindowManager.openPermissionSettings(context)
            return ok().put("opened", opened)
        }
        return try {
            when (tool) {
                // 感知类
                "screenshot" -> screenshot()
                "get_layout" -> getLayout(args)
                "get_node" -> getNode(args)
                "find_node" -> findNode(args)
                "get_foreground_app" -> getForegroundApp()
                "get_screen_info" -> getScreenInfo()
                "read_clipboard" -> ok().put("text", textInput.readClipboard())
                "get_windows" -> getWindows()
                // 操作类
                "click" -> clickLike(args, long = false)
                "long_click" -> clickLike(args, long = true)
                "press" -> press(args)
                "swipe" -> swipe(args)
                "gesture" -> gesture(args)
                "node_action" -> nodeAction(args)
                "input_text" -> inputText(args)
                "paste" -> paste(args)
                "key_event" -> keyEvent(args)
                "global_action" -> globalAction(args)
                "set_clipboard" -> {
                    val text = requireString(args, "text")
                    textInput.setClipboard(text); ok()
                }
                "launch_app" -> launchApp(args)
                "stop_app" -> stopApp(args)
                "open_url" -> openUrl(args)
                "scroll" -> scroll(args)
                // 控制类
                "wait_for_node" -> waitForNode(args)
                "wait_for_text" -> waitForText(args)
                "wait_for_app" -> waitForApp(args)
                "sleep" -> {
                    Thread.sleep(args.optLong("ms", 500).coerceIn(0, 60_000)); ok()
                }
                else -> error("unknown_tool", "未知工具: $tool")
            }
        } catch (e: ToolException) {
            error(e.code, e.message ?: "工具执行失败")
        } catch (e: IllegalStateException) {
            error("service_unavailable", e.message ?: "无障碍服务未运行")
        } catch (e: Exception) {
            error("internal_error", "${e.javaClass.simpleName}: ${e.message}")
        }
    }

    // ---------- 基础设施 ----------

    private class ToolException(val code: String, message: String) : Exception(message)

    private fun ok(): JSONObject = JSONObject().put("ok", true)

    private fun error(code: String, message: String): JSONObject =
        JSONObject().put("ok", false).put(
            "error", JSONObject().put("code", code).put("message", message)
        )

    private fun requireString(args: JSONObject, key: String): String {
        val v = args.optString(key, "")
        if (v.isEmpty()) throw ToolException("missing_param", "缺少必需参数: $key")
        return v
    }

    private fun requireService(): VentureAccessibilityService =
        VentureAccessibilityService.instance
            ?: throw ToolException("service_unavailable", "无障碍服务未运行，请在系统设置中开启 Venture 无障碍服务")

    private fun health(): JSONObject {
        val service = VentureAccessibilityService.instance
        return ok()
            .put("service_connected", service != null)
            .put("operational", VentureAccessibilityService.hasOperationalState)
    }

    /** 捕获布局（brief→v3 简化 / full→完整 JSON 树），刷新会话快照 */
    private fun captureLayout(mode: String): Pair<Capture, LayoutV3.Result?> {
        requireService()
        settleIfNeeded()
        val capture = layoutInspector.captureNow()
            ?: throw ToolException("capture_failed", "无法获取当前窗口布局（无根节点）")
        lastCapture = capture
        val v3 = if (mode == "full") null else LayoutV3.simplify(context, capture)
        lastSnapshot = v3
        return capture to v3
    }

    /** 抓树时机：动作后等待 400ms 静默再抓树，避免过渡动画中间态（v3 配套机制 3） */
    private fun settleIfNeeded() {
        val elapsed = System.currentTimeMillis() - lastActionAt
        if (elapsed < LayoutV3.ACTION_SETTLE_MS) Thread.sleep(LayoutV3.ACTION_SETTLE_MS - elapsed)
    }

    /** 自身保护：目标节点属于 Venture 自身包名时拒绝破坏性动作（规格书 §9） */
    private fun guardSelfTarget(node: NodeInfo?) {
        if (node?.packageName == context.packageName) {
            throw ToolException("self_target_forbidden", "拒绝对自身应用执行破坏性操作")
        }
    }

    // ---------- 感知类 ----------

    private fun screenshot(): JSONObject {
        requireService()
        val result = screenshotHandler.captureScreen()
            ?: throw ToolException("screenshot_failed", "截图失败（可能过于频繁或系统拒绝），可降级使用 get_layout")
        return ok()
            .put("image_path", result.imagePath)
            .put("size", JSONArray(listOf(result.width, result.height)))
    }

    private fun getLayout(args: JSONObject): JSONObject {
        var mode = args.optString("mode", "brief").ifEmpty { "brief" }
        var note: String? = null
        if (mode == "subagent") {
            // subagent 模式仅保留接口（规格书 6.1：由后续具体实现），降级为 brief
            mode = "brief"
            note = "subagent 模式暂未实现，已降级为 brief"
        }
        val (capture, v3) = captureLayout(mode)
        val out = ok()
            .put("windows", capture.windowsToJson())
        if (v3 != null) {
            // v3：行式 DSL 文本（省 token）+ rev 版本 + 元信息（内部已有预算截断控制大小）
            out.put("text", v3.text)
            out.put("rev", v3.rev)
            out.put("truncated", v3.truncated)
            out.put("cut", v3.cutCount)
            out.put("viewport", JSONArray(listOf(v3.viewport.left, v3.viewport.top, v3.viewport.right, v3.viewport.bottom)))
            out.put("screen", "${v3.screenWidth}x${v3.screenHeight}")
            out.put("modal", v3.modal)
            out.put("warnings", JSONArray(v3.warnings))
            out.put("notice", "行式 DSL 布局（text 字段）。坐标与 scroll 方向为准；节点完整属性用 get_node；页面是否变化对比 rev")
        } else {
            // full：完整 JSON 树，大小保护：> 20kB 不返回，引导换用 brief/agent 模式
            val rootJson = capture.root.toJson().toString()
            val size = rootJson.toByteArray(Charsets.UTF_8).size
            if (size > LAYOUT_MAX_BYTES) {
                return error("layout_too_large", "布局树大小过大（$size 字节），请使用 brief 模式或 agent 模式")
            }
            out.put("truncated", false)
            out.put("root", JSONObject(rootJson))
        }
        note?.let { out.put("notice", it) }
        return out
    }

    private fun getNode(args: JSONObject): JSONObject {
        if (!args.has("node_id")) throw ToolException("missing_param", "缺少必需参数: node_id")
        val nodeId = args.getInt("node_id")
        val snapshot = lastSnapshot
            ?: throw ToolException("no_snapshot", "尚无布局快照，请先调用 get_layout")
        val node = snapshot.nodeMap[nodeId]
            ?: throw ToolException("node_not_found", "节点 $nodeId 不在最近一次布局快照中")
        return ok().put("node", v3NodeToJson(node))
    }

    /** v3 节点完整属性（get_node 返回；raw 字段来自捕获快照） */
    private fun v3NodeToJson(n: LayoutV3.PNode): JSONObject {
        val raw = n.node
        val o = JSONObject()
        o.put("node_id", n.id)
        o.put("role", n.role ?: "")
        o.put("desc", n.desc ?: "")
        o.put("text", raw.text ?: "")
        o.put("desc_raw", raw.desc ?: "")
        o.put("center", JSONArray(listOf(n.clickTarget.x, n.clickTarget.y)))
        o.put("bounds", JSONArray(listOf(n.bounds.left, n.bounds.top, n.bounds.right, n.bounds.bottom)))
        n.effectiveFid?.let { o.put("fid", it) }
        o.put("states", JSONArray(n.states))
        o.put("acts", JSONArray(n.acts.toList()))
        o.put("scroll_dir", n.scrollDir ?: "")
        o.put("float", n.float)
        o.put("clipped", n.clipped)
        o.put("occluded", n.occluded)
        o.put("reason", n.reason ?: "")
        o.put("class", raw.className ?: "")
        o.put("pkg", raw.packageName ?: "")
        o.put("clickable", raw.clickable)
        o.put("longClickable", raw.longClickable)
        o.put("scrollable", raw.scrollable)
        o.put("checkable", raw.checkable)
        o.put("checked", raw.checked)
        o.put("enabled", raw.enabled)
        o.put("editable", raw.editable)
        o.put("focusable", raw.focusable)
        o.put("selected", raw.selected)
        o.put("visible", raw.visibleToUser)
        o.put("depth", raw.depth)
        o.put("indexInParent", raw.indexInParent)
        return o
    }

    private fun findNode(args: JSONObject): JSONObject {
        val limit = args.optInt("limit", 10).coerceIn(1, 50)
        val selector = JSONObject()
        listOf("text", "desc", "id", "className").forEach { k ->
            args.optString(k, "").takeIf { it.isNotEmpty() }?.let { selector.put(k, it) }
        }
        listOf("clickable", "scrollable", "checkable", "editable").forEach { k ->
            if (args.has(k)) selector.put(k, args.getBoolean(k))
        }
        if (selector.length() == 0) throw ToolException("missing_param", "find_node 至少需要一个匹配条件")

        // 刷新快照以对齐 node_id 编号（v3 简化结果）
        val (_, v3) = captureLayout("brief")
        val matches = mutableListOf<JSONObject>()
        v3!!.nodeMap.values.forEach { n ->
            if (matches.size >= limit) return@forEach
            if (v3Match(n, selector)) {
                matches.add(JSONObject()
                    .put("node_id", n.id)
                    .put("text", n.desc ?: "")
                    .put("role", n.role ?: "")
                    .put("fid", n.effectiveFid ?: "")
                    .put("bounds", JSONArray(listOf(n.bounds.left, n.bounds.top, n.bounds.right, n.bounds.bottom)))
                    .put("center", JSONArray(listOf(n.clickTarget.x, n.clickTarget.y))))
            }
        }
        return ok().put("matches", JSONArray(matches))
    }

    /** v3 节点选择器匹配（text/desc 子串 → 清洗后 desc；id → fid 后缀/simpleId；className/布尔 → raw） */
    private fun v3Match(n: LayoutV3.PNode, s: JSONObject): Boolean {
        val text = s.optString("text", "")
        if (text.isNotEmpty() && n.desc?.contains(text) != true) return false
        val desc = s.optString("desc", "")
        if (desc.isNotEmpty() && n.desc?.contains(desc) != true) return false
        val id = s.optString("id", "")
        if (id.isNotEmpty()) {
            val fullId = n.effectiveFid ?: return false
            if (!fullId.endsWith(id) && fullId.substringAfterLast("/id/").substringAfterLast('/') != id) return false
        }
        val cls = s.optString("className", "")
        if (cls.isNotEmpty() && n.node.className?.contains(cls) != true) return false
        if (s.has("clickable") && n.node.clickable != s.getBoolean("clickable")) return false
        if (s.has("scrollable") && n.node.scrollable != s.getBoolean("scrollable")) return false
        if (s.has("checkable") && n.node.checkable != s.getBoolean("checkable")) return false
        if (s.has("editable") && n.node.editable != s.getBoolean("editable")) return false
        return true
    }

    private fun getForegroundApp(): JSONObject {
        val service = VentureAccessibilityService.instance
        var pkg = service?.lastForegroundPackage
        if (pkg.isNullOrEmpty()) {
            // 无障碍不可用时降级 UsageStats（需要 PACKAGE_USAGE_STATS 权限，无权限则空）
            pkg = foregroundByUsageStats()
        }
        val appName = pkg?.let {
            runCatching {
                val pm = context.packageManager
                pm.getApplicationLabel(pm.getApplicationInfo(it, 0)).toString()
            }.getOrNull()
        }
        return ok().put("package_name", pkg ?: "").put("app_name", appName ?: "")
    }

    private fun foregroundByUsageStats(): String? {
        if (Build.VERSION.SDK_INT < 22) return null
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = appOps.unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName
        )
        if (mode != AppOpsManager.MODE_ALLOWED) return null
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val end = System.currentTimeMillis()
        val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, end - 60_000, end)
        return stats?.maxByOrNull { it.lastTimeUsed }?.packageName
    }

    private fun getScreenInfo(): JSONObject {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        return ok()
            .put("width", metrics.widthPixels)
            .put("height", metrics.heightPixels)
            .put("dpi", metrics.densityDpi)
            .put("density", metrics.density.toDouble())
    }

    private fun getWindows(): JSONObject {
        requireService()
        val capture = lastCapture ?: layoutInspector.captureNow()
            ?: throw ToolException("capture_failed", "无法获取窗口列表")
        return ok().put("windows", capture.windowsToJson())
    }

    // ---------- 操作类 ----------

    /**
     * click / long_click（v3 配套机制）：
     * node_id 存在 → rev 校验（可选）→ anchor 重定位（实时树重新定位 + 偏移校验）→ 新 safePoint 手势。
     * x,y → 坐标手势。
     */
    private fun clickLike(args: JSONObject, long: Boolean): JSONObject {
        requireService()
        if (args.has("node_id")) {
            val nodeId = args.getInt("node_id")
            val snapshot = lastSnapshot
                ?: throw ToolException("no_snapshot", "尚无布局快照，请先调用 get_layout")
            val old = snapshot.nodeMap[nodeId]
                ?: throw ToolException("node_not_found", "节点 $nodeId 不在最近一次布局快照中")
            checkRev(args, snapshot)
            // anchor 重定位（失败即拒绝并回传新树提示）
            val target = relocate(old, "click")
            guardSelfTarget(target.node)
            val pt = target.clickTarget
            val success = if (long) gestureExecutor.longClick(pt.x, pt.y)
            else gestureExecutor.click(pt.x, pt.y)
            if (!success) throw ToolException("gesture_failed", "手势分发失败")
            lastActionAt = System.currentTimeMillis()
            val out = ok()
                .put("used", "anchor")
                .put("rev", lastSnapshot?.rev ?: "")
            // 无变化检测（配套机制 4）：动作前后 rev 相同 → 明确告知（点击可能未生效）
            if (lastSnapshot?.rev == snapshot.rev) {
                out.put("notice", "页面无变化，点击可能未生效，请重新 get_layout 确认")
            }
            return out
        }
        if (args.has("x") && args.has("y")) {
            val x = args.getInt("x"); val y = args.getInt("y")
            val success = if (long) gestureExecutor.longClick(x, y) else gestureExecutor.click(x, y)
            if (!success) throw ToolException("gesture_failed", "手势分发失败")
            lastActionAt = System.currentTimeMillis()
            return ok().put("used", "coordinate")
        }
        throw ToolException("missing_param", "click 需要 node_id 或 x,y")
    }

    /** rev 校验（可选参数：LLM 携带最近一次 get_layout 的 rev，不匹配即拒绝） */
    private fun checkRev(args: JSONObject, snapshot: LayoutV3.Result) {
        if (args.has("rev") && args.getString("rev") != snapshot.rev) {
            throw ToolException(
                "page_changed",
                "页面已变化（rev 不匹配 ${args.getString("rev")} vs ${snapshot.rev}），请重新 get_layout 观察后重试"
            )
        }
    }

    /**
     * anchor 重定位（v3 配套机制 2）：重新捕获布局 → 简化 → 找 anchor 相同节点。
     * 找不到 → 拒绝（页面已变化）；偏移 > 原节点最大边长 60% → 拒绝（目标位置已变）。
     * 无论成败都刷新会话快照（对齐新编号），失败时错误消息带新 rev。
     */
    private fun relocate(old: LayoutV3.PNode, needAct: String?): LayoutV3.PNode {
        settleIfNeeded()
        val fresh = layoutInspector.captureNow()
            ?: throw ToolException("capture_failed", "无法获取当前窗口布局（无根节点）")
        val result = LayoutV3.simplify(context, fresh)
        lastSnapshot = result
        val target = result.nodeMap.values.firstOrNull { it.anchor == old.anchor }
            ?: throw ToolException(
                "page_changed",
                "目标位置已变（页面已变化 rev=${result.rev}），请重新 get_layout 观察"
            )
        if (needAct != null && !target.acts.contains(needAct) && !target.acts.any { it.startsWith("scroll") }) {
            throw ToolException(
                "page_changed",
                "目标已不可交互（页面已变化 rev=${result.rev}），请重新 get_layout 观察"
            )
        }
        // 偏移校验：中心点位移超过原节点最大边长 60% → 目标位置已变
        val d = hypot(
            target.clickTarget.x - old.center.x.toDouble(),
            target.clickTarget.y - old.center.y.toDouble()
        )
        val maxDim = max(old.bounds.width(), old.bounds.height()).toDouble()
        if (d > maxDim * 0.6) {
            throw ToolException(
                "page_changed",
                "目标位置已变（偏移过大 rev=${result.rev}），请重新 get_layout 观察"
            )
        }
        return target
    }

    /** 由 v3 节点重建实时选择器（优先 fid → desc），供 node_action/scroll 走 performAction */
    private fun selectorFromV3(n: LayoutV3.PNode): JSONObject? {
        val selector = JSONObject()
        when {
            !n.effectiveFid.isNullOrEmpty() -> selector.put("id", n.effectiveFid)
            !n.desc.isNullOrEmpty() -> selector.put("text", n.desc)
            else -> return null
        }
        return selector
    }

    private fun press(args: JSONObject): JSONObject {
        requireService()
        val x = args.getInt("x"); val y = args.getInt("y")
        val duration = args.optLong("duration_ms", GestureExecutor.TAP_DURATION_MS)
        if (!gestureExecutor.press(x, y, duration)) throw ToolException("gesture_failed", "手势分发失败")
        return ok()
    }

    private fun swipe(args: JSONObject): JSONObject {
        requireService()
        val keys = listOf("x1", "y1", "x2", "y2")
        keys.forEach { if (!args.has(it)) throw ToolException("missing_param", "缺少必需参数: $it") }
        val duration = args.optLong("duration_ms", 300)
        if (!gestureExecutor.swipe(
                args.getInt("x1"), args.getInt("y1"), args.getInt("x2"), args.getInt("y2"), duration
            )
        ) throw ToolException("gesture_failed", "手势分发失败")
        return ok()
    }

    private fun gesture(args: JSONObject): JSONObject {
        requireService()
        val pointsArr = args.optJSONArray("points")
            ?: throw ToolException("missing_param", "缺少必需参数: points")
        val points = mutableListOf<Pair<Int, Int>>()
        for (i in 0 until pointsArr.length()) {
            val p = pointsArr.getJSONArray(i)
            points.add(p.getInt(0) to p.getInt(1))
        }
        val duration = args.optLong("duration_ms", 300)
        val start = args.optLong("start_ms", 0)
        if (!gestureExecutor.gesture(start, duration, points)) throw ToolException("gesture_failed", "手势分发失败")
        return ok()
    }

    private fun nodeAction(args: JSONObject): JSONObject {
        requireService()
        if (!args.has("node_id")) throw ToolException("missing_param", "缺少必需参数: node_id")
        val action = requireString(args, "action")
        val nodeId = args.getInt("node_id")
        val snapshot = lastSnapshot
            ?: throw ToolException("no_snapshot", "尚无布局快照，请先调用 get_layout")
        val old = snapshot.nodeMap[nodeId]
            ?: throw ToolException("node_not_found", "节点 $nodeId 不在最近一次布局快照中")
        checkRev(args, snapshot)
        // anchor 重定位（失败即拒绝并回传新树提示）
        val target = relocate(old, null)
        guardSelfTarget(target.node)

        val selector = selectorFromV3(target)
            ?: throw ToolException("no_selector", "节点 $nodeId 无法构造选择器（无 fid/desc）")
        val actionArgs = JSONObject()
        args.optString("text", "").takeIf { it.isNotEmpty() }?.let { actionArgs.put("text", it) }
        args.optJSONObject("args")?.let { extra ->
            extra.keys().forEach { k -> actionArgs.put(k, extra.get(k)) }
        }
        if (!actionExecutor.perform(selector, action, actionArgs)) {
            throw ToolException("action_failed", "节点动作 $action 执行失败（节点可能不支持该动作）")
        }
        lastActionAt = System.currentTimeMillis()
        return ok()
    }

    private fun inputText(args: JSONObject): JSONObject {
        requireService()
        val text = requireString(args, "text")
        val selector = args.optJSONObject("selector")
        val method = textInput.inputText(text, selector)
        if (method == TextInputHandler.Method.FAILED) {
            return ok().put("method", method.wireName)
                .put("error", JSONObject().put("code", "input_failed").put("message", "所有输入路径均失败，请提示用户手动输入"))
        }
        return ok().put("method", method.wireName)
    }

    private fun paste(args: JSONObject): JSONObject {
        requireService()
        var selector = args.optJSONObject("selector")
        if (selector == null && args.has("node_id")) {
            val snapshot = lastSnapshot
                ?: throw ToolException("no_snapshot", "尚无布局快照，请先调用 get_layout")
            val old = snapshot.nodeMap[args.getInt("node_id")]
                ?: throw ToolException("node_not_found", "节点不在最近一次布局快照中")
            checkRev(args, snapshot)
            // anchor 重定位（失败即拒绝并回传新树提示）
            val target = relocate(old, null)
            guardSelfTarget(target.node)
            selector = selectorFromV3(target)
        }
        val text = args.optString("text", "").takeIf { it.isNotEmpty() }
        val method = textInput.paste(selector, text)
        if (method == TextInputHandler.Method.FAILED) {
            throw ToolException("paste_failed", "粘贴失败（节点不支持 PASTE 且菜单粘贴未命中）")
        }
        return ok().put("method", method.wireName)
    }

    private fun keyEvent(args: JSONObject): JSONObject {
        requireService()
        val key = requireString(args, "key")
        if (!keyEventInjector.keyEvent(key)) {
            throw ToolException("key_failed", "按键 $key 注入失败（该按键可能无可靠注入路径）")
        }
        return ok()
    }

    private fun globalAction(args: JSONObject): JSONObject {
        requireService()
        val action = requireString(args, "action")
        if (!globalActions.dispatch(action)) {
            throw ToolException("action_failed", "全局动作 $action 执行失败")
        }
        return ok()
    }

    private fun launchApp(args: JSONObject): JSONObject {
        val app = requireString(args, "app")
        if (!appLauncher.launchApp(app)) {
            throw ToolException("launch_failed", "无法启动应用: $app（未安装或无启动入口）")
        }
        return ok().put("resolved_package", appLauncher.resolvePackage(app) ?: "")
    }

    private fun openUrl(args: JSONObject): JSONObject {
        val url = requireString(args, "url")
        if (!appLauncher.openUrl(url)) {
            throw ToolException("open_url_failed", "无法打开链接: $url")
        }
        return ok()
    }

    /**
     * 停止指定应用（结束其进程，Run_script 前清理干扰软件用）。
     *
     * 仅 root 路径：`am force-stop`（最可靠）。无 root 时返回 root_required 错误，
     * 提示用户手动关闭应用（不做不可靠降级尝试）。
     */
    private fun stopApp(args: JSONObject): JSONObject {
        val pkg = requireString(args, "package_name")
        return appStopper.stop(pkg)
    }

    private fun scroll(args: JSONObject): JSONObject {
        requireService()
        val direction = requireString(args, "direction")
        val times = args.optInt("times", 1).coerceIn(1, 20)
        val actionFor = { d: String ->
            when (d) {
                "up" -> "scrollBackward"; "down" -> "scrollForward"
                "left" -> "scrollLeft"; "right" -> "scrollRight"
                else -> throw ToolException("bad_param", "未知滚动方向: $d")
            }
        }
        repeat(times) {
            val success = if (args.has("node_id")) {
                val snapshot = lastSnapshot
                    ?: throw ToolException("no_snapshot", "尚无布局快照，请先调用 get_layout")
                val old = snapshot.nodeMap[args.getInt("node_id")]
                    ?: throw ToolException("node_not_found", "节点不在最近一次布局快照中")
                checkRev(args, snapshot)
                // anchor 重定位（失败即拒绝并回传新树提示）
                val target = relocate(old, null)
                val selector = selectorFromV3(target)
                    ?: throw ToolException("no_selector", "节点无法构造选择器")
                actionExecutor.perform(selector, actionFor(direction))
            } else {
                // 屏幕内滑动（up=内容向上滚=手指下滑到上，即向上轻扫）
                val cx = getScreenWidth() / 2
                val h = getScreenHeight()
                when (direction) {
                    "up" -> gestureExecutor.swipe(cx, (h * 0.35).toInt(), cx, (h * 0.75).toInt(), 300)
                    "down" -> gestureExecutor.swipe(cx, (h * 0.75).toInt(), cx, (h * 0.35).toInt(), 300)
                    "left" -> gestureExecutor.swipe((getScreenWidth() * 0.3).toInt(), h / 2, (getScreenWidth() * 0.7).toInt(), h / 2, 300)
                    "right" -> gestureExecutor.swipe((getScreenWidth() * 0.7).toInt(), h / 2, (getScreenWidth() * 0.3).toInt(), h / 2, 300)
                    else -> throw ToolException("bad_param", "未知滚动方向: $direction")
                }
            }
            if (!success) throw ToolException("scroll_failed", "滚动失败（方向: $direction）")
            if (times > 1) Thread.sleep(350)
        }
        lastActionAt = System.currentTimeMillis()
        return ok()
    }

    private fun getScreenWidth(): Int =
        (getScreenInfo().optInt("width", 1080))

    private fun getScreenHeight(): Int =
        (getScreenInfo().optInt("height", 2400))

    // ---------- 控制类（轮询/等待，规格书 6.3：500ms 轮询） ----------

    private fun waitForNode(args: JSONObject): JSONObject {
        val selector = args.optJSONObject("selector")
            ?: throw ToolException("missing_param", "缺少必需参数: selector")
        val timeout = args.optLong("timeout_ms", DEFAULT_WAIT_TIMEOUT_MS).coerceIn(500, 120_000)
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            val found = runCatching {
                val (_, v3) = captureLayout("brief")
                v3?.nodeMap?.values?.firstOrNull { v3Match(it, selector) }
            }.getOrNull()
            if (found != null) return ok().put("node_id", found.id)
            Thread.sleep(WAIT_POLL_INTERVAL_MS)
        }
        return JSONObject().put("ok", false)
            .put("error", JSONObject().put("code", "timeout").put("message", "wait_for_node 超时（${timeout}ms）"))
    }

    private fun waitForText(args: JSONObject): JSONObject {
        val text = requireString(args, "text")
        val timeout = args.optLong("timeout_ms", DEFAULT_WAIT_TIMEOUT_MS).coerceIn(500, 120_000)
        val selector = JSONObject().put("text", text)
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            val found = runCatching {
                val (_, v3) = captureLayout("brief")
                v3?.nodeMap?.values?.firstOrNull { v3Match(it, selector) }
            }.getOrNull()
            if (found != null) return ok().put("node_id", found.id)
            Thread.sleep(WAIT_POLL_INTERVAL_MS)
        }
        return JSONObject().put("ok", false)
            .put("error", JSONObject().put("code", "timeout").put("message", "wait_for_text 超时: \"$text\"（${timeout}ms）"))
    }

    private fun waitForApp(args: JSONObject): JSONObject {
        val nameOrPkg = args.optString("package_name", "").ifEmpty {
            args.optString("pkg", "").ifEmpty { args.optString("app_name", "") }
        }
        if (nameOrPkg.isEmpty()) throw ToolException("missing_param", "缺少必需参数: package_name 或 app_name")
        val targetPkg = appLauncher.resolvePackage(nameOrPkg) ?: nameOrPkg
        val timeout = args.optLong("timeout_ms", 8_000L).coerceIn(500, 120_000)
        val deadline = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < deadline) {
            val foreground = getForegroundApp().optString("package_name", "")
            if (foreground == targetPkg) return ok().put("package_name", foreground)
            Thread.sleep(WAIT_POLL_INTERVAL_MS)
        }
        return JSONObject().put("ok", false)
            .put("error", JSONObject().put("code", "timeout").put("message", "wait_for_app 超时: $targetPkg（${timeout}ms）"))
    }
}
