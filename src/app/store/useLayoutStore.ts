import { create } from 'zustand';
import { CodeReference } from '../types';
import {
  SMALL_SCREEN_SIDEBAR_BREAKPOINT,
  MIN_CHAT_WIDTH,
  COLLAPSED_CHAT_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_EDITOR_WIDTH,
  MAX_EDITOR_WIDTH,
  BROWSER_PANEL_WIDTH,
  MIN_BROWSER_WIDTH,
  MIN_SETTINGS_WIDTH,
  RIGHT_RAIL_WIDTH,
  CHAT_EDITOR_GUTTER,
} from '../constants';
import {
  resolveActiveWorkspaceView,
  resolveClosePanelState,
  resolveDesktopPanelState,
  resolveOpenDiffState,
  resolveShowChatState,
  resolveShowPanelState,
  resolveSinglePageSyncState,
  resolveTogglePanelState,
  SinglePagePanelView,
  ToggleablePanel,
  WorkspaceView,
} from '../utils/layoutPanels';

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function shrinkPanel(current: number, min: number, deficit: number) {
  if (deficit <= 0 || current <= min) {
    return { next: current, remaining: deficit };
  }
  const reduction = Math.min(current - min, deficit);
  return {
    next: current - reduction,
    remaining: deficit - reduction,
  };
}

function panelWidthForAvailable(target: number, min: number, available: number) {
  if (available < min) {
    return 0;
  }

  return clamp(Math.min(target, available), min, target);
}

const initialViewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
const initialSidebarOpen = initialViewportWidth >= SMALL_SCREEN_SIDEBAR_BREAKPOINT;

export type SinglePageView = SinglePagePanelView;

export interface ResponsiveLayout {
  sidebarWidth: number;
  editorWidth: number;
  chatWidth: number;
  chatCollapsed: boolean;
  browserWidth: number;
  settingsPanelWidth: number;
  sidebarUsesOverlay: boolean;
  shouldUseSidebarOverlay: boolean;
  compactRightPanels: boolean;
  singlePageMode: boolean;
  effectiveEditorOpen: boolean;
  browserParticipatesInLayout: boolean;
  workflowParticipatesInLayout: boolean;
  settingsParticipatesInLayout: boolean;
  usageParticipatesInLayout: boolean;
  singlePageContentWidth: number;
  workflowWidth: number;
}

function areResponsiveLayoutsEqual(a: ResponsiveLayout, b: ResponsiveLayout) {
  return (
    a.sidebarWidth === b.sidebarWidth &&
    a.editorWidth === b.editorWidth &&
    a.chatWidth === b.chatWidth &&
    a.chatCollapsed === b.chatCollapsed &&
    a.browserWidth === b.browserWidth &&
    a.settingsPanelWidth === b.settingsPanelWidth &&
    a.sidebarUsesOverlay === b.sidebarUsesOverlay &&
    a.shouldUseSidebarOverlay === b.shouldUseSidebarOverlay &&
    a.compactRightPanels === b.compactRightPanels &&
    a.singlePageMode === b.singlePageMode &&
    a.effectiveEditorOpen === b.effectiveEditorOpen &&
    a.browserParticipatesInLayout === b.browserParticipatesInLayout &&
    a.workflowParticipatesInLayout === b.workflowParticipatesInLayout &&
    a.settingsParticipatesInLayout === b.settingsParticipatesInLayout &&
    a.usageParticipatesInLayout === b.usageParticipatesInLayout &&
    a.singlePageContentWidth === b.singlePageContentWidth &&
    a.workflowWidth === b.workflowWidth
  );
}

interface LayoutComputationState {
  viewportWidth: number;
  isSidebarOpen: boolean;
  sidebarWidth: number;
  activeWorkspaceView: WorkspaceView;
  isBrowserOpen: boolean;
  isEditorOpen: boolean;
  editorWidth: number | null;
  isSettingsOpen: boolean;
  settingsWidth: number;
  isUsageOpen: boolean;
  isResizingEditor: boolean;
  isResizingSidebar: boolean;
}

function hasPanelVisibilityChanged(
  state: Pick<LayoutState, 'singlePageView' | 'activeWorkspaceView' | 'isEditorOpen' | 'isSettingsOpen' | 'isUsageOpen'>,
  nextState: Pick<LayoutState, 'singlePageView' | 'activeWorkspaceView' | 'isEditorOpen' | 'isSettingsOpen' | 'isUsageOpen'>
) {
  return (
    state.singlePageView !== nextState.singlePageView ||
    state.activeWorkspaceView !== nextState.activeWorkspaceView ||
    state.isEditorOpen !== nextState.isEditorOpen ||
    state.isSettingsOpen !== nextState.isSettingsOpen ||
    state.isUsageOpen !== nextState.isUsageOpen
  );
}

function deriveResponsiveLayout(state: LayoutComputationState): ResponsiveLayout {
  const reservedRightWidth = RIGHT_RAIL_WIDTH;
  const shouldForceSidebarOverlay = state.viewportWidth < SMALL_SCREEN_SIDEBAR_BREAKPOINT;
  const sidebarParticipatesInLayout = state.isSidebarOpen && !shouldForceSidebarOverlay;
  const minimumRightPanelWidth = MIN_EDITOR_WIDTH;
  const compactRightPanels = state.viewportWidth < MIN_CHAT_WIDTH + MIN_EDITOR_WIDTH + RIGHT_RAIL_WIDTH + (sidebarParticipatesInLayout ? MIN_SIDEBAR_WIDTH : 0);
  const singlePageMode = state.viewportWidth < MIN_CHAT_WIDTH + minimumRightPanelWidth + RIGHT_RAIL_WIDTH + (sidebarParticipatesInLayout ? MIN_SIDEBAR_WIDTH : 0);
  const effectiveEditorOpen = state.isEditorOpen && !state.isSettingsOpen && !state.isUsageOpen;
  const usableViewportWidth = Math.max(state.viewportWidth - reservedRightWidth, state.viewportWidth * 0.2);
  const browserParticipatesInLayout = !singlePageMode && state.isBrowserOpen && state.activeWorkspaceView === 'browser';
  const workflowParticipatesInLayout = !singlePageMode && state.activeWorkspaceView === 'workflow';
  const settingsParticipatesInLayout = !singlePageMode && state.isSettingsOpen && state.activeWorkspaceView === 'settings';
  const usageParticipatesInLayout = !singlePageMode && state.isUsageOpen && state.activeWorkspaceView === 'usage';
  const availableBesideSidebar = Math.max(
    usableViewportWidth - (sidebarParticipatesInLayout ? state.sidebarWidth : 0),
    0
  );
  const browserWidth = browserParticipatesInLayout
    ? panelWidthForAvailable(BROWSER_PANEL_WIDTH, MIN_BROWSER_WIDTH, availableBesideSidebar - 320)
    : 0;
  const workflowWidth = workflowParticipatesInLayout
    ? panelWidthForAvailable(BROWSER_PANEL_WIDTH, MIN_BROWSER_WIDTH, availableBesideSidebar - 320)
    : 0;
  const settingsPanelWidth = settingsParticipatesInLayout || usageParticipatesInLayout
    ? panelWidthForAvailable(
        state.settingsWidth,
        MIN_SETTINGS_WIDTH,
        availableBesideSidebar - 320
      )
    : 0;
  const activeExtraPanelWidth = browserWidth + workflowWidth
    + (settingsParticipatesInLayout ? settingsPanelWidth : 0)
    + (usageParticipatesInLayout ? settingsPanelWidth : 0);
  const availableForCore = usableViewportWidth - activeExtraPanelWidth;
  const minimumChatWidth = 320;

  let resSidebarWidth = sidebarParticipatesInLayout ? state.sidebarWidth : 0;
  const savedSidebarWidth = (!state.isSidebarOpen && !shouldForceSidebarOverlay) ? state.sidebarWidth : 0;
  let resEditorWidth = effectiveEditorOpen
    ? (state.editorWidth !== null
        ? clamp(state.editorWidth + savedSidebarWidth, MIN_EDITOR_WIDTH, MAX_EDITOR_WIDTH)
        : clamp(availableForCore - resSidebarWidth - CHAT_EDITOR_GUTTER, MIN_EDITOR_WIDTH, MAX_EDITOR_WIDTH))
    : 0;
  let sidebarUsesOverlay = false;
  let deficit = resSidebarWidth + resEditorWidth + minimumChatWidth - availableForCore;
  const shrinkOrder: Array<{ id: 'sidebar' | 'editor'; min: number }> = [];

  if (state.isResizingSidebar) shrinkOrder.push({ id: 'sidebar', min: sidebarParticipatesInLayout ? MIN_SIDEBAR_WIDTH : 0 });
  if (state.isResizingEditor) shrinkOrder.push({ id: 'editor', min: effectiveEditorOpen ? MIN_EDITOR_WIDTH : 0 });
  if (!state.isResizingSidebar) shrinkOrder.push({ id: 'sidebar', min: sidebarParticipatesInLayout ? MIN_SIDEBAR_WIDTH : 0 });
  if (!state.isResizingEditor) shrinkOrder.push({ id: 'editor', min: effectiveEditorOpen ? MIN_EDITOR_WIDTH : 0 });

  for (const panel of shrinkOrder) {
    if (deficit <= 0) {
      break;
    }

    if (panel.id === 'sidebar') {
      ({ next: resSidebarWidth, remaining: deficit } = shrinkPanel(resSidebarWidth, panel.min, deficit));
      continue;
    }

    ({ next: resEditorWidth, remaining: deficit } = shrinkPanel(resEditorWidth, panel.min, deficit));
  }

  if (deficit > 0 && sidebarParticipatesInLayout) {
    deficit -= resSidebarWidth;
    resSidebarWidth = 0;
    sidebarUsesOverlay = true;
  }

  return {
    sidebarWidth: resSidebarWidth,
    editorWidth: resEditorWidth,
    chatWidth: singlePageMode && state.activeWorkspaceView !== 'chat'
      ? COLLAPSED_CHAT_WIDTH
      : Math.max(availableForCore - resSidebarWidth - resEditorWidth, availableForCore * 0.2),
    chatCollapsed: singlePageMode && state.activeWorkspaceView !== 'chat',
    browserWidth,
    settingsPanelWidth,
    sidebarUsesOverlay,
    shouldUseSidebarOverlay: shouldForceSidebarOverlay || sidebarUsesOverlay,
    compactRightPanels,
    singlePageMode,
    effectiveEditorOpen,
    browserParticipatesInLayout,
    workflowParticipatesInLayout,
    settingsParticipatesInLayout,
    usageParticipatesInLayout,
    singlePageContentWidth: Math.max(usableViewportWidth, 0),
    workflowWidth,
  };
}

export function selectResponsiveLayout(state: LayoutComputationState): ResponsiveLayout {
  const nextLayout = deriveResponsiveLayout(state);

  const cached = layoutCache.value;
  if (cached && areResponsiveLayoutsEqual(cached, nextLayout)) {
    return cached;
  }

  layoutCache.value = nextLayout;
  return nextLayout;
}

export const selectIsSidebarOpen = (state: LayoutState) => state.isSidebarOpen;
export const selectIsSettingsOpen = (state: LayoutState) => state.isSettingsOpen;
export const selectActiveSettingsTab = (state: LayoutState) => state.activeSettingsTab;
export const selectSetActiveSettingsTab = (state: LayoutState) => state.setActiveSettingsTab;
export const selectIsUsageOpen = (state: LayoutState) => state.isUsageOpen;
export const selectIsEditorOpen = (state: LayoutState) => state.isEditorOpen;
export const selectIsBrowserOpen = (state: LayoutState) => state.isBrowserOpen;
export const selectIsBrowserSummaryOpen = (state: LayoutState) => state.isBrowserSummaryOpen;
export const selectSetIsBrowserSummaryOpen = (state: LayoutState) => state.setIsBrowserSummaryOpen;
export const selectActiveWorkspaceView = (state: LayoutState) => state.activeWorkspaceView;
export const selectViewportWidth = (state: LayoutState) => state.viewportWidth;
export const selectSidebarWidth = (state: LayoutState) => state.sidebarWidth;
export const selectSettingsWidth = (state: LayoutState) => state.settingsWidth;
export const selectActiveDiffId = (state: LayoutState) => state.activeDiffId;
export const selectSinglePageView = (state: LayoutState) => state.singlePageView;
export const selectIsResizingSidebar = (state: LayoutState) => state.isResizingSidebar;
export const selectIsResizingEditor = (state: LayoutState) => state.isResizingEditor;
export const selectSetViewportWidth = (state: LayoutState) => state.setViewportWidth;
export const selectToggleSidebar = (state: LayoutState) => state.toggleSidebar;
export const selectToggleBrowser = (state: LayoutState) => state.toggleBrowser;
export const selectToggleBrowserSummary = (state: LayoutState) => state.toggleBrowserSummary;
export const selectToggleWorkflow = (state: LayoutState) => state.toggleWorkflow;
export const selectSyncPanelVisibility = (state: LayoutState) => state.syncPanelVisibility;
export const selectShowChatPanel = (state: LayoutState) => state.showChatPanel;
export const selectTogglePanel = (state: LayoutState) => state.togglePanel;
export const selectClosePanel = (state: LayoutState) => state.closePanel;
export const selectOpenDiff = (state: LayoutState) => state.openDiff;
export const selectSetSettingsWidth = (state: LayoutState) => state.setSettingsWidth;
export const selectShowTestButton = (state: LayoutState) => state.showTestButton;
export const selectShowLayoutDebug = (state: LayoutState) => state.showLayoutDebug;
export const selectSetShowTestButton = (state: LayoutState) => state.setShowTestButton;
export const selectSetShowLayoutDebug = (state: LayoutState) => state.setShowLayoutDebug;

const layoutCache: { value: ResponsiveLayout | null } = { value: null };

export type SettingsTab = 'basic' | 'api' | 'migration';

interface LayoutState {
  showFpsOverlay: boolean;
  showOriginalContentDebug: boolean;
  showRawResponseDebug: boolean;
  showTestButton: boolean;
  showLayoutDebug: boolean;
  isSidebarOpen: boolean;
  isSettingsOpen: boolean;
  activeSettingsTab: SettingsTab;
  isUsageOpen: boolean;
  isEditorOpen: boolean;
  isBrowserOpen: boolean;
  isBrowserSummaryOpen: boolean;
  activeWorkspaceView: WorkspaceView;
  viewportWidth: number;
  sidebarWidth: number;
  settingsWidth: number;
  editorWidth: number | null;
  isResizingSidebar: boolean;
  isResizingEditor: boolean;
  activeDiffId: string | null;
  activeCodeReference: CodeReference | null;
  codeReferenceRevealToken: number;
  singlePageView: SinglePageView;

  // Actions
  setIsSidebarOpen: (open: boolean) => void;
  setIsSettingsOpen: (open: boolean) => void;
  setActiveSettingsTab: (tab: SettingsTab) => void;
  setIsUsageOpen: (open: boolean) => void;
  setIsEditorOpen: (open: boolean) => void;
  setIsBrowserOpen: (open: boolean) => void;
  setIsBrowserSummaryOpen: (open: boolean) => void;
  setViewportWidth: (width: number) => void;
  setSidebarWidth: (width: number) => void;
  setSettingsWidth: (width: number) => void;
  setEditorWidth: (width: number | null) => void;
  setIsResizingSidebar: (isResizing: boolean) => void;
  setIsResizingEditor: (isResizing: boolean) => void;
  setActiveDiffId: (id: string | null) => void;
  setActiveCodeReference: (reference: CodeReference | null) => void;
  setSinglePageView: (view: SinglePageView) => void;
  toggleSidebar: () => void;
  toggleBrowser: () => void;
  toggleBrowserSummary: () => void;
  toggleWorkflow: () => void;
  clearActiveDiff: () => void;
  syncPanelVisibility: () => void;
  showChatPanel: () => void;
  showPanel: (panel: ToggleablePanel, fallbackDiffId?: string) => void;
  togglePanel: (panel: ToggleablePanel, fallbackDiffId?: string) => void;
  closePanel: (panel: ToggleablePanel) => void;
  openDiff: (id: string) => void;
  openCodeReference: (reference: CodeReference) => void;
  commitWidths: () => void;

  // Derived values & logic
  toggleFpsOverlay: () => void;
  setOccupancyMonitorDebug: (enabled: boolean) => void;
  setOriginalContentDebug: (enabled: boolean) => void;
  setRawResponseDebug: (enabled: boolean) => void;
  setShowTestButton: (enabled: boolean) => void;
  setShowLayoutDebug: (enabled: boolean) => void;
  getResponsiveWidths: () => ResponsiveLayout;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  isSidebarOpen: initialSidebarOpen,
  isSettingsOpen: false,
  activeSettingsTab: 'basic',
  isUsageOpen: false,
  isEditorOpen: false,
  isBrowserOpen: false,
  isBrowserSummaryOpen: false,
  activeWorkspaceView: 'chat',
  viewportWidth: initialViewportWidth,
  sidebarWidth: 280,
  settingsWidth: 400,
  editorWidth: null,
  isResizingSidebar: false,
  isResizingEditor: false,
  activeDiffId: null,
  activeCodeReference: null,
  codeReferenceRevealToken: 0,
  singlePageView: 'chat',

  showFpsOverlay: false,
  showOriginalContentDebug: false,
  showRawResponseDebug: false,
  showTestButton: false,
  showLayoutDebug: false,

  setIsSidebarOpen: (open) => set((state) => {
    if (!open) return { isSidebarOpen: false };
    // 打开时若宽度被异常清零，重置为最小宽度，保证侧边栏可展开
    const sidebarWidth = state.sidebarWidth < MIN_SIDEBAR_WIDTH ? MIN_SIDEBAR_WIDTH : state.sidebarWidth;
    return { isSidebarOpen: true, sidebarWidth };
  }),
  setIsSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setActiveSettingsTab: (tab) => set({ activeSettingsTab: tab }),
  setIsUsageOpen: (open) => set({ isUsageOpen: open }),
  setIsEditorOpen: (open) => set({ isEditorOpen: open }),
  setIsBrowserOpen: (open) => set({ isBrowserOpen: open }),
  setIsBrowserSummaryOpen: (open) => set({ isBrowserSummaryOpen: open }),
  setViewportWidth: (width) => set({ viewportWidth: width }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setSettingsWidth: (width) => set({ settingsWidth: width }),
  setSinglePageView: (view) => set({ singlePageView: view }),
  toggleSidebar: () => set((state) => {
    const nextOpen = !state.isSidebarOpen;
    // 打开时若宽度被异常清零，重置为最小宽度，保证侧边栏可展开
    const sidebarWidth = nextOpen && state.sidebarWidth < MIN_SIDEBAR_WIDTH ? MIN_SIDEBAR_WIDTH : state.sidebarWidth;
    return { isSidebarOpen: nextOpen, sidebarWidth };
  }),
  toggleBrowser: () => set((state) => {
    const isBrowserOpen = !state.isBrowserOpen;
    const activeWorkspaceView = isBrowserOpen
      ? 'browser'
      : resolveActiveWorkspaceView({
          ...state,
          isBrowserOpen,
          preferredView: state.activeWorkspaceView,
        });

    return {
      isBrowserOpen,
      activeWorkspaceView,
      singlePageView: isBrowserOpen ? 'browser' : activeWorkspaceView,
    };
  }),
  toggleBrowserSummary: () => set((state) => ({ isBrowserSummaryOpen: !state.isBrowserSummaryOpen })),
  toggleWorkflow: () => set((state) => {
    const nextView: WorkspaceView = state.activeWorkspaceView === 'workflow' ? 'chat' : 'workflow';
    return {
      activeWorkspaceView: nextView,
      singlePageView: nextView,
      isEditorOpen: false,
      isSettingsOpen: false,
      isUsageOpen: false,
    };
  }),
  clearActiveDiff: () => set({ activeDiffId: null }),
  syncPanelVisibility: () => {
    const state = get();
    const responsive = deriveResponsiveLayout(state);

    if (responsive.singlePageMode) {
      const nextState = resolveSinglePageSyncState({
        singlePageView: state.singlePageView,
        isBrowserOpen: state.isBrowserOpen,
        isEditorOpen: state.isEditorOpen,
        isSettingsOpen: state.isSettingsOpen,
        isUsageOpen: state.isUsageOpen,
      });

      const syncedState = {
        singlePageView: nextState.view,
        isEditorOpen: nextState.isEditorOpen,
        isSettingsOpen: nextState.isSettingsOpen,
        isUsageOpen: nextState.isUsageOpen,
      };

      if (hasPanelVisibilityChanged(state, syncedState)) {
        set(syncedState);
      }
      return;
    }

    const nextState = resolveDesktopPanelState({
      isEditorOpen: state.isEditorOpen,
      isSettingsOpen: state.isSettingsOpen,
      isUsageOpen: state.isUsageOpen,
    });

    const syncedState = {
      singlePageView: state.singlePageView,
      ...nextState,
    };

    if (hasPanelVisibilityChanged(state, syncedState)) {
      set(nextState);
    }
  },
  showChatPanel: () => set((state) => resolveShowChatState(state)),
  showPanel: (panel, fallbackDiffId) => {
    const state = get();
    const responsive = deriveResponsiveLayout(state);

    set(resolveShowPanelState({
      panel,
      currentState: state,
      responsive,
      fallbackDiffId,
    }));
  },
  togglePanel: (panel, fallbackDiffId) => {
    const state = get();
    const responsive = deriveResponsiveLayout(state);

    set(resolveTogglePanelState({
      panel,
      currentState: state,
      responsive,
      fallbackDiffId,
    }));
  },
  closePanel: (panel) => {
    const state = get();
    const { singlePageMode } = deriveResponsiveLayout(state);

    set(resolveClosePanelState({
      panel,
      currentState: state,
      singlePageMode,
    }));
  },
  openDiff: (id) => {
    const state = get();
    const responsive = deriveResponsiveLayout(state);

    set(resolveOpenDiffState({
      diffId: id,
      currentState: state,
      responsive,
    }));
  },
  setEditorWidth: (width) => {
    if (width === null) {
      set({ editorWidth: null });
      return;
    }
    const state = get();
    const shouldForceSidebarOverlay = state.viewportWidth < SMALL_SCREEN_SIDEBAR_BREAKPOINT;
    const savedSidebarWidth = (!state.isSidebarOpen && !shouldForceSidebarOverlay) ? state.sidebarWidth : 0;
    set({ editorWidth: width - savedSidebarWidth });
  },
  setIsResizingSidebar: (isResizing) => set({ isResizingSidebar: isResizing }),
  setIsResizingEditor: (isResizing) => set({ isResizingEditor: isResizing }),
  setActiveDiffId: (id) => set({ activeDiffId: id }),
  setActiveCodeReference: (reference) => set({ activeCodeReference: reference }),
  openCodeReference: (reference) => {
    get().openDiff(reference.diffId);
    set((state) => ({
      activeCodeReference: reference,
      codeReferenceRevealToken: state.codeReferenceRevealToken + 1,
    }));
  },
  commitWidths: () => {
    const state = get();
    const responsive = deriveResponsiveLayout(state);
    const shouldForceSidebarOverlay = state.viewportWidth < SMALL_SCREEN_SIDEBAR_BREAKPOINT;
    const savedSidebarWidth = (!state.isSidebarOpen && !shouldForceSidebarOverlay) ? state.sidebarWidth : 0;

    // overlay 模式下 sidebar 实际显示宽度是 state.sidebarWidth（不参与布局），
    // responsive.sidebarWidth 此时为 0，不能用 0 覆盖，否则后续无法展开侧边栏
    const nextSidebarWidth = responsive.shouldUseSidebarOverlay
      ? state.sidebarWidth
      : Math.max(responsive.sidebarWidth, MIN_SIDEBAR_WIDTH);

    set({
      sidebarWidth: nextSidebarWidth,
      editorWidth: responsive.editorWidth ? responsive.editorWidth - savedSidebarWidth : null
    });
  },

  toggleFpsOverlay: () => set((state) => ({ showFpsOverlay: !state.showFpsOverlay })),
  setOccupancyMonitorDebug: (enabled) => set({ showFpsOverlay: enabled }),
  setOriginalContentDebug: (enabled) => set({ showOriginalContentDebug: enabled }),
  setRawResponseDebug: (enabled) => set({ showRawResponseDebug: enabled }),
  setShowTestButton: (enabled) => set({ showTestButton: enabled }),
  setShowLayoutDebug: (enabled) => set({ showLayoutDebug: enabled }),

  getResponsiveWidths: () => deriveResponsiveLayout(get())
}));
