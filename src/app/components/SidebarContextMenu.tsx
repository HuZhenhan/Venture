import React from 'react';
import { motion } from 'motion/react';
import { Edit2, Layers, Archive, FileJson, Trash2 } from 'lucide-react';
import { useChatStore } from '../store/useChatStore';
import { resolveFloatingPosition } from '../utils/floatingPosition';

interface SidebarContextMenuProps {
  x: number;
  y: number;
  chatId: string;
  onClose: () => void;
  onRename: (id: string, title: string) => void;
}

export const SidebarContextMenu: React.FC<SidebarContextMenuProps> = ({
  x,
  y,
  chatId,
  onClose,
  onRename
}) => {
  const { chats, deleteChat, cloneChat } = useChatStore();
  const chat = chats.find(c => c.id === chatId);
  const position = resolveFloatingPosition({ x, y, width: 180, height: 200 });

  return (
    <div className="fixed inset-0 z-[1000] pointer-events-none">
      <div 
        className="absolute inset-0 pointer-events-auto" 
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: -10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -10 }}
        transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
        style={{ 
          position: 'fixed', 
          left: position.left,
          top: position.top,
          zIndex: 1001,
          transformOrigin: 'top left',
          pointerEvents: 'auto'
        }}
        className="w-44 bg-background/85 backdrop-blur-2xl border border-border rounded-xl shadow-[0_20px_40px_-10px_rgba(0,0,0,0.2)] overflow-hidden p-1.5 transform-gpu antialiased"
      >
        <button
          onClick={() => {
            if (chat) onRename(chat.id, chat.title);
            onClose();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-foreground hover:bg-muted/50 rounded-lg transition-colors"
        >
          <Edit2 className="w-3.5 h-3.5 opacity-60" />
          <span>重命名</span>
        </button>
        <button
          onClick={() => {
            if (chat) cloneChat(chat.id);
            onClose();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-foreground hover:bg-muted/50 rounded-lg transition-colors"
        >
          <Layers className="w-3.5 h-3.5 opacity-60" />
          <span>复制</span>
        </button>
        <div className="h-[1px] bg-muted/50 my-1 mx-1.5" />
        <button
          disabled
          className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-muted-foreground rounded-lg cursor-not-allowed opacity-50"
          title="功能待实现"
        >
          <Archive className="w-3.5 h-3.5 opacity-60" />
          <span>归档</span>
        </button>
        <button
          disabled
          className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-muted-foreground rounded-lg cursor-not-allowed opacity-50"
          title="功能待实现"
        >
          <FileJson className="w-3.5 h-3.5 opacity-60" />
          <span>元数据</span>
        </button>
        <div className="h-[1px] bg-muted/50 my-1 mx-1.5" />
        <button
          onClick={() => {
            deleteChat(chatId);
            onClose();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>删除</span>
        </button>
      </motion.div>
    </div>
  );
};
