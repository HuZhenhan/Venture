import { useEffect, useMemo, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { APIConfig } from '../types';
import { MIN_CHAT_WIDTH, RIGHT_RAIL_WIDTH, APPLE_CURVE, DURATION } from '../constants';
import { type SettingsTab, useLayoutStore, selectActiveSettingsTab } from '../store/useLayoutStore';
import { usePreferencesStore } from '../store/usePreferencesStore';
import { useThemeStore, ThemeMode } from '../store/useThemeStore';
import { getLegacyLocalDataSummary, migrateLegacyLocalData } from '../services/appDataService';
import { useChatStore } from '../store/useChatStore';
import { beginHorizontalResize } from '../utils/panelResize';
import { PreferencesPanel, ProviderLibraryPanel, MigrationPanel } from './settings/SettingsSidebarPanels';

interface SettingsSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  side?: 'left' | 'right';
  width?: number;
  onWidthChange?: (w: number) => void;
  apiConfigs: APIConfig[];
  onApiConfigsChange: (configs: APIConfig[]) => void;
}

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色模式', value: 'light' },
  { label: '深色模式', value: 'dark' },
];

const SETTINGS_TABS_ORDER: SettingsTab[] = ['basic', 'api', 'migration'];

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({ 
  isOpen, 
  onClose, 
  side = 'left',
  width = 400, 
  onWidthChange, 
  apiConfigs, 
}) => {
  const commitWidths = useLayoutStore(state => state.commitWidths);
  const viewportWidth = useLayoutStore(state => state.viewportWidth);
  const { theme, setTheme } = useThemeStore();
  const hydrateTheme = useThemeStore((state) => state.hydrateTheme);
  const hydrateAppData = useChatStore((state) => state.hydrateAppData);
  const loadApiConfigs = useChatStore((state) => state.loadApiConfigs);
  const {
    sendShortcut: savedSendShortcut,
    autoGenerateConversationTitles: savedAutoGenerateConversationTitles,
    autoGenerateReasoningTitles: savedAutoGenerateReasoningTitles,
    setPreferences,
  } = usePreferencesStore();
  const hydratePreferences = usePreferencesStore((state) => state.hydratePreferences);
  const [draftSendShortcut, setDraftSendShortcut] = useState(savedSendShortcut);
  const [draftAutoGenerateConversationTitles, setDraftAutoGenerateConversationTitles] = useState(savedAutoGenerateConversationTitles);
  const [draftAutoGenerateReasoningTitles, setDraftAutoGenerateReasoningTitles] = useState(savedAutoGenerateReasoningTitles);
  const [draftTheme, setDraftTheme] = useState<ThemeMode>(theme);
  const [migrationStatus, setMigrationStatus] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const appearance = THEME_OPTIONS.find(o => o.value === draftTheme)?.label ?? '跟随系统';
  const setAppearance = (label: string) => {
    const found = THEME_OPTIONS.find(o => o.label === label);
    if (found) setDraftTheme(found.value);
  };

  const [expandedConfigId, setExpandedConfigId] = useState<string | null>(null);
  const isRightSide = side === 'right';
  const maxResizableWidth = useMemo(
    () => Math.max(320, viewportWidth - RIGHT_RAIL_WIDTH - MIN_CHAT_WIDTH),
    [viewportWidth]
  );
  const hasPendingPreferenceChanges =
    draftSendShortcut !== savedSendShortcut ||
    draftAutoGenerateConversationTitles !== savedAutoGenerateConversationTitles ||
    draftAutoGenerateReasoningTitles !== savedAutoGenerateReasoningTitles ||
    draftTheme !== theme;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setDraftSendShortcut(savedSendShortcut);
    setDraftAutoGenerateConversationTitles(savedAutoGenerateConversationTitles);
    setDraftAutoGenerateReasoningTitles(savedAutoGenerateReasoningTitles);
    setDraftTheme(theme);
  }, [isOpen, savedSendShortcut, savedAutoGenerateConversationTitles, savedAutoGenerateReasoningTitles, theme]);

  const handleSavePreferences = () => {
    setPreferences({
      sendShortcut: draftSendShortcut,
      autoGenerateConversationTitles: draftAutoGenerateConversationTitles,
      autoGenerateReasoningTitles: draftAutoGenerateReasoningTitles,
    });
    if (draftTheme !== theme) {
      setTheme(draftTheme);
    }
  };

  const legacySummary = getLegacyLocalDataSummary();
  const handleMigrateLegacyLocalData = async () => {
    if (!legacySummary) {
      setMigrationStatus('当前入口没有可迁移的旧数据');
      return;
    }
    setMigrationStatus('正在迁移当前入口数据...');
    try {
      const data = await migrateLegacyLocalData();
      hydrateAppData(data.chats, data.activeChatId);
      hydratePreferences(data.preferences);
      hydrateTheme(data.theme);
      await loadApiConfigs();
      setMigrationStatus(`已迁移：${legacySummary.chatCount} 个会话，设置已覆盖到统一存储`);
    } catch (error) {
      console.warn('Failed to migrate legacy local data.', error);
      setMigrationStatus('迁移失败，请确认后端服务已启动');
    }
  };

  const activeSettingsTab = useLayoutStore(selectActiveSettingsTab);
  const previousTabRef = useRef(activeSettingsTab);
  const [direction, setDirection] = useState(1);

  useEffect(() => {
    const prevIndex = SETTINGS_TABS_ORDER.indexOf(previousTabRef.current);
    const currIndex = SETTINGS_TABS_ORDER.indexOf(activeSettingsTab);
    if (currIndex !== prevIndex) {
      setDirection(currIndex > prevIndex ? 1 : -1);
    }
    previousTabRef.current = activeSettingsTab;
  }, [activeSettingsTab]);

  const getTabContent = () => {
    switch (activeSettingsTab) {
      case 'basic':
        return (
          <PreferencesPanel
            appearance={appearance}
            onAppearanceChange={setAppearance}
            sendShortcut={draftSendShortcut}
            onSendShortcutChange={setDraftSendShortcut}
            autoGenerateConversationTitles={draftAutoGenerateConversationTitles}
            onAutoGenerateConversationTitlesChange={setDraftAutoGenerateConversationTitles}
            autoGenerateReasoningTitles={draftAutoGenerateReasoningTitles}
            onAutoGenerateReasoningTitlesChange={setDraftAutoGenerateReasoningTitles}
            onSave={handleSavePreferences}
            hasPendingChanges={hasPendingPreferenceChanges}
          />
        );
      case 'api':
        return (
          <ProviderLibraryPanel
            apiConfigs={apiConfigs}
            expandedConfigId={expandedConfigId}
            onExpandedConfigIdChange={setExpandedConfigId}
          />
        );
      case 'migration':
        return (
          <MigrationPanel
            migrationSummary={legacySummary}
            migrationStatus={migrationStatus}
            onMigrateLegacyLocalData={handleMigrateLegacyLocalData}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      {!onWidthChange && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: isOpen ? 1 : 0 }}
          transition={{ duration: DURATION.fast }}
          onClick={onClose}
          className="fixed inset-0 bg-black/30 backdrop-blur-sm"
          style={{ pointerEvents: isOpen ? 'auto' : 'none' }}
        />
      )}
      
      <motion.div
        initial={false}
        animate={{ width: isOpen ? width : 0 }}
        className={`h-full bg-sidebar ${isRightSide ? 'border-l' : 'border-r'} border-border flex flex-col shrink-0 overflow-hidden relative transform-gpu antialiased shadow-lg z-[100] ${!isOpen ? 'pointer-events-none' : ''}`}
        transition={{
          width: isResizing
            ? { duration: 0 }
            : { duration: DURATION.panel, ease: APPLE_CURVE }
        }}
      >
        <div 
          className="h-full flex flex-col relative overflow-hidden"
          style={{ width }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex-1 relative overflow-hidden">
            <AnimatePresence mode="popLayout" initial={false} custom={direction}>
              <motion.div
                key={activeSettingsTab}
                custom={direction}
                initial={(d: number) => ({ x: d * 30, opacity: 0 })}
                animate={{ x: 0, opacity: 1 }}
                exit={(d: number) => ({ x: d * -30, opacity: 0 })}
                transition={{ duration: 0.35, ease: APPLE_CURVE }}
                className="absolute inset-0 flex flex-col overflow-y-auto overflow-x-hidden custom-scrollbar"
              >
                {getTabContent()}
              </motion.div>
            </AnimatePresence>
          </div>

          <div 
            className="absolute right-0 top-0 w-0.5 h-full cursor-col-resize bg-gradient-to-b from-transparent via-border to-transparent opacity-0 hover:opacity-100 transition-opacity"
            onMouseDown={(e) => {
              setIsResizing(true);
              beginHorizontalResize({
                startEvent: e,
                initialWidth: width,
                minWidth: 320,
                maxWidth: maxResizableWidth,
                direction: 'expand-left',
                setWidth: (newWidth) => onWidthChange?.(newWidth),
                setIsResizing,
                onResizeEnd: () => {
                  commitWidths();
                },
              });
            }}
          />
        </div>
      </motion.div>
    </>
  );
};
