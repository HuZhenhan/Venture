export interface VentureHealth {
  status: 'ok';
  version: string;
  nonce: string;
  pid: number;
  startedAt: number;
}

export type VentureProviderKind = 'openai_compatible' | 'deepseek';

export interface VentureModelCapabilities {
  supportsReasoning: boolean;
  supportsTools: boolean;
  supportsMultimodal: boolean;
  contextWindow?: number;
}

export interface VentureModel {
  id: string;
  name: string;
  enabled: boolean;
  supportsMultimodal?: boolean;
  capabilities?: VentureModelCapabilities;
}

export interface VentureProvider {
  id: string;
  name: string;
  providerKind: VentureProviderKind;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyPreview: string;
  models: VentureModel[];
  inputContextWindow: number;
}

export interface AddProviderRequest {
  name: string;
  providerKind: VentureProviderKind;
  baseUrl: string;
  apiKey: string;
  models: VentureModel[];
  inputContextWindow: number;
}

export interface UpdateProviderRequest {
  name?: string;
  providerKind?: VentureProviderKind;
  baseUrl?: string;
  apiKey?: string;
  models?: VentureModel[];
  inputContextWindow?: number;
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessageContent = string | ChatMessageContentPart[];

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: ChatMessageContent;
  reasoning_content?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface StreamChatRequest {
  chatId?: string;
  turnMessageId?: string;
  assistantMessageId?: string;
  modelId: string;
  providerId?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  traceUpstream?: boolean;
}

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export type StreamEvent =
  | { event: 'message_start' }
  | { event: 'reasoning_delta'; data: { delta: string } }
  | { event: 'content_delta'; data: { delta: string } }
  | { event: 'tool_call_start'; data: { index: number; id: string; name: string } }
  | { event: 'tool_call_delta'; data: { index: number; id?: string; name?: string; arguments?: string } }
  | { event: 'message_done'; data: { usage?: UsageInfo | null; upstream_trace?: unknown } }
  | { event: 'error'; data: { code: string; message: string } };

export interface ExecuteToolRequest {
  tool: string;
  input?: unknown;
  chatId: string;
  turnMessageId?: string;
  modelId?: string;
}

export interface ExecuteToolResult {
  output: string;
  isError: boolean;
  structured?: unknown;
}

export interface FileChangesQuery {
  turnId?: string;
  path?: string;
}

export interface ChangeRecordSummary {
  id: string;
  turnId: string;
  messageId: string;
  path: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  source: 'agent' | 'external_edit' | 'user_manual';
  timestamp: number;
}

export type SkillScope = 'project' | 'global' | 'plugin' | 'mcp';
export type SkillPermission = 'allow' | 'deny' | 'ask';

export interface SkillInfo {
  canonicalName: string;
  name: string;
  description: string;
  whenToUse: string;
  version: string;
  scope: SkillScope;
  location: string;
  active: boolean;
  enabled: boolean;
  autoInvocable: boolean;
  userInvocable: boolean;
  paths: string[] | null;
  frontmatter: Record<string, unknown>;
  shadowedBy: string | null;
  bundled: boolean;
  permission: SkillPermission;
}

export interface SkillLoadError {
  location: string;
  code: string;
  message: string;
}

export interface SkillPlatformInfo {
  hasProjectScope: boolean;
  os: string;
}

export interface SkillListResult {
  skills: SkillInfo[];
  shadowed: SkillInfo[];
  errors: SkillLoadError[];
  platform: SkillPlatformInfo;
}
