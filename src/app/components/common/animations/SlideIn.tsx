import { motion } from 'motion/react';

/**
 * 滑入动画包装器
 * 用于侧边栏、抽屉等需要滑入效果的元素
 * 
 * @example
 * <SlideIn direction="left">
 *   <div>侧边栏内容</div>
 * </SlideIn>
 */
interface SlideInProps {
  children: React.ReactNode;
  direction?: 'left' | 'right' | 'top' | 'bottom';
  duration?: number;
  className?: string;
}

export function SlideIn({ 
  children, 
  direction = 'left', 
  duration = 0.45,
  className 
}: SlideInProps) {
  const variants = {
    left: { x: -100, opacity: 0 },
    right: { x: 100, opacity: 0 },
    top: { y: -100, opacity: 0 },
    bottom: { y: 100, opacity: 0 },
  };

  return (
    <motion.div
      initial={variants[direction]}
      animate={{ x: 0, y: 0, opacity: 1 }}
      transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
