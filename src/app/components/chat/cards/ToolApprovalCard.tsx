import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, CheckCheck, ChevronDown, ShieldAlert, X } from 'lucide-react';
import { ToolCall } from '../../../types';
import { APPLE_CURVE, CARD_EXPAND_TRANSITION, CARD_HEADER_TRANSITION } from '../../../constants';
import { formatInput, inputSummary } from './ToolCallCard';

interface ToolApprovalCardProps {
  tool: ToolCall;
  /** 同意（仅本次调用）。 */
  onApprove: (toolId: string) => void;
  /** 一律同意（完全相同（工具、参数）的调用之后自动同意）。 */
  onAlwaysApprove: (toolId: string) => void;
  /** 拒绝。 */
  onReject: (toolId: string) => void;
}

function truncateForHeader(text: string, max = 60): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/**
 * 工具调用权限询问卡片。
 *
 * 布局参考 AskCardFull：头部（图标 + 标题 + 工具名 + 参数摘要 + 展开箭头），
 * 展开区依次展示 描述（预留位置，暂未启用）→ 传入参数 → 操作按钮
 * （拒绝 / 一律同意 / 同意）。
 *
 * 卡片渲染条件为 tool.status === 'needs_approval'，该状态随会话持久化，
 * 因此软件关闭重开后卡片会照常显示、等待用户决定。
 */
export function ToolApprovalCard({ tool, onApprove, onAlwaysApprove, onReject }: ToolApprovalCardProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const summary = inputSummary(tool);
  const formattedInput = formatInput(tool.input);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.6, ease: APPLE_CURVE }}
      className="w-full max-w-[651px] overflow-hidden rounded-2xl border border-amber-500/30 text-left shadow-[0_8px_20px_-20px_rgba(3,2,19,0.15)] transition-[border-color,box-shadow] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
    >
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-colors duration-500 hover:bg-muted/40"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
          <ShieldAlert size={12} className="text-amber-500" />
        </span>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-[12px] font-medium tracking-tight whitespace-nowrap text-muted-foreground">
            权限请求
          </span>
          <span className="truncate text-[12px] font-semibold tracking-tight text-foreground">
            {tool.name}
          </span>
          {summary ? (
            <span className="truncate text-[12px] text-muted-foreground/80 font-mono">
              {truncateForHeader(summary)}
            </span>
          ) : null}
        </div>
        <motion.span animate={{ rotate: isExpanded ? 0 : 180 }} transition={CARD_HEADER_TRANSITION} className="shrink-0">
          <ChevronDown size={14} className="text-[#8e8e93]" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CARD_EXPAND_TRANSITION}
          >
            <div className="space-y-2 px-4 pb-3 pt-1">
              {/* 描述区域（预留显示位置，暂未启用：等待后续接入操作描述来源） */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                  描述
                </div>
                <p className="text-[12px] leading-5 text-muted-foreground/60">
                  {tool.description ?? '暂无描述'}
                </p>
              </div>

              {/* 传入参数 */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                  传入参数
                </div>
                <pre className="max-h-[240px] overflow-auto rounded-xl border border-border bg-muted/30 p-3 text-[11px] leading-relaxed text-foreground/90 font-mono whitespace-pre-wrap break-all">
                  {formattedInput || '{}'}
                </pre>
              </div>

              {/* 操作按钮 */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onReject(tool.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] whitespace-nowrap text-muted-foreground hover:text-[#d65a54] transition-colors"
                >
                  <X size={11} />
                  拒绝
                </button>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onAlwaysApprove(tool.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] whitespace-nowrap font-medium rounded-lg border border-border text-foreground hover:bg-muted/50 transition-all"
                  >
                    <CheckCheck size={11} />
                    一律同意
                  </button>
                  <button
                    type="button"
                    onClick={() => onApprove(tool.id)}
                    className="flex items-center gap-1.5 px-3 py-1 text-[11px] whitespace-nowrap font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all"
                  >
                    <Check size={11} />
                    同意
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
