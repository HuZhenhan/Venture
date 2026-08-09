import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ScrollText,
  Plus,
  Upload,
  Settings2,
  Search,
  RefreshCw,
  ChevronDown,
  X,
  CircleAlert,
  Loader2,
} from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { useSkillStore, type SkillScopeFilter, type SkillStatusFilter } from '../../store/useSkillStore';
import { useLayoutStore } from '../../store/useLayoutStore';
import type { SkillInfo } from '../../services/skillService';
import { SkillCard } from './SkillCard';
import { SkillDetailView } from './SkillDetailView';

/**
 * 技能管理面板。
 *
 * - 列表：搜索（名称/描述）、状态与来源过滤、启用/禁用、删除（二次确认）
 * - 顶部操作：新建、设置（打开设置页 skills 标签）
 * - 导入 FAB（zip → base64 → 后端校验导入）
 * - 下拉刷新、扫描错误横幅（可展开详情/关闭）
 * - 详情页：信息面板 + 文件树弹层 + SKILL.md 预览/编辑/复制
 */

interface SkillPanelProps {
  width?: number;
}

const STATUS_FILTERS: Array<{ id: SkillStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '未启用' },
];

const SCOPE_FILTERS: Array<{ id: SkillScopeFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'global', label: '全局' },
  { id: 'plugin', label: '插件' },
  { id: 'mcp', label: 'MCP' },
];

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return window.btoa(binary);
}

function matchesSearch(skill: SkillInfo, query: string, searchInDescription: boolean): boolean {
  if (!query) return true;
  const lowered = query.toLowerCase();
  if (skill.name.toLowerCase().includes(lowered)) return true;
  if (skill.canonicalName.toLowerCase().includes(lowered)) return true;
  return searchInDescription && (skill.description ?? '').toLowerCase().includes(lowered);
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      transition={{ duration: 0.15, ease: APPLE_CURVE }}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors ${
        active
          ? 'border-foreground/20 bg-foreground text-background'
          : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {label}
    </motion.button>
  );
}

function NewSkillDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { name: string; description: string; whenToUse?: string; body?: string }) => Promise<void>;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [whenToUse, setWhenToUse] = React.useState('');
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async () => {
    if (busy) return;
    if (!name.trim() || !description.trim()) {
      setError('名称与描述为必填项');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        whenToUse: whenToUse.trim() || undefined,
        body: body.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: APPLE_CURVE }}
        onClick={onClose}
        className="absolute inset-0 z-40 bg-[rgba(28,28,30,0.3)] backdrop-blur-[2px]"
      />
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        transition={{ duration: 0.3, ease: APPLE_CURVE }}
        className="absolute inset-x-4 top-10 z-50 flex max-h-[calc(100%-5rem)] flex-col rounded-[24px] border border-border bg-background shadow-[0_24px_60px_-24px_rgba(0,0,0,0.3)]"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border/60">
          <span className="text-[13px] font-semibold text-foreground">新建技能</span>
          <motion.button
            type="button"
            whileTap={{ scale: 0.9 }}
            transition={{ duration: 0.15, ease: APPLE_CURVE }}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
            aria-label="关闭"
          >
            <X size={14} />
          </motion.button>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 space-y-3">
          <label className="block space-y-1">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.15em]">名称 *</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              className="w-full rounded-[14px] border border-border bg-muted/40 px-3.5 py-2.5 text-[12px] text-foreground outline-none focus:border-foreground/30"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.15em]">描述 *</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="这个技能能做什么"
              className="w-full rounded-[14px] border border-border bg-muted/40 px-3.5 py-2.5 text-[12px] text-foreground outline-none focus:border-foreground/30"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.15em]">何时使用</span>
            <input
              value={whenToUse}
              onChange={(e) => setWhenToUse(e.target.value)}
              placeholder="什么场景下应该触发（可选）"
              className="w-full rounded-[14px] border border-border bg-muted/40 px-3.5 py-2.5 text-[12px] text-foreground outline-none focus:border-foreground/30"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.15em]">正文</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="SKILL.md 正文（Markdown，可选）"
              className="h-[140px] w-full resize-none rounded-[14px] border border-border bg-muted/40 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-foreground/30"
            />
          </label>
          {error && (
            <div className="rounded-[14px] bg-red-500/[0.06] border border-red-500/20 px-3.5 py-2.5 text-[11px] text-red-500">
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-border/60">
          <motion.button
            type="button"
            whileTap={{ scale: 0.94 }}
            transition={{ duration: 0.15, ease: APPLE_CURVE }}
            onClick={onClose}
            className="rounded-full border border-border px-3.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            取消
          </motion.button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.94 }}
            transition={{ duration: 0.15, ease: APPLE_CURVE }}
            onClick={() => void handleSubmit()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-[11px] font-semibold text-background disabled:opacity-40"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            创建
          </motion.button>
        </div>
      </motion.div>
    </>
  );
}

export function SkillPanel({ width = 400 }: SkillPanelProps) {
  const skills = useSkillStore((s) => s.skills);
  const shadowed = useSkillStore((s) => s.shadowed);
  const errors = useSkillStore((s) => s.errors);
  const loading = useSkillStore((s) => s.loading);
  const loadError = useSkillStore((s) => s.loadError);
  const searchQuery = useSkillStore((s) => s.searchQuery);
  const searchInDescription = useSkillStore((s) => s.searchInDescription);
  const statusFilter = useSkillStore((s) => s.statusFilter);
  const scopeFilter = useSkillStore((s) => s.scopeFilter);
  const selectedSkillName = useSkillStore((s) => s.selectedSkillName);
  const refresh = useSkillStore((s) => s.refresh);
  const create = useSkillStore((s) => s.create);
  const remove = useSkillStore((s) => s.remove);
  const setEnabled = useSkillStore((s) => s.setEnabled);
  const importZip = useSkillStore((s) => s.importZip);
  const selectSkill = useSkillStore((s) => s.selectSkill);
  const setSearchQuery = useSkillStore((s) => s.setSearchQuery);
  const setSearchInDescription = useSkillStore((s) => s.setSearchInDescription);
  const setStatusFilter = useSkillStore((s) => s.setStatusFilter);
  const setScopeFilter = useSkillStore((s) => s.setScopeFilter);

  const showPanel = useLayoutStore((s) => s.showPanel);
  const setActiveSettingsTab = useLayoutStore((s) => s.setActiveSettingsTab);

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [importError, setImportError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [newDialogOpen, setNewDialogOpen] = React.useState(false);
  const [errorsDismissed, setErrorsDismissed] = React.useState(false);
  const [errorsExpanded, setErrorsExpanded] = React.useState(false);
  const [detailAutoEdit, setDetailAutoEdit] = React.useState(false);

  // 下拉刷新
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pullStartYRef = React.useRef<number | null>(null);
  const [pullDistance, setPullDistance] = React.useState(0);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // 新一次扫描产生新错误时重新显示横幅
  React.useEffect(() => {
    if (errors.length > 0) setErrorsDismissed(false);
  }, [errors]);

  const handleOpenSettings = () => {
    setActiveSettingsTab('skills');
    showPanel('settings');
  };

  const handleImportFile = async (file: File) => {
    setImportError(null);
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      await importZip(arrayBufferToBase64(buffer));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const handleOpenDetail = (skill: SkillInfo, autoEdit = false) => {
    setDetailAutoEdit(autoEdit);
    void selectSkill(skill.name);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    pullStartYRef.current =
      scrollRef.current && scrollRef.current.scrollTop <= 0 ? e.touches[0].clientY : null;
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (pullStartYRef.current === null) return;
    const delta = e.touches[0].clientY - pullStartYRef.current;
    if (delta > 0 && scrollRef.current && scrollRef.current.scrollTop <= 0) {
      setPullDistance(Math.min(delta, 100));
    } else if (pullDistance !== 0) {
      setPullDistance(0);
    }
  };

  const handleTouchEnd = () => {
    if (pullDistance > 60 && !loading) {
      void refresh();
    }
    pullStartYRef.current = null;
    setPullDistance(0);
  };

  const filteredSkills = React.useMemo(
    () =>
      skills.filter((skill) => {
        if (statusFilter === 'enabled' && !skill.enabled) return false;
        if (statusFilter === 'disabled' && skill.enabled) return false;
        if (scopeFilter !== 'all' && skill.scope !== scopeFilter) return false;
        return matchesSearch(skill, searchQuery.trim(), searchInDescription);
      }),
    [skills, statusFilter, scopeFilter, searchQuery, searchInDescription],
  );

  const selectedSkill = selectedSkillName
    ? [...skills, ...shadowed].find(
        (skill) => skill.name === selectedSkillName || skill.canonicalName === selectedSkillName,
      ) ?? null
    : null;

  return (
    <div className="shrink-0 h-full flex flex-col bg-sidebar z-20 overflow-hidden border-l border-border">
      <div className="flex-1 flex flex-col h-full relative" style={{ width }}>
        <AnimatePresence mode="wait" initial={false}>
          {selectedSkill ? (
            <motion.div
              key="detail"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.3, ease: APPLE_CURVE }}
              className="flex-1 flex flex-col h-full min-h-0"
            >
              <SkillDetailView
                skill={selectedSkill}
                autoEdit={detailAutoEdit}
                onBack={() => void selectSkill(null)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="list"
              initial={{ opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.3, ease: APPLE_CURVE }}
              className="flex-1 flex flex-col h-full min-h-0"
            >
              <div
                ref={scrollRef}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                className="flex-1 overflow-y-auto custom-scrollbar px-5 pb-8 pt-6 space-y-4 relative z-10"
              >
                {/* 下拉刷新指示器 */}
                <AnimatePresence>
                  {(pullDistance > 0 || loading) && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: APPLE_CURVE }}
                      className="flex items-center justify-center overflow-hidden"
                    >
                      <RefreshCw
                        size={14}
                        className={`text-muted-foreground ${loading || pullDistance > 60 ? 'animate-spin' : ''}`}
                        style={loading ? undefined : { transform: `rotate(${pullDistance * 3}deg)` }}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* 标题栏 + 顶部操作：新建 / 设置 在刷新按钮左侧 */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em]">
                    <ScrollText size={12} />
                    技能
                  </div>
                  <div className="flex items-center gap-1.5">
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.9 }}
                      transition={{ duration: 0.15, ease: APPLE_CURVE }}
                      onClick={() => setNewDialogOpen(true)}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      aria-label="新建技能"
                    >
                      <Plus size={13} />
                    </motion.button>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.9 }}
                      transition={{ duration: 0.15, ease: APPLE_CURVE }}
                      onClick={handleOpenSettings}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      aria-label="技能设置"
                    >
                      <Settings2 size={13} />
                    </motion.button>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.9 }}
                      transition={{ duration: 0.15, ease: APPLE_CURVE }}
                      onClick={() => void refresh()}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                      aria-label="刷新技能列表"
                    >
                      <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                    </motion.button>
                  </div>
                </div>

                {/* 搜索栏 */}
                <div className="flex items-center gap-2">
                  <label className="flex flex-1 items-center gap-2 rounded-[16px] border border-border bg-background/80 px-3 py-2">
                    <Search size={13} className="shrink-0 text-muted-foreground" />
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="搜索技能名称…"
                      className="w-full border-none bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </label>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.94 }}
                    transition={{ duration: 0.15, ease: APPLE_CURVE }}
                    onClick={() => setSearchInDescription(!searchInDescription)}
                    className={`shrink-0 rounded-full border px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
                      searchInDescription
                        ? 'border-foreground/20 bg-foreground text-background'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                    title="搜索时包含描述"
                  >
                    含描述
                  </motion.button>
                </div>

                {/* 过滤器 */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-bold text-muted-foreground">状态</span>
                    {STATUS_FILTERS.map((filter) => (
                      <FilterChip
                        key={filter.id}
                        label={filter.label}
                        active={statusFilter === filter.id}
                        onClick={() => setStatusFilter(filter.id)}
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-bold text-muted-foreground">来源</span>
                    {SCOPE_FILTERS.map((filter) => (
                      <FilterChip
                        key={filter.id}
                        label={filter.label}
                        active={scopeFilter === filter.id}
                        onClick={() => setScopeFilter(filter.id)}
                      />
                    ))}
                  </div>
                </div>

                {/* 扫描错误横幅 */}
                {errors.length > 0 && !errorsDismissed && (
                  <div className="rounded-[16px] bg-red-500/[0.06] border border-red-500/20 overflow-hidden">
                    <div className="flex items-center gap-2 px-3.5 py-2.5">
                      <CircleAlert size={13} className="shrink-0 text-red-500" />
                      <button
                        type="button"
                        onClick={() => setErrorsExpanded((v) => !v)}
                        className="flex flex-1 items-center gap-1 text-left text-[11px] font-medium text-red-500"
                      >
                        {errors.length} 个技能加载失败
                        <motion.span
                          animate={{ rotate: errorsExpanded ? 180 : 0 }}
                          transition={{ duration: 0.3, ease: APPLE_CURVE }}
                        >
                          <ChevronDown size={12} />
                        </motion.span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setErrorsDismissed(true)}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-red-500/70 hover:text-red-500"
                        aria-label="关闭错误提示"
                      >
                        <X size={11} />
                      </button>
                    </div>
                    <AnimatePresence initial={false}>
                      {errorsExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.3, ease: APPLE_CURVE }}
                          className="overflow-hidden"
                        >
                          <div className="space-y-1.5 px-3.5 pb-3">
                            {errors.map((error, index) => (
                              <div key={`${error.location}-${index}`} className="text-[10px] leading-relaxed text-red-500/90">
                                <span className="font-mono font-semibold">[{error.code}]</span> {error.message}
                                <div className="font-mono text-red-500/60 break-all">{error.location}</div>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {importError && (
                  <div className="rounded-[16px] bg-red-500/[0.06] border border-red-500/20 px-3.5 py-2.5 text-[11px] text-red-500 leading-relaxed">
                    导入失败：{importError}
                  </div>
                )}

                {loadError && (
                  <div className="rounded-[16px] bg-red-500/[0.06] border border-red-500/20 px-3.5 py-2.5 text-[11px] text-red-500">
                    {loadError}
                  </div>
                )}

                {/* 技能列表 */}
                <div className="space-y-2.5">
                  {filteredSkills.map((skill) => (
                    <SkillCard
                      key={skill.canonicalName}
                      skill={skill}
                      onOpenDetail={(autoEdit) => handleOpenDetail(skill, autoEdit)}
                      onToggleEnabled={() => void setEnabled(skill.name, !skill.enabled)}
                      onDelete={() => remove(skill.name)}
                    />
                  ))}
                  {!loading && filteredSkills.length === 0 && !loadError && (
                    <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                      <ScrollText size={28} strokeWidth={1.5} />
                      <div className="text-[12px]">
                        {skills.length === 0 ? '暂无技能，新建或点击右下角导入' : '没有匹配的技能'}
                      </div>
                    </div>
                  )}
                </div>

                {/* 被遮蔽的技能 */}
                {shadowed.length > 0 && (
                  <div className="space-y-2.5">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.15em]">
                      被遮蔽（{shadowed.length}）
                    </div>
                    {shadowed.map((skill) => (
                      <div
                        key={skill.canonicalName}
                        className="rounded-[20px] border border-border/60 bg-muted/30 px-4 py-3 opacity-70"
                      >
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[12px] font-medium text-foreground truncate">{skill.name}</span>
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
                            被 {skill.shadowedBy ?? '同名技能'} 遮蔽
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1 line-clamp-1">
                          {skill.description || '（无描述）'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 导入 FAB */}
              <motion.button
                type="button"
                whileTap={{ scale: 0.92 }}
                transition={{ duration: 0.15, ease: APPLE_CURVE }}
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="absolute bottom-6 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-background shadow-[0_10px_24px_-8px_rgba(0,0,0,0.35)] disabled:opacity-50"
                aria-label="导入技能 zip"
                title="导入技能（zip）"
              >
                {importing ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
              </motion.button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportFile(file);
                  e.target.value = '';
                }}
              />

              {/* 新建技能对话框 */}
              <AnimatePresence>
                {newDialogOpen && (
                  <NewSkillDialog
                    onClose={() => setNewDialogOpen(false)}
                    onSubmit={async (input) => {
                      await create(input);
                    }}
                  />
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
