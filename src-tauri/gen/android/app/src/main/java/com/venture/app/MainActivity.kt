package com.venture.app

import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    lateinit var browserManager: BrowserWebViewManager
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        browserManager = BrowserWebViewManager(this)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        // 允许 HTTPS 页面 (https://tauri.localhost) 访问本地 HTTP 后端 (http://127.0.0.1:49527)。
        // targetSdk>=28 时 WebView 默认 MIXED_CONTENT_NEVER_ALLOW，会拦截此类混合内容请求，
        // 导致前端 fetch 抛出 "Failed to fetch"（添加 API/供应商时报错即由此而来）。
        // usesCleartextTraffic=true 只解除网络层明文限制，不影响混合内容策略，二者需分别开启。
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        val tauriView = webView as? RustWebView ?: return
        browserManager.setTauriView(tauriView)
        tauriView.addJavascriptInterface(browserManager.bridge, "BrowserBridge")
    }

    override fun onDestroy() {
        browserManager.destroy()
        super.onDestroy()
    }
}
