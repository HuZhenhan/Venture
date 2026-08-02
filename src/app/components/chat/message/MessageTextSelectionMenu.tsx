import React, { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Copy, Quote } from "lucide-react";
import { ComposerReference } from "../../../types";
import { INSERT_CHAT_EVENT } from "../../../utils/codeReferences";
import { copyTextToClipboard } from "../../../utils/clipboard";
import { toast } from "sonner";

interface MessageSelectionMenuState {
  x: number;
  y: number;
  text: string;
}

const MENU_WIDTH = 176;
const MENU_HEIGHT = 96;

/**
 * 消息文本选中后的右键菜单（复制 / 引用）。
 * 仅当用户选中了本消息气泡内的文本时才弹出；
 * 引用会构造 ComposerReference（kind: 'chat'）并通过 INSERT_CHAT_EVENT
 * 插入输入框，用于对 AI 回复的某一段内容进行追问。
 */
export function MessageTextSelectionMenu({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<MessageSelectionMenuState | null>(null);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    if (!selectedText || selection?.isCollapsed) return;

    // 选中内容必须来自当前消息气泡内部，避免弹出其他区域的残留选择
    const container = event.currentTarget;
    const anchorInside = !!selection.anchorNode && container.contains(selection.anchorNode);
    const focusInside = !!selection.focusNode && container.contains(selection.focusNode);
    if (!anchorInside && !focusInside) return;

    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      text: selectedText,
    });
  }, []);

  useEffect(() => {
    if (!menu) return;

    const handleMouseDown = () => setMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu]);

  const handleCopy = useCallback(async () => {
    if (!menu) return;
    await copyTextToClipboard(menu.text);
    toast.success("已复制到剪贴板");
    setMenu(null);
  }, [menu]);

  const handleQuote = useCallback(() => {
    if (!menu) return;
    const text = menu.text;
    const reference: ComposerReference = {
      id: crypto.randomUUID(),
      kind: "chat",
      label: text.length > 24 ? `${text.slice(0, 24)}…` : text,
      detail: text,
      description: "消息引用",
    };
    document.dispatchEvent(new CustomEvent(INSERT_CHAT_EVENT, {
      detail: { references: [reference] },
    }));
    setMenu(null);
  }, [menu]);

  return (
    <>
      <div className="contents" onContextMenu={handleContextMenu}>
        {children}
      </div>
      {menu ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="fixed z-[200] w-44 rounded-xl border border-border bg-background p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.25)]"
          style={{
            left: Math.min(menu.x, window.innerWidth - MENU_WIDTH),
            top: Math.min(menu.y, window.innerHeight - MENU_HEIGHT),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleCopy}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            <Copy size={14} className="shrink-0 text-muted-foreground" />
            复制
          </button>
          <button
            type="button"
            onClick={handleQuote}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            <Quote size={14} className="shrink-0 text-muted-foreground" />
            引用
          </button>
        </motion.div>
      ) : null}
    </>
  );
}
