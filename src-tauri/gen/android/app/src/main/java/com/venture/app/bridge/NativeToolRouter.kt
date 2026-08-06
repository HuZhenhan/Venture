package com.venture.app.bridge

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.DisplayMetrics
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import com.venture.app.accessibility.AccessibilityBridge
import com.venture.app.accessibility.Capture
import com.venture.app.accessibility.LayoutCompressor
import com.venture.app.accessibility.LayoutInspector
import com.venture.app.accessibility.NodeInfo
import com.venture.app.accessibility.VentureAccessibilityService
import com.venture.app.accessibility.automator.ActionExecutor
import com.venture.app.accessibility.automator.AppLauncher
import com.venture.app.accessibility.automator.GestureExecutor
import com.venture.app.accessibility.automator.GlobalActionExecutor
import com.venture.app.accessibility.automator.KeyEventInjector
import com.venture.app.accessibility.automator.NodeFinder
import com.venture.app.accessibility.automator.ScreenMetrics
import com.venture.app.accessibility.automator.ScreenshotHandler
import com.venture.app.accessibility.automator.TextInputHandler
import org.json.JSONArray
import org.json.JSONObject

/**
 * 原生工具路由（对应规格书 6.6 tool_router 的原生侧）。
 *
 * - 入参校验：必须字段缺失 → 明确错误（LLM 可自我纠正重调）
 * - 全部返回结构化 JSON，失败带 error:{code,message}
 * - 维护"最近一次布局快照"（编号 → NodeInfo），供 get_node / click(node_id) 查表转坐标
 * - wait_for_*：500ms 轮询直至命中或超时（规格书 6.3）
 */
class NativeToolRouter(private val context: Context) {

    companion object {
        const val WAIT_POLL_INTERVAL_MS = 500L
        const val DEFAULT_WAIT_TIMEOUT_MS = 10_000L
    }

    private val bridge = AccessibilityBridge()
    private val layoutInspector = LayoutInspector(context)
    private val screenMetrics = ScreenMetrics.from(context)
    private val actionExecutor = ActionExecutor(bridge)
    private val gestureExecutor = GestureExecutor({ VentureAccessibilityService.instance }, screenMetrics)
    private val globalActions = GlobalActionExecutor({ VentureAccessibilityService.instance })
    private val textInput = TextInputHandler(context, bridge, actionExecutor, gestureExecutor)
    private val appLauncher = AppLauncher(context)
    private val keyEventInjector = KeyEventInjector(context, bridge, globalActions, actionExecutor)
    private val screenshotHandler = ScreenshotHandler(context) { VentureAccessibilityService.instance }

    /** 最近一次布局快照（brief 编号表），click(node_id)/get_node 查表用 */
    @Volatile
    private var lastSnapshot: LayoutCompressor.Compressed? = null

    @Volatile
    private var lastCapture: Capture? = null

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

    /** 捕获布局（brief/full），刷新会话快照 */
    private fun captureLayout(mode: String): Pair<Capture, LayoutCompressor.Compressed?> {
        requireService()
        val capture = layoutInspector.captureNow()
            ?: throw ToolException("capture_failed", "无法获取当前窗口布局（无根节点）")
        lastCapture = capture
        val compressed = if (mode == "full") null else LayoutCompressor.compress(capture.root)
        lastSnapshot = compressed
        return capture to compressed
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
        val (capture, compressed) = captureLayout(mode)
        val out = ok()
            .put("windows", capture.windowsToJson())
        if (compressed != null) {
            out.put("truncated", compressed.truncated)
            out.put("root", compressed.root)
        } else {
            out.put("truncated", false)
            out.put("root", capture.root.toJson())
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
        return ok().put("node", node.toJson(nodeId))
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

        // 刷新快照以对齐 node_id 编号
        val (_, compressed) = captureLayout("brief")
        val matches = mutableListOf<JSONObject>()
        findInSnapshot(compressed, selector, limit, matches)
        return ok().put("matches", JSONArray(matches))
    }

    /** 在快照树（数据层）中按选择器匹配，返回带 brief 编号的条目 */
    private fun findInSnapshot(
        compressed: LayoutCompressor.Compressed?,
        selector: JSONObject,
        limit: Int,
        out: MutableList<JSONObject>,
    ) {
        val root = lastCapture?.root ?: return
        val idByNode = compressed?.nodeMap?.entries?.associate { (id, node) -> node to id } ?: emptyMap()

        fun nodeMatches(n: NodeInfo): Boolean {
            val text = selector.optString("text", "")
            if (text.isNotEmpty() && n.text?.contains(text) != true) return false
            val desc = selector.optString("desc", "")
            if (desc.isNotEmpty() && n.desc?.contains(desc) != true) return false
            val id = selector.optString("id", "")
            if (id.isNotEmpty()) {
                val fullId = n.fullId ?: return false
                if (!fullId.endsWith(id) && n.simpleId != id) return false
            }
            val cls = selector.optString("className", "")
            if (cls.isNotEmpty() && n.className?.contains(cls) != true) return false
            if (selector.has("clickable") && n.clickable != selector.getBoolean("clickable")) return false
            if (selector.has("scrollable") && n.scrollable != selector.getBoolean("scrollable")) return false
            if (selector.has("checkable") && n.checkable != selector.getBoolean("checkable")) return false
            if (selector.has("editable") && n.editable != selector.getBoolean("editable")) return false
            return true
        }

        fun dfs(n: NodeInfo) {
            if (out.size >= limit) return
            if (nodeMatches(n)) {
                val item = JSONObject()
                    .put("node_id", idByNode[n] ?: -1)
                    .put("text", n.text ?: "")
                    .put("desc", n.desc ?: "")
                    .put("class", n.className ?: "")
                    .put("bounds", JSONArray(listOf(n.boundsInScreen.left, n.boundsInScreen.top, n.boundsInScreen.right, n.boundsInScreen.bottom)))
                    .put("center", JSONArray(listOf(n.center.x, n.center.y)))
                    .put("clickable", n.clickable)
                out.add(item)
            }
            n.children.forEach { dfs(it) }
        }
        dfs(root)
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
     * click / long_click（规格书 6.2）：
     * node_id 存在 → 快照节点可 performAction 则节点动作，否则按快照坐标手势；x,y → 坐标手势。
     */
    private fun clickLike(args: JSONObject, long: Boolean): JSONObject {
        requireService()
        if (args.has("node_id")) {
            val nodeId = args.getInt("node_id")
            val snapshot = lastSnapshot
                ?: throw ToolException("no_snapshot", "尚无布局快照，请先调用 get_layout")
            val node = snapshot.nodeMap[nodeId]
                ?: throw ToolException("node_not_found", "节点 $nodeId 不在最近一次布局快照中")
            guardSelfTarget(node)

            val actionName = if (long) "longClick" else "click"
            val actionConst = if (long) "ACTION_LONG_CLICK" else "ACTION_CLICK"
            if (node.actionNames.contains(actionConst)) {
                val selector = selectorFromSnapshotNode(node)
                if (selector != null && actionExecutor.perform(selector, actionName)) {
                    return ok().put("used", "node")
                }
            }
            // 坐标兜底（快照过期由调用方重新 capture，见规格书 3.7/5.2）
            val success = if (long) gestureExecutor.longClick(node.center.x, node.center.y)
            else gestureExecutor.click(node.center.x, node.center.y)
            if (!success) throw ToolException("gesture_failed", "手势分发失败")
            return ok().put("used", "coordinate")
        }
        if (args.has("x") && args.has("y")) {
            val x = args.getInt("x"); val y = args.getInt("y")
            val success = if (long) gestureExecutor.longClick(x, y) else gestureExecutor.click(x, y)
            if (!success) throw ToolException("gesture_failed", "手势分发失败")
            return ok().put("used", "coordinate")
        }
        throw ToolException("missing_param", "click 需要 node_id 或 x,y")
    }

    /** 由快照节点重建选择器（优先 id → text → desc，唯一性靠 bounds 二次确认） */
    private fun selectorFromSnapshotNode(node: NodeInfo): JSONObject? {
        val selector = JSONObject()
        when {
            !node.simpleId.isNullOrEmpty() -> selector.put("id", node.simpleId)
            !node.text.isNullOrEmpty() -> selector.put("text", node.text)
            !node.desc.isNullOrEmpty() -> selector.put("desc", node.desc)
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
        val node = snapshot.nodeMap[nodeId]
            ?: throw ToolException("node_not_found", "节点 $nodeId 不在最近一次布局快照中")
        guardSelfTarget(node)

        val selector = selectorFromSnapshotNode(node)
            ?: throw ToolException("no_selector", "节点 $nodeId 无法构造选择器（无 id/text/desc）")
        val actionArgs = JSONObject()
        args.optString("text", "").takeIf { it.isNotEmpty() }?.let { actionArgs.put("text", it) }
        args.optJSONObject("args")?.let { extra ->
            extra.keys().forEach { k -> actionArgs.put(k, extra.get(k)) }
        }
        if (!actionExecutor.perform(selector, action, actionArgs)) {
            throw ToolException("action_failed", "节点动作 $action 执行失败（节点可能不支持该动作）")
        }
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
            val node = snapshot.nodeMap[args.getInt("node_id")]
                ?: throw ToolException("node_not_found", "节点不在最近一次布局快照中")
            guardSelfTarget(node)
            selector = selectorFromSnapshotNode(node)
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

    private fun scroll(args: JSONObject): JSONObject {
        requireService()
        val direction = requireString(args, "direction")
        val times = args.optInt("times", 1).coerceIn(1, 20)
        repeat(times) {
            val success = if (args.has("node_id")) {
                val snapshot = lastSnapshot
                    ?: throw ToolException("no_snapshot", "尚无布局快照，请先调用 get_layout")
                val node = snapshot.nodeMap[args.getInt("node_id")]
                    ?: throw ToolException("node_not_found", "节点不在最近一次布局快照中")
                val selector = selectorFromSnapshotNode(node)
                    ?: throw ToolException("no_selector", "节点无法构造选择器")
                val action = when (direction) {
                    "up" -> "scrollBackward"; "down" -> "scrollForward"
                    "left" -> "scrollLeft"; "right" -> "scrollRight"
                    else -> throw ToolException("bad_param", "未知滚动方向: $direction")
                }
                actionExecutor.perform(selector, action)
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
                val (capture, compressed) = captureLayout("brief")
                val matches = mutableListOf<JSONObject>()
                findInSnapshot(compressed, selector, 1, matches)
                matches.firstOrNull()
            }.getOrNull()
            if (found != null) return ok().put("node_id", found.optInt("node_id", -1))
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
                val (_, compressed) = captureLayout("brief")
                val matches = mutableListOf<JSONObject>()
                findInSnapshot(compressed, selector, 1, matches)
                matches.firstOrNull()
            }.getOrNull()
            if (found != null) return ok().put("node_id", found.optInt("node_id", -1))
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
