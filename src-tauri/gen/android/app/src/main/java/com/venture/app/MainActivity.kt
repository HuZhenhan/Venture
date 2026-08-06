package com.venture.app

import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.venture.app.bridge.NativeToolRouter
import com.venture.app.bridge.ToolServer

class MainActivity : TauriActivity() {
    lateinit var browserManager: BrowserWebViewManager
        private set

    private lateinit var toolRouter: NativeToolRouter

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        browserManager = BrowserWebViewManager(this)
        // 启动原生工具桥（127.0.0.1:46307），供后端 tool_router 转发无障碍工具调用
        toolRouter = NativeToolRouter(this)
        ToolServer.ensureStarted { tool, args -> toolRouter.dispatch(tool, args) }
        setupImeInsets()
        setupBackNavigation()
    }

    /**
     * 层级返回：拦截系统返回键，把事件派发给前端
     * （window.dispatchEvent(new CustomEvent('venture-back'))），
     * 由前端按当前页面层级决定：返回主对话页，或在主对话页弹出退出确认。
     * 不调用默认行为，避免在二级页面（如 API 供应商设置页）直接退出应用。
     */
    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                notifyFrontendBackPressed()
            }
        })
    }

    private fun notifyFrontendBackPressed() {
        // content 布局的第一个子 View 即 Tauri 主 WebView（与 IME insets 处理方式一致）
        val content = window.decorView.findViewById<ViewGroup>(android.R.id.content)
            ?: run { finish(); return }
        val webView = content.getChildAt(0) as? WebView
            ?: run { finish(); return }
        runOnUiThread {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('venture-back'));",
                null,
            )
        }
    }

    /**
     * 软键盘适配（解决输入法遮挡输入框）。
     *
     * enableEdgeToEdge() 在 API 30+ 设置 decorFitsSystemWindows=false，
     * 此时 Manifest 的 windowSoftInputMode="adjustResize" 失效，系统不再自动
     * 缩小窗口，需要手动监听 IME insets，把键盘高度补偿为主 WebView 的
     * bottomMargin，使 WebView 布局视口变矮、底部输入框自动上移到键盘上方。
     *
     * API < 30 时 WindowInsetsCompat.Type.ime() 恒为 0，此监听无副作用，
     * 遮挡问题由 adjustResize 兜底解决，两套机制互不干扰。
     */
    private fun setupImeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            // content 布局的第一个子 View 即 Tauri 主 WebView（键盘弹出时必定已创建）
            val content = window.decorView.findViewById<ViewGroup>(android.R.id.content) ?: return@setOnApplyWindowInsetsListener insets
            val webView = content.getChildAt(0) as? WebView ?: return@setOnApplyWindowInsetsListener insets
            val params = webView.layoutParams
            if (params is ViewGroup.MarginLayoutParams) {
                params.bottomMargin = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                webView.layoutParams = params
            }
            insets
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        // 覆盖安装后 WebView 会从持久化 HTTP 缓存加载旧版 index.html（此前出现过
        // 设备界面停留在旧版本、新功能不生效的问题）。每次启动清空缓存，
        // 确保始终加载 assets 中的最新前端。
        webView.clearCache(true)
        WebView.setWebContentsDebuggingEnabled(true)
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
