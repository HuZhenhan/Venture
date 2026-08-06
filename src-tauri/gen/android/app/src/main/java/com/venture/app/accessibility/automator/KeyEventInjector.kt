package com.venture.app.accessibility.automator

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import com.venture.app.accessibility.AccessibilityBridge
import org.json.JSONObject

/**
 * 按键注入（对应规格书 4.6）。
 *
 * 无障碍服务没有公开的系统级按键注入 API，按按键类型分别走可靠路径：
 * - back/home/recent → performGlobalAction（系统级，最可靠）
 * - enter → 聚焦可编辑节点 ACTION_IME_ENTER（输入法回车）
 * - del → 聚焦节点 setSelection(0..len) + cut（删除选中文本）
 * - volumeUp/volumeDown → AudioManager
 * - tab/menu → 尽力而为，不支持返回 false
 */
class KeyEventInjector(
    private val context: Context,
    private val bridge: AccessibilityBridge,
    private val globalActions: GlobalActionExecutor,
    private val actionExecutor: ActionExecutor,
) {

    fun keyEvent(key: String): Boolean = when (key) {
        "back" -> globalActions.back()
        "home" -> globalActions.home()
        "recent", "recents" -> globalActions.recents()
        "menu" -> false // 无可靠系统级路径
        "enter" -> imeEnter()
        "del" -> deleteSelection()
        "tab" -> false
        "volumeUp" -> adjustVolume(AudioManager.ADJUST_RAISE)
        "volumeDown" -> adjustVolume(AudioManager.ADJUST_LOWER)
        else -> false
    }

    /** 回车：对当前聚焦的可编辑节点发 ACTION_IME_ENTER（API 30+），低版本尝试 ACTION_SET_TEXT 追加换行不可行 → false */
    private fun imeEnter(): Boolean {
        val node = NodeFinder.findFocusedEditable(bridge) ?: return false
        return try {
            if (Build.VERSION.SDK_INT >= 30) {
                val supported = node.actionList.any { it.id == AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id }
                if (supported) {
                    actionExecutor.performOnNode(node, "imeEnter")
                } else {
                    // 部分应用不声明 IME_ENTER 但 performAction 仍可用，尝试一次
                    runCatching { node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) }.getOrDefault(false)
                }
            } else {
                false
            }
        } finally {
            runCatching { node.recycle() }
        }
    }

    /** 删除：选中全部文本后剪切（等效 DEL 清空输入框） */
    private fun deleteSelection(): Boolean {
        val node = NodeFinder.findFocusedEditable(bridge) ?: return false
        return try {
            val len = node.text?.length ?: 0
            if (len == 0) return false
            val sel = actionExecutor.performOnNode(
                node, "setSelection",
                JSONObject().put("start", 0).put("end", len)
            )
            if (!sel) return false
            actionExecutor.performOnNode(node, "cut")
        } finally {
            runCatching { node.recycle() }
        }
    }

    private fun adjustVolume(direction: Int): Boolean = runCatching {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
        true
    }.getOrDefault(false)
}
