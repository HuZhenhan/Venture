import React, { useState, useRef, useCallback, useEffect } from 'react';
import { RotateCw, ChevronLeft, ChevronRight, Globe } from 'lucide-react';
import { DURATION } from '../constants';
import { BrowserSummaryPanel } from './BrowserSummaryPanel';
import { useLayoutStore, selectIsBrowserSummaryOpen, selectSetIsBrowserSummaryOpen } from '../store/useLayoutStore';
import { DEFAULT_BROWSER_PREFERENCES, type BrowserPreferences, usePreferencesStore } from '../store/usePreferencesStore';

const DEFAULT_URL = 'https://www.bing.com';
const NATIVE_BROWSER_RESTORE_DELAY_MS = Math.ceil(DURATION.panel * 1000) + 80;
const BOUNDS_SYNC_DEBOUNCE_MS = 80;

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
    aria-label={isRunning ? '正在摘取页面文本' : '页面文本摘取'}
    title={isRunning ? '正在摘取页面文本' : '页面文本摘取（非 AI 总结）'}
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
  const browserPreferences = usePreferencesStore((state) => state.browser);
  const setPreferences = usePreferencesStore((state) => state.setPreferences);
  const initialBrowserUrl = normalizeUrl(browserPreferences.currentUrl || DEFAULT_BROWSER_PREFERENCES.currentUrl);
  const [inputUrl, setInputUrl] = useState(initialBrowserUrl);
  const [currentUrl, setCurrentUrl] = useState(initialBrowserUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(browserPreferences.canGoBack);
  const [canGoForward, setCanGoForward] = useState(browserPreferences.canGoForward);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [isNativeViewReady, setIsNativeViewReady] = useState(false);
  const [isSummaryPreviewRunning, setIsSummaryPreviewRunning] = useState(false);
  const [summary, setSummary] = useState<BrowserSummary | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const syncAnimationFrameRef = useRef<number | null>(null);
  const syncDebounceTimeoutRef = useRef<number | null>(null);
  const nativeRestoreTimeoutRef = useRef<number | null>(null);
  const hasAppliedHydratedBrowserPreferencesRef = useRef(false);
  const isElectronBrowser = typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__ && !!window.desktopShell;
  const shouldPrepareNativeBrowser = isElectronBrowser && isOpen && !isNativeViewHidden;
  const shouldShowNativeBrowser = shouldPrepareNativeBrowser && isNativeViewReady;

  const isBrowserSummaryOpen = useLayoutStore(selectIsBrowserSummaryOpen);
  const setIsBrowserSummaryOpen = useLayoutStore(selectSetIsBrowserSummaryOpen);

  // 用 ref 跟踪文本摘取面板状态，避免改变 syncBounds 的依赖而触发 effect 重建。
  const isBrowserSummaryOpenRef = useRef(isBrowserSummaryOpen);
  isBrowserSummaryOpenRef.current = isBrowserSummaryOpen;

  const persistBrowserState = useCallback((state: Partial<BrowserPreferences>) => {
    const previous = usePreferencesStore.getState().browser;
    const next: BrowserPreferences = { ...previous, ...state };
    if (
      previous.currentUrl === next.currentUrl &&
      previous.canGoBack === next.canGoBack &&
      previous.canGoForward === next.canGoForward &&
      previous.lastOpenedAt === next.lastOpenedAt
    ) {
      return;
    }
    setPreferences({ browser: next });
  }, [setPreferences]);

  const syncBounds = useCallback(() => {
    if (!shouldShowNativeBrowser || !viewportRef.current) return;
    if (isBrowserSummaryOpenRef.current) return; // 文本摘取面板打开时不恢复原生视图 bounds
    window.desktopShell?.browserSetBounds(getElementBounds(viewportRef.current));
  }, [shouldShowNativeBrowser]);

  const clearScheduledBoundsSync = useCallback(() => {
    if (syncDebounceTimeoutRef.current !== null) {
      window.clearTimeout(syncDebounceTimeoutRef.current);
      syncDebounceTimeoutRef.current = null;
    }
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
    syncDebounceTimeoutRef.current = window.setTimeout(() => {
      syncDebounceTimeoutRef.current = null;
      syncAnimationFrameRef.current = window.requestAnimationFrame(() => {
        syncAnimationFrameRef.current = null;
        syncBounds();
      });
    }, BOUNDS_SYNC_DEBOUNCE_MS);
  }, [clearScheduledBoundsSync, syncBounds]);

  const navigate = useCallback((url: string) => {
    const target = normalizeUrl(url);
    setInputUrl(target);
    setCurrentUrl(target);
    setNativeError(null);
    setIsLoading(true);
    persistBrowserState({ currentUrl: target });

    if (!isElectronBrowser) {
      setIsLoading(false);
      setNativeError('Web 预览无法加载内置 BrowserView。请在 Electron 桌面端打开浏览器面板。');
      return;
    }

    window.desktopShell?.browserNavigate(target).catch((err) => {
      setNativeError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    });
  }, [isElectronBrowser, persistBrowserState]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') navigate(inputUrl);
    },
    [inputUrl, navigate]
  );

  const handleRefresh = useCallback(() => {
    if (!isElectronBrowser) return;
    setIsLoading(true);
    window.desktopShell?.browserReload();
  }, [isElectronBrowser]);

  const handleBack = useCallback(() => {
    if (isElectronBrowser) window.desktopShell?.browserBack();
  }, [isElectronBrowser]);

  const handleForward = useCallback(() => {
    if (isElectronBrowser) window.desktopShell?.browserForward();
  }, [isElectronBrowser]);

  const handleResetToDefaultPage = useCallback(() => {
    setInputUrl(DEFAULT_URL);
    setCurrentUrl(DEFAULT_URL);
    setCanGoBack(false);
    setCanGoForward(false);
    setNativeError(null);
    persistBrowserState({
      currentUrl: DEFAULT_URL,
      canGoBack: false,
      canGoForward: false,
    });
  }, [persistBrowserState]);

  const handleSummaryPreview = useCallback(async () => {
    if (!isElectronBrowser || !shouldShowNativeBrowser || isSummaryPreviewRunning) return;

    setNativeError(null);
    setIsSummaryPreviewRunning(true);
    try {
      const result = await window.desktopShell?.browserSummarizePreview();
      if (result) {
        setSummary(result);
        if (result.status === 'failed') {
          setNativeError(result.error || '页面文本摘取失败');
        } else {
          setIsBrowserSummaryOpen(true);
        }
      }
    } catch (err) {
      setNativeError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSummaryPreviewRunning(false);
    }
  }, [isElectronBrowser, isSummaryPreviewRunning, setIsBrowserSummaryOpen, shouldShowNativeBrowser]);

  const handleCloseSummary = useCallback(() => {
    setIsBrowserSummaryOpen(false);
  }, [setIsBrowserSummaryOpen]);

  useEffect(() => {
    if (hasAppliedHydratedBrowserPreferencesRef.current) return;
    const restoredUrl = normalizeUrl(browserPreferences.currentUrl || DEFAULT_URL);
    if (restoredUrl === currentUrl && browserPreferences.canGoBack === canGoBack && browserPreferences.canGoForward === canGoForward) {
      hasAppliedHydratedBrowserPreferencesRef.current = true;
      return;
    }
    if (currentUrl !== DEFAULT_URL && currentUrl !== initialBrowserUrl) return;

    setInputUrl(restoredUrl);
    setCurrentUrl(restoredUrl);
    setCanGoBack(browserPreferences.canGoBack);
    setCanGoForward(browserPreferences.canGoForward);
    hasAppliedHydratedBrowserPreferencesRef.current = true;
  }, [browserPreferences, canGoBack, canGoForward, currentUrl, initialBrowserUrl]);

  useEffect(() => {
    if (!isElectronBrowser) return;
    return window.desktopShell?.onBrowserState((state) => {
      const nextUrl = state.url || DEFAULT_URL;
      setInputUrl(nextUrl);
      setCurrentUrl(nextUrl);
      setCanGoBack(state.canGoBack);
      setCanGoForward(state.canGoForward);
      setIsLoading(state.isLoading);
      setNativeError(state.error ?? null);
      persistBrowserState({
        currentUrl: nextUrl,
        canGoBack: state.canGoBack,
        canGoForward: state.canGoForward,
      });
    });
  }, [isElectronBrowser, persistBrowserState]);

  useEffect(() => {
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
      persistBrowserState({ lastOpenedAt: Date.now() });
    }, NATIVE_BROWSER_RESTORE_DELAY_MS);

    return clearNativeRestoreTimer;
  }, [clearNativeRestoreTimer, persistBrowserState, shouldPrepareNativeBrowser]);

  useEffect(() => {
    if (!shouldShowNativeBrowser || !viewportRef.current) {
      window.desktopShell?.browserHide();
      return;
    }

    const openNativeBrowser = () => {
      const bounds = viewportRef.current ? getElementBounds(viewportRef.current) : undefined;
      if (!bounds) return;
      if (isBrowserSummaryOpenRef.current) return; // 文本摘取面板打开时不要显示原生视图
      window.desktopShell?.browserOpen({ url: currentUrl, bounds }).catch((err) => {
        setNativeError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });
    };

    openNativeBrowser();
    scheduleBoundsSync();
    const resizeObserver = new ResizeObserver(scheduleBoundsSync);
    resizeObserver.observe(viewportRef.current);
    window.addEventListener('resize', scheduleBoundsSync);

    return () => {
      clearScheduledBoundsSync();
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleBoundsSync);
      window.desktopShell?.browserHide();
    };
  }, [clearScheduledBoundsSync, currentUrl, scheduleBoundsSync, shouldShowNativeBrowser]);

  // 文本摘取面板打开时隐藏原生浏览器视图（HTML 覆盖层才能露出来），关闭时恢复 bounds。
  useEffect(() => {
    if (!shouldShowNativeBrowser) return;
    if (isBrowserSummaryOpen) {
      window.desktopShell?.browserHide();
    } else if (viewportRef.current) {
      scheduleBoundsSync();
    }
  }, [isBrowserSummaryOpen, scheduleBoundsSync, shouldShowNativeBrowser]);

  useEffect(() => {
    scheduleBoundsSync();
  }, [scheduleBoundsSync]);

  if (!isOpen) return null;

  return (
    <div className="flex h-full w-full flex-col bg-background overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          onClick={handleBack}
          aria-label="后退"
          disabled={!isElectronBrowser || !canGoBack}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          onClick={handleForward}
          aria-label="前进"
          disabled={!isElectronBrowser || !canGoForward}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
        >
          <ChevronRight size={15} />
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          aria-label="刷新"
          disabled={!isElectronBrowser}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          style={isLoading ? { animation: 'spin 0.8s linear infinite' } : undefined}
        >
          <RotateCw size={14} />
        </button>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="地址栏"
          className="h-7 flex-1 rounded-md border border-border bg-muted/30 px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
          spellCheck={false}
          autoComplete="off"
        />
        <BrowserSummaryButton
          isRunning={isSummaryPreviewRunning}
          disabled={!shouldShowNativeBrowser || isLoading || isSummaryPreviewRunning}
          onClick={handleSummaryPreview}
        />
      </div>

      <div ref={viewportRef} className="relative flex-1 overflow-hidden bg-white">
        {isLoading && (
          <div
            className="absolute left-0 top-0 z-10 h-0.5 bg-blue-500/70"
            style={{ animation: 'browser-progress 1.4s ease-in-out forwards' }}
          />
        )}
        {isElectronBrowser && shouldPrepareNativeBrowser && !isNativeViewReady && (
          <div className="flex h-full w-full items-center justify-center bg-background px-8 text-center">
            <div className="rounded-2xl border border-border bg-muted/20 px-5 py-4 text-xs font-medium text-muted-foreground shadow-sm">
              正在恢复浏览器...
            </div>
          </div>
        )}
        {!isElectronBrowser && (
          <div className="flex h-full w-full items-center justify-center bg-background px-8 text-center">
            <div className="max-w-[360px] rounded-2xl border border-border bg-muted/20 p-5 shadow-sm">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Globe size={18} />
              </div>
              <h3 className="mt-4 text-sm font-semibold text-foreground">内置浏览器需要 Electron 桌面端</h3>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                当前是 Web 环境，只能保留地址栏和状态；BrowserView 运行在 Electron 主进程中，无法在普通浏览器里创建。
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={handleResetToDefaultPage}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/50"
                >
                  回退默认页
                </button>
              </div>
            </div>
          </div>
        )}
        {nativeError && (
          <div className="absolute bottom-4 left-4 right-4 rounded-lg border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm">
            {nativeError}
          </div>
        )}
        {isBrowserSummaryOpen && (
          <div className="absolute inset-0 z-20 bg-background">
            {summary ? (
              <BrowserSummaryPanel summary={summary} onClose={handleCloseSummary} />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center">
                <div className="rounded-2xl border border-border bg-muted/20 px-5 py-4 text-xs font-medium text-muted-foreground shadow-sm">
                  暂无页面文本摘取内容，请点击地址栏右侧的摘取按钮获取
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
