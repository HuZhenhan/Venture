import { useState } from "react";
import { Loader2 } from "lucide-react";
import { SkillCall } from "../../../types";
import { getToolCardClasses } from "./toolCardStyles";
import { ExpandableCard, StatusHeader } from "./ExpandableCard";

interface SkillCardProps {
  skill: SkillCall;
}

const getCustomIcon = (status: SkillCall["status"]) => {
  const iconClassName = "text-muted-foreground";

  switch (status) {
    case "running":
      return <Loader2 size={12} className={`${iconClassName} animate-spin`} />;
    case "completed":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
          <path d="M6 1L7.2 4.8L11 6L7.2 7.2L6 11L4.8 7.2L1 6L4.8 4.8L6 1Z" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="6" cy="6" r="1" fill="currentColor"/>
        </svg>
      );
    case "failed":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-destructive">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1"/>
          <path d="M6 3.5V6.5M6 8.5H6.005" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        </svg>
      );
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={iconClassName}>
          <path d="M2.5 9.5L9.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          <path d="M8 2L10 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          <rect x="2" y="8" width="2" height="2" rx="0.5" stroke="currentColor" strokeWidth="1"/>
        </svg>
      );
  }
};

const getStatusText = (status: SkillCall["status"]) => {
  switch (status) {
    case "running": return "正在调用 Skill";
    case "completed": return "Skill 调用成功";
    case "failed": return "Skill 调用失败";
    default: return "调用 Skill";
  }
};

export function SkillCard({ skill }: SkillCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const styles = getToolCardClasses(isExpanded);

  return (
    <ExpandableCard
      expanded={isExpanded}
      onExpandedChange={setIsExpanded}
      icon={getCustomIcon(skill.status)}
      header={
        <StatusHeader statusKey={skill.status}>
          <span className={`${styles.eyebrow} font-normal whitespace-nowrap`}>{getStatusText(skill.status)}</span>
          <span className={`truncate ${styles.headerTitle}`}>{skill.name}</span>
        </StatusHeader>
      }
    >
      <div className="px-11 pb-5 pt-1">
        {(skill.params || skill.output) ? (
          <div className="space-y-3">
            {skill.params && (
              <div className="space-y-1.5">
                <div className={`text-[10px] font-bold uppercase tracking-wider ${styles.label}`}>Params</div>
                <pre className={styles.codeBlock}>{skill.params}</pre>
              </div>
            )}
            {skill.output && (
              <div className="space-y-1.5">
                <div className={`text-[10px] font-bold uppercase tracking-wider ${styles.label}`}>Output</div>
                <pre className={styles.codeBlock}>{skill.output}</pre>
              </div>
            )}
          </div>
        ) : (
          <div className={`text-[12px] italic ${styles.bodyText}`}>没有详细信息</div>
        )}
      </div>
    </ExpandableCard>
  );
}
