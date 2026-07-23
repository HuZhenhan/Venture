import { useState } from "react";
import { Loader2, ExternalLink } from "lucide-react";
import { WebSearch } from "../../../types";
import { getToolCardClasses } from "./toolCardStyles";
import { ExpandableCard, StatusHeader } from "./ExpandableCard";

interface WebSearchCardProps {
  search: WebSearch;
}

const getCustomIcon = (status: WebSearch["status"]) => {
  const iconClassName = "text-muted-foreground";

  switch (status) {
    case "searching":
      return <Loader2 size={12} className={`${iconClassName} animate-spin`} />;
    case "failed":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-destructive">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1"/>
          <path d="M6 3.5V6.5M6 8.5H6.005" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        </svg>
      );
    case "completed":
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1"/>
          <path d="M1.5 4.5H10.5M1.5 7.5H10.5" stroke="currentColor" strokeWidth="1"/>
          <path d="M6 1C7.5 3.5 7.5 8.5 6 11M6 1C4.5 3.5 4.5 8.5 6 11" stroke="currentColor" strokeWidth="1"/>
        </svg>
      );
  }
};

const getStatusText = (status: WebSearch["status"]) => {
  switch (status) {
    case "searching": return "正在搜索网络";
    case "completed": return "已完成网络搜索";
    case "failed": return "网络搜索失败";
    default: return "网页搜索";
  }
};

export function WebSearchCard({ search }: WebSearchCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const styles = getToolCardClasses(isExpanded);

  return (
    <ExpandableCard
      expanded={isExpanded}
      onExpandedChange={setIsExpanded}
      icon={getCustomIcon(search.status)}
      header={
        <StatusHeader statusKey={search.status}>
          <span className={`${styles.eyebrow} font-normal whitespace-nowrap`}>{getStatusText(search.status)}</span>
          <span className={`truncate ${styles.headerTitle}`}>"{search.query}"</span>
        </StatusHeader>
      }
    >
      <div className="px-11 pb-5 pt-1">
        {search.results && search.results.length > 0 ? (
          <div className="space-y-4">
            {search.results.map((result, idx) => (
              <div key={idx} className={`flex flex-col gap-1 p-2 -mx-2 rounded-xl transition-colors ${styles.hoverItem}`}>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noreferrer"
                  className={`flex items-center gap-1.5 text-[13px] font-medium hover:underline w-fit transition-colors ${styles.link}`}
                >
                  <span className="truncate max-w-[280px]">{result.title}</span>
                  <ExternalLink size={10} className="opacity-70 flex-shrink-0" />
                </a>
                <p className={`text-[12px] leading-relaxed line-clamp-2 ${styles.bodyText}`}>
                  {result.snippet}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className={`text-[12px] italic ${styles.bodyText}`}>
            {search.status === 'searching' ? '搜索结果拉取中...' : '无搜索结果'}
          </div>
        )}
      </div>
    </ExpandableCard>
  );
}
