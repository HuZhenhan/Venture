import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Eye,
  FilePen,
  FileSearch,
  FileText,
  FolderSearch,
  ListPlus,
  List as ListIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Rocket,
  Search,
  Workflow,
  Wrench,
  XCircle,
} from 'lucide-react';
import { ToolCall, ToolCallStatus } from '../../../types';
import { APPLE_CURVE, CARD_EXPAND_TRANSITION, CARD_HEADER_TRANSITION } from '../../../constants';
import { getToolCardClasses } from './toolCardStyles';

interface ToolCallCardProps {
  tool: ToolCall;
}

const TOOL_ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Read: FileText,
  Write: FilePen,
  Edit: Pencil,
  Glob: FolderSearch,
  Grep: FileSearch,
  TodoCreate: ListPlus,
  TodoUpdate: RefreshCw,
  TodoList: ListIcon,
  TodoGet: Eye,
  spawn_agent: Rocket,
  get_agent_output: Eye,
  kill_agent: XCircle,
  run_workflow: Workflow,
  AskUserQuestion: Eye,
};

function getToolIcon(name: string) {
  return TOOL_ICON_MAP[name] ?? Wrench;
}

const STATUS_META: Record<ToolCallStatus, { label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  pending: { label: '待执行', icon: CircleAlert },
  running: { label: '执行中', icon: Loader2 },
  completed: { label: '已完成', icon: Check },
  failed: { label: '失败', icon: CircleAlert },
  needs_user_input: { label: '等待回复', icon: CircleAlert },
  needs_approval: { label: '待授权', icon: CircleAlert },
};

export function formatInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function truncateForHeader(text: string, max = 60): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function inputSummary(tool: ToolCall): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || input === null) return '';

  switch (tool.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof input.file_path === 'string' ? input.file_path : '';
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : '';
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : '';
    case 'TodoCreate':
      return typeof input.subject === 'string' ? input.subject : '';
    case 'TodoUpdate':
    case 'TodoGet':
      return typeof input.todoId === 'string' ? `#${input.todoId}` : '';
    case 'TodoList':
      return '';
    case 'spawn_agent':
      return typeof input.description === 'string' ? input.description : '';
    case 'AskUserQuestion':
      return typeof input.question === 'string' ? input.question : '';
    default:
      return '';
  }
}

export function ToolCallCard({ tool }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(tool.status === 'running' || tool.status === 'failed');
  const styles = getToolCardClasses(isExpanded);

  const ToolIcon = getToolIcon(tool.name);
  const statusMeta = STATUS_META[tool.status] ?? STATUS_META.pending;
  const StatusIcon = statusMeta.icon;
  const isRunning = tool.status === 'running';
  const isError = tool.status === 'failed';

  const summary = inputSummary(tool);
  const formattedInput = formatInput(tool.input);
  const formattedOutput = tool.output ?? '';

  const statusColorClass = isError
    ? 'text-[#d65a54]'
    : isRunning
      ? 'text-[#0a84ff]'
      : tool.status === 'completed'
        ? 'text-[#34c759]'
        : 'text-muted-foreground';

  const statusBgClass = isError
    ? 'bg-[#d65a54]/10'
    : isRunning
      ? 'bg-[#0a84ff]/10'
      : tool.status === 'completed'
        ? 'bg-[#34c759]/10'
        : 'bg-muted/50';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.6, ease: APPLE_CURVE }}
      className="w-full max-w-[651px] overflow-hidden rounded-2xl border border-border text-left shadow-[0_8px_20px_-20px_rgba(3,2,19,0.15)] transition-[border-color,box-shadow] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
    >
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-colors duration-500 hover:bg-muted/40"
      >
        <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${statusBgClass}`}>
          <StatusIcon
            size={12}
            className={`${statusColorClass} ${isRunning ? 'animate-spin' : ''}`}
          />
        </span>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <ToolIcon size={13} className="shrink-0 text-muted-foreground" />
          <span className={`text-[12px] font-medium tracking-tight whitespace-nowrap ${styles.eyebrow}`}>
            {statusMeta.label}
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
        {isExpanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CARD_EXPAND_TRANSITION}
          >
            <div className="space-y-3 px-11 pb-4 pt-2">
              {/* 输入参数 */}
              {formattedInput ? (
                <div>
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
                    <Search size={11} />
                    <span>输入</span>
                  </div>
                  <pre className={`${styles.codeBlock} max-h-[240px] overflow-auto`}>
                    {formattedInput}
                  </pre>
                </div>
              ) : null}

              {/* 输出结果 */}
              {formattedOutput ? (
                <div>
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
                    {isError ? <CircleAlert size={11} className="text-[#d65a54]" /> : <Check size={11} className="text-[#34c759]" />}
                    <span>{isError ? '错误' : '输出'}</span>
                  </div>
                  <pre className={`${styles.codeBlock} max-h-[320px] overflow-auto ${isError ? 'border-[#d65a54]/30 text-[#d65a54]/90' : ''}`}>
                    {formattedOutput}
                  </pre>
                </div>
              ) : null}

              {/* 运行中占位 */}
              {isRunning && !formattedOutput ? (
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" />
                  <span>正在执行工具调用…</span>
                </div>
              ) : null}

              {/* 等待执行占位 */}
              {tool.status === 'pending' ? (
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70">
                  <CircleAlert size={12} />
                  <span>等待系统执行…</span>
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
