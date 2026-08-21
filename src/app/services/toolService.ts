import { backendDelete, backendGet, backendPatch, backendPost } from './backendClient';

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
  /** 工具名（Write/Edit/Glob/Grep/TodoCreate/spawn_agent/...）。 */
  tool: string;
  /** 已解析的工具输入参数。 */
  input: unknown;
  /** 当前会话 ID，todo 工具按此隔离。 */
  chatId: string;
  /** 当前轮次的消息 ID（用于文件回退系统的 turn 级关联）。
   *  提供时触发备份流程，不提供时跳过备份（向后兼容）。 */
  turnMessageId?: string;
  /** 当前会话模型 ID（子代理 spawn_agent 工具的 inherit 语义；设计稿 §18.1 #6）。 */
  modelId?: string;
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
      ...(params.turnMessageId ? { turnMessageId: params.turnMessageId } : {}),
      ...(params.modelId ? { modelId: params.modelId } : {}),
    },
  );
  return {
    output: result.output,
    isError: result.isError,
    structured: result.structured,
  };
}

// ─── 清单（todo）CRUD ───────────────────────────────────────────────────────
//
// 说明：REST 路径与字段保留 task 命名（内部协议，与后端 task_store.rs 一致）；
// 模型侧的工具名是 TodoCreate/TodoUpdate/TodoList/TodoGet（与子代理 spawn_agent 区分）。
//
// 路由约定：
//   GET    /api/tasks?chatId=xxx          — 列出会话下所有清单项
//   POST   /api/tasks                     — 创建清单项（body 含 chatId）
//   GET    /api/tasks/:id?chatId=xxx      — 获取单个清单项
//   PATCH  /api/tasks/:id?chatId=xxx      — 更新清单项

/** 后端清单状态（与 backend task_store.rs 对齐）。 */
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

// ─── 文件回退系统 API ──────────────────────────────────────────────────────
//
// 路由约定：
//   POST   /api/files/restore-turn         — Turn 级回退
//   POST   /api/files/restore-records       — 选择性回退（按 record_id）
//   GET    /api/files/changes               — 查询变更记录
//   POST   /api/files/backup-mode           — 设置备份模式
//   GET    /api/files/backup-status         — 查看备份状态
//   DELETE /api/files/backups               — 删除备份
//   POST   /api/files/sync-in               — SAF sync-in
//   POST   /api/files/sync-out              — SAF sync-out
//   GET    /api/files/sync-status           — SAF 同步状态

/** 变更记录摘要（与后端 ChangeRecord 对齐）。 */
export interface ChangeRecordSummary {
  id: string;
  turnId: string;
  messageId: string;
  path: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  source: 'agent' | 'external_edit' | 'user_manual';
  timestamp: number;
}

/** 回退操作结果。 */
export interface RestoreResult {
  restoredFiles: string[];
  conflicts: ConflictInfo[];
  errors: string[];
}

/** 冲突信息。 */
export interface ConflictInfo {
  filePath: string;
  recordId: string;
  description: string;
}

/** 备份模式。 */
export type BackupMode = 'snapshot' | 'hunks' | 'auto';

/** 备份状态。 */
export interface BackupStatus {
  mode: BackupMode;
  pathOverrides: Array<{ globPattern: string; mode: BackupMode }>;
  quota: {
    maxTotalSize: number;
    safMaxTotalSize: number;
    warnThreshold: number;
  };
  totalSize: number;
  sessionCount: number;
}

/** SAF 同步状态。 */
export interface SyncStatus {
  enabled: boolean;
  dirtyCount: number;
  dirtyFiles: string[];
  trackedCount: number;
}

/** SAF sync-in 报告。 */
export interface SyncInReport {
  externalEdits: string[];
  externalDeletes: string[];
}

/** SAF sync-out 报告。 */
export interface SyncOutReport {
  synced: string[];
  failures: Array<{ path: string; reason: string; recoverable: boolean }>;
}

/**
 * Turn 级回退：回退指定 turn 内所有文件修改。
 * 路由：POST /api/files/restore-turn
 */
export async function restoreTurn(chatId: string, turnId: string): Promise<RestoreResult> {
  return backendPost<RestoreResult>('/api/files/restore-turn', { chatId, turnId });
}

/**
 * 选择性回退：回退指定的变更记录。
 * 路由：POST /api/files/restore-records
 */
export async function restoreRecords(recordIds: string[]): Promise<RestoreResult> {
  return backendPost<RestoreResult>('/api/files/restore-records', { recordIds });
}

/**
 * 查询变更记录。
 * 路由：GET /api/files/changes?chatId=...&turnId=...&path=...
 */
export async function getChanges(params: {
  chatId?: string;
  turnId?: string;
  path?: string;
}): Promise<ChangeRecordSummary[]> {
  const query = new URLSearchParams();
  if (params.chatId) query.set('chatId', params.chatId);
  if (params.turnId) query.set('turnId', params.turnId);
  if (params.path) query.set('path', params.path);
  const result = await backendGet<{ changes: ChangeRecordSummary[] }>(
    `/api/files/changes?${query.toString()}`,
  );
  return result.changes;
}

/**
 * 设置备份模式。
 * 路由：POST /api/files/backup-mode
 */
export async function setBackupMode(
  mode: BackupMode,
  pathPattern?: string,
): Promise<void> {
  await backendPost('/api/files/backup-mode', {
    mode,
    ...(pathPattern ? { pathPattern } : {}),
  });
}

/**
 * 查看备份状态。
 * 路由：GET /api/files/backup-status
 */
export async function getBackupStatus(): Promise<BackupStatus> {
  return backendGet<BackupStatus>('/api/files/backup-status');
}

/**
 * 删除备份。
 * 路由：DELETE /api/files/backups?chatId=...
 */
export async function deleteBackups(chatId?: string): Promise<void> {
  const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
  await backendDelete(`/api/files/backups${query}`);
}

/**
 * SAF sync-in：从 SAF 拉取外部变更。
 * 路由：POST /api/files/sync-in
 */
export async function syncIn(): Promise<SyncInReport> {
  return backendPost<SyncInReport>('/api/files/sync-in', {});
}

/**
 * SAF sync-out：推送到 SAF。
 * 路由：POST /api/files/sync-out
 */
export async function syncOut(): Promise<SyncOutReport> {
  return backendPost<SyncOutReport>('/api/files/sync-out', {});
}

/**
 * 查看 SAF 同步状态。
 * 路由：GET /api/files/sync-status
 */
export async function getSyncStatus(): Promise<SyncStatus> {
  return backendGet<SyncStatus>('/api/files/sync-status');
}

/** GC 报告。 */
export interface GcReport {
  versionsScanned: number;
  objectsMarked: number;
  objectsDeleted: number;
  spaceFreed: number;
  sessionsMerged: number;
}

/**
 * 执行垃圾回收：清理孤立对象、合并旧版本、释放空间。
 * 路由：POST /api/files/gc
 */
export async function runGc(): Promise<GcReport> {
  return backendPost<GcReport>('/api/files/gc', {});
}

// ─── 悬浮窗授权（Android 后台场景） ────────────────────────────────────────

export interface ApprovalNotifyParams {
  chatId: string;
  messageId: string;
  toolId: string;
  toolName: string;
  input: unknown;
  description?: string;
}

export interface ApprovalResult {
  messageId: string;
  toolId: string;
  decision: 'approve' | 'always_approve' | 'reject';
}

/**
 * 请求显示授权悬浮窗（工具权限询问时调用；后端转发 Kotlin 桥。
 * 应用在前台时 Kotlin 侧不显示，由应用内授权卡片处理）。
 * 路由：POST /api/approval/notify
 */
export async function notifyApproval(params: ApprovalNotifyParams): Promise<void> {
  await backendPost('/api/approval/notify', params);
}

/**
 * 轮询消费悬浮窗授权结果（取出即删，避免重复处理）。
 * 路由：GET /api/approval/results?chatId=...
 */
export async function fetchApprovalResults(chatId: string): Promise<ApprovalResult[]> {
  const res = await backendGet<{ results: ApprovalResult[] }>(
    `/api/approval/results?chatId=${encodeURIComponent(chatId)}`,
  );
  return res.results ?? [];
}
