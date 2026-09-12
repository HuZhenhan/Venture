import { motion } from 'motion/react';
import { cn } from '../ui/utils';

/**
 * 统一开关组件
 * 
 * 重命名说明：原 AppleToggle → Toggle
 * 去除品牌暗示，强调功能本身
 * 
 * @example
 * <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} />
 */
export interface ToggleProps {
  checked: boolean;
  onChange: () => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}

export function Toggle({ 
  checked, 
  onChange, 
  size = 'md', 
  disabled = false,
  className 
}: ToggleProps) {
  const sizeConfig = {
    sm: { width: 'w-9', height: 'h-5', thumbSize: 'size-4', translateX: 'translate-x-[18px]' },
    md: { width: 'w-11', height: 'h-6', thumbSize: 'size-5', translateX: 'translate-x-[22px]' },
  };

  const config = sizeConfig[size];

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange();
      }}
      disabled={disabled}
      className={cn(
        'relative flex items-center rounded-full transition-colors duration-500 ease-out',
        config.width,
        config.height,
        checked ? 'bg-primary' : 'bg-muted',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        className
      )}
      role="switch"
      aria-checked={checked}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 450, damping: 22, mass: 0.8 }}
        className={cn(
          'block rounded-full bg-white shadow-sm',
          config.thumbSize,
          checked ? config.translateX : 'translate-x-0.5'
        )}
      />
    </button>
  );
}
