import { useState, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Check } from 'lucide-react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { cn } from '../ui/utils';
import { APPLE_CURVE, DURATION } from '../../constants';

/**
 * 统一下拉选择组件
 * 
 * 重命名说明：原 CustomSelect → Select
 * 去除无意义前缀，使用清晰的功能描述
 * 
 * @example
 * <Select 
 *   value={theme} 
 *   options={['light', 'dark', 'system']} 
 *   onChange={setTheme} 
 * />
 */
export interface SelectProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  menuPosition?: 'top' | 'bottom';
  className?: string;
}

export function Select({
  value,
  options,
  onChange,
  placeholder = '请选择',
  menuPosition = 'bottom',
  className = '',
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setIsOpen(false), isOpen);

  return (
    <div className={cn('relative', className)} ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <span>{value || placeholder}</span>
        <ChevronDown 
          size={12} 
          className={cn(
            'transition-transform duration-300',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: menuPosition === 'top' ? 4 : -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: menuPosition === 'top' ? 4 : -4 }}
            transition={{ duration: DURATION.card, ease: APPLE_CURVE }}
            className={cn(
              'absolute right-0 z-[9999] min-w-[8rem] overflow-hidden',
              'rounded-xl border border-border bg-background/95 backdrop-blur-2xl',
              'p-1 shadow-lg',
              menuPosition === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
            )}
          >
            {options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-muted/50"
              >
                <span>{option}</span>
                {value === option && <Check size={12} className="text-foreground" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
