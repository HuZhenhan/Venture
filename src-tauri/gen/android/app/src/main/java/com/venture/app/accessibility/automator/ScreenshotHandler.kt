package com.venture.app.accessibility.automator

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Bitmap
import android.hardware.HardwareBuffer
import android.os.Build
import android.view.Display
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 截图（对应规格书 4.7）。
 *
 * 仅 API 30+：service.takeScreenshot(DEFAULT_DISPLAY, executor, callback)
 *  - HARDWARE 位图不可读像素，必须 copy(ARGB_8888) 后 recycle
 *  - ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT → 50ms 后重试
 *  - 其他失败 → 返回 null，上层走 OCR 降级或 ask_user
 *
 * OCR 对接：仅保留接口（OcrEngine），后续添加本地/云端实现。
 */
class ScreenshotHandler(
    private val context: Context,
    private val serviceProvider: () -> AccessibilityService?,
) {

    /** OCR 引擎接口（规格书 4.7：只保留接口，后续添加） */
    interface OcrEngine {
        fun recognize(imagePath: String, region: IntArray? = null): String
    }

    @Volatile
    var ocrEngine: OcrEngine? = null

    class ScreenshotResult(
        val imagePath: String,
        val width: Int,
        val height: Int,
    )

    fun screenshotsDir(): File =
        File(context.filesDir, "screenshots").apply { mkdirs() }

    /** 同步截图，成功返回结果，失败返回 null */
    fun captureScreen(maxRetries: Int = 3): ScreenshotResult? {
        if (Build.VERSION.SDK_INT < 30) return null
        val service = serviceProvider() ?: return null

        var attempt = 0
        while (attempt < maxRetries) {
            attempt++
            val latch = CountDownLatch(1)
            val bitmapHolder = arrayOfNulls<Bitmap>(1)
            val failureHolder = intArrayOf(-1)

            runCatching {
                service.takeScreenshot(
                    Display.DEFAULT_DISPLAY,
                    context.mainExecutor,
                    object : AccessibilityService.TakeScreenshotCallback {
                        override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                            try {
                                val hwBitmap = Bitmap.wrapHardwareBuffer(
                                    screenshot.hardwareBuffer, screenshot.colorSpace
                                )
                                screenshot.hardwareBuffer.close()
                                // HARDWARE 位图不可读像素 → copy 成 ARGB_8888
                                bitmapHolder[0] = hwBitmap?.copy(Bitmap.Config.ARGB_8888, false)
                                hwBitmap?.recycle()
                            } finally {
                                latch.countDown()
                            }
                        }

                        override fun onFailure(errorCode: Int) {
                            failureHolder[0] = errorCode
                            latch.countDown()
                        }
                    }
                )
            }.onFailure { return null }

            latch.await(10, TimeUnit.SECONDS)

            val failure = failureHolder[0]
            if (failure == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) {
                Thread.sleep(50) // 间隔过短 → 50ms 后重试（规格书 4.7）
                continue
            }
            if (failure != -1) return null

            val bitmap = bitmapHolder[0] ?: return null
            val file = File(screenshotsDir(), "shot_${System.currentTimeMillis()}.png")
            return try {
                FileOutputStream(file).use { out ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                }
                ScreenshotResult(file.absolutePath, bitmap.width, bitmap.height)
            } finally {
                bitmap.recycle()
            }
        }
        return null
    }
}
