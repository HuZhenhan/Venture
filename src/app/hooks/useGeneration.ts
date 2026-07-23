import { useCallback, useRef } from 'react';
import { useChatStore } from '../store/useChatStore';
import { useLayoutStore } from '../store/useLayoutStore';
import {
  appendContentDelta,
  appendReasoningDelta,
  finalizeMessage,
  updateMessageInList,
} from '../store/chatState';
import { Message } from '../types';
import { streamChat } from '../services/chatStreamService';
import { generateConversationTitle, generateReasoningTitle } from '../services/titleGenerationService';
import { buildChatMessageContentFromProtocol } from '../utils/codeReferences';
import {
  adaptLegacyMessageContent,
  appendVisibleContent,
  getThinkingText,
  getVisibleText,
  serializeError,
  setThinkingTitle,
} from '../utils/messageContentProtocol';
import { usePreferencesStore } from '../store/usePreferencesStore';

const DEFAULT_CHAT_TEMPERATURE = 0.8;

interface ResolvedModelSelection {
  provider: NonNullable<ReturnType<typeof useChatStore.getState>['apiConfigs'][number]>;
  model: NonNullable<ReturnType<typeof useChatStore.getState>['apiConfigs'][number]['models'][number]>;
}

function resolveEnabledModelSelection(
  apiConfigs: ReturnType<typeof useChatStore.getState>['apiConfigs'],
  modelId?: string,
): ResolvedModelSelection | null {
  for (const provider of apiConfigs) {
    const model = provider.models.find((item) => (
      item.enabled && (!modelId || item.id === modelId)
    ));

    if (model) {
      return { provider, model };
    }
  }

  return null;
}

function formatErrorContent(code: string, message: string): string {
  const suggestions = getErrorSuggestions(code)
    .split('\n')
    .map((suggestion) => suggestion.replace(/^•\s*/, '').trim())
    .filter(Boolean);
  return serializeError({
    code,
    message,
    suggestions,
    time: new Date().toLocaleTimeString('zh-CN'),
  });
}

function getErrorSuggestions(code: string): string {
  const suggestionMap: Record<string, string> = {
    'MODEL_NOT_FOUND': 
      `• 检查模型 ID 是否正确配置\n` +
      `• 确保在 YOLO → 设置 中启用了该模型\n` +
      `• 验证 API 供应商配置是否完整\n` +
      `• 确认模型在 API 供应商端是否存在`,
    
    'PROVIDER_NOT_FOUND':
      `• 在 YOLO → 设置 中添加 API 供应商\n` +
      `• 确保供应商名称和 API 密钥正确\n` +
      `• 验证 API 供应商的 Base URL 是否正确`,
    
    'UPSTREAM_AUTH_FAILED':
      `• 检查 API 密钥是否正确\n` +
      `• 验证 API 密钥是否过期或已失效\n` +
      `• 确认 API 密钥在上游服务中是否启用`,
    
    'UPSTREAM_TIMEOUT':
      `• 检查网络连接\n` +
      `• 上游服务可能响应缓慢，请稍后重试\n` +
      `• 尝试使用其他 API 供应商`,
    
    'UPSTREAM_RATE_LIMITED':
      `• 请等待片刻后重试\n` +
      `• 减少请求频率\n` +
      `• 考虑升级 API 配额`,
    
    'INVALID_PROVIDER_CONFIG':
      `• 检查 API 供应商配置\n` +
      `• 确保 Base URL 格式正确\n` +
      `• 验证所有必填字段已完整填写`,
    
    'UPSTREAM_STREAM_ERROR':
      `• 检查网络连接稳定性\n` +
      `• 上游服务可能出现问题，请稍后重试\n` +
      `• 查看 API 供应商的服务状态`,
    
    'CONFIG_DECRYPT_FAILED':
      `• 配置文件可能已损坏\n` +
      `• 尝试重新配置 API 供应商\n` +
      `• 联系技术支持`,
  };
  
  return suggestionMap[code] || '';
}

async function generateAndApplyTitles(chatId: string, messageId: string, modelId: string) {
  const preferences = usePreferencesStore.getState();
  const shouldGenerateConversationTitle = preferences.autoGenerateConversationTitles;
  const shouldGenerateReasoningTitle = preferences.autoGenerateReasoningTitles;

  if ((!shouldGenerateConversationTitle && !shouldGenerateReasoningTitle) || !modelId) {
    return;
  }

  const chat = useChatStore.getState().chats.find((item) => item.id === chatId);
  const aiMessage = chat?.messages.find((message) => message.id === messageId);
  if (!chat || !aiMessage || aiMessage.role !== 'ai') {
    return;
  }

  const normalizedContent = adaptLegacyMessageContent(aiMessage);
  const reasoning = getThinkingText(normalizedContent);
  const firstUserMessage = chat.messages.find((message) => message.role === 'user');
  const isFirstAssistantReply =
    chat.messages.filter((message) => message.role === 'user').length === 1 &&
    chat.messages.filter((message) => message.role === 'ai').length === 1;

  if (shouldGenerateReasoningTitle && reasoning) {
    generateReasoningTitle({
      modelId,
      reasoning,
      assistantMessage: getVisibleText(normalizedContent),
    })
      .then((title) => {
        if (!title) return;
        useChatStore.getState().updateChatMessages(chatId, (messages) =>
          messages.map((message) => {
            if (message.id !== messageId) return message;
            return {
              ...message,
              content: setThinkingTitle(adaptLegacyMessageContent(message), title),
            };
          })
        );
      })
      .catch(() => {});
  }

  if (shouldGenerateConversationTitle && isFirstAssistantReply && firstUserMessage) {
    generateConversationTitle({
      modelId,
      userMessage: firstUserMessage.content,
      assistantMessage: getVisibleText(normalizedContent),
    })
      .then((title) => {
        if (!title) return;
        const latestChat = useChatStore.getState().chats.find((item) => item.id === chatId);
        if (!latestChat) return;
        const stillFirstTurn =
          latestChat.messages.filter((message) => message.role === 'user').length === 1 &&
          latestChat.messages.filter((message) => message.role === 'ai').length === 1;
        if (stillFirstTurn && usePreferencesStore.getState().autoGenerateConversationTitles) {
          useChatStore.getState().renameChat(chatId, title);
        }
      })
      .catch(() => {});
  }
}

export function useGeneration() {
  const appendChatMessage = useChatStore((s) => s.appendChatMessage);
  const setGeneratingChatId = useChatStore((s) => s.setGeneratingChatId);
  const generationSession = useChatStore((s) => s.generationSession);
  const setGenerationSession = useChatStore((s) => s.setGenerationSession);
  const setCurrentTasks = useChatStore((s) => s.setCurrentTasks);
  const currentTasks = useChatStore((s) => s.currentTasks);
  const updateChatMessages = useChatStore((s) => s.updateChatMessages);
  const apiConfigs = useChatStore((s) => s.apiConfigs);

  const closePanel = useLayoutStore((s) => s.closePanel);
  const clearActiveDiff = useLayoutStore((s) => s.clearActiveDiff);

  const abortControllerRef = useRef<AbortController | null>(null);

  const updateMessageInChat = useCallback(
    (chatId: string, messageId: string, updater: (message: Message) => Message) => {
      updateChatMessages(chatId, (messages) => updateMessageInList(messages, messageId, updater));
    },
    [updateChatMessages]
  );

  const triggerAIResponse = useCallback(
    async (chatId: string, modelId?: string, options?: { continueMessageId?: string }) => {
      const isContinue = !!options?.continueMessageId;
      const aiMessageId = isContinue ? options!.continueMessageId! : crypto.randomUUID();

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setGenerationSession({ chatId, messageId: aiMessageId });
      setGeneratingChatId(chatId);
      setCurrentTasks([]);
      closePanel('editor');
      clearActiveDiff();

      if (!isContinue) {
        const placeholderMessage: Message = {
          id: aiMessageId,
          role: 'ai',
          content: '',
          blocks: [],
          status: 'loading',
        };
        appendChatMessage(chatId, placeholderMessage);
      } else {
        // For continue mode: set the existing message to 'reasoning' status
        updateMessageInChat(chatId, aiMessageId, (msg) => ({
          ...msg,
          status: 'reasoning' as const,
        }));
      }

      const chats = useChatStore.getState().chats;
      const chat = chats.find((c) => c.id === chatId);
      if (!chat) {
        setGeneratingChatId(null);
        setGenerationSession(null);
        return;
      }

      const modelSelection = resolveEnabledModelSelection(apiConfigs, modelId);
      const activeProvider = modelSelection?.provider;
      const activeModel = modelSelection?.model;
      const resolvedModelId = activeModel?.id;
      const contextWindow = activeProvider?.inputContextWindow ?? 20;

      if (!activeProvider || !activeModel || !resolvedModelId) {
        const errorContent = formatErrorContent('MODEL_NOT_FOUND', '未找到可用模型，请在设置中启用一个模型。');
        updateMessageInChat(chatId, aiMessageId, (message) => ({
          ...message,
          content: appendVisibleContent(message.content, errorContent),
          status: 'done' as const,
        }));
        setGeneratingChatId(null);
        setGenerationSession(null);
        return;
      }

      const historyMessages = chat.messages
        .filter((message) => message.id !== aiMessageId)
        .map((message) => {
          const content = adaptLegacyMessageContent(message);
          return {
            role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
            content: buildChatMessageContentFromProtocol(
              content,
              message.role === 'user' && (activeModel.supportsMultimodal ?? false),
            ),
          };
        });

      try {
        await streamChat(
          {
            modelId: resolvedModelId,
            providerId: activeProvider.id,
            messages: historyMessages,
            contextWindow,
            temperature: DEFAULT_CHAT_TEMPERATURE,
          },
          (event) => {
            if (controller.signal.aborted) return;

            if (event.event === 'message_start') {
              if (!isContinue) {
                updateMessageInChat(chatId, aiMessageId, (msg) => ({
                  ...msg,
                  status: 'reasoning' as const,
                }));
              }
            } else if (event.event === 'reasoning_delta') {
              updateChatMessages(chatId, (msgs) =>
                appendReasoningDelta(msgs, aiMessageId, event.data.delta)
              );
            } else if (event.event === 'content_delta') {
              updateChatMessages(chatId, (msgs) =>
                appendContentDelta(msgs, aiMessageId, event.data.delta)
              );
            } else if (event.event === 'message_done') {
              updateChatMessages(chatId, (msgs) =>
                finalizeMessage(msgs, aiMessageId).map((msg) =>
                  msg.id === aiMessageId ? { ...msg, usage: event.data.usage ?? undefined } : msg
                )
              );
              if (!isContinue) {
                void generateAndApplyTitles(chatId, aiMessageId, resolvedModelId);
              }
              setGeneratingChatId(null);
              setGenerationSession(null);
            } else if (event.event === 'error') {
              const errorContent = formatErrorContent(event.data.code, event.data.message);
              updateMessageInChat(chatId, aiMessageId, (message) => ({
                ...message,
                content: appendVisibleContent(message.content, errorContent),
                status: 'done' as const,
              }));
              setGeneratingChatId(null);
              setGenerationSession(null);
            }
          },
          controller.signal
        );
      } catch {
        if (!controller.signal.aborted) {
          const errorContent = formatErrorContent(
            'BACKEND_UNAVAILABLE',
            '无法连接到后端服务，请确认 Rust 后端已启动。',
          );
          updateMessageInChat(chatId, aiMessageId, (message) => ({
            ...message,
            content: appendVisibleContent(message.content, errorContent),
            status: 'done' as const,
          }));
          setGeneratingChatId(null);
          setGenerationSession(null);
        }
      }
    },
    [
      appendChatMessage,
      clearActiveDiff,
      closePanel,
      setCurrentTasks,
      setGeneratingChatId,
      setGenerationSession,
      updateChatMessages,
      updateMessageInChat,
      apiConfigs,
    ]
  );

  const handleConfirmFileOp = useCallback(
    (_chatId: string, _aiMessageId: string, _fileOpId: string) => {
    },
    []
  );

  const handleRejectFileOp = useCallback(
    (_chatId: string, _aiMessageId: string, _fileOpId: string) => {
      setGeneratingChatId(null);
      setGenerationSession(null);
    },
    [setGeneratingChatId, setGenerationSession]
  );

  const handleStopGeneration = useCallback(() => {
    if (!generationSession) return;

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    const session = generationSession;
    setGenerationSession(null);
    setCurrentTasks(currentTasks.map((t) =>
      t.status === 'running' ? { ...t, status: 'failed' as const } : t
    ));
    setGeneratingChatId(null);

    updateChatMessages(session.chatId, (msgs) =>
      finalizeMessage(msgs, session.messageId)
    );
  }, [
    currentTasks,
    generationSession,
    setCurrentTasks,
    setGeneratingChatId,
    setGenerationSession,
    updateChatMessages,
  ]);

  return {
    triggerAIResponse,
    handleConfirmFileOp,
    handleRejectFileOp,
    handleStopGeneration,
  };
}
