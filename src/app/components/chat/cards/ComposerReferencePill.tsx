import {
  FileCode2,
  FileImage,
  FileText,
  Folder,
  Globe,
  Hash,
  MessageSquareText,
  OctagonAlert,
  Scale,
  X,
} from "lucide-react";
import { ComposerReference } from "../../../types";
import { formatFileSize, isUploadedResourceReference } from "../../../utils/uploadedResources";

interface ComposerReferencePillProps {
  reference: ComposerReference;
  onClick?: (reference: ComposerReference) => void;
  onRemove?: (referenceId: string) => void;
  variant?: "card" | "inline";
}

function getReferenceIcon(reference: ComposerReference) {
  if (isUploadedResourceReference(reference) && reference.resource.kind === "image") {
    return FileImage;
  }

  switch (reference.kind) {
    case "code":
    case "symbol":
      return FileCode2;
    case "file":
    case "doc":
      return FileText;
    case "folder":
      return Folder;
    case "chat":
      return MessageSquareText;
    case "rule":
      return Scale;
    case "problem":
      return OctagonAlert;
    case "web":
      return Globe;
    default:
      return Hash;
  }
}

export function ComposerReferencePill({
  reference,
  onClick,
  onRemove,
  variant = "card",
}: ComposerReferencePillProps) {
  const Icon = getReferenceIcon(reference);
  const clickable = typeof onClick === "function";
  const uploaded = isUploadedResourceReference(reference) ? reference.resource : null;
  const isInline = variant === "inline";

  return (
    <div className={`group/reference inline-flex min-w-0 items-center gap-1.5 border border-border bg-background/85 text-foreground shadow-[0_8px_18px_-16px_rgba(15,23,42,0.3)] backdrop-blur-xl ${isInline ? "max-w-[240px] rounded-md px-1.5 py-0.5 text-[12px] align-middle" : "max-w-full sm:max-w-md rounded-xl px-2 py-1 text-[12px]"}`}>
      <button
        type="button"
        onClick={clickable ? () => onClick(reference) : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${clickable ? "hover:text-[#0A84FF]" : ""}`}
      >
        <span className={`${isInline ? "h-4 w-4 rounded" : "h-5 w-5 rounded-lg"} flex shrink-0 items-center justify-center overflow-hidden bg-muted/70 text-muted-foreground transition-colors group-hover/reference:text-foreground`}>
          {uploaded?.kind === "image" ? (
            <img src={uploaded.dataUrl} alt="" className="h-full w-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          ) : (
            <Icon size={isInline ? 11 : 12} strokeWidth={2} />
          )}
        </span>
        <span className="min-w-0 truncate font-medium tracking-tight">{reference.label}</span>
        {!isInline && (reference.detail || uploaded) ? (
          <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
            {uploaded ? formatFileSize(uploaded.size) : reference.detail}
          </span>
        ) : null}
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(reference.id)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`移除 ${reference.label} 引用`}
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      ) : null}
    </div>
  );
}
