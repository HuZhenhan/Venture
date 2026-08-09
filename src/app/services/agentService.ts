import { backendGet, backendPost, backendDelete } from './backendClient';

// ─── 手机助手 Agent API（对应 MOBILE_ASSISTANT_SPEC.md 第 6/8 章） ────────────
//
// 路由约定：
//   POST   /api/agent/tool                     — 通用工具调用（agent 循环执行入口）
//   GET    /api/agent/tool-schemas             — 工具 schema 同步
//   GET    /api/agent/trace?chatId=&limit=     — 执行轨迹
//   GET    /api/agent/health                   — 原生桥健康
//   GET    /api/agent/permission               — 无障碍权限三态
//   POST   /api/agent/permission/open          — 跳转系统无障碍设置
//   GET    /api/agent/scripts                  — 脚本列表
//   GET    /api/agent/scripts/:name            — 脚本详情
//   PUT    /api/agent/scripts/:name            — 创建/更新用户脚本
//   DELETE /api/agent/scripts/:name            — 删除脚本
//   POST   /api/agent/scripts/:name/enabled    — 启用/禁用
//   POST   /api/agent/scripts/:name/run        — 运行脚本
//   POST   /api/agent/scripts/validate         — 静态校验
//   POST   /api/agent/scripts/import           — 导入分享脚本

/** agent 工具名集合（小写）——useGeneration 据此把工具分发到 /api/agent/tool 而非 /api/tools/execute。 */
export const AGENT_TOOL_NAMES = new Set([
  // 感知
  'screenshot', 'get_layout', 'get_node', 'find_node', 'get_foreground_app',
  'get_screen_info', 'read_clipboard', 'get_windows',
  // 操作
  'click', 'long_click', 'press', 'swipe', 'gesture', 'node_action', 'input_text',
  'paste', 'key_event', 'global_action', 'set_clipboard', 'launch_app', 'open_url', 'scroll',
  // 控制
  'wait_for_node', 'wait_for_text', 'wait_for_app', 'sleep', 'stop_app',
  // 确认/进度
  'report_progress',
  // 脚本
  'run_script', 'list_scripts', 'create_script', 'validate_script',
]);

export function isAgentTool(toolName: string): boolean {
  return AGENT_TOOL_NAMES.has(toolName.toLowerCase());
}

export interface AgentToolResult {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

/** 执行 agent 工具（POST /api/agent/tool） */
export async function executeAgentTool(
  tool: string,
  args: unknown,
  chatId: string,
): Promise<AgentToolResult> {
  return backendPost<AgentToolResult>('/api/agent/tool', {
    tool,
    args: args ?? {},
    chatId,
  });
}

// ─── 无障碍权限门槛（规格书 8.3 三态检测） ────────────────────────────────
//
// 重启软件后第一次执行"需要无障碍服务"的工具时，先检测权限；未开启则引导
// 用户跳转系统设置。进程内只检查一次（WebView 重启即重置），避免每步打扰。

/** 不依赖无障碍服务的工具（豁免名单） */
const NON_ACCESSIBILITY_TOOLS = new Set([
  'launch_app', 'open_url', 'set_clipboard', 'read_clipboard', 'sleep',
]);

/** 该工具是否依赖无障碍服务 */
export function needsAccessibilityPermission(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return AGENT_TOOL_NAMES.has(name) && !NON_ACCESSIBILITY_TOOLS.has(name);
}

/** 会话级检查标志：false = 本进程尚未检查过 */
let sessionPermissionChecked = false;
let sessionPermissionOk = false;

/**
 * 进程内首次检查无障碍权限。
 * @returns 'ok' 已开启 | 'missing' 未开启（应引导） | 'skip' 工具不需要权限
 */
export async function checkAccessibilityPermissionOnce(
  toolName: string,
): Promise<'ok' | 'missing' | 'skip'> {
  if (!needsAccessibilityPermission(toolName)) return 'skip';
  if (sessionPermissionChecked) return sessionPermissionOk ? 'ok' : 'missing';

  sessionPermissionChecked = true;
  try {
    const state = await getAccessibilityPermission();
    // granted：系统设置已授权；connected：服务实例已连接
    const ok = state.granted === true && state.connected === true;
    sessionPermissionOk = ok;
    return ok ? 'ok' : 'missing';
  } catch {
    // 后端不可达时放行，避免误伤正常执行
    sessionPermissionOk = true;
    return 'ok';
  }
}

/** 重置会话检查（用户取消引导后，下次工具调用会再次提示） */
export function resetAccessibilityCheck(): void {
  sessionPermissionChecked = false;
  sessionPermissionOk = false;
}

/** 标记本次会话已通过检查（用户在设置页开启权限返回后调用） */
export function markAccessibilityChecked(): void {
  sessionPermissionChecked = true;
  sessionPermissionOk = true;
}

/** 权限引导弹窗的结果回调（true=已开启，false=用户取消） */
let permissionResolver: ((granted: boolean) => void) | null = null;

/**
 * 等待用户处理权限引导弹窗（阻塞工具循环）。
 * 弹窗因权限已开启而关闭 → resolve(true)；用户取消 → resolve(false)。
 */
export function waitForPermissionResolution(): Promise<boolean> {
  return new Promise((resolve) => {
    permissionResolver = resolve;
  });
}

/** 弹窗关闭时调用：告知等待中的工具循环结果 */
export function resolvePermissionDialog(granted: boolean): void {
  permissionResolver?.(granted);
  permissionResolver = null;
}

// ─── 执行轨迹 ────────────────────────────────────────────────────────────────

export interface TraceEntry {
  chat_id: string;
  tool: string;
  args: unknown;
  result: unknown;
  ts: number;
  duration_ms: number;
}

export async function getAgentTrace(chatId?: string, limit = 100): Promise<TraceEntry[]> {
  const query = new URLSearchParams();
  if (chatId) query.set('chat_id', chatId);
  query.set('limit', String(limit));
  const result = await backendGet<{ trace: TraceEntry[] }>(`/api/agent/trace?${query.toString()}`);
  return result.trace;
}

// ─── 无障碍权限（规格书 8.3 三态检测） ───────────────────────────────────────

export interface AccessibilityPermissionState {
  ok: boolean;
  granted?: boolean;
  connected?: boolean;
  operational?: boolean;
  error?: { code: string; message: string };
}

export async function getAccessibilityPermission(): Promise<AccessibilityPermissionState> {
  return backendGet<AccessibilityPermissionState>('/api/agent/permission');
}

export async function openAccessibilitySettings(): Promise<void> {
  await backendPost('/api/agent/permission/open', {});
}

export async function getAgentBridgeHealth(): Promise<{ ok: boolean; service_connected?: boolean; operational?: boolean }> {
  return backendGet<{ ok: boolean; service_connected?: boolean; operational?: boolean }>('/api/agent/health');
}

// ─── 后台保活（电池优化白名单引导） ──────────────────────────────────────────

export interface KeepAliveStatus {
  ok: boolean;
  /** 是否已豁免电池优化 */
  exempt?: boolean;
  /** 前台保活服务是否运行中 */
  active?: boolean;
  error?: { code: string; message: string };
}

/** 保活状态（电池优化豁免 + 前台服务活动） */
export async function getKeepAliveStatus(): Promise<KeepAliveStatus> {
  return backendGet<KeepAliveStatus>('/api/agent/keepalive/status');
}

/** 请求电池优化豁免（弹系统对话框） */
export async function requestBatteryExempt(): Promise<KeepAliveStatus> {
  return backendPost<KeepAliveStatus>('/api/agent/keepalive/request-exempt', {});
}

/** 打开电池优化设置页（用户手动选"不受限制"） */
export async function openBatterySettings(): Promise<KeepAliveStatus> {
  return backendPost<KeepAliveStatus>('/api/agent/keepalive/open-settings', {});
}

// ─── AI 活动悬浮窗权限 ─────────────────────────────────────────────────────

export interface OverlayPermissionState {
  ok: boolean;
  /** 是否已授予悬浮窗权限（SYSTEM_ALERT_WINDOW） */
  granted?: boolean;
  error?: { code: string; message: string };
}

/** 悬浮窗权限状态 */
export async function getOverlayPermission(): Promise<OverlayPermissionState> {
  return backendGet<OverlayPermissionState>('/api/agent/overlay/permission');
}

/** 打开悬浮窗权限授权页 */
export async function openOverlaySettings(): Promise<OverlayPermissionState> {
  return backendPost<OverlayPermissionState>('/api/agent/overlay/open-settings', {});
}

/** 主动关闭悬浮窗（停止按钮/异常中断时调用，防止状态残留） */
export async function hideOverlay(): Promise<void> {
  await backendPost('/api/agent/overlay/hide', {});
}

// ─── 脚本管理（DSL §12） ─────────────────────────────────────────────────────

export type ScriptSource = 'builtin' | 'user' | 'shared';

export interface ScriptSummary {
  name: string;
  description: string;
  risky: boolean;
  enabled: boolean;
  source: ScriptSource;
  run_count: number;
  params_schema: Record<string, unknown>;
  result_schema?: Record<string, unknown> | null;
}

export interface ScriptDef extends ScriptSummary {
  version: number;
  required_permissions: string[];
  timeout_sec: number;
  max_steps: number;
  params: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
}

export interface ValidationReport {
  valid: boolean;
  requires_confirmation: boolean;
  issues: Array<{ level: string; path: string; message: string }>;
}

export interface RunScriptOutcome {
  status: 'ok' | 'error' | 'needs_confirmation' | 'disabled' | 'not_found';
  result: unknown;
  duration_ms: number;
  steps_executed: number;
  last_error: string | null;
  confirmation?: { script: string; reason: string; risky: boolean };
}

export async function listScripts(): Promise<ScriptSummary[]> {
  const result = await backendGet<{ scripts: ScriptSummary[] }>('/api/agent/scripts');
  return result.scripts;
}

export async function getScript(name: string): Promise<ScriptDef> {
  const result = await backendGet<{ script: ScriptDef }>(`/api/agent/scripts/${encodeURIComponent(name)}`);
  return result.script;
}

export async function deleteScript(name: string): Promise<{ ok: boolean; error?: { message: string } }> {
  return backendDelete<{ ok: boolean; error?: { message: string } }>(`/api/agent/scripts/${encodeURIComponent(name)}`);
}

export async function setScriptEnabled(name: string, enabled: boolean): Promise<void> {
  await backendPost(`/api/agent/scripts/${encodeURIComponent(name)}/enabled`, { enabled });
}

export async function runScript(
  name: string,
  params: Record<string, unknown>,
  confirmed = false,
  chatId = '',
): Promise<RunScriptOutcome> {
  return backendPost<RunScriptOutcome>(`/api/agent/scripts/${encodeURIComponent(name)}/run`, {
    params,
    confirmed,
    chatId,
  });
}

export async function validateScript(script: unknown): Promise<ValidationReport> {
  const result = await backendPost<{ ok: boolean; report: ValidationReport }>(
    '/api/agent/scripts/validate',
    script,
  );
  return result.report;
}

/** 导入分享脚本（默认 risky + 禁用，后端强制） */
export async function importScript(script: unknown): Promise<{ ok: boolean; error?: { message: string }; report?: ValidationReport }> {
  return backendPost('/api/agent/scripts/import', script);
}

/** 导出脚本为格式化 JSON 文本（前端下载/分享用） */
export async function exportScriptText(name: string): Promise<string> {
  const script = await getScript(name);
  return JSON.stringify(script, null, 2);
}
