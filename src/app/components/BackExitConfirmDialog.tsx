import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLayoutStore } from '../store/useLayoutStore';
import { isAndroid } from '../utils/platform';
import { APPLE_CURVE } from '../constants';

/**
 * Android 层级返回 + 退出确认。
 *
 * 原生端（MainActivity）拦截系统返回键后派发 `venture-back` 事件：
 * - 处于二级页面（设置/浏览器/工作流/脚本等）→ 返回主对话页
 * - 处于主对话页 → 弹出退出确认框，确认后调用 Rust 端 `quit_app` 退出
 */
export function BackExitConfirmDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isAndroid()) return;

    const handleBack = () => {
      const state = useLayoutStore.getState();
      // 非主对话页（singlePageView 为设置/浏览器/工作流/脚本等）→ 层级返回
      if (state.singlePageView !== 'chat' || state.activeWorkspaceView !== 'chat') {
        state.showChatPanel();
        return;
      }
      // 主对话页 → 弹退出确认，不直接退出
      setOpen(true);
    };

    window.addEventListener('venture-back', handleBack);
    return () => window.removeEventListener('venture-back', handleBack);
  }, []);

  const handleQuit = () => {
    setOpen(false);
    void invoke('quit_app');
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-md"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 30 }}
            transition={{ type: 'spring', stiffness: 350, damping: 30, mass: 0.8 }}
            className="relative w-full max-w-sm transform-gpu rounded-[32px] border border-border bg-background p-7 shadow-2xl"
          >
            <div className="space-y-1.5">
              <h3 className="text-[19px] font-bold tracking-tight text-foreground">退出 Venture？</h3>
              <p className="text-[13px] leading-5 text-muted-foreground">
                对话内容会自动保存，退出后可在历史记录中继续查看。
              </p>
            </div>
            <div className="flex gap-3 pt-7">
              <button
                onClick={() => setOpen(false)}
                className="flex-1 rounded-[24px] border border-border py-3 text-[13px] font-bold text-foreground transition-all hover:bg-muted/50 active:scale-[0.98]"
              >
                取消
              </button>
              <button
                onClick={handleQuit}
                className="flex-1 rounded-[24px] bg-primary py-3 text-[13px] font-bold text-primary-foreground shadow-xl transition-all hover:shadow-2xl active:scale-[0.98]"
              >
                退出
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
