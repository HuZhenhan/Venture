/** 当前运行平台是否为 Android（Tauri Android WebView） */
export function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}
