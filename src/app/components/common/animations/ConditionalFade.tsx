import { AnimatePresence, motion } from 'motion/react';

/**
 * 条件渲染动画包装器
 * 替代手写 AnimatePresence + motion.div 的重复代码
 * 
 * @example
 * <ConditionalFade show={isOpen}>
 *   <div>条件显示的内容</div>
 * </ConditionalFade>
 */
interface ConditionalFadeProps {
  show: boolean;
  children: React.ReactNode;
  duration?: number;
  className?: string;
}

export function ConditionalFade({ 
  show, 
  children,
  duration = 0.2,
  className 
}: ConditionalFadeProps) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
