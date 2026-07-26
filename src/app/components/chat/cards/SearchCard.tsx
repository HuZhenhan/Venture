import { useState } from "react";
import { Loader2 } from "lucide-react";
import { SearchOp } from "../../../types";
import { getToolCardClasses } from "./toolCardStyles";
import { ExpandableCard, StatusHeader } from "./ExpandableCard";

interface SearchCardProps {
  searchOp: SearchOp;
  onFileClick?: (path: string, line?: number) => void;
}

const getCustomIcon = (_type: SearchOp["type"], status: SearchOp["status"]) => {
  const iconClassName = "text-muted-foreground";

  if (status === "searching") {
    return <Loader2 size={12} className={`${iconClassName} animate-spin`} />;
  }

  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
      <circle cx="5" cy="5" r="3" stroke="currentColor" strokeWidth="1"/>
      <path d="M7.2 7.2L10.5 10.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  );
};

const getStatusText = (type: SearchOp["type"], status: SearchOp["status"]) => {
  const term = type === "file" ? "文件" : "代码";
  switch (status) {
    case "searching": return `正在检索${term}`;
    case "completed": return `已完成${term}检索`;
    case "failed": return `${term}检索失败`;
    default: return `${term}检索`;
  }
};

export function SearchCard({ searchOp, onFileClick }: SearchCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const styles = getToolCardClasses(isExpanded);

  return (
    <ExpandableCard
      expanded={isExpanded}
      onExpandedChange={setIsExpanded}
      icon={getCustomIcon(searchOp.type, searchOp.status)}
      header={
        <StatusHeader statusKey={searchOp.status}>
          <span className={`${styles.eyebrow} font-normal whitespace-nowrap`}>{getStatusText(searchOp.type, searchOp.status)}</span>
          <span className={`truncate ${styles.headerTitle}`}>"{searchOp.query}"</span>
          {searchOp.status === "completed" && searchOp.results && (
            <span className="text-[11px] text-muted-foreground/60 font-normal flex items-center gap-1.5 shrink-0">
              <span className="w-0.5 h-0.5 rounded-full bg-muted-foreground/40" />
              {searchOp.results.length} 个结果
            </span>
          )}
        </StatusHeader>
      }
    >
      <div className="px-11 pb-5 pt-1">
        {searchOp.results && searchOp.results.length > 0 ? (
          <div className="space-y-3">
            {searchOp.results.map((result, idx) => (
              <div
                key={idx}
                onClick={() => onFileClick?.(result.path, result.line)}
                className={`flex flex-col gap-1.5 p-2 -mx-2 rounded-xl cursor-pointer transition-colors ${styles.hoverItem}`}
              >
                <div className={`flex items-center gap-2 text-[12px] font-medium ${styles.title}`}>
                  <span className={`truncate text-[11px] max-w-full ${styles.inlineCode}`}>
                    {result.path}
                  </span>
                  {result.line !== undefined && (
                    <span className={`text-[10px] font-mono shrink-0 ${styles.label}`}>
                      L{result.line}
                    </span>
                  )}
                </div>
                {result.match && (
                  <pre className={styles.codeBlock}>
                    {result.match}
                  </pre>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className={`text-[12px] italic ${styles.bodyText}`}>
            {searchOp.status === 'searching' ? '检索中...' : '无检索匹配项'}
          </div>
        )}
      </div>
    </ExpandableCard>
  );
}
