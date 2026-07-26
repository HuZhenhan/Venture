import React, {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, Check, ChevronDown, Clock, Copy, Lightbulb, RotateCcw, Undo2 } from 'lucide-react';
import { CodeReference, ComposerReference, ContentBlock, Message } from '../../../types';
import { APPLE_CURVE, CARD_EXPAND_TRANSITION, CARD_HEADER_TRANSITION } from '../../../constants';
import { ComposerReferencePill } from '../cards/ComposerReferencePill';
import { CodeReferenceCard } from '../cards/CodeReferenceCard';
import { FileOpCard } from '../cards/FileOpCard';
import { SearchCard } from '../cards/SearchCard';
import { SkillCard } from '../cards/SkillCard';
import { WebSearchCard } from '../cards/WebSearchCard';
import { DiffPreview } from '../../DiffPreview';
import { ReasoningDisplay } from '../../ReasoningDisplay';
import { TaskDisplay } from '../../TaskDisplay';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { usePreferencesStore } from '../../../store/usePreferencesStore';
import { useChatStore } from '../../../store/useChatStore';
import { useLayoutStore } from '../../../store/useLayoutStore';
import { getResidualMessageBlocks, getAskForms, adaptLegacyMessageContent } from '../../../utils/messageContentProtocol';
import { MessageContentRenderer } from './MessageContentRenderer';

export const ScrollRootCtx = createContext<React.MutableRefObject<HTMLDivElement | null>>({ current: null });

const ACTION_BAR_HOVER_REVEAL_DELAY_MS = 280;
const ACTION_BAR_HOVER_MOVE_TOLERANCE_PX = 8;

interface VirtualMessageProps {
  isLocked: boolean;
  children: (skipAnimation: boolean) => React.ReactNode;
}

interface MessageBlockProps {
  block: ContentBlock;
  blockIdx: number;
  message: Message;
  isLastBlock: boolean;
  onOpenDiff: (id: string) => void;
  onOpenCodeReference: (reference: CodeReference) => void;
  onOpenComposerReference: (reference: ComposerReference) => void;
  onConfirmFileOp: (messageId: string, fileOpId: string) => void;
  onRejectFileOp: (messageId: string, fileOpId: string) => void;
  onMarkdownComplete: (messageId: string) => void;
}

interface MessageItemProps {
  message: Message;
  isLastMessage: boolean;
  showUsageInfo: boolean;
  isGenerating: boolean;
  skipAnimation: boolean;
  copiedId: string | null;
  showUndoConfirm: string | null;
  onCopy: (content: string, id: string) => void;
  onShowUndoConfirm: (id: string | null) => void;
  onRegenerate: (messageId?: string) => void;
  onUndo: (messageId?: string) => void;
  onOpenDiff: (id: string) => void;
  onOpenCodeReference: (reference: CodeReference) => void;
  onOpenComposerReference: (reference: ComposerReference) => void;
  onConfirmFileOp: (messageId: string, fileOpId: string) => void;
  onRejectFileOp: (messageId: string, fileOpId: string) => void;
  onUpdateAskBlock: (messageId: string, askId: string, answer: { selectedOptions?: string[]; text?: string }) => void;
  onSkipAskBlock: (messageId: string, askId: string) => void;
  onMarkdownComplete: (messageId: string) => void;
}

function getCachedTokens(message: Message): number {
  return message.usage?.prompt_cache_hit_tokens ?? message.usage?.prompt_tokens_details?.cached_tokens ?? 0;
}

function getCacheHitRate(message: Message): number {
  const cached = getCachedTokens(message);
  const prompt = message.usage?.prompt_tokens ?? 0;
  const cacheMiss = message.usage?.prompt_cache_miss_tokens ?? 0;
  const cacheBase = cached + cacheMiss;
  const denominator = cacheBase > 0 ? cacheBase : prompt;
  return denominator > 0 ? Math.round((cached / denominator) * 100) : 0;
}

function formatTokenCount(value?: number): string {
  const safeValue = Math.max(0, value ?? 0);
  if (safeValue >= 1_000_000) return `${(safeValue / 1_000_000).toFixed(1)}M`;
  if (safeValue >= 1_000) return `${(safeValue / 1_000).toFixed(1)}K`;
  return String(safeValue);
}

function formatTokenUnit(value?: number): string {
  return `${formatTokenCount(value)} tokens`;
}

function getMessageReferences(message: Message) {
  return message.blocks?.find((item) => item.type === 'reference_list')?.references ?? [];
}

function UserTextWithReferencePills({
  content,
  references,
  onOpenComposerReference,
}: {
  content: string;
  references: ComposerReference[];
  onOpenComposerReference: (reference: ComposerReference) => void;
}) {
  if (references.length === 0) {
    return <>{content}</>;
  }

  const referenceByLabel = new Map(references.map((reference) => [reference.label, reference]));
  const segments: React.ReactNode[] = [];
  const pattern = /【资源: ([^】]+)】/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const [raw, label] = match;
    const reference = referenceByLabel.get(label);
    if (!reference) continue;

    if (match.index > cursor) {
      segments.push(content.slice(cursor, match.index));
    }

    segments.push(
      <ComposerReferencePill
        key={`${reference.id}-${match.index}`}
        reference={reference}
        onClick={onOpenComposerReference}
        variant="inline"
      />,
    );
    cursor = match.index + raw.length;
  }

  if (cursor < content.length) {
    segments.push(content.slice(cursor));
  }

  return <>{segments.length > 0 ? segments : content}</>;
}

function RawMessageContent({ message, content }: { message: Message; content?: string }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <pre className={`max-w-full whitespace-pre-wrap break-words rounded-2xl border border-border/50 bg-background/80 px-5 py-3 text-left font-mono text-[12px] leading-[1.6] text-foreground shadow-sm ${isUser ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}>
        {content ?? message.content}
      </pre>
    </div>
  );
}

interface RequestErrorDetails {
  code: string;
  message: string;
  suggestions: string[];
  time: string;
}

function parseRequestErrorDetails(content: string): RequestErrorDetails | null {
  const match = /^请求错误详情\s*\n错误 \[([^\]]+)]\s*\n时间: ([^\n]+)\s*\n消息: ([\s\S]*?)(?:\n建议:\s*\n([\s\S]*))?\s*$/.exec(content.trim());
  if (!match) return null;

  const [, code, time, message, suggestionText = ''] = match;
  const suggestions = suggestionText
    .split('\n')
    .map((line) => line.replace(/^•\s*/, '').trim())
    .filter((line) => line.length > 0);

  return {
    code: code.trim(),
    time: time.trim(),
    message: message.trim(),
    suggestions,
  };
}

function RequestErrorCard({ details }: { details: RequestErrorDetails }) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="mb-4 w-full max-w-[651px] overflow-hidden rounded-2xl border border-border bg-transparent text-left shadow-[0_8px_20px_-20px_rgba(3,2,19,0.15)] transition-[border-color,box-shadow] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]">
      <button
        type="button"
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-colors duration-500 hover:bg-muted/40"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#d65a54]/10">
          <AlertCircle size={12} className="text-[#d65a54]" />
        </span>
        <div className="min-w-0 flex-1 truncate text-[12px] font-medium leading-[18px] tracking-[-0.18px] text-[#77777d]">
          错误 <span className="font-mono text-[11px] tracking-[-0.25px]">[{details.code}]</span>
        </div>
        <motion.div
          animate={{ rotate: isExpanded ? 0 : 180 }}
          transition={CARD_HEADER_TRANSITION}
          className="shrink-0"
        >
          <ChevronDown size={14} className="text-[#8e8e93]" />
        </motion.div>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CARD_EXPAND_TRANSITION}
          >
            <div className="px-11 pb-4 pt-3">
              <div className="flex items-center gap-1.5 text-[11px] leading-4 text-[#8e8e93]">
                <Clock size={12} className="shrink-0" />
                <span>时间</span>
                <span className="font-mono text-[#636369]">{details.time}</span>
              </div>

              <div className="pt-3">
                <div className="text-[11px] font-medium leading-4 text-[#8e8e93]">消息</div>
                <div className="flex gap-2 pt-1">
                  <AlertCircle size={14} className="mt-0.5 shrink-0 text-[#d65a54]" />
                  <p className="min-w-0 whitespace-pre-wrap break-words text-[13px] leading-5 text-[#505055]">
                    {details.message}
                  </p>
                </div>
              </div>

              {details.suggestions.length > 0 ? (
                <div className="pt-3.5">
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold leading-4 text-[#636369]">
                      <Lightbulb size={12} className="text-[#8e8e93]" />
                      <span>建议</span>
                    </div>
                    <ul className="space-y-1 pt-1.5">
                      {details.suggestions.map((suggestion) => (
                        <li key={suggestion} className="flex gap-1.5 text-[12px] font-medium leading-[18px] text-[#636369]">
                          <span className="mt-[7px] size-1 shrink-0 rounded-full bg-[#b9b9bf]" />
                          <span>{suggestion}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function VirtualMessage({ isLocked, children }: VirtualMessageProps) {
  const scrollRootRef = useContext(ScrollRootCtx);
  const [visible, setVisible] = useState(true);
  const heightRef = useRef(0);
  const domRef = useRef<HTMLDivElement>(null);
  const wasMountedRef = useRef(false);

  useEffect(() => {
    if (isLocked) {
      setVisible(true);
      return;
    }

    const root = scrollRootRef.current;
    const element = domRef.current;
    if (!root || !element) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          wasMountedRef.current = true;
          setVisible(true);
          return;
        }

        const height = element.offsetHeight;
        if (height > 0) {
          heightRef.current = height;
        }
        setVisible(false);
      },
      { root, rootMargin: '500px 0px', threshold: 0 }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRootRef, isLocked]);

  return (
    <div ref={domRef} style={!visible ? { height: heightRef.current } : undefined}>
      {visible ? children(wasMountedRef.current) : null}
    </div>
  );
}

const MessageBlock = memo(function MessageBlock({
  block,
  blockIdx,
  message,
  isLastBlock,
  onOpenDiff,
  onOpenCodeReference,
  onOpenComposerReference,
  onConfirmFileOp,
  onRejectFileOp,
  onMarkdownComplete,
}: MessageBlockProps) {
  const autoGenerateReasoningTitles = usePreferencesStore((state) => state.autoGenerateReasoningTitles);

  if (block.type === 'reasoning') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
        <ReasoningDisplay
          reasoning={block.content}
          isComplete={block.status === 'done'}
          status={block.status || 'reasoning'}
          title={autoGenerateReasoningTitles ? block.title : undefined}
        />
      </motion.div>
    );
  }

  if (block.type === 'tasks') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
        <TaskDisplay tasks={block.tasks} />
      </motion.div>
    );
  }

  if (block.type === 'diff') {
    return (
      <motion.button onClick={() => onOpenDiff(block.diff.id)} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }} className="w-full text-left">
        <DiffPreview diff={block.diff} compact />
      </motion.button>
    );
  }

  if (block.type === 'code_reference') {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
        <CodeReferenceCard reference={block.reference} onClick={onOpenCodeReference} />
      </motion.div>
    );
  }

  if (block.type === 'reference_list') {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
        <div className={`flex flex-wrap gap-2 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          {block.references.map((reference) => (
            <ComposerReferencePill
              key={reference.id}
              reference={reference}
              onClick={onOpenComposerReference}
            />
          ))}
        </div>
      </motion.div>
    );
  }

  if (block.type === 'skill') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
        <SkillCard skill={block.skill} />
      </motion.div>
    );
  }

  if (block.type === 'file_op') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
        <FileOpCard fileOp={block.fileOp} onConfirm={() => onConfirmFileOp(message.id, block.fileOp.id)} onReject={() => onRejectFileOp(message.id, block.fileOp.id)} />
      </motion.div>
    );
  }

  if (block.type === 'search_op') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
        <SearchCard searchOp={block.searchOp} />
      </motion.div>
    );
  }

  if (block.type === 'web_search') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
        <WebSearchCard search={block.search} />
      </motion.div>
    );
  }

  if (block.type === 'text') {
    if (message.role === 'user') {
      const references = getMessageReferences(message);
      return (
        <div className="flex justify-end">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }} className="inline-block rounded-2xl rounded-tr-sm bg-muted/80 px-5 py-3 text-left text-[16px] font-medium leading-[1.6] tracking-tight text-foreground select-text whitespace-pre-wrap break-words">
            <UserTextWithReferencePills
              content={block.content}
              references={references}
              onOpenComposerReference={onOpenComposerReference}
            />
          </motion.div>
        </div>
      );
    }

    const errorDetails = parseRequestErrorDetails(block.content);
    if (errorDetails) {
      return (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
          <RequestErrorCard details={errorDetails} />
        </motion.div>
      );
    }

    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }} className="group/msg relative select-text">
        <MarkdownContent content={block.content} status={isLastBlock ? message.status : 'done'} onComplete={() => onMarkdownComplete(message.id)} className="ml-2" />
      </motion.div>
    );
  }

  void blockIdx;
  return null;
});

const UsageTooltip = memo(function UsageTooltip({ message }: { message: Message }) {
  const [isOpen, setIsOpen] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apiConfigs = useChatStore((state) => state.apiConfigs);
  const activeChat = useChatStore((state) => state.getActiveChat());

  const contextWindowK = apiConfigs.length > 0
    ? Math.max(...apiConfigs.map((c) => c.inputContextWindow ?? 0))
    : 0;
  const contextWindowTokens = contextWindowK * 1000;

  const usageMessages = activeChat?.messages.filter((m) => m.role === 'ai' && m.usage) ?? [];
  const convInputTokens = usageMessages.reduce((sum, m) => sum + (m.usage?.prompt_tokens ?? 0), 0);
  const convOutputTokens = usageMessages.reduce((sum, m) => sum + (m.usage?.completion_tokens ?? 0), 0);
  const convCachedTokens = usageMessages.reduce((sum, m) => sum + getCachedTokens(m), 0);
  const convCacheMissTokens = usageMessages.reduce((sum, m) => sum + (m.usage?.prompt_cache_miss_tokens ?? 0), 0);
  const convCacheHitRate = convInputTokens > 0 ? Math.round((convCachedTokens / convInputTokens) * 100) : 0;
  const lastTotalTokens = (message.usage?.total_tokens ?? ((message.usage?.prompt_tokens ?? 0) + (message.usage?.completion_tokens ?? 0)));
  const contextUsageRate = contextWindowTokens > 0 ? Math.min(100, Math.round((lastTotalTokens / contextWindowTokens) * 100)) : 0;

  const thisInput = message.usage?.prompt_tokens ?? 0;
  const thisOutput = message.usage?.completion_tokens ?? 0;
  const hasCacheData = convCachedTokens > 0 || convCacheMissTokens > 0;

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const scheduleOpen = (nextOpen: boolean) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setIsOpen(nextOpen);
      hoverTimerRef.current = null;
    }, nextOpen ? 120 : 80);
  };

  return (
    <motion.div
      className="relative"
      initial={{ opacity: 0, y: 4, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.96 }}
      transition={{ duration: 0.24, ease: APPLE_CURVE }}
      onMouseEnter={() => scheduleOpen(true)}
      onMouseLeave={() => scheduleOpen(false)}
    >
      <motion.div
        className={`relative flex cursor-default items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground ${isOpen ? 'bg-muted/50 text-foreground' : ''}`}
      >
        <svg viewBox="0 0 36 36" className="h-[14px] w-[14px] -rotate-90">
          <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="4" className="opacity-20" />
          <motion.circle
            cx="18" cy="18" r="14"
            fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round"
            strokeDasharray="88"
            initial={{ strokeDashoffset: 88 }}
            animate={{ strokeDashoffset: 88 * (1 - contextUsageRate / 100) }}
            transition={{ duration: 0.9, ease: APPLE_CURVE }}
          />
        </svg>
        <span className="font-mono text-[11px] font-medium">{contextUsageRate}%</span>
      </motion.div>
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            className="absolute bottom-full left-1/2 -translate-x-1/2 z-50 mb-2 pointer-events-auto"
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={{ duration: 0.18, ease: APPLE_CURVE }}
          >
            <div className="w-52 rounded-xl border border-border bg-popover p-1.5 shadow-[0_12px_24px_-4px_rgba(0,0,0,0.2)] backdrop-blur-xl">
              <div className="mb-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">本次回复</div>
              <div className="flex justify-between px-2 py-1 text-[11px]">
                <span className="text-muted-foreground">输入</span>
                <span className="font-mono font-medium text-foreground">{formatTokenUnit(thisInput)}</span>
              </div>
              <div className="flex justify-between px-2 py-1 text-[11px]">
                <span className="text-muted-foreground">输出</span>
                <span className="font-mono font-medium text-foreground">{formatTokenUnit(thisOutput)}</span>
              </div>
              <div className="h-px bg-border my-1 mx-1" />
              <div className="mb-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">整个对话</div>
              <div className="flex justify-between px-2 py-1 text-[11px]">
                <span className="text-muted-foreground">累计输入</span>
                <span className="font-mono font-medium text-foreground">{formatTokenUnit(convInputTokens)}</span>
              </div>
              <div className="flex justify-between px-2 py-1 text-[11px]">
                <span className="text-muted-foreground">累计输出</span>
                <span className="font-mono font-medium text-foreground">{formatTokenUnit(convOutputTokens)}</span>
              </div>
              {hasCacheData && (
                <div className="flex justify-between px-2 py-1 text-[11px]">
                  <span className="text-muted-foreground">缓存命中率</span>
                  <span className="font-mono font-medium text-foreground">{convCacheHitRate}%</span>
                </div>
              )}
              {contextWindowTokens > 0 && (
                <div className="flex justify-between px-2 py-1 text-[11px]">
                  <span className="text-muted-foreground">上下文使用率</span>
                  <span className="font-mono font-medium text-foreground">{contextUsageRate}%</span>
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
});

export const MessageItem = memo(function MessageItem({
  message,
  isLastMessage,
  showUsageInfo,
  isGenerating,
  skipAnimation,
  copiedId,
  showUndoConfirm,
  onCopy,
  onShowUndoConfirm,
  onRegenerate,
  onUndo,
  onOpenDiff,
  onOpenCodeReference,
  onOpenComposerReference,
  onConfirmFileOp,
  onRejectFileOp,
  onUpdateAskBlock,
  onSkipAskBlock,
  onMarkdownComplete,
}: MessageItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const showOriginalContentDebug = useLayoutStore((state) => state.showOriginalContentDebug);
  const showRawResponseDebug = useLayoutStore((state) => state.showRawResponseDebug);
  const autoGenerateReasoningTitles = usePreferencesStore((state) => state.autoGenerateReasoningTitles);
  const residualBlocks = getResidualMessageBlocks(message);
  const hoverRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverAnchorRef = useRef<{ x: number; y: number } | null>(null);
  // 用户在历史轮次上点击过撤销/重新生成后，强制保持展开
  const [isStickyExpanded, setIsStickyExpanded] = useState(false);

  const clearHoverRevealTimer = () => {
    if (hoverRevealTimerRef.current) {
      clearTimeout(hoverRevealTimerRef.current);
      hoverRevealTimerRef.current = null;
    }
  };

  const scheduleHoverReveal = (x: number, y: number) => {
    clearHoverRevealTimer();
    hoverAnchorRef.current = { x, y };
    hoverRevealTimerRef.current = setTimeout(() => {
      setIsHovered(true);
      hoverRevealTimerRef.current = null;
    }, ACTION_BAR_HOVER_REVEAL_DELAY_MS);
  };

  useEffect(() => {
    return () => clearHoverRevealTimer();
  }, []);

  const canShowActionBar =
    message.role === 'ai' &&
    message.status === 'done' &&
    !isGenerating &&
    !getAskForms(adaptLegacyMessageContent(message)).some((ask) => ask.status === 'pending') &&
    !message.blocks?.some(
      (block) => block.type === 'file_op' && block.fileOp.status === 'requires_confirmation'
    );

  const showActionBar =
    canShowActionBar &&
    (isLastMessage || isHovered || isStickyExpanded || showUndoConfirm === message.id);

  const handleRegenerateClick = () => {
    if (!isLastMessage) {
      setIsStickyExpanded(true);
    }
    onRegenerate(message.id);
  };

  const handleUndoConfirm = () => {
    if (!isLastMessage) {
      setIsStickyExpanded(true);
    }
    onUndo(message.id);
  };

  const handleMouseEnter = (event: React.MouseEvent<HTMLDivElement>) => {
    scheduleHoverReveal(event.clientX, event.clientY);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isHovered || !hoverAnchorRef.current) return;

    const movementX = Math.abs(event.clientX - hoverAnchorRef.current.x);
    const movementY = Math.abs(event.clientY - hoverAnchorRef.current.y);

    if (movementX > ACTION_BAR_HOVER_MOVE_TOLERANCE_PX || movementY > ACTION_BAR_HOVER_MOVE_TOLERANCE_PX) {
      scheduleHoverReveal(event.clientX, event.clientY);
    }
  };

  const handleMouseLeave = () => {
    clearHoverRevealTimer();
    hoverAnchorRef.current = null;
    setIsHovered(false);
  };

  return (
    <motion.div
      initial={skipAnimation ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
      className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className={`w-full max-w-[85%] ${message.role === 'user' ? 'text-right' : 'text-left'}`}>
        <div className={`mb-2 flex items-center gap-2 opacity-30 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <span className="block min-h-[1.2em] text-[11px] font-medium uppercase tracking-widest">
            {message.role === 'user' ? 'You' : 'Neural Core'}
          </span>
        </div>

        <div className="space-y-4">
          {showOriginalContentDebug || showRawResponseDebug ? (
            <RawMessageContent content={showRawResponseDebug ? message.rawResponse : undefined} message={message} />
          ) : (
            <AnimatePresence mode="popLayout">
              <MessageContentRenderer
                message={message}
                onOpenComposerReference={onOpenComposerReference}
                onMarkdownComplete={onMarkdownComplete}
                onUpdateAskBlock={onUpdateAskBlock}
                onSkipAskBlock={onSkipAskBlock}
                showReasoningTitle={autoGenerateReasoningTitles}
              />
              {residualBlocks.map((block, index) => (
                <ErrorBoundary key={`block-eb-${index}`}>
                  <MessageBlock
                    block={block}
                    blockIdx={index}
                    message={message}
                    isLastBlock={index === residualBlocks.length - 1}
                    onOpenDiff={onOpenDiff}
                    onOpenCodeReference={onOpenCodeReference}
                    onOpenComposerReference={onOpenComposerReference}
                    onConfirmFileOp={onConfirmFileOp}
                    onRejectFileOp={onRejectFileOp}
                    onMarkdownComplete={onMarkdownComplete}
                  />
                </ErrorBoundary>
              ))}
            </AnimatePresence>
          )}

          <AnimatePresence initial={false}>
            {showActionBar ? (
              <motion.div
                key="action-bar"
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: 'auto', marginTop: 24 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={{ duration: 0.32, ease: APPLE_CURVE }}
                style={{ overflow: 'visible' }}
              >
                <div className="flex items-center gap-1 border-t border-border/30 pt-4">
                  <AnimatePresence mode="wait">
                    {showUndoConfirm === message.id ? (
                      <motion.div key="confirm" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-2 py-1">
                        <AlertCircle size={12} className="text-red-500" />
                        <span className="text-[11px] font-medium text-red-600">确认撤销此轮对话？</span>
                        <button onClick={handleUndoConfirm} className="px-1 text-[11px] font-bold text-red-600 hover:underline">确认</button>
                        <button onClick={() => onShowUndoConfirm(null)} className="px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">取消</button>
                      </motion.div>
                    ) : (
                      <motion.div key="actions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1">
                        <button onClick={handleRegenerateClick} className="group/btn flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground">
                          <RotateCcw size={14} className="transition-transform duration-300 group-hover/btn:rotate-[-45deg]" />
                          <span className="text-[11px] font-medium">重新生成</span>
                        </button>
                        <button onClick={() => onShowUndoConfirm(message.id)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground">
                          <Undo2 size={14} />
                          <span className="text-[11px] font-medium">撤销更改</span>
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="flex-1" />
                  <AnimatePresence>
                    {showUsageInfo ? <UsageTooltip message={message} /> : null}
                  </AnimatePresence>
                  <button onClick={() => onCopy(message.content, message.id)} className="rounded-lg p-1.5 text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground">
                    {copiedId === message.id ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                  </button>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
});
