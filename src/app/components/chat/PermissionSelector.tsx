import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, Eye, Infinity as InfinityIcon, ScanSearch, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useChatStore } from '../../store/useChatStore';
import { APPLE_CURVE } from '../../constants';
import { ChatMode, ToolPermissionLevel } from '../../types';
import {
  resolvePermissionForChat,
  TOOL_PERMISSION_DESCRIPTIONS,
  TOOL_PERMISSION_LABELS,
  TOOL_PERMISSION_OPTIONS,
} from '../../utils/toolPermissions';

const PERMISSION_ICONS: Record<ToolPermissionLevel, React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>> = {
  unrestricted: InfinityIcon,
  auto_review: ScanSearch,
  readonly: Eye,
  general: ShieldCheck,
  ask_all: ShieldQuestion,
};

const MODE_LABELS: Record<ChatMode, string> = {
  yolo: 'YOLO',
  agent: 'Agent',
  plan: 'Plan',
};

interface PermissionSelectorProps {
  /** 与输入框其它按钮保持一致的焦点保护处理。 */
  preserveComposerFocus: (event: React.MouseEvent) => void;
}

/**
 * 工具权限选择按钮（输入框发送按钮左侧）。
 *
 * 布局/交互参考模型选择器：触发按钮 + 向上弹出菜单。
 * 可选项随当前模式（yolo/agent/plan）变化；选择结果按会话持久化
 * （新会话写入 preSelectedPermissions，创建时随会话保存）。
 */
export function PermissionSelector({ preserveComposerFocus }: PermissionSelectorProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const activeChatId = useChatStore((state) => state.activeChatId);
  const chat = useChatStore((state) => state.chats.find((item) => item.id === state.activeChatId) ?? null);
  const preSelectedMode = useChatStore((state) => state.preSelectedMode);
  const preSelectedPermissions = useChatStore((state) => state.preSelectedPermissions);
  const setChatPermission = useChatStore((state) => state.setChatPermission);
  const setPreSelectedPermission = useChatStore((state) => state.setPreSelectedPermission);

  const currentMode = chat?.mode || preSelectedMode;
  const currentLevel = resolvePermissionForChat(chat, currentMode, preSelectedPermissions);
  const options = TOOL_PERMISSION_OPTIONS[currentMode];
  const CurrentIcon = PERMISSION_ICONS[currentLevel];

  const closeMenu = React.useCallback(() => setIsOpen(false), []);
  const toggleMenu = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setIsOpen((current) => !current);
  }, []);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelect = React.useCallback((event: React.MouseEvent, level: ToolPermissionLevel) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeChatId) {
      setChatPermission(activeChatId, currentMode, level);
    } else {
      setPreSelectedPermission(currentMode, level);
    }
    setIsOpen(false);
  }, [activeChatId, currentMode, setChatPermission, setPreSelectedPermission]);

  return (
    <div className="relative min-w-0" ref={menuRef}>
      <button
        type="button"
        data-composer-action="true"
        onMouseDown={preserveComposerFocus}
        onClick={toggleMenu}
        className="flex h-8 min-w-0 max-w-[44vw] sm:max-w-full items-center gap-1.5 rounded-xl px-2 text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground active:scale-95"
        title={`工具权限：${TOOL_PERMISSION_LABELS[currentLevel]}`}
      >
        <CurrentIcon size={13} className="shrink-0" strokeWidth={2.1} />
        <span className="max-w-[96px] truncate text-[12px] font-medium tracking-tight sm:max-w-[140px]">{TOOL_PERMISSION_LABELS[currentLevel]}</span>
        <ChevronDown size={12} className={`shrink-0 transition-transform duration-500 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] cursor-default bg-transparent" onMouseDown={closeMenu} />
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.96 }}
              transition={{ duration: 0.4, ease: APPLE_CURVE }}
              className="absolute bottom-full right-0 mb-3 w-64 max-w-[calc(100vw-2rem)] bg-background rounded-2xl border border-border shadow-lg overflow-hidden z-[101] p-1.5 origin-bottom-right transform-gpu antialiased"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-2 mb-1 flex items-center justify-between">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.05em]">工具权限</span>
                <span className="text-[10px] font-medium text-muted-foreground/70">{MODE_LABELS[currentMode]} 模式</span>
              </div>
              <div className="max-h-64 overflow-y-auto custom-scrollbar-chat px-0.5">
                {options.map((level) => {
                  const Icon = PERMISSION_ICONS[level];
                  const isActive = level === currentLevel;
                  return (
                    <button
                      key={level}
                      type="button"
                      onMouseDown={(event) => handleSelect(event, level)}
                      className="flex items-center justify-between w-full px-3 py-2.5 rounded-xl hover:bg-muted/50 active:bg-muted transition-all text-left group/item"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`flex size-6 shrink-0 items-center justify-center rounded-lg ${isActive ? 'bg-foreground/10 text-foreground' : 'bg-muted/50 text-muted-foreground group-hover/item:text-foreground'} transition-colors`}>
                          <Icon size={13} strokeWidth={2.1} />
                        </span>
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className={`text-[13px] tracking-tight transition-colors ${isActive ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground group-hover/item:text-foreground'}`}>
                            {TOOL_PERMISSION_LABELS[level]}
                          </span>
                          <span className="text-[10px] text-muted-foreground font-medium truncate">
                            {TOOL_PERMISSION_DESCRIPTIONS[level]}
                          </span>
                        </div>
                      </div>
                      {isActive && <motion.div layoutId="active-permission-dot" className="w-1.5 h-1.5 rounded-full bg-foreground shrink-0" transition={{ type: 'spring', stiffness: 500, damping: 30 }} />}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
