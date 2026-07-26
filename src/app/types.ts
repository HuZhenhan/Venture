export type ChatSubmitAction =
  | { type: 'message'; text: string }
  | { type: 'regenerateLastReply' }
  | { type: 'undoLastTurn' };

export type ChatMode = 'agent' | 'plan' | 'yolo';

export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description?: string;
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  oldNumber?: number;
  newNumber?: number;
  content: string;
}

export interface CodeDiff {
  id: string;
  file: string;
  summary: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export interface SkillCall {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  params?: string;
  output?: string;
}

export interface FileOp {
  id: string;
  type: 'copy' | 'delete' | 'cut' | 'move';
  source: string;
  destination?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'requires_confirmation';
}

export interface WebSearch {
  id: string;
  query: string;
  status: 'searching' | 'completed' | 'failed';
  results?: Array<{ title: string; url: string; snippet: string }>;
}

export interface AskOption {
  id: string;
  label: string;
}

export interface AskForm {
  id: string;
  question: string;
  options?: AskOption[];
  allowMultiple?: boolean;
  requiresText?: boolean;
  status: 'pending' | 'answered' | 'skipped';
  answer?: {
    selectedOptions?: string[];
    text?: string;
  };
}

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'needs_user_input';

export interface ToolCall {
  id: string;
  name: string;
  /** 已解析的工具输入参数（JSON 对象）。 */
  input: unknown;
  status: ToolCallStatus;
  /** 工具执行输出，状态为 completed/failed 时存在。 */
  output?: string;
  /** 后端返回的结构化数据（如任务对象），可选。 */
  structured?: unknown;
}

export interface SearchOp {
  id: string;
  type: 'file' | 'code';
  query: string;
  status: 'searching' | 'completed' | 'failed';
  results?: Array<{ path: string; line?: number; match?: string }>;
}

export interface CodeReference {
  id: string;
  diffId: string;
  filePath: string;
  fileName: string;
  language: string;
  excerpt: string;
  selectionStart: number;
  selectionEnd: number;
  startLine: number;
  endLine: number;
}

export type UploadedResourceKind = 'image' | 'text' | 'pdf' | 'presentation' | 'document' | 'file';

export interface UploadedResource {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: UploadedResourceKind;
  dataUrl: string;
  textContent?: string;
}

export type ComposerDraftNode =
  | { type: 'text'; text: string }
  | { type: 'reference'; referenceId: string };

export type ComposerReferenceKind =
  | 'code'
  | 'file'
  | 'folder'
  | 'doc'
  | 'chat'
  | 'symbol'
  | 'rule'
  | 'problem'
  | 'web';

interface BaseComposerReference {
  id: string;
  kind: ComposerReferenceKind;
  label: string;
  detail?: string;
  description?: string;
}

export interface CodeComposerReference extends BaseComposerReference {
  kind: 'code';
  codeReference: CodeReference;
}

export interface ResourceComposerReference extends BaseComposerReference {
  kind: Exclude<ComposerReferenceKind, 'code'>;
  diffId?: string;
  filePath?: string;
  chatId?: string;
  url?: string;
  resource?: UploadedResource;
}

export type ComposerReference = CodeComposerReference | ResourceComposerReference;

export interface InsertChatPayload {
  text?: string;
  references?: ComposerReference[];
}

export interface BrowserSummaryChunk {
  id: string;
  type: 'text' | 'heading' | 'list' | 'quote' | 'code';
  level?: number;
  content: string;
}

export interface BrowserSummary {
  id: string;
  url: string;
  timestamp: number;
  chunks: BrowserSummaryChunk[];
  status: 'extracting' | 'completed' | 'failed';
  error?: string;
}

export interface TraceRecord {
  id: string;
  timestamp: number;
  chatId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    rawEvents: unknown[];
  };
  /** 后端→供应商 的上游请求和原始响应事件（仅在 traceUpstream 模式开启时填充） */
  upstream?: {
    request: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: unknown;
    };
    response: {
      rawEvents: unknown[];
    };
  };
}

export type ContentBlock =
  | { type: 'text', content: string }
  | { type: 'reasoning', content: string, status?: 'reasoning' | 'done', title?: string }
  | { type: 'tasks', tasks: Task[], id: string }
  | { type: 'diff', diff: CodeDiff }
  | { type: 'code_reference', reference: CodeReference }
  | { type: 'reference_list', references: ComposerReference[] }
  | { type: 'skill', skill: SkillCall }
  | { type: 'file_op', fileOp: FileOp }
  | { type: 'web_search', search: WebSearch }
  | { type: 'ask', ask: AskForm }
  | { type: 'search_op', searchOp: SearchOp }
  | { type: 'browser_summary', summary: BrowserSummary }
  | { type: 'tool_call', tool: ToolCall };

/** 消息的时序分段，保证按生成顺序渲染（reasoning → content → tool_calls 交替）。 */
export type MessageSegment =
  | { type: 'reasoning'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_calls'; calls: ToolCall[] };

export interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string;
  /** 推理/思考内容（所有轮次拼接），用于标题生成等。 */
  reasoning?: string;
  /** 推理标题，由标题生成服务填充。 */
  reasoningTitle?: string;
  /** 时序分段列表，按 streaming 实际到达顺序记录，用于渲染。 */
  segments?: MessageSegment[];
  rawResponse?: string;
  blocks?: ContentBlock[];
  status?: 'loading' | 'reasoning' | 'typing' | 'done';
  usage?: TokenUsage;
  /** Tool calls from assistant messages (OpenAI-native format). */
  toolCalls?: ToolCall[];
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  mode: ChatMode;
}

export interface AIModel {
  id: string;
  name: string;
  enabled: boolean;
  supportsMultimodal?: boolean;
}

export interface APIConfig {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyPreview: string;
  models: AIModel[];
  inputContextWindow: number;
  outputContextWindow: number;
}
