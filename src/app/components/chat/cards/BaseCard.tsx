import { ReactNode, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { APPLE_CURVE, CARD_EXPAND_TRANSITION, CARD_HEADER_TRANSITION } from '../../../constants';

interface BaseCardProps {
  /** 卡片左侧图标 */
  icon: ReactNode;
  /** Header 区域内容（状态文本、标题等） */
  headerContent: ReactNode;
  /** 展开后的内容 */
  children: ReactNode;
  /** 是否默认展开 */
  defaultExpanded?: boolean;
  /** 受控展开状态 */
  expanded?: boolean;
  /** 展开状态变化回调 */
  onExpandedChange?: (expanded: boolean) => void;
}

/**
 * 统一的可展开卡片基础组件
 * 用于所有需要展开/收起功能的卡片（Tool、Ask、Skill 等）
 */
export function BaseCard({
  icon,
  headerContent,
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
}: BaseCardProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : internalExpanded;

  const toggle = () => {
    const next = !isExpanded;
    if (!isControlled) setInternalExpanded(next);
    onExpandedChange?.(next);
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
        onClick={toggle}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-colors duration-500 hover:bg-muted/40"
      >
        {icon}
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {headerContent}
        </div>
        <motion.span 
          animate={{ rotate: isExpanded ? 0 : 180 }} 
          transition={CARD_HEADER_TRANSITION} 
          className="shrink-0"
        >
          <ChevronDown size={14} className="text-[#8e8e93]" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={CARD_EXPAND_TRANSITION}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
