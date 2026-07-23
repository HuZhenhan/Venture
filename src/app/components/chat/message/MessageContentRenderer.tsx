import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, ChevronDown, Clock, Lightbulb } from 'lucide-react';
import { Message, ComposerReference } from '../../../types';
import { APPLE_CURVE, CARD_EXPAND_TRANSITION, CARD_HEADER_TRANSITION } from '../../../constants';
import { ReasoningDisplay } from '../../ReasoningDisplay';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { ComposerReferencePill } from '../cards/ComposerReferencePill';
import { AskCardInline, AskCardFull } from '../cards/AskCardContainer';
import {
  adaptLegacyMessageContent,
  attachmentToReference,
  getAskForms,
  getNodeText,
  MessageContentNode,
  parseAskNode,
  parseAttachmentNode,
  parseErrorNode,
  parseMessageContent,
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
  const nodes = useMemo(
    () => parseMessageContent(adaptLegacyMessageContent(message)),
    [message],
  );
  const lastTextIndex = nodes.findLastIndex((node) => node.type === 'text' && node.content.length > 0);

  // Extract all ask forms to determine which is the first pending (active) one
  const asks = useMemo(() => getAskForms(adaptLegacyMessageContent(message)), [message]);
  const firstPendingAskId = useMemo(() => {
    const firstPending = asks.find((ask) => ask.status === 'pending');
    return firstPending?.id;
  }, [asks]);

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

    if (node.name === 'ask') {
      const ask = parseAskNode(node);
      if (!ask) return null;

      // Render inline based on status
      if (ask.status === 'pending') {
        if (ask.id === firstPendingAskId) {
          // This is the active ask - show full card
          return (
            <AskCardFull
              key={key}
              ask={ask}
              onAnswer={(askId, answer) => onUpdateAskBlock(message.id, askId, answer)}
              onSkip={(askId) => onSkipAskBlock(message.id, askId)}
            />
          );
        }
        // Not the active pending ask - show as waiting inline
        return (
          <motion.div key={key} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 text-[12px] text-muted-foreground/50">
            <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/30" />
            <span className="truncate">{ask.question}</span>
            <span>· 等待中</span>
          </motion.div>
        );
      }

      // Answered or skipped - show as compact inline
      return <AskCardInline key={key} ask={ask} />;
    }

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

  return <>{renderNodes(nodes, message.id)}</>;
});
