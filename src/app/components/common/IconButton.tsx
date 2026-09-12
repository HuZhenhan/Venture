import { forwardRef } from 'react';
import { TapScale } from './animations';
import { cn } from '../ui/utils';

/**
 * 统一图标按钮组件
 * 
 * 重命名说明：原 HeaderButton → IconButton
 * 从位置描述改为功能描述，更清晰明确
 * 
 * @example
 * <IconButton label="刷新" onClick={handleRefresh}>
 *   <RefreshCw size={14} />
 * </IconButton>
 */
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string; // 必填的 aria-label，确保无障碍访问
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'ghost' | 'outline';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, size = 'md', variant = 'default', className, children, ...props }, ref) => {
    const sizeClasses = {
      sm: 'size-6',
      md: 'size-7',
      lg: 'size-8',
    };

    const variantClasses = {
      default: 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      ghost: 'text-foreground hover:bg-muted/40',
      outline: 'border border-border text-foreground hover:bg-muted/40',
    };

    return (
      <TapScale
        as="button"
        ref={ref as any}
        type="button"
        aria-label={label}
        title={label}
        className={cn(
          'flex items-center justify-center rounded-lg transition-colors',
          sizeClasses[size],
          variantClasses[variant],
          className
        )}
        {...props}
      >
        {children}
      </TapScale>
    );
  }
);

IconButton.displayName = 'IconButton';
