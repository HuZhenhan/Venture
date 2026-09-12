import { Chat, Message, MessageSegment, ToolCall } from '../types';
import { appendThinkingContent, appendVisibleContent } from '../utils/messageContentProtocol';

export function updateChatEntry(
  chats: Chat[],
  chatId: string,
  updater: (chat: Chat) => Chat
): Chat[] {
  let didUpdate = false;

  const nextChats = chats.map((chat) => {
    if (chat.id !== chatId) {
      return chat;
    }

    didUpdate = true;
    return updater(chat);
  });

  return didUpdate ? nextChats : chats;
}

export function updateChatMessagesInList(
  chats: Chat[],
  chatId: string,
  updater: (messages: Message[]) => Message[]
): Chat[] {
  return updateChatEntry(chats, chatId, (chat) => ({
    ...chat,
    messages: updater(chat.messages),
  }));
}

export function appendMessageToChat(chats: Chat[], chatId: string, message: Message): Chat[] {
  return updateChatMessagesInList(chats, chatId, (messages) => [...messages, message]);
}

export function updateMessageInList(
  messages: Message[],
  messageId: string,
  updater: (message: Message) => Message
): Message[] {
  return messages.map((message) => (message.id === messageId ? updater(message) : message));
}

/**
 * 将 delta 追加到 segments 末尾的同类型分段；若末尾类型不同则新建分段。
 */
function appendToSegment(
  segments: MessageSegment[],
  type: 'reasoning' | 'content',
  delta: string,
): MessageSegment[] {
  const last = segments[segments.length - 1];
  if (last?.type === type) {
    return [...segments.slice(0, -1), { ...last, content: last.content + delta }];
  }
  return [...segments, { type, content: delta }];
}

export function appendReasoningDelta(
  messages: Message[],
  messageId: string,
  delta: string
): Message[] {
  return updateMessageInList(messages, messageId, (message) => ({
    ...message,
    content: appendThinkingContent(message.content, delta),
    segments: appendToSegment(message.segments ?? [], 'reasoning', delta),
    rawResponse: `${message.rawResponse ?? ''}${delta}`,
    status: 'reasoning' as const,
  }));
}

export function appendContentDelta(
  messages: Message[],
  messageId: string,
  delta: string
): Message[] {
  return updateMessageInList(messages, messageId, (message) => ({
    ...message,
    segments: appendToSegment(message.segments ?? [], 'content', delta),
    content: appendVisibleContent(message.content, delta),
    rawResponse: `${message.rawResponse ?? ''}${delta}`,
    status: 'typing' as const,
  }));
}

/**
 * 在 message_done 时将本轮新增的 tool calls 作为 tool_calls 分段追加到 segments。
 */
export function appendToolCallSegments(
  messages: Message[],
  messageId: string,
  newCalls: ToolCall[],
): Message[] {
  return updateMessageInList(messages, messageId, (message) => {
    if (newCalls.length === 0) return message;
    const toolSeg: MessageSegment = { type: 'tool_calls', calls: newCalls };
    return { ...message, segments: [...(message.segments ?? []), toolSeg] };
  });
}

export function finalizeMessage(
  messages: Message[],
  messageId: string
): Message[] {
  return updateMessageInList(messages, messageId, (message) => ({
    ...message,
    status: 'done' as const,
  }));
}
