package com.venture.app.accessibility.automator

import android.content.Context
import android.util.DisplayMetrics
import android.view.WindowManager

/**
 * 屏幕指标（对应规格书 4.2 / 5.2 ScreenMetrics 缩放）。
 *
 * 脚本坐标系（虚拟分辨率）→ 真实像素：scaleX/scaleY 统一在手势层应用。
 * 未设置虚拟分辨率时 scale = 1（坐标直用）。
 */
class ScreenMetrics(
    private val deviceWidth: Int,
    private val deviceHeight: Int,
) {
    @Volatile
    private var virtualWidth: Int = 0

    @Volatile
    private var virtualHeight: Int = 0

    /** 设置脚本虚拟分辨率（0 表示禁用缩放） */
    fun setVirtualResolution(width: Int, height: Int) {
        virtualWidth = width
        virtualHeight = height
    }

    val scaleX: Float
        get() = if (virtualWidth > 0) deviceWidth.toFloat() / virtualWidth else 1f

    val scaleY: Float
        get() = if (virtualHeight > 0) deviceHeight.toFloat() / virtualHeight else 1f

    fun scaleX(x: Int): Int = (x * scaleX).toInt()
    fun scaleY(y: Int): Int = (y * scaleY).toInt()

    companion object {
        fun from(context: Context): ScreenMetrics {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
            return ScreenMetrics(metrics.widthPixels, metrics.heightPixels)
        }
    }
}
