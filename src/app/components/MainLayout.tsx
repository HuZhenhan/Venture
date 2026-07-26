import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sidebar } from './Sidebar';
import { ChatArea } from './ChatArea';
import { ChatHeader } from './chat/ChatHeader';
import { SidebarToggleButton } from './SidebarToggleButton';
import { RightPanelRail } from './RightPanelRail';
import { BrowserPanel } from './BrowserPanel';
import { WorkflowCanvas } from './WorkflowCanvas';
import { DesktopPanels, SinglePagePanels } from './layout/MainLayoutPanels';
import { useChatStore } from '../store/useChatStore';
import { 
  selectResponsiveLayout, 
  selectIsSidebarOpen,
  selectIsSettingsOpen,
  selectIsUsageOpen,
  selectIsEditorOpen,
  selectIsBrowserOpen,
  selectIsBrowserSummaryOpen,
  selectActiveWorkspaceView,
  selectSetViewportWidth,
  selectSidebarWidth,
  selectSettingsWidth,
  selectSinglePageView,
  selectToggleSidebar,
  selectToggleBrowser,
  selectToggleBrowserSummary,
  selectToggleWorkflow,
  selectSyncPanelVisibility,
  selectShowChatPanel,
  selectTogglePanel,
  selectClosePanel,
  selectSetSettingsWidth,
  selectIsResizingSidebar,
  selectIsResizingEditor,
  selectShowTestButton,
  selectShowLayoutDebug,
  useLayoutStore 
} from '../store/useLayoutStore';
import { AMBIENT_BG, RIGHT_RAIL_WIDTH, APPLE_CURVE, DURATION, PANEL_TRANSITION } from '../constants';
import { resolveAdaptivePanelVisibility, resolveRailState } from '../utils/layoutPanels';

const TOGGLE_REST_X = 20;
const TOGGLE_OPEN_GAP = 44;
const TOGGLE_TOP = 10;

export function MainLayout() {
  const { apiConfigs, setApiConfigs } = useChatStore();

  const isSidebarOpen = useLayoutStore(selectIsSidebarOpen);
  const isSettingsOpen = useLayoutStore(selectIsSettingsOpen);
  const isUsageOpen = useLayoutStore(selectIsUsageOpen);
  const isEditorOpen = useLayoutStore(selectIsEditorOpen);
  const isBrowserOpen = useLayoutStore(selectIsBrowserOpen);
  const isBrowserSummaryOpen = useLayoutStore(selectIsBrowserSummaryOpen);
  const activeWorkspaceView = useLayoutStore(selectActiveWorkspaceView);
  const setViewportWidth = useLayoutStore(selectSetViewportWidth);
  const sidebarWidth = useLayoutStore(selectSidebarWidth);
  const settingsWidth = useLayoutStore(selectSettingsWidth);
  const setSettingsWidth = useLayoutStore(selectSetSettingsWidth);
  const singlePageView = useLayoutStore(selectSinglePageView);
  const toggleSidebar = useLayoutStore(selectToggleSidebar);
  const toggleBrowser = useLayoutStore(selectToggleBrowser);
  const toggleBrowserSummary = useLayoutStore(selectToggleBrowserSummary);
  const toggleWorkflow = useLayoutStore(selectToggleWorkflow);
  const syncPanelVisibility = useLayoutStore(selectSyncPanelVisibility);
  const showChatPanel = useLayoutStore(selectShowChatPanel);
  const togglePanel = useLayoutStore(selectTogglePanel);
  const closePanel = useLayoutStore(selectClosePanel);
  const isResizingSidebar = useLayoutStore(selectIsResizingSidebar);
  const isResizingEditor = useLayoutStore(selectIsResizingEditor);
  const responsiveWidths = useLayoutStore(selectResponsiveLayout);
  const showTestButton = useLayoutStore(selectShowTestButton);
  const showLayoutDebug = useLayoutStore(selectShowLayoutDebug);

  const handleResize = useCallback(() => {
    setViewportWidth(window.innerWidth);
  }, [setViewportWidth]);

  useEffect(() => {
    let rafId: number;
    const onResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(handleResize);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(rafId);
    };
  }, [handleResize]);

  const {
    compactRightPanels,
    singlePageMode,
    effectiveEditorOpen,
    shouldUseSidebarOverlay,
    chatCollapsed,
    browserWidth,
    settingsPanelWidth,
    browserParticipatesInLayout,
    settingsParticipatesInLayout,
    usageParticipatesInLayout,
    singlePageContentWidth,
  } = responsiveWidths;
  const visibleSidebarWidth = shouldUseSidebarOverlay ? sidebarWidth : responsiveWidths.sidebarWidth;
  const toggleButtonX = isSidebarOpen ? Math.max(TOGGLE_REST_X, visibleSidebarWidth - TOGGLE_OPEN_GAP) : TOGGLE_REST_X;
  const adaptiveVisibility = useMemo(() => resolveAdaptivePanelVisibility({
    activeWorkspaceView,
    isBrowserOpen,
    isEditorOpen,
    isSettingsOpen,
    isUsageOpen,
    browserParticipatesInLayout,
    settingsParticipatesInLayout,
    usageParticipatesInLayout,
    chatCollapsed,
    singlePageMode,
  }), [
    activeWorkspaceView,
    isBrowserOpen,
    isEditorOpen,
    isSettingsOpen,
    isUsageOpen,
    browserParticipatesInLayout,
    settingsParticipatesInLayout,
    usageParticipatesInLayout,
    chatCollapsed,
    singlePageMode,
  ]);

  const singlePagePanelShellClassName =
    'absolute inset-y-0 right-0 h-full bg-background';

  useEffect(() => {
    syncPanelVisibility();
  }, [compactRightPanels, isBrowserOpen, isEditorOpen, isSettingsOpen, isUsageOpen, singlePageMode, singlePageView, syncPanelVisibility]);

  const railState = resolveRailState({
    singlePageMode,
    singlePageView: adaptiveVisibility.singlePageView,
    activeWorkspaceView,
    isBrowserOpen,
    browserParticipatesInLayout,
    effectiveEditorOpen,
    isSettingsOpen,
    isUsageOpen,
  });
  const showDockedBrowser = !singlePageMode && adaptiveVisibility.showBrowser;
  const showDockedWorkflow = !singlePageMode && adaptiveVisibility.showWorkflow;

  const toggleSettings = useCallback(() => togglePanel('settings'), [togglePanel]);
  const toggleUsage = useCallback(() => togglePanel('usage'), [togglePanel]);
  const showChat = useCallback(() => showChatPanel(), [showChatPanel]);
  const handleToggleBrowser = useCallback(() => toggleBrowser(), [toggleBrowser]);
  const handleToggleBrowserSummary = useCallback(() => toggleBrowserSummary(), [toggleBrowserSummary]);
  const handleToggleWorkflow = useCallback(() => toggleWorkflow(), [toggleWorkflow]);

  // ── Lazy panel mounting ──────────────────────────────────────────────────────
  // Panels that have never been opened are NOT mounted in the DOM, saving initial
  // render cost. Once opened for the first time, they stay mounted (but hidden)
  // so subsequent opens are instant without re-initialisation.
  const settingsEverOpenedRef = useRef(isSettingsOpen);
  const usageEverOpenedRef = useRef(isUsageOpen);

  if (isSettingsOpen) settingsEverOpenedRef.current = true;
  if (isUsageOpen) usageEverOpenedRef.current = true;

  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground font-sans overflow-hidden selection:bg-black/10 antialiased relative">
      <div className="fixed inset-0 z-0 opacity-[0.08] pointer-events-none">
        <img src={AMBIENT_BG} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="relative flex-1 flex overflow-hidden">
        <motion.div
          initial={false}
          animate={{
            left: toggleButtonX,
            top: TOGGLE_TOP,
            opacity: 1,
          }}
          transition={{
            left: { type: "spring", stiffness: 360, damping: 34, mass: 0.82 },
            top: { duration: DURATION.fast, ease: APPLE_CURVE },
            opacity: { duration: DURATION.micro + 0.09 },
          }}
          className={`absolute z-50 ${__IS_ELECTRON__ ? 'no-drag' : ''}`}
        >
          <div className="flex items-center gap-2">
            <SidebarToggleButton isOpen={isSidebarOpen} onClick={toggleSidebar} />
            {showTestButton && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-all text-xs font-bold"
                onClick={() => console.log('%c[TestButton] 测试按钮被点击了！', 'color: #0f0; font-weight: bold; font-size: 14px')}
                aria-label="测试按钮"
              >
                T
              </motion.button>
            )}
          </div>
        </motion.div>

        <AnimatePresence initial={false}>
          {shouldUseSidebarOverlay && isSidebarOpen && (
            <motion.button
              type="button"
              aria-label="关闭侧边栏遮罩"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DURATION.fast, ease: APPLE_CURVE }}
              onClick={toggleSidebar}
              className={`absolute inset-0 z-40 bg-[rgba(28,28,30,0.16)] backdrop-blur-[2px] ${__IS_ELECTRON__ ? 'no-drag' : ''}`}
            />
          )}
        </AnimatePresence>

        <div
          className={`${shouldUseSidebarOverlay ? 'absolute inset-y-0 left-0 z-50' : 'relative flex flex-shrink-0 z-30'} ${shouldUseSidebarOverlay && !isSidebarOpen ? 'pointer-events-none' : 'pointer-events-auto'} ${__IS_ELECTRON__ ? 'no-drag' : ''}`}
        >
          <Sidebar />
        </div>

        <div className="flex-1 flex flex-col overflow-hidden relative">
          <div style={{ marginRight: RIGHT_RAIL_WIDTH }}>
            <ChatHeader />
          </div>
          <motion.div 
          className="flex-1 flex overflow-hidden relative transform-gpu will-change-transform"
          initial={false}
          style={{ marginRight: RIGHT_RAIL_WIDTH }}
          transition={{
            width: (isResizingSidebar || isResizingEditor) ? { duration: 0 } : PANEL_TRANSITION
          }}
        >
            {/* 无论大屏小屏，始终渲染 ChatArea */}
            <motion.main
              initial={false}
              animate={{
                width: adaptiveVisibility.showChat ? responsiveWidths.chatWidth : 0,
                opacity: adaptiveVisibility.showChat ? 1 : 0,
              }}
              transition={PANEL_TRANSITION}
              className={`shrink-0 flex flex-col relative min-w-0 bg-background z-10 overflow-hidden ${adaptiveVisibility.showChat ? '' : 'pointer-events-none'}`}
            >
              <ChatArea />
            </motion.main>

            {/* 浏览器面板：与对话区域同级平铺 */}
            <motion.div
              initial={false}
              animate={{ width: showDockedBrowser ? browserWidth : 0, opacity: showDockedBrowser ? 1 : 0 }}
              transition={PANEL_TRANSITION}
              className={`shrink-0 flex h-full overflow-hidden ${showDockedBrowser ? 'border-l border-border' : 'pointer-events-none'}`}
            >
              <BrowserPanel
                isOpen={isBrowserOpen}
                width={browserWidth}
                isNativeViewHidden={adaptiveVisibility.isBrowserNativeViewHidden || !showDockedBrowser}
              />
            </motion.div>

            {/* 工作流面板：与对话区域同级平铺 */}
            <motion.div
              initial={false}
              animate={{ width: showDockedWorkflow ? responsiveWidths.workflowWidth : 0, opacity: showDockedWorkflow ? 1 : 0 }}
              transition={PANEL_TRANSITION}
              className={`shrink-0 flex h-full overflow-hidden ${showDockedWorkflow ? 'border-l border-border' : 'pointer-events-none'}`}
            >
              <WorkflowCanvas />
            </motion.div>

            {/* 小屏幕下的遮罩层 (与左侧栏对齐的逻辑) */}
            <AnimatePresence>
              {singlePageMode && adaptiveVisibility.singlePageView !== 'chat' && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: DURATION.fast, ease: APPLE_CURVE }}
                  onClick={showChat}
                  className="absolute inset-0 z-40 bg-[rgba(28,28,30,0.16)] backdrop-blur-[2px]"
                />
              )}
            </AnimatePresence>

            {/* 小屏幕下的右侧弹出面板 (Overlay 模式) */}
            {singlePageMode ? (
              <SinglePagePanels
                singlePageView={adaptiveVisibility.singlePageView}
                singlePageContentWidth={singlePageContentWidth}
                shellClassName={singlePagePanelShellClassName}
                isBrowserOpen={railState.browserActive}
                isBrowserNativeViewHidden={adaptiveVisibility.isBrowserNativeViewHidden}
                apiConfigs={apiConfigs}
                onApiConfigsChange={setApiConfigs}
                onShowChat={showChat}
              />
            ) : null}

            {/* 大屏幕下的普通左右平铺模式 (Flex 模式)
                懒挂载：每个面板仅在首次打开后才渲染，避免初次加载时产生隐藏面板的开销 */}
            {!singlePageMode ? (
              <DesktopPanels
                settingsEverOpened={settingsEverOpenedRef.current}
                usageEverOpened={usageEverOpenedRef.current}
                isSettingsOpen={adaptiveVisibility.showSettings && settingsParticipatesInLayout}
                isUsageOpen={adaptiveVisibility.showUsage && usageParticipatesInLayout}
                settingsWidth={settingsPanelWidth || settingsWidth}
                isResizingSettings={false}
                apiConfigs={apiConfigs}
                onApiConfigsChange={setApiConfigs}
                onCloseSettings={() => closePanel('settings')}
                onCloseUsage={() => closePanel('usage')}
                onSettingsWidthChange={setSettingsWidth}
              />
            ) : null}
          </motion.div>

          <div
            className="absolute right-0 top-0 bottom-0 z-30 flex h-full shrink-0 border-l border-border bg-background"
            style={{ width: RIGHT_RAIL_WIDTH }}
          >
            <div className="sticky top-0 flex w-full pt-2">
              <RightPanelRail
                isChatActive={railState.chatActive}
                isSettingsOpen={railState.settingsActive}
                isUsageOpen={railState.usageActive}
                isBrowserOpen={isBrowserOpen}
                isBrowserActive={railState.browserActive}
                isBrowserSummaryOpen={isBrowserSummaryOpen}
                isWorkflowActive={railState.workflowActive}
                onShowChat={showChat}
                onToggleSettings={toggleSettings}
                onToggleUsage={toggleUsage}
                onToggleBrowser={handleToggleBrowser}
                onToggleBrowserSummary={handleToggleBrowserSummary}
                onToggleWorkflow={handleToggleWorkflow}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 布局调试信息面板 */}
      {showLayoutDebug && (
        <div className="fixed bottom-4 left-4 z-[9999] bg-black/85 text-green-400 text-[11px] font-mono rounded-lg p-3 max-w-[320px] space-y-1 border border-green-500/30 backdrop-blur-sm pointer-events-auto select-text">
          <div className="text-xs font-bold text-green-300 mb-1">Layout Debug</div>
          <div>viewport: <span className="text-white">{responsiveWidths.viewportWidth}</span></div>
          <div>sidebar: <span className="text-white">{isSidebarOpen ? 'open' : 'closed'}</span> ({sidebarWidth}px) {shouldUseSidebarOverlay ? '(overlay)' : '(inline)'}</div>
          <div>settings: <span className="text-white">{isSettingsOpen ? 'open' : 'closed'}</span> ({settingsWidth}px)</div>
          <div>editor: <span className="text-white">{isEditorOpen ? 'open' : 'closed'}</span></div>
          <div>browser: <span className="text-white">{isBrowserOpen ? 'open' : 'closed'}</span></div>
          <div>singlePage: <span className="text-white">{responsiveWidths.singlePageMode ? 'yes' : 'no'}</span></div>
          <div>chatCollapsed: <span className="text-white">{responsiveWidths.chatCollapsed ? 'yes' : 'no'}</span></div>
          <div>toggleBtn @ (<span className="text-white">{toggleButtonX}</span>, <span className="text-white">{TOGGLE_TOP}</span>)</div>
          <div className="text-[10px] text-green-500/70 mt-1">/debug layout false 关闭</div>
        </div>
      )}
    </div>
  );
}
