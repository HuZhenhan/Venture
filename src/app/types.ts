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
  | { type: 'browser_summary', summary: BrowserSummary };

export interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string; // Keep this as full content for simple rendering if needed
  rawResponse?: string;
  blocks?: ContentBlock[];
  status?: 'loading' | 'reasoning' | 'typing' | 'done';
  usage?: TokenUsage;
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
