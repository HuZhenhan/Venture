import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Brain } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { APPLE_CURVE, CARD_HEADER_TRANSITION } from "../constants";
import { getToolCardClasses } from "./chat/cards/toolCardStyles";
import { ExpandableCard } from "./chat/cards/ExpandableCard";

interface ReasoningDisplayProps {
  reasoning: string;
  isComplete: boolean;
  status: 'reasoning' | 'typing' | 'done' | 'loading';
  title?: string;
}

export function ReasoningDisplay({ reasoning, isComplete, status, title }: ReasoningDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(status === 'reasoning');
  const [displayedLength, setDisplayedLength] = useState(
    status === 'reasoning' ? 0 : reasoning.length
  );
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const styles = getToolCardClasses(isExpanded);
  const isActive = status === 'reasoning';
  const headerText = title?.trim() || reasoning.replace(/[#*`\n]/g, ' ');

  useEffect(() => {
    if (status === 'reasoning') {
      setIsExpanded(true);
    } else if (status === 'typing' || status === 'done') {
      const timer = setTimeout(() => setIsExpanded(false), 800);
      return () => clearTimeout(timer);
    }
  }, [status]);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (status !== 'reasoning') {
      setDisplayedLength(reasoning.length);
      return;
    }

    if (displayedLength >= reasoning.length) return;

    timerRef.current = setInterval(() => {
      setDisplayedLength(prev => {
        const next = prev + 1;
        if (next >= reasoning.length) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
        }
        return next;
      });
    }, 20);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status, reasoning]);

  const displayedText = reasoning.slice(0, displayedLength);

  const header = (
    <AnimatePresence mode="wait">
      {isActive ? (
        <motion.span
          key="reasoning"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={CARD_HEADER_TRANSITION}
          className={`absolute left-0 text-[12px] font-medium tracking-tight whitespace-nowrap ${styles.eyebrow}`}
        >
          AI 正在思考...
        </motion.span>
      ) : (
        <motion.div
          key="content-preview"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={CARD_HEADER_TRANSITION}
          className="absolute left-0 flex items-center pr-8 w-full"
        >
          <span className={`text-[12px] font-medium tracking-tight truncate w-full pr-4 ${styles.eyebrow}`}>
            {headerText}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <ExpandableCard
      expanded={isExpanded}
      onExpandedChange={setIsExpanded}
      icon={<Brain size={12} className={styles.iconForeground} />}
      header={header}
    >
      <div className="px-11 pb-4 pt-1">
        <div className="relative">
          <div className={`text-[13px] leading-[1.6] font-normal selection:bg-black/5 ${styles.bodyText}`}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({children}) => <p className="mb-2 last:mb-0 inline">{children}</p>,
                strong: ({children}) => <strong className="font-semibold text-foreground/80">{children}</strong>,
                code: ({children}) => <code className={`${styles.inlineCode} text-[0.9em]`}>{children}</code>
              }}
            >
              {displayedText}
            </ReactMarkdown>
            {isActive && (
              <motion.span
                animate={{ opacity: [0, 1, 0] }}
                transition={{ duration: 0.8, repeat: Infinity }}
                className={`inline-block w-[2px] h-[14px] ml-1 align-middle ${styles.caret}`}
              />
            )}
          </div>
        </div>
      </div>
    </ExpandableCard>
  );
}
