import { useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, X } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { useSkillStore } from '../../store/useSkillStore';
import { AppleToggle } from '../settings/SettingsSidebarPanels';

interface SkillCreateDialogProps {
  onClose: () => void;
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function SkillCreateDialog({ onClose }: SkillCreateDialogProps) {
  const create = useSkillStore((state) => state.create);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [whenToUse, setWhenToUse] = useState('');
  const [autoInvocable, setAutoInvocable] = useState(true);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = NAME_PATTERN.test(name);
  const canSubmit = nameValid && description.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await create({
        name: name.trim(),
        description: description.trim(),
        ...(whenToUse.trim() ? { whenToUse: whenToUse.trim() } : {}),
        autoInvocable,
        ...(body.trim() ? { body } : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: APPLE_CURVE }}
      className="absolute inset-0 z-20 flex items-center justify-center bg-[rgba(28,28,30,0.16)] p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.3, ease: APPLE_CURVE }}
        className="flex max-h-full w-full max-w-[420px] flex-col overflow-hidden rounded-[22px] border border-border bg-background shadow-[0_28px_70px_-36px_rgba(15,23,42,0.38)]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold text-foreground">新建技能</span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto custom-scrollbar px-4 py-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">名称</label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-skill"
              className="w-full rounded-xl border border-border bg-muted/20 px-3 py-2 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
            <p className={`mt-1 text-[10px] ${name && !nameValid ? 'text-[#d65a54]' : 'text-muted-foreground'}`}>
              小写字母、数字与连字符（如 pdf-tools）
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">描述</label>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个技能做什么"
              className="w-full rounded-xl border border-border bg-muted/20 px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">适用场景（可选）</label>
            <input
              value={whenToUse}
              onChange={(event) => setWhenToUse(event.target.value)}
              placeholder="什么时候应该使用这个技能"
              className="w-full rounded-xl border border-border bg-muted/20 px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
          </div>

          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 px-3 py-2">
            <span className="text-[12px] text-foreground">允许 AI 自动调用</span>
            <AppleToggle size="sm" checked={autoInvocable} onChange={() => setAutoInvocable((value) => !value)} />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">正文（可选，Markdown）</label>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              spellCheck={false}
              placeholder="# 使用说明&#10;&#10;在这里编写技能的详细指令..."
              className="h-36 w-full resize-none rounded-xl border border-border bg-muted/20 px-3 py-2 font-mono text-[11px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
          </div>

          {error && <p className="text-[11px] text-[#d65a54]">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-muted/60 px-3 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            创建
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
