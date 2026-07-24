import React, { useState, useRef, useCallback, useEffect } from 'react';
import { RotateCw, ChevronLeft, ChevronRight, Globe, ExternalLink } from 'lucide-react';
import { DURATION, RIGHT_RAIL_WIDTH } from '../constants';
import { BrowserSummaryPanel } from './BrowserSummaryPanel';
import { useLayoutStore, selectIsBrowserSummaryOpen, selectSetIsBrowserSummaryOpen, selectIsRightRailOpen } from '../store/useLayoutStore';

const DEFAULT_URL = 'https://www.bing.com';
const NATIVE_BROWSER_RESTORE_DELAY_MS = Math.ceil(DURATION.panel * 1000) + 80;

function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return DEFAULT_URL;
  if (/^https?:\/\//i.test(t)) return t;
  if (t.includes('.') && !t.includes(' ')) return 'https://' + t;
  return 'https://www.bing.com/search?q=' + encodeURIComponent(t);
}

function getElementBounds(element: HTMLElement): NativeBrowserBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    visible: rect.width > 0 && rect.height > 0,
  };
}

interface BrowserPanelProps {
  isOpen: boolean;
  width?: number;
  isNativeViewHidden?: boolean;
}

interface BrowserSummaryButtonProps {
  isRunning: boolean;
  disabled: boolean;
  onClick: () => void;
}

const BrowserSummaryButton: React.FC<BrowserSummaryButtonProps> = ({
  isRunning,
  disabled,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={isRunning ? '正在摘取核心信息' : '摘取网页核心信息'}
    title={isRunning ? '正在摘取核心信息' : '摘取网页核心信息'}
    disabled={disabled}
    className="group relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-all duration-300 hover:border-primary/20 hover:bg-primary/10 hover:text-primary disabled:pointer-events-none disabled:text-primary"
  >
    {isRunning && (
      <span className="absolute inset-0 rounded-md bg-primary/10 motion-safe:animate-pulse" />
    )}
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
      className="relative transition-transform duration-300 group-hover:scale-105"
    >
      <path d="M7 4.75h7.25A2.75 2.75 0 0 1 17 7.5v9A2.75 2.75 0 0 1 14.25 19.25H7A2.75 2.75 0 0 1 4.25 16.5v-9A2.75 2.75 0 0 1 7 4.75Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 9h5.5M8 12h4M8 15h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m17.9 3.9.42 1.08c.12.3.35.53.65.65l1.08.42-1.08.42c-.3.12-.53.35-.65.65l-.42 1.08-.42-1.08a1.14 1.14 0 0 0-.65-.65l-1.08-.42 1.08-.42c.3-.12.53-.35.65-.65l.42-1.08Z" fill="currentColor" />
    </svg>
  </button>
);

export const BrowserPanel: React.FC<BrowserPanelProps> = ({
  isOpen,
  isNativeViewHidden = false,
}) => {
  const [inputUrl, setInputUrl] = useState(DEFAULT_URL);
  const [currentUrl, setCurrentUrl] = useState(DEFAULT_URL);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [isNativeViewReady, setIsNativeViewReady] = useState(false);
  const [isSummaryPreviewRunning, setIsSummaryPreviewRunning] = useState(false);
  const [summary, setSummary] = useState<BrowserSummary | null>(null);
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const syncAnimationFrameRef = useRef<number | null>(null);
  const nativeRestoreTimeoutRef = useRef<number | null>(null);
  const callbackIdCounterRef = useRef(0);

  const isElectronBrowser = __IS_ELECTRON__ && !!window.desktopShell;
  const isAndroidBrowser = !__IS_ELECTRON__ && !!window.BrowserBridge;
  const hasNativeBrowser = isElectronBrowser || isAndroidBrowser;
  const shouldPrepareNativeBrowser = hasNativeBrowser && isOpen && !isNativeViewHidden;
  const shouldShowNativeBrowser = shouldPrepareNativeBrowser && isNativeViewReady;

  const isBrowserSummaryOpen = useLayoutStore(selectIsBrowserSummaryOpen);
  const setIsBrowserSummaryOpen = useLayoutStore(selectSetIsBrowserSummaryOpen);
  const isRightRailOpen = useLayoutStore(selectIsRightRailOpen);
  const viewportWidth = useLayoutStore((state) => state.viewportWidth);

  const isBrowserSummaryOpenRef = useRef(isBrowserSummaryOpen);
  isBrowserSummaryOpenRef.current = isBrowserSummaryOpen;

  // ── Android 端：设置摘要回调接收器 ──────────────────────────
  useEffect(() => {
    if (!isAndroidBrowser) return;

    // 初始化回调存储
    window.__browser_summary_callbacks = window.__browser_summary_callbacks || {};

    // Kotlin 完成提取后通过 evaluateJavascript 调用此函数
    window.__browser_summary_result = (callbackId: string, summary: BrowserSummary) => {
      const cb = window.__browser_summary_callbacks?.[callbackId];
      if (cb) {
        delete window.__browser_summary_callbacks![callbackId];
        cb.resolve(summary);
      }
    };

    return () => {
      delete window.__browser_summary_result;
    };
  }, [isAndroidBrowser]);

  // ── Android 端：监听原生浏览器状态变化 ──────────────────────
  useEffect(() => {
    if (!isAndroidBrowser) return;

    const handleState = (e: Event) => {
      const detail = (e as CustomEvent).detail as NativeBrowserState;
      setInputUrl(detail.url || DEFAULT_URL);
      setCurrentUrl(detail.url || DEFAULT_URL);
      setCanGoBack(detail.canGoBack);
      setCanGoForward(detail.canGoForward);
      setIsLoading(detail.isLoading);
      setNativeError(detail.error ?? null);
    };

    window.addEventListener('browser-state', handleState);
    return () => window.removeEventListener('browser-state', handleState);
  }, [isAndroidBrowser]);

  // ── Electron 端：监听原生浏览器状态 ─────────────────────────
  useEffect(() => {
    if (!isElectronBrowser) return;
    return window.desktopShell?.onBrowserState((state) => {
      setInputUrl(state.url || DEFAULT_URL);
      setCurrentUrl(state.url || DEFAULT_URL);
      setCanGoBack(state.canGoBack);
      setCanGoForward(state.canGoForward);
      setIsLoading(state.isLoading);
      setNativeError(state.error ?? null);
    });
  }, [isElectronBrowser]);

  // ── 同步原生浏览器 bounds ──────────────────────────────────
  const syncBounds = useCallback(() => {
    if (!shouldShowNativeBrowser || !viewportRef.current) return;
    if (isBrowserSummaryOpenRef.current) return;

    const rawBounds = getElementBounds(viewportRef.current);
    const reservedRight = isRightRailOpen ? RIGHT_RAIL_WIDTH : 0;
    const maxWidth = Math.max(viewportWidth - reservedRight - rawBounds.x, 0);
    const clampedBounds = {
      x: Math.max(0, rawBounds.x),
      y: Math.max(0, rawBounds.y),
      width: Math.min(Math.max(0, rawBounds.width), maxWidth),
      height: Math.max(0, rawBounds.height),
      visible: rawBounds.visible,
    };

    if (isElectronBrowser) {
      window.desktopShell?.browserSetBounds(clampedBounds);
    } else if (isAndroidBrowser) {
      const dpr = window.devicePixelRatio || 1;
      window.BrowserBridge?.setBounds(
        clampedBounds.x * dpr,
        clampedBounds.y * dpr,
        clampedBounds.width * dpr,
        clampedBounds.height * dpr,
      );
    }
  }, [shouldShowNativeBrowser, isElectronBrowser, isAndroidBrowser, isRightRailOpen, viewportWidth]);

  const clearScheduledBoundsSync = useCallback(() => {
    if (syncAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(syncAnimationFrameRef.current);
      syncAnimationFrameRef.current = null;
    }
  }, []);

  const clearNativeRestoreTimer = useCallback(() => {
    if (nativeRestoreTimeoutRef.current !== null) {
      window.clearTimeout(nativeRestoreTimeoutRef.current);
      nativeRestoreTimeoutRef.current = null;
    }
  }, []);

  const scheduleBoundsSync = useCallback(() => {
    clearScheduledBoundsSync();
    syncAnimationFrameRef.current = window.requestAnimationFrame(() => {
      syncAnimationFrameRef.current = null;
      syncBounds();
    });
  }, [clearScheduledBoundsSync, syncBounds]);

  // ── 导航 ───────────────────────────────────────────────────
  const navigate = useCallback((url: string) => {
    const target = normalizeUrl(url);
    setInputUrl(target);
    setCurrentUrl(target);
    setNativeError(null);
    setIsLoading(true);
    setIframeBlocked(false);

    if (isElectronBrowser) {
      window.desktopShell?.browserNavigate(target).catch((err) => {
        setNativeError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });
    } else if (isAndroidBrowser) {
      window.BrowserBridge?.navigate(target);
    } else {
      // Fallback: try iframe, or just update UI state
      setIsLoading(false);
    }
  }, [isElectronBrowser, isAndroidBrowser]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') navigate(inputUrl);
    },
    [inputUrl, navigate]
  );

  const handleRefresh = useCallback(() => {
    if (isElectronBrowser) {
      setIsLoading(true);
      window.desktopShell?.browserReload();
    } else if (isAndroidBrowser) {
      window.BrowserBridge?.reload();
    }
  }, [isElectronBrowser, isAndroidBrowser]);

  const handleBack = useCallback(() => {
    if (isElectronBrowser) window.desktopShell?.browserBack();
    else if (isAndroidBrowser) window.BrowserBridge?.goBack();
  }, [isElectronBrowser, isAndroidBrowser]);

  const handleForward = useCallback(() => {
    if (isElectronBrowser) window.desktopShell?.browserForward();
    else if (isAndroidBrowser) window.BrowserBridge?.goForward();
  }, [isElectronBrowser, isAndroidBrowser]);

  // ── 页面摘要提取 ───────────────────────────────────────────
  const handleSummaryPreview = useCallback(async () => {
    if (!hasNativeBrowser || !shouldShowNativeBrowser || isSummaryPreviewRunning) return;

    setNativeError(null);
    setIsSummaryPreviewRunning(true);

    try {
      if (isElectronBrowser) {
        const result = await window.desktopShell?.browserSummarizePreview();
        if (result) processSummaryResult(result);
      } else if (isAndroidBrowser) {
        const callbackId = 'sum-' + (++callbackIdCounterRef.current).toString(36) + '-' + Date.now().toString(36);
        const promise = new Promise<BrowserSummary>((resolve, reject) => {
          window.__browser_summary_callbacks![callbackId] = { resolve, reject };
          // 超时 30s
          setTimeout(() => {
            const cb = window.__browser_summary_callbacks?.[callbackId];
            if (cb) {
              delete window.__browser_summary_callbacks![callbackId];
              cb.reject(new Error('摘取超时'));
            }
          }, 30000);
        });
        window.BrowserBridge?.summarize(callbackId);
        const result = await promise;
        processSummaryResult(result);
      }
    } catch (err) {
      setNativeError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSummaryPreviewRunning(false);
    }
  }, [hasNativeBrowser, isSummaryPreviewRunning, setIsBrowserSummaryOpen, shouldShowNativeBrowser, isElectronBrowser, isAndroidBrowser]);

  const processSummaryResult = useCallback((result: BrowserSummary) => {
    setSummary(result);
    if (result.status === 'failed') {
      setNativeError(result.error || '摘取失败');
    } else {
      setIsBrowserSummaryOpen(true);
    }
  }, [setIsBrowserSummaryOpen]);

  const handleCloseSummary = useCallback(() => {
    setIsBrowserSummaryOpen(false);
  }, [setIsBrowserSummaryOpen]);

  // ── 打开外部浏览器 ─────────────────────────────────────────
  const handleOpenExternal = useCallback(() => {
    if (isAndroidBrowser) {
      window.BrowserBridge?.openExternal(currentUrl);
    } else {
      window.open(currentUrl, '_blank', 'noopener,noreferrer');
    }
  }, [isAndroidBrowser, currentUrl]);

  // ── 原生视图生命周期：Electron ─────────────────────────────
  useEffect(() => {
    if (!isElectronBrowser) return;
    clearNativeRestoreTimer();

    if (!shouldPrepareNativeBrowser) {
      setIsNativeViewReady(false);
      window.desktopShell?.browserHide();
      return;
    }

    setIsNativeViewReady(false);
    nativeRestoreTimeoutRef.current = window.setTimeout(() => {
      nativeRestoreTimeoutRef.current = null;
      setIsNativeViewReady(true);
    }, NATIVE_BROWSER_RESTORE_DELAY_MS);

    return clearNativeRestoreTimer;
  }, [clearNativeRestoreTimer, isElectronBrowser, shouldPrepareNativeBrowser]);

  // ── 原生视图生命周期：Android ──────────────────────────────
  useEffect(() => {
    if (!isAndroidBrowser) return;

    if (!shouldPrepareNativeBrowser) {
      setIsNativeViewReady(false);
      window.BrowserBridge?.hide();
      return;
    }

    setIsNativeViewReady(true);
    return () => {
      window.BrowserBridge?.hide();
    };
  }, [isAndroidBrowser, shouldPrepareNativeBrowser]);

  // ── 保险：isOpen 或 isNativeViewHidden 变为 false 时强制隐藏 ──
  useEffect(() => {
    if (!isAndroidBrowser) return;
    if (!isOpen || isNativeViewHidden) {
      window.BrowserBridge?.hide();
    }
  }, [isAndroidBrowser, isOpen, isNativeViewHidden]);

  // ── 页面切后台 / 锁屏时隐藏浏览器 ──────────────────────────
  useEffect(() => {
    if (!isAndroidBrowser) return;
    const handleVisibility = () => {
      if (document.hidden) window.BrowserBridge?.hide();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isAndroidBrowser]);

  // ── 打开原生视图 ───────────────────────────────────────────
  useEffect(() => {
    if (!shouldShowNativeBrowser || !viewportRef.current) {
      if (!hasNativeBrowser) return;
      if (isElectronBrowser) window.desktopShell?.browserHide();
      else if (isAndroidBrowser) window.BrowserBridge?.hide();
      return;
    }

    if (isElectronBrowser) {
      const openNativeBrowser = () => {
        const bounds = viewportRef.current ? getElementBounds(viewportRef.current) : undefined;
        if (!bounds) return;
        if (isBrowserSummaryOpenRef.current) return;
        window.desktopShell?.browserOpen({ url: currentUrl, bounds }).catch((err) => {
          setNativeError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        });
      };
      openNativeBrowser();
    } else if (isAndroidBrowser && viewportRef.current) {
      const bounds = getElementBounds(viewportRef.current);
      const dpr = window.devicePixelRatio || 1;
      window.BrowserBridge?.open(
        currentUrl,
        bounds.x * dpr,
        bounds.y * dpr,
        bounds.width * dpr,
        bounds.height * dpr,
      );
    }

    scheduleBoundsSync();
    const resizeObserver = new ResizeObserver(syncBounds);
    resizeObserver.observe(viewportRef.current);
    window.addEventListener('resize', syncBounds);

    return () => {
      clearScheduledBoundsSync();
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncBounds);
      if (isElectronBrowser) window.desktopShell?.browserHide();
      else if (isAndroidBrowser) window.BrowserBridge?.hide();
    };
  }, [clearScheduledBoundsSync, currentUrl, hasNativeBrowser, isAndroidBrowser, isElectronBrowser, scheduleBoundsSync, shouldShowNativeBrowser, syncBounds]);

  // ── 摘要面板：隐藏/恢复原生视图 ────────────────────────────
  useEffect(() => {
    if (!shouldShowNativeBrowser) return;
    if (isBrowserSummaryOpen) {
      if (isElectronBrowser) window.desktopShell?.browserHide();
      else if (isAndroidBrowser) window.BrowserBridge?.hide();
    } else if (viewportRef.current) {
      syncBounds();
    }
  }, [isBrowserSummaryOpen, isAndroidBrowser, isElectronBrowser, shouldShowNativeBrowser, syncBounds]);

  // ── 右栏切换后，等动画完成再同步原生浏览器边界 ──────────
  // 右侧栏展开/收起有 550ms 动画，期间 DOM 尺寸在变化；
  // ResizeObserver 会逐步触发，但保险起见在动画结束后再同步一次。
  useEffect(() => {
    const delay = Math.ceil(DURATION.panel * 1000) + 100;
    const timer = setTimeout(syncBounds, delay);
    return () => clearTimeout(timer);
  }, [isRightRailOpen, syncBounds]);

  // ── iframe 加载检测 ─────────────────────────────────────────
  const handleIframeError = useCallback(() => {
    setIframeBlocked(true);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="flex h-full w-full flex-col bg-background overflow-hidden">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border pl-0 pr-2 py-1.5">
        <div className="flex items-center gap-0 shrink-0">
          <button
            type="button"
            onClick={handleBack}
            aria-label="后退"
            disabled={!hasNativeBrowser || !canGoBack}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={handleForward}
            aria-label="前进"
            disabled={!hasNativeBrowser || !canGoForward}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            aria-label="刷新"
            disabled={!hasNativeBrowser}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            style={isLoading ? { animation: 'spin 0.8s linear infinite' } : undefined}
          >
            <RotateCw size={14} />
          </button>
        </div>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="地址栏"
          className="h-7 flex-1 min-w-0 rounded-md border border-border bg-muted/30 px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-colors truncate"
          spellCheck={false}
          autoComplete="off"
        />
        <BrowserSummaryButton
          isRunning={isSummaryPreviewRunning}
          disabled={!shouldShowNativeBrowser || isLoading || isSummaryPreviewRunning}
          onClick={handleSummaryPreview}
        />
        {iframeBlocked && (
          <button
            type="button"
            onClick={handleOpenExternal}
            aria-label="在系统浏览器打开"
            title="在系统浏览器打开"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      {/* 视图区域 */}
      <div ref={viewportRef} className="relative flex-1 overflow-hidden bg-white">
        {isLoading && (
          <div
            className="absolute left-0 top-0 z-10 h-0.5 bg-blue-500/70"
            style={{ animation: 'browser-progress 1.4s ease-in-out forwards' }}
          />
        )}

        {/* Electron: 原生浏览器恢复中 */}
        {isElectronBrowser && shouldPrepareNativeBrowser && !isNativeViewReady && (
          <div className="flex h-full w-full items-center justify-center bg-background px-8 text-center">
            <div className="rounded-2xl border border-border bg-muted/20 px-5 py-4 text-xs font-medium text-muted-foreground shadow-sm">
              正在恢复浏览器...
            </div>
          </div>
        )}

        {/* 无原生浏览器时，使用 iframe 或显示提示 */}
        {!hasNativeBrowser && !isLoading && (
          <iframe
            src={currentUrl}
            className="h-full w-full border-0"
            title="网页浏览"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onError={handleIframeError}
          />
        )}

        {(nativeError || iframeBlocked) && (
          <div className="absolute bottom-4 left-4 right-4 rounded-lg border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm flex items-center gap-2">
            <span className="flex-1 truncate">{nativeError || '页面无法在内置浏览器中加载'}</span>
            <button
              type="button"
              onClick={handleOpenExternal}
              className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20 transition-colors"
            >
              外部浏览器打开
            </button>
          </div>
        )}

        {/* 摘要面板 */}
        {isBrowserSummaryOpen && (
          <div className="absolute inset-0 z-20 bg-background">
            {summary ? (
              <BrowserSummaryPanel summary={summary} onClose={handleCloseSummary} />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center">
                <div className="rounded-2xl border border-border bg-muted/20 px-5 py-4 text-xs font-medium text-muted-foreground shadow-sm">
                  暂无摘取内容，请点击地址栏右侧的摘取按钮获取
                </div>
                <button
                  type="button"
                  onClick={handleCloseSummary}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/50"
                >
                  关闭
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes browser-progress {
          0%   { width: 0%;   opacity: 1; }
          80%  { width: 85%;  opacity: 1; }
          100% { width: 100%; opacity: 0; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
