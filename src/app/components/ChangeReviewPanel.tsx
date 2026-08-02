import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  X,
  FileText,
  RotateCcw,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useChangeReview } from '../hooks/useChangeReview';
import { ConflictInfo } from '../services/toolService';

// ─── 组件 Props ────────────────────────────────────────────────────────────

interface ChangeReviewPanelProps {
  /** 当前 chat ID */
  chatId: string;
  /** 要审阅的 turn ID（user message ID） */
  turnId: string;
  /** 关闭面板的回调 */
  onClose: () => void;
}

// ─── 主组件 ────────────────────────────────────────────────────────────────

/**
 * 变更审阅面板。
 *
 * 展示某个 turn 内所有文件修改的 hunk 列表，
 * 支持选择性接受/拒绝单个 hunk，以及批量操作。
 *
 * 使用方式：通过 /changes [turn_id] 命令打开。
 */
export function ChangeReviewPanel({ chatId, turnId, onClose }: ChangeReviewPanelProps) {
  const {
    loading,
    records,
    hunksByFile,
    restoreResult,
    error,
    loadChanges,
    setHunkStatus,
    setAllHunksStatus,
    revertRejectedHunks,
    revertEntireTurn,
    clearRestoreResult,
  } = useChangeReview();

  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  // 加载变更数据
  useEffect(() => {
    if (turnId) {
      loadChanges(turnId);
    }
  }, [turnId, loadChanges]);

  // 默认展开所有文件
  useEffect(() => {
    if (hunksByFile.size > 0 && expandedFiles.size === 0) {
      setExpandedFiles(new Set(hunksByFile.keys()));
    }
  }, [hunksByFile, expandedFiles.size]);

  const toggleFile = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const handleRevertRejected = useCallback(async () => {
    await revertRejectedHunks();
  }, [revertRejectedHunks]);

  const handleRevertAll = useCallback(async () => {
    await revertEntireTurn(chatId, turnId);
  }, [chatId, turnId, revertEntireTurn]);

  // 统计
  const totalHunks = Array.from(hunksByFile.values()).flat().length;
  const acceptedCount = Array.from(hunksByFile.values())
    .flat()
    .filter((h) => h.status === 'accepted').length;
  const rejectedCount = Array.from(hunksByFile.values())
    .flat()
    .filter((h) => h.status === 'rejected').length;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-900">
      {/* ─── 头部 ─── */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-zinc-500" />
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            变更审阅
          </h2>
          {totalHunks > 0 && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {totalHunks} 项变更
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
        >
          <X size={16} />
        </button>
      </div>

      {/* ─── 错误提示 ─── */}
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* ─── 回退结果 ─── */}
      {restoreResult && (
        <RestoreResultDisplay
          result={restoreResult}
          onDismiss={clearRestoreResult}
        />
      )}

      {/* ─── 内容区 ─── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={20} className="animate-spin text-zinc-400" />
          </div>
        ) : records.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-sm text-zinc-400">
            <FileText size={32} className="mb-2 opacity-50" />
            <p>该轮次没有文件变更记录</p>
          </div>
        ) : (
          <div className="space-y-1 p-3">
            {Array.from(hunksByFile.entries()).map(([filePath, hunks]) => {
              const isExpanded = expandedFiles.has(filePath);
              const fileAccepted = hunks.filter((h) => h.status === 'accepted').length;
              const fileRejected = hunks.filter((h) => h.status === 'rejected').length;

              return (
                <div
                  key={filePath}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  {/* 文件头 */}
                  <button
                    onClick={() => toggleFile(filePath)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} className="text-zinc-400" />
                    ) : (
                      <ChevronRight size={14} className="text-zinc-400" />
                    )}
                    <FileText size={14} className="text-zinc-500" />
                    <span className="flex-1 truncate text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      {filePath}
                    </span>
                    <div className="flex items-center gap-1.5 text-xs">
                      {fileAccepted > 0 && (
                        <span className="text-green-600 dark:text-green-400">
                          {fileAccepted} 接受
                        </span>
                      )}
                      {fileRejected > 0 && (
                        <span className="text-red-600 dark:text-red-400">
                          {fileRejected} 拒绝
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Hunk 列表 */}
                  {isExpanded && (
                    <div className="border-t border-zinc-100 dark:border-zinc-800">
                      {hunks.map((hunk) => (
                        <div
                          key={hunk.hunkId}
                          className="flex items-center gap-2 px-3 py-2"
                        >
                          <button
                            onClick={() => setHunkStatus(hunk.hunkId, 'accepted')}
                            className={`rounded p-1 transition-colors ${
                              hunk.status === 'accepted'
                                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-400'
                                : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800'
                            }`}
                            title="接受此变更"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={() => setHunkStatus(hunk.hunkId, 'rejected')}
                            className={`rounded p-1 transition-colors ${
                              hunk.status === 'rejected'
                                ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-400'
                                : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800'
                            }`}
                            title="拒绝此变更（回退）"
                          >
                            <X size={14} />
                          </button>
                          <span className="flex-1 text-xs text-zinc-600 dark:text-zinc-400">
                            {hunk.filePath}
                          </span>
                          <span className="text-xs text-zinc-400">
                            {hunk.recordId.slice(0, 8)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── 底部操作栏 ─── */}
      {records.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex gap-2">
            <button
              onClick={() => setAllHunksStatus('accepted')}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              全部接受
            </button>
            <button
              onClick={() => setAllHunksStatus('rejected')}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              全部拒绝
            </button>
          </div>
          <div className="flex gap-2">
            {rejectedCount > 0 && (
              <button
                onClick={handleRevertRejected}
                className="flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                <RotateCcw size={12} />
                回退已拒绝 ({rejectedCount})
              </button>
            )}
            <button
              onClick={handleRevertAll}
              className="flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              <RotateCcw size={12} />
              回退整轮
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 回退结果展示子组件 ─────────────────────────────────────────────────────

function RestoreResultDisplay({
  result,
  onDismiss,
}: {
  result: { restoredFiles: string[]; conflicts: ConflictInfo[]; errors: string[] };
  onDismiss: () => void;
}) {
  const hasConflicts = result.conflicts.length > 0;
  const hasErrors = result.errors.length > 0;

  return (
    <div
      className={`border-b px-4 py-3 text-sm ${
        hasErrors
          ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'
          : hasConflicts
            ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
            : 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          {result.restoredFiles.length > 0 && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              已恢复 {result.restoredFiles.length} 个文件
            </p>
          )}
          {hasConflicts && (
            <div className="mt-1">
              <p className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle size={12} />
                {result.conflicts.length} 个冲突
              </p>
              <ul className="mt-1 space-y-0.5">
                {result.conflicts.map((c, i) => (
                  <li key={i} className="text-xs text-amber-600 dark:text-amber-500">
                    {c.filePath}: {c.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hasErrors && (
            <div className="mt-1">
              <p className="text-xs font-medium text-red-700 dark:text-red-400">
                {result.errors.length} 个错误
              </p>
              <ul className="mt-1 space-y-0.5">
                {result.errors.map((e, i) => (
                  <li key={i} className="text-xs text-red-600 dark:text-red-500">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="rounded p-1 text-zinc-400 hover:bg-white/50 dark:hover:bg-black/20"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
