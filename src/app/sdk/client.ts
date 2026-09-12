import { VentureApiError } from './errors';
import type {
  AddProviderRequest,
  ChangeRecordSummary,
  ExecuteToolRequest,
  ExecuteToolResult,
  FileChangesQuery,
  SkillListResult,
  StreamChatRequest,
  StreamEvent,
  UpdateProviderRequest,
  VentureHealth,
  VentureProvider,
} from './types';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type BaseUrlResolver = string | (() => string | Promise<string>);
export type StreamEventHandler = (event: StreamEvent) => void;

export interface VentureClientOptions {
  baseUrl: BaseUrlResolver;
  fetchImpl?: FetchLike;
}

interface SseFrame {
  event?: string;
  data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readErrorPayload(payload: unknown): { code?: string; message?: string; trace?: unknown } | null {
  if (!isRecord(payload)) return null;
  const error = payload.error;
  if (!isRecord(error)) return null;
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    message: typeof error.message === 'string' ? error.message : undefined,
    trace: error.trace,
  };
}

function parseSseBlock(block: string): SseFrame | null {
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const rawLine of block.split('\n')) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colonIdx = rawLine.indexOf(':');
    const field = colonIdx === -1 ? rawLine : rawLine.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : rawLine.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    if (field === 'event') event = value;
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export class VentureClient {
  private readonly baseUrl: BaseUrlResolver;
  private readonly fetchImpl: FetchLike;

  constructor(options: VentureClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async health(): Promise<VentureHealth> {
    return this.request<VentureHealth>('GET', '/api/health');
  }

  async listProviders(): Promise<VentureProvider[]> {
    const result = await this.request<{ providers: VentureProvider[] }>('GET', '/api/providers');
    return result.providers;
  }

  async addProvider(params: AddProviderRequest): Promise<VentureProvider> {
    const result = await this.request<{ provider: VentureProvider }>('POST', '/api/providers', params);
    return result.provider;
  }

  async updateProvider(id: string, params: UpdateProviderRequest): Promise<VentureProvider> {
    const result = await this.request<{ provider: VentureProvider }>(
      'PATCH',
      `/api/providers/${encodeURIComponent(id)}`,
      params,
    );
    return result.provider;
  }

  async deleteProvider(id: string): Promise<void> {
    await this.request<{ success: boolean }>('DELETE', `/api/providers/${encodeURIComponent(id)}`);
  }

  async streamChat(
    params: StreamChatRequest,
    onEvent: StreamEventHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchRaw('POST', '/api/chat/stream', params, signal, 'text/event-stream');
    if (!response.ok) throw await this.toApiError(response);

    const reader = response.body?.getReader();
    if (!reader) {
      throw new VentureApiError({
        status: response.status,
        code: 'STREAM_BODY_UNAVAILABLE',
        message: 'Chat stream response body is unavailable.',
      });
    }

    onEvent({ event: 'message_start' });
    await this.readSse(reader, onEvent);
  }

  async executeTool(params: ExecuteToolRequest): Promise<ExecuteToolResult> {
    return this.request<ExecuteToolResult>('POST', '/api/tools/execute', {
      tool: params.tool,
      input: params.input ?? {},
      chatId: params.chatId,
      ...(params.turnMessageId ? { turnMessageId: params.turnMessageId } : {}),
      ...(params.modelId ? { modelId: params.modelId } : {}),
    });
  }

  async getFileChanges(params: FileChangesQuery): Promise<ChangeRecordSummary[]> {
    const query = new URLSearchParams();
    if (params.turnId) query.set('turnId', params.turnId);
    if (params.path) query.set('path', params.path);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const result = await this.request<{ changes: ChangeRecordSummary[] }>('GET', `/api/files/changes${suffix}`);
    return result.changes;
  }

  async listSkills(): Promise<SkillListResult> {
    return this.request<SkillListResult>('GET', '/api/skills');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchRaw(method, path, body);
    if (!response.ok) throw await this.toApiError(response);
    return response.json() as Promise<T>;
  }

  private async fetchRaw(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    accept?: string,
  ): Promise<Response> {
    const baseUrl = await this.resolveBaseUrl();
    try {
      return await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: accept ?? 'application/json',
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error: unknown) {
      throw new VentureApiError({
        status: null,
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : String(error),
        trace: error,
      });
    }
  }

  private async resolveBaseUrl(): Promise<string> {
    const value = typeof this.baseUrl === 'function' ? await this.baseUrl() : this.baseUrl;
    return value.replace(/\/$/, '');
  }

  private async toApiError(response: Response): Promise<VentureApiError> {
    let trace: unknown;
    try {
      trace = await response.json();
      const payload = readErrorPayload(trace);
      if (payload) {
        return new VentureApiError({
          status: response.status,
          code: payload.code ?? `HTTP_${response.status}`,
          message: payload.message ?? response.statusText,
          trace: payload.trace ?? trace,
        });
      }
    } catch {
      trace = undefined;
    }

    return new VentureApiError({
      status: response.status,
      code: `HTTP_${response.status}`,
      message: response.statusText || `HTTP ${response.status}`,
      trace,
    });
  }

  private async readSse(reader: ReadableStreamDefaultReader<Uint8Array>, onEvent: StreamEventHandler): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const consumed = this.consumeSseBuffer(buffer, onEvent);
        if (consumed.done) return;
        buffer = consumed.remaining;
      }
      buffer += decoder.decode();
      const tail = buffer.replace(/\r\n/g, '\n').trim();
      if (tail) this.dispatchSseBlock(tail, onEvent);
    } finally {
      reader.releaseLock();
    }
  }

  private consumeSseBuffer(buffer: string, onEvent: StreamEventHandler): { remaining: string; done: boolean } {
    let remaining = buffer;
    for (;;) {
      const nlnl = remaining.indexOf('\n\n');
      const rnrn = remaining.indexOf('\r\n\r\n');
      const hasLf = nlnl !== -1;
      const hasCrLf = rnrn !== -1;
      if (!hasLf && !hasCrLf) return { remaining, done: false };
      const useLf = hasLf && (!hasCrLf || nlnl < rnrn);
      const idx = useLf ? nlnl : rnrn;
      const sepLen = useLf ? 2 : 4;
      const block = remaining.slice(0, idx).replace(/\r\n/g, '\n');
      remaining = remaining.slice(idx + sepLen);
      if (this.dispatchSseBlock(block, onEvent)) return { remaining, done: true };
    }
  }

  private dispatchSseBlock(block: string, onEvent: StreamEventHandler): boolean {
    const frame = parseSseBlock(block);
    if (!frame) return false;
    const trimmed = frame.data.trim();
    if (trimmed === '[DONE]') return true;
    if (!trimmed) return false;
    try {
      const event = JSON.parse(trimmed) as StreamEvent;
      onEvent(event);
      return event.event === 'message_done' || event.event === 'error';
    } catch {
      return false;
    }
  }
}
