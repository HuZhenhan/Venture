import { motion } from "motion/react";
import { FileCode2 } from "lucide-react";
import { CodeDiff } from "../types";
import { getToolCardClasses } from "./chat/cards/toolCardStyles";

interface Props { diff: CodeDiff; compact?: boolean; }

export function DiffPreview({ diff, compact = false }: Props) {
  if (compact) {
    const styles = getToolCardClasses(false);
    const fileName = diff.file.split(/[\\/]/).pop() || diff.file;

    return (
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
        className={styles.shell}
      >
        <div className={styles.header}>
          <div className={styles.icon}>
            <FileCode2 size={12} className={styles.iconForeground} />
          </div>
          <div className="min-w-0 flex-1 text-left">
            <div className={`text-[12px] font-medium tracking-tight truncate ${styles.headerTitle}`}>
              {fileName}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-bold text-[#30A46C]">+{diff.additions}</span>
            <span className="text-[11px] font-bold text-[#E5484D]">-{diff.deletions}</span>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <div className="rounded-2xl bg-background/70 border border-border shadow-[0_8px_24px_rgba(0,0,0,0.04)] overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <div className="text-[12px] font-semibold text-foreground truncate">{diff.file}</div>
        <div className="text-[10px] text-muted-foreground mt-1 font-mono">+{diff.additions} / -{diff.deletions}</div>
      </div>
      <div className="overflow-auto custom-scrollbar-chat font-mono text-[11px] max-h-[calc(100vh-180px)]">
        {diff.lines.map((line, idx) => (
          <div key={idx} className={`grid grid-cols-[34px_34px_1fr] gap-2 px-3 py-1.5 border-l-2 ${line.type === "add" ? "bg-[#EEF8F1] border-[#6BA779]" : line.type === "remove" ? "bg-[#FAEEEE] border-[#B87A7A]" : "border-transparent text-muted-foreground"}`}>
            <span className="text-right text-[#A1A1A6] select-none">{line.oldNumber ?? ""}</span>
            <span className="text-right text-[#A1A1A6] select-none">{line.newNumber ?? ""}</span>
            <span className="whitespace-pre text-foreground"><span className="inline-block w-4 text-muted-foreground">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
