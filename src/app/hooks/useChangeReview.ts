import { useCallback, useEffect, useState } from 'react';
import {
  BackupStatus,
  ChangeRecordSummary,
  GcReport,
  RestoreResult,
  SyncStatus,
  getBackupStatus,
  getChangeDiff,
  getChanges,
  getSyncStatus,
  runGc,
  restoreRecords,
  restoreTurn,
} from '../services/toolService';
import { CodeDiff } from '../types';

// ─── 类型定义 ──────────────────────────────────────────────────────────────

export type ChangeReviewStatus = 'pending' | 'accepted' | 'rejected';

/** 审阅面板状态。 */
interface ChangeReviewState {
  /** 是否正在加载 */
  loading: boolean;
  /** 当前 turn 的变更记录 */
  records: ChangeRecordSummary[];
  /** 按记录 ID 保存的审阅状态 */
  recordStatuses: Map<string, ChangeReviewStatus>;
  /** 按记录 ID 缓存的 diff */
  diffByRecord: Map<string, CodeDiff>;
  /** 正在加载 diff 的记录 ID */
  loadingDiffId: string | null;
  /** 当前 turn ID */
  currentTurnId: string | null;
  /** 备份状态 */
  backupStatus: BackupStatus | null;
  /** SAF 状态 */
  syncStatus: SyncStatus | null;
  /** GC 结果 */
  gcReport: GcReport | null;
  /** 回退操作结果 */
  restoreResult: RestoreResult | null;
  /** 错误信息 */
  error: string | null;
}

// ─── Hook ──────────────────────────────────────────────────────────────────

/**
 * 变更审阅状态管理 Hook。
 *
 * 提供：
 * - 加载指定 turn 的变更记录
 * - hunk 级别的接受/拒绝状态管理
 * - 选择性回退（按 hunk 或按记录）
 * - Turn 级回退
 */
export function useChangeReview() {
  const [state, setState] = useState<ChangeReviewState>({
    loading: false,
    records: [],
    recordStatuses: new Map(),
    diffByRecord: new Map(),
    loadingDiffId: null,
    currentTurnId: null,
    backupStatus: null,
    syncStatus: null,
    gcReport: null,
    restoreResult: null,
    error: null,
  });

  /** 加载指定 turn 的变更记录。 */
  const loadChanges = useCallback(async (turnId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const records = await getChanges({ turnId });
      const [backupStatus, syncStatus] = await Promise.all([
        getBackupStatus().catch(() => null),
        getSyncStatus().catch(() => null),
      ]);
      const recordStatuses = new Map<string, ChangeReviewStatus>();
      for (const record of records) recordStatuses.set(record.id, 'pending');
      setState((prev) => ({
        ...prev,
        loading: false,
        records,
        recordStatuses,
        diffByRecord: new Map(),
        currentTurnId: turnId,
        backupStatus,
        syncStatus,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  /** 加载单条记录 diff。 */
  const loadDiff = useCallback(async (recordId: string) => {
    if (state.diffByRecord.has(recordId) || state.loadingDiffId === recordId) return;
    setState((prev) => ({ ...prev, loadingDiffId: recordId, error: null }));
    try {
      const diff = await getChangeDiff(recordId);
      setState((prev) => {
        const diffByRecord = new Map(prev.diffByRecord);
        diffByRecord.set(recordId, diff);
        return { ...prev, diffByRecord, loadingDiffId: null };
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loadingDiffId: null,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [state.diffByRecord, state.loadingDiffId]);

  /** 设置某条记录的接受/拒绝状态。 */
  const setRecordStatus = useCallback(
    (recordId: string, status: ChangeReviewStatus) => {
      setState((prev) => {
        const recordStatuses = new Map(prev.recordStatuses);
        recordStatuses.set(recordId, status);
        return { ...prev, recordStatuses };
      });
    },
    [],
  );

  /** 批量设置所有记录状态。 */
  const setAllRecordStatus = useCallback(
    (status: ChangeReviewStatus) => {
      setState((prev) => {
        const recordStatuses = new Map<string, ChangeReviewStatus>();
        for (const record of prev.records) recordStatuses.set(record.id, status);
        return { ...prev, recordStatuses };
      });
    },
    [],
  );

  /** 选择性回退被拒绝的记录。 */
  const revertRejectedRecords = useCallback(async () => {
    const rejectedRecordIds: string[] = [];
    for (const [recordId, status] of state.recordStatuses) {
      if (status === 'rejected') {
        rejectedRecordIds.push(recordId);
      }
    }
    if (rejectedRecordIds.length === 0) {
      return null;
    }
    try {
      const result = await restoreRecords(rejectedRecordIds);
      setState((prev) => ({ ...prev, restoreResult: result }));
      if (state.currentTurnId) await loadChanges(state.currentTurnId);
      return result;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }, [loadChanges, state.currentTurnId, state.recordStatuses]);

  /** Turn 级回退。 */
  const revertEntireTurn = useCallback(async (chatId: string, turnId: string) => {
    try {
      const result = await restoreTurn(chatId, turnId);
      setState((prev) => ({ ...prev, restoreResult: result }));
      await loadChanges(turnId);
      return result;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }, [loadChanges]);

  /** 手动触发 GC。 */
  const runManualGc = useCallback(async () => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      const gcReport = await runGc();
      const backupStatus = await getBackupStatus().catch(() => null);
      setState((prev) => ({ ...prev, gcReport, backupStatus }));
      return gcReport;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }, []);

  /** 清除状态。 */
  const reset = useCallback(() => {
    setState({
      loading: false,
      records: [],
      recordStatuses: new Map(),
      diffByRecord: new Map(),
      loadingDiffId: null,
      currentTurnId: null,
      backupStatus: null,
      syncStatus: null,
      gcReport: null,
      restoreResult: null,
      error: null,
    });
  }, []);

  /** 清除回退结果。 */
  const clearRestoreResult = useCallback(() => {
    setState((prev) => ({ ...prev, restoreResult: null }));
  }, []);

  return {
    ...state,
    loadChanges,
    loadDiff,
    setRecordStatus,
    setAllRecordStatus,
    revertRejectedRecords,
    revertEntireTurn,
    runManualGc,
    reset,
    clearRestoreResult,
  };
}
