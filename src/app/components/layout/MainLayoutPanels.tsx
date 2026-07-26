import React from 'react';
import { motion } from 'motion/react';
import { APIConfig } from '../../types';
import { PANEL_TRANSITION, DURATION, APPLE_CURVE } from '../../constants';

import { SettingsSidebar } from '../SettingsSidebar';
import { UsagePanel } from '../UsagePanel';
import { BrowserPanel } from '../BrowserPanel';
import { WorkflowCanvas } from '../WorkflowCanvas';

interface SinglePagePanelsProps {
  singlePageView: 'chat' | 'browser' | 'workflow' | 'editor' | 'settings' | 'usage';
  singlePageContentWidth: number;
  shellClassName: string;
  isBrowserOpen: boolean;
  isBrowserNativeViewHidden: boolean;
  apiConfigs: APIConfig[];
  onApiConfigsChange: (configs: APIConfig[]) => void;
  onShowChat: () => void;
}

type OverlayPanelView = Exclude<SinglePagePanelsProps['singlePageView'], 'chat'>;

interface DesktopPanelsProps {
  settingsEverOpened: boolean;
  usageEverOpened: boolean;
  isSettingsOpen: boolean;
  isUsageOpen: boolean;
  settingsWidth: number;
  isResizingSettings: boolean;
  apiConfigs: APIConfig[];
  onApiConfigsChange: (configs: APIConfig[]) => void;
  onCloseSettings: () => void;
  onCloseUsage: () => void;
  onSettingsWidthChange: (width: number) => void;
}

export const SinglePagePanels = React.memo(function SinglePagePanels({
  singlePageView,
  singlePageContentWidth,
  shellClassName,
  isBrowserOpen,
  isBrowserNativeViewHidden,
  apiConfigs,
  onApiConfigsChange,
  onShowChat,
}: SinglePagePanelsProps) {
  const OVERLAY_DURATION_MS = DURATION.panel * 1000;
  const overlayTransition = PANEL_TRANSITION;
  const [activeView, setActiveView] = React.useState<OverlayPanelView | null>(
    singlePageView === 'chat' ? null : singlePageView
  );
  const [incomingView, setIncomingView] = React.useState<OverlayPanelView | null>(null);
  const [isDismissingActive, setIsDismissingActive] = React.useState(false);
  const transitionTimerRef = React.useRef<number | null>(null);
  const latestRequestedViewRef = React.useRef<OverlayPanelView | null>(
    singlePageView === 'chat' ? null : singlePageView
  );

  if (singlePageView !== 'chat') {
    latestRequestedViewRef.current = singlePageView;
  }

  React.useLayoutEffect(() => {
    if (transitionTimerRef.current) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }

    if (singlePageView === 'chat') {
      const dismissTarget = incomingView ?? activeView ?? latestRequestedViewRef.current;
      if (dismissTarget) {
        setActiveView(dismissTarget);
        setIncomingView(null);
        setIsDismissingActive(true);
        transitionTimerRef.current = window.setTimeout(() => {
          setActiveView(null);
          setIsDismissingActive(false);
          latestRequestedViewRef.current = null;
          transitionTimerRef.current = null;
        }, OVERLAY_DURATION_MS);
      }
      return;
    }

    if (!activeView) {
      setActiveView(singlePageView);
      setIncomingView(null);
      setIsDismissingActive(false);
      return;
    }

    if (activeView === singlePageView && !incomingView) {
      setIsDismissingActive(false);
      return;
    }

    if (incomingView === singlePageView) {
      setIsDismissingActive(false);
      return;
    }

    setIncomingView(singlePageView);
    setIsDismissingActive(false);
    transitionTimerRef.current = window.setTimeout(() => {
      setActiveView(singlePageView);
      setIncomingView(null);
      transitionTimerRef.current = null;
    }, OVERLAY_DURATION_MS);
  }, [OVERLAY_DURATION_MS, activeView, incomingView, singlePageView]);

  React.useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        window.clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);

  const renderOverlayPanel = (
    view: OverlayPanelView,
    mode: 'active' | 'incoming'
  ) => {
    const panelKey = `${mode}-${view}`;
    const motionProps =
      mode === 'incoming'
        ? { initial: { x: '100%' }, animate: { x: 0 }, zIndex: 60 }
        : {
            initial: activeView === view ? false : { x: '100%' },
            animate: { x: isDismissingActive || singlePageView === 'chat' ? '100%' : 0 },
            zIndex: 50,
          };

    const shouldDisablePointerEvents = mode === 'active' && (isDismissingActive || singlePageView === 'chat');
    const panelClassName = `${shellClassName}${shouldDisablePointerEvents ? ' pointer-events-none' : ''}`;
    const elevatedPanelClassName = panelClassName;

    if (view === 'browser') {
      return (
        <motion.div
          key={panelKey}
          initial={motionProps.initial}
          animate={motionProps.animate}
          transition={overlayTransition}
          className={elevatedPanelClassName}
          style={{ width: singlePageContentWidth, zIndex: motionProps.zIndex }}
        >
          <BrowserPanel
            isOpen={isBrowserOpen}
            width={singlePageContentWidth}
            isNativeViewHidden={isBrowserNativeViewHidden}
          />
        </motion.div>
      );
    }

    if (view === 'workflow') {
      return (
        <motion.div
          key={panelKey}
          initial={motionProps.initial}
          animate={motionProps.animate}
          transition={overlayTransition}
          className={elevatedPanelClassName}
          style={{ width: singlePageContentWidth, zIndex: motionProps.zIndex }}
        >
          <WorkflowCanvas />
        </motion.div>
      );
    }

    if (view === 'editor') {
      return null;
    }

    if (view === 'settings') {
      return (
        <motion.div
          key={panelKey}
          initial={motionProps.initial}
          animate={motionProps.animate}
          transition={overlayTransition}
          className={`${elevatedPanelClassName} overflow-visible`}
          style={{ width: singlePageContentWidth, zIndex: motionProps.zIndex }}
        >
          <SettingsSidebar
            isOpen
            side="right"
            onClose={onShowChat}
            width={singlePageContentWidth}
            apiConfigs={apiConfigs}
            onApiConfigsChange={onApiConfigsChange}
          />
        </motion.div>
      );
    }

    return (
      <motion.div
        key={panelKey}
        initial={motionProps.initial}
        animate={motionProps.animate}
        transition={overlayTransition}
        className={elevatedPanelClassName}
        style={{ width: singlePageContentWidth, zIndex: motionProps.zIndex }}
      >
        <UsagePanel
          isOpen
          width={singlePageContentWidth}
        />
      </motion.div>
    );
  };

  const visibleActiveView =
    activeView ?? (singlePageView === 'chat' ? latestRequestedViewRef.current : null);

  return (
    <>
      {visibleActiveView ? renderOverlayPanel(visibleActiveView, 'active') : null}
      {incomingView ? renderOverlayPanel(incomingView, 'incoming') : null}
    </>
  );
});

export const DesktopPanels = React.memo(function DesktopPanels({
  settingsEverOpened,
  usageEverOpened,
  isSettingsOpen,
  isUsageOpen,
  settingsWidth,
  isResizingSettings,
  apiConfigs,
  onApiConfigsChange,
  onCloseSettings,
  onCloseUsage,
  onSettingsWidthChange,
}: DesktopPanelsProps) {
  const isResizing = isResizingSettings;

  const targetVisible = React.useMemo(
    () => ({
      editor: false,
      settings: isSettingsOpen,
      usage: isUsageOpen && !isSettingsOpen,
    }),
    [isSettingsOpen, isUsageOpen]
  );

  const stillAnimatingRef = React.useRef<Partial<Record<keyof typeof targetVisible, boolean>>>({});
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

  const renderedPanels = {} as typeof targetVisible;
  (Object.keys(targetVisible) as Array<keyof typeof targetVisible>).forEach((key) => {
    renderedPanels[key] = targetVisible[key] || !!stillAnimatingRef.current[key];
  });

  const handlePanelAnimationComplete = React.useCallback(
    (panelKey: keyof typeof targetVisible) => {
      if (!targetVisible[panelKey] && stillAnimatingRef.current[panelKey]) {
        delete stillAnimatingRef.current[panelKey];
        forceUpdate();
      }
    },
    [targetVisible]
  );

  const prevTargetVisibleRef = React.useRef(targetVisible);
  if (prevTargetVisibleRef.current !== targetVisible) {
    (Object.keys(targetVisible) as Array<keyof typeof targetVisible>).forEach((key) => {
      if (prevTargetVisibleRef.current[key] && !targetVisible[key]) {
        stillAnimatingRef.current[key] = true;
      }
      if (targetVisible[key]) {
        delete stillAnimatingRef.current[key];
      }
    });
    prevTargetVisibleRef.current = targetVisible;
  }

  const renderedSettingsWidth = renderedPanels.settings ? settingsWidth : 0;
  const renderedUsageWidth = renderedPanels.usage ? settingsWidth : 0;
  const totalWidth = Math.max(renderedSettingsWidth, renderedUsageWidth);

  const isAnyTargetVisible = targetVisible.settings || targetVisible.usage;

  const getPanelMotion = (panel: 'settings' | 'usage') => {
    if (targetVisible[panel]) {
      return { x: 0, opacity: 1, zIndex: 40 };
    }
    if (!isAnyTargetVisible) {
      // Both are closing or closed, slide to the right
      return { x: '100%', opacity: 1, zIndex: 30 };
    }
    // Switching between panels (Usage is conceptually left, Settings is conceptually right)
    if (panel === 'settings') {
      return { x: 30, opacity: 0, zIndex: 30 };
    } else {
      return { x: -30, opacity: 0, zIndex: 30 };
    }
  };

  return (
    <motion.div
      className="relative shrink-0 h-full overflow-hidden pointer-events-none select-none"
      animate={{ width: totalWidth }}
      transition={{
        width: isResizing ? { duration: 0 } : PANEL_TRANSITION,
      }}
    >
      {settingsEverOpened && renderedPanels.settings && (
        <motion.div
          className="absolute top-0 right-0 h-full bg-background select-none"
          style={{ width: settingsWidth }}
          initial={false}
          animate={{
            ...getPanelMotion('settings'),
            pointerEvents: (targetVisible.settings ? 'auto' : 'none') as React.CSSProperties['pointerEvents'],
          }}
          onAnimationComplete={() => handlePanelAnimationComplete('settings')}
          transition={{ duration: 0.35, ease: APPLE_CURVE }}
        >
          <SettingsSidebar
            isOpen={true}
            side="right"
            onClose={onCloseSettings}
            width={settingsWidth}
            onWidthChange={onSettingsWidthChange}
            apiConfigs={apiConfigs}
            onApiConfigsChange={onApiConfigsChange}
          />
        </motion.div>
      )}

      {usageEverOpened && renderedPanels.usage && (
        <motion.div
          className="absolute top-0 right-0 h-full bg-background select-none"
          style={{ width: settingsWidth }}
          initial={false}
          animate={{
            ...getPanelMotion('usage'),
            pointerEvents: (targetVisible.usage ? 'auto' : 'none') as React.CSSProperties['pointerEvents'],
          }}
          onAnimationComplete={() => handlePanelAnimationComplete('usage')}
          transition={{ duration: 0.35, ease: APPLE_CURVE }}
        >
          <UsagePanel
            isOpen={true}
            width={settingsWidth}
          />
        </motion.div>
      )}
    </motion.div>
  );
});
