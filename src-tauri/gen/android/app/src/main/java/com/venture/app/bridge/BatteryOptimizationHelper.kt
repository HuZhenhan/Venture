package com.venture.app.bridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * 电池优化 / 后台保活引导工具。
 *
 * 用途（配合 VentureKeepAliveService）：
 *  - isIgnoringBatteryOptimizations：检测应用是否已豁免电池优化（未豁免时
 *    系统可能在后台限制 CPU/网络/任务，FGS 效果打折扣）
 *  - requestIgnoreBatteryOptimizations：跳系统弹窗请求豁免（需 Manifest
 *    声明 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS；用户拒绝不影响使用）
 *  - openBatteryOptimizationSettings：直达电池优化设置页（API 23+）
 */
object BatteryOptimizationHelper {

    /** 是否已豁免电池优化（API 23+；低版本恒为 true） */
    fun isExempt(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 23) return true
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /** 请求豁免（弹系统对话框，用户可拒绝） */
    fun requestExempt(context: Context): Boolean {
        if (isExempt(context)) return true
        if (Build.VERSION.SDK_INT < 23) return true
        return runCatching {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
        }.getOrDefault(false)
    }

    /** 打开电池优化设置页（用户手动选择"不受限制"） */
    fun openSettings(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 23) return false
        return runCatching {
            val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }.getOrDefault(false)
    }

    /** 无障碍服务是否已授权（自愈/引导共用） */
    fun accessibilityGranted(context: Context): Boolean =
        AccessibilityPermissionHelper.isAccessibilityGranted(context)
}
