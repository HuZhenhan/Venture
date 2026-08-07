import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Plus, RefreshCw, ScrollText, Settings2 } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { selectSetActiveSettingsTab, useLayoutStore } from '../../store/useLayoutStore';
import { selectSelectedSkillName, useSkillStore } from '../../store/useSkillStore';
import { SkillCreateDialog } from './SkillCreateDialog';
import { SkillDetailView } from './SkillDetailView';
import { SkillListView } from './SkillListView';

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      transition={{ duration: 0.15, ease: APPLE_CURVE }}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      {children}
    </motion.button>
  );
}

export function SkillPanel() {
  const refresh = useSkillStore((state) => state.refresh);
  const loading = useSkillStore((state) => state.loading);
  const selectedSkillName = useSkillStore(selectSelectedSkillName);
  const select = useSkillStore((state) => state.select);
  const setActiveSettingsTab = useLayoutStore(selectSetActiveSettingsTab);
  const showPanel = useLayoutStore((state) => state.showPanel);

  const [createOpen, setCreateOpen] = useState(false);
  const [startInEdit, setStartInEdit] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openSettings = () => {
    setActiveSettingsTab('skills');
    showPanel('settings');
  };

  const openDetail = (name: string, edit = false) => {
    setStartInEdit(edit);
    void select(name);
  };

  const handleBack = () => {
    setStartInEdit(false);
    void select(null);
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background">
      {/* 头部 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2.5">
        {selectedSkillName ? (
          <HeaderButton label="返回列表" onClick={handleBack}>
            <ArrowLeft size={14} />
          </HeaderButton>
        ) : (
          <span className="flex h-7 w-7 items-center justify-center text-muted-foreground">
            <ScrollText size={14} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {selectedSkillName ?? '技能'}
        </span>
        <HeaderButton label="刷新" onClick={() => void refresh()}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </HeaderButton>
        <HeaderButton label="新建技能" onClick={() => setCreateOpen(true)}>
          <Plus size={14} />
        </HeaderButton>
        <HeaderButton label="技能设置" onClick={openSettings}>
          <Settings2 size={13} />
        </HeaderButton>
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {selectedSkillName ? (
            <motion.div
              key={`detail-${selectedSkillName}`}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.3, ease: APPLE_CURVE }}
              className="h-full"
            >
              <SkillDetailView startInEdit={startInEdit} />
            </motion.div>
          ) : (
            <motion.div
              key="list"
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.3, ease: APPLE_CURVE }}
              className="h-full"
            >
              <SkillListView onOpenDetail={openDetail} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 新建对话框 */}
      <AnimatePresence>
        {createOpen && <SkillCreateDialog onClose={() => setCreateOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
