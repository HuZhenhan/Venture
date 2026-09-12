import { motion } from 'motion/react';

/**
 * 淡入动画包装器
 * 用于卡片、对话框等需要淡入效果的元素
 * 
 * @example
 * <FadeIn delay={0.2}>
 *   <div>内容</div>
 * </FadeIn>
 */
interface FadeInProps {
  children: React.ReactNode;
  delay?: number;
  duration?: number;
  className?: string;
}

export function FadeIn({ 
  children, 
  delay = 0, 
  duration = 0.6,
  className 
}: FadeInProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: [0.32, 0.72, 0, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
