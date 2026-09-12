import { useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, X } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { useSkillStore } from '../../store/useSkillStore';
import { Toggle } from '../common';

interface SkillCreateDialogProps {
  onClose: () => void;
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface FieldErrors {
  name?: string;
  description?: string;
  whenToUse?: string;
}

export function SkillCreateDialog({ onClose }: SkillCreateDialogProps) {
  const create = useSkillStore((state) => state.create);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [whenToUse, setWhenToUse] = useState('');
  const [autoInvocable, setAutoInvocable] = useState(true);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const validateFields = (): FieldErrors => {
    const errors: FieldErrors = {};
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedWhenToUse = whenToUse.trim();
    if (!trimmedName) {
      errors.name = '名称必填';
    } else if (trimmedName.length > 64 || !NAME_PATTERN.test(trimmedName)) {
      errors.name = '仅支持小写字母、数字和单连字符，最长 64 字符';
    }
    if (!trimmedDescription) {
      errors.description = '描述必填';
    } else if (trimmedDescription.length > 500) {
      errors.description = '描述不能超过 500 字符';
    }
    if (autoInvocable && !trimmedWhenToUse) {
      errors.whenToUse = '允许 AI 自动调用时，触发条件必填';
    } else if (trimmedWhenToUse.length > 100) {
      errors.whenToUse = '触发条件不能超过 100 字符';
    }
    return errors;
  };

  const canSubmit = !submitting;

  const handleSubmit = async () => {
    const nextErrors = validateFields();
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !canSubmit) return;
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
              onChange={(event) => { setName(event.target.value); setFieldErrors((value) => ({ ...value, name: undefined })); }}
              placeholder="my-skill"
              className="w-full rounded-xl border border-border bg-muted/20 px-3 py-2 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
            <p className={`mt-1 text-[10px] ${fieldErrors.name ? 'text-[#d65a54]' : 'text-muted-foreground'}`}>
              {fieldErrors.name ?? '小写字母、数字与连字符（如 pdf-tools）'}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">描述</label>
            <input
              value={description}
              onChange={(event) => { setDescription(event.target.value); setFieldErrors((value) => ({ ...value, description: undefined })); }}
              placeholder="这个技能做什么"
              className="w-full rounded-xl border border-border bg-muted/20 px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
            {fieldErrors.description && <p className="mt-1 text-[10px] text-[#d65a54]">{fieldErrors.description}</p>}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">触发条件{autoInvocable ? '' : '（可选）'}</label>
            <input
              value={whenToUse}
              onChange={(event) => { setWhenToUse(event.target.value); setFieldErrors((value) => ({ ...value, whenToUse: undefined })); }}
              placeholder="什么时候应该使用这个技能"
              className="w-full rounded-xl border border-border bg-muted/20 px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
            {fieldErrors.whenToUse && <p className="mt-1 text-[10px] text-[#d65a54]">{fieldErrors.whenToUse}</p>}
          </div>

          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/20 px-3 py-2">
            <span className="text-[12px] text-foreground">允许 AI 自动调用</span>
            <Toggle size="sm" checked={autoInvocable} onChange={() => { setAutoInvocable((value) => !value); setFieldErrors((value) => ({ ...value, whenToUse: undefined })); }} />
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
