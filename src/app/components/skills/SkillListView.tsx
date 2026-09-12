import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, CircleAlert, Eye, Pencil, ScrollText, Search, Trash2, X } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { SkillInfo } from '../../services/skillService';
import {
  filterSkills,
  selectSkills,
  selectSkillErrors,
  selectSkillErrorsDismissed,
  selectSkillPlatform,
  selectSkillScopeFilter,
  selectSkillSearchInDescription,
  selectSkillSearchQuery,
  selectSkillStatusFilter,
  selectShadowedSkills,
  useSkillStore,
  SkillScopeFilter,
  SkillStatusFilter,
} from '../../store/useSkillStore';
import { Toggle } from '../common';
import { ScopeBadge, StatusBadges } from './skillUi';

interface SkillListViewProps {
  onOpenDetail: (name: string, edit?: boolean) => void;
}

const STATUS_FILTERS: Array<{ id: SkillStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '未启用' },
];

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${
        active ? 'bg-foreground text-background' : 'bg-muted/50 text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}

function SkillErrorCard() {
  const errors = useSkillStore(selectSkillErrors);
  const dismissed = useSkillStore(selectSkillErrorsDismissed);
  const dismissErrors = useSkillStore((state) => state.dismissErrors);

  if (errors.length === 0 || dismissed) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: APPLE_CURVE }}
      className="mx-3 mt-3 rounded-2xl border border-[#ff9f0a]/30 bg-[#ff9f0a]/5 p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#ff9f0a]">
          <CircleAlert size={13} />
          <span>{errors.length} 个技能加载失败</span>
        </div>
        <button
          type="button"
          onClick={dismissErrors}
          className="flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="忽略加载错误"
        >
          <X size={12} />
        </button>
      </div>
      <div className="space-y-1.5">
        {errors.map((error, index) => (
          <div key={`${error.location}-${index}`} className="rounded-xl bg-background/70 px-2.5 py-2">
            <div className="text-[11px] font-medium text-foreground">
              <span className="mr-1.5 rounded bg-muted/70 px-1 py-0.5 font-mono text-[10px]">{error.code}</span>
              {error.message}
            </div>
            <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{error.location}</div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function SkillCardItem({ skill, shadowed, onOpenDetail }: { skill: SkillInfo; shadowed?: boolean; onOpenDetail: (name: string, edit?: boolean) => void }) {
  const setEnabled = useSkillStore((state) => state.setEnabled);
  const remove = useSkillStore((state) => state.remove);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await remove(skill.name);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-background/80 p-3 transition-shadow duration-300 hover:shadow-[0_8px_24px_rgba(0,0,0,0.05)]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{skill.name}</span>
        <ScopeBadge scope={skill.scope} />
        <StatusBadges skill={skill} />
        <span className="flex-1" />
        <span onClick={(event) => event.stopPropagation()}>
          <Toggle
            size="sm"
            checked={skill.enabled}
            onChange={() => void setEnabled(skill.name, !skill.enabled)}
          />
        </span>
      </div>
      {skill.description ? (
        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{skill.description}</p>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5">
        {confirmingDelete ? (
          <>
            <span className="text-[11px] font-medium text-[#d65a54]">确认删除此技能？</span>
            <span className="flex-1" />
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleDelete()}
              className="rounded-lg bg-[#d65a54] px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? '删除中…' : '删除'}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => setConfirmingDelete(false)}
              className="rounded-lg bg-muted/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onOpenDetail(skill.name)}
              className="flex items-center gap-1 rounded-lg bg-muted/50 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Eye size={11} />
              详情
            </button>
            {!shadowed && (
              <>
                <button
                  type="button"
                  onClick={() => onOpenDetail(skill.name, true)}
                  className="flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={`编辑 ${skill.name}`}
                  title="编辑"
                >
                  <Pencil size={11} />
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[#d65a54]/10 hover:text-[#d65a54]"
                  aria-label={`删除 ${skill.name}`}
                  title="删除"
                >
                  <Trash2 size={11} />
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function SkillListView({ onOpenDetail }: SkillListViewProps) {
  const searchQuery = useSkillStore(selectSkillSearchQuery);
  const searchInDescription = useSkillStore(selectSkillSearchInDescription);
  const statusFilter = useSkillStore(selectSkillStatusFilter);
  const scopeFilter = useSkillStore(selectSkillScopeFilter);
  const platform = useSkillStore(selectSkillPlatform);
  const shadowed = useSkillStore(selectShadowedSkills);
  const setSearchQuery = useSkillStore((state) => state.setSearchQuery);
  const setSearchInDescription = useSkillStore((state) => state.setSearchInDescription);
  const setStatusFilter = useSkillStore((state) => state.setStatusFilter);
  const setScopeFilter = useSkillStore((state) => state.setScopeFilter);
  const [shadowedExpanded, setShadowedExpanded] = useState(false);
  const skills = useSkillStore(selectSkills);

  const filtered = useMemo(
    () => filterSkills({ skills, searchQuery, searchInDescription, statusFilter, scopeFilter }),
    [skills, searchQuery, searchInDescription, statusFilter, scopeFilter],
  );

  const scopeFilters: Array<{ id: SkillScopeFilter; label: string }> = [
    { id: 'all', label: '全部' },
    ...(platform?.hasProjectScope ? [{ id: 'project' as const, label: '项目' }] : []),
    { id: 'global', label: '全局' },
    { id: 'plugin', label: '插件' },
    { id: 'mcp', label: 'MCP' },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SkillErrorCard />

      {/* 搜索栏 */}
      <div className="flex items-center gap-2 px-3 pt-3">
        <label className="flex flex-1 items-center gap-2 rounded-xl border border-border bg-muted/30 px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索技能..."
            className="w-full border-none bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <button
          type="button"
          onClick={() => setSearchInDescription(!searchInDescription)}
          aria-pressed={searchInDescription}
          className={`shrink-0 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors ${
            searchInDescription ? 'bg-foreground text-background' : 'bg-muted/50 text-muted-foreground hover:text-foreground'
          }`}
          title="同时在描述中搜索"
        >
          含描述
        </button>
      </div>

      {/* 筛选 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pt-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">状态</span>
          {STATUS_FILTERS.map((filter) => (
            <FilterChip
              key={filter.id}
              active={statusFilter === filter.id}
              label={filter.label}
              onClick={() => setStatusFilter(filter.id)}
            />
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">来源</span>
          {scopeFilters.map((filter) => (
            <FilterChip
              key={filter.id}
              active={scopeFilter === filter.id}
              label={filter.label}
              onClick={() => setScopeFilter(filter.id)}
            />
          ))}
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 space-y-2 overflow-y-auto custom-scrollbar px-3 py-3">
        {filtered.length === 0 && shadowed.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground">
              <ScrollText size={18} />
            </div>
            <p className="text-[13px] font-medium text-foreground">暂无技能</p>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              点击右上角「新建」创建第一个技能，或调整搜索与筛选条件。
            </p>
          </div>
        ) : (
          <>
            {filtered.map((skill) => (
              <SkillCardItem key={skill.canonicalName || skill.name} skill={skill} onOpenDetail={onOpenDetail} />
            ))}

            {shadowed.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShadowedExpanded((value) => !value)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
                >
                  <motion.span animate={{ rotate: shadowedExpanded ? 0 : -90 }} transition={{ duration: 0.25, ease: APPLE_CURVE }}>
                    <ChevronDown size={12} />
                  </motion.span>
                  被遮蔽的技能（{shadowed.length}）
                </button>
                <AnimatePresence initial={false}>
                  {shadowedExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: APPLE_CURVE }}
                      className="overflow-hidden"
                    >
                      <div className="space-y-2 pt-1.5 opacity-75">
                        {shadowed.map((skill) => (
                          <SkillCardItem key={skill.location} skill={skill} shadowed onOpenDetail={onOpenDetail} />
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
