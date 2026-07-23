import React, { useState, useCallback, memo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, MessageSquare, MoreHorizontal, GripVertical } from 'lucide-react';
import { MIN_SIDEBAR_WIDTH, APPLE_CURVE, DURATION } from '../constants';
import { useChatStore } from '../store/useChatStore';
import { selectResponsiveLayout, useLayoutStore } from '../store/useLayoutStore';
import { beginHorizontalResize } from '../utils/panelResize';
import { SidebarContextMenu } from './SidebarContextMenu';
import { Chat } from '../types';

// ─── ChatItem ─────────────────────────────────────────────────────────────────
// Memoized individual chat item — only re-renders when its own data changes,
// not when sibling chats update.
interface ChatItemProps {
  chat: Chat;
  isActive: boolean;
  isEditing: boolean;
  editValue: string;
  hasContextMenu: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onContextMenuBtn: (e: React.MouseEvent, id: string) => void;
  onEditChange: (val: string) => void;
  onEditBlur: () => void;
  onEditKeyDown: (e: React.KeyboardEvent) => void;
}

const ChatItem = memo(function ChatItem({
  chat,
  isActive,
  isEditing,
  editValue,
  hasContextMenu,
  onSelect,
  onContextMenu,
  onContextMenuBtn,
  onEditChange,
  onEditBlur,
  onEditKeyDown,
}: ChatItemProps) {
  return (
    <motion.div
      initial={false}
      onClick={() => !isEditing && onSelect(chat.id)}
      onContextMenu={(e) => onContextMenu(e, chat.id)}
      className={`group relative flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
        isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {isActive && (
        <motion.div
          layoutId="active-pill"
          className="absolute inset-0 bg-background shadow-[0_4px_16px_rgba(0,0,0,0.08)] border border-border rounded-xl z-0"
          transition={{ duration: DURATION.normal, ease: APPLE_CURVE }}
        />
      )}

      {!isActive && !hasContextMenu && (
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 bg-muted/60 rounded-xl transition-all duration-300 z-0" />
      )}

      {!isActive && hasContextMenu && (
        <div className="absolute inset-0 bg-muted/80 rounded-xl z-0" />
      )}

      <div className="relative z-10 flex items-center gap-3 truncate w-full">
        <motion.div
          animate={{ color: isActive ? "var(--foreground)" : "var(--muted-foreground)" }}
          transition={{ duration: DURATION.fast + 0.02, ease: APPLE_CURVE }}
        >
          <MessageSquare className="w-3.5 h-3.5 shrink-0" />
        </motion.div>

        {isEditing ? (
          <input
            autoFocus
            className="bg-transparent border-none outline-none text-[13px] w-full font-medium"
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onBlur={onEditBlur}
            onKeyDown={onEditKeyDown}
          />
        ) : (
          <motion.span
            animate={{
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--foreground)" : "var(--muted-foreground)",
            }}
            className="text-[13px] truncate tracking-tight"
            transition={{ duration: DURATION.fast + 0.02, ease: APPLE_CURVE }}
          >
            {chat.title}
          </motion.span>
        )}
      </div>

      <div className="relative z-10 flex items-center shrink-0">
        <button
          onClick={(e) => onContextMenuBtn(e, chat.id)}
          className={`p-1 rounded-lg transition-all ${
            isActive || hasContextMenu
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100'
          } text-muted-foreground hover:text-foreground`}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>
    </motion.div>
  );
});

// ─── Sidebar ──────────────────────────────────────────────────────────────────
export const Sidebar: React.FC = () => {
  const chats = useChatStore((state) => state.chats);
  const activeChatId = useChatStore((state) => state.activeChatId);
  const renameChat = useChatStore((state) => state.renameChat);
  const setActiveChatId = useChatStore((state) => state.setActiveChatId);
  const shouldUseSidebarOverlay = useLayoutStore((state) => selectResponsiveLayout(state).shouldUseSidebarOverlay);
  const isSidebarOpen = useLayoutStore((state) => state.isSidebarOpen);
  const sidebarWidth = useLayoutStore((state) => state.sidebarWidth);
  const setSidebarWidth = useLayoutStore((state) => state.setSidebarWidth);
  const isResizingSidebar = useLayoutStore((state) => state.isResizingSidebar);
  const setIsResizingSidebar = useLayoutStore((state) => state.setIsResizingSidebar);
  const commitWidths = useLayoutStore((state) => state.commitWidths);

  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renameDraft, setRenameDraft] = useState<{ id: string; value: string } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ id, x: e.clientX, y: e.clientY });
  }, []);

  const handleContextMenuBtn = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    handleContextMenu(e, id);
  }, [handleContextMenu]);

  const startEditing = useCallback((id: string, title: string) => {
    setRenameDraft({ id, value: title });
    setContextMenu(null);
  }, []);

  const saveRename = useCallback(() => {
    if (renameDraft?.value.trim()) {
      renameChat(renameDraft.id, renameDraft.value.trim());
    }
    setRenameDraft(null);
  }, [renameChat, renameDraft]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveRename();
    if (e.key === 'Escape') setRenameDraft(null);
  }, [saveRename]);

  const handleSelect = useCallback((id: string) => {
    setActiveChatId(id);
  }, [setActiveChatId]);

  const handleNewChat = useCallback(() => {
    setActiveChatId(null);
  }, [setActiveChatId]);

  return (
    <>
      <motion.aside
        initial={false}
        animate={{
          width: isSidebarOpen ? sidebarWidth : 0,
          opacity: isSidebarOpen ? 1 : 0,
        }}
        className={`h-full bg-background/80 backdrop-blur-2xl border-r border-border flex flex-col shrink-0 relative z-30 transform-gpu antialiased scrollbar-hide overflow-visible ${
          shouldUseSidebarOverlay ? 'absolute inset-y-0 left-0' : ''
        } ${!isSidebarOpen ? 'pointer-events-none' : ''}`}
        transition={{
          width: isResizingSidebar
            ? { duration: 0 }
            : { duration: DURATION.panel, ease: APPLE_CURVE },
          opacity: { duration: DURATION.fast + 0.02 },
        }}
      >
        <div
          className="h-full w-full flex flex-col relative overflow-hidden"
        >
          {/* Header */}
          <div className="px-5 flex items-center justify-between h-[52px] shrink-0 border-b border-black/[0.03]">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-[#1C1C1E]/60">
                Venture AI
              </span>
            </div>
          </div>

          {/* New Chat Button */}
          <div className="px-4 pt-4 mb-6">
            <button
              onClick={handleNewChat}
              className="w-full flex items-center justify-center gap-2 py-3 bg-muted hover:bg-muted/80 border border-border rounded-2xl text-[13px] font-medium transition-all active:scale-[0.98] group"
            >
              <Plus className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <span className="text-foreground">新建对话</span>
            </button>
          </div>

          {/* History List */}
          <div className="flex-1 px-4 space-y-1 overflow-y-auto custom-scrollbar">
            <h2 className="px-3 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em] mb-4">
              最近对话
            </h2>
            {chats.map((chat) => (
              <ChatItem
                key={chat.id}
                chat={chat}
                isActive={chat.id === activeChatId}
                isEditing={renameDraft?.id === chat.id}
                editValue={renameDraft?.value ?? ''}
                hasContextMenu={contextMenu?.id === chat.id}
                onSelect={handleSelect}
                onContextMenu={handleContextMenu}
                onContextMenuBtn={handleContextMenuBtn}
                onEditChange={(value) => setRenameDraft((current) => (current ? { ...current, value } : current))}
                onEditBlur={saveRename}
                onEditKeyDown={handleEditKeyDown}
              />
            ))}
          </div>

          {/* Resize Handle */}
          {isSidebarOpen && (
            <div
              className="absolute top-0 right-[-2px] w-[5px] h-full cursor-col-resize hover:bg-[#007AFF]/20 transition-colors z-50 group active:bg-[#007AFF]/40"
              onMouseDown={(e) => {
                beginHorizontalResize({
                  startEvent: e,
                  initialWidth: sidebarWidth,
                  minWidth: MIN_SIDEBAR_WIDTH,
                  maxWidth: 600,
                  direction: 'expand-right',
                  setWidth: setSidebarWidth,
                  setIsResizing: setIsResizingSidebar,
                  getActualWidth: () => useLayoutStore.getState().getResponsiveWidths().sidebarWidth,
                  onResizeStart: commitWidths,
                });
              }}
            >
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                <GripVertical size={12} className="text-[#8E8E93]" />
              </div>
            </div>
          )}
        </div>
      </motion.aside>

      <AnimatePresence>
        {contextMenu && (
          <SidebarContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            chatId={contextMenu.id}
            onClose={() => setContextMenu(null)}
            onRename={startEditing}
          />
        )}
      </AnimatePresence>
    </>
  );
};
