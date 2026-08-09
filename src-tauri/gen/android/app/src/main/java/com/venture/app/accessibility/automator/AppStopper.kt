package com.venture.app.accessibility.automator

import android.content.Context
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 应用停止器（stop_app 工具的原生实现）。
 *
 * Android 安全模型下，普通第三方应用无法直接「强制停止」其他应用：
 * - killBackgroundProcesses（KILL_BACKGROUND_PROCESSES 权限）仅对非关键后台进程生效，
 *   Android 10+ 上对常驻服务/近期任务中的应用基本无效；
 * - forceStopPackage 是隐藏 API，需要 FORCE_STOP_PACKAGES 签名权限或 root/shell 身份；
 * - 无障碍打开系统设置点「强行停止」在部分厂商 ROM（如 vivo）上因设置页屏蔽
 *   无障碍布局查询而不可行。
 *
 * 因此本实现仅在 root 可用时执行 `am force-stop`（最可靠）；无 root 时直接返回
 * 「缺少 root 权限」错误，由用户手动关闭应用，不做不可靠的降级尝试。
 */
class AppStopper(
    private val context: Context,
) {

    companion object {
        /** 包名白名单（防 shell 注入：pkg 会拼进命令行） */
        private val PKG_PATTERN = Regex("^[a-zA-Z0-9._]+$")
    }

    /** root 可用性缓存（探测一次即可，避免每次 stop_app 都等待 su 响应） */
    @Volatile
    private var rootCached: Boolean? = null

    /** 停止指定应用。返回结构化 JSON（ok=true 带 method/killed；失败带 error） */
    fun stop(pkg: String): JSONObject {
        if (pkg == context.packageName) {
            return error("self_target_forbidden", "拒绝对自身应用执行停止操作")
        }
        if (!PKG_PATTERN.matches(pkg)) {
            return error("bad_param", "非法包名: $pkg")
        }
        if (!hasRoot()) {
            return error(
                "root_required",
                "设备未获取 root 权限，无法强制停止应用。请在系统设置中手动关闭 $pkg"
            )
        }
        if (!forceStopViaRoot(pkg)) {
            return error(
                "stop_failed",
                "root 可用但 am force-stop 执行失败，请在系统设置中手动关闭 $pkg"
            )
        }
        return JSONObject()
            .put("ok", true)
            .put("method", "root")
            .put("killed", true)
            .put("message", "已强制停止 $pkg")
    }

    /** 探测 su 是否可用（结果缓存；无 su 时 start 立即失败，无需等待） */
    private fun hasRoot(): Boolean {
        rootCached?.let { return it }
        val ok = runCatching {
            val p = ProcessBuilder("su", "-c", "id").start()
            val finished = p.waitFor(3, TimeUnit.SECONDS)
            if (!finished) p.destroy()
            finished && p.exitValue() == 0
        }.getOrDefault(false)
        rootCached = ok
        return ok
    }

    private fun forceStopViaRoot(pkg: String): Boolean = runCatching {
        val p = ProcessBuilder("su", "-c", "am force-stop $pkg").start()
        val finished = p.waitFor(5, TimeUnit.SECONDS)
        if (!finished) p.destroy()
        finished && p.exitValue() == 0
    }.getOrDefault(false)

    private fun error(code: String, message: String): JSONObject =
        JSONObject()
            .put("ok", false)
            .put("error", JSONObject().put("code", code).put("message", message))
}
