import { useCallback, useEffect, useState } from 'react';
import {
  Camera,
  GitCompare,
  Zap,
  HardDrive,
  Loader2,
  Check,
  Trash2,
} from 'lucide-react';
import {
  BackupMode,
  BackupStatus,
  getBackupStatus,
  setBackupMode,
  deleteBackups,
} from '../services/toolService';

// ─── 模式配置 ──────────────────────────────────────────────────────────────

const MODE_CONFIG: Record<
  BackupMode,
  { label: string; description: string; icon: typeof Camera }
> = {
  snapshot: {
    label: 'Snapshot 模式',
    description: '写前全量备份，回退时整文件恢复。最可靠，空间占用较高。',
    icon: Camera,
  },
  hunks: {
    label: 'Hunk 模式',
    description: '行级 diff 审阅，支持选择性接受/拒绝单个 hunk。',
    icon: GitCompare,
  },
  auto: {
    label: 'Auto 模式',
    description: '根据文件大小、修改频率等特征自动选择策略。',
    icon: Zap,
  },
};

// ─── 主组件 ────────────────────────────────────────────────────────────────

interface BackupModeControlProps {
  /** 可选的关闭回调 */
  onClose?: () => void;
}

/**
 * 备份模式控制面板。
 *
 * 提供：
 * - 全局备份模式切换（snapshot / hunks / auto）
 * - 路径级策略覆写
 * - 空间占用查看
 * - 备份清理
 *
 * 通过 /backup-mode 命令打开，或从设置中进入。
 */
export function BackupModeControl({ onClose }: BackupModeControlProps) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pathPattern, setPathPattern] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getBackupStatus();
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const handleSetMode = useCallback(
    async (mode: BackupMode) => {
      setSaving(true);
      setError(null);
      try {
        await setBackupMode(mode);
        await refreshStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [refreshStatus],
  );

  const handleAddPathOverride = useCallback(async () => {
    if (!pathPattern.trim()) return;
    const currentMode = status?.mode ?? 'snapshot';
    setSaving(true);
    setError(null);
    try {
      await setBackupMode(currentMode, pathPattern.trim());
      setPathPattern('');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [pathPattern, status?.mode, refreshStatus]);

  const handleDeleteBackups = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await deleteBackups();
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [refreshStatus]);

  // 格式化空间大小
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={20} className="animate-spin text-zinc-400" />
      </div>
    );
  }

  const usagePercent = status
    ? (status.totalSize / status.quota.maxTotalSize) * 100
    : 0;
  const isWarning = usagePercent >= (status?.quota.warnThreshold ?? 0.8) * 100;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-900">
      {/* ─── 头部 ─── */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <HardDrive size={16} className="text-zinc-500" />
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            备份模式
          </h2>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        )}
      </div>

      {/* ─── 错误提示 ─── */}
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ─── 模式选择 ─── */}
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            全局备份模式
          </h3>
          <div className="space-y-2">
            {(Object.keys(MODE_CONFIG) as BackupMode[]).map((mode) => {
              const config = MODE_CONFIG[mode];
              const Icon = config.icon;
              const isActive = status?.mode === mode;
              return (
                <button
                  key={mode}
                  onClick={() => handleSetMode(mode)}
                  disabled={saving}
                  className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    isActive
                      ? 'border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-800'
                      : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
                  }`}
                >
                  <Icon
                    size={18}
                    className={isActive ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400'}
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {config.label}
                      </span>
                      {isActive && (
                        <Check size={14} className="text-green-600 dark:text-green-400" />
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {config.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ─── 路径级覆写 ─── */}
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            路径级策略覆写
          </h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={pathPattern}
              onChange={(e) => setPathPattern(e.target.value)}
              placeholder="例如：src/** 或 *.lock"
              className="flex-1 rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
            />
            <button
              onClick={handleAddPathOverride}
              disabled={saving || !pathPattern.trim()}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              添加
            </button>
          </div>
          {status && status.pathOverrides.length > 0 && (
            <ul className="mt-2 space-y-1">
              {status.pathOverrides.map((override, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded-md bg-zinc-50 px-3 py-1.5 text-xs dark:bg-zinc-800/50"
                >
                  <span className="font-mono text-zinc-600 dark:text-zinc-400">
                    {override.globPattern}
                  </span>
                  <span className="text-zinc-500">→ {MODE_CONFIG[override.mode].label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ─── 空间占用 ─── */}
        {status && (
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              空间占用
            </h3>
            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">
                  {formatSize(status.totalSize)} / {formatSize(status.quota.maxTotalSize)}
                </span>
                <span
                  className={`text-xs font-medium ${
                    isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400'
                  }`}
                >
                  {usagePercent.toFixed(1)}%
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className={`h-full rounded-full transition-all ${
                    isWarning ? 'bg-amber-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(usagePercent, 100)}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-zinc-400">
                <span>{status.sessionCount} 个会话</span>
                <button
                  onClick={handleDeleteBackups}
                  disabled={saving}
                  className="flex items-center gap-1 text-red-500 hover:text-red-600"
                >
                  <Trash2 size={12} />
                  清理备份
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
