package com.venture.app.accessibility

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * 布局捕获入口（对应规格书 3.3）。
 *
 * 关键：捕获前必须 clearAccessibilityCache()——系统对无障碍节点有缓存，
 * 布局变化后不刷新会拿到旧帧（坐标/文本过期）。
 */
class LayoutInspector(private val context: Context) {

    interface OnCaptureAvailableListener {
        fun onCaptureAvailable(capture: Capture, context: Context)
    }

    @Volatile
    var capture: Capture? = null
        private set

    private val executor = Executors.newSingleThreadExecutor()
    private val listeners = CopyOnWriteArrayList<OnCaptureAvailableListener>()

    fun addListener(listener: OnCaptureAvailableListener) = listeners.add(listener)
    fun removeListener(listener: OnCaptureAvailableListener) = listeners.remove(listener)

    /**
     * 同步捕获当前窗口（供工具桥直接调用）。
     * 返回 null 表示服务不可用或无根节点。
     */
    fun captureNow(): Capture? {
        val service = VentureAccessibilityService.instance ?: return null
        clearAccessibilityCache(service)
        val root = service.fastRootInActiveWindow ?: service.getRootInActiveWindow() ?: return null
        val windows = runCatching { service.windows }.getOrNull()
            ?.map { WindowInfo.create(context, it) } ?: emptyList()
        val rootInfo = NodeInfo.capture(context, root)
        // 快照完成后立即回收原节点（规格书 3.7）
        runCatching { root.recycle() }
        val c = Capture(windows, rootInfo)
        capture = c
        return c
    }

    /** 异步捕获并通知监听器（对应规格书 3.3 captureCurrentWindow） */
    fun captureCurrentWindow(): Boolean {
        val service = VentureAccessibilityService.instance ?: return false
        clearAccessibilityCache(service)
        val root = service.fastRootInActiveWindow ?: service.getRootInActiveWindow() ?: return false
        executor.execute {
            val windows = runCatching { service.windows }.getOrNull()
                ?.map { WindowInfo.create(context, it) } ?: emptyList()
            val c = Capture(windows, NodeInfo.capture(context, root))
            runCatching { root.recycle() }
            capture = c
            listeners.forEach { it.onCaptureAvailable(c, context) }
        }
        return true
    }

    private fun clearAccessibilityCache(service: AccessibilityService) {
        if (Build.VERSION.SDK_INT >= 33) {
            runCatching { service.clearCache() }
        } else {
            clearCacheLegacy()
        }
    }

    /** API 33 以下：反射 AccessibilityInteractionClient.clearCache()（规格书 3.3） */
    @SuppressLint("PrivateApi", "DiscouragedPrivateApi")
    private fun clearCacheLegacy() {
        runCatching {
            val clazz = Class.forName("android.view.accessibility.AccessibilityInteractionClient")
            val getInstance = clazz.getDeclaredMethod("getInstance")
            val client = getInstance.invoke(null)
            val clearCache = clazz.getDeclaredMethod("clearCache")
            clearCache.isAccessible = true
            clearCache.invoke(client)
        }
    }
}
