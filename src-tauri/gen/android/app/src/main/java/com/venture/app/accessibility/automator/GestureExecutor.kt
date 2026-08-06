package com.venture.app.accessibility.automator

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Handler
import android.os.HandlerThread
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 全局手势执行器（对应规格书 4.2 dispatchGesture）。
 *
 * 实现要点：
 * 1. 坐标先过 ScreenMetrics 缩放（脚本虚拟分辨率 → 真实像素）
 * 2. Path：首点 moveTo，其余 lineTo
 * 3. dispatchGesture 是异步 API，此处同步封装（CountDownLatch 等待回调）
 * 4. 负坐标抛异常（防坐标换算错误）
 * 5. 服务未运行 → 抛 IllegalStateException("无障碍服务未运行")
 */
class GestureExecutor(
    private val serviceProvider: () -> AccessibilityService?,
    private val screenMetrics: ScreenMetrics?,
) {

    companion object {
        /** 手势同步等待上限（规格书附录 B：128s） */
        const val DISPATCH_TIMEOUT_MS = 128_000L

        /** click 手势时长 = TapTimeout(100ms) × 1.25 */
        const val TAP_DURATION_MS = 125L

        /** longClick 手势时长 = LongPressTimeout(400ms) × 1.25 */
        const val LONG_PRESS_DURATION_MS = 500L
    }

    private val handlerThread = HandlerThread("venture-gesture").apply { start() }
    private val handler = Handler(handlerThread.looper)

    private fun requireService(): AccessibilityService =
        serviceProvider() ?: throw IllegalStateException("无障碍服务未运行")

    private fun checkCoordinates(vararg coords: Int) {
        coords.forEach {
            if (it < 0) throw IllegalArgumentException("坐标不能为负: $it（检查坐标换算）")
        }
    }

    private fun scaleX(x: Int): Int = screenMetrics?.scaleX(x) ?: x
    private fun scaleY(y: Int): Int = screenMetrics?.scaleY(y) ?: y

    /** 同步分发手势，返回是否完成 */
    private fun dispatch(description: GestureDescription): Boolean {
        val service = requireService()
        val latch = CountDownLatch(1)
        val result = booleanArrayOf(false)
        val dispatched = runCatching {
            service.dispatchGesture(description, object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    result[0] = true
                    latch.countDown()
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    result[0] = false
                    latch.countDown()
                }
            }, handler)
        }.getOrDefault(false)
        if (!dispatched) return false
        latch.await(DISPATCH_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        return result[0]
    }

    fun click(x: Int, y: Int): Boolean = press(x, y, TAP_DURATION_MS)

    fun longClick(x: Int, y: Int): Boolean = press(x, y, LONG_PRESS_DURATION_MS)

    fun press(x: Int, y: Int, duration: Long): Boolean {
        checkCoordinates(x, y)
        val path = Path().apply { moveTo(scaleX(x).toFloat(), scaleY(y).toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0, duration.coerceAtLeast(1))
        return dispatch(GestureDescription.Builder().addStroke(stroke).build())
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Long): Boolean {
        checkCoordinates(x1, y1, x2, y2)
        val path = Path().apply {
            moveTo(scaleX(x1).toFloat(), scaleY(y1).toFloat())
            lineTo(scaleX(x2).toFloat(), scaleY(y2).toFloat())
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, duration.coerceAtLeast(1))
        return dispatch(GestureDescription.Builder().addStroke(stroke).build())
    }

    /** 任意折线手势 */
    fun gesture(startMs: Long, durationMs: Long, points: List<Pair<Int, Int>>): Boolean {
        if (points.isEmpty()) return false
        points.forEach { checkCoordinates(it.first, it.second) }
        val path = Path().apply {
            moveTo(scaleX(points[0].first).toFloat(), scaleY(points[0].second).toFloat())
            points.drop(1).forEach { lineTo(scaleX(it.first).toFloat(), scaleY(it.second).toFloat()) }
        }
        val stroke = GestureDescription.StrokeDescription(path, startMs.coerceAtLeast(0), durationMs.coerceAtLeast(1))
        return dispatch(GestureDescription.Builder().addStroke(stroke).build())
    }

    /** 多指手势（每笔一个 StrokeDescription） */
    fun gestures(strokes: List<Triple<Long, Long, List<Pair<Int, Int>>>>): Boolean {
        if (strokes.isEmpty()) return false
        val builder = GestureDescription.Builder()
        strokes.forEach { (startMs, durationMs, points) ->
            if (points.isNotEmpty()) {
                points.forEach { checkCoordinates(it.first, it.second) }
                val path = Path().apply {
                    moveTo(scaleX(points[0].first).toFloat(), scaleY(points[0].second).toFloat())
                    points.drop(1).forEach { lineTo(scaleX(it.first).toFloat(), scaleY(it.second).toFloat()) }
                }
                builder.addStroke(
                    GestureDescription.StrokeDescription(path, startMs.coerceAtLeast(0), durationMs.coerceAtLeast(1))
                )
            }
        }
        return dispatch(builder.build())
    }
}
