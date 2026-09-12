import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { DiffPreview } from './DiffPreview';
import { useChangeReview } from '../hooks/useChangeReview';
import { ChangeRecordSummary, ConflictInfo } from '../services/toolService';
import { PanelHeader } from './shared/PanelHeader';
import { beginHorizontalResize } from '../utils/panelResize';
import { useLayoutStore } from '../store/useLayoutStore';
import { MIN_CHANGE_REVIEW_WIDTH, MAX_CHANGE_REVIEW_WIDTH } from '../constants';

interface ChangeReviewPanelProps {
  chatId: string;
  turnId: string;
  onClose: () => void;
  width?: number;
  onWidthChange?: (width: number) => void;
}

const KIND_LABELS: Record<ChangeRecordSummary['kind'], string> = {
  create: 'Create',
  modify: 'Modify',
  delete: 'Delete',
  rename: 'Rename',
};

const SOURCE_LABELS: Record<ChangeRecordSummary['source'], string> = {
  agent: 'Agent Tool',
  external_edit: 'External Edit',
  user_manual: 'User Manual',
};

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '未知时间';
  return new Date(timestamp).toLocaleString();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function ChangeReviewPanel({ chatId, turnId, onClose, width = 680, onWidthChange }: ChangeReviewPanelProps) {
  const commitWidths = useLayoutStore(state => state.commitWidths);
  const viewportWidth = useLayoutStore(state => state.viewportWidth);
  const [isResizing, setIsResizing] = useState(false);
  
  const {
    loading,
    records,
    recordStatuses,
    diffByRecord,
    loadingDiffId,
    backupStatus,
    syncStatus,
    gcReport,
    restoreResult,
    error,
    loadChanges,
    loadDiff,
    setRecordStatus,
    setAllRecordStatus,
    revertRejectedRecords,
    revertEntireTurn,
    runManualGc,
    clearRestoreResult,
  } = useChangeReview();

  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (turnId) {
      loadChanges(turnId);
    }
  }, [turnId, loadChanges]);

  const groupedRecords = useMemo(() => {
    const groups = new Map<string, ChangeRecordSummary[]>();
    for (const record of records) {
      const items = groups.get(record.path) ?? [];
      items.push(record);
      groups.set(record.path, items);
    }
    return groups;
  }, [records]);

  const rejectedCount = useMemo(() => (
    Array.from(recordStatuses.values()).filter((status) => status === 'rejected').length
  ), [recordStatuses]);

  const acceptedCount = useMemo(() => (
    Array.from(recordStatuses.values()).filter((status) => status === 'accepted').length
  ), [recordStatuses]);

  const toggleRecord = useCallback((recordId: string) => {
    setExpandedRecords((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
        void loadDiff(recordId);
      }
      return next;
    });
  }, [loadDiff]);

  const handleRevertRejected = useCallback(async () => {
    if (rejectedCount === 0) return;
    const ok = window.confirm(`确认回退 ${rejectedCount} 条已拒绝的文件变更？该操作会通过 file_history 恢复文件。`);
    if (ok) await revertRejectedRecords();
  }, [rejectedCount, revertRejectedRecords]);

  const handleRevertAll = useCallback(async () => {
    const ok = window.confirm(`确认回退 turn ${turnId} 的全部 ${records.length} 条文件变更？`);
    if (ok) await revertEntireTurn(chatId, turnId);
  }, [chatId, records.length, revertEntireTurn, turnId]);

  const handleRunGc = useCallback(async () => {
    const ok = window.confirm('确认手动执行文件历史 GC？仅清理孤立对象或超配额旧 session，不会默认静默删除历史。');
    if (ok) await runManualGc();
  }, [runManualGc]);

  return (
    <div className="flex h-full flex-col bg-background text-foreground relative">
      <PanelHeader
        title="变更审阅"
        subtitle={`Turn: ${turnId || '未选择'}`}
        icon={<FileText size={16} />}
        badge={`${records.length} 条记录`}
        onClose={onClose}
      />

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        </div>
      )}

      {restoreResult && (
        <RestoreResultDisplay result={restoreResult} onDismiss={clearRestoreResult} />
      )}

      <div className="border-b border-border px-4 py-3 text-xs text-muted-foreground">
        <div className="grid gap-2 sm:grid-cols-3">
          <div>备份：{backupStatus ? `${formatBytes(backupStatus.totalSize)} / ${backupStatus.sessionCount} sessions` : '状态不可用'}</div>
          <div>SAF：{syncStatus?.enabled ? `已启用，${syncStatus.dirtyCount} dirty` : '未启用/仅预留'}</div>
          <button
            type="button"
            onClick={handleRunGc}
            className="flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted"
          >
            <Trash2 size={12} />
            手动 GC
          </button>
        </div>
        {gcReport && (
          <p className="mt-2">
            GC：扫描 {gcReport.versionsScanned} 版本，删除 {gcReport.objectsDeleted} 对象，释放 {formatBytes(gcReport.spaceFreed)}。
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : records.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-sm text-muted-foreground">
            <FileText size={32} className="mb-2 opacity-50" />
            <p>该轮次没有文件变更记录，或记录已缺失</p>
          </div>
        ) : (
          <div className="space-y-3 p-3">
            {Array.from(groupedRecords.entries()).map(([filePath, fileRecords]) => (
              <section key={filePath} className="rounded-lg border border-border">
                <div className="border-b border-border px-3 py-2">
                  <div className="truncate text-xs font-medium">{filePath}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">{fileRecords.length} 条变更</div>
                </div>
                <div className="divide-y divide-border">
                  {fileRecords.map((record) => {
                    const status = recordStatuses.get(record.id) ?? 'pending';
                    const isExpanded = expandedRecords.has(record.id);
                    const diff = diffByRecord.get(record.id);
                    return (
                      <div key={record.id} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => toggleRecord(record.id)} className="rounded p-1 hover:bg-muted">
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{KIND_LABELS[record.kind]}</span>
                              <span>{SOURCE_LABELS[record.source]}</span>
                              <span className="text-muted-foreground">{formatTime(record.timestamp)}</span>
                            </div>
                            <div className="mt-1 truncate text-[11px] text-muted-foreground">Record: {record.id}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setRecordStatus(record.id, 'accepted')}
                            className={`rounded p-1 ${status === 'accepted' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'text-muted-foreground hover:bg-muted'}`}
                            title="接受此记录"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setRecordStatus(record.id, 'rejected')}
                            className={`rounded p-1 ${status === 'rejected' ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' : 'text-muted-foreground hover:bg-muted'}`}
                            title="拒绝并加入部分回退"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        {isExpanded && (
                          <div className="mt-2">
                            {loadingDiffId === record.id ? (
                              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                                <Loader2 size={14} className="animate-spin" />
                                正在加载 diff...
                              </div>
                            ) : diff ? (
                              <DiffPreview diff={diff} />
                            ) : (
                              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">Diff 不可用</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {records.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <div className="flex gap-2">
            <button type="button" onClick={() => setAllRecordStatus('accepted')} className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
              全部接受 ({acceptedCount})
            </button>
            <button type="button" onClick={() => setAllRecordStatus('rejected')} className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">
              全部拒绝
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRevertRejected}
              disabled={rejectedCount === 0}
              className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw size={12} />
              回退已拒绝 ({rejectedCount})
            </button>
            <button type="button" onClick={handleRevertAll} className="flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
              <RotateCcw size={12} />
              回退整轮
            </button>
          </div>
        </div>
      )}

      {onWidthChange && (
        <div 
          className="absolute left-0 top-0 w-0.5 h-full cursor-col-resize bg-gradient-to-b from-transparent via-border to-transparent opacity-0 hover:opacity-100 transition-opacity z-50"
          onMouseDown={(e) => {
            setIsResizing(true);
            beginHorizontalResize({
              startEvent: e,
              initialWidth: width,
              minWidth: MIN_CHANGE_REVIEW_WIDTH,
              maxWidth: Math.min(MAX_CHANGE_REVIEW_WIDTH, viewportWidth - 200),
              direction: 'expand-right',
              setWidth: onWidthChange,
              setIsResizing,
              onResizeEnd: () => commitWidths(),
            });
          }}
        />
      )}
    </div>
  );
}

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
    <div className={`border-b px-4 py-3 text-sm ${hasErrors ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950' : hasConflicts ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950' : 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground">已恢复 {result.restoredFiles.length} 个文件</p>
          {hasConflicts && (
            <div className="mt-1">
              <p className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle size={12} />
                {result.conflicts.length} 个冲突
              </p>
              <ul className="mt-1 space-y-0.5">
                {result.conflicts.map((conflict) => (
                  <li key={`${conflict.recordId}-${conflict.filePath}`} className="text-xs text-amber-600 dark:text-amber-500">
                    {conflict.filePath}: {conflict.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hasErrors && (
            <div className="mt-1">
              <p className="text-xs font-medium text-red-700 dark:text-red-400">{result.errors.length} 个错误</p>
              <ul className="mt-1 space-y-0.5">
                {result.errors.map((message) => (
                  <li key={message} className="text-xs text-red-600 dark:text-red-500">{message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <button type="button" onClick={onDismiss} className="rounded p-1 text-muted-foreground hover:bg-background/60">
          <AlertTriangle size={14} />
        </button>
      </div>
    </div>
  );
}
