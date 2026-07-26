import React, { ComponentType } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles, ShieldCheck, Eye } from "lucide-react";
import { useChatStore } from "../../store/useChatStore";
import { selectResponsiveLayout, useLayoutStore } from "../../store/useLayoutStore";
import { APPLE_CURVE } from "../../constants";
import { ChatMode } from "../../types";
import CustomTitleBar from "../window/CustomTitleBar";

const CHAT_MODES: { id: ChatMode; label: string; icon: ComponentType<{ size?: number; className?: string; strokeWidth?: number }> }[] = [
  { id: 'yolo', label: 'YOLO', icon: Sparkles },
  { id: 'agent', label: 'Agent', icon: ShieldCheck },
  { id: 'plan', label: 'Plan', icon: Eye },
];

export function ChatHeader() {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const chat = useChatStore((state) => state.chats.find((item) => item.id === state.activeChatId) ?? null);
  const preSelectedMode = useChatStore((state) => state.preSelectedMode);
  const setChatMode = useChatStore((state) => state.setChatMode);
  const setPreSelectedMode = useChatStore((state) => state.setPreSelectedMode);
  const isSidebarOpen = useLayoutStore(state => state.isSidebarOpen);
  const shouldUseSidebarOverlay = useLayoutStore((state) => selectResponsiveLayout(state).shouldUseSidebarOverlay);
  const isChatPushed = isSidebarOpen && !shouldUseSidebarOverlay;
  const currentMode = chat?.mode || preSelectedMode;
  const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  const handleModeChange = (mode: ChatMode) => {
    if (activeChatId) {
      setChatMode(activeChatId, mode);
      return;
    }

    setPreSelectedMode(mode);
  };

  return (
    <div
      className="shrink-0 h-[52px] flex items-center pl-5 pr-0 z-20 bg-background/70 backdrop-blur-3xl border-b border-border"
    >
      {/* 左侧：spacer + 标题（不设 drag，避免拦截 toggle/测试按钮的点击） */}
      <div className="flex items-center min-w-0 h-full shrink-0">
        <motion.div
          initial={false}
          animate={{
            width: isChatPushed ? 0 : 32,
            marginRight: isChatPushed ? 0 : 12
          }}
          transition={{ duration: 0.42, ease: APPLE_CURVE }}
          className="shrink-0"
        />
        <AnimatePresence mode="wait">
          <motion.div
            key={chat?.id || "empty"}
            layout
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.2, ease: APPLE_CURVE }}
            className="flex items-center min-w-0"
          >
            <h1 className="text-[13px] font-semibold text-foreground tracking-tight truncate leading-none">
              {chat?.title || "新对话"}
            </h1>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* 中间：独立的 drag 区域（空白，不包含任何按钮） */}
      <div
        className="flex-1 h-full"
        style={__IS_ELECTRON__ ? dragRegionStyle : undefined}
      />

      {/* 右侧：模式按钮 + 窗口控制（no-drag） */}
      <div className="flex items-center justify-end ml-4 gap-3 shrink-0" style={__IS_ELECTRON__ ? noDragRegionStyle : undefined}>
        <div className="flex items-center bg-muted/50 p-[2.5px] rounded-xl border border-border select-none">
          {CHAT_MODES.map((m) => {
            const Icon = m.icon;
            const isActive = currentMode === m.id;
            return (
              <motion.button
                whileTap={{ scale: 0.92 }}
                key={m.id}
                onClick={() => handleModeChange(m.id)}
                className={`relative flex items-center gap-1.5 px-3 py-1 rounded-[9.5px] transition-colors duration-200 min-w-[64px] justify-center ${
                  isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="mode-bg"
                    className="absolute inset-0 bg-background shadow-sm rounded-[9.5px]"
                    transition={{
                      type: "spring",
                      stiffness: 450,
                      damping: 22,
                      mass: 0.8
                    }}
                  />
                )}
                <Icon size={12} className="relative z-10" strokeWidth={2.4} />
                <span className="relative z-10 text-[10px] font-bold tracking-wider uppercase">
                  {m.label}
                </span>
              </motion.button>
            );
          })}
        </div>
        {__IS_ELECTRON__ && <CustomTitleBar />}
      </div>
    </div>
  );
}
