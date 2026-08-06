package com.venture.app.accessibility

import android.content.Context
import android.content.res.Resources
import android.graphics.Point
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * 节点序列化模型（对应规格书 3.4）。
 *
 * 捕获时为纯数据快照（立即脱离 AccessibilityNodeInfo 生命周期），
 * 生成 JSON 后原节点即可 recycle，避免 use-after-recycle。
 */
class NodeInfo(
    val boundsInParent: Rect,
    val boundsInScreen: Rect,
    val packageName: String?,
    val simpleId: String?,
    val fullId: String?,
    val idHex: String?,
    val desc: String?,
    val text: String?,
    val className: String?,
    val center: Point,
    val clickable: Boolean,
    val longClickable: Boolean,
    val scrollable: Boolean,
    val checkable: Boolean,
    val checked: Boolean,
    val enabled: Boolean,
    val editable: Boolean,
    val focusable: Boolean,
    val selected: Boolean,
    val visibleToUser: Boolean,
    val depth: Int,
    val indexInParent: Int,
    val childCount: Int,
    val row: Int,
    val column: Int,
    val rowSpan: Int,
    val columnSpan: Int,
    /** 关键：setText/paste 能力检测依据（规格书 4.1 前置检查） */
    val actionNames: List<String>,
    val children: List<NodeInfo>,
) {

    /** 是否满足 brief 模式保留条件（规格书 3.5 步骤 1） */
    fun isBriefWorthy(maxDepth: Int): Boolean =
        !text.isNullOrEmpty() || !desc.isNullOrEmpty() ||
            clickable || scrollable || checkable ||
            !fullId.isNullOrEmpty() || depth <= maxDepth

    /** brief 截断优先级：有 text/desc > 可交互 > id > 深度小（规格书 3.5 步骤 3） */
    fun briefPriority(): Int = when {
        !text.isNullOrEmpty() || !desc.isNullOrEmpty() -> 0
        clickable || scrollable || checkable -> 1
        !fullId.isNullOrEmpty() -> 2
        else -> 3 + depth.coerceAtMost(100)
    }

    fun toJson(id: Int = -1): JSONObject {
        val o = JSONObject()
        o.put("id", id)
        o.put("text", text ?: "")
        o.put("desc", desc ?: "")
        o.put("class", className ?: "")
        o.put("pkg", packageName ?: "")
        fullId?.let { o.put("fullId", it) }
        o.put("bounds", JSONArray(listOf(boundsInScreen.left, boundsInScreen.top, boundsInScreen.right, boundsInScreen.bottom)))
        o.put("center", JSONArray(listOf(center.x, center.y)))
        o.put("clickable", clickable)
        o.put("longClickable", longClickable)
        o.put("scrollable", scrollable)
        o.put("checkable", checkable)
        o.put("checked", checked)
        o.put("enabled", enabled)
        o.put("editable", editable)
        o.put("selected", selected)
        o.put("visible", visibleToUser)
        o.put("depth", depth)
        o.put("indexInParent", indexInParent)
        o.put("childCount", childCount)
        o.put("actions", JSONArray(actionNames))
        val arr = JSONArray()
        children.forEach { arr.put(it.toJson()) }
        o.put("children", arr)
        return o
    }

    companion object {
        /** resources 按包名缓存（规格书 3.4 idHex） */
        private val resourcesCache = HashMap<String, Resources?>()

        private fun resourcesFor(context: Context, pkg: String?): Resources? {
            if (pkg == null) return null
            if (resourcesCache.containsKey(pkg)) return resourcesCache[pkg]
            val res = runCatching {
                context.packageManager.getResourcesForApplication(pkg)
            }.getOrNull()
            resourcesCache[pkg] = res
            return res
        }

        private fun actionName(action: AccessibilityNodeInfo.AccessibilityAction): String = when (action.id) {
            AccessibilityNodeInfo.ACTION_CLICK -> "ACTION_CLICK"
            AccessibilityNodeInfo.ACTION_LONG_CLICK -> "ACTION_LONG_CLICK"
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> "ACTION_SCROLL_FORWARD"
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> "ACTION_SCROLL_BACKWARD"
            AccessibilityNodeInfo.ACTION_SET_TEXT -> "ACTION_SET_TEXT"
            AccessibilityNodeInfo.ACTION_PASTE -> "ACTION_PASTE"
            AccessibilityNodeInfo.ACTION_COPY -> "ACTION_COPY"
            AccessibilityNodeInfo.ACTION_CUT -> "ACTION_CUT"
            AccessibilityNodeInfo.ACTION_FOCUS -> "ACTION_FOCUS"
            AccessibilityNodeInfo.ACTION_CLEAR_FOCUS -> "ACTION_CLEAR_FOCUS"
            AccessibilityNodeInfo.ACTION_SELECT -> "ACTION_SELECT"
            AccessibilityNodeInfo.ACTION_CLEAR_SELECTION -> "ACTION_CLEAR_SELECTION"
            AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS -> "ACTION_ACCESSIBILITY_FOCUS"
            AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS -> "ACTION_CLEAR_ACCESSIBILITY_FOCUS"
            AccessibilityNodeInfo.ACTION_EXPAND -> "ACTION_EXPAND"
            AccessibilityNodeInfo.ACTION_COLLAPSE -> "ACTION_COLLAPSE"
            AccessibilityNodeInfo.ACTION_DISMISS -> "ACTION_DISMISS"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id -> "ACTION_SHOW_ON_SCREEN"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS.id -> "ACTION_SET_PROGRESS"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_TO_POSITION.id -> "ACTION_SCROLL_TO_POSITION"
            AccessibilityNodeInfo.ACTION_SET_SELECTION -> "ACTION_SET_SELECTION"
            AccessibilityNodeInfo.ACTION_NEXT_AT_MOVEMENT_GRANULARITY -> "ACTION_NEXT_AT_MOVEMENT_GRANULARITY"
            AccessibilityNodeInfo.ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY -> "ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY"
            AccessibilityNodeInfo.ACTION_NEXT_HTML_ELEMENT -> "ACTION_NEXT_HTML_ELEMENT"
            AccessibilityNodeInfo.ACTION_PREVIOUS_HTML_ELEMENT -> "ACTION_PREVIOUS_HTML_ELEMENT"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id -> "ACTION_SCROLL_UP"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id -> "ACTION_SCROLL_DOWN"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id -> "ACTION_SCROLL_LEFT"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id -> "ACTION_SCROLL_RIGHT"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_CONTEXT_CLICK.id -> "ACTION_CONTEXT_CLICK"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_PRESS_AND_HOLD.id -> "ACTION_PRESS_AND_HOLD"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id -> "ACTION_IME_ENTER"
            AccessibilityNodeInfo.AccessibilityAction.ACTION_MOVE_WINDOW.id -> "ACTION_MOVE_WINDOW"
            else -> "ACTION_${action.id}"
        }

        /** DFS 递归捕获为纯数据快照（规格书 3.4） */
        fun capture(context: Context, node: AccessibilityNodeInfo, depth: Int = 0): NodeInfo {
            val boundsScreen = Rect()
            node.getBoundsInScreen(boundsScreen)
            val boundsParent = Rect()
            node.getBoundsInParent(boundsParent)

            val fullId = node.viewIdResourceName
            val simpleId = fullId?.substringAfterLast("/id/")?.substringAfterLast('/')
            val idHex = runCatching {
                resourcesFor(context, node.packageName?.toString())
                    ?.getIdentifier(fullId, null, null)
                    ?.takeIf { it != 0 }
                    ?.let { "0x" + Integer.toHexString(it) }
            }.getOrNull()

            var row = -1; var column = -1; var rowSpan = -1; var columnSpan = -1
            node.collectionItemInfo?.let {
                row = it.rowIndex; column = it.columnIndex
                rowSpan = it.rowSpan; columnSpan = it.columnSpan
            }

            val children = mutableListOf<NodeInfo>()
            for (i in 0 until node.childCount) {
                val child = runCatching { node.getChild(i) }.getOrNull() ?: continue
                children.add(capture(context, child, depth + 1))
                child.recycle()
            }

            return NodeInfo(
                boundsInParent = boundsParent,
                boundsInScreen = boundsScreen,
                packageName = node.packageName?.toString(),
                simpleId = simpleId,
                fullId = fullId,
                idHex = idHex,
                desc = node.contentDescription?.toString(),
                text = node.text?.toString(),
                className = node.className?.toString(),
                center = Point(
                    (boundsScreen.left + boundsScreen.right) / 2,
                    (boundsScreen.top + boundsScreen.bottom) / 2
                ),
                clickable = node.isClickable,
                longClickable = node.isLongClickable,
                scrollable = node.isScrollable,
                checkable = node.isCheckable,
                checked = node.isChecked,
                enabled = node.isEnabled,
                editable = node.isEditable,
                focusable = node.isFocusable,
                selected = node.isSelected,
                visibleToUser = node.isVisibleToUser,
                depth = depth,
                indexInParent = -1, // 由调用方需要时补（capture 树内不依赖）
                childCount = node.childCount,
                row = row, column = column, rowSpan = rowSpan, columnSpan = columnSpan,
                actionNames = node.actionList.map { actionName(it) },
                children = children,
            )
        }
    }
}
