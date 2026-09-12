import { create } from 'zustand';
import {
  SubagentCompletionSummary,
  SubagentPermissionRequest,
  SubagentSseEvent,
  decideSubagentPermission,
  fetchCompletedSubagents,
  subscribeSubagentEvents,
} from '../services/subagentService';

export type WorkflowNodeStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface RuntimeWorkflowNode {
  id: string;
  agentId?: string;
  seq?: number;
  title: string;
  subtitle?: string;
  status: WorkflowNodeStatus;
  reason?: string;
}

export interface RuntimeWorkflowEdge {
  id: string;
  source: string;
  target: string;
  status?: 'ok' | 'failed';
  reason?: string;
}

export interface RuntimeWorkflowRun {
  runId: string;
  nodes: RuntimeWorkflowNode[];
  edges: RuntimeWorkflowEdge[];
  updatedAt: number;
}

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
  workflowRuns: Record<string, RuntimeWorkflowRun>;
  activeWorkflowRunId: string | null;
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
  workflowRuns: {},
  activeWorkflowRunId: null,
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
        const { requestId, tool, input, reason, riskLevel, impact } = event.data;
        if (!requestId || !tool) return;
        const req: SubagentPermissionRequest = {
          requestId: String(requestId),
          chatId: event.chatId,
          taskId: event.taskId,
          tool: String(tool),
          input,
          reason: typeof reason === 'string' ? reason : undefined,
          riskLevel: riskLevel === 'low' || riskLevel === 'medium' || riskLevel === 'high' ? riskLevel : undefined,
          impact: impact && typeof impact === 'object' && 'value' in impact
            ? impact as { kind: string; value: string }
            : undefined,
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
      case 'subagent_state':
      case 'subagent_recovery': {
        mergeWorkflowAgentEvent(event, set);
        break;
      }
      case 'workflow_dag': {
        mergeWorkflowDagEvent(event, set);
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

function mergeWorkflowDagEvent(
  event: SubagentSseEvent,
  set: (partial: Partial<SubagentState> | ((state: SubagentState) => Partial<SubagentState>)) => void,
) {
  const runId = getRunId(event);
  if (!runId) return;
  const incomingNodes = Array.isArray(event.data.nodes) ? event.data.nodes : [];
  const incomingEdges = Array.isArray(event.data.edges) ? event.data.edges : [];

  set((state) => {
    const existing = state.workflowRuns[runId] ?? { runId, nodes: [], edges: [], updatedAt: 0 };
    const nodes = new Map(existing.nodes.map((node) => [node.id, node]));
    incomingNodes.forEach((raw) => {
      const node = parseWorkflowNode(raw);
      if (!node) return;
      nodes.set(node.id, { ...nodes.get(node.id), ...node });
    });
    const edges = new Map(existing.edges.map((edge) => [edge.id, edge]));
    incomingEdges.forEach((raw) => {
      const edge = parseWorkflowEdge(raw);
      if (!edge) return;
      edges.set(edge.id, { ...edges.get(edge.id), ...edge });
    });
    return {
      activeWorkflowRunId: runId,
      workflowRuns: {
        ...state.workflowRuns,
        [runId]: {
          runId,
          nodes: [...nodes.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
          edges: [...edges.values()],
          updatedAt: Date.now(),
        },
      },
    };
  });
}

function mergeWorkflowAgentEvent(
  event: SubagentSseEvent,
  set: (partial: Partial<SubagentState> | ((state: SubagentState) => Partial<SubagentState>)) => void,
) {
  const runId = getRunId(event);
  if (!runId || event.data.owner !== 'workflow') return;
  const status = parseWorkflowStatus(event.data.state);
  if (!status) return;
  set((state) => {
    const existing = state.workflowRuns[runId];
    if (!existing) return {};
    const nodes = existing.nodes.map((node) => {
      if (node.agentId !== event.taskId) return node;
      return { ...node, status, reason: String(event.data.reason ?? event.data.error ?? node.reason ?? '') || undefined };
    });
    return {
      workflowRuns: {
        ...state.workflowRuns,
        [runId]: { ...existing, nodes, updatedAt: Date.now() },
      },
    };
  });
}

function parseWorkflowNode(raw: unknown): RuntimeWorkflowNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const id = typeof data.id === 'string' ? data.id : null;
  const status = parseWorkflowStatus(data.status);
  if (!id || !status) return null;
  return {
    id,
    agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
    seq: typeof data.seq === 'number' ? data.seq : undefined,
    title: typeof data.title === 'string' ? data.title.slice(0, 80) : id,
    subtitle: typeof data.subtitle === 'string' ? data.subtitle : undefined,
    status,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
  };
}

function parseWorkflowEdge(raw: unknown): RuntimeWorkflowEdge | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const id = typeof data.id === 'string' ? data.id : null;
  const source = typeof data.source === 'string' ? data.source : null;
  const target = typeof data.target === 'string' ? data.target : null;
  if (!id || !source || !target) return null;
  return {
    id,
    source,
    target,
    status: data.status === 'failed' ? 'failed' : 'ok',
    reason: typeof data.reason === 'string' ? data.reason : undefined,
  };
}

function parseWorkflowStatus(value: unknown): WorkflowNodeStatus | null {
  if (
    value === 'pending' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'skipped' ||
    value === 'cancelled'
  ) {
    return value;
  }
  return null;
}

function getRunId(event: SubagentSseEvent): string | null {
  const runId = event.data.runId;
  return typeof runId === 'string' && runId.length > 0 ? runId : null;
}
