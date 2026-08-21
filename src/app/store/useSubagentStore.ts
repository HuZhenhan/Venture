import { create } from 'zustand';
import {
  SubagentCompletionSummary,
  SubagentPermissionRequest,
  SubagentSseEvent,
  decideSubagentPermission,
  fetchCompletedSubagents,
  subscribeSubagentEvents,
} from '../services/subagentService';

/**
 * 子代理系统全局状态（设计稿 §7.5 / §11.2 适配）。
 *
 * - pendingPermissions：子代理运行中的权限询问（Ask 效果经 SSE 转发，
 *   由 SubagentPermissionBanner 渲染审批卡片）
 * - pendingCompletions：后台任务完成摘要缓冲，在下一轮用户消息发送前
 *   注入主对话（consumeCompletionsForChat 消费后移除）
 */

interface SubagentState {
  connected: boolean;
  pendingPermissions: SubagentPermissionRequest[];
  pendingCompletions: SubagentCompletionSummary[];
  /** 最近一次子代理状态（供 UI 调试展示） */
  lastEvent: SubagentSseEvent | null;

  // Actions
  init: () => void;
  handleEvent: (event: SubagentSseEvent) => void;
  resolvePermission: (
    requestId: string,
    decision: 'approve' | 'always_approve' | 'reject',
  ) => Promise<void>;
  /** 消费指定会话的完成摘要（注入后移除，§7.5）。 */
  consumeCompletionsForChat: (chatId: string) => SubagentCompletionSummary[];
  /** 拉取完成缓冲（SSE 断线补齐）。 */
  refreshCompletions: () => Promise<void>;
}

let unsubscribe: (() => void) | null = null;

export const useSubagentStore = create<SubagentState>((set, get) => ({
  connected: false,
  pendingPermissions: [],
  pendingCompletions: [],
  lastEvent: null,

  init: () => {
    if (unsubscribe) return; // 幂等：多组件挂载只订阅一次
    unsubscribe = subscribeSubagentEvents(
      (event) => get().handleEvent(event),
      () => {
        // SSE（重）连成功：补齐断线期间错过的完成事件（§7.5）
        void get().refreshCompletions();
        set({ connected: true });
      },
    );
    // 首次挂载也拉一次（后端崩溃扫描的提醒等）
    void get().refreshCompletions();
  },

  handleEvent: (event) => {
    set({ lastEvent: event });
    switch (event.type) {
      case 'subagent_permission_request': {
        const { requestId, tool, input } = event.data;
        if (!requestId || !tool) return;
        const req: SubagentPermissionRequest = {
          requestId: String(requestId),
          chatId: event.chatId,
          taskId: event.taskId,
          tool: String(tool),
          input,
          requestedAt: Date.now(),
        };
        set((state) => ({
          pendingPermissions: [
            ...state.pendingPermissions.filter((p) => p.requestId !== req.requestId),
            req,
          ],
        }));
        break;
      }
      case 'subagent_permission_resolved': {
        const requestId = event.data.requestId;
        if (!requestId) return;
        set((state) => ({
          pendingPermissions: state.pendingPermissions.filter(
            (p) => p.requestId !== requestId,
          ),
        }));
        break;
      }
      case 'subagent_completed': {
        // 后台任务完成 → 缓冲（前台等待中的任务结果经 HTTP 响应返回，不进缓冲，§7.5）
        const summary: SubagentCompletionSummary = {
          taskId: event.taskId,
          chatId: event.chatId,
          state: 'completed',
          summary: buildSummary(event),
        };
        set((state) => ({
          pendingCompletions: [...state.pendingCompletions, summary],
        }));
        break;
      }
      case 'subagent_failed': {
        const summary: SubagentCompletionSummary = {
          taskId: event.taskId,
          chatId: event.chatId,
          state: 'failed',
          summary: buildSummary(event),
        };
        set((state) => ({
          pendingCompletions: [...state.pendingCompletions, summary],
        }));
        break;
      }
      default:
        break;
    }
  },

  resolvePermission: async (requestId, decision) => {
    // 乐观移除卡片；决策经 HTTP 回填后端（超时 30s 后端默认拒绝，§11.2）
    set((state) => ({
      pendingPermissions: state.pendingPermissions.filter(
        (p) => p.requestId !== requestId,
      ),
    }));
    try {
      await decideSubagentPermission(requestId, decision);
    } catch {
      // 网络异常时后端 30s 超时兜底拒绝
    }
  },

  consumeCompletionsForChat: (chatId) => {
    const all = get().pendingCompletions;
    const mine = all.filter((c) => c.chatId === chatId);
    if (mine.length === 0) return [];
    set({ pendingCompletions: all.filter((c) => c.chatId !== chatId) });
    return mine;
  },

  refreshCompletions: async () => {
    try {
      const completed = await fetchCompletedSubagents();
      if (completed.length > 0) {
        set((state) => ({
          pendingCompletions: [
            ...state.pendingCompletions.filter(
              (existing) => !completed.some((c) => c.taskId === existing.taskId),
            ),
            ...completed,
          ],
        }));
      }
    } catch {
      // 后端不可达时静默（下次重连补齐）
    }
  },
}));

function buildSummary(event: SubagentSseEvent): string {
  if (event.type === 'subagent_completed') {
    const turns = event.data.turns ?? 0;
    const duration = ((event.data.durationMs ?? 0) / 1000).toFixed(1);
    const output = (event.data.output ?? '').slice(0, 200);
    return `共 ${turns} 轮，耗时 ${duration}s。摘要：${output}`;
  }
  if (event.type === 'subagent_failed') {
    return `失败（${event.data.kind ?? 'unknown'}）：${event.data.error ?? ''}`;
  }
  return event.data.state ?? '';
}
