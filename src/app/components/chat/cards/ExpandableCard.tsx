import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { APPLE_CURVE, CARD_EXPAND_TRANSITION, CARD_HEADER_TRANSITION } from '../../../constants';
import { getToolCardClasses } from './toolCardStyles';

interface ExpandableCardProps {
  icon: React.ReactNode;
  header: React.ReactNode;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function ExpandableCard({
  icon,
  header,
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
}: ExpandableCardProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : internalExpanded;

  const toggle = () => {
    const next = !isExpanded;
    if (!isControlled) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  const styles = getToolCardClasses(isExpanded);

  return (
    <div className="mb-4 w-full overflow-hidden">
      <div className={styles.shell}>
        <button onClick={toggle} className={styles.header}>
          <div className={styles.icon}>{icon}</div>

          <div className="flex-1 min-w-0 relative h-5 overflow-hidden flex items-center">
            {header}
          </div>

          <motion.div
            animate={{ rotate: isExpanded ? 0 : 180 }}
            transition={CARD_HEADER_TRANSITION}
            className="flex-shrink-0"
          >
            <ChevronDown size={14} className={styles.chevron} />
          </motion.div>
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
      </div>
    </div>
  );
}

interface StatusHeaderProps {
  statusKey: string;
  children: React.ReactNode;
}

export function StatusHeader({ statusKey, children }: StatusHeaderProps) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={statusKey}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        transition={CARD_HEADER_TRANSITION}
        className="absolute left-0 text-[12px] font-medium tracking-tight flex items-center gap-2 w-full"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
