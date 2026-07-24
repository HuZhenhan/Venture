export type WorkspaceView = 'chat' | 'browser' | 'workflow' | 'editor' | 'settings' | 'usage';
export type SinglePagePanelView = WorkspaceView;
export type ToggleablePanel = Exclude<WorkspaceView, 'chat' | 'browser' | 'workflow'>;

export interface SinglePageSyncState {
  view: SinglePagePanelView;
  isEditorOpen: boolean;
  isSettingsOpen: boolean;
  isUsageOpen: boolean;
}

export interface RailState {
  chatActive: boolean;
  browserActive: boolean;
  workflowActive: boolean;
  editorActive: boolean;
  settingsActive: boolean;
  usageActive: boolean;
}

export interface PanelVisibilityState {
  singlePageView: SinglePagePanelView;
  activeWorkspaceView: WorkspaceView;
  isBrowserOpen: boolean;
  isEditorOpen: boolean;
  isSettingsOpen: boolean;
  isUsageOpen: boolean;
  activeDiffId: string | null;
}

export interface WorkspaceOpenState {
  isBrowserOpen: boolean;
  isEditorOpen: boolean;
  isSettingsOpen: boolean;
  isUsageOpen: boolean;
}

export interface ResponsivePanelContext {
  singlePageMode: boolean;
  compactRightPanels: boolean;
  effectiveEditorOpen: boolean;
}

interface ShowPanelArgs {
  panel: ToggleablePanel;
  currentState: PanelVisibilityState;
  responsive: ResponsivePanelContext;
  fallbackDiffId?: string;
}

interface TogglePanelArgs extends ShowPanelArgs {}

function createVisibilityState(view: SinglePagePanelView): Omit<PanelVisibilityState, 'activeDiffId' | 'activeWorkspaceView' | 'isBrowserOpen'> {
  return {
    singlePageView: view,
    isEditorOpen: view === 'editor',
    isSettingsOpen: view === 'settings',
    isUsageOpen: view === 'usage',
  };
}

export function isWorkspaceViewOpen(view: WorkspaceView, state: WorkspaceOpenState): boolean {
  switch (view) {
    case 'chat':
      return true;
    case 'browser':
      return state.isBrowserOpen;
    case 'workflow':
      return true;
    case 'editor':
      return state.isEditorOpen;
    case 'settings':
      return state.isSettingsOpen;
    case 'usage':
      return state.isUsageOpen;
  }
}

export function resolveActiveWorkspaceView(args: WorkspaceOpenState & { preferredView: WorkspaceView }): WorkspaceView {
  if (isWorkspaceViewOpen(args.preferredView, args)) {
    return args.preferredView;
  }

  if (args.isSettingsOpen) return 'settings';
  if (args.isUsageOpen) return 'usage';
  if (args.isBrowserOpen) return 'browser';
  if (args.isEditorOpen) return 'editor';
  return 'chat';
}

export interface AdaptivePanelVisibilityArgs extends WorkspaceOpenState {
  activeWorkspaceView: WorkspaceView;
  browserParticipatesInLayout: boolean;
  settingsParticipatesInLayout: boolean;
  usageParticipatesInLayout: boolean;
  chatCollapsed: boolean;
  singlePageMode: boolean;
}

export interface AdaptivePanelVisibility {
  showChat: boolean;
  showBrowser: boolean;
  showWorkflow: boolean;
  showSettings: boolean;
  showUsage: boolean;
  singlePageView: SinglePagePanelView;
  isBrowserNativeViewHidden: boolean;
}

export function resolveAdaptivePanelVisibility(args: AdaptivePanelVisibilityArgs): AdaptivePanelVisibility {
  const activeView = resolveActiveWorkspaceView({
    preferredView: args.activeWorkspaceView,
    isBrowserOpen: args.isBrowserOpen,
    isEditorOpen: args.isEditorOpen,
    isSettingsOpen: args.isSettingsOpen,
    isUsageOpen: args.isUsageOpen,
  });
  const singlePageView = args.singlePageMode ? activeView : 'chat';
  const showBrowser = args.isBrowserOpen && (args.browserParticipatesInLayout || singlePageView === 'browser');

  return {
    showChat: !args.chatCollapsed || singlePageView === 'chat',
    showBrowser,
    showWorkflow: activeView === 'workflow',
    showSettings: args.isSettingsOpen && (args.settingsParticipatesInLayout || singlePageView === 'settings'),
    showUsage: args.isUsageOpen && (args.usageParticipatesInLayout || singlePageView === 'usage'),
    singlePageView,
    isBrowserNativeViewHidden: !showBrowser || (args.singlePageMode && singlePageView !== 'browser'),
  };
}

function isPanelOpen(state: PanelVisibilityState, panel: ToggleablePanel): boolean {
  switch (panel) {
    case 'editor':
      return state.isEditorOpen;
    case 'settings':
      return state.isSettingsOpen;
    case 'usage':
      return state.isUsageOpen;
  }
}

function ensureDiffId(activeDiffId: string | null, shouldOpenEditor: boolean, fallbackDiffId?: string): string | null {
  if (!shouldOpenEditor || activeDiffId) {
    return activeDiffId;
  }

  return fallbackDiffId ?? null;
}

export function createSinglePageSyncState(view: SinglePagePanelView): SinglePageSyncState {
  return {
    view,
    isEditorOpen: view === 'editor',
    isSettingsOpen: view === 'settings',
    isUsageOpen: view === 'usage',
  };
}

export function resolveSinglePageSyncState(args: {
  singlePageView: SinglePagePanelView;
  isBrowserOpen: boolean;
  isEditorOpen: boolean;
  isSettingsOpen: boolean;
  isUsageOpen: boolean;
}): SinglePageSyncState {
  const currentViewState =
    args.singlePageView === 'workflow' ||
    (args.singlePageView === 'settings' && args.isSettingsOpen) ||
    (args.singlePageView === 'usage' && args.isUsageOpen) ||
    (args.singlePageView === 'browser' && args.isBrowserOpen) ||
    (args.singlePageView === 'editor' && args.isEditorOpen);

  if (currentViewState) {
    return createSinglePageSyncState(args.singlePageView);
  }

  if (args.isSettingsOpen) {
    return createSinglePageSyncState('settings');
  }

  if (args.isUsageOpen) {
    return createSinglePageSyncState('usage');
  }

  if (args.isBrowserOpen) {
    return createSinglePageSyncState('browser');
  }

  return createSinglePageSyncState('chat');
}

export function resolveDesktopPanelState(args: {
  isEditorOpen: boolean;
  isSettingsOpen: boolean;
  isUsageOpen: boolean;
}): Omit<SinglePageSyncState, 'view'> {
  if (args.isSettingsOpen) {
    return {
      isEditorOpen: false,
      isSettingsOpen: true,
      isUsageOpen: false,
    };
  }

  if (args.isUsageOpen) {
    return {
      isEditorOpen: false,
      isSettingsOpen: false,
      isUsageOpen: true,
    };
  }

  return {
    isEditorOpen: args.isEditorOpen,
    isSettingsOpen: args.isSettingsOpen,
    isUsageOpen: args.isUsageOpen,
  };
}

export function resolveRailState(args: {
  singlePageMode: boolean;
  singlePageView: SinglePagePanelView;
  activeWorkspaceView: WorkspaceView;
  isBrowserOpen: boolean;
  browserParticipatesInLayout: boolean;
  effectiveEditorOpen: boolean;
  isSettingsOpen: boolean;
  isUsageOpen: boolean;
}): RailState {
  if (args.singlePageMode) {
    return {
      chatActive: args.singlePageView === 'chat',
      browserActive: args.singlePageView === 'browser',
      workflowActive: args.singlePageView === 'workflow',
      editorActive: args.singlePageView === 'editor',
      settingsActive: args.singlePageView === 'settings',
      usageActive: args.singlePageView === 'usage',
    };
  }

  return {
    chatActive: args.activeWorkspaceView === 'chat' || (args.activeWorkspaceView !== 'workflow' && !args.effectiveEditorOpen && !args.isSettingsOpen && !args.isUsageOpen && !args.isBrowserOpen),
    browserActive: args.isBrowserOpen && (args.activeWorkspaceView === 'browser' || args.browserParticipatesInLayout),
    workflowActive: args.activeWorkspaceView === 'workflow',
    editorActive: args.effectiveEditorOpen,
    settingsActive: args.isSettingsOpen,
    usageActive: args.isUsageOpen,
  };
}

export function resolveSinglePageTargetView(args: {
  currentView: SinglePagePanelView;
  targetView: ToggleablePanel;
  targetOpen: boolean;
}): SinglePagePanelView {
  const nextOpen = args.currentView !== args.targetView || !args.targetOpen;
  return nextOpen ? args.targetView : 'chat';
}

export function resolveShowChatState(currentState: PanelVisibilityState): PanelVisibilityState {
  return {
    ...currentState,
    ...createVisibilityState('chat'),
    activeWorkspaceView: 'chat',
  };
}

export function resolveShowPanelState(args: ShowPanelArgs): PanelVisibilityState {
  if (args.responsive.singlePageMode) {
    return {
      ...args.currentState,
      ...createVisibilityState(args.panel),
        activeWorkspaceView: args.panel,
      activeDiffId: ensureDiffId(args.currentState.activeDiffId, args.panel === 'editor', args.fallbackDiffId),
    };
  }

  switch (args.panel) {
    case 'settings':
      return {
        ...args.currentState,
        activeWorkspaceView: 'settings',
        isSettingsOpen: true,
        isUsageOpen: false,
        isEditorOpen: false,
      };
    case 'usage':
      return {
        ...args.currentState,
        activeWorkspaceView: 'usage',
        isSettingsOpen: false,
        isUsageOpen: true,
        isEditorOpen: false,
      };
    case 'editor':
      return {
        ...args.currentState,
        activeWorkspaceView: 'editor',
        isEditorOpen: true,
        isSettingsOpen: false,
        isUsageOpen: false,
        activeDiffId: ensureDiffId(args.currentState.activeDiffId, true, args.fallbackDiffId),
      };
  }
}

export function resolveTogglePanelState(args: TogglePanelArgs): PanelVisibilityState {
  if (args.responsive.singlePageMode) {
    const nextView = resolveSinglePageTargetView({
      currentView: args.currentState.singlePageView,
      targetView: args.panel,
      targetOpen: isPanelOpen(args.currentState, args.panel),
    });

    return {
      ...args.currentState,
      ...createVisibilityState(nextView),
      activeWorkspaceView: nextView,
      activeDiffId: ensureDiffId(args.currentState.activeDiffId, nextView === 'editor', args.fallbackDiffId),
    };
  }

  switch (args.panel) {
    case 'settings':
      return args.currentState.isSettingsOpen
        ? { ...args.currentState, isSettingsOpen: false, activeWorkspaceView: resolveActiveWorkspaceView({ ...args.currentState, isSettingsOpen: false, preferredView: args.currentState.activeWorkspaceView }) }
        : resolveShowPanelState(args);
    case 'usage':
      return args.currentState.isUsageOpen
        ? { ...args.currentState, isUsageOpen: false, activeWorkspaceView: resolveActiveWorkspaceView({ ...args.currentState, isUsageOpen: false, preferredView: args.currentState.activeWorkspaceView }) }
        : resolveShowPanelState(args);
    case 'editor':
      return args.currentState.isEditorOpen
        ? { ...args.currentState, isEditorOpen: false, activeWorkspaceView: resolveActiveWorkspaceView({ ...args.currentState, isEditorOpen: false, preferredView: args.currentState.activeWorkspaceView }) }
        : resolveShowPanelState(args);
  }
}

export function resolveClosePanelState(args: {
  panel: ToggleablePanel;
  currentState: PanelVisibilityState;
  singlePageMode: boolean;
}): PanelVisibilityState {
  if (args.singlePageMode && args.currentState.singlePageView === args.panel) {
    return resolveShowChatState(args.currentState);
  }

  switch (args.panel) {
    case 'editor':
      return { ...args.currentState, isEditorOpen: false, activeWorkspaceView: resolveActiveWorkspaceView({ ...args.currentState, isEditorOpen: false, preferredView: args.currentState.activeWorkspaceView }) };
    case 'settings':
      return { ...args.currentState, isSettingsOpen: false, activeWorkspaceView: resolveActiveWorkspaceView({ ...args.currentState, isSettingsOpen: false, preferredView: args.currentState.activeWorkspaceView }) };
    case 'usage':
      return { ...args.currentState, isUsageOpen: false, activeWorkspaceView: resolveActiveWorkspaceView({ ...args.currentState, isUsageOpen: false, preferredView: args.currentState.activeWorkspaceView }) };
  }
}

export function resolveOpenDiffState(args: {
  diffId: string;
  currentState: PanelVisibilityState;
  responsive: ResponsivePanelContext;
}): PanelVisibilityState {
  return {
    ...resolveShowPanelState({
      panel: 'editor',
      currentState: args.currentState,
      responsive: args.responsive,
      fallbackDiffId: args.diffId,
    }),
    activeDiffId: args.diffId,
  };
}
