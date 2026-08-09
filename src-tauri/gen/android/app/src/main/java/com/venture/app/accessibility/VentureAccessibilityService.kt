package com.venture.app.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.venture.app.bridge.NativeToolBridge
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Venture 无障碍服务（对应规格书 3.1）。
 *
 * 职责：
 *  - 维护全局实例与双状态（已连接 / 已可操作）
 *  - fast root 缓存：窗口切换/焦点变化时顺手缓存 rootInActiveWindow
 *  - 事件回调注册表：eventType -> callbacks，供 wait_for_text 等轮询复用
 */
class VentureAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: VentureAccessibilityService? = null
            private set

        /** 收到首个无障碍事件后才为 true（服务真正可操作的信号） */
        @Volatile
        var hasOperationalState = false
            private set

        private val LOCK = ReentrantLock()
        private val ENABLED = LOCK.newCondition()
        private val OPERATIONAL = LOCK.newCondition()

        const val DEFAULT_TIMEOUT = 2000L

        /** 等待服务连接（系统绑定完成） */
        fun waitForStarted(timeout: Long = DEFAULT_TIMEOUT): Boolean {
            if (instance != null) return true
            return LOCK.withLock {
                var remaining = timeout
                while (instance == null && remaining > 0) {
                    val start = System.currentTimeMillis()
                    ENABLED.await(remaining, TimeUnit.MILLISECONDS)
                    remaining -= System.currentTimeMillis() - start
                }
                instance != null
            }
        }

        /** 等待服务进入可操作状态（收到首个事件） */
        fun waitForOperational(timeout: Long = DEFAULT_TIMEOUT): Boolean {
            if (hasOperationalState) return true
            return LOCK.withLock {
                var remaining = timeout
                while (!hasOperationalState && remaining > 0) {
                    val start = System.currentTimeMillis()
                    OPERATIONAL.await(remaining, TimeUnit.MILLISECONDS)
                    remaining -= System.currentTimeMillis() - start
                }
                hasOperationalState
            }
        }

        fun stop() {
            instance?.disableSelf()
        }

        internal fun resetState() {
            hasOperationalState = false
        }
    }

    /** fast root 缓存：窗口切换/焦点变化时更新（规格书 3.1） */
    @Volatile
    var fastRootInActiveWindow: AccessibilityNodeInfo? = null

    /** 最近一次窗口切换的前台包名（get_foreground_app 用） */
    @Volatile
    var lastForegroundPackage: String? = null
        private set

    /** 事件回调注册表：eventType -> callbacks（供 wait_for_text 等轮询/监听复用） */
    private val eventCallbacks = ConcurrentHashMap<Int, MutableList<(AccessibilityEvent) -> Unit>>()

    fun registerEventCallback(eventType: Int, callback: (AccessibilityEvent) -> Unit) {
        eventCallbacks.getOrPut(eventType) { mutableListOf() }.add(callback)
    }

    fun unregisterEventCallback(eventType: Int, callback: (AccessibilityEvent) -> Unit) {
        eventCallbacks[eventType]?.remove(callback)
    }

    override fun onServiceConnected() {
        instance = this
        // 布局分析更完整（腾讯系部分节点依赖），代价：节点树更大，由 brief 压缩配合
        serviceInfo = serviceInfo?.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        }
        // 自愈：进程被杀后系统重启本服务（新进程），恢复工具桥，
        // 使自动化能力在用户重新打开应用前即可用，也借此保住进程优先级。
        runCatching { NativeToolBridge.recoverIfNeeded(this) }
        LOCK.withLock { ENABLED.signalAll() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        instance = this
        if (!hasOperationalState) {
            hasOperationalState = true
            LOCK.withLock { OPERATIONAL.signalAll() }
        }
        // fast root 缓存：窗口切换/焦点变化时顺手缓存
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED
        ) {
            runCatching { rootInActiveWindow }.getOrNull()?.let { fastRootInActiveWindow = it }
        }
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.packageName?.toString()?.let { lastForegroundPackage = it }
        }
        // 事件回调分发
        eventCallbacks[event.eventType]?.toList()?.forEach { cb ->
            runCatching { cb(event) }
        }
    }

    override fun onInterrupt() {
        // 无需处理：本服务不维护中断敏感状态
    }

    override fun getRootInActiveWindow(): AccessibilityNodeInfo? =
        runCatching { super.getRootInActiveWindow() }.getOrNull() // 系统 Binder 调用可能抛异常

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        fastRootInActiveWindow = null
        resetState()
        return super.onUnbind(intent)
    }
}
