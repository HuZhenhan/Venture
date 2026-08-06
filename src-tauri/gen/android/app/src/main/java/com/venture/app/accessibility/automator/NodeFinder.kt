package com.venture.app.accessibility.automator

import android.view.accessibility.AccessibilityNodeInfo
import com.venture.app.accessibility.AccessibilityBridge
import org.json.JSONObject

/**
 * 节点查找器：在**实时**节点树上按选择器查找（规格书第 6 章 find_node / 第 7 章 selector 语义）。
 *
 * 选择器字段（全部可选，组合 AND）：
 *   text / desc / id(simpleId 或 fullId 后缀匹配) / className /
 *   clickable / scrollable / index（匹配结果中的第几个）
 *
 * 注意：返回的是**实时节点**，调用方用完后必须 recycle。
 */
object NodeFinder {

    class Match(
        val node: AccessibilityNodeInfo,
        val text: String?,
        val desc: String?,
        val bounds: android.graphics.Rect,
    )

    fun matches(node: AccessibilityNodeInfo, selector: JSONObject): Boolean {
        val text = selector.optString("text", "")
        if (text.isNotEmpty() && node.text?.toString()?.contains(text) != true) return false

        val desc = selector.optString("desc", "")
        if (desc.isNotEmpty() && node.contentDescription?.toString()?.contains(desc) != true) return false

        val id = selector.optString("id", "")
        if (id.isNotEmpty()) {
            val fullId = node.viewIdResourceName ?: return false
            // 允许传 simpleId（"search_edit"）或 fullId 后缀（":id/search_edit"）
            if (!fullId.endsWith(id) && fullId.substringAfterLast("/id/").substringAfterLast('/') != id) return false
        }

        val className = selector.optString("className", "")
        if (className.isNotEmpty() && node.className?.toString()?.contains(className) != true) return false

        if (selector.has("clickable") && node.isClickable != selector.optBoolean("clickable")) return false
        if (selector.has("scrollable") && node.isScrollable != selector.optBoolean("scrollable")) return false
        if (selector.has("checkable") && node.isCheckable != selector.optBoolean("checkable")) return false
        if (selector.has("editable") && node.isEditable != selector.optBoolean("editable")) return false

        return true
    }

    /**
     * DFS 查找所有匹配节点（可见性优先）。
     * limit 语义复用 AutoJs6 "验证即搜索" 思想：findOne 传 limit=2 可验证唯一性。
     */
    fun findAll(root: AccessibilityNodeInfo, selector: JSONObject, limit: Int = 10): List<Match> {
        val results = mutableListOf<Match>()
        fun dfs(node: AccessibilityNodeInfo) {
            if (results.size >= limit) return
            if (matches(node, selector)) {
                val bounds = android.graphics.Rect()
                node.getBoundsInScreen(bounds)
                results.add(
                    Match(
                        node = AccessibilityNodeInfo.obtain(node),
                        text = node.text?.toString(),
                        desc = node.contentDescription?.toString(),
                        bounds = bounds,
                    )
                )
            }
            for (i in 0 until node.childCount) {
                if (results.size >= limit) return
                val child = runCatching { node.getChild(i) }.getOrNull() ?: continue
                dfs(child)
                child.recycle()
            }
        }
        dfs(root)
        return results
    }

    /** 按选择器查找（自动取根），返回匹配列表。index 在 selector 中指定时只取该个。 */
    fun find(bridge: AccessibilityBridge, selector: JSONObject, limit: Int = 10): List<Match> {
        val root = bridge.getRootInActiveWindow() ?: return emptyList()
        return try {
            val all = findAll(root, selector, limit)
            val index = selector.optInt("index", -1)
            if (index >= 0) {
                val picked = all.getOrNull(index)
                all.filter { it.node != picked?.node }.forEach { runCatching { it.node.recycle() } }
                listOfNotNull(picked)
            } else {
                all
            }
        } finally {
            runCatching { root.recycle() }
        }
    }

    /** 找当前聚焦的可编辑节点（input_text 无目标时用） */
    fun findFocusedEditable(bridge: AccessibilityBridge): AccessibilityNodeInfo? {
        val root = bridge.getRootInActiveWindow() ?: return null
        return try {
            val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            if (focused != null && focused.isEditable) focused else {
                focused?.recycle()
                // 退而求其次：第一个可编辑节点
                val editables = findAll(root, JSONObject().put("editable", true), 1)
                editables.firstOrNull()?.node
            }
        } finally {
            runCatching { root.recycle() }
        }
    }
}
