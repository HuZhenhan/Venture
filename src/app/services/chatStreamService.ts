import { getBackendBaseUrl, BackendRequestError } from './backendClient';
import type { TokenUsage } from '../types';

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
  modelId: string;
  providerId?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 开启后端→供应商上游追踪，后端将在 message_done 中附带 upstream_trace */
  traceUpstream?: boolean;
}

export type StreamEvent =
  | { event: 'message_start' }
  | { event: 'reasoning_delta'; data: { delta: string } }
  | { event: 'content_delta'; data: { delta: string } }
  | { event: 'tool_call_start'; data: { index: number; id: string; name: string } }
  | { event: 'tool_call_delta'; data: { index: number; arguments: string } }
  | { event: 'message_done'; data: { usage?: UsageInfo | null; upstream_trace?: { request: { url: string; method: string; headers: Record<string, string>; body: unknown }; events: unknown[] } } }
  | { event: 'error'; data: { code: string; message: string } };

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

function dispatchFrame(frame: SseFrame, onEvent: StreamEventCallback, trace?: TraceCallback): boolean {
  const trimmed = frame.data.trim();
  if (trimmed === '[DONE]') return true;
  if (!trimmed) return false;
  try {
    const evt = JSON.parse(trimmed) as StreamEvent;
    // Record raw response event before processing
    trace?.onResponseEvent(evt);
    onEvent(evt);
    if (evt.event === 'message_done' || evt.event === 'error') return true;
  } catch {
    // ignore malformed json
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
      const json = await res.json();
      if (json?.error) { code = json.error.code; message = json.error.message; }
    } catch { }
    onEvent({ event: 'error', data: { code, message } });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    onEvent({ event: 'error', data: { code: 'UPSTREAM_STREAM_ERROR', message: 'no response body' } });
    return;
  }

  onEvent({ event: 'message_start' });

  const decoder = new TextDecoder();
  let buffer = '';
  let doneSeen = false;

  const consumeBlock = (block: string): boolean => {
    const frame = parseSseBlock(block);
    if (!frame) return false;
    return dispatchFrame(frame, onEvent, trace);
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
      onEvent({ event: 'message_done', data: { usage: null } });
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    onEvent({ event: 'error', data: { code: 'UPSTREAM_STREAM_ERROR', message: String(err) } });
  } finally {
    try { reader.releaseLock(); } catch { }
  }
}
