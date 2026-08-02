import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Upload,
  Download,
  CloudOff,
  Cloud,
  Loader2,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import {
  SyncStatus,
  SyncInReport,
  SyncOutReport,
  getSyncStatus,
  syncIn,
  syncOut,
} from '../services/toolService';

// ─── 主组件 ────────────────────────────────────────────────────────────────

/**
 * SAF 同步状态指示器。
 *
 * 仅在 SAF 工作区模式下有意义。提供：
 * - 显示当前同步状态（dirty 文件数、已追踪文件数）
 * - sync-in：从 SAF 拉取外部变更
 * - sync-out：推送本地修改到 SAF
 *
 * 通过 /sync-status 命令打开，或在 SAF 工作区时自动显示在状态栏。
 */
export function SyncStatusIndicator() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<'in' | 'out' | null>(null);
  const [lastSyncIn, setLastSyncIn] = useState<SyncInReport | null>(null);
  const [lastSyncOut, setLastSyncOut] = useState<SyncOutReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getSyncStatus();
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

  const handleSyncIn = useCallback(async () => {
    setSyncing('in');
    setError(null);
    try {
      const report = await syncIn();
      setLastSyncIn(report);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(null);
    }
  }, [refreshStatus]);

  const handleSyncOut = useCallback(async () => {
    setSyncing('out');
    setError(null);
    try {
      const report = await syncOut();
      setLastSyncOut(report);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(null);
    }
  }, [refreshStatus]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <Loader2 size={12} className="animate-spin" />
        <span>检查同步状态...</span>
      </div>
    );
  }

  // SAF 未启用时显示简洁状态
  if (!status?.enabled) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-zinc-400" title="本地存储模式，无需同步">
        <CloudOff size={12} />
        <span>本地存储</span>
      </div>
    );
  }

  const hasDirty = status.dirtyCount > 0;

  return (
    <div className="flex flex-col gap-2">
      {/* ─── 状态指示 ─── */}
      <div className="flex items-center gap-2 text-xs">
        <div
          className={`flex items-center gap-1.5 ${hasDirty ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}
        >
          {hasDirty ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}
          <span>
            {hasDirty
              ? `${status.dirtyCount} 个文件待同步`
              : `已同步 (${status.trackedCount} 个文件)`}
          </span>
        </div>
      </div>

      {/* ─── 操作按钮 ─── */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleSyncIn}
          disabled={syncing !== null}
          className="flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/50"
          title="从 SAF 拉取外部变更"
        >
          {syncing === 'in' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Download size={11} />
          )}
          <span>Sync In</span>
        </button>
        <button
          onClick={handleSyncOut}
          disabled={syncing !== null || !hasDirty}
          className="flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/50"
          title="推送本地修改到 SAF"
        >
          {syncing === 'out' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Upload size={11} />
          )}
          <span>Sync Out</span>
        </button>
        <button
          onClick={refreshStatus}
          disabled={syncing !== null}
          className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 dark:hover:bg-zinc-800"
          title="刷新状态"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {/* ─── 错误提示 ─── */}
      {error && (
        <div className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
          <AlertCircle size={11} />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* ─── sync-in 结果 ─── */}
      {lastSyncIn && (lastSyncIn.externalEdits.length > 0 || lastSyncIn.externalDeletes.length > 0) && (
        <div className="rounded-md bg-blue-50 p-2 text-xs dark:bg-blue-950/50">
          <div className="flex items-center gap-1 font-medium text-blue-700 dark:text-blue-400">
            <Cloud size={11} />
            <span>Sync In 完成</span>
          </div>
          {lastSyncIn.externalEdits.length > 0 && (
            <p className="mt-1 text-blue-600 dark:text-blue-500">
              检测到 {lastSyncIn.externalEdits.length} 个外部修改
            </p>
          )}
          {lastSyncIn.externalDeletes.length > 0 && (
            <p className="text-blue-600 dark:text-blue-500">
              检测到 {lastSyncIn.externalDeletes.length} 个外部删除
            </p>
          )}
        </div>
      )}

      {/* ─── sync-out 结果 ─── */}
      {lastSyncOut && (lastSyncOut.synced.length > 0 || lastSyncOut.failures.length > 0) && (
        <div
          className={`rounded-md p-2 text-xs ${
            lastSyncOut.failures.length > 0
              ? 'bg-amber-50 dark:bg-amber-950/50'
              : 'bg-green-50 dark:bg-green-950/50'
          }`}
        >
          <div
            className={`flex items-center gap-1 font-medium ${
              lastSyncOut.failures.length > 0
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-green-700 dark:text-green-400'
            }`}
          >
            <Upload size={11} />
            <span>Sync Out 完成</span>
          </div>
          {lastSyncOut.synced.length > 0 && (
            <p className="mt-1 text-green-600 dark:text-green-500">
              成功同步 {lastSyncOut.synced.length} 个文件
            </p>
          )}
          {lastSyncOut.failures.length > 0 && (
            <div className="mt-1">
              <p className="text-amber-600 dark:text-amber-500">
                {lastSyncOut.failures.length} 个文件同步失败：
              </p>
              <ul className="ml-3 list-disc">
                {lastSyncOut.failures.slice(0, 3).map((f, i) => (
                  <li key={i} className="text-amber-600 dark:text-amber-500">
                    {f.path}: {f.reason}
                  </li>
                ))}
                {lastSyncOut.failures.length > 3 && (
                  <li className="text-amber-600 dark:text-amber-500">
                    ...及另外 {lastSyncOut.failures.length - 3} 个
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
