import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../ui/utils';

/**
 * 统一徽章/标签组件
 * 用于状态显示、分类标记等场景
 * 
 * @example
 * <Badge variant="success">已启用</Badge>
 * <Badge variant="error">高风险</Badge>
 */
const badgeVariants = cva(
  'inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
  {
    variants: {
      variant: {
        info: 'bg-[#0a84ff]/10 text-[#0a84ff]',
        success: 'bg-[#30d158]/10 text-[#30d158]',
        warning: 'bg-[#ff9f0a]/10 text-[#ff9f0a]',
        error: 'bg-[#d65a54]/10 text-[#d65a54]',
        purple: 'bg-[#af52de]/10 text-[#af52de]',
        muted: 'bg-muted/60 text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'muted',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
