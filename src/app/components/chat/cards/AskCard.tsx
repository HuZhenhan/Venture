import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, ChevronDown, Pencil } from "lucide-react";
import { AskForm } from "../../../types";
import { APPLE_CURVE, CARD_EXPAND_TRANSITION, CARD_HEADER_TRANSITION } from "../../../constants";
import { getToolCardClasses } from "./toolCardStyles";

const OTHER_ID = "__other__";

interface AskCardProps {
  ask: AskForm;
  onSubmit?: (answer: { selectedOptions?: string[]; text?: string }) => void;
}

export function AskCard({ ask, onSubmit }: AskCardProps) {
  const isAnswered = ask.status === "answered";
  const hasOptions = !!ask.options && ask.options.length > 0;
  const showOtherOption = hasOptions && ask.requiresText;
  const isTextOnly = !hasOptions && ask.requiresText;

  const [selectedOptions, setSelectedOptions] = useState<string[]>(ask.answer?.selectedOptions || []);
  const [textInput, setTextInput] = useState(ask.answer?.text || "");
  const [isExpanded, setIsExpanded] = useState(!isAnswered);
  const styles = getToolCardClasses(isExpanded);

  const otherSelected = selectedOptions.includes(OTHER_ID);

  const handleOptionToggle = (id: string) => {
    if (isAnswered) return;
    if (ask.allowMultiple) {
      setSelectedOptions((prev) => (prev.includes(id) ? prev.filter((o) => o !== id) : [...prev, id]));
    } else {
      setSelectedOptions([id]);
    }
  };

  const handleSubmit = () => {
    if (isAnswered) return;
    // Text-only mode: require text
    if (isTextOnly && !textInput.trim()) return;
    // Choice + Other mode: if Other is selected, require text
    if (showOtherOption && otherSelected && !textInput.trim()) return;
    // Choice mode: require at least one selection
    if (hasOptions && !showOtherOption && selectedOptions.length === 0) return;
    // Choice + Other mode: require at least one selection (including Other)
    if (hasOptions && showOtherOption && selectedOptions.length === 0) return;

    // Filter out __other__ from submitted selections
    const realSelections = selectedOptions.filter((id) => id !== OTHER_ID);
    onSubmit?.({
      selectedOptions: realSelections.length > 0 ? realSelections : undefined,
      text: textInput.trim() || undefined,
    });
  };

  const canSubmit = (() => {
    if (isAnswered) return false;
    if (isTextOnly) return textInput.trim().length > 0;
    if (showOtherOption && otherSelected) return selectedOptions.length > 0 && textInput.trim().length > 0;
    if (hasOptions) return selectedOptions.length > 0;
    return false;
  })();

  const icon = isAnswered ? (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-muted-foreground">
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1" />
      <path d="M4 6L5.5 7.5L8.5 4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-muted-foreground">
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1" />
      <path d="M4.5 4.5C4.5 3.5 5.5 3 6 3C6.5 3 7.5 3.5 7.5 4.5C7.5 5.5 6.5 5.5 6 6V7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <circle cx="6" cy="8.5" r="0.5" fill="currentColor" />
    </svg>
  );

  const statusText = isAnswered ? "已回答" : "等待你的回复";

  const renderOptionButton = (id: string, label: string, isOther = false) => {
    const isSelected = selectedOptions.includes(id);
    return (
      <button
        key={id}
        onClick={() => handleOptionToggle(id)}
        disabled={isAnswered}
        className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
          isSelected
            ? "border-primary/20 bg-background shadow-sm"
            : "border-border bg-background hover:border-border/80"
        } ${isAnswered ? "cursor-default opacity-80" : "cursor-pointer"}`}
      >
        <div
          className={`flex items-center justify-center w-4 h-4 shrink-0 border transition-colors ${
            ask.allowMultiple ? "rounded-md" : "rounded-full"
          } ${
            isSelected
              ? "border-primary bg-primary"
              : "border-muted-foreground bg-background"
          }`}
        >
          {isSelected && (
            <Check size={10} className="text-primary-foreground" strokeWidth={3} />
          )}
        </div>
        <span className={`text-[13px] ${isSelected ? "text-foreground font-semibold" : "text-foreground"}`}>
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
          {icon}
        </span>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className={`text-[12px] font-medium tracking-tight whitespace-nowrap ${styles.eyebrow}`}>
            {statusText}
          </span>
          <span className="truncate text-[12px] font-medium tracking-tight text-foreground">
            {ask.question}
          </span>
        </div>
        <motion.span animate={{ rotate: isExpanded ? 0 : 180 }} transition={CARD_HEADER_TRANSITION} className="shrink-0">
          <ChevronDown size={14} className="text-[#8e8e93]" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CARD_EXPAND_TRANSITION}
          >
            <div className="px-11 pb-4 pt-1 space-y-3">
              {/* Mode label */}
              {!isAnswered && (
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                  {isTextOnly
                    ? "填空"
                    : ask.allowMultiple
                      ? showOtherOption ? "多选 + 其他" : "多选"
                      : showOtherOption ? "单选 + 其他" : "单选"}
                </div>
              )}

              {/* Options */}
              {hasOptions && (
                <div className="space-y-2">
                  {ask.options!.map((opt) => renderOptionButton(opt.id, opt.label))}
                  {showOtherOption && renderOptionButton(OTHER_ID, "其他", true)}
                </div>
              )}

              {/* Text input: shown when text-only mode, or when "Other" is selected */}
              <AnimatePresence initial={false}>
                {(isTextOnly || (showOtherOption && otherSelected)) && !isAnswered && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={CARD_EXPAND_TRANSITION}
                    className="overflow-hidden"
                  >
                    <textarea
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      placeholder={isTextOnly ? "请输入你的回答..." : "请输入其他内容..."}
                      autoFocus={showOtherOption && otherSelected}
                      className="w-full min-h-[80px] p-3 text-[13px] text-foreground bg-input-background border border-border rounded-xl focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 resize-none transition-all placeholder:text-muted-foreground"
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Answered display */}
              {isAnswered && (
                <div className="space-y-1.5">
                  {ask.answer?.selectedOptions && ask.answer.selectedOptions.length > 0 && (
                    <div className="flex items-center gap-1.5 text-[11px] text-[#8e8e93]">
                      <span>用户选择</span>
                      <span className="font-mono text-[#636369]">
                        {ask.answer.selectedOptions
                          .map((id) => ask.options?.find((o) => o.id === id)?.label || id)
                          .join(", ")}
                      </span>
                    </div>
                  )}
                  {ask.answer?.text && (
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-[#505055]">
                      {ask.answer.text}
                    </p>
                  )}
                </div>
              )}

              {/* Submit button */}
              {!isAnswered && (
                <div className="flex justify-end pt-1">
                  <button
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    className={`${styles.primaryButton} ${!canSubmit ? "opacity-40 cursor-not-allowed" : ""}`}
                  >
                    提交确认
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
