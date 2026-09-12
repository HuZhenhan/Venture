import { backendGet } from './backendClient';
import type { TokenUsage } from '../types';

export type SessionEventKind =
  | { type: 'userMessageCreated'; messageId: string; contentPreview?: string }
  | { type: 'assistantStreamStarted'; messageId: string; modelId: string; providerId?: string }
  | { type: 'reasoningDelta'; messageId: string; delta: string }
  | { type: 'contentDelta'; messageId: string; delta: string }
  | { type: 'toolCallStarted'; messageId: string; index: number; toolCallId: string; name: string }
  | { type: 'toolCallFinished'; messageId: string; toolCallId: string; status: 'completed' | 'failed'; output: string }
  | { type: 'turnCompleted'; assistantMessageId: string; usage?: TokenUsage | null }
  | { type: 'turnFailed'; assistantMessageId: string; code: string; message: string }
  | { type: 'turnCancelled'; assistantMessageId: string; reason: string };

export interface SessionEvent {
  id: string;
  chatId: string;
  turnId: string;
  createdAt: number;
  event: SessionEventKind;
}

export interface SessionEventsResponse {
  events: SessionEvent[];
}

export async function getSessionEvents(chatId: string): Promise<SessionEvent[]> {
  if (!chatId.trim()) return [];
  const response = await backendGet<SessionEventsResponse>(
    `/api/sessions/${encodeURIComponent(chatId)}/events`,
  );
  return response.events;
}
