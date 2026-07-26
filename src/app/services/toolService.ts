import { backendGet, backendPatch, backendPost } from './backendClient';

// ─── 工具执行 ──────────────────────────────────────────────────────────────

export interface ExecuteToolResult {
  /** 工具输出文本，将作为 [tool] 的 [output] 回填给模型。 */
  output: string;
  /** 是否为错误结果。 */
  isError: boolean;
  /** 后端返回的结构化数据（如任务对象），可选。 */
  structured?: unknown;
}

export interface ExecuteToolParams {
  /** 工具名（Write/Edit/Glob/Grep/TaskCreate/...）。 */
  tool: string;
  /** 已解析的工具输入参数。 */
  input: unknown;
  /** 当前会话 ID，任务工具按此隔离。 */
  chatId: string;
}

/**
 * 调用后端执行单个工具调用。
 *
 * 路由：POST /api/tools/execute
 * 返回：{ output, isError, structured? }
 */
export async function executeTool(params: ExecuteToolParams): Promise<ExecuteToolResult> {
  const result = await backendPost<{ output: string; isError: boolean; structured?: unknown }>(
    '/api/tools/execute',
    {
      tool: params.tool,
      input: params.input ?? {},
      chatId: params.chatId,
    },
  );
  return {
    output: result.output,
    isError: result.isError,
    structured: result.structured,
  };
}

// ─── 任务管理 CRUD ──────────────────────────────────────────────────────────
//
// 路由约定：
//   GET    /api/tasks?chatId=xxx          — 列出会话下所有任务
//   POST   /api/tasks                     — 创建任务（body 含 chatId）
//   GET    /api/tasks/:id?chatId=xxx      — 获取单个任务
//   PATCH  /api/tasks/:id?chatId=xxx      — 更新任务

/** 后端任务状态（与 backend task_store.rs 对齐）。 */
export type BackendTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

const STATUS_LABELS: Record<BackendTaskStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
};

/** 后端 Task 结构（与 backend task_store.rs 对齐）。 */
export interface BackendTask {
  id: string;
  subject: string;
  description?: string;
  status: BackendTaskStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskPayload {
  subject: string;
  description?: string;
  status?: BackendTaskStatus;
}

export interface UpdateTaskPayload {
  subject?: string;
  description?: string | null;
  status?: BackendTaskStatus;
}

export async function listTasks(chatId: string): Promise<BackendTask[]> {
  const result = await backendGet<{ tasks: BackendTask[] }>(`/api/tasks?chatId=${encodeURIComponent(chatId)}`);
  return result.tasks;
}

export async function createTask(chatId: string, payload: CreateTaskPayload): Promise<BackendTask> {
  const result = await backendPost<{ task: BackendTask }>('/api/tasks', {
    chatId,
    ...payload,
  });
  return result.task;
}

export async function getTask(chatId: string, taskId: string): Promise<BackendTask> {
  const result = await backendGet<{ task?: BackendTask } | BackendTask>(
    `/api/tasks/${encodeURIComponent(taskId)}?chatId=${encodeURIComponent(chatId)}`,
  );
  // 兼容直接返回 task 或包在 { task } 中两种格式
  return (result as { task?: BackendTask }).task ?? (result as BackendTask);
}

export async function updateTask(
  chatId: string,
  taskId: string,
  payload: UpdateTaskPayload,
): Promise<BackendTask> {
  const result = await backendPatch<{ task?: BackendTask } | BackendTask>(
    `/api/tasks/${encodeURIComponent(taskId)}?chatId=${encodeURIComponent(chatId)}`,
    payload,
  );
  return (result as { task?: BackendTask }).task ?? (result as BackendTask);
}

/** 任务状态中文标签，供卡片渲染复用。 */
export function taskStatusLabel(status: BackendTaskStatus): string {
  return STATUS_LABELS[status] ?? status;
}
