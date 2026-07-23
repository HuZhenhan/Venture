import { Chat, Message } from '../types';
import {
  appendThinkingContent,
  appendVisibleContent,
  closeOpenThinking,
  keepFirstThinkingPair,
} from '../utils/messageContentProtocol';

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

export function appendReasoningDelta(
  messages: Message[],
  messageId: string,
  delta: string
): Message[] {
  return updateMessageInList(messages, messageId, (message) => ({
    ...message,
    content: appendThinkingContent(message.content, delta),
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
    content: appendVisibleContent(message.content, delta),
    rawResponse: `${message.rawResponse ?? ''}${delta}`,
    status: 'typing' as const,
  }));
}

export function finalizeMessage(
  messages: Message[],
  messageId: string
): Message[] {
  return updateMessageInList(messages, messageId, (message) => ({
    ...message,
    content: keepFirstThinkingPair(closeOpenThinking(message.content)),
    status: 'done' as const,
  }));
}