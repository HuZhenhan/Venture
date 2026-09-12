import { motion } from 'motion/react';
import { forwardRef } from 'react';

/**
 * 点击缩放动画包装器
 * 用于按钮、卡片等可点击元素，提供统一的点击反馈动画
 * 
 * @example
 * <TapScale as="button" onClick={handleClick}>
 *   点击我
 * </TapScale>
 */
interface TapScaleProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'button' | 'div' | 'a' | 'span';
  scale?: number;
  children: React.ReactNode;
}

export const TapScale = forwardRef<HTMLElement, TapScaleProps>(
  ({ as = 'button', scale = 0.92, children, ...props }, ref) => {
    const Component = motion[as] as any;
    
    return (
      <Component
        ref={ref}
        whileTap={{ scale }}
        transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
        {...props}
      >
        {children}
      </Component>
    );
  }
);

TapScale.displayName = 'TapScale';
