import { motion, AnimatePresence } from "motion/react";
import { ShieldAlert, Check, ShieldCheck, X } from "lucide-react";
import { useSubagentStore } from "../store/useSubagentStore";

/**
 * 子代理权限审批横幅（设计稿 §11.2 适配：Ask 效果的决策方为前端审批 UI）。
 *
 * 子代理运行中命中 Ask 规则时，coordinator 经 SSE 推送
 * subagent_permission_request；本横幅渲染审批卡片（approve /
 * always_approve / reject），决策经 HTTP 回填，30s 无响应后端默认拒绝。
 */
export function SubagentPermissionBanner() {
  const pendingPermissions = useSubagentStore((s) => s.pendingPermissions);
  const resolvePermission = useSubagentStore((s) => s.resolvePermission);

  if (pendingPermissions.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[90] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {pendingPermissions.map((req) => (
          <motion.div
            key={req.requestId}
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            className="pointer-events-auto w-full max-w-lg rounded-xl border bg-background/95 shadow-lg backdrop-blur"
          >
            <div className="flex items-start gap-3 p-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-500">
                <ShieldAlert size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  子代理请求使用工具：<code className="rounded bg-muted px-1 py-0.5 text-xs">{req.tool}</code>
                </div>
                <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
                  {formatInput(req.input)}
                </pre>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                    onClick={() => void resolvePermission(req.requestId, "approve")}
                  >
                    <Check size={12} /> 同意
                  </button>
                  <button
                    className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
                    onClick={() => void resolvePermission(req.requestId, "always_approve")}
                  >
                    <ShieldCheck size={12} /> 一律同意
                  </button>
                  <button
                    className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                    onClick={() => void resolvePermission(req.requestId, "reject")}
                  >
                    <X size={12} /> 拒绝
                  </button>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    30 秒无响应将自动拒绝
                  </span>
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function formatInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input.slice(0, 500);
  try {
    return JSON.stringify(input, null, 2).slice(0, 500);
  } catch {
    return String(input).slice(0, 500);
  }
}
