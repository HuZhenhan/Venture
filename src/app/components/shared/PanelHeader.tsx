import React from 'react';
import { X } from 'lucide-react';

export interface PanelHeaderProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  badge?: string | number;
  onClose?: () => void;
  actions?: React.ReactNode;
}

export function PanelHeader({
  title,
  subtitle,
  icon,
  badge,
  onClose,
  actions,
}: PanelHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {badge && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {badge}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        {actions}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭面板"
          >
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
