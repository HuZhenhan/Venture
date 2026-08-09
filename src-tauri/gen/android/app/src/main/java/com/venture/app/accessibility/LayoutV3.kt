package com.venture.app.accessibility

import android.content.Context
import android.graphics.Point
import android.graphics.Rect
import android.util.DisplayMetrics
import android.view.WindowManager
import android.view.accessibility.AccessibilityWindowInfo
import java.security.MessageDigest
import java.util.Locale
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * 布局树深度简化 v3 —— 替换 LayoutCompressor 的 brief 模式（用户方案一比一实现）。
 *
 * 11 步管线：
 *   0 多窗口归一 → 1 几何归一 → 2 可见性分流 → 3 文本清洗 → 4 几何去重
 *   → 5 语义剪枝 → 6 结构压平 → 7 遮挡校验 → 8 角色&状态推断
 *   → 9 列表识别&一行化 → 10 预算截断 → 11 行式 DSL 序列化
 * 配套机制：rev 快照版本（页面变化检测）、anchor 稳定锚点（执行器重定位）。
 *
 * 输出为行式 DSL（替代 JSON，省 50~70% token）：
 *   screen <W>x<H> viewport=[x1,y1,x2,y2] app=<pkg> page=<activity> rev=<hash>
 *   --- chrome ---
 *   <id> <role> <desc> @<cx>,<cy> [#<fid>] [*<state>] [float] [clipped] [occluded]
 *   --- offscreen ---
 *   <id> <role> <desc> [#<fid>] [*<state>] reason:<reason>
 *   --- list #<id> scroll<方向> box=[...] items=<visible>/<total> ---
 *   <id> item <desc拼接> @<cx>,<cy>
 *      <id> <role> <desc> @<cx>,<cy>
 *   +<N> items below (scroll↓)
 *   --- warnings ---
 *   - <warning>
 */
object LayoutV3 {

    const val MAX_OFFSCREEN = 15
    const val NODE_LIMIT = 150
    const val TOKEN_LIMIT = 1500
    const val LIST_MIN_ITEMS = 3
    const val DESC_MAX_LEN = 60
    const val DESC_BUDGET_LEN = 30

    // 动作后静默等待时长（抓树时机，配套机制 3）
    const val ACTION_SETTLE_MS = 400L

    // ── 输出模型 ──────────────────────────────────────────────

    /** 简化后节点（序列化行 + 执行器重定位的句柄） */
    class PNode(
        val node: NodeInfo,
        var desc: String?,
        var parent: PNode? = null,
        var children: MutableList<PNode> = mutableListOf(),
        var kept: Boolean = true,
        var offscreen: Boolean = false,
        var reason: String? = null,
        var removed: Boolean = false,
        var outOfViewport: Boolean = false,
        var clipped: Boolean = false,
        var safePoint: Point? = null,
        var occluded: Boolean = false,
        var role: String? = null,
        var states: List<String> = emptyList(),
        var scrollDir: String? = null,
        var acts: Set<String> = emptySet(),
        var extraActs: MutableSet<String> = mutableSetOf(),
        var float: Boolean = false,
        var anchor: String = "",
        var pathForAnchor: String = "",
        var inheritedFid: String? = null,
        var listContainer: Boolean = false,
        var isItem: Boolean = false,
        var subActions: List<PNode> = emptyList(),
    ) {
        var id: Int = -1

        val bounds: Rect get() = node.boundsInScreen
        val center: Point get() = node.center
        val clickTarget: Point get() = safePoint ?: node.center
        fun area(): Int = bounds.width() * bounds.height()

        /** 方案 6 可交互：clickable || scrollable || checkable || editable */
        val interactive: Boolean
            get() = node.clickable || node.scrollable || node.checkable || node.editable

        /** 方案 2 offscreen 可交互：clickable || checkable || scrollable */
        val interactiveLoose: Boolean
            get() = node.clickable || node.checkable || node.scrollable

        val effectiveFid: String? get() = node.fullId ?: inheritedFid
    }

    /** 简化结果 */
    class Result(
        val text: String,
        val rev: String,
        val nodeMap: Map<Int, PNode>,
        val truncated: Boolean,
        val cutCount: Int,
        val warnings: List<String>,
        val viewport: Rect,
        val screenWidth: Int,
        val screenHeight: Int,
        val modal: Boolean,
        val pkg: String?,
        val page: String?,
    )

    // ── 主入口 ────────────────────────────────────────────────

    fun simplify(context: Context, capture: Capture): Result {
        val (w, h) = screenSize(context)
        val viewport = computeViewport(context, w, h)
        val warnings = mutableListOf<String>()

        // 0. 多窗口归一
        val sel = selectWindow(capture, viewport, warnings)

        // 3. 文本清洗（建树即清洗，供后续步骤使用）
        val fidFreq = HashMap<String, Int>()
        countFids(sel.root, fidFreq)
        val root = PNode(sel.root, effectiveText(sel.root))
        buildTree(sel.root, root)

        // 1. 几何归一
        markGeometry(root, viewport)

        // 2. 可见性分流（offscreen 旁路 vs 真剪除）
        val offscreen = mutableListOf<PNode>()
        splitOffscreen(root, viewport, offscreen, fidFreq)

        // 4. 几何去重（IoU 合并 + 祖先吸收 + 文本包含）
        dedup(root, viewport, fidFreq)

        // 5. 语义剪枝
        prune(root, fidFreq)
        root.kept = true
        detachNotKept(root)

        // 6. 结构压平（透明容器塌缩，fid 向下继承）
        flattenChildren(root, fidFreq)

        // 7. 遮挡校验（safePoint / occluded）
        occlusion(root, viewport)

        // 8. 角色 & 状态推断（含 offscreen 节点）
        inferAll(root, viewport, fidFreq)
        offscreen.forEach { inferNode(it, viewport, fidFreq) }

        // 9. 列表识别 & 一行化
        detectLists(root)

        // 10/11. 预算截断 + 行式 DSL 序列化
        return serialize(root, offscreen, viewport, w, h, sel, warnings, fidFreq)
    }

    // ── 第 0 步：多窗口归一 ──────────────────────────────────────

    private class SelectResult(val root: NodeInfo, val modal: Boolean, val page: String?)

    private fun selectWindow(capture: Capture, vp: Rect, warnings: MutableList<String>): SelectResult {
        val windows = capture.windows
            .filter { it.root != null && it.type != AccessibilityWindowInfo.TYPE_INPUT_METHOD }
            .sortedByDescending { it.order }
        if (windows.isEmpty()) {
            // 系统 windows 列表不可用（部分设备/服务刚启动/时序问题）时降级：
            // 直接使用活动窗口根节点（captureNow 已成功拿到），保证布局可用
            warnings.add("windows 列表不可用，已降级使用活动窗口根节点")
            return SelectResult(capture.root, false, null)
        }
        val vpArea = vp.width() * vp.height()
        val appTitle = capture.windows
            .filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .maxByOrNull { it.order }?.title?.toString()?.take(40)

        for (w in windows) {
            val r = w.root!!
            // 空浮层容器（面积 > 80% 视口 + 无文本 + 无可见子孙）：不输出，写入 warnings
            if (isEmptyOverlay(r, vp, vpArea)) {
                warnings.add("存在空浮层容器 <${r.className ?: r.packageName ?: "?"}>")
                continue
            }
            // 非 application 窗口（system/accessibility_overlay）→ modal
            if (w.type != AccessibilityWindowInfo.TYPE_APPLICATION) {
                return SelectResult(r, true, appTitle)
            }
            // application 窗口内全屏 clickable 容器 → modal 子树（背景树丢弃）
            val full = findFullscreenClickable(r, vp, vpArea)
            if (full != null) return SelectResult(full, true, appTitle)
            return SelectResult(r, false, appTitle)
        }
        throw IllegalStateException("全部窗口均为空浮层")
    }

    private fun isEmptyOverlay(n: NodeInfo, vp: Rect, vpArea: Int): Boolean {
        if (n.boundsInScreen.width() * n.boundsInScreen.height() <= vpArea * 0.8) return false
        if (hasAnyText(n)) return false
        return !hasVisibleDescendantNode(n)
    }

    private fun hasAnyText(n: NodeInfo): Boolean {
        if (cleanText(n.desc) != null || cleanText(n.text) != null) return true
        return n.children.any { hasAnyText(it) }
    }

    private fun hasVisibleDescendantNode(n: NodeInfo): Boolean {
        if (n.visibleToUser) return true
        return n.children.any { hasVisibleDescendantNode(it) }
    }

    private fun hasEffectiveDescendant(n: NodeInfo): Boolean {
        if (cleanText(n.desc) != null || cleanText(n.text) != null) return true
        if (n.clickable || n.scrollable || n.checkable) return true
        return n.children.any { hasEffectiveDescendant(it) }
    }

    /** 全屏 clickable 容器：面积 > 80% 视口 && clickable && 含可见子孙（DFS 先序取最外层） */
    private fun findFullscreenClickable(n: NodeInfo, vp: Rect, vpArea: Int): NodeInfo? {
        if (n.clickable && n.visibleToUser &&
            n.boundsInScreen.width() * n.boundsInScreen.height() > vpArea * 0.8 &&
            hasVisibleDescendantNode(n)
        ) return n
        for (c in n.children) {
            findFullscreenClickable(c, vp, vpArea)?.let { return it }
        }
        return null
    }

    // ── 第 1 步：几何归一 ────────────────────────────────────────

    private fun screenSize(context: Context): Pair<Int, Int> {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val m = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    private fun computeViewport(context: Context, w: Int, h: Int): Rect {
        val statusBar = dimensionResource(context, "status_bar_height")
        val navBar = dimensionResource(context, "navigation_bar_height")
        return Rect(0, statusBar, w, h - navBar)
    }

    private fun dimensionResource(context: Context, name: String): Int {
        val id = context.resources.getIdentifier(name, "dimen", "android")
        return if (id > 0) runCatching { context.resources.getDimensionPixelSize(id) }.getOrDefault(0) else 0
    }

    private fun markGeometry(p: PNode, vp: Rect) {
        val b = p.bounds
        val inter = Rect(b)
        val ok = inter.intersect(vp)
        if (!ok || inter.width() <= 0 || inter.height() <= 0) {
            p.outOfViewport = true
        } else if (inter.width() < b.width() || inter.height() < b.height()) {
            p.clipped = true
        }
        p.children.forEach { markGeometry(it, vp) }
    }

    // ── 第 2 步：可见性分流 ──────────────────────────────────────

    private fun splitOffscreen(root: PNode, vp: Rect, offscreen: MutableList<PNode>, fidFreq: Map<String, Int>) {
        fun walk(p: PNode) {
            val area = p.bounds.width() * p.bounds.height()
            val hasContent = p.desc != null || (p.node.fullId != null && (fidFreq[p.node.fullId] ?: 0) == 1)
            if ((!p.node.visibleToUser || area <= 0) && p.interactiveLoose && hasContent && !p.outOfViewport) {
                // A. offscreen 旁路
                p.offscreen = true
                p.reason = if (p.clipped) "clipped" else "collapsed"
                p.pathForAnchor = ancestorPath(p)
                offscreen.add(p)
            } else if (!p.offscreen) {
                // B. 真剪除
                val pruned1 = !p.node.visibleToUser && !hasVisibleDescendantNode(p.node)
                val pruned2 = area <= 0 && !hasEffectiveDescendant(p.node)
                val pruned3 = p.outOfViewport && p.parent?.node?.scrollable != true
                if (pruned1 || pruned2 || pruned3) p.removed = true
            }
            p.children.forEach { walk(it) }
        }
        walk(root)
        // 物理移除（offscreen 节点进入旁路数组，从主树摘除）
        fun detach(p: PNode) {
            p.children.removeAll { it.removed || it.offscreen }
            p.children.forEach { detach(it) }
        }
        detach(root)
    }

    // ── 第 3 步：文本清洗 ────────────────────────────────────────

    private val PUA_RE = Regex("[\uE000-\uF8FF]")
    private val ZW_RE = Regex("[\u200B-\u200F\uFEFF]")
    private val PUNCT_ONLY_RE = Regex("^[\\p{P}\\p{Z}\\p{C}\\s]*$")

    /** 清洗管线：PUA 剥离 → 零宽剥离 → 标点空判定 → 截断 → trim */
    fun cleanText(t: String?): String? {
        if (t == null) return null
        var s = PUA_RE.replace(t, "")
        s = ZW_RE.replace(s, "")
        s = s.trim()
        if (s.isEmpty()) return null
        if (PUNCT_ONLY_RE.matches(s)) return null
        if (s.length > DESC_MAX_LEN) s = s.take(DESC_MAX_LEN) + "…"
        return s
    }

    /** desc 取值优先级：清洗后 desc → 清洗后 text → 无文本 */
    private fun effectiveText(n: NodeInfo): String? {
        cleanText(n.desc)?.let { return it }
        return cleanText(n.text)
    }

    private fun buildTree(n: NodeInfo, p: PNode) {
        for (c in n.children) {
            val cp = PNode(c, effectiveText(c))
            cp.parent = p
            p.children.add(cp)
            buildTree(c, cp)
        }
    }

    private fun countFids(n: NodeInfo, out: HashMap<String, Int>) {
        n.fullId?.let { out[it] = (out[it] ?: 0) + 1 }
        n.children.forEach { countFids(it, out) }
    }

    private fun hasUniqueFid(p: PNode, fidFreq: Map<String, Int>): Boolean {
        val fid = p.node.fullId ?: return false
        return fidFreq[fid] == 1
    }

    // ── 第 4 步：几何去重 ────────────────────────────────────────

    private fun iou(a: Rect, b: Rect): Float {
        val iw = min(a.right, b.right) - max(a.left, b.left)
        val ih = min(a.bottom, b.bottom) - max(a.top, b.top)
        if (iw <= 0 || ih <= 0) return 0f
        val inter = iw * ih
        val union = a.width() * a.height() + b.width() * b.height() - inter
        return if (union <= 0) 0f else inter.toFloat() / union
    }

    private fun dedup(root: PNode, vp: Rect, fidFreq: Map<String, Int>) {
        // A. IoU 合并（同父兄弟，>0.9）
        fun iouMerge(p: PNode) {
            val kids = p.children
            var i = 0
            while (i < kids.size) {
                var j = i + 1
                while (j < kids.size) {
                    val a = kids[i]
                    val b = kids[j]
                    if (a.interactiveLoose && b.interactiveLoose && iou(a.bounds, b.bounds) > 0.9f) {
                        // 保留面积大的
                        if (b.area() > a.area()) {
                            val tmp = a
                            kids[i] = b
                            kids[j] = tmp
                        }
                        val keep = kids[i]
                        val drop = kids[j]
                        // desc 取非空且更长的
                        val kd = keep.desc
                        val dd = drop.desc
                        when {
                            kd == null -> keep.desc = dd
                            dd != null && dd.length > kd.length -> keep.desc = dd
                        }
                        // acts 取并集（推断时合并）
                        keep.extraActs.addAll(drop.node.actionNames)
                        drop.removed = true
                        kids.removeAt(j)
                    } else j++
                }
                i++
            }
            kids.removeAll { it.removed }
            kids.forEach { iouMerge(it) }
        }
        iouMerge(root)

        // B. 祖先吸收（desc 空且无 fid 的可交互节点被有 desc 的可交互祖先完全包含时丢弃）
        fun absorb(p: PNode) {
            val removable = mutableListOf<PNode>()
            for (c in p.children) {
                if (c.interactive && c.desc == null && !hasUniqueFid(c, fidFreq)) {
                    var y: PNode? = p
                    while (y != null) {
                        if (y.interactive && y.desc != null && containsRect(y.bounds, c.bounds)) break
                        y = y.parent
                    }
                    if (y != null) {
                        // 例外：位于祖先四角/边缘 15% 带内的小控件（关闭×、收藏♡、更多⋯）
                        val inEdge = inEdgeBand(y.bounds, c.center)
                        val tiny = c.area() < y.area() * 0.1
                        if (!(inEdge && tiny)) removable.add(c)
                    }
                }
                absorb(c)
            }
            p.children.removeAll { it in removable }
        }
        absorb(root)

        // C. 文本包含去重（与父级或兄弟完全包含 → 保留信息更全的）
        fun textDedup(p: PNode) {
            val pd = p.desc
            if (pd != null) {
                for (c in p.children) {
                    val cd = c.desc ?: continue
                    when {
                        pd.contains(cd) && cd.length <= pd.length -> c.desc = null
                        cd.contains(pd) && pd.length < cd.length -> p.desc = null
                    }
                }
            }
            val kids = p.children
            for (i in kids.indices) {
                val a = kids[i].desc ?: continue
                for (j in i + 1 until kids.size) {
                    val b = kids[j].desc ?: continue
                    if (a.contains(b) && b.length <= a.length) kids[j].desc = null
                    else if (b.contains(a) && a.length <= b.length) kids[i].desc = null
                }
            }
            kids.forEach { textDedup(it) }
        }
        textDedup(root)
    }

    private fun containsRect(outer: Rect, inner: Rect): Boolean =
        inner.left >= outer.left && inner.top >= outer.top &&
            inner.right <= outer.right && inner.bottom <= outer.bottom

    /** point 是否落在 rect 的边缘 ratio 带状区内 */
    private fun inEdgeBand(rect: Rect, point: Point, ratio: Float = 0.15f): Boolean {
        val dw = rect.width() * ratio
        val dh = rect.height() * ratio
        return point.x < rect.left + dw || point.x > rect.right - dw ||
            point.y < rect.top + dh || point.y > rect.bottom - dh
    }

    // ── 第 5 步：语义剪枝 ────────────────────────────────────────

    private fun prune(p: PNode, fidFreq: Map<String, Int>): Boolean {
        val childKept = p.children.map { prune(it, fidFreq) }
        val keepSelf = p.desc != null || p.interactive || hasUniqueFid(p, fidFreq)
        val keep = keepSelf || childKept.any { it }
        if (!keep) p.kept = false
        return keep
    }

    private fun detachNotKept(p: PNode) {
        p.children.removeAll { !it.kept }
        p.children.forEach { detachNotKept(it) }
    }

    // ── 第 6 步：结构压平 ────────────────────────────────────────

    /** 透明容器：desc 空 && 不可交互 && 无唯一 fid && 子节点数 === 1 → 替换为子节点，fid 向下继承 */
    private fun flattenChildren(p: PNode, fidFreq: Map<String, Int>) {
        var i = 0
        while (i < p.children.size) {
            val c = p.children[i]
            flattenChildren(c, fidFreq)
            if (c.desc == null && !c.interactive && !hasUniqueFid(c, fidFreq) && c.children.size == 1) {
                val child = c.children[0]
                child.parent = p
                if (child.node.fullId == null && c.node.fullId != null) child.inheritedFid = c.node.fullId
                p.children[i] = child
                // i 不递增：新节点可能仍透明，继续检查
            } else i++
        }
    }

    // ── 第 7 步：遮挡校验 ────────────────────────────────────────

    /** 按绘制顺序（后出现的兄弟在上）：center 被上层覆盖 → 重算 safePoint；无安全点 → occluded */
    private fun occlusion(root: PNode, vp: Rect) {
        fun walk(p: PNode) {
            val sorted = p.children.sortedBy { it.node.indexInParent }
            for (i in sorted.indices) {
                val c = sorted[i]
                if (c.interactive) {
                    val upper = sorted.drop(i + 1).flatMap { collectInteractiveNodes(it) }
                    val sp = findSafePoint(c, upper, vp)
                    if (sp != null) c.safePoint = sp else c.occluded = true
                }
                walk(c)
            }
        }
        walk(root)
    }

    private fun collectInteractiveNodes(p: PNode): List<PNode> =
        (if (p.interactive) listOf(p) else emptyList()) + p.children.flatMap { collectInteractiveNodes(it) }

    private fun findSafePoint(c: PNode, upper: List<PNode>, vp: Rect): Point? {
        val b = c.bounds
        val w6 = b.width() / 6
        val h6 = b.height() / 6
        val candidates = mutableListOf<Point>()
        candidates.add(Point(b.centerX(), b.centerY()))
        candidates.add(Point(b.left + w6, b.top + h6))
        candidates.add(Point(b.right - w6, b.top + h6))
        candidates.add(Point(b.left + w6, b.bottom - h6))
        candidates.add(Point(b.right - w6, b.bottom - h6))
        candidates.add(Point(b.centerX(), b.top + h6))
        candidates.add(Point(b.centerX(), b.bottom - h6))
        candidates.add(Point(b.left + w6, b.centerY()))
        candidates.add(Point(b.right - w6, b.centerY()))
        for (pt in candidates) {
            if (!vp.contains(pt.x, pt.y)) continue
            if (upper.any { it.bounds.contains(pt.x, pt.y) }) continue
            return pt
        }
        return null
    }

    // ── 第 8 步：角色 & 状态推断 ─────────────────────────────────

    private fun inferAll(root: PNode, vp: Rect, fidFreq: Map<String, Int>) {
        fun walk(p: PNode) {
            inferNode(p, vp, fidFreq)
            p.children.forEach { walk(it) }
        }
        walk(root)
    }

    private fun inferNode(p: PNode, vp: Rect, fidFreq: Map<String, Int>) {
        val (acts, dir) = inferActs(p)
        p.acts = acts
        p.scrollDir = dir
        p.states = inferStates(p)
        p.role = inferRole(p, vp, fidFreq)
        p.float = inferFloat(p, vp)
        p.anchor = anchorOf(p, fidFreq)
    }

    /** 9B. acts 与 state 分离；滚动方向保留（"只剩一个方向"是列表到头的关键信号） */
    private fun inferActs(p: PNode): Pair<Set<String>, String?> {
        val set = mutableSetOf<String>()
        var fwd = false; var bck = false; var lft = false; var rgt = false
        fun handle(a: String) {
            when (a) {
                "ACTION_CLICK" -> set.add("click")
                "ACTION_LONG_CLICK" -> set.add("longPress")
                "ACTION_FOCUS" -> set.add("focus")
                "ACTION_SET_TEXT" -> set.add("edit")
                "ACTION_SCROLL_FORWARD" -> fwd = true
                "ACTION_SCROLL_BACKWARD" -> bck = true
                "ACTION_SCROLL_LEFT" -> lft = true
                "ACTION_SCROLL_RIGHT" -> rgt = true
            }
        }
        p.node.actionNames.forEach { handle(it) }
        p.extraActs.forEach { handle(it) }
        val v = when { fwd && bck -> "↕"; fwd -> "↓"; bck -> "↑"; else -> "" }
        val h = when { lft && rgt -> "↔"; lft -> "←"; rgt -> "→"; else -> "" }
        val dir = (v + h).ifEmpty { null }
        if (dir != null) set.add("scroll$dir")
        return set to dir
    }

    private fun inferStates(p: PNode): List<String> {
        val l = mutableListOf<String>()
        if (p.node.checked) l.add("checked")
        if (p.node.selected) l.add("selected")
        if (!p.node.enabled) l.add("disabled")
        if (p.node.checkable) l.add("checkable")
        return l
    }

    /** 9A. role 推断（规则链，命中即停；都不命中省略） */
    private fun inferRole(p: PNode, vp: Rect, fidFreq: Map<String, Int>): String? {
        val fid = (p.effectiveFid ?: p.node.fullId)?.lowercase(Locale.ROOT) ?: ""
        if (fid.isNotEmpty()) {
            if (Regex("search|edit|input|query").containsMatchIn(fid)) return "input"
            if (Regex("btn|submit|buy|cart|pay|add").containsMatchIn(fid)) return "button"
            if (Regex("tab|toolbar|nav|bar").containsMatchIn(fid)) return "tab"
            if (Regex("list|recycler|grid").containsMatchIn(fid)) return "list"
            if (Regex("dialog|modal|popup").containsMatchIn(fid)) return "overlay"
        }
        if (p.node.scrollable) return "scroll"
        if (p.node.editable || p.acts.contains("edit")) return "input"
        if (p.node.checkable) return "checkbox"
        val d = p.desc ?: ""
        if (Regex("¥|￥|\\d+\\.\\d{2}元|\\d+人付款").containsMatchIn(d)) return "item"
        if (Regex("返回|关闭|取消|确定").containsMatchIn(d)) return "button"
        if (p.node.clickable) {
            val area = p.area()
            val vpArea = vp.width() * vp.height()
            if (d.length <= 8 && area < vpArea * 0.05) return "button"
            if (area > vpArea * 0.15) return "card"
        }
        if (p.parent?.node?.scrollable == true) return "item"
        return null
    }

    /** 悬浮元素：fid 关键词或 屏幕右下角小控件 */
    private fun inferFloat(p: PNode, vp: Rect): Boolean {
        val fid = (p.effectiveFid ?: p.node.fullId)?.lowercase(Locale.ROOT) ?: ""
        if (Regex("float|fab|suspension|backtop|back_top").containsMatchIn(fid)) return true
        if (p.interactive && p.area() < vp.width() * vp.height() * 0.015) {
            if (p.center.x > vp.right - 200 && p.center.y > vp.bottom - 350) return true
        }
        return false
    }

    // ── 配套机制：anchor 稳定锚点 ────────────────────────────────

    private fun ancestorPath(n: PNode): String {
        val parts = mutableListOf<String>()
        var cur: PNode? = n.parent
        while (cur != null && parts.size < 4) {
            parts.add("${cur.node.className?.substringAfterLast('.') ?: "-"}:${cur.node.indexInParent}")
            cur = cur.parent
        }
        return parts.joinToString("/")
    }

    /** anchor = hash(fid | 归一化desc | role | 祖先路径) */
    private fun anchorOf(p: PNode, fidFreq: Map<String, Int>): String {
        val fid = p.node.fullId?.takeIf { fidFreq[it] == 1 } ?: ""
        val desc = p.desc ?: ""
        val role = p.role ?: ""
        val path = p.pathForAnchor.ifEmpty { ancestorPath(p) }
        return sha1("$fid|$desc|$role|$path").take(8)
    }

    // ── 第 9 步：列表识别 & 一行化 ────────────────────────────────

    private fun detectLists(root: PNode) {
        fun walk(p: PNode) {
            if (p.node.scrollable || p.acts.any { it.startsWith("scroll") }) {
                val kids = p.children
                if (kids.size >= LIST_MIN_ITEMS) {
                    val sig0 = signatureOf(kids[0])
                    if (kids.all { signatureOf(it) == sig0 }) {
                        p.listContainer = true
                        for (k in kids) {
                            k.isItem = true
                            if (k.role == null) k.role = "item"
                        }
                    }
                }
            }
            p.children.forEach { walk(it) }
        }
        walk(root)
    }

    /** 结构签名：role + 子节点 role 序列 + 文本模式 */
    private fun signatureOf(p: PNode): String {
        val childRoles = p.children.joinToString(",") { it.role ?: "-" }
        val tp = when {
            p.desc?.contains('¥') == true || p.desc?.contains('￥') == true -> "m"
            p.desc?.any { it.isDigit() } == true -> "n"
            !p.desc.isNullOrEmpty() -> "t"
            else -> "x"
        }
        return "${p.role}|$childRoles|$tp"
    }

    private fun itemDescOf(item: PNode): String {
        val parts = mutableListOf<String>()
        fun walk(n: PNode) {
            n.desc?.let { if (it.isNotBlank() && !parts.contains(it)) parts.add(it) }
            n.children.forEach { walk(it) }
        }
        walk(item)
        return parts.joinToString(" | ")
    }

    private fun subActionsOf(item: PNode): List<PNode> {
        val cands = mutableListOf<PNode>()
        fun walk(n: PNode) {
            if (n !== item && n.acts.contains("click") && n.desc != null) cands.add(n)
            n.children.forEach { walk(it) }
        }
        walk(item)
        val rank = mapOf("进店" to 4, "店铺" to 4, "更多" to 3, "收藏" to 2, "加购" to 2, "关注" to 2, "详情" to 1, "查看" to 1)
        return cands
            .sortedByDescending { d -> rank.entries.firstOrNull { (k, _) -> d.desc!!.contains(k) }?.value ?: 0 }
            .take(2)
    }

    // ── 第 10/11 步：预算截断 + 序列化 ─────────────────────────────

    private class Line(
        val p: PNode?,
        val kind: Int,   // 0=固定 1=chrome白名单 2=chrome普通 3=offscreen 4=item 5=sub 6=fold
        val prio: Int,
        val dist: Double,
    ) {
        var descLen: Int = DESC_MAX_LEN
        var text: String = ""
        var cut: Boolean = false
    }

    private fun serialize(
        root: PNode,
        offscreen: List<PNode>,
        vp: Rect,
        w: Int,
        h: Int,
        sel: SelectResult,
        warnings: List<String>,
        fidFreq: Map<String, Int>,
    ): Result {
        val lines = mutableListOf<Line>()

        // chrome 行（树序 DFS）
        fun collectChrome(p: PNode) {
            if (p !== root && !p.listContainer && !p.isItem) {
                val prio = when {
                    isWhitelist(p, vp) -> 0
                    p.desc == null && !p.interactive -> 5
                    p.desc == null -> 4
                    !p.interactive -> 4
                    else -> 3
                }
                lines.add(Line(p, if (prio == 0) 1 else 2, prio, distToViewportCenter(p, vp)))
            }
            p.children.forEach { collectChrome(it) }
        }
        collectChrome(root)

        // offscreen 行（上限 15，desc 信息量优先）
        val off = offscreen.filter { !it.removed }
            .sortedByDescending { it.desc?.length ?: 0 }
            .take(MAX_OFFSCREEN)
        off.forEach { lines.add(Line(it, 3, 0, 0.0)) }

        // list 区结构行（head/item/sub/fold）
        val listContainers = mutableListOf<PNode>()
        fun collectLists(p: PNode) {
            if (p.listContainer) {
                listContainers.add(p)
                val kids = p.children
                val visible = kids.filter { !it.outOfViewport }.take(20)
                lines.add(Line(p, 0, 0, 0.0)) // head（文本在编号后生成）
                for (it in visible) {
                    lines.add(Line(it, 4, 0, 0.0))
                    subActionsOf(it).forEach { s -> lines.add(Line(s, 5, 0, 0.0)) }
                }
                val folded = kids.size - visible.size
                if (folded > 0) lines.add(Line(p, 6, 0, 0.0)) // fold
            }
            p.children.forEach { collectLists(it) }
        }
        collectLists(root)

        // 预算截断（白名单 → token 预算 → 砍节点）
        val cutCount = budgetFix(lines)

        // 编号（输出顺序：chrome → offscreen → list 容器/items/subs；被砍的不编号；折叠 item 保留 id）
        var next = 1
        lines.filter { it.kind == 1 || it.kind == 2 }.forEach { if (!it.cut) it.p!!.id = next++ }
        lines.filter { it.kind == 3 }.forEach { if (!it.cut) it.p!!.id = next++ }
        for (container in listContainers) {
            container.id = next++
            for (l in lines) {
                if (l.p === container && l.kind == 0) l.text = listHeadText(container)
            }
            val kids = container.children
            val visible = kids.filter { !it.outOfViewport }.take(20)
            for (it in visible) {
                it.id = next++
                it.subActions = subActionsOf(it).take(2)
                for (s in it.subActions) s.id = next++
            }
            // 折叠 item 保留 id（nodeMap 可查，可点击性由执行器重定位保证）
            kids.filter { it.outOfViewport }.forEach { it.id = next++ }
        }

        // 行文本生成
        lines.forEach { l ->
            if (l.cut) return@forEach
            when (l.kind) {
                1, 2 -> l.text = chromeLineText(l.p!!, l.descLen)
                3 -> l.text = offscreenLineText(l.p!!)
                4 -> l.text = itemLineText(l.p!!)
                5 -> l.text = subLineText(l.p!!)
                6 -> {
                    val dir = l.p?.scrollDir ?: ""
                    val foldDir = if (dir.contains("↓")) "↓" else if (dir.contains("↑")) "↑" else dir
                    val folded = l.p!!.children.size -
                        l.p!!.children.filter { !it.outOfViewport }.take(20).size
                    l.text = "+$folded items below (scroll$foldDir)"
                }
            }
        }

        // rev（配套机制 1）：hash(树结构 + fid + desc 前 20 字)
        val rev = computeRev(root, off)

        // 组装
        val sb = StringBuilder()
        sb.append("screen ${w}x${h} viewport=[${vp.left},${vp.top},${vp.right},${vp.bottom}]")
        sel.root.packageName?.let { sb.append(" app=").append(it) }
        sel.page?.let { sb.append(" page=").append(it) }
        sb.append(" rev=").append(rev)
        if (sel.modal) sb.append(" modal")
        if (cutCount > 0) sb.append(" truncated:").append(cutCount)
        sb.append('\n')

        val chrome = lines.filter { it.kind == 1 || it.kind == 2 }
        if (chrome.isNotEmpty()) {
            sb.append("--- chrome ---\n")
            chrome.forEach { if (!it.cut) sb.append(it.text).append('\n') }
        }
        val offLines = lines.filter { it.kind == 3 }
        if (offLines.isNotEmpty()) {
            sb.append("--- offscreen ---\n")
            offLines.forEach { if (!it.cut) sb.append(it.text).append('\n') }
        }
        for (container in listContainers) {
            sb.append(listHeadText(container)).append('\n')
            val kids = container.children
            val visible = kids.filter { !it.outOfViewport }.take(20)
            for (it in visible) {
                sb.append(itemLineText(it)).append('\n')
                it.subActions.forEach { s -> sb.append(subLineText(s)).append('\n') }
            }
            val folded = kids.size - visible.size
            if (folded > 0) {
                val dir = container.scrollDir ?: ""
                val foldDir = if (dir.contains("↓")) "↓" else if (dir.contains("↑")) "↑" else dir
                sb.append("+$folded items below (scroll$foldDir)").append('\n')
            }
        }
        if (warnings.isNotEmpty()) {
            sb.append("--- warnings ---\n")
            warnings.forEach { sb.append("- ").append(it).append('\n') }
        }

        val nodeMap = HashMap<Int, PNode>()
        lines.forEach { l -> l.p?.let { if (it.id >= 0) nodeMap[it.id] = it } }
        // 折叠 item（无行）也入 map
        for (container in listContainers) {
            container.children.filter { it.outOfViewport }.forEach { nodeMap[it.id] = it }
        }

        return Result(
            text = sb.toString().trimEnd(),
            rev = rev,
            nodeMap = nodeMap,
            truncated = cutCount > 0,
            cutCount = cutCount,
            warnings = warnings,
            viewport = vp,
            screenWidth = w,
            screenHeight = h,
            modal = sel.modal,
            pkg = sel.root.packageName,
            page = sel.page,
        )
    }

    private fun listHeadText(container: PNode): String {
        val kids = container.children
        val visibleCount = kids.filter { !it.outOfViewport }.take(20).size
        val dir = container.scrollDir ?: ""
        val b = container.bounds
        return "--- list #${container.id} scroll$dir box=[${b.left},${b.top},${b.right},${b.bottom}] items=$visibleCount/${kids.size} ---"
    }

    /** 预算截断：返回被砍行数 */
    private fun budgetFix(lines: MutableList<Line>): Int {
        var cut = 0
        fun over(): Boolean {
            val alive = lines.filter { !it.cut }
            val count = alive.size
            val tokens = alive.sumOf { tokenEst(lineTextOf(it)) }
            return count > NODE_LIMIT || tokens > TOKEN_LIMIT
        }
        fun cutLine(l: Line) { l.cut = true; cut++ }

        var overNow = over()
        while (overNow) {
            // 5. 距视口中心最远的无文本不可交互节点
            val p5 = lines.filter { it.kind == 2 && it.prio == 5 && !it.cut }.maxByOrNull { it.dist }
            if (p5 != null) { cutLine(p5); overNow = over(); continue }
            // 4. 有文本不可交互 / 无文本可交互
            val p4 = lines.filter { it.kind == 2 && it.prio == 4 && !it.cut }.maxByOrNull { it.dist }
            if (p4 != null) { cutLine(p4); overNow = over(); continue }
            // 3. 有文本可交互
            val p3 = lines.filter { it.kind == 2 && it.prio == 3 && !it.cut }.maxByOrNull { it.dist }
            if (p3 != null) { cutLine(p3); overNow = over(); continue }
            // 2. desc 长度截短（>30 → 30+"…"）
            if (lines.any { it.descLen > DESC_BUDGET_LEN && !it.cut }) {
                lines.filter { it.descLen > DESC_BUDGET_LEN && !it.cut }.forEach { it.descLen = DESC_BUDGET_LEN }
                overNow = over(); continue
            }
            // 1. 砍视口外 item 的折叠数量（隐藏 fold 行）
            val fold = lines.filter { it.kind == 6 && !it.cut }.firstOrNull()
            if (fold != null) { cutLine(fold); overNow = over(); continue }
            // 兜底：砍 offscreen（desc 短的先砍）
            val os = lines.filter { it.kind == 3 && !it.cut }.minByOrNull { it.p?.desc?.length ?: 0 }
            if (os != null) { cutLine(os); overNow = over(); continue }
            break
        }
        return cut
    }

    private fun tokenEst(s: String): Int {
        var asc = 0
        var other = 0
        for (ch in s) if (ch.code < 128) asc++ else other++
        return asc / 2 + other * 3 / 2
    }

    /** 预算阶段的文本估算（id 未分配，用 0 占位） */
    private fun lineTextOf(l: Line): String = when (l.kind) {
        1, 2 -> chromeLineText(l.p!!, l.descLen)
        3 -> offscreenLineText(l.p!!)
        4 -> itemLineText(l.p!!)
        5 -> subLineText(l.p!!)
        6 -> "+N items below"
        else -> "--- list #0 ---"
    }

    private fun distToViewportCenter(p: PNode, vp: Rect): Double {
        val cx = vp.exactCenterX().toDouble()
        val cy = vp.exactCenterY().toDouble()
        val pt = p.clickTarget
        return hypot(pt.x - cx, pt.y - cy)
    }

    /** 白名单（导航骨架，永远不砍） */
    private fun isWhitelist(p: PNode, vp: Rect): Boolean {
        val fid = p.effectiveFid?.lowercase(Locale.ROOT) ?: ""
        val d = p.desc ?: ""
        if (Regex("back|nav_up").containsMatchIn(fid) || d == "返回") return true
        if (p.role == "input" && Regex("search").containsMatchIn(fid)) return true
        if (p.role == "tab" && (Regex("tab|nav|bar").containsMatchIn(fid) || p.center.y > vp.bottom * 0.9)) return true
        if (p.float) return true
        if (Regex("提交|确认|支付|购买|下单").containsMatchIn(d)) return true
        return false
    }

    private fun esc(s: String): String =
        if (s.any { it == ' ' || it == '\t' }) "\"" + s.replace("\"", "\\\"") + "\"" else s

    private fun truncated(s: String, len: Int): String =
        if (s.length > len) s.take(len) + "…" else s

    private fun chromeLineText(p: PNode, descLen: Int): String {
        val sb = StringBuilder()
        sb.append(p.id)
        p.role?.let { sb.append(' ').append(it) }
        p.desc?.let { sb.append(' ').append(esc(truncated(it, descLen))) }
        if (p.acts.isNotEmpty()) sb.append(" @").append(p.clickTarget.x).append(',').append(p.clickTarget.y)
        p.effectiveFid?.let { sb.append(" #").append(it) }
        p.states.forEach { sb.append(" *").append(it) }
        if (p.float) sb.append(" float")
        if (p.clipped) sb.append(" clipped")
        if (p.occluded) sb.append(" occluded")
        return sb.toString()
    }

    private fun offscreenLineText(p: PNode): String {
        val sb = StringBuilder()
        sb.append(p.id)
        p.role?.let { sb.append(' ').append(it) }
        p.desc?.let { sb.append(' ').append(esc(it)) }
        p.effectiveFid?.let { sb.append(" #").append(it) }
        p.states.forEach { sb.append(" *").append(it) }
        sb.append(" reason:").append(p.reason ?: "collapsed")
        return sb.toString()
    }

    private fun itemLineText(p: PNode): String {
        val sb = StringBuilder()
        sb.append(p.id).append(" item ").append(esc(itemDescOf(p)))
        if (p.acts.isNotEmpty()) sb.append(" @").append(p.clickTarget.x).append(',').append(p.clickTarget.y)
        if (p.clipped) sb.append(" clipped")
        return sb.toString()
    }

    private fun subLineText(p: PNode): String {
        val sb = StringBuilder("   ")
        sb.append(p.id)
        p.role?.let { sb.append(' ').append(it) }
        p.desc?.let { sb.append(' ').append(esc(it)) }
        if (p.acts.isNotEmpty()) sb.append(" @").append(p.clickTarget.x).append(',').append(p.clickTarget.y)
        return sb.toString()
    }

    // ── 配套机制：rev 快照版本 ────────────────────────────────────

    private fun computeRev(root: PNode, offscreen: List<PNode>): String {
        val sb = StringBuilder()
        fun walk(p: PNode) {
            sb.append(p.node.depth).append(':').append(p.node.indexInParent).append(':')
                .append(p.node.className).append(':').append(p.node.fullId).append(':')
                .append(p.desc?.take(20)).append(':').append(p.children.size).append('|')
            p.children.forEach { walk(it) }
        }
        walk(root)
        offscreen.sortedBy { it.node.fullId ?: "" }.forEach {
            sb.append("off:").append(it.node.fullId).append(':').append(it.desc?.take(20)).append('|')
        }
        return sha1(sb.toString()).take(6)
    }

    private fun sha1(s: String): String =
        MessageDigest.getInstance("SHA-1").digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
