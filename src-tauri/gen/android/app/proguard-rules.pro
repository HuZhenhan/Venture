# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ────────────────────────────────────────────────────────────
# Tauri/wry JNI 调用保护（修复 R8 裁剪导致的启动闪退）
#
# 背景：release 构建开启了 R8（isMinifyEnabled=true）。wry 的 Rust 端通过
# JNI 字符串查找（env.call_method）调用 WryActivity.getId()/getVersion()、
# RustWebView.loadUrlMainThread() 等方法，R8 感知不到这些 native 调用，
# 会把方法当无用代码裁剪掉，启动时 NoSuchMethodError → Rust panic → SIGABRT。
#
# wry crate 自带 proguard-wry.pro 规则，但 tauri 生成工程时该规则未进入
# .tauri/tauri-api/proguard-rules.pro（且原规则只匹配 app.tauri 包，模板类
# 实际在 com.venture.app 包），因此在此补充。
# ────────────────────────────────────────────────────────────

# tauri/wry 模板类整体保留（JNI 字符串调用 + 生命周期回调，逐个 keep 会遗漏）
-keep class com.venture.app.WryActivity { *; }
-keep class com.venture.app.TauriActivity { *; }
-keep class com.venture.app.RustWebView { *; }
-keep class com.venture.app.RustWebChromeClient { *; }
-keep class com.venture.app.RustWebViewClient { *; }
-keep class com.venture.app.Rust { *; }
-keep class com.venture.app.Ipc { *; }

-keep class com.venture.app.** {
  native <methods>;
}