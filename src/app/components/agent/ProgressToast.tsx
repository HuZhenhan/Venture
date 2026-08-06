import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { useAgentStore } from '../../store/agentState';

const AUTO_DISMISS_MS = 4000;

/**
 * report_progress 悬浮提示（规格书 6.4：前端流式展示，不中断循环）。
 * 读取 agentState 中最近一次进度消息，自动消隐。
 */
export function ProgressToast() {
  const progressMessage = useAgentStore((s) => s.progressMessage);
  const clearProgressMessage = useAgentStore((s) => s.clearProgressMessage);

  React.useEffect(() => {
    if (!progressMessage) return;
    const timer = window.setTimeout(clearProgressMessage, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [progressMessage, clearProgressMessage]);

  return (
    <AnimatePresence>
      {progressMessage && (
        <motion.div
          key={progressMessage.ts}
          initial={{ opacity: 0, y: -12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ duration: 0.3, ease: APPLE_CURVE }}
          className="pointer-events-none fixed left-1/2 top-14 z-[9998] -translate-x-1/2"
        >
          <div className="flex items-center gap-2 rounded-full border border-border bg-background/90 px-4 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur-xl">
            <Loader2 size={13} className="animate-spin text-muted-foreground" />
            <span className="text-[12px] font-medium text-foreground">{progressMessage.message}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
