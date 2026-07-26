import { useCallback, useRef } from 'react';
import { useChatStore } from '../store/useChatStore';
import { useLayoutStore } from '../store/useLayoutStore';
import {
  appendContentDelta,
  appendReasoningDelta,
  appendToolCallSegments,
  finalizeMessage,
  updateMessageInList,
} from '../store/chatState';
import { Message, ToolCall, ToolCallStatus, TraceRecord } from '../types';
import { streamChat, ChatMessage, TraceCallback } from '../services/chatStreamService';
import { generateConversationTitle, generateReasoningTitle } from '../services/titleGenerationService';
import { buildChatMessageContentFromProtocol } from '../utils/codeReferences';
import {
  adaptLegacyMessageContent,
  getThinkingText,
  getVisibleText,
  serializeError,
} from '../utils/messageContentProtocol';
import { executeTool } from '../services/toolService';
import { usePreferencesStore } from '../store/usePreferencesStore';

const DEFAULT_CHAT_TEMPERATURE = 0.8;
/// Agent 工具循环最大迭代次数，防止模型陷入无限工具调用。
const MAX_TOOL_ITERATIONS = 15;

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
  const reasoning = aiMessage.reasoning || getThinkingText(normalizedContent);
  const firstUserMessage = chat.messages.find((message) => message.role === 'user');
  const isFirstAssistantReply =
    chat.messages.filter((message) => message.role === 'user').length === 1 &&
    chat.messages.filter((message) => message.role === 'ai').length === 1;

  if (shouldGenerateReasoningTitle && reasoning) {
    generateReasoningTitle({
      modelId,
      reasoning,
      assistantMessage: aiMessage.reasoning != null ? aiMessage.content : getVisibleText(normalizedContent),
    })
      .then((title) => {
        if (!title) return;
        useChatStore.getState().updateChatMessages(chatId, (messages) =>
          messages.map((message) => {
            if (message.id !== messageId) return message;
            return {
              ...message,
              reasoningTitle: title,
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
      assistantMessage: aiMessage.reasoning != null ? aiMessage.content : getVisibleText(normalizedContent),
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
  // tracedChatId / addTraceRecord 通过 useChatStore.getState() 在 triggerAIResponse 内读取，
  // 此处不订阅，避免 tracedChatId 变化引发 useGeneration 重新计算但 triggerAIResponse 不更新（不在依赖数组）的误解。

  const closePanel = useLayoutStore((s) => s.closePanel);
  const clearActiveDiff = useLayoutStore((s) => s.clearActiveDiff);

  const abortControllerRef = useRef<AbortController | null>(null);
  /// Agent 工具循环迭代计数。每次新一轮（非 continue）生成时重置。
  const toolLoopIterationRef = useRef(0);
  /// 持有 triggerAIResponse 的引用，供 runToolLoop 继续生成时调用，打破循环依赖。
  const triggerRef = useRef<((chatId: string, modelId?: string, options?: { continueMessageId?: string }) => void) | null>(null);
  /// 流式 tool_call delta 累积器：按 index 累积 id/name/arguments。
  const toolCallAccumulator = useRef<Map<number, { id: string; name: string; arguments: string }>>(new Map());
  /// runToolLoop 并发锁序号：每次新调用递增，用于防止旧的 runToolLoop 覆盖新状态。
  const toolLoopSeqRef = useRef(0);

  const updateMessageInChat = useCallback(
    (chatId: string, messageId: string, updater: (message: Message) => Message) => {
      updateChatMessages(chatId, (messages) => updateMessageInList(messages, messageId, updater));
    },
    [updateChatMessages]
  );

  /**
   * Agent 工具执行循环。
   *
   * 流程：
   * 1. 读取当前消息内容，提取 status=pending 的工具调用；
   * 2. 若无 pending 工具或已达迭代上限 → 收尾（标题生成 + 解除 generating 状态）；
   * 3. 逐个执行 pending 工具：先置 running，调用后端执行，再置 completed/failed 并回填 output；
   * 4. 全部执行完毕后，以 continue 模式重新触发 AI 响应，让模型读取工具结果继续生成。
   *
   * 迭代上限 MAX_TOOL_ITERATIONS 防止模型陷入无限工具调用。
   */
  const runToolLoop = useCallback(
    async (chatId: string, messageId: string, modelId: string, isContinue: boolean) => {
      // 获取本实例的唯一序号，用于 cancelation token 模式：外部（handleStopGeneration、
      // 新一轮 triggerAIResponse）可通过递增 toolLoopSeqRef 使旧实例跳过 continue 和清理。
      const mySeq = ++toolLoopSeqRef.current;

      const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
      const message = chat?.messages.find((m) => m.id === messageId);

      if (!message) {
        setGeneratingChatId(null);
        setGenerationSession(null);
        return;
      }

      const tools = message.toolCalls ?? [];
      const pending = tools.filter((t) => t.status === 'pending');

      // 无 pending 工具或已达迭代上限 → 正常收尾
      if (pending.length === 0 || toolLoopIterationRef.current >= MAX_TOOL_ITERATIONS) {
        if (toolLoopIterationRef.current >= MAX_TOOL_ITERATIONS && pending.length > 0) {
          // 达上限仍有 pending 工具：标记为 failed 并提示
          const cappedTools = tools.map((t) =>
            t.status === 'pending'
              ? { ...t, status: 'failed' as ToolCallStatus, output: `已达到工具调用迭代上限 (${MAX_TOOL_ITERATIONS})，中止执行。` }
              : t
          );
          updateMessageInChat(chatId, messageId, (msg) => ({
            ...msg,
            toolCalls: cappedTools,
          }));
        }
        if (!isContinue) {
          void generateAndApplyTitles(chatId, messageId, modelId);
        }
        // 仅当本实例未被后续调用覆盖时才执行清理，防止错误终止新的生成。
        if (toolLoopSeqRef.current === mySeq) {
          setGeneratingChatId(null);
          setGenerationSession(null);
        }
        return;
      }

      // 执行 pending 工具
      toolLoopIterationRef.current += 1;
      let updatedTools = [...tools];
      for (const tool of pending) {
        // 置为 running，UI 立即反馈
        updatedTools = updatedTools.map((t) =>
          t.id === tool.id ? { ...t, status: 'running' as ToolCallStatus } : t
        );
        updateMessageInChat(chatId, messageId, (msg) => ({
          ...msg,
          toolCalls: updatedTools,
        }));

        try {
          const result = await executeTool({
            tool: tool.name,
            input: tool.input,
            chatId,
          });
          const status: ToolCallStatus = result.isError ? 'failed' : 'completed';
          updatedTools = updatedTools.map((t) =>
            t.id === tool.id
              ? { ...t, status, output: result.output, structured: result.structured }
              : t
          );
          updateMessageInChat(chatId, messageId, (msg) => ({
            ...msg,
            toolCalls: updatedTools,
          }));
        } catch (err) {
          updatedTools = updatedTools.map((t) =>
            t.id === tool.id
              ? { ...t, status: 'failed' as ToolCallStatus, output: err instanceof Error ? err.message : String(err) }
              : t
          );
          updateMessageInChat(chatId, messageId, (msg) => ({
            ...msg,
            toolCalls: updatedTools,
          }));
        }
      }

      // 工具结果已写入 message.toolCalls，以 continue 模式重新触发生成。
      // 仅当本实例未被 handleStopGeneration 或新一轮生成覆盖时才继续。
      if (toolLoopSeqRef.current === mySeq) {
        triggerRef.current?.(chatId, undefined, { continueMessageId: messageId });
      }
    },
    [setGeneratingChatId, setGenerationSession, updateMessageInChat]
  );

  const triggerAIResponse = useCallback(
    async (chatId: string, modelId?: string, options?: { continueMessageId?: string }) => {
    const isContinue = !!options?.continueMessageId;
    const aiMessageId = isContinue ? options!.continueMessageId! : crypto.randomUUID();
    // 新一轮生成：递增序号以取消任何仍在执行的旧 runToolLoop，防止并发 continue。
    // 同时重置工具循环计数器；continue 模式沿用已有计数。
    if (!isContinue) {
      toolLoopSeqRef.current += 1;
      toolLoopIterationRef.current = 0;
    }
    // 每次生成重置 tool call 累积器
    toolCallAccumulator.current.clear();

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

      if (!activeProvider || !activeModel || !resolvedModelId) {
        const errorContent = formatErrorContent('MODEL_NOT_FOUND', '未找到可用模型，请在设置中启用一个模型。');
        updateMessageInChat(chatId, aiMessageId, (message) => ({
          ...message,
          content: message.content + errorContent,
          status: 'done' as const,
        }));
        setGeneratingChatId(null);
        setGenerationSession(null);
        return;
      }

      // 构建 API 消息列表：展开 assistant 消息中的 tool_calls 为 assistant+tool 消息对
      const apiMessages: ChatMessage[] = [];
      for (const msg of chat.messages) {
        // 首轮生成时跳过当前（空占位）消息；continue 模式需包含已有内容和工具调用/结果
        if (msg.id === aiMessageId && !isContinue) continue;
        const content = adaptLegacyMessageContent(msg);
        const role = msg.role === 'user' ? 'user' as const : 'assistant' as const;
        const apiContent = buildChatMessageContentFromProtocol(
          content,
          msg.role === 'user' && (activeModel.supportsMultimodal ?? false),
        );

        const reasoningContent = role === 'assistant' && msg.reasoning
          ? { reasoning_content: msg.reasoning }
          : {};

        if (msg.toolCalls && msg.toolCalls.length > 0) {
          // 只包含已执行完毕的 tool calls，避免 pending/running 状态的工具没有对应 tool 结果而触
          // 发 "role 'tool' must be a response to a preceding message with 'tool_calls'" 错误
          const resolvedCalls = msg.toolCalls.filter(
            (tc) => tc.status === 'completed' || tc.status === 'failed',
          );
          if (resolvedCalls.length > 0) {
            apiMessages.push({
              role,
              content: apiContent,
              ...reasoningContent,
              tool_calls: resolvedCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
              })),
            });
            for (const tc of resolvedCalls) {
              apiMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: tc.output ?? '',
              });
            }
          } else {
            apiMessages.push({ role, content: apiContent, ...reasoningContent });
          }
        } else {
          apiMessages.push({ role, content: apiContent, ...reasoningContent });
        }
      }

      // Set up trace recording if debug mode is on and this chat is being traced
      const debugMode = usePreferencesStore.getState().debugMode;
      const currentTracedId = useChatStore.getState().tracedChatId;
      const isTracing = debugMode && currentTracedId === chatId;
      console.log('[Trace] isTracing check:', { debugMode, currentTracedId, chatId, isTracing });
      let trace: TraceCallback | undefined;
      let traceRawEvents: unknown[] = [];
      let traceRequestBody: unknown = null;
      let upstreamTrace: TraceRecord['upstream'] | undefined;
      // 防止 finishTraceRecord 被重复调用导致同一轮请求写入多条记录。
      // message_done / error 事件、catch 块、finally 兜底都可能触发，只记录一次。
      let traceRecorded = false;

      if (isTracing) {
        trace = {
          onRequest: (body) => { traceRequestBody = body; },
          onResponseEvent: (rawEvent) => { traceRawEvents.push(rawEvent); },
        };
      }

      const finishTraceRecord = () => {
        if (traceRecorded) return;
        traceRecorded = true;
        console.log('[Trace] finishTraceRecord called:', { isTracing, hasBody: !!traceRequestBody, eventCount: traceRawEvents.length });
        if (isTracing && traceRequestBody) {
          useChatStore.getState().addTraceRecord({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            chatId,
            request: {
              url: `${activeProvider.baseUrl}/chat/completions`,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: traceRequestBody,
            },
            response: { rawEvents: traceRawEvents },
            upstream: upstreamTrace,
          });
        }
      };

      try {
        await streamChat(
          {
            modelId: resolvedModelId,
            providerId: activeProvider.id,
            messages: apiMessages,
            temperature: DEFAULT_CHAT_TEMPERATURE,
            traceUpstream: isTracing,
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
            } else if (event.event === 'tool_call_start') {
              const { index, id, name } = event.data;
              const existing = toolCallAccumulator.current.get(index) ?? { id: '', name: '', arguments: '' };
              existing.id = id;
              existing.name = name;
              toolCallAccumulator.current.set(index, existing);
            } else if (event.event === 'tool_call_delta') {
              const { index, arguments: args } = event.data;
              const existing = toolCallAccumulator.current.get(index) ?? { id: '', name: '', arguments: '' };
              existing.arguments += args;
              toolCallAccumulator.current.set(index, existing);
            } else if (event.event === 'message_done') {
              // 提取上游追踪数据
              if (event.data.upstream_trace) {
                upstreamTrace = {
                  request: event.data.upstream_trace.request,
                  response: { rawEvents: event.data.upstream_trace.events },
                };
              }
              // 从累积器提取 tool calls
              const accumulated = Array.from(toolCallAccumulator.current.entries())
                .sort(([a], [b]) => a - b)
                .map(([_, tc]) => {
                  let input: unknown = {};
                  if (tc.arguments) {
                    try { input = JSON.parse(tc.arguments); } catch { /* keep as string fallback */ }
                  }
                  return {
                    id: tc.id,
                    name: tc.name,
                    input,
                    status: 'pending' as ToolCallStatus,
                  };
                });

              updateChatMessages(chatId, (msgs) => {
                const finalized = finalizeMessage(msgs, aiMessageId).map((msg) =>
                  msg.id === aiMessageId
                    ? { ...msg, usage: event.data.usage ?? undefined, toolCalls: accumulated.length > 0 ? [...(msg.toolCalls ?? []), ...accumulated] : msg.toolCalls }
                    : msg
                );
                // 将本轮新增的 tool calls 作为时序分段追加到 segments
                return appendToolCallSegments(finalized, aiMessageId, accumulated);
              });
              finishTraceRecord();
              // Agent 工具循环：检测 pending 工具调用 → 执行 → 继续生成。
              void runToolLoop(chatId, aiMessageId, resolvedModelId, isContinue);
            } else if (event.event === 'error') {
              finishTraceRecord();
              const errorContent = formatErrorContent(event.data.code, event.data.message);
              updateMessageInChat(chatId, aiMessageId, (message) => ({
                ...message,
                content: message.content + errorContent,
                status: 'done' as const,
              }));
              setGeneratingChatId(null);
              setGenerationSession(null);
            }
          },
          controller.signal,
          trace,
        );
      } catch {
        // 异常路径（后端不可达、CORS 失败、网络中断等）：
        // trace.onRequest 已在 fetch 前调用、traceRequestBody 已赋值，
        // 必须在此刷新记录，否则追踪界面会一直停留在"等待 API 请求..."。
        finishTraceRecord();
        if (!controller.signal.aborted) {
          const errorContent = formatErrorContent(
            'BACKEND_UNAVAILABLE',
            '无法连接到后端服务，请确认 Rust 后端已启动。',
          );
          updateMessageInChat(chatId, aiMessageId, (message) => ({
            ...message,
            content: message.content + errorContent,
            status: 'done' as const,
          }));
          setGeneratingChatId(null);
          setGenerationSession(null);
        }
      } finally {
        // 兜底：确保任何未预见的异常路径也能记录 trace。
        // 防重复标志会阻止已记录的再次写入，不会产生重复记录。
        finishTraceRecord();
      }
    },
    [
      appendChatMessage,
      clearActiveDiff,
      closePanel,
      runToolLoop,
      setCurrentTasks,
      setGeneratingChatId,
      setGenerationSession,
      updateChatMessages,
      updateMessageInChat,
      apiConfigs,
    ]
  );

  // 持有 triggerAIResponse 引用，供 runToolLoop 在工具执行完毕后继续生成。
  // 每次 render 同步赋值，确保 runToolLoop 调用时拿到最新实例。
  triggerRef.current = triggerAIResponse;

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

    // 递增序号以取消任何仍在执行的 runToolLoop，防止旧的工具循环触发 continue。
    toolLoopSeqRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    // 用户主动中止：重置工具循环计数器，避免下次生成沿用旧计数
    toolLoopIterationRef.current = 0;

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
