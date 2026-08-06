package com.venture.app.accessibility.automator

import android.accessibilityservice.AccessibilityService
import android.os.Build

/**
 * 系统全局动作（对应规格书 4.3）。
 * API 28+ 动作（lockScreen/takeScreenshot 等）低版本 try-catch 尝试执行。
 */
class GlobalActionExecutor(private val serviceProvider: () -> AccessibilityService?) {

    private fun service(): AccessibilityService? = serviceProvider()

    private fun global(action: Int): Boolean =
        runCatching { service()?.performGlobalAction(action) == true }.getOrDefault(false)

    fun back() = global(AccessibilityService.GLOBAL_ACTION_BACK)
    fun home() = global(AccessibilityService.GLOBAL_ACTION_HOME)
    fun recents() = global(AccessibilityService.GLOBAL_ACTION_RECENTS)
    fun notifications() = global(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
    fun quickSettings() = global(AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS)
    fun powerDialog() = global(AccessibilityService.GLOBAL_ACTION_POWER_DIALOG)
    fun splitScreen() = global(AccessibilityService.GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN)

    fun lockScreen(): Boolean =
        if (Build.VERSION.SDK_INT >= 28) global(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN) else false

    fun takeScreenshot(): Boolean =
        if (Build.VERSION.SDK_INT >= 28) global(AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT) else false

    /** 按名称分发（tool 层用） */
    fun dispatch(action: String): Boolean = when (action) {
        "back" -> back()
        "home" -> home()
        "recents" -> recents()
        "notifications" -> notifications()
        "quickSettings" -> quickSettings()
        "powerDialog" -> powerDialog()
        "splitScreen" -> splitScreen()
        "lockScreen" -> lockScreen()
        else -> false
    }
}
