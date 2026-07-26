import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, ChevronDown, Clock, Lightbulb } from 'lucide-react';
import { Message, ComposerReference } from '../../../types';
import { APPLE_CURVE, CARD_EXPAND_TRANSITION, CARD_HEADER_TRANSITION } from '../../../constants';
import { ReasoningDisplay } from '../../ReasoningDisplay';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { ComposerReferencePill } from '../cards/ComposerReferencePill';
import { AskCardInline, AskCardFull } from '../cards/AskCardContainer';
import { ToolCallCard } from '../cards/ToolCallCard';
import {
  adaptLegacyMessageContent,
  attachmentToReference,
  getNodeText,
  MessageContentNode,
  parseAttachmentNode,
  parseErrorNode,
  parseMessageContent,
  toolCallToAskForm,
} from '../../../utils/messageContentProtocol';

interface MessageContentRendererProps {
  message: Message;
  onOpenComposerReference: (reference: ComposerReference) => void;
  onMarkdownComplete: (messageId: string) => void;
  onUpdateAskBlock: (messageId: string, askId: string, answer: { selectedOptions?: string[]; text?: string }) => void;
  onSkipAskBlock: (messageId: string, askId: string) => void;
  showReasoningTitle: boolean;
}

function titleFromThinking(node: MessageContentNode): string | undefined {
  if (node.type !== 'tag') return undefined;
  const title = node.children.find((child) => child.type === 'tag' && child.name === 'title');
  return title ? getNodeText(title).trim() || undefined : undefined;
}

function thinkingText(node: MessageContentNode): string {
  if (node.type !== 'tag') return '';
  return node.children
    .filter((child) => child.type !== 'tag' || child.name !== 'title')
    .map(getNodeText)
    .join('');
}

function ErrorContent({ node }: { node: MessageContentNode }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const details = parseErrorNode(node);
  if (!details) return null;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }} className="w-full max-w-[651px] overflow-hidden rounded-2xl border border-border text-left">
      <button type="button" onClick={() => setIsExpanded((value) => !value)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#d65a54]/10"><AlertCircle size={12} className="text-[#d65a54]" /></span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[#77777d]">错误 <span className="font-mono text-[11px]">[{details.code}]</span></span>
        <motion.span animate={{ rotate: isExpanded ? 0 : 180 }} transition={CARD_HEADER_TRANSITION}><ChevronDown size={14} className="text-[#8e8e93]" /></motion.span>
      </button>
      <AnimatePresence initial={false}>
        {isExpanded ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={CARD_EXPAND_TRANSITION}>
            <div className="space-y-3 px-11 pb-4 pt-3">
              {details.time ? <div className="flex items-center gap-1.5 text-[11px] text-[#8e8e93]"><Clock size={12} /><span>时间</span><span className="font-mono text-[#636369]">{details.time}</span></div> : null}
              <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-[#505055]">{details.message}</p>
              {details.suggestions.length > 0 ? (
                <div>
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#636369]"><Lightbulb size={12} /><span>建议</span></div>
                  <ul className="space-y-1 pt-1.5">
                    {details.suggestions.map((suggestion) => <li key={suggestion} className="text-[12px] leading-[18px] text-[#636369]">• {suggestion}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

export const MessageContentRenderer = memo(function MessageContentRenderer({
  message,
  onOpenComposerReference,
  onMarkdownComplete,
  onUpdateAskBlock,
  onSkipAskBlock,
  showReasoningTitle,
}: MessageContentRendererProps) {
  const segments = message.segments;
  const hasSegments = !!(segments && segments.length > 0);
  const hasSeparateReasoning = message.reasoning != null;
  const rawContent = useMemo(
    () => adaptLegacyMessageContent(message),
    [message],
  );
  const nodes = useMemo(
    () => {
      const parsed = parseMessageContent(rawContent);
      if (hasSegments) {
        // 时序分段模式：text/thinking 由 segments 渲染，这里只保留 ask/error/attachment
        return parsed.filter((node) =>
          node.type === 'tag' && ['error', 'attachment'].includes(node.name),
        );
      }
      // 兼容旧格式：过滤掉 thinking 标签避免与独立 reasoning 字段重复
      if (hasSeparateReasoning) {
        return parsed.filter((node) => node.type !== 'tag' || node.name !== 'thinking');
      }
      return parsed;
    },
    [rawContent, hasSeparateReasoning, hasSegments],
  );
  const lastTextIndex = nodes.findLastIndex((node) => node.type === 'text' && node.content.length > 0);

  const renderNodes = (items: MessageContentNode[], path: string): React.ReactNode => items.map((node, index) => {
    const key = `${path}-${index}`;
    if (node.type === 'text') {
      if (!node.content) return null;
      if (message.role === 'user') {
        return (
          <div key={key} className="flex justify-end">
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }} className="inline-block whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-muted/80 px-5 py-3 text-left text-[16px] font-medium leading-[1.6] text-foreground">
              {node.content}
            </motion.div>
          </div>
        );
      }
      return (
        <motion.div key={key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }} className="group/msg relative select-text">
          <MarkdownContent content={node.content} status={index === lastTextIndex ? message.status : 'done'} onComplete={() => onMarkdownComplete(message.id)} className="ml-[8px]" />
        </motion.div>
      );
    }

    if (node.name === 'thinking') {
      const content = thinkingText(node);
      return content ? (
        <motion.div key={key} initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
          <ReasoningDisplay reasoning={content} isComplete={message.status !== 'reasoning'} status={message.status === 'reasoning' ? 'reasoning' : 'done'} title={showReasoningTitle ? titleFromThinking(node) : undefined} />
        </motion.div>
      ) : null;
    }

    if (node.name === 'error') return <ErrorContent key={key} node={node} />;

    if (node.name === 'attachment') {
      const resource = parseAttachmentNode(node);
      if (!resource) return null;
      const reference = attachmentToReference(resource);
      return (
        <motion.div key={key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <ComposerReferencePill reference={reference} onClick={onOpenComposerReference} />
        </motion.div>
      );
    }

    return <span key={key}>{renderNodes(node.children, key)}</span>;
  });

  return (
    <>
      {hasSegments ? (
        // 时序分段模式：按 streaming 到达顺序渲染
        segments!.map((seg, i) => {
          const isLastSeg = i === segments!.length - 1;
          if (seg.type === 'reasoning') {
            return (
              <motion.div key={`seg-${i}`} initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
                <ReasoningDisplay
                  reasoning={seg.content}
                  isComplete={!isLastSeg || message.status !== 'reasoning'}
                  status={isLastSeg && message.status === 'reasoning' ? 'reasoning' : 'done'}
                  title={undefined}
                />
              </motion.div>
            );
          }
          if (seg.type === 'content') {
            return (
              <motion.div key={`seg-${i}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }} className="group/msg relative select-text">
                <MarkdownContent
                  content={seg.content}
                  status={isLastSeg && (message.status === 'typing' || message.status === 'reasoning') ? message.status : 'done'}
                  onComplete={() => onMarkdownComplete(message.id)}
                  className="ml-[8px]"
                />
              </motion.div>
            );
          }
          if (seg.type === 'tool_calls') {
            const liveCalls = seg.calls.map((segTc) => {
              const live = (message.toolCalls ?? []).find((tc) => tc.id === segTc.id);
              return live ?? segTc;
            });
            return liveCalls.map((tool) => {
              if (tool.name === 'AskUserQuestion') {
                const ask = toolCallToAskForm(tool);
                if (!ask) return null;
                if (ask.status === 'pending') {
                  return (
                    <AskCardFull
                      key={tool.id}
                      ask={ask}
                      onAnswer={(askId, answer) => onUpdateAskBlock(message.id, askId, answer)}
                      onSkip={(askId) => onSkipAskBlock(message.id, askId)}
                    />
                  );
                }
                return <AskCardInline key={tool.id} ask={ask} />;
              }
              return (
                <motion.div key={tool.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
                  <ToolCallCard tool={tool} />
                </motion.div>
              );
            });
          }
          return null;
        })
      ) : (
        // 兼容旧格式
        <>
          {hasSeparateReasoning && message.reasoning && message.reasoning.length > 0 && (
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
              <ReasoningDisplay
                reasoning={message.reasoning}
                isComplete={message.status !== 'reasoning'}
                status={message.status === 'reasoning' ? 'reasoning' : 'done'}
                title={showReasoningTitle ? message.reasoningTitle : undefined}
              />
            </motion.div>
          )}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <>
              {message.toolCalls.map((tool) => {
                if (tool.name === 'AskUserQuestion') {
                  const ask = toolCallToAskForm(tool);
                  if (!ask) return null;
                  if (ask.status === 'pending') {
                    return (
                      <AskCardFull
                        key={tool.id}
                        ask={ask}
                        onAnswer={(askId, answer) => onUpdateAskBlock(message.id, askId, answer)}
                        onSkip={(askId) => onSkipAskBlock(message.id, askId)}
                      />
                    );
                  }
                  return <AskCardInline key={tool.id} ask={ask} />;
                }
                return (
                  <motion.div key={tool.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: APPLE_CURVE }}>
                    <ToolCallCard tool={tool} />
                  </motion.div>
                );
              })}
            </>
          )}
        </>
      )}
      {renderNodes(nodes, message.id)}
    </>
  );
});
