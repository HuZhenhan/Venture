import React, { useCallback, useRef } from "react";
import { motion } from "motion/react";
import { useChatStore } from "../../store/useChatStore";
import { MessageItem, ScrollRootCtx, VirtualMessage } from "./message/MessageListParts";
import { useMessageListActions } from "./message/useMessageListActions";
import { TypewriterHeading } from "./TypewriterHeading";

// ─── MessageList ──────────────────────────────────────────────────────────────
interface MessageListProps {
  scrollContainerRef: React.Ref<HTMLDivElement>;
  paddingBottom: number;
}

export function MessageList({ scrollContainerRef, paddingBottom }: MessageListProps) {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const chat = useChatStore(
    (state) => state.chats.find((c) => c.id === state.activeChatId) ?? null
  );
  const isGenerating = useChatStore(
    (state) =>
      state.generatingChatId !== null &&
      state.generatingChatId === state.activeChatId
  );
  const actions = useMessageListActions(chat, activeChatId);

  // Stable ref to scroll container — shared via context with VirtualMessage
  const localScrollRef = useRef<HTMLDivElement | null>(null);

  // Merge external scrollContainerRef with local one
  const mergedScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      localScrollRef.current = node;
      if (typeof scrollContainerRef === "function") {
        scrollContainerRef(node);
      } else if (scrollContainerRef) {
        (scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [scrollContainerRef]
  );

  // ── Empty state ──
  if (!chat || chat.messages.length === 0) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center w-full select-none"
        style={{ paddingBottom: `${paddingBottom}px` }}
      >
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 1.0, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col items-center justify-center text-center w-full px-4 select-none"
        >
          <TypewriterHeading />
          <p className="text-muted-foreground text-[15px] sm:text-[17px] max-w-sm mx-auto font-medium leading-relaxed">
            剥离冗余，让每一次对话都直抵思维的本质。
          </p>
        </motion.div>
      </div>
    );
  }

  const lastMessageId = chat.messages[chat.messages.length - 1].id;
  let latestUsageMessageId: string | null = null;
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (message.role === "ai" && message.usage) {
      latestUsageMessageId = message.id;
      break;
    }
  }

  return (
    <ScrollRootCtx.Provider value={localScrollRef}>
      <div
        ref={mergedScrollRef}
        className="flex-1 flex flex-col overflow-y-auto px-4 sm:px-12 custom-scrollbar-chat"
      >
        <div className="max-w-3xl mx-auto w-full space-y-12 py-10">
          {chat.messages.map((message) => {
            const isLastMessage = message.id === lastMessageId;
            // Lock (always render) the message that is currently being generated
            const isLocked =
              isLastMessage && (isGenerating || message.status === "typing");

            return (
              <VirtualMessage key={message.id} isLocked={isLocked}>
                {(skipAnimation) => (
                  <MessageItem
                    message={message}
                    isLastMessage={isLastMessage}
                    showUsageInfo={message.id === latestUsageMessageId}
                    isGenerating={isGenerating}
                    skipAnimation={skipAnimation}
                    copiedId={actions.copiedId}
                    showUndoConfirm={actions.showUndoConfirm}
                    onCopy={actions.handleCopy}
                    onShowUndoConfirm={actions.setShowUndoConfirm}
                    onRegenerate={actions.handleRegenerate}
                    onUndo={actions.handleUndo}
                    onOpenDiff={actions.handleOpenDiff}
                    onOpenCodeReference={actions.handleOpenCodeReference}
                    onOpenComposerReference={actions.handleOpenComposerReference}
                    onConfirmFileOp={actions.handleConfirmFileOpCb}
                    onRejectFileOp={actions.handleRejectFileOpCb}
                    onUpdateAskBlock={actions.handleUpdateAskBlock}
                    onSkipAskBlock={actions.handleSkipAskBlock}
                    onMarkdownComplete={actions.handleMarkdownComplete}
                  />
                )}
              </VirtualMessage>
            );
          })}
        </div>
        {/* 占位块：撑开输入框高度，确保最后一条消息滚动到底时不被遮挡 */}
        <div style={{ height: paddingBottom, flexShrink: 0 }} aria-hidden="true" />
      </div>
    </ScrollRootCtx.Provider>
  );
}
