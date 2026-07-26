import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronUp, CheckCircle2, Loader2, Circle, AlertCircle } from "lucide-react";
import { Task } from "../types";
import { APPLE_CURVE } from "../constants";

interface FloatingTaskIndicatorProps {
  tasks: Task[];
  isActive: boolean;
}
export function FloatingTaskIndicator({ tasks, isActive }: FloatingTaskIndicatorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isOpen && containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  if (!tasks || tasks.length === 0) return null;

  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const totalCount = tasks.length;
  const failedCount = tasks.filter(t => t.status === 'failed').length;

  const getStatusIcon = (status: Task['status']) => {
    switch (status) {
      case 'running':
        return <Loader2 size={12} className="text-muted-foreground animate-spin" />;
      case 'completed':
        return <CheckCircle2 size={12} className="text-green-500" />;
      case 'failed':
        return <AlertCircle size={12} className="text-muted-foreground" />;
      default:
        return <Circle size={12} className="text-muted-foreground" />;
    }
  };

  return (
    <div className="flex flex-col items-center w-full relative z-40" ref={containerRef}>
      <motion.button
        layout
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className={`
          relative flex items-center justify-center w-32 h-[14px] transition-all duration-300 z-50 bg-input-background backdrop-blur-3xl
          ${isOpen ? '' : 'shadow-[0_-4px_12px_rgba(0,0,0,0.02)]'}
        `}
        style={{
          clipPath: 'polygon(0% 100%, 8% 100%, 15% 98%, 20% 88%, 25% 65%, 30% 35%, 35% 12%, 40% 2%, 45% 0%, 55% 0%, 60% 2%, 65% 12%, 70% 35%, 75% 65%, 80% 88%, 85% 98%, 92% 100%, 100% 100%)' 
        }}
        transition={{ duration: 0.4, ease: APPLE_CURVE }}
      >
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0, y: isOpen ? 1 : -0.5 }}
          transition={{ duration: 0.4, ease: APPLE_CURVE }}
        >
          <ChevronUp size={12} className="text-muted-foreground" strokeWidth={3} />
        </motion.div>
      </motion.button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={{ duration: 0.4, ease: APPLE_CURVE }}
            className="w-full max-w-[320px] sm:max-w-[360px] bg-input-background backdrop-blur-3xl rounded-t-[16px] border-t border-x border-border shadow-[0_-20px_40px_rgba(0,0,0,0.08)] mt-[-1px] overflow-hidden origin-top"
          >
            <div className="p-3 pb-4">
              <div className="flex items-center justify-between mb-3 px-1">
                <span className="text-[11px] font-bold tracking-tight text-muted-foreground uppercase">任务</span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {failedCount > 0 ? `${completedCount}/${totalCount} · stopped` : `${completedCount}/${totalCount}`}
                </span>
              </div>
              
              <div className="space-y-3 px-1">
                {tasks.map((task) => (
                  <div key={task.id} className="flex flex-col gap-1">
                    <div className="flex items-start gap-2 min-w-0 w-full">
                      <div className="shrink-0 mt-[2px]">
                        {getStatusIcon(task.status)}
                      </div>
                      <span className={`text-[12px] font-medium leading-normal break-words whitespace-normal flex-1 min-w-0 ${
                        task.status === 'completed' ? 'text-muted-foreground line-through decoration-black/10' : 'text-foreground'
                      }`}>
                        {task.title}
                      </span>
                    </div>
                    {task.description && (
                      <p className="pl-5 text-[11px] text-muted-foreground leading-relaxed break-words whitespace-normal w-full">
                        {task.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
