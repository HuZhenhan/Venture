import React from 'react';
import { motion } from 'motion/react';
import { ChevronRight, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import type { SkillInfo, SkillScope } from '../../services/skillService';
import { AppleToggle } from '../settings/SettingsSidebarPanels';

export const SCOPE_LABELS: Record<SkillScope, string> = {
  global: '全局',
  plugin: '插件',
  mcp: 'MCP',
};

export const SCOPE_STYLES: Record<SkillScope, string> = {
  global: 'bg-blue-500/10 text-blue-500',
  plugin: 'bg-emerald-500/10 text-emerald-500',
  mcp: 'bg-amber-500/10 text-amber-500',
};

interface SkillCardProps {
  skill: SkillInfo;
  onOpenDetail: (autoEdit?: boolean) => void;
  onToggleEnabled: () => void;
  onDelete: () => Promise<void>;
}

export function SkillCard({ skill, onOpenDetail, onToggleEnabled, onDelete }: SkillCardProps) {
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="bg-background/80 backdrop-blur-xl rounded-[20px] border border-border overflow-hidden transition-shadow duration-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[13px] font-semibold text-foreground truncate">{skill.name}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${SCOPE_STYLES[skill.scope]}`}>
                {SCOPE_LABELS[skill.scope]}
              </span>
              {skill.bundled && (
                <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-bold text-blue-500">
                  内置
                </span>
              )}
              {!skill.active && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
                  未激活
                </span>
              )}
              {!skill.enabled && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
                  已禁用
                </span>
              )}
              {skill.permission === 'deny' && (
                <span className="flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold text-red-500">
                  <ShieldAlert size={9} />
                  权限拒绝
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
              {skill.description || '（无描述）'}
            </div>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <AppleToggle checked={skill.enabled} onChange={onToggleEnabled} size="sm" />
          </div>
        </div>

        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          <PanelButton icon={ChevronRight} label="详情" onClick={() => onOpenDetail()} />
          {!skill.bundled && (
            <>
              <PanelButton icon={Pencil} label="编辑" onClick={() => onOpenDetail(true)} />
              {confirmingDelete ? (
                <>
                  <PanelButton icon={Trash2} label={busy ? '删除中…' : '确认删除'} onClick={() => void handleDelete()} danger />
                  <PanelButton icon={ChevronRight} label="取消" onClick={() => setConfirmingDelete(false)} />
                </>
              ) : (
                <PanelButton icon={Trash2} label="删除" onClick={() => setConfirmingDelete(true)} danger />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function PanelButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      transition={{ duration: 0.15, ease: APPLE_CURVE }}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors ${
        danger
          ? 'border-red-500/20 text-red-500 hover:bg-red-500/10'
          : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      } ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
    >
      <Icon size={11} />
      {label}
    </motion.button>
  );
}
