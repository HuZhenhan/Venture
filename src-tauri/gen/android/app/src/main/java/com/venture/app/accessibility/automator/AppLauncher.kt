package com.venture.app.accessibility.automator

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/**
 * 应用启动与链接打开（对应规格书 4.5）。
 *
 * launch_app 自动识别双模式：入参含 "." → 包名；否则 → 应用名模糊匹配。
 * 不用固定映射表：要操作的目标软件可能是未知的。
 */
class AppLauncher(private val context: Context) {

    fun launchApp(nameOrPkg: String): Boolean {
        return if (nameOrPkg.contains(".")) {
            launchByPackage(nameOrPkg)
        } else {
            launchByName(nameOrPkg)
        }
    }

    private fun launchByPackage(pkg: String): Boolean {
        val intent = context.packageManager.getLaunchIntentForPackage(pkg) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(intent) }.isSuccess
    }

    /** 名称模糊匹配：完全相等 > 前缀 > 包含（大小写不敏感） */
    private fun launchByName(name: String): Boolean {
        val pm = context.packageManager
        val main = Intent(Intent.ACTION_MAIN, null).addCategory(Intent.CATEGORY_LAUNCHER)
        val activities = pm.queryIntentActivities(main, PackageManager.MATCH_ALL)
        if (activities.isEmpty()) return false

        data class Candidate(val pkg: String, val label: String)

        val candidates = activities.map {
            Candidate(it.activityInfo.packageName, it.loadLabel(pm)?.toString() ?: "")
        }.filter { it.label.isNotEmpty() }

        val lower = name.lowercase()
        val picked = candidates.firstOrNull { it.label.lowercase() == lower }
            ?: candidates.firstOrNull { it.label.lowercase().startsWith(lower) }
            ?: candidates.firstOrNull { it.label.lowercase().contains(lower) }
            ?: return false
        return launchByPackage(picked.pkg)
    }

    /** 解析应用名 → 包名（wait_for_app 等场景复用同一识别规则） */
    fun resolvePackage(nameOrPkg: String): String? {
        if (nameOrPkg.contains(".")) return nameOrPkg
        val pm = context.packageManager
        val main = Intent(Intent.ACTION_MAIN, null).addCategory(Intent.CATEGORY_LAUNCHER)
        val activities = pm.queryIntentActivities(main, PackageManager.MATCH_ALL)
        val lower = nameOrPkg.lowercase()
        return activities
            .map { it.activityInfo.packageName to (it.loadLabel(pm)?.toString() ?: "") }
            .filter { it.second.isNotEmpty() }
            .let { list ->
                list.firstOrNull { it.second.lowercase() == lower }
                    ?: list.firstOrNull { it.second.lowercase().startsWith(lower) }
                    ?: list.firstOrNull { it.second.lowercase().contains(lower) }
            }?.first
    }

    fun openUrl(url: String): Boolean {
        // URL scheme 深链（tbopen://、openapp.jdmobile://、weixin://）与普通 https 统一走 ACTION_VIEW
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(intent) }.isSuccess
    }
}
