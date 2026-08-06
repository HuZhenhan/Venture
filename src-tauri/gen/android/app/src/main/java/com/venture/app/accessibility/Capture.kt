package com.venture.app.accessibility

import android.content.Context
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次捕获的结果（对应规格书 3.6）：全部窗口 + 活动窗口根节点树。
 */
class Capture(
    val windows: List<WindowInfo>,
    val root: NodeInfo,
) {
    fun windowsToJson(): JSONArray {
        val arr = JSONArray()
        windows.forEach { arr.put(it.toJson()) }
        return arr
    }
}

class WindowInfo(
    val root: NodeInfo?,
    val title: CharSequence?,
    /** layer + 1（规格书 3.6） */
    val order: Int,
    val type: Int,
) {
    fun typeName(): String = when (type) {
        AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
        AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "input_method"
        AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "accessibility_overlay"
        AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "split_screen_divider"
        else -> "unknown($type)"
    }

    fun toJson(): JSONObject {
        val o = JSONObject()
        o.put("type", typeName())
        o.put("title", title?.toString() ?: "")
        o.put("order", order)
        return o
    }

    companion object {
        fun create(context: Context, window: AccessibilityWindowInfo): WindowInfo {
            val rootNode = runCatching { window.root }.getOrNull()
            val rootInfo = rootNode?.let {
                val info = NodeInfo.capture(context, it)
                it.recycle()
                info
            }
            return WindowInfo(
                root = rootInfo,
                title = window.title,
                order = window.layer + 1,
                type = window.type,
            )
        }
    }
}
