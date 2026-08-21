import { getBackendBaseUrl, backendGet, backendPost, backendPut } from './backendClient';

// ─── 子代理系统 API（设计稿 §7.5 / §11.2 / §13.2）────────────────────────
//
// 路由约定：
//   GET  /api/subagents/events                    — SSE 事件流（完成/权限/状态）
//   GET  /api/subagents/completed                 — 完成缓冲拉取（断线补齐，拉取即消费）
//   POST /api/subagents/permissions/:requestId    — 权限审批决策回填
//   GET  /api/subagents/agents                    — 可用 agent 列表
//   GET  /api/subagents/config                    — 子代理配置
//   PUT  /api/subagents/config                    — 更新子代理配置

/** SSE 事件（与后端 SseEvent 对齐）。 */
export interface SubagentSseEvent {
  type: string;
  chatId: string;
  taskId: string;
  data: {
    // subagent_completed
    state?: string;
    output?: string;
    turns?: number;
    toolCalls?: number;
    durationMs?: number;
    truncated?: boolean;
    // subagent_permission_request
    requestId?: string;
    tool?: string;
    input?: unknown;
    // subagent_failed
    error?: string;
    kind?: string;
    retryable?: boolean;
    [key: string]: unknown;
  };
}

/** 后台完成摘要（注入主对话用，§7.5）。 */
export interface SubagentCompletionSummary {
  taskId: string;
  chatId: string;
  state: string;
  summary: string;
}

/** 权限请求（审批横幅用，§11.2）。 */
export interface SubagentPermissionRequest {
  requestId: string;
  chatId: string;
  taskId: string;
  tool: string;
  input: unknown;
  requestedAt: number;
}

/** 订阅后端 SSE 事件流；返回取消函数。
 *  事件经回调分发（由 useSubagentStore 统一管理状态）。 */
export function subscribeSubagentEvents(
  onEvent: (event: SubagentSseEvent) => void,
  onOpen?: () => void,
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retryTimer: number | null = null;
  // SSE 断线自动重连（指数退避，上限 30s）
  let retryDelay = 1000;

  const connect = async () => {
    if (closed) return;
    const base = await getBackendBaseUrl();
    if (closed) return;
    es = new EventSource(`${base}/api/subagents/events`);

    // 后端事件类型（Event 默认按 event 字段分发）
    const types = [
      'subagent_completed',
      'subagent_failed',
      'subagent_state',
      'subagent_progress',
      'subagent_permission_request',
      'subagent_permission_resolved',
      'subagent_recovery',
      'lagged',
    ];
    types.forEach((type) => {
      es?.addEventListener(type, (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          onEvent(payload as SubagentSseEvent);
        } catch {
          // 忽略畸形事件
        }
      });
    });

    es.onopen = () => {
      retryDelay = 1000;
      onOpen?.();
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (!closed) {
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    };
  };

  void connect();

  return () => {
    closed = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    es?.close();
    es = null;
  };
}

/** 拉取完成缓冲（断线补齐；拉取即消费，§7.5）。 */
export async function fetchCompletedSubagents(): Promise<SubagentCompletionSummary[]> {
  const result = await backendGet<{ completed: SubagentCompletionSummary[] }>(
    '/api/subagents/completed',
  );
  return result.completed ?? [];
}

/** 回填权限审批决策（approve / always_approve / reject）。 */
export async function decideSubagentPermission(
  requestId: string,
  decision: 'approve' | 'always_approve' | 'reject',
): Promise<void> {
  await backendPost(`/api/subagents/permissions/${encodeURIComponent(requestId)}`, {
    decision,
  });
}

/** 可用 agent 列表。 */
export interface SubagentAgentInfo {
  name: string;
  description: string;
  capabilityMode: string | null;
  hidden: boolean;
}

export async function listSubagentAgents(): Promise<SubagentAgentInfo[]> {
  const result = await backendGet<{ agents: SubagentAgentInfo[] }>('/api/subagents/agents');
  return result.agents ?? [];
}

/** 子代理配置（设置页）。 */
export interface SubagentConfig {
  maxSubagentDepth: number;
  allowModelDepthHint: boolean;
  subagentsMaxConcurrent: number;
  subagentsQueueLimit: number;
  awaitBudgetMs: number;
  permissionTimeoutMs: number;
  depthPolicy: string;
  worktreeMaxAgeDays: number;
}

export async function getSubagentConfig(): Promise<SubagentConfig> {
  return backendGet<SubagentConfig>('/api/subagents/config');
}

export async function updateSubagentConfig(config: Partial<SubagentConfig>): Promise<void> {
  await backendPut('/api/subagents/config', config);
}
