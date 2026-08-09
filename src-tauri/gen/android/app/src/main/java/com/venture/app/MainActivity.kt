package com.venture.app

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.venture.app.bridge.ApprovalOverlayWindowManager
import com.venture.app.bridge.NativeToolBridge
import com.venture.app.bridge.OverlayWindowManager
import com.venture.app.bridge.ToolServer

class MainActivity : TauriActivity() {
    lateinit var browserManager: BrowserWebViewManager
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        browserManager = BrowserWebViewManager(this)
        // 启动原生工具桥（127.0.0.1:46307），供后端 tool_router 转发无障碍工具调用。
        // 经 NativeToolBridge 统一入口，支持进程被杀后无障碍服务自愈复用同一 router。
        NativeToolBridge.init(this)
        ToolServer.ensureStarted(this) { tool, args -> NativeToolBridge.dispatch(tool, args) }
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
        // 设备界面停留在旧版本、新功能不生效的问题）。启动优化：仅当 versionCode
        // 变化（覆盖安装/升级）时清空缓存，确保加载最新前端；日常重进命中缓存，
        // 避免每次冷加载单文件 bundle 导致白屏变长。
        // 注意：开发打包若 versionCode 未递增，设备上可能仍是旧版前端——改完前端
        // 必须递增 src-tauri/gen/android/app/tauri.properties 的 tauri.android.versionCode。
        val versionCode = if (Build.VERSION.SDK_INT >= 28) {
            packageManager.getPackageInfo(packageName, 0).longVersionCode
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(packageName, 0).versionCode.toLong()
        }
        val prefs = getSharedPreferences("venture_webview_cache", Context.MODE_PRIVATE)
        val lastVersion = prefs.getLong("last_version_code", -1L)
        if (lastVersion != versionCode) {
            webView.clearCache(true)
            prefs.edit().putLong("last_version_code", versionCode).apply()
        }
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

    override fun onResume() {
        super.onResume()
        // 回到应用前台：悬浮窗关闭（应用内已有 AI 活动/授权卡片展示），保留状态记忆
        OverlayWindowManager.onAppForeground()
        ApprovalOverlayWindowManager.onAppForeground()
    }

    override fun onPause() {
        super.onPause()
        // 应用退后台：若 AI 正在运行，悬浮窗恢复显示；有待授权请求时补显授权卡片
        OverlayWindowManager.onAppBackground()
        ApprovalOverlayWindowManager.onAppBackground()
    }

    override fun onDestroy() {
        browserManager.destroy()
        super.onDestroy()
    }
}
