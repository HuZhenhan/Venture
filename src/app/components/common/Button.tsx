import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { TapScale } from './animations';
import { cn } from '../ui/utils';

/**
 * 统一按钮组件
 * 
 * 内置点击缩放动画，避免重复编写 motion.button 代码
 * 
 * @example
 * <Button variant="primary" size="md" onClick={handleSubmit}>
 *   提交
 * </Button>
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-border bg-background hover:bg-muted/50',
        ghost: 'hover:bg-muted/50',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs rounded-lg',
        md: 'h-9 px-4 text-sm rounded-xl',
        lg: 'h-10 px-6 text-base rounded-xl',
        icon: 'size-9 rounded-xl',
      },
      animation: {
        tap: '', // 默认点击动画
        none: '', // 无动画
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
      animation: 'tap',
    },
  }
);

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    VariantProps<typeof buttonVariants> {
  type?: 'button' | 'submit' | 'reset';
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, animation, type = 'button', children, asChild, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, animation }), className);

    // 如果禁用动画，使用普通 button
    if (animation === 'none' || asChild) {
      return (
        <button ref={ref} type={type} className={classes} {...props}>
          {children}
        </button>
      );
    }

    // 默认使用 TapScale 提供点击动画
    return (
      <TapScale as="button" ref={ref as any} type={type} className={classes} {...props}>
        {children}
      </TapScale>
    );
  }
);

Button.displayName = 'Button';
