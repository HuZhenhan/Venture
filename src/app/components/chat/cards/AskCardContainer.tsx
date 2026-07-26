import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, SkipForward, ChevronDown, Pencil } from 'lucide-react';
import { AskForm } from '../../../types';
import { APPLE_CURVE, CARD_EXPAND_TRANSITION } from '../../../constants';

interface AskCardContainerProps {
  asks: AskForm[];
  onAnswer: (askId: string, answer: { selectedOptions?: string[]; text?: string }) => void;
  onSkip: (askId: string) => void;
}

const OTHER_ID = '__other__';

export function AskCardInline({ ask }: { ask: AskForm }) {
  const isSkipped = ask.status === 'skipped';

  const getAnswerDisplay = () => {
    if (isSkipped) return '已跳过';
    if (!ask.answer) return '';
    const parts: string[] = [];
    if (ask.answer.selectedOptions && ask.answer.selectedOptions.length > 0) {
      const labels = ask.answer.selectedOptions
        .map((id) => ask.options?.find((o) => o.id === id)?.label || id)
        .join(', ');
      parts.push(labels);
    }
    if (ask.answer.text) parts.push(ask.answer.text);
    return parts.join(' · ');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2 text-[12px] text-muted-foreground"
    >
      {isSkipped ? (
        <SkipForward size={10} className="text-muted-foreground" />
      ) : (
        <Check size={10} className="text-muted-foreground" />
      )}
      <span className="truncate">{ask.question}</span>
      <span className="text-[11px] text-muted-foreground/70">
        {isSkipped ? '· 已跳过' : `· ${getAnswerDisplay()}`}
      </span>
    </motion.div>
  );
}

export function AskCardFull({ ask, onAnswer, onSkip }: {
  ask: AskForm;
  onAnswer: (askId: string, answer: { selectedOptions?: string[]; text?: string }) => void;
  onSkip: (askId: string) => void;
}) {
  const hasOptions = !!ask.options && ask.options.length > 0;
  const showOtherOption = hasOptions && ask.requiresText;
  const isTextOnly = !hasOptions && ask.requiresText;

  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [textInput, setTextInput] = useState('');
  const [isExpanded, setIsExpanded] = useState(true);

  const otherSelected = selectedOptions.includes(OTHER_ID);

  const handleOptionToggle = (id: string) => {
    if (ask.allowMultiple) {
      setSelectedOptions((prev) => (prev.includes(id) ? prev.filter((o) => o !== id) : [...prev, id]));
    } else {
      setSelectedOptions([id]);
    }
  };

  const handleSubmit = () => {
    if (isTextOnly && !textInput.trim()) return;
    if (showOtherOption && otherSelected && !textInput.trim()) return;
    if (hasOptions && !showOtherOption && selectedOptions.length === 0) return;
    if (hasOptions && showOtherOption && selectedOptions.length === 0) return;

    const realSelections = selectedOptions.filter((id) => id !== OTHER_ID);
    onAnswer(ask.id, {
      selectedOptions: realSelections.length > 0 ? realSelections : undefined,
      text: textInput.trim() || undefined,
    });
  };

  const canSubmit = (() => {
    if (isTextOnly) return textInput.trim().length > 0;
    if (showOtherOption && otherSelected) return selectedOptions.length > 0 && textInput.trim().length > 0;
    if (hasOptions) return selectedOptions.length > 0;
    return false;
  })();

  const renderOptionButton = (id: string, label: string, isOther = false) => {
    const isSelected = selectedOptions.includes(id);
    return (
      <button
        key={id}
        onClick={() => handleOptionToggle(id)}
        className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
          isSelected
            ? 'border-primary/20 bg-background shadow-sm'
            : 'border-border bg-background hover:border-border/80'
        } cursor-pointer`}
      >
        <div
          className={`flex items-center justify-center w-4 h-4 shrink-0 border transition-colors ${
            ask.allowMultiple ? 'rounded-md' : 'rounded-full'
          } ${
            isSelected
              ? 'border-primary bg-primary'
              : 'border-muted-foreground bg-background'
          }`}
        >
          {isSelected && (
            <Check size={10} className="text-primary-foreground" strokeWidth={3} />
          )}
        </div>
        <span className={`text-[13px] ${isSelected ? 'text-foreground font-semibold' : 'text-foreground'}`}>
          {label}
        </span>
        {isOther && isSelected && (
          <Pencil size={11} className="ml-auto text-muted-foreground shrink-0" />
        )}
      </button>
    );
  };

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
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted/50">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-muted-foreground">
            <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1" />
            <path d="M4.5 4.5C4.5 3.5 5.5 3 6 3C6.5 3 7.5 3.5 7.5 4.5C7.5 5.5 6.5 5.5 6 6V7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <circle cx="6" cy="8.5" r="0.5" fill="currentColor" />
          </svg>
        </span>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-[12px] font-medium tracking-tight whitespace-nowrap text-muted-foreground">
            等待你的回复
          </span>
          <span className="truncate text-[12px] font-medium tracking-tight text-foreground">
            {ask.question}
          </span>
        </div>
        <motion.span animate={{ rotate: isExpanded ? 0 : 180 }} transition={CARD_EXPAND_TRANSITION} className="shrink-0">
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
            <div className="px-11 pb-4 pt-1 space-y-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                {isTextOnly
                  ? '填空'
                  : ask.allowMultiple
                    ? showOtherOption ? '多选 + 其他' : '多选'
                    : showOtherOption ? '单选 + 其他' : '单选'}
              </div>

              {hasOptions && (
                <div className="space-y-2">
                  {ask.options!.map((opt) => renderOptionButton(opt.id, opt.label))}
                  {showOtherOption && renderOptionButton(OTHER_ID, '其他', true)}
                </div>
              )}

              <AnimatePresence initial={false}>
                {(isTextOnly || (showOtherOption && otherSelected)) && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={CARD_EXPAND_TRANSITION}
                    className="overflow-hidden"
                  >
                    <textarea
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      placeholder={isTextOnly ? '请输入你的回答...' : '请输入其他内容...'}
                      autoFocus={showOtherOption && otherSelected}
                      className="w-full min-h-[80px] p-3 text-[13px] text-foreground bg-input-background border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 resize-none transition-all placeholder:text-muted-foreground"
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex justify-between pt-1">
                <button
                  onClick={() => onSkip(ask.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <SkipForward size={11} />
                  跳过
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className={`px-4 py-1.5 text-[12px] font-medium rounded-lg transition-all ${
                    canSubmit
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'bg-muted text-muted-foreground opacity-40 cursor-not-allowed'
                  }`}
                >
                  提交确认
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function AskCardContainer({ asks, onAnswer, onSkip }: AskCardContainerProps) {
  const pendingAsks = useMemo(() => asks.filter((ask) => ask.status === 'pending'), [asks]);
  const resolvedAsks = useMemo(() => asks.filter((ask) => ask.status !== 'pending'), [asks]);

  if (asks.length === 0) return null;

  return (
    <div className="space-y-2">
      {resolvedAsks.length > 0 && (
        <div className="space-y-1">
          {resolvedAsks.map((ask) => (
            <AskCardInline key={ask.id} ask={ask} />
          ))}
        </div>
      )}

      <AnimatePresence mode="wait">
        {pendingAsks.length > 0 && (
          <AskCardFull
            key={pendingAsks[0].id}
            ask={pendingAsks[0]}
            onAnswer={onAnswer}
            onSkip={onSkip}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
