import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { FileOp } from "../../../types";
import { getToolCardClasses } from "./toolCardStyles";
import { ExpandableCard, StatusHeader } from "./ExpandableCard";

interface FileOpCardProps {
  fileOp: FileOp;
  onConfirm?: () => void;
  onReject?: () => void;
}

const getFileName = (path: string) => path.split(/[/\\]/).pop() || path;

const getOpIcon = (type: FileOp["type"], status: FileOp["status"]) => {
  const iconClassName = "text-muted-foreground";

  if (status === "running") {
    return <Loader2 size={12} className={`${iconClassName} animate-spin`} />;
  }

  if (status === "completed") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
        <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1"/>
        <path d="M4 6L5.5 7.5L8.5 4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }

  if (status === "failed") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-destructive">
        <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1"/>
        <path d="M6 3.5V6.5M6 8.5H6.005" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      </svg>
    );
  }

  switch (type) {
    case "copy":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
          <rect x="2" y="4" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1"/>
          <path d="M4 2H9C9.55228 2 10 2.44772 10 3V8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        </svg>
      );
    case "delete":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
          <path d="M2.5 3H9.5M4 3V2C4 1.44772 4.44772 1 5 1H7C7.55228 1 8 1.44772 8 2V3M3.5 3V9.5C3.5 10.0523 3.94772 10.5 4.5 10.5H7.5C8.05228 10.5 8.5 10.0523 8.5 9.5V3H3.5Z" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M5 5V8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          <path d="M7 5V8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        </svg>
      );
    case "cut":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
          <circle cx="3.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1"/>
          <circle cx="3.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1"/>
          <path d="M5 4.5L10 8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          <path d="M5 7.5L10 4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        </svg>
      );
    case "move":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
          <path d="M1.5 4L3.5 2V3.5H10.5V4.5H3.5V6L1.5 4Z" fill="currentColor"/>
          <path d="M10.5 8L8.5 6V7.5H1.5V8.5H8.5V10L10.5 8Z" fill="currentColor"/>
        </svg>
      );
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
          <path d="M3 1.5C3 1.22386 3.22386 1 3.5 1H8.5L11 3.5V10.5C11 10.7761 10.7761 11 10.5 11H3.5C3.22386 11 3 10.7761 3 10.5V1.5Z" stroke="currentColor" strokeWidth="1"/>
          <path d="M8.5 1V3.5H11" stroke="currentColor" strokeWidth="1"/>
        </svg>
      );
  }
};

const getOpText = (type: FileOp["type"]) => {
  switch (type) {
    case "copy": return "复制文件";
    case "delete": return "删除文件";
    case "cut": return "剪切文件";
    case "move": return "移动文件";
    default: return "操作文件";
  }
};

export function FileOpCard({ fileOp, onConfirm, onReject }: FileOpCardProps) {
  const [isExpanded, setIsExpanded] = useState(fileOp.status === "requires_confirmation");
  const styles = getToolCardClasses(isExpanded);

  useEffect(() => {
    if (fileOp.status === "completed") {
      setIsExpanded(false);
    }
  }, [fileOp.status]);

  return (
    <ExpandableCard
      expanded={isExpanded}
      onExpandedChange={setIsExpanded}
      icon={getOpIcon(fileOp.type, fileOp.status)}
      header={
        <StatusHeader statusKey={fileOp.status}>
          <span className={`${styles.eyebrow} font-normal whitespace-nowrap`}>
            {fileOp.status === 'requires_confirmation' ? `需要确认：${getOpText(fileOp.type)}` : getOpText(fileOp.type)}
          </span>
          <span className={`truncate ${styles.headerTitle}`}>{getFileName(fileOp.source)}</span>
        </StatusHeader>
      }
    >
      <div className="px-11 pb-5 pt-1 space-y-4">
        <div className="space-y-2">
          <div className={`flex flex-col gap-1 text-[12px] ${styles.bodyText}`}>
            <div className="flex items-start gap-2">
              <span className={`font-medium min-w-[36px] ${styles.label}`}>源文件:</span>
              <span className={`${styles.inlineCode} break-all`}>{fileOp.source}</span>
            </div>
            {fileOp.destination && (
              <div className="flex items-start gap-2 mt-1">
                <span className={`font-medium min-w-[36px] ${styles.label}`}>目标:</span>
                <span className={`${styles.inlineCode} break-all`}>{fileOp.destination}</span>
              </div>
            )}
          </div>
        </div>

        {fileOp.status === "requires_confirmation" && (
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={(e) => { e.stopPropagation(); onConfirm?.(); }}
              className={fileOp.type === 'delete' ? styles.dangerButton : styles.primaryButton}
            >
              确认操作
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onReject?.(); setIsExpanded(false); }}
              className={styles.secondaryButton}
            >
              取消
            </button>
          </div>
        )}
      </div>
    </ExpandableCard>
  );
}
