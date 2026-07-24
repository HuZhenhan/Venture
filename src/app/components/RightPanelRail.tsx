import { motion, AnimatePresence } from 'motion/react';
import { MessageSquareText, Settings2, Activity, Globe, SlidersHorizontal, Key, HardDriveDownload, FileText, Workflow } from 'lucide-react';
import { APPLE_CURVE } from '../constants';
import { type SettingsTab, useLayoutStore, selectActiveSettingsTab, selectSetActiveSettingsTab } from '../store/useLayoutStore';

interface RightPanelRailProps {
  isChatActive: boolean;
  isSettingsOpen: boolean;
  isUsageOpen: boolean;
  isBrowserOpen: boolean;
  isBrowserActive: boolean;
  isBrowserSummaryOpen: boolean;
  isWorkflowActive: boolean;
  onShowChat: () => void;
  onToggleSettings: () => void;
  onToggleUsage: () => void;
  onToggleBrowser: () => void;
  onToggleBrowserSummary: () => void;
  onToggleWorkflow: () => void;
}

interface RailButtonProps {
  isActive: boolean;
  label: string;
  onClick: () => void;
  controlsId?: string;
  children: React.ReactNode;
}

const SETTINGS_TABS: ReadonlyArray<{
  id: SettingsTab;
  label: string;
  icon: typeof SlidersHorizontal;
}> = [
  { id: 'basic', label: '基础', icon: SlidersHorizontal },
  { id: 'api', label: 'API', icon: Key },
  { id: 'migration', label: '迁移', icon: HardDriveDownload },
] as const;

function RailButton({ isActive, label, onClick, controlsId, children }: RailButtonProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      transition={{ duration: 0.15, ease: APPLE_CURVE }}
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={isActive}
      aria-expanded={controlsId ? isActive : undefined}
      aria-controls={controlsId}
      title={label}
      className={`relative flex h-10 w-10 items-center justify-center rounded-[18px] transition-colors duration-300 ${
        isActive
          ? 'text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      }`}
    >
      {isActive && (
        <motion.div
          layoutId={`rail-active-${label}`}
          transition={{ duration: 0.42, ease: APPLE_CURVE }}
          className="absolute inset-0 rounded-[18px] border border-border bg-background shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.02)]"
        />
      )}
      <span className="relative z-10 flex items-center justify-center">{children}</span>
    </motion.button>
  );
}

export function RightPanelRail({
  isChatActive,
  isSettingsOpen,
  isUsageOpen,
  isBrowserOpen,
  isBrowserActive,
  isBrowserSummaryOpen,
  isWorkflowActive,
  onShowChat,
  onToggleSettings,
  onToggleUsage,
  onToggleBrowser,
  onToggleBrowserSummary,
  onToggleWorkflow,
}: RightPanelRailProps) {
  const activeSettingsTab = useLayoutStore(selectActiveSettingsTab);
  const setActiveSettingsTab = useLayoutStore(selectSetActiveSettingsTab);
  const settingsMenuId = 'right-rail-settings-menu';

  return (
    <div className="mt-2 mb-0 flex h-[calc(100%-0.5rem)] w-full flex-col items-center justify-between rounded-t-[24px] rounded-b-none border border-border border-b-0 bg-background/55 px-1.5 py-1.5 shadow-[0_12px_32px_-24px_rgba(0,0,0,0.3)] backdrop-blur-xl">
      <div className="flex flex-col items-center gap-2">
        <RailButton isActive={isChatActive} label="显示聊天栏" onClick={onShowChat}>
          <MessageSquareText size={17} />
        </RailButton>
        <RailButton isActive={isBrowserActive} label={isBrowserOpen ? (isBrowserActive ? '收起浏览器' : '显示浏览器') : '打开浏览器'} onClick={onToggleBrowser}>
          <Globe size={17} />
        </RailButton>
        <RailButton isActive={isWorkflowActive} label={isWorkflowActive ? '收起工作流' : '打开工作流'} onClick={onToggleWorkflow}>
          <Workflow size={17} />
        </RailButton>
      </div>

      <div className="flex flex-col items-center gap-2 w-full relative">
        <RailButton isActive={isBrowserSummaryOpen} label={isBrowserSummaryOpen ? '收起摘要' : '展开摘要'} onClick={onToggleBrowserSummary}>
          <FileText size={17} />
        </RailButton>

        <RailButton isActive={isUsageOpen} label={isUsageOpen ? '收起用量' : '展开用量'} onClick={onToggleUsage}>
          <Activity size={17} />
        </RailButton>

        <AnimatePresence>
          {isSettingsOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.35, ease: APPLE_CURVE }}
              id={settingsMenuId}
              className="flex flex-col items-center overflow-hidden w-full"
            >
              {/* 淡灰色细横线 */}
              <div className="w-full px-2 mb-2">
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  exit={{ scaleX: 0 }}
                  transition={{ duration: 0.3, ease: APPLE_CURVE }}
                  className="h-[1px] w-full bg-border origin-left"
                />
              </div>

              <div className="flex flex-col items-center gap-2 pb-2">
                {SETTINGS_TABS.map((tab) => {
                  const isActive = activeSettingsTab === tab.id;
                  const Icon = tab.icon;
                  return (
                    <motion.button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveSettingsTab(tab.id)}
                      whileTap={{ scale: 0.92 }}
                      title={tab.label}
                      aria-label={`打开${tab.label}设置`}
                      aria-pressed={isActive}
                      className={`relative flex h-10 w-10 items-center justify-center rounded-[18px] transition-colors duration-300 ${
                        isActive ? 'text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      }`}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="settings-tab-active"
                          transition={{ duration: 0.42, ease: APPLE_CURVE }}
                          className="absolute inset-0 rounded-[18px] border border-border bg-background shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.02)]"
                        />
                      )}
                      <span className="relative z-10 flex items-center justify-center">
                        <Icon size={17} />
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <RailButton
          isActive={isSettingsOpen}
          label={isSettingsOpen ? '收起设置' : '展开设置'}
          onClick={onToggleSettings}
          controlsId={settingsMenuId}
        >
          <Settings2 size={17} />
        </RailButton>
      </div>
    </div>
  );
}