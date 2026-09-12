import { useEffect, useState } from 'react';
import { Check, Eye, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { SkillInfo, getSkillFile } from '../../services/skillService';
import {
  selectSelectedSkillName,
  selectSkillContent,
  selectSkillFileTree,
  selectSkills,
  useSkillStore,
} from '../../store/useSkillStore';
import { MarkdownContent } from '../ui/MarkdownContent';
import { SkillFileTree } from './SkillFileTree';
import { ScopeBadge, StatusBadges, stripFrontmatter } from './skillUi';

interface SkillDetailViewProps {
  startInEdit: boolean;
}

function BoolValue({ value }: { value: boolean }) {
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${value ? 'bg-[#30d158]/10 text-[#30d158]' : 'bg-muted/60 text-muted-foreground'}`}>
      {value ? '是' : '否'}
    </span>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-[11px] text-foreground">{children}</span>
    </div>
  );
}

function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">{title}</div>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  );
}

const FRONTMATTER_KNOWN_KEYS = new Set(['name', 'description', 'version', 'when_to_use', 'whenToUse', 'when-to-use']);

function SkillInfoPanel({ skill }: { skill: SkillInfo }) {
  const extraFrontmatter = Object.entries(skill.frontmatter ?? {}).filter(
    ([key]) => !FRONTMATTER_KNOWN_KEYS.has(key),
  );

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <InfoSection title="基本信息">
        <InfoRow label="标识名"><span className="font-mono">{skill.canonicalName}</span></InfoRow>
        <InfoRow label="名称"><span className="font-mono">{skill.name}</span></InfoRow>
        <InfoRow label="版本"><span className="font-mono">{skill.version || '—'}</span></InfoRow>
        <InfoRow label="来源"><ScopeBadge scope={skill.scope} /></InfoRow>
        <InfoRow label="状态">
          <span className="flex flex-wrap justify-end gap-1">
            <StatusBadges skill={skill} />
            {skill.active && skill.enabled && skill.permission !== 'deny' && !skill.shadowedBy && (
              <span className="rounded-md bg-[#30d158]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#30d158]">正常</span>
            )}
          </span>
        </InfoRow>
      </InfoSection>

      <InfoSection title="调用方式">
        <InfoRow label="已启用"><BoolValue value={skill.enabled} /></InfoRow>
        <InfoRow label="自动调用"><BoolValue value={skill.autoInvocable} /></InfoRow>
        <InfoRow label="用户调用"><BoolValue value={skill.userInvocable} /></InfoRow>
        <InfoRow label="已激活"><BoolValue value={skill.active} /></InfoRow>
      </InfoSection>

      {skill.whenToUse ? (
        <InfoSection title="适用场景">
          <p className="py-1.5 text-[11px] leading-4 text-foreground">{skill.whenToUse}</p>
        </InfoSection>
      ) : null}

      {skill.paths && skill.paths.length > 0 ? (
        <InfoSection title="激活路径">
          <div className="space-y-1 py-1.5">
            {skill.paths.map((path) => (
              <div key={path} className="break-all rounded-lg bg-muted/40 px-2 py-1 font-mono text-[10px] text-foreground">{path}</div>
            ))}
          </div>
        </InfoSection>
      ) : null}

      {skill.review ? (
        <InfoSection title="本地静态检查">
          <p className="py-1.5 text-[11px] leading-4 text-muted-foreground">{skill.review.summary}</p>
          {skill.review.findings.slice(0, 6).map((finding) => (
            <div key={`${finding.code}-${finding.path ?? 'skill'}-${finding.message}`} className="py-1.5 text-left text-[11px] leading-4">
              <span className="font-semibold text-foreground">{finding.severity}</span>
              <span className="text-muted-foreground"> · {finding.path ?? 'SKILL.md'} · {finding.message}</span>
            </div>
          ))}
        </InfoSection>
      ) : null}

      <InfoSection title="位置">
        <p className="break-all py-1.5 font-mono text-[10px] leading-4 text-muted-foreground">{skill.location}</p>
      </InfoSection>

      {extraFrontmatter.length > 0 ? (
        <InfoSection title="其他元数据">
          {extraFrontmatter.map(([key, value]) => (
            <InfoRow key={key} label={key}>
              <span className="break-all font-mono text-[10px]">
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </span>
            </InfoRow>
          ))}
        </InfoSection>
      ) : null}
    </div>
  );
}

export function SkillDetailView({ startInEdit }: SkillDetailViewProps) {
  const selectedSkillName = useSkillStore(selectSelectedSkillName);
  const skillContent = useSkillStore(selectSkillContent);
  const fileTree = useSkillStore(selectSkillFileTree);
  const skills = useSkillStore(selectSkills);
  const shadowed = useSkillStore((state) => state.shadowed);
  const updateContent = useSkillStore((state) => state.updateContent);
  const upsertResource = useSkillStore((state) => state.upsertResource);
  const deleteResource = useSkillStore((state) => state.deleteResource);
  const validate = useSkillStore((state) => state.validate);

  const skill = [...skills, ...shadowed].find((item) => item.canonicalName === selectedSkillName || item.name === selectedSkillName) ?? null;

  const [editing, setEditing] = useState(startInEdit);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [resourceEditing, setResourceEditing] = useState(false);
  const [resourceDraft, setResourceDraft] = useState('');
  const [resourceSaving, setResourceSaving] = useState(false);
  const [reviewSummary, setReviewSummary] = useState<string | null>(null);

  useEffect(() => {
    setEditing(startInEdit);
    setDraft(null);
    setPreviewFile(null);
    setResourceEditing(false);
    setResourceDraft('');
    setReviewSummary(null);
  }, [selectedSkillName, startInEdit]);

  if (!skill) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        未找到技能信息
      </div>
    );
  }

  const handleSelectFile = async (path: string) => {
    if (!selectedSkillName) return;
    setPreviewLoading(true);
    try {
      const content = await getSkillFile(selectedSkillName, path);
      setPreviewFile({ path, content });
      setResourceEditing(false);
      setResourceDraft(content);
    } catch (error) {
      console.warn('Failed to load skill file.', error);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleStartEdit = () => {
    setDraft(skillContent ?? '');
    setEditing(true);
  };

  const handleSave = async () => {
    if (!selectedSkillName || draft === null) return;
    setSaving(true);
    try {
      await updateContent(selectedSkillName, draft);
      setEditing(false);
      setDraft(null);
    } catch (error) {
      console.warn('Failed to save skill content.', error);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateResource = async () => {
    if (!selectedSkillName) return;
    const path = window.prompt('输入资源文件路径，例如 assets/notes.md');
    if (!path) return;
    setResourceSaving(true);
    try {
      await upsertResource(selectedSkillName, path, '');
      setPreviewFile({ path, content: '' });
      setResourceDraft('');
      setResourceEditing(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '创建资源文件失败');
    } finally {
      setResourceSaving(false);
    }
  };

  const handleSaveResource = async () => {
    if (!selectedSkillName || !previewFile) return;
    setResourceSaving(true);
    try {
      await upsertResource(selectedSkillName, previewFile.path, resourceDraft);
      setPreviewFile({ path: previewFile.path, content: resourceDraft });
      setResourceEditing(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '保存资源文件失败');
    } finally {
      setResourceSaving(false);
    }
  };

  const handleDeleteResource = async () => {
    if (!selectedSkillName || !previewFile) return;
    if (!window.confirm(`删除资源文件 ${previewFile.path}？`)) return;
    setResourceSaving(true);
    try {
      await deleteResource(selectedSkillName, previewFile.path);
      setPreviewFile(null);
      setResourceDraft('');
      setResourceEditing(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '删除资源文件失败');
    } finally {
      setResourceSaving(false);
    }
  };

  const handleValidate = async () => {
    if (!selectedSkillName) return;
    try {
      const result = await validate(selectedSkillName);
      setReviewSummary(result.review.summary);
    } catch (error) {
      setReviewSummary(error instanceof Error ? error.message : '校验失败');
    }
  };

  const markdownBody = skillContent ? stripFrontmatter(skillContent) : '';

  return (
    <div className="flex h-full flex-col overflow-hidden xl:flex-row">
      {/* 左：文件树 */}
      <div className="max-h-40 shrink-0 overflow-y-auto border-b border-border custom-scrollbar xl:h-full xl:max-h-none xl:w-44 xl:border-b-0 xl:border-r">
        <div className="flex items-center gap-1 px-3 pb-1 pt-3">
          <span className="flex-1 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">文件</span>
          <button
            type="button"
            disabled={resourceSaving}
            onClick={() => void handleCreateResource()}
            className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="新建资源文件"
            title="新建资源文件"
          >
            <Plus size={11} />
          </button>
        </div>
        <SkillFileTree tree={fileTree} selectedPath={previewFile?.path ?? null} onSelectFile={(path) => void handleSelectFile(path)} />
      </div>

      {/* 中：内容 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          {previewFile ? (
            <>
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{previewFile.path}</span>
              <button
                type="button"
                onClick={() => setPreviewFile(null)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="关闭文件预览"
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <span className="truncate font-mono text-[11px] text-muted-foreground">SKILL.md</span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void handleValidate()}
            className="rounded-lg bg-muted/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            title="本地静态校验，不是 LLM 审计"
          >
            校验
          </button>
          {editing ? (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSave()}
                className="flex items-center gap-1 rounded-lg bg-foreground px-2 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                保存
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => { setEditing(false); setDraft(null); }}
                className="rounded-lg bg-muted/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                取消
              </button>
            </>
          ) : previewFile ? (
            <>
              {resourceEditing ? (
                <button
                  type="button"
                  disabled={resourceSaving}
                  onClick={() => void handleSaveResource()}
                  className="flex items-center gap-1 rounded-lg bg-foreground px-2 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {resourceSaving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  保存资源
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setResourceDraft(previewFile.content); setResourceEditing(true); }}
                  className="flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="编辑资源文件"
                  title="编辑资源文件"
                >
                  <Pencil size={12} />
                </button>
              )}
              <button
                type="button"
                disabled={resourceSaving}
                onClick={() => void handleDeleteResource()}
                className="flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-[#d65a54] disabled:opacity-50"
                aria-label="删除资源文件"
                title="删除资源文件"
              >
                <Trash2 size={12} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={editing ? undefined : (previewFile ? () => setPreviewFile(null) : handleStartEdit)}
              className="flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={previewFile ? '返回 SKILL.md' : '编辑 SKILL.md'}
              title={previewFile ? '返回 SKILL.md' : '编辑'}
            >
              {previewFile ? <Eye size={12} /> : <Pencil size={12} />}
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 py-3">
          {reviewSummary ? (
            <div className="mb-3 rounded-xl border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              {reviewSummary}
            </div>
          ) : null}
          {previewFile ? (
            resourceEditing ? (
              <textarea
                value={resourceDraft}
                onChange={(event) => setResourceDraft(event.target.value)}
                spellCheck={false}
                className="h-full min-h-[320px] w-full resize-none rounded-xl border border-border bg-muted/20 p-3 font-mono text-[11px] leading-5 text-foreground outline-none focus:border-foreground/30"
              />
            ) : (
              <pre className="whitespace-pre-wrap break-all rounded-xl bg-muted/30 p-3 font-mono text-[11px] leading-5 text-foreground">
                {previewLoading ? '加载中…' : previewFile.content}
              </pre>
            )
          ) : editing ? (
            <textarea
              value={draft ?? ''}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              className="h-full min-h-[320px] w-full resize-none rounded-xl border border-border bg-muted/20 p-3 font-mono text-[11px] leading-5 text-foreground outline-none focus:border-foreground/30"
            />
          ) : skillContent === null ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
              加载中…
            </div>
          ) : (
            <MarkdownContent content={markdownBody} status="done" />
          )}
        </div>
      </div>

      {/* 右：技能信息 */}
      <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border custom-scrollbar xl:h-full xl:max-h-none xl:w-56 xl:border-l xl:border-t-0">
        <SkillInfoPanel skill={skill} />
      </div>
    </div>
  );
}
