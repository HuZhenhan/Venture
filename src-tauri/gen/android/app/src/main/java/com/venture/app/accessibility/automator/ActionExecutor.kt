package com.venture.app.accessibility.automator

import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import com.venture.app.accessibility.AccessibilityBridge
import org.json.JSONObject

/**
 * 节点操作执行器（对应规格书 4.1 performAction 分发）。
 *
 * 执行前置检查：节点 actionList 不含该 action → 直接失败（进上层 retry/skip 逻辑），
 * 避免无效 Binder 调用。
 */
class ActionExecutor(private val bridge: AccessibilityBridge) {

    /** action 名称 → (actionId, bundle 参数填充器) */
    private fun resolveAction(action: String, args: JSONObject): Pair<Int, Bundle>? {
        val bundle = Bundle()
        val id: Int = when (action) {
            "click" -> AccessibilityNodeInfo.ACTION_CLICK
            "longClick" -> AccessibilityNodeInfo.ACTION_LONG_CLICK
            "pressAndHold" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_PRESS_AND_HOLD.id
            "contextClick" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_CONTEXT_CLICK.id
            "dragStart" -> if (Build.VERSION.SDK_INT >= 32) AccessibilityNodeInfo.AccessibilityAction.ACTION_DRAG_START.id else return null
            "dragDrop" -> if (Build.VERSION.SDK_INT >= 32) AccessibilityNodeInfo.AccessibilityAction.ACTION_DRAG_DROP.id else return null
            "dragCancel" -> if (Build.VERSION.SDK_INT >= 32) AccessibilityNodeInfo.AccessibilityAction.ACTION_DRAG_CANCEL.id else return null
            "scrollForward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "scrollBackward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "scrollUp" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
            "scrollDown" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
            "scrollLeft" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
            "scrollRight" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
            "pageUp" -> if (Build.VERSION.SDK_INT >= 29) AccessibilityNodeInfo.AccessibilityAction.ACTION_PAGE_UP.id else AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
            "pageDown" -> if (Build.VERSION.SDK_INT >= 29) AccessibilityNodeInfo.AccessibilityAction.ACTION_PAGE_DOWN.id else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "pageLeft" -> if (Build.VERSION.SDK_INT >= 29) AccessibilityNodeInfo.AccessibilityAction.ACTION_PAGE_LEFT.id else AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
            "pageRight" -> if (Build.VERSION.SDK_INT >= 29) AccessibilityNodeInfo.AccessibilityAction.ACTION_PAGE_RIGHT.id else AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
            "scrollTo" -> {
                bundle.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_ROW_INT, args.optInt("row", 0))
                bundle.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_COLUMN_INT, args.optInt("column", 0))
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_TO_POSITION.id
            }
            "setText" -> {
                bundle.putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    args.optString("text", "")
                )
                AccessibilityNodeInfo.ACTION_SET_TEXT
            }
            "setSelection" -> {
                bundle.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, args.optInt("start", 0))
                bundle.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, args.optInt("end", 0))
                AccessibilityNodeInfo.ACTION_SET_SELECTION
            }
            "copy" -> AccessibilityNodeInfo.ACTION_COPY
            "cut" -> AccessibilityNodeInfo.ACTION_CUT
            "paste" -> AccessibilityNodeInfo.ACTION_PASTE
            "focus" -> AccessibilityNodeInfo.ACTION_FOCUS
            "clearFocus" -> AccessibilityNodeInfo.ACTION_CLEAR_FOCUS
            "select" -> AccessibilityNodeInfo.ACTION_SELECT
            "clearSelection" -> AccessibilityNodeInfo.ACTION_CLEAR_SELECTION
            "accessibilityFocus" -> AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
            "clearAccessibilityFocus" -> AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS
            "expand" -> AccessibilityNodeInfo.ACTION_EXPAND
            "collapse" -> AccessibilityNodeInfo.ACTION_COLLAPSE
            "dismiss" -> AccessibilityNodeInfo.ACTION_DISMISS
            "show" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id
            "setProgress" -> {
                bundle.putFloat(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_PROGRESS_VALUE,
                    args.optDouble("progress", 0.0).toFloat()
                )
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS.id
            }
            "moveWindow" -> {
                bundle.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_MOVE_WINDOW_X, args.optInt("x", 0))
                bundle.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_MOVE_WINDOW_Y, args.optInt("y", 0))
                AccessibilityNodeInfo.AccessibilityAction.ACTION_MOVE_WINDOW.id
            }
            "imeEnter" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id
            "showTooltip" -> if (Build.VERSION.SDK_INT >= 28) AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_TOOLTIP.id else return null
            "hideTooltip" -> if (Build.VERSION.SDK_INT >= 28) AccessibilityNodeInfo.AccessibilityAction.ACTION_HIDE_TOOLTIP.id else return null
            else -> return null
        }
        return id to bundle
    }

    /**
     * 对选择器命中的第一个节点执行动作。
     * @return true 成功；false 失败（节点未找到 / action 不支持 / performAction 失败）
     */
    fun perform(selector: JSONObject, action: String, args: JSONObject = JSONObject()): Boolean {
        val (actionId, bundle) = resolveAction(action, args) ?: return false
        val matches = NodeFinder.find(bridge, selector, 1)
        val node = matches.firstOrNull()?.node ?: return false
        return try {
            // 前置检查：节点不支持该 action 则直接失败（规格书 4.1）
            val supported = node.actionList.any { it.id == actionId }
            if (!supported) return false
            runCatching { node.performAction(actionId, bundle) }.getOrDefault(false)
        } catch (e: IllegalStateException) {
            false
        } finally {
            runCatching { node.recycle() }
        }
    }

    /** 直接对给定实时节点执行（TextInputHandler 内部复用） */
    fun performOnNode(node: AccessibilityNodeInfo, action: String, args: JSONObject = JSONObject()): Boolean {
        val (actionId, bundle) = resolveAction(action, args) ?: return false
        return try {
            val supported = node.actionList.any { it.id == actionId }
            if (!supported) return false
            runCatching { node.performAction(actionId, bundle) }.getOrDefault(false)
        } catch (e: IllegalStateException) {
            false
        }
    }
}
