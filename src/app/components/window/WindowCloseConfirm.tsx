import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { APPLE_CURVE } from '../../constants';

/**
 * 桌面版关闭确认弹窗。
 *
 * 主进程拦截窗口 close 事件（点 X / Alt+F4）后发送 `window-close-requested`，
 * 此处弹出确认框，用户可选择：取消 / 最小化到托盘 / 退出。
 */
export function WindowCloseConfirm() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!window.desktopShell?.onCloseRequested) return;
    return window.desktopShell.onCloseRequested(() => setOpen(true));
  }, []);

  const handleHideToTray = () => {
    setOpen(false);
    window.desktopShell?.hideToTray();
  };

  const handleQuit = () => {
    setOpen(false);
    window.desktopShell?.quitApp();
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
            <div className="flex flex-col gap-2 pt-7">
              <button
                onClick={handleHideToTray}
                className="w-full rounded-[24px] bg-primary py-3 text-[13px] font-bold text-primary-foreground shadow-xl transition-all hover:shadow-2xl active:scale-[0.98]"
              >
                最小化到托盘
              </button>
              <button
                onClick={handleQuit}
                className="w-full rounded-[24px] border border-border py-3 text-[13px] font-bold text-foreground transition-all hover:bg-muted/50 active:scale-[0.98]"
              >
                退出
              </button>
              <button
                onClick={() => setOpen(false)}
                className="w-full rounded-[24px] py-3 text-[13px] font-bold text-muted-foreground transition-all hover:text-foreground"
              >
                取消
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
