import React from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Check, Copy, Eye, FolderOpen, Loader2, Pencil, Save } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import type { SkillInfo } from '../../services/skillService';
import { useSkillStore } from '../../store/useSkillStore';
import { MarkdownContent } from '../ui/MarkdownContent';
import { SCOPE_LABELS, SCOPE_STYLES } from './SkillCard';
import { SkillFilesSheet } from './SkillFilesSheet';

interface SkillDetailViewProps {
  skill: SkillInfo;
  autoEdit?: boolean;
  onBack: () => void;
}

/** 去掉 SKILL.md 开头两个 --- 之间的 frontmatter，只保留正文 */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'whenToUse',
  'when-to-use',
  'version',
  'paths',
  'enabled',
  'autoInvocable',
  'auto-invocable',
  'userInvocable',
  'user-invocable',
  'permission',
  'scope',
]);

function boolText(value: boolean): string {
  return value ? '是' : '否';
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="w-[72px] shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words text-[12px] text-foreground">{children}</span>
    </div>
  );
}

export function SkillDetailView({ skill, autoEdit, onBack }: SkillDetailViewProps) {
  const skillContent = useSkillStore((s) => s.skillContent);
  const skillContentLoading = useSkillStore((s) => s.skillContentLoading);
  const fileTree = useSkillStore((s) => s.fileTree);
  const updateContent = useSkillStore((s) => s.updateContent);

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const autoEditConsumedRef = React.useRef(false);

  // 从卡片的「编辑」按钮进入时，内容就绪后直接进入编辑态（仅一次）
  React.useEffect(() => {
    if (autoEdit && !autoEditConsumedRef.current && !skill.bundled && skillContent !== null) {
      autoEditConsumedRef.current = true;
      setDraft(skillContent);
      setEditing(true);
    }
  }, [autoEdit, skill.bundled, skillContent]);

  const handleStartEdit = () => {
    setDraft(skillContent ?? '');
    setSaveError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateContent(skill.name, draft);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!skillContent) return;
    try {
      await navigator.clipboard.writeText(skillContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用时静默失败
    }
  };

  const frontmatterExtras = Object.entries(skill.frontmatter ?? {}).filter(
    ([key]) => !KNOWN_FRONTMATTER_KEYS.has(key),
  );

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 relative">
      <div className="flex-1 overflow-y-auto custom-scrollbar px-5 pb-8 pt-6 space-y-4">
        {/* 标题栏 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <motion.button
              type="button"
              whileTap={{ scale: 0.9 }}
              transition={{ duration: 0.15, ease: APPLE_CURVE }}
              onClick={onBack}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              aria-label="返回技能列表"
            >
              <ArrowLeft size={14} />
            </motion.button>
            <span className="truncate text-[13px] font-semibold text-foreground">{skill.name}</span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${SCOPE_STYLES[skill.scope]}`}>
              {SCOPE_LABELS[skill.scope]}
            </span>
          </div>
          <motion.button
            type="button"
            whileTap={{ scale: 0.9 }}
            transition={{ duration: 0.15, ease: APPLE_CURVE }}
            onClick={() => setFilesOpen(true)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
            aria-label="查看技能文件"
          >
            <FolderOpen size={14} />
          </motion.button>
        </div>

        {/* 技能信息面板 */}
        <div className="bg-background/80 backdrop-blur-xl rounded-[20px] border border-border px-4 py-3 divide-y divide-border/50">
          <InfoRow label="标识">{skill.canonicalName}</InfoRow>
          <InfoRow label="名称">{skill.name}</InfoRow>
          {skill.version && <InfoRow label="版本">{skill.version}</InfoRow>}
          <InfoRow label="来源">{SCOPE_LABELS[skill.scope]}</InfoRow>
          <InfoRow label="已启用">{boolText(skill.enabled)}</InfoRow>
          <InfoRow label="自动调用">{boolText(skill.autoInvocable)}</InfoRow>
          <InfoRow label="手动调用">{boolText(skill.userInvocable)}</InfoRow>
          <InfoRow label="已激活">{boolText(skill.active)}</InfoRow>
          {skill.whenToUse && <InfoRow label="何时使用">{skill.whenToUse}</InfoRow>}
          {skill.paths && skill.paths.length > 0 && (
            <InfoRow label="激活路径">
              <span className="font-mono text-[11px]">{skill.paths.join(', ')}</span>
            </InfoRow>
          )}
          <InfoRow label="位置">
            <span className="font-mono text-[11px]">{skill.location}</span>
          </InfoRow>
          {frontmatterExtras.map(([key, value]) => (
            <InfoRow key={key} label={key}>
              <span className="font-mono text-[11px]">
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </span>
            </InfoRow>
          ))}
        </div>

        {/* SKILL.md 内容 */}
        <div className="bg-background/80 backdrop-blur-xl rounded-[20px] border border-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.15em]">
              SKILL.md
            </span>
            <div className="flex items-center gap-1">
              {!skill.bundled && (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  transition={{ duration: 0.15, ease: APPLE_CURVE }}
                  onClick={editing ? () => setEditing(false) : handleStartEdit}
                  disabled={skillContentLoading || skillContent === null}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-40"
                  aria-label={editing ? '预览' : '编辑'}
                >
                  {editing ? <Eye size={13} /> : <Pencil size={13} />}
                </motion.button>
              )}
              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                transition={{ duration: 0.15, ease: APPLE_CURVE }}
                onClick={() => void handleCopy()}
                disabled={!skillContent}
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-40"
                aria-label="复制 SKILL.md 原文"
              >
                {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
              </motion.button>
            </div>
          </div>

          <div className="px-4 py-3">
            {skillContentLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-[12px]">加载中…</span>
              </div>
            ) : skillContent === null ? (
              <div className="py-8 text-center text-[12px] text-muted-foreground">内容加载失败</div>
            ) : editing ? (
              <div className="space-y-2.5">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="h-[320px] w-full resize-none rounded-[14px] border border-border bg-muted/40 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-foreground/30"
                />
                {saveError && (
                  <div className="rounded-[14px] bg-red-500/[0.06] border border-red-500/20 px-3.5 py-2.5 text-[11px] text-red-500">
                    保存失败：{saveError}
                  </div>
                )}
                <div className="flex justify-end">
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.94 }}
                    transition={{ duration: 0.15, ease: APPLE_CURVE }}
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-[11px] font-semibold text-background disabled:opacity-40"
                  >
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    保存
                  </motion.button>
                </div>
              </div>
            ) : (
              <MarkdownContent content={stripFrontmatter(skillContent)} status="done" />
            )}
          </div>
        </div>
      </div>

      <SkillFilesSheet
        open={filesOpen}
        skillName={skill.name}
        tree={fileTree}
        onClose={() => setFilesOpen(false)}
      />
    </div>
  );
}
