import { Chat, ChatMode, PermissionDecision, PermissionProfile, ToolPermissionLevel, ToolPermissionsByMode } from '../types';
import type { ToolMetadata } from '../services/toolService';

/**
 * 工具调用权限系统核心逻辑。
 *
 * 权限级别语义见 types.ts 的 ToolPermissionLevel 注释。
 * 本模块只负责「判定」，UI（权限选择按钮、询问卡片）与执行（useGeneration）
 * 分别引用这里的常量与 evaluateToolCall。
 */

// ─── 各模式可选权限 ─────────────────────────────────────────────────────────

export const TOOL_PERMISSION_OPTIONS: Record<ChatMode, ToolPermissionLevel[]> = {
  yolo: ['unrestricted', 'auto_review', 'general'],
  agent: ['unrestricted', 'auto_review', 'general', 'ask_all'],
  plan: ['readonly', 'unrestricted', 'auto_review', 'general', 'ask_all'],
};

/** 各模式的默认权限级别：默认不自动执行写入、命令、MCP、子代理等高风险能力。 */
export const DEFAULT_TOOL_PERMISSION: Record<ChatMode, ToolPermissionLevel> = {
  yolo: 'general',
  agent: 'general',
  plan: 'readonly',
};

export const TOOL_PERMISSION_LABELS: Record<ToolPermissionLevel, string> = {
  unrestricted: '受信任',
  auto_review: '自动审查',
  readonly: '只读',
  general: '标准确认',
  ask_all: '全部询问',
};

export const TOOL_PERMISSION_DESCRIPTIONS: Record<ToolPermissionLevel, string> = {
  unrestricted: '读写与 Skill 可自动执行，命令/MCP/子代理仍需确认',
  auto_review: '保守预留：高风险能力仍需你确认',
  readonly: '仅允许读取、搜索与任务管理工具',
  general: '读取自动执行，写入/命令/网络/MCP/Skill/子代理需确认',
  ask_all: '所有工具调用都需要你同意',
};

export const TOOL_PERMISSION_PROFILES: Record<ToolPermissionLevel, PermissionProfile> = {
  readonly: {
    readFiles: 'allow',
    writeFiles: 'deny',
    executeCommands: 'deny',
    networkAccess: 'deny',
    mcpAccess: 'deny',
    skillAccess: 'ask',
    subagentAccess: 'deny',
    sandbox: 'no_sandbox',
  },
  general: {
    readFiles: 'allow',
    writeFiles: 'ask',
    executeCommands: 'ask',
    networkAccess: 'ask',
    mcpAccess: 'ask',
    skillAccess: 'ask',
    subagentAccess: 'ask',
    sandbox: 'no_sandbox',
  },
  ask_all: {
    readFiles: 'ask',
    writeFiles: 'ask',
    executeCommands: 'ask',
    networkAccess: 'ask',
    mcpAccess: 'ask',
    skillAccess: 'ask',
    subagentAccess: 'ask',
    sandbox: 'no_sandbox',
  },
  auto_review: {
    readFiles: 'audit_only',
    writeFiles: 'ask',
    executeCommands: 'ask',
    networkAccess: 'ask',
    mcpAccess: 'ask',
    skillAccess: 'audit_only',
    subagentAccess: 'ask',
    sandbox: 'no_sandbox',
  },
  unrestricted: {
    readFiles: 'allow',
    writeFiles: 'allow',
    executeCommands: 'ask',
    networkAccess: 'ask',
    mcpAccess: 'ask',
    skillAccess: 'allow',
    subagentAccess: 'ask',
    sandbox: 'no_sandbox',
  },
};

// ─── 工具分类 ───────────────────────────────────────────────────────────────

/** 只读级别放行的工具（小写工具名）。 */
const READONLY_ALLOWED_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'askuserquestion',
  'taskcreate',
  'taskupdate',
  'tasklist',
  'taskget',
  'todocreate',
  'todoupdate',
  'todolist',
  'todoget',
  'list_skill',
]);

const WRITE_TOOLS = new Set(['write', 'edit']);
const SKILL_TOOLS = new Set(['load_skill']);
const SUBAGENT_TOOLS = new Set(['spawn_agent', 'get_agent_output', 'kill_agent', 'run_workflow', 'kill_workflow']);

/** 无论何种权限级别都不需要授权卡片的工具（自身即是交互工具）。 */
const ALWAYS_ALLOWED_TOOLS = new Set(['askuserquestion']);

// ─── 判定结果 ───────────────────────────────────────────────────────────────

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';

export type PermissionCapability = keyof Omit<PermissionProfile, 'sandbox'>;

const CAPABILITY_LABELS: Record<PermissionCapability, string> = {
  readFiles: '读取文件',
  writeFiles: '写入文件',
  executeCommands: '执行命令',
  networkAccess: '网络访问',
  mcpAccess: 'MCP 工具',
  skillAccess: 'Skill 加载',
  subagentAccess: '子代理',
};

export function getPermissionProfileForLevel(level: ToolPermissionLevel): PermissionProfile {
  return TOOL_PERMISSION_PROFILES[level] ?? TOOL_PERMISSION_PROFILES.general;
}

export function getToolCapability(toolName: string): PermissionCapability {
  const normalized = toolName.toLowerCase();
  if (READONLY_ALLOWED_TOOLS.has(normalized)) return 'readFiles';
  if (WRITE_TOOLS.has(normalized)) return 'writeFiles';
  if (SKILL_TOOLS.has(normalized)) return 'skillAccess';
  if (SUBAGENT_TOOLS.has(normalized)) return 'subagentAccess';
  if (normalized.startsWith('mcp_') || normalized.includes('mcp')) return 'mcpAccess';
  if (normalized.includes('web') || normalized.includes('fetch') || normalized.includes('search')) return 'networkAccess';
  return 'executeCommands';
}

export function riskLevelForTool(toolName: string, metadata?: ToolMetadata): 'low' | 'medium' | 'high' {
  if (metadata?.riskLevel) return metadata.riskLevel;
  const capability = getToolCapability(toolName);
  if (capability === 'writeFiles' || capability === 'executeCommands' || capability === 'networkAccess' || capability === 'mcpAccess') {
    return 'high';
  }
  if (capability === 'skillAccess' || capability === 'subagentAccess') return 'medium';
  return 'low';
}

export function impactSummaryForTool(toolName: string, input: unknown): string {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const value = record.file_path ?? record.path ?? record.url ?? record.command ?? record.name ?? record.subagent_type;
  return typeof value === 'string' && value.trim().length > 0 ? value : toolName;
}

// ─── 签名（"一律同意"白名单用）─────────────────────────────────────────────

/** 递归按键名排序后序列化，保证相同语义的参数产生稳定签名。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** 生成工具调用签名：工具名 + 规范化参数。"一律同意"按完全相同（工具、参数）匹配。 */
export function toolSignature(toolName: string, input: unknown): string {
  return `${toolName}::${stableStringify(input ?? {})}`;
}

// ─── 权限解析与判定 ─────────────────────────────────────────────────────────

/**
 * 解析会话在某模式下的生效权限级别。
 * 存储值不在该模式可选范围内时回退到默认级别。
 */
export function resolveChatPermission(
  permissions: ToolPermissionsByMode | undefined,
  mode: ChatMode,
): ToolPermissionLevel {
  const stored = permissions?.[mode];
  if (stored && TOOL_PERMISSION_OPTIONS[mode].includes(stored)) {
    return stored;
  }
  return DEFAULT_TOOL_PERMISSION[mode];
}

/** 从 Chat 对象解析生效权限级别（chat 为空时走新会话预选权限）。 */
export function resolvePermissionForChat(
  chat: Pick<Chat, 'permissions'> | null | undefined,
  mode: ChatMode,
  preSelectedPermissions?: ToolPermissionsByMode,
): ToolPermissionLevel {
  if (chat) {
    return resolveChatPermission(chat.permissions, mode);
  }
  return resolveChatPermission(preSelectedPermissions, mode);
}

export interface EvaluateToolCallArgs {
  level: ToolPermissionLevel;
  mode: ChatMode;
  toolName: string;
  input: unknown;
  metadata?: ToolMetadata;
  /** "一律同意"白名单签名集合。 */
  approvedSignatures: readonly string[];
}

/**
 * 判定一次工具调用在当前权限级别下的处理方式：
 * - allow：直接执行；
 * - deny：自动拒绝（以 failed 结果回填给模型）；
 * - ask：弹出权限询问卡片，等待用户决定。
 */
export function evaluateToolCall({
  level,
  mode,
  toolName,
  input,
  metadata,
  approvedSignatures,
}: EvaluateToolCallArgs): ToolPermissionDecision {
  const normalized = toolName.toLowerCase();

  // 交互工具自身永远放行（其 UI 即是询问）
  if (ALWAYS_ALLOWED_TOOLS.has(normalized)) {
    return 'allow';
  }

  void metadata;

  const profile = getPermissionProfileForLevel(level);
  const configuredDecision: PermissionDecision = profile[getToolCapability(normalized)];
  if (configuredDecision === 'allow' || configuredDecision === 'audit_only') return 'allow';
  if (configuredDecision === 'deny' || mode === 'yolo') return 'deny';
  return approvedSignatures.includes(toolSignature(toolName, input)) ? 'allow' : 'ask';
}

// ─── 拒绝文案 ───────────────────────────────────────────────────────────────

/** 权限不足被自动拒绝时回填给模型的输出。 */
export function permissionDeniedOutput(level: ToolPermissionLevel, toolName: string): string {
  const levelLabel = TOOL_PERMISSION_LABELS[level] ?? level;
  const capability = CAPABILITY_LABELS[getToolCapability(toolName)];
  return `权限不足：当前权限 profile 为「${levelLabel}」，${capability}能力不允许工具 ${toolName} 自动执行，本次调用已被拒绝。请调整方案或请求用户确认。`;
}

export interface PermissionRequestCopy {
  title: string;
  description: string;
  inputLabel: string;
  timeoutHint?: string;
}

export function buildPermissionRequestCopy(args: {
  actor: 'tool' | 'subagent';
  toolName: string;
  reason?: string;
  timeoutSeconds?: number;
}): PermissionRequestCopy {
  const capability = CAPABILITY_LABELS[getToolCapability(args.toolName)];
  const actor = args.actor === 'subagent' ? '子代理' : '工具调用';
  return {
    title: `${actor}请求使用：${args.toolName}`,
    description: args.reason ?? `${capability}能力需要用户确认后才能继续。`,
    inputLabel: '传入参数',
    timeoutHint: args.timeoutSeconds ? `${args.timeoutSeconds} 秒无响应将自动拒绝` : undefined,
  };
}

/** 用户在询问卡片上点击「拒绝」时回填给模型的输出。 */
export const USER_REJECTED_OUTPUT = '用户拒绝了本次工具调用，请不要重复尝试相同操作；如需继续，请与用户确认或更换方案。';

/** 权限询问被新一轮对话取代时的输出。 */
export const APPROVAL_EXPIRED_OUTPUT = '权限询问已取消（用户发起了新的对话），本次工具调用未执行。';
