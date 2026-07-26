import { useState } from "react";
import { ListTodo, CheckCircle2, Loader2, Circle, AlertCircle } from "lucide-react";
import { Task } from "../types";
import { getToolCardClasses } from "./chat/cards/toolCardStyles";
import { ExpandableCard, StatusHeader } from "./chat/cards/ExpandableCard";

interface TaskDisplayProps { tasks: Task[]; }

const getStatusIcon = (status: Task["status"], iconClassName: string) => {
  switch (status) {
    case "running": return <Loader2 size={12} className={`${iconClassName} animate-spin`} />;
    case "completed": return <CheckCircle2 size={12} className={iconClassName} />;
    case "failed": return <AlertCircle size={12} className="text-red-500" />;
    default: return <Circle size={12} className={iconClassName} />;
  }
};

export function TaskDisplay({ tasks }: TaskDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const styles = getToolCardClasses(isExpanded);

  if (!tasks || tasks.length === 0) return null;

  const runningTasks = tasks.filter(t => t.status === "running");
  const allCompleted = tasks.every(t => t.status === "completed");
  const hasFailedTasks = tasks.some(t => t.status === "failed");

  const headerContent = runningTasks.length > 0 ? (
    <StatusHeader statusKey="running">
      <span className={`${styles.eyebrow} font-normal`}>正在处理</span>
      <span className={`truncate ${styles.headerTitle}`}>{runningTasks[0].title}</span>
      {runningTasks.length > 1 && <span className={styles.badge}>+{runningTasks.length - 1}</span>}
    </StatusHeader>
  ) : (
    <StatusHeader statusKey="done">
      <span className={`${styles.eyebrow} font-normal`}>
        {allCompleted ? "任务已全部完成" : hasFailedTasks ? "任务已手动停止" : "查看任务规划"}
      </span>
    </StatusHeader>
  );

  return (
    <ExpandableCard
      expanded={isExpanded}
      onExpandedChange={setIsExpanded}
      icon={<ListTodo size={12} className={styles.iconForeground} />}
      header={headerContent}
    >
      <div className="px-7 pb-5 pt-1">
        <div className={`relative space-y-4 before:absolute before:left-[10px] before:top-2 before:bottom-2 before:w-px ${styles.timelineLine}`}>
          {tasks.map((task) => (
            <div key={task.id} className="relative flex flex-col gap-1.5 pl-8">
              <div className={`absolute left-0 top-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full ${styles.timelineNode}`}>
                {getStatusIcon(task.status, styles.iconForeground)}
              </div>
              <span className={`text-[13px] font-medium leading-tight tracking-tight ${task.status === "completed" ? `${styles.eyebrow} line-through decoration-border` : styles.title}`}>
                {task.title}
              </span>
              {task.description && task.status !== "completed" && (
                <p className={`text-[11px] leading-relaxed font-normal ${styles.bodyText}`}>{task.description}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </ExpandableCard>
  );
}
