declare const __IS_ELECTRON__: boolean;

interface BackendInfo {
  baseUrl: string;
  ready: boolean;
  port: number;
  nonce?: string | null;
  pid?: number | null;
  startedAt?: string | null;
}

interface NativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
}

interface NativeBrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  visible: boolean;
  error?: string;
}

interface BrowserSummaryChunk {
  id: string;
  type: 'text' | 'heading' | 'list' | 'quote' | 'code';
  level?: number;
  content: string;
}

interface BrowserSummary {
  id: string;
  url: string;
  timestamp: number;
  chunks: BrowserSummaryChunk[];
  status: 'completed' | 'failed';
  error?: string;
}

interface DesktopShellApi {
  isDesktop: true;
  platform: string;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  unmaximizeWindow: () => void;
  isMaximized: () => Promise<boolean>;
  closeWindow: () => void;
  getBackendInfo: () => Promise<BackendInfo>;
  browserOpen: (payload: {
    url: string;
    bounds: NativeBrowserBounds;
  }) => Promise<boolean>;
  browserNavigate: (url: string) => Promise<boolean>;
  browserSetBounds: (bounds: NativeBrowserBounds) => void;
  browserHide: () => void;
  browserClose: () => void;
  browserBack: () => void;
  browserForward: () => void;
  browserReload: () => void;
  browserSummarizePreview: () => Promise<BrowserSummary>;
  onBrowserState: (
    callback: (state: NativeBrowserState) => void,
  ) => () => void;
}

/** Android 原生 WebView 浏览器桥接 */
interface BrowserBridgeApi {
  open(url: string, x: number, y: number, w: number, h: number): void;
  navigate(url: string): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  setBounds(x: number, y: number, w: number, h: number): void;
  summarize(callbackId: string): void;
  hide(): void;
  close(): void;
  openExternal(url: string): void;
}

/** 前端存储的 summarize Promise resolver */
interface BrowserSummaryCallback {
  resolve: (value: BrowserSummary) => void;
  reject: (reason: Error) => void;
}

interface Window {
  desktopShell?: DesktopShellApi;
  BrowserBridge?: BrowserBridgeApi;
  __browser_summary_callbacks?: Record<string, BrowserSummaryCallback>;
  __browser_summary_result?: (callbackId: string, summary: BrowserSummary) => void;
}