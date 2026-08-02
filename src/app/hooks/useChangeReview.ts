import { useCallback, useEffect, useState } from 'react';
import {
  ChangeRecordSummary,
  ConflictInfo,
  RestoreResult,
  getChanges,
  restoreRecords,
  restoreTurn,
} from '../services/toolService';

// ─── 类型定义 ──────────────────────────────────────────────────────────────

/** Hunk 审阅项。 */
export interface ChangeReviewHunk {
  hunkId: string;
  recordId: string;
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  context: string[];
  status: 'pending' | 'accepted' | 'rejected';
}

/** 审阅面板状态。 */
interface ChangeReviewState {
  /** 是否正在加载 */
  loading: boolean;
  /** 当前 turn 的变更记录 */
  records: ChangeRecordSummary[];
  /** 按文件分组的 hunks */
  hunksByFile: Map<string, ChangeReviewHunk[]>;
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
    hunksByFile: new Map(),
    restoreResult: null,
    error: null,
  });

  /** 加载指定 turn 的变更记录。 */
  const loadChanges = useCallback(async (turnId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const records = await getChanges({ turnId });
      // 按 filePath 分组
      const hunksByFile = new Map<string, ChangeReviewHunk[]>();
      for (const record of records) {
        const filePath = record.path;
        if (!hunksByFile.has(filePath)) {
          hunksByFile.set(filePath, []);
        }
        // 为每条记录创建一个 hunk 条目（Phase 1 简化：一条记录 = 一个 hunk）
        hunksByFile.get(filePath)!.push({
          hunkId: record.id,
          recordId: record.id,
          filePath,
          oldStart: 0,
          oldLines: 0,
          newStart: 0,
          newLines: 0,
          context: [],
          status: 'pending',
        });
      }
      setState((prev) => ({
        ...prev,
        loading: false,
        records,
        hunksByFile,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  /** 设置某个 hunk 的接受/拒绝状态。 */
  const setHunkStatus = useCallback(
    (hunkId: string, status: 'accepted' | 'rejected') => {
      setState((prev) => {
        const newHunksByFile = new Map(prev.hunksByFile);
        for (const [filePath, hunks] of newHunksByFile) {
          const idx = hunks.findIndex((h) => h.hunkId === hunkId);
          if (idx !== -1) {
            const newHunks = [...hunks];
            newHunks[idx] = { ...newHunks[idx], status };
            newHunksByFile.set(filePath, newHunks);
            break;
          }
        }
        return { ...prev, hunksByFile: newHunksByFile };
      });
    },
    [],
  );

  /** 批量设置所有 hunks 的状态。 */
  const setAllHunksStatus = useCallback(
    (status: 'accepted' | 'rejected') => {
      setState((prev) => {
        const newHunksByFile = new Map(prev.hunksByFile);
        for (const [filePath, hunks] of newHunksByFile) {
          newHunksByFile.set(
            filePath,
            hunks.map((h) => ({ ...h, status })),
          );
        }
        return { ...prev, hunksByFile: newHunksByFile };
      });
    },
    [],
  );

  /** 选择性回退被拒绝的 hunks（按 record_id）。 */
  const revertRejectedHunks = useCallback(async () => {
    const rejectedRecordIds: string[] = [];
    for (const hunks of state.hunksByFile.values()) {
      for (const hunk of hunks) {
        if (hunk.status === 'rejected') {
          rejectedRecordIds.push(hunk.recordId);
        }
      }
    }
    if (rejectedRecordIds.length === 0) {
      return null;
    }
    try {
      const result = await restoreRecords(rejectedRecordIds);
      setState((prev) => ({ ...prev, restoreResult: result }));
      return result;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }, [state.hunksByFile]);

  /** Turn 级回退。 */
  const revertEntireTurn = useCallback(async (chatId: string, turnId: string) => {
    try {
      const result = await restoreTurn(chatId, turnId);
      setState((prev) => ({ ...prev, restoreResult: result }));
      return result;
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
      hunksByFile: new Map(),
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
    setHunkStatus,
    setAllHunksStatus,
    revertRejectedHunks,
    revertEntireTurn,
    reset,
    clearRestoreResult,
  };
}
