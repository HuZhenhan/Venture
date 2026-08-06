import React from 'react';
import { ShieldAlert, Settings } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { useAgentStore } from '../../store/agentState';
import {
  getAccessibilityPermission,
  markAccessibilityChecked,
  openAccessibilitySettings,
  resetAccessibilityCheck,
  resolvePermissionDialog,
} from '../../services/agentService';

const POLL_INTERVAL_MS = 1500;

/**
 * 无障碍权限引导弹窗（规格书 8.3）。
 *
 * 触发：进程内第一次执行需要无障碍服务的 agent 工具时，检测到权限未开启。
 * 工具循环会阻塞等待本弹窗的结果：
 * - 用户点「去开启」→ 跳转系统无障碍设置；弹窗持续轮询权限状态，
 *   检测到已开启（或从设置页返回时立即重查）→ 自动关闭并告知循环继续执行工具。
 * - 用户点「取消」→ 关闭并重置检查标志，下次工具调用会再次提示。
 */
export function AccessibilityPermissionDialog() {
  const open = useAgentStore((s) => s.permissionDialogOpen);
  const toolName = useAgentStore((s) => s.permissionDialogTool);
  const setPermissionDialog = useAgentStore((s) => s.setPermissionDialog);

  // 权限已开启 → 自动关闭弹窗并放行等待中的工具循环
  const closeWithGranted = React.useCallback(() => {
    markAccessibilityChecked();
    resolvePermissionDialog(true);
    setPermissionDialog(false);
  }, [setPermissionDialog]);

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let pollTimer: number | undefined;

    const checkPermission = async () => {
      if (cancelled) return;
      try {
        const state = await getAccessibilityPermission();
        if (state.granted === true && state.connected === true) {
          if (!cancelled) closeWithGranted();
          return true;
        }
      } catch {
        // 后端不可达：继续轮询
      }
      return false;
    };

    // 从系统设置页返回时立即重查（visibilitychange）
    const onVisible = () => {
      if (document.visibilityState === 'visible') void checkPermission();
    };
    document.addEventListener('visibilitychange', onVisible);
    // 轮询兜底（用户在设置页停留期间服务连接可能延迟建立）
    pollTimer = window.setInterval(() => void checkPermission(), POLL_INTERVAL_MS);
    void checkPermission();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (pollTimer) window.clearInterval(pollTimer);
    };
  }, [open, closeWithGranted]);

  const handleOpenSettings = () => {
    void openAccessibilitySettings();
  };

  const handleCancel = () => {
    // 用户暂时不想开启：重置检查标志（下次工具调用会再次提示），放行循环
    resetAccessibilityCheck();
    resolvePermissionDialog(false);
    setPermissionDialog(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => {
      if (!next) handleCancel();
    }}>
      <AlertDialogContent className="max-w-[340px] gap-5 rounded-2xl p-6">
        <AlertDialogHeader className="flex flex-col items-center gap-3 text-center sm:text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            <ShieldAlert size={22} className="text-amber-500" />
          </div>
          <AlertDialogTitle className="text-base">未开启无障碍服务</AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] leading-relaxed">
            执行{toolName ? (
              <span className="mx-0.5 rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">
                {toolName}
              </span>
            ) : null}
            需要「Venture 无障碍服务」权限，请前往系统设置开启。开启返回后会自动继续执行。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={handleCancel}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="flex-1 gap-1.5"
            onClick={handleOpenSettings}
          >
            <Settings size={14} />
            去开启
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
