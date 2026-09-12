import { getBackendBaseUrl, BackendRequestError } from './backendClient';
import type { TokenUsage } from '../types';
import { debugWarn } from '../utils/debugLogger';

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessageContent = string | ChatMessageContentPart[];

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: ChatMessageContent;
  /** DeepSeek 思考模式要求的 reasoning_content 回传字段 */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface StreamChatParams {
  chatId?: string;
  turnMessageId?: string;
  assistantMessageId?: string;
  modelId: string;
  providerId?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 开启后端→供应商上游追踪，后端将在 message_done 中附带 upstream_trace */
  traceUpstream?: boolean;
}

export interface UpstreamTrace {
  request: { url: string; method: string; headers: Record<string, string>; body: unknown };
  events: unknown[];
  upstream_error?: { status?: number; body?: string };
}

interface ChatStreamEventBase {
  schema_version: number;
  chat_id: string;
  turn_message_id: string;
  sequence?: number;
}

export type ChatStreamEvent =
  | (ChatStreamEventBase & { event: 'message_start'; data: Record<string, never> })
  | (ChatStreamEventBase & { event: 'reasoning_delta'; data: { delta: string } })
  | (ChatStreamEventBase & { event: 'content_delta'; data: { delta: string } })
  | (ChatStreamEventBase & { event: 'tool_call_start'; data: { index: number; id: string; name: string } })
  | (ChatStreamEventBase & { event: 'tool_call_delta'; data: { index: number; id?: string; name?: string; arguments?: string } })
  | (ChatStreamEventBase & { event: 'message_done'; data: { usage?: UsageInfo | null; upstream_trace?: UpstreamTrace } })
  | (ChatStreamEventBase & { event: 'error'; data: { code: string; message: string; upstream_trace?: UpstreamTrace } });

export type StreamEvent = ChatStreamEvent;

export type UsageInfo = TokenUsage;

export type StreamEventCallback = (event: StreamEvent) => void;

export interface TraceCallback {
  onRequest: (body: unknown) => void;
  onResponseEvent: (rawEvent: unknown) => void;
}

export interface StreamHandle {
  abort: () => void;
}

interface SseFrame {
  event?: string;
  data: string;
}

const KNOWN_EVENTS = new Set<ChatStreamEvent['event']>([
  'message_start',
  'reasoning_delta',
  'content_delta',
  'tool_call_start',
  'tool_call_delta',
  'message_done',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === 'string') headers[key] = headerValue;
  }
  return headers;
}

function parseUpstreamTrace(value: unknown): UpstreamTrace | undefined {
  if (!isRecord(value) || !isRecord(value.request)) return undefined;
  const request = value.request;
  const trace: UpstreamTrace = {
    request: {
      url: stringValue(request, 'url') ?? '',
      method: stringValue(request, 'method') ?? 'POST',
      headers: parseHeaders(request.headers),
      body: request.body,
    },
    events: Array.isArray(value.events) ? value.events : [],
  };
  if (isRecord(value.upstream_error)) {
    trace.upstream_error = {
      status: numberValue(value.upstream_error, 'status'),
      body: stringValue(value.upstream_error, 'body'),
    };
  }
  return trace;
}

function parseUsageInfo(value: unknown): UsageInfo | null | undefined {
  if (value == null) return value;
  if (!isRecord(value)) return undefined;
  const usage: UsageInfo = {};
  const keys: Array<Exclude<keyof UsageInfo, 'prompt_tokens_details'>> = [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
  ];
  for (const key of keys) {
    const parsed = numberValue(value, key);
    if (parsed !== undefined) usage[key] = parsed;
  }
  if (isRecord(value.prompt_tokens_details)) {
    const cachedTokens = numberValue(value.prompt_tokens_details, 'cached_tokens');
    if (cachedTokens !== undefined) usage.prompt_tokens_details = { cached_tokens: cachedTokens };
  }
  return usage;
}

function parseHttpErrorBody(value: unknown): { code: string; message: string } | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  return {
    code: stringValue(value.error, 'code') ?? 'UPSTREAM_STREAM_ERROR',
    message: stringValue(value.error, 'message') ?? 'HTTP error',
  };
}

function protocolError(
  code: string,
  message: string,
  defaults: Pick<ChatStreamEventBase, 'chat_id' | 'turn_message_id'>,
): ChatStreamEvent {
  return {
    event: 'error',
    schema_version: 1,
    chat_id: defaults.chat_id,
    turn_message_id: defaults.turn_message_id,
    data: { code, message },
  };
}

function normalizeStreamEvent(
  raw: unknown,
  frameEvent: string | undefined,
  defaults: Pick<ChatStreamEventBase, 'chat_id' | 'turn_message_id'>,
): ChatStreamEvent {
  if (!isRecord(raw)) throw new Error('SSE payload must be a JSON object');

  const eventName = frameEvent ?? stringValue(raw, 'event') ?? stringValue(raw, 'type');
  if (!eventName || !KNOWN_EVENTS.has(eventName as ChatStreamEvent['event'])) {
    throw new Error(`Unknown SSE event: ${eventName ?? '(missing)'}`);
  }
  const payloadEvent = stringValue(raw, 'event');
  if (frameEvent && payloadEvent && frameEvent !== payloadEvent) {
    debugWarn('sse', 'event name mismatch', { frameEvent, payloadEvent });
  }

  const data = isRecord(raw.data) ? raw.data : {};
  const sequence = numberValue(raw, 'sequence');
  const base: ChatStreamEventBase = {
    schema_version: numberValue(raw, 'schema_version') ?? 0,
    chat_id: stringValue(raw, 'chat_id') ?? defaults.chat_id,
    turn_message_id: stringValue(raw, 'turn_message_id') ?? defaults.turn_message_id,
    ...(sequence !== undefined ? { sequence } : {}),
  };

  switch (eventName) {
    case 'message_start':
      return { ...base, event: 'message_start', data: {} };
    case 'reasoning_delta': {
      const delta = stringValue(data, 'delta');
      if (delta === undefined) throw new Error('reasoning_delta.data.delta must be a string');
      return { ...base, event: 'reasoning_delta', data: { delta } };
    }
    case 'content_delta': {
      const delta = stringValue(data, 'delta');
      if (delta === undefined) throw new Error('content_delta.data.delta must be a string');
      return { ...base, event: 'content_delta', data: { delta } };
    }
    case 'tool_call_start': {
      const index = numberValue(data, 'index');
      const id = stringValue(data, 'id');
      const name = stringValue(data, 'name');
      if (index === undefined || id === undefined || name === undefined) {
        throw new Error('tool_call_start requires numeric index, string id and string name');
      }
      return { ...base, event: 'tool_call_start', data: { index, id, name } };
    }
    case 'tool_call_delta': {
      const index = numberValue(data, 'index');
      const id = stringValue(data, 'id');
      const name = stringValue(data, 'name');
      const args = stringValue(data, 'arguments');
      if (index === undefined) throw new Error('tool_call_delta.data.index must be a number');
      return {
        ...base,
        event: 'tool_call_delta',
        data: {
          index,
          ...(id !== undefined ? { id } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(args !== undefined ? { arguments: args } : {}),
        },
      };
    }
    case 'message_done': {
      const upstreamTrace = parseUpstreamTrace(data.upstream_trace);
      return {
        ...base,
        event: 'message_done',
        data: {
          usage: parseUsageInfo(data.usage),
          ...(upstreamTrace ? { upstream_trace: upstreamTrace } : {}),
        },
      };
    }
    case 'error': {
      const upstreamTrace = parseUpstreamTrace(data.upstream_trace);
      return {
        ...base,
        event: 'error',
        data: {
          code: stringValue(data, 'code') ?? 'UPSTREAM_STREAM_ERROR',
          message: stringValue(data, 'message') ?? 'stream returned an error event',
          ...(upstreamTrace ? { upstream_trace: upstreamTrace } : {}),
        },
      };
    }
  }
}

function parseSseBlock(block: string): SseFrame | null {
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const rawLine of block.split('\n')) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colonIdx = rawLine.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      field = rawLine;
      value = '';
    } else {
      field = rawLine.slice(0, colonIdx);
      value = rawLine.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'event') {
      event = value;
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

function dispatchFrame(
  frame: SseFrame,
  onEvent: StreamEventCallback,
  defaults: Pick<ChatStreamEventBase, 'chat_id' | 'turn_message_id'>,
  trace?: TraceCallback,
): boolean {
  const trimmed = frame.data.trim();
  if (trimmed === '[DONE]') return true;
  if (!trimmed) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const evt = normalizeStreamEvent(parsed, frame.event, defaults);
    // Record raw response event before processing
    trace?.onResponseEvent(evt);
    onEvent(evt);
    if (evt.event === 'message_done' || evt.event === 'error') return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugWarn('sse', 'failed to parse stream frame', { message, frameEvent: frame.event, data: trimmed });
    onEvent(protocolError('STREAM_PARSE_ERROR', message, defaults));
    return true;
  }
  return false;
}

export async function streamChat(
  params: StreamChatParams,
  onEvent: StreamEventCallback,
  signal?: AbortSignal,
  trace?: TraceCallback,
): Promise<void> {
  const base = await getBackendBaseUrl();
  const body: Record<string, unknown> = {
    chatId: params.chatId,
    turnMessageId: params.turnMessageId,
    assistantMessageId: params.assistantMessageId,
    modelId: params.modelId,
    providerId: params.providerId,
    messages: params.messages,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
  };
  if (params.traceUpstream) {
    body.traceUpstream = true;
  }

  // Record raw request before sending
  if (trace) {
    console.log('[Trace] onRequest called, body keys:', Object.keys(body));
    trace.onRequest(body);
  } else {
    console.log('[Trace] No trace callback provided to streamChat');
  }

  let res: Response;
  try {
    res = await fetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    throw new BackendRequestError({
      code: 'BACKEND_NOT_READY',
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    });
  }

  if (!res.ok) {
    let code = 'UPSTREAM_STREAM_ERROR';
    let message = `HTTP ${res.status}`;
    try {
      const parsed: unknown = await res.json();
      const parsedError = parseHttpErrorBody(parsed);
      if (parsedError) ({ code, message } = parsedError);
    } catch { }
    onEvent(protocolError(code, message, { chat_id: params.chatId ?? '', turn_message_id: params.turnMessageId ?? '' }));
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    onEvent(protocolError('UPSTREAM_STREAM_ERROR', 'no response body', { chat_id: params.chatId ?? '', turn_message_id: params.turnMessageId ?? '' }));
    return;
  }

  const defaults = { chat_id: params.chatId ?? '', turn_message_id: params.turnMessageId ?? '' };
  onEvent({ event: 'message_start', schema_version: 1, ...defaults, data: {} });

  const decoder = new TextDecoder();
  let buffer = '';
  let doneSeen = false;

  const consumeBlock = (block: string): boolean => {
    const frame = parseSseBlock(block);
    if (!frame) return false;
    return dispatchFrame(frame, onEvent, defaults, trace);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const nlnl = buffer.indexOf('\n\n');
        const rnrn = buffer.indexOf('\r\n\r\n');
        let idx = -1;
        let sepLen = 0;
        if (nlnl !== -1 && (rnrn === -1 || nlnl < rnrn)) {
          idx = nlnl;
          sepLen = 2;
        } else if (rnrn !== -1) {
          idx = rnrn;
          sepLen = 4;
        }
        if (idx === -1) break;

        const block = buffer.slice(0, idx).replace(/\r\n/g, '\n');
        buffer = buffer.slice(idx + sepLen);
        if (consumeBlock(block)) {
          doneSeen = true;
          return;
        }
      }
    }

    // Flush trailing bytes
    buffer += decoder.decode();
    const tail = buffer.replace(/\r\n/g, '\n').trim();
    if (tail.length > 0) {
      if (consumeBlock(tail)) doneSeen = true;
    }

    if (!doneSeen) {
      onEvent({ event: 'message_done', schema_version: 1, ...defaults, data: { usage: null } });
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    onEvent(protocolError('UPSTREAM_STREAM_ERROR', String(err), defaults));
  } finally {
    try { reader.releaseLock(); } catch { }
  }
}
