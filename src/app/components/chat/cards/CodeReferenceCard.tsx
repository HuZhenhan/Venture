import { FileCode2, ArrowUpRight, X } from "lucide-react";
import { CodeReference } from "../../../types";
import { formatCodeReferenceLocation } from "../../../utils/codeReferences";

interface CodeReferenceCardProps {
  reference: CodeReference;
  variant?: "composer" | "message";
  onClick?: (reference: CodeReference) => void;
  onRemove?: (referenceId: string) => void;
}

export function CodeReferenceCard({
  reference,
  variant = "message",
  onClick,
  onRemove,
}: CodeReferenceCardProps) {
  const isComposer = variant === "composer";
  const excerpt = reference.excerpt.trim().split("\n").slice(0, 2).join("\n");

  return (
    <div
      className={`group flex items-start gap-2 rounded-2xl border border-border bg-background shadow-[0_12px_28px_-24px_rgba(0,0,0,0.3)] ${
        isComposer ? "p-2.5" : "p-3"
      }`}
    >
      <button
        type="button"
        onClick={() => onClick?.(reference)}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#0A84FF]/10 text-[#0A84FF]">
          <FileCode2 size={15} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-semibold tracking-tight text-foreground">
              {reference.fileName}
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {reference.startLine === reference.endLine
                ? `L${reference.startLine}`
                : `L${reference.startLine}-${reference.endLine}`}
            </span>
          </div>
          <p className="mt-1 truncate text-[11px] font-medium text-muted-foreground">
            {formatCodeReferenceLocation(reference)}
          </p>
          <pre className="mt-2 overflow-hidden whitespace-pre-wrap break-all text-[11px] leading-5 text-foreground/78">
            {excerpt}
          </pre>
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors group-hover:text-foreground">
          <ArrowUpRight size={14} strokeWidth={2} />
        </div>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(reference.id)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="移除代码引用"
        >
          <X size={14} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
