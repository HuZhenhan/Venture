package com.venture.app.bridge

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.text.TextUtils
import android.view.accessibility.AccessibilityManager
import com.venture.app.accessibility.VentureAccessibilityService

/**
 * 无障碍权限引导（对应规格书 8.3）。
 *
 * 三态检测：
 *  - hasService（系统设置中已授权）→ 查询 enabled_accessibility_services
 *  - hasInstance（服务已连接）→ VentureAccessibilityService.instance != null
 *  - hasOperationalState（收到首个事件）→ 真正可操作
 */
object AccessibilityPermissionHelper {

    /** 系统设置中是否已授权本应用的无障碍服务 */
    fun isAccessibilityGranted(context: Context): Boolean {
        val expected = ComponentName(context, VentureAccessibilityService::class.java)
        val enabled = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabled)
        while (splitter.hasNext()) {
            // 系统以短类名格式存储组件（如 com.venture.app/.accessibility.X），
            // flattenToString 生成完整类名（com.venture.app/com.venture.app.accessibility.X），
            // 两种格式都必须匹配，否则已授权的服务会被误判为未开启
            val entry = splitter.next()
            if (entry.equals(expected.flattenToString(), ignoreCase = true) ||
                entry.equals(expected.flattenToShortString(), ignoreCase = true)
            ) {
                return true
            }
        }
        return false
    }

    /** 三态快照（前端权限引导页展示用） */
    fun stateSnapshot(context: Context): Map<String, Boolean> = mapOf(
        "granted" to isAccessibilityGranted(context),
        "connected" to (VentureAccessibilityService.instance != null),
        "operational" to VentureAccessibilityService.hasOperationalState,
    )

    /** 跳转系统无障碍设置页 */
    fun openAccessibilitySettings(context: Context) {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
