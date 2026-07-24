# Venture Android — 浏览器 WebView ProGuard 规则
# 防止 release 混淆导致 @JavascriptInterface 方法被移除

-keep class com.venture.app.BrowserWebViewManager$BrowserJsBridge {
    @android.webkit.JavascriptInterface public <methods>;
}

-keep class com.venture.app.BrowserWebViewManager {
    public <init>(...);
}

-keep class com.venture.app.BrowserExtractScript {
    public static java.lang.String SCRIPT;
}
