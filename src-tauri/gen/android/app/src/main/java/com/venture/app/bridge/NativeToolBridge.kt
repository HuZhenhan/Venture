package com.venture.app.bridge

import android.content.Context
import org.json.JSONObject

/**
 * 原生工具桥全局入口（自愈机制核心）。
 *
 * 进程被杀后系统会重启无障碍服务（onServiceConnected），此时 MainActivity /
 * ToolServer / Rust 后端都不存在。本对象持有 applicationContext 与懒加载的
 * NativeToolRouter，服务恢复时调用 [recoverIfNeeded] 把 ToolServer 拉起来，
 * 使原生工具桥在用户重新打开应用前即可用。
 */
object NativeToolBridge {

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var router: NativeToolRouter? = null

    /** 初始化（MainActivity.onCreate 与无障碍服务 onServiceConnected 都会调用） */
    fun init(context: Context): Context {
        val app = context.applicationContext
        if (appContext == null) appContext = app
        return app
    }

    fun ensureRouter(context: Context): NativeToolRouter =
        router ?: synchronized(this) {
            router ?: NativeToolRouter(init(context)).also { router = it }
        }

    /** 工具分发（MainActivity 的 ToolServer handler 走这里） */
    fun dispatch(tool: String, args: JSONObject): JSONObject {
        val ctx = appContext ?: return JSONObject().put("ok", false).put(
            "error", JSONObject().put("code", "not_initialized").put("message", "NativeToolBridge 未初始化")
        )
        return ensureRouter(ctx).dispatch(tool, args)
    }

    /**
     * 自愈：进程被杀后无障碍服务重启时调用。
     * 幂等启动 ToolServer；router 懒加载（首次工具调用时重建）。
     */
    fun recoverIfNeeded(context: Context) {
        init(context)
        ToolServer.ensureStarted(appContext!!) { tool, args -> dispatch(tool, args) }
    }

    /** 无障碍服务是否就绪（health 查询用） */
    fun isAccessibilityReady(): Boolean =
        com.venture.app.accessibility.VentureAccessibilityService.instance != null
}
