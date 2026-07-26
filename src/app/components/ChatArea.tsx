import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useChatStore } from "../store/useChatStore";
import { useChatScroll } from "../hooks/useChatScroll";
import { MessageList } from "./chat/MessageList";
import { ChatInput } from "./chat/ChatInput";
import { TraceView } from "./chat/TraceView";

export const ChatArea = React.memo(function ChatArea() {
  // Only subscribe to activeChatId (not the full chat object) so ChatArea
  // doesn't re-render on every message update during streaming.
  // MessageList manages its own subscription to the chat content.
  const activeChatId = useChatStore((state) => state.activeChatId);
  const tracedChatId = useChatStore((state) => state.tracedChatId);

  const INPUT_DOCK_COMFORT_GAP = 24;
  const [inputDockHeight, setInputDockHeight] = useState(220);
  const scrollBottomInset = inputDockHeight + INPUT_DOCK_COMFORT_GAP;
  const inputAreaRef = useRef<HTMLDivElement>(null);

  const {
    scrollContainerRef,
    forceScrollToBottom
  } = useChatScroll();

  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el) return;

    const updateDockHeight = () => {
      const nextHeight = Math.ceil(el.getBoundingClientRect().height);
      setInputDockHeight((prev) => (Math.abs(prev - nextHeight) <= 1 ? prev : nextHeight));
    };

    updateDockHeight();
    const observer = new ResizeObserver(() => updateDockHeight());
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  const isTracing = tracedChatId !== null && tracedChatId === activeChatId;

  return (
    <div className="flex-1 flex flex-col relative h-full bg-background overflow-hidden">
      <div className="flex-1 relative overflow-hidden flex">
        {/* 正常聊天界面 —— 追踪开启时仍继续显示，用户可正常发消息 */}
        <div className="flex-1 relative overflow-hidden">
          <AnimatePresence mode="popLayout" initial={true}>
            <motion.div
              key={activeChatId ?? "empty"}
              initial={{ x: "12%", opacity: 0, scale: 0.99 }}
              animate={{ x: 0, opacity: 1, scale: 1 }}
              exit={{ x: "-10%", opacity: 0, scale: 0.99 }}
              className="absolute inset-0 flex flex-col"
              style={{ backfaceVisibility: 'hidden', transformStyle: 'preserve-3d' }}
              transition={{ type: "spring", stiffness: 450, damping: 40, mass: 0.8, restDelta: 0.001 }}
            >
              <MessageList
                scrollContainerRef={scrollContainerRef}
                paddingBottom={scrollBottomInset}
              />
            </motion.div>
          </AnimatePresence>
        </div>

        {/* 追踪叠加面板 —— 只读显示，不影响左侧聊天交互 */}
        <AnimatePresence>
          {isTracing && (
            <motion.div
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 40, mass: 0.8 }}
              className="h-full shrink-0"
            >
              <TraceView />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ChatInput inputAreaRef={inputAreaRef} onMessageSent={forceScrollToBottom} />
    </div>
  );
});
