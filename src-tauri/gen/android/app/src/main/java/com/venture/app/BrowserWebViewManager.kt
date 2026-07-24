@file:Suppress("SetJavaScriptEnabled")

package com.venture.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject

/**
 * 管理独立的 Android WebView，用于应用内浏览器功能。
 * 替代 Electron 的 BrowserView，同时支持 JS 注入提取页面摘要。
 */
class BrowserWebViewManager(private val activity: WryActivity) {
    private val handler = Handler(Looper.getMainLooper())
    var browserView: WebView? = null
        private set

    private var tauriView: RustWebView? = null
    private var isCreated = false
    private var currentBounds: BrowserBounds? = null
    @Volatile private var isExplicitlyHidden = false

    data class BrowserBounds(
        val x: Int, val y: Int, val width: Int, val height: Int
    ) {
        val visible: Boolean get() = width > 0 && height > 0 && x >= 0 && y >= 0
    }

    /** 前端通过 addJavascriptInterface 直接调用的桥接对象 */
    inner class BrowserJsBridge {
        @JavascriptInterface
        fun open(url: String, x: Float, y: Float, w: Float, h: Float) {
            handler.post {
                isExplicitlyHidden = false
                navigate(url)
                updateBounds(
                    BrowserBounds(
                        x = (x + 0.5f).toInt(),
                        y = (y + 0.5f).toInt(),
                        width = (w + 0.5f).toInt(),
                        height = (h + 0.5f).toInt()
                    )
                )
            }
        }

        @JavascriptInterface
        fun navigate(url: String) {
            handler.post { this@BrowserWebViewManager.navigate(url) }
        }

        @JavascriptInterface
        fun goBack() {
            handler.post { browserView?.goBack() }
        }

        @JavascriptInterface
        fun goForward() {
            handler.post { browserView?.goForward() }
        }

        @JavascriptInterface
        fun reload() {
            handler.post { browserView?.reload() }
        }

        @JavascriptInterface
        fun setBounds(x: Float, y: Float, w: Float, h: Float) {
            handler.post {
                updateBounds(
                    BrowserBounds(
                        x = (x + 0.5f).toInt(),
                        y = (y + 0.5f).toInt(),
                        width = (w + 0.5f).toInt(),
                        height = (h + 0.5f).toInt()
                    )
                )
            }
        }

        @JavascriptInterface
        fun summarize(callbackId: String) {
            handler.post { runSummarize(callbackId) }
        }

        @JavascriptInterface
        fun hide() {
            // postAtFrontOfQueue：跳到消息队列最前面，确保在 pending 的 setBounds 之前
            handler.postAtFrontOfQueue { this@BrowserWebViewManager.hide() }
        }

        @JavascriptInterface
        fun close() {
            handler.postAtFrontOfQueue {
                isExplicitlyHidden = true
                destroy()
            }
        }

        @JavascriptInterface
        fun openExternal(url: String) {
            handler.post {
                try {
                    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                    activity.startActivity(intent)
                } catch (_: Exception) { }
            }
        }
    }

    val bridge = BrowserJsBridge()

    fun setTauriView(view: RustWebView) {
        tauriView = view
    }

    /** 通知前端浏览器状态变化（通过 CustomEvent） */
    private fun notifyState(url: String, title: String, canGoBack: Boolean, canGoForward: Boolean, isLoading: Boolean, error: String?) {
        val escapedUrl = url.replace("\\", "\\\\").replace("'", "\\'")
        val escapedTitle = title.replace("\\", "\\\\").replace("'", "\\'")
        val escapedError = if (error != null) "'${error.replace("\\", "\\\\").replace("'", "\\'")}'" else "null"
        val js = """
            window.dispatchEvent(new CustomEvent('browser-state', {
                detail: { url: '$escapedUrl', title: '$escapedTitle', canGoBack: $canGoBack, canGoForward: $canGoForward, isLoading: $isLoading, error: $escapedError }
            }));
        """.trimIndent()
        tauriView?.evaluateJavascript(js, null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun create(url: String) {
        if (isCreated) return
        isCreated = true

        val ctx = activity.applicationContext
        browserView = WebView(ctx).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            settings.setSupportZoom(true)
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.userAgentString = settings.userAgentString + " VentureBrowser/1.0"
            isVerticalScrollBarEnabled = true
            isHorizontalScrollBarEnabled = true
            setBackgroundColor(Color.WHITE)

            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    val canGoBack = view.canGoBack()
                    val canGoForward = view.canGoForward()
                    notifyState(url, view.title ?: "", canGoBack, canGoForward, false, null)
                }

                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    url?.let {
                        notifyState(it, "", browserView?.canGoBack() ?: false, browserView?.canGoForward() ?: false, true, null)
                    }
                }

                override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                    notifyState(failingUrl ?: "", "", browserView?.canGoBack() ?: false, browserView?.canGoForward() ?: false, false, description ?: "加载失败")
                }

                override fun onReceivedSslError(view: WebView?, handler: android.webkit.SslErrorHandler?, error: android.net.http.SslError?) {
                    // 部分网站证书链不完整，允许继续加载（用户可在外部浏览器验证）
                    handler?.proceed()
                }

                override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
                    return false  // 所有 URL 都在 WebView 内加载
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView?, title: String?) {
                    notifyState(view?.url ?: "", title ?: "", browserView?.canGoBack() ?: false, browserView?.canGoForward() ?: false, false, null)
                }
            }
        }

        // 添加到 activity 的内容视图之上
        val rootLayout = activity.window.decorView.findViewById<FrameLayout>(android.R.id.content)
        browserView?.let { wv ->
            rootLayout?.addView(wv, FrameLayout.LayoutParams(0, 0).apply {
                gravity = Gravity.TOP or Gravity.START
            })
        }

        navigate(url)
    }

    fun navigate(url: String) {
        if (!isCreated) create(url)
        val wv = browserView ?: return
        if (url != wv.url) wv.loadUrl(url)
        notifyState(url, "", wv.canGoBack(), wv.canGoForward(), true, null)
    }

    fun updateBounds(bounds: BrowserBounds) {
        val wv = browserView ?: return
        // hide() 已调用，拒绝 ResizeObserver / syncBounds 的任何恢复
        if (isExplicitlyHidden) return

        currentBounds = bounds
        if (!bounds.visible) {
            wv.visibility = android.view.View.GONE
            return
        }

        val params = wv.layoutParams as? FrameLayout.LayoutParams
            ?: FrameLayout.LayoutParams(bounds.width, bounds.height)
        params.width = bounds.width
        params.height = bounds.height
        params.leftMargin = bounds.x
        params.topMargin = bounds.y
        wv.layoutParams = params
        wv.visibility = android.view.View.VISIBLE
    }

    fun hide() {
        isExplicitlyHidden = true
        browserView?.visibility = android.view.View.GONE
    }

    fun destroy() {
        isExplicitlyHidden = true
        browserView?.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            (parent as? ViewGroup)?.removeView(this)
            destroy()
        }
        browserView = null
        isCreated = false
        currentBounds = null
    }

    /** 执行页面内容摘要提取 */
    private fun runSummarize(callbackId: String) {
        val wv = browserView
        if (wv == null) {
            sendSummaryError(callbackId, "浏览器视图不可用")
            return
        }

        wv.evaluateJavascript(BrowserExtractScript.SCRIPT) { rawResult ->
            val resultJson = parseExtractResult(rawResult)
            val currentUrl = try { wv.url ?: "" } catch (_: Exception) { "" }

            val summary = JSONObject().apply {
                put("id", "sum-" + java.lang.Long.toString(System.currentTimeMillis(), 36) + "-" +
                        java.lang.Long.toString((Math.random() * 0xFFFFFF).toLong(), 36))
                put("url", currentUrl)
                put("timestamp", System.currentTimeMillis())
                if (resultJson != null) {
                    put("chunks", resultJson.optJSONArray("chunks") ?: JSONArray())
                    put("status", if (resultJson.optBoolean("success", false)) "completed" else "failed")
                    put("error", if (resultJson.optBoolean("success", false)) JSONObject.NULL else resultJson.optString("error", "摘取失败"))
                } else {
                    put("chunks", JSONArray())
                    put("status", "failed")
                    put("error", "摘取结果解析失败")
                }
            }

            // 用 JSON 字符串回调前端
            val cbJs = "window.__browser_summary_result('$callbackId', $summary);"
            tauriView?.evaluateJavascript(cbJs, null)
        }
    }

    private fun parseExtractResult(raw: String): JSONObject? {
        val trimmed = raw.trim()
        // evaluateJavascript 返回的字符串可能被双引号包裹
        val json = if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            trimmed.substring(1, trimmed.length - 1)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
                .replace("\\/", "/")
        } else {
            trimmed
        }
        return try {
            JSONObject(json)
        } catch (_: Exception) {
            null
        }
    }

    private fun sendSummaryError(callbackId: String, message: String) {
        val cbJs = """window.__browser_summary_result('$callbackId', {"id":"err","url":"","timestamp":${System.currentTimeMillis()},"chunks":[],"status":"failed","error":"${message.replace("\"", "\\\"")}"});"""
        tauriView?.evaluateJavascript(cbJs, null)
    }
}
