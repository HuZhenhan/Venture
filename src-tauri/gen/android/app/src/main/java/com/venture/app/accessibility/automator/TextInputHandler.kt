package com.venture.app.accessibility.automator

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.accessibility.AccessibilityNodeInfo
import com.venture.app.accessibility.AccessibilityBridge
import org.json.JSONObject

/**
 * 文本输入体系（对应规格书 4.4 核心决策树）。
 *
 * 决策顺序：
 * 1. target 为空 → 取当前聚焦的可编辑节点
 * 2. click 聚焦 + wait(300ms)
 * 3. actionNames 含 ACTION_SET_TEXT → setText
 * 4. 否则含 ACTION_PASTE → set_clipboard + paste（微信/QQ 场景首选，
 *    paste 走用户真实"长按→粘贴"管线，应用无法区分）
 * 5. 否则 → 自绘控件：剪贴板 + 长按菜单粘贴（long_click → find_node("粘贴") → click）
 * 6. 最终兜底：返回 failed，由 AI 提示用户手动输入
 */
class TextInputHandler(
    private val context: Context,
    private val bridge: AccessibilityBridge,
    private val actionExecutor: ActionExecutor,
    private val gestureExecutor: GestureExecutor,
) {

    enum class Method(val wireName: String) {
        SET_TEXT("setText"),
        PASTE("paste"),
        MENU_PASTE("menu_paste"),
        FAILED("failed"),
    }

    fun setClipboard(text: String) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("venture", text))
    }

    fun readClipboard(): String {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = cm.primaryClip ?: return ""
        if (clip.itemCount == 0) return ""
        return clip.getItemAt(0).coerceToText(context)?.toString() ?: ""
    }

    /**
     * 输入文本。
     * @param selector 目标节点选择器；null 表示用当前聚焦输入框
     * @return 使用的输入方式（FAILED 表示所有路径均失败）
     */
    fun inputText(text: String, selector: JSONObject? = null): Method {
        val node: AccessibilityNodeInfo = if (selector != null) {
            NodeFinder.find(bridge, selector, 1).firstOrNull()?.node ?: return Method.FAILED
        } else {
            NodeFinder.findFocusedEditable(bridge) ?: return Method.FAILED
        }

        try {
            // 2. click 聚焦 + wait（paste 必须，setText 建议）
            if (node.isClickable) {
                runCatching { node.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
            }
            if (!node.isFocused) {
                runCatching { node.performAction(AccessibilityNodeInfo.ACTION_FOCUS) }
            }
            Thread.sleep(300)

            val actionIds = node.actionList.map { it.id }

            // 3. setText 路径
            if (actionIds.contains(AccessibilityNodeInfo.ACTION_SET_TEXT)) {
                val ok = actionExecutor.performOnNode(
                    node, "setText", JSONObject().put("text", text)
                )
                if (ok) return Method.SET_TEXT
                // setText 失败（微信/QQ 来源检测）→ 继续尝试 paste
            }

            // 4. paste 路径
            if (actionIds.contains(AccessibilityNodeInfo.ACTION_PASTE)) {
                setClipboard(text)
                val ok = actionExecutor.performOnNode(node, "paste")
                if (ok) return Method.PASTE
            }

            // 5. 自绘控件兜底：剪贴板 + 长按菜单粘贴
            setClipboard(text)
            if (menuPaste(node)) return Method.MENU_PASTE

            return Method.FAILED
        } finally {
            runCatching { node.recycle() }
        }
    }

    /** 向指定节点粘贴剪贴板内容（paste tool） */
    fun paste(selector: JSONObject?, text: String?): Method {
        text?.let { setClipboard(it) }
        val node: AccessibilityNodeInfo = if (selector != null) {
            NodeFinder.find(bridge, selector, 1).firstOrNull()?.node ?: return Method.FAILED
        } else {
            NodeFinder.findFocusedEditable(bridge) ?: return Method.FAILED
        }
        try {
            if (node.isClickable) {
                runCatching { node.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
            }
            Thread.sleep(300)
            val actionIds = node.actionList.map { it.id }
            if (actionIds.contains(AccessibilityNodeInfo.ACTION_PASTE)) {
                if (actionExecutor.performOnNode(node, "paste")) return Method.PASTE
            }
            if (menuPaste(node)) return Method.MENU_PASTE
            return Method.FAILED
        } finally {
            runCatching { node.recycle() }
        }
    }

    /** 长按输入框 → 布局树找"粘贴"菜单 → 点击（规格书 4.4.1 方案 B） */
    private fun menuPaste(node: AccessibilityNodeInfo): Boolean {
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        val cx = bounds.centerX()
        val cy = bounds.centerY()
        if (cx < 0 || cy < 0) return false
        if (!gestureExecutor.longClick(cx, cy)) return false
        Thread.sleep(600)
        val pasteMenu = NodeFinder.find(
            bridge,
            JSONObject().put("text", "粘贴"),
            3
        ).firstOrNull { it.text == "粘贴" || it.desc == "粘贴" }
            ?: NodeFinder.find(bridge, JSONObject().put("text", "Paste"), 1).firstOrNull()
            ?: return false
        return try {
            runCatching {
                pasteMenu.node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }.getOrDefault(false)
        } finally {
            runCatching { pasteMenu.node.recycle() }
        }
    }
}
