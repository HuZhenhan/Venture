package com.venture.app.accessibility

import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

/**
 * 无障碍桥（对应规格书 3.2）。
 *
 * - NORMAL 模式：实时调用 getRootInActiveWindow
 * - FAST 模式：读 fastRootInActiveWindow 缓存（滚动等高频场景避免 Binder 开销）
 * - windowFilter：多窗口场景过滤（如排除输入法/系统浮层）
 */
class AccessibilityBridge {

    enum class Mode { NORMAL, FAST }

    @Volatile
    var mode: Mode = Mode.NORMAL

    var windowFilter: ((AccessibilityWindowInfo) -> Boolean)? = null

    fun getService(): VentureAccessibilityService? = VentureAccessibilityService.instance

    fun getRootInActiveWindow(): AccessibilityNodeInfo? {
        val service = getService() ?: return null
        return when (mode) {
            Mode.FAST -> service.fastRootInActiveWindow ?: service.getRootInActiveWindow()
            Mode.NORMAL -> service.getRootInActiveWindow()
        }
    }

    /** 全窗口根节点（过滤后），多窗口操作用 */
    fun windowRoots(): List<AccessibilityNodeInfo> {
        val service = getService() ?: return emptyList()
        val windows = runCatching { service.windows }.getOrNull() ?: return emptyList()
        val filter = windowFilter
        return windows
            .filter { filter?.invoke(it) ?: true }
            .mapNotNull { runCatching { it.root }.getOrNull() }
    }
}
