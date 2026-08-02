import { Chat, ChatMode, ToolPermissionLevel, ToolPermissionsByMode } from '../types';

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

/** 各模式的默认权限级别（保持历史行为：全部放行）。 */
export const DEFAULT_TOOL_PERMISSION: Record<ChatMode, ToolPermissionLevel> = {
  yolo: 'unrestricted',
  agent: 'unrestricted',
  plan: 'unrestricted',
};

export const TOOL_PERMISSION_LABELS: Record<ToolPermissionLevel, string> = {
  unrestricted: '无限制',
  auto_review: '自动审查',
  readonly: '只读',
  general: '仅一般操作',
  ask_all: '全部询问',
};

export const TOOL_PERMISSION_DESCRIPTIONS: Record<ToolPermissionLevel, string> = {
  unrestricted: '自动执行所有工具调用',
  auto_review: '执行前自动审查（暂未启用，同无限制）',
  readonly: '仅允许读取、搜索与任务管理工具',
  general: '读写编辑自动执行，其余工具需询问',
  ask_all: '所有工具调用都需要你同意',
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
]);

/** 仅一般操作级别自动放行的工具（小写工具名）= 只读集 + 写入/编辑。 */
const GENERAL_ALLOWED_TOOLS = new Set([
  ...READONLY_ALLOWED_TOOLS,
  'write',
  'edit',
]);

/** 无论何种权限级别都不需要授权卡片的工具（自身即是交互工具）。 */
const ALWAYS_ALLOWED_TOOLS = new Set(['askuserquestion']);

// ─── 判定结果 ───────────────────────────────────────────────────────────────

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';

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
  approvedSignatures,
}: EvaluateToolCallArgs): ToolPermissionDecision {
  const normalized = toolName.toLowerCase();

  // 交互工具自身永远放行（其 UI 即是询问）
  if (ALWAYS_ALLOWED_TOOLS.has(normalized)) {
    return 'allow';
  }

  switch (level) {
    case 'unrestricted':
      return 'allow';

    case 'auto_review':
      // TODO: 自动审查接口预留——后续在此接入自动审查流程（如二次模型评估）。
      // 当前保持与「无限制」一致的行为。
      return 'allow';

    case 'readonly':
      return READONLY_ALLOWED_TOOLS.has(normalized) ? 'allow' : 'deny';

    case 'general': {
      if (GENERAL_ALLOWED_TOOLS.has(normalized)) {
        return 'allow';
      }
      // yolo 模式下「仅一般操作」：权限外工具直接自动拒绝，不询问
      if (mode === 'yolo') {
        return 'deny';
      }
      return approvedSignatures.includes(toolSignature(toolName, input)) ? 'allow' : 'ask';
    }

    case 'ask_all':
      return approvedSignatures.includes(toolSignature(toolName, input)) ? 'allow' : 'ask';
  }
}

// ─── 拒绝文案 ───────────────────────────────────────────────────────────────

/** 权限不足被自动拒绝时回填给模型的输出。 */
export function permissionDeniedOutput(level: ToolPermissionLevel, toolName: string): string {
  const levelLabel = TOOL_PERMISSION_LABELS[level] ?? level;
  return `权限不足：当前权限级别为「${levelLabel}」，工具 ${toolName} 不在允许范围内，本次调用已被自动拒绝。请调整方案，仅使用当前权限允许的工具。`;
}

/** 用户在询问卡片上点击「拒绝」时回填给模型的输出。 */
export const USER_REJECTED_OUTPUT = '用户拒绝了本次工具调用，请不要重复尝试相同操作；如需继续，请与用户确认或更换方案。';

/** 权限询问被新一轮对话取代时的输出。 */
export const APPROVAL_EXPIRED_OUTPUT = '权限询问已取消（用户发起了新的对话），本次工具调用未执行。';
