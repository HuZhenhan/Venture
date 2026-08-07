import { useCallback } from 'react';
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
import { buildChatMessageContentFromProtocol, serializeComposerMessage } from '../utils/codeReferences';
import {
  adaptLegacyMessageContent,
  getThinkingText,
  getVisibleText,
  serializeError,
} from '../utils/messageContentProtocol';
import { executeTool } from '../services/toolService';
import { checkAccessibilityPermissionOnce, executeAgentTool, isAgentTool, waitForPermissionResolution } from '../services/agentService';
import { useAgentStore } from '../store/agentState';
import { usePreferencesStore } from '../store/usePreferencesStore';
import { debugError } from '../utils/debugLogger';
import {
  APPROVAL_EXPIRED_OUTPUT,
  evaluateToolCall,
  permissionDeniedOutput,
  resolvePermissionForChat,
} from '../utils/toolPermissions';

const DEFAULT_CHAT_TEMPERATURE = 0.8;
/// Agent 工具循环最大迭代次数，防止模型陷入无限工具调用。
const MAX_TOOL_ITERATIONS = 15;

// ── 生成控制状态（模块级单例）──────────────────────────────────────────────
// 生成会话状态（generatingChatId / generationSession）存于全局 store，而
// abort 控制与工具循环控制必须同样是全局单例：useGeneration 会被 ChatInput
// （useChatComposer）与 MessageList（useMessageListActions）分别实例化。
// 若这些 ref 留在 hook 内，ChatInput 停止按钮 abort 的是自身实例的 controller，
// 无法中断另一实例发起的生成（如回答 ask 卡片、重新生成后的 continue）。
// 同一时刻只有一个生成会话（generatingChatId 全局唯一），单例语义安全。
const abortControllerRef = { current: null as AbortController | null };
/// Agent 工具循环迭代计数。每次新一轮（非 continue）生成时重置。
const toolLoopIterationRef = { current: 0 };
/// 持有 triggerAIResponse 的引用，供 runToolLoop 继续生成时调用，打破循环依赖。
const triggerRef = { current: null as ((chatId: string, modelId?: string, options?: { continueMessageId?: string }) => void) | null };
/// 流式 tool_call delta 累积器：按 index 累积 id/name/arguments。
const toolCallAccumulator = { current: new Map<number, { id: string; name: string; arguments: string }>() };
/// runToolLoop 并发锁序号：每次新调用递增，用于防止旧的 runToolLoop 覆盖新状态。
const toolLoopSeqRef = { current: 0 };

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
   *
   * turnMessageId：当前轮次对应的 user message ID，用于文件回退系统的 turn 级关联。
   */
  const runToolLoop = useCallback(
    async (chatId: string, messageId: string, modelId: string, isContinue: boolean, turnMessageId?: string) => {
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
        if (toolLoopSeqRef.current === mySeq) {
          setGeneratingChatId(null);
          setGenerationSession(null);
        }
        return;
      }

      // 分离 AskUserQuestion 与普通工具
      const askTools = pending.filter((t) => t.name === 'AskUserQuestion');
      const normalTools = pending.filter((t) => t.name !== 'AskUserQuestion');

      // 将 AskUserQuestion 标记为 needs_user_input，等待用户响应
      let updatedTools = [...tools];
      if (askTools.length > 0) {
        updatedTools = updatedTools.map((t) =>
          askTools.some((at) => at.id === t.id)
            ? { ...t, status: 'needs_user_input' as ToolCallStatus }
            : t
        );
        updateMessageInChat(chatId, messageId, (msg) => ({ ...msg, toolCalls: updatedTools }));
      }

      // 若无普通工具需执行，暂停循环等待用户回答
      if (normalTools.length === 0) {
        setGeneratingChatId(null);
        setGenerationSession(null);
        return;
      }

      // 执行普通 pending 工具
      toolLoopIterationRef.current += 1;
      for (const tool of normalTools) {
        // 停止（handleStopGeneration）或新一轮生成会递增 seq，中止剩余工具执行
        if (toolLoopSeqRef.current !== mySeq) break;

        // ── 权限系统：执行前判定 allow / deny / ask ──────────────────────
        // approvalGranted：用户刚在询问卡片上点击"同意/一律同意"，本次直接放行。
        const latestChat = useChatStore.getState().chats.find((c) => c.id === chatId);
        const currentMode = latestChat?.mode ?? 'agent';
        const permissionLevel = resolvePermissionForChat(latestChat, currentMode);
        const decision: 'allow' | 'deny' | 'ask' = tool.approvalGranted
          ? 'allow'
          : evaluateToolCall({
              level: permissionLevel,
              mode: currentMode,
              toolName: tool.name,
              input: tool.input,
              approvedSignatures: latestChat?.approvedToolCalls ?? [],
            });

        if (decision === 'deny') {
          // 权限不足（只读 / yolo 下仅一般操作）：自动拒绝，结果回填给模型
          updatedTools = updatedTools.map((t) =>
            t.id === tool.id
              ? { ...t, status: 'failed' as ToolCallStatus, output: permissionDeniedOutput(permissionLevel, tool.name) }
              : t
          );
          updateMessageInChat(chatId, messageId, (msg) => ({
            ...msg,
            toolCalls: updatedTools,
          }));
          continue;
        }

        if (decision === 'ask') {
          // 需要用户授权：标记 needs_approval 并暂停工具循环，等待询问卡片结果。
          // 状态随会话持久化，即使关闭软件，重新打开后卡片仍会正常显示。
          updatedTools = updatedTools.map((t) =>
            t.id === tool.id ? { ...t, status: 'needs_approval' as ToolCallStatus } : t
          );
          updateMessageInChat(chatId, messageId, (msg) => ({
            ...msg,
            toolCalls: updatedTools,
          }));
          setGeneratingChatId(null);
          setGenerationSession(null);
          return;
        }

        updatedTools = updatedTools.map((t) =>
          t.id === tool.id ? { ...t, status: 'running' as ToolCallStatus } : t
        );
        updateMessageInChat(chatId, messageId, (msg) => ({
          ...msg,
          toolCalls: updatedTools,
        }));

        try {
          // 手机助手工具走 /api/agent/tool 通道（无障碍/Dsl 脚本），其余走 /api/tools/execute
          if (isAgentTool(tool.name)) {
            // 无障碍权限门槛（规格书 8.3）：重启后首次执行需权限的工具时检查，
            // 未开启 → 弹窗引导并阻塞等待：用户开启权限返回后自动继续执行该工具，
            // 取消才标记失败并暂停循环
            const permissionGate = await checkAccessibilityPermissionOnce(tool.name);
            if (permissionGate === 'missing') {
              useAgentStore.getState().setPermissionDialog(true, tool.name);
              const permissionGranted = await waitForPermissionResolution();
              if (!permissionGranted) {
                updatedTools = updatedTools.map((t) =>
                  t.id === tool.id
                    ? {
                        ...t,
                        status: 'failed' as ToolCallStatus,
                        output: `缺少「Venture 无障碍服务」权限，已取消执行。开启权限后重新发送消息即可。`,
                      }
                    : t
                );
                updateMessageInChat(chatId, messageId, (msg) => ({
                  ...msg,
                  toolCalls: updatedTools,
                }));
                setGeneratingChatId(null);
                setGenerationSession(null);
                return;
              }
              // 权限已开启：继续执行当前工具，不标记失败
              if (toolLoopSeqRef.current !== mySeq) return; // 等待期间用户点击了停止
            }

            const agentInput: Record<string, unknown> = {
              ...((tool.input ?? {}) as Record<string, unknown>),
            };
            // 高危脚本：用户在确认卡片上同意后，以 confirmed=true 重放（规格书 §9/§12.4）
            if (tool.name.toLowerCase() === 'run_script' && tool.approvalGranted) {
              agentInput.confirmed = true;
            }
            const agentResult = await executeAgentTool(tool.name, agentInput, chatId);

            // 高危/分享/危险动作脚本 → 后端返回 needs_confirmation：
            // 转换为 needs_approval 暂停循环，复用现有权限询问卡片（规格书 §6.4 护栏）
            const scriptStatus = (agentResult as { status?: string }).status;
            if (tool.name.toLowerCase() === 'run_script' && scriptStatus === 'needs_confirmation') {
              const reason = (agentResult as { confirmation?: { reason?: string } }).confirmation?.reason
                ?? '该脚本需要用户确认后执行';
              updatedTools = updatedTools.map((t) =>
                t.id === tool.id
                  ? { ...t, status: 'needs_approval' as ToolCallStatus, output: reason }
                  : t
              );
              updateMessageInChat(chatId, messageId, (msg) => ({
                ...msg,
                toolCalls: updatedTools,
              }));
              setGeneratingChatId(null);
              setGenerationSession(null);
              return;
            }

            // report_progress → 悬浮提示（不中断循环，规格书 6.4）
            if (tool.name.toLowerCase() === 'report_progress') {
              const message = (agentResult as { message?: string }).message
                ?? (agentInput.message as string | undefined)
                ?? '';
              if (message) useAgentStore.getState().setProgressMessage(message);
            }

            const isError = agentResult.ok === false;
            const output = isError
              ? (agentResult.error?.message ?? 'agent 工具执行失败')
              : JSON.stringify(agentResult);
            const status: ToolCallStatus = isError ? 'failed' : 'completed';
            updatedTools = updatedTools.map((t) =>
              t.id === tool.id
                ? { ...t, status, output, structured: agentResult }
                : t
            );
            updateMessageInChat(chatId, messageId, (msg) => ({
              ...msg,
              toolCalls: updatedTools,
            }));
            continue;
          }

          const result = await executeTool({
            tool: tool.name,
            input: tool.input,
            chatId,
            turnMessageId,
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

      // 有 askTool 等待 → 暂停，不继续循环
      if (askTools.length > 0) {
        setGeneratingChatId(null);
        setGenerationSession(null);
        return;
      }

      // 工具结果已写入，以 continue 模式重新触发生成。
      if (toolLoopSeqRef.current === mySeq) {
        triggerRef.current?.(chatId, undefined, { continueMessageId: messageId });
      }
    },
    [setGeneratingChatId, setGenerationSession, updateMessageInChat]
  );

  /**
   * 权限询问（或 AskUserQuestion）得到用户答复后，恢复工具执行流程。
   *
   * - 仍有 pending 工具 → 重新进入 runToolLoop 继续执行；
   * - 无 pending 且无任何未解决的等待状态 → 以 continue 模式重新触发生成，
   *   让模型读取工具结果（含被拒绝的结果）继续输出；
   * - 仍有其它等待中的卡片 → 保持暂停，不做任何事。
   *
   * 该路径同样覆盖「软件重启后答复遗留询问卡片」的场景：状态均已持久化，
   * 此处只需按当前 store 中的消息状态推进即可。
   */
  const resumeToolExecution = useCallback(
    (chatId: string, messageId: string) => {
      const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
      const message = chat?.messages.find((m) => m.id === messageId);
      if (!chat || !message) return;

      const tools = message.toolCalls ?? [];
      const hasPending = tools.some((t) => t.status === 'pending');
      const hasUnresolved = tools.some(
        (t) => t.status === 'needs_user_input' || t.status === 'needs_approval',
      );

      if (hasPending) {
        // modelId 在 continue 路径仅用于标题生成（且 isContinue=true 时不会生成），
        // 因此即使模型配置尚未加载完成也不阻塞工具恢复执行。
        const selection = resolveEnabledModelSelection(useChatStore.getState().apiConfigs);
        // 计算当前 turn 对应的 user message ID（与 triggerAIResponse 中的逻辑一致）
        let turnMessageId: string | undefined;
        for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
          if (chat.messages[i].role === 'user') {
            turnMessageId = chat.messages[i].id;
            break;
          }
        }
        void runToolLoop(chatId, messageId, selection?.model.id ?? '', true, turnMessageId);
        return;
      }

      if (!hasUnresolved) {
        triggerRef.current?.(chatId, undefined, { continueMessageId: messageId });
      }
    },
    [runToolLoop]
  );

  const triggerAIResponse = useCallback(
    async (chatId: string, modelId?: string, options?: { continueMessageId?: string; autoRetried?: boolean; resumeContent?: string }) => {
    const isContinue = !!options?.continueMessageId;
    // 自动续传标记：上游流中断时自动重试一次，重试的调用不再续传（防死循环）
    const isAutoRetry = !!options?.autoRetried;
    // 续写内容：中断前已生成的部分正文（作为最后一条 assistant 消息让模型继续补全）
    const resumeContent = options?.resumeContent;
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
          content: resumeContent ?? '',
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

      // 新一轮生成前，自动放弃历史轮次中尚未回答的 AskUserQuestion（视为跳过），
      // 避免 needs_user_input 状态永久残留（该状态下消息操作栏会被隐藏）。
      // 同理，未处理的权限询问（needs_approval）也标记为失败取消，防止悬挂。
      const hasStaleAsks = chat.messages.some((m) =>
        (m.toolCalls ?? []).some(
          (tc) =>
            (tc.name === 'AskUserQuestion' && tc.status === 'needs_user_input') ||
            tc.status === 'needs_approval',
        ),
      );
      if (hasStaleAsks) {
        updateChatMessages(chatId, (messages) =>
          messages.map((m) => ({
            ...m,
            toolCalls: (m.toolCalls ?? []).map((tc) => {
              if (tc.name === 'AskUserQuestion' && tc.status === 'needs_user_input') {
                return { ...tc, status: 'completed' as const, output: '[skipped]' };
              }
              if (tc.status === 'needs_approval') {
                return { ...tc, status: 'failed' as const, output: APPROVAL_EXPIRED_OUTPUT };
              }
              return tc;
            }),
          })),
        );
      }

      // 计算当前 turn 对应的 user message ID，用于文件回退系统的 turn 级关联。
      // 逆序查找 AI 消息之前的最后一条 user 消息。
      let turnMessageId: string | undefined;
      for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
        const msg = chat.messages[i];
        if (msg.id === aiMessageId && !isContinue) continue;
        if (msg.role === 'user') {
          turnMessageId = msg.id;
          break;
        }
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

      // 构建 API 消息列表：展开 assistant 消息中的 tool_calls 为 assistant+tool 消息对。
      // continue 模式会在同一条消息中累积多轮工具循环（文字与 tool_calls 追加拼接）。
      // 若按整条消息原样发送（content 拼接 + 全部 tool_calls），模型无法区分轮次边界，
      // 容易把之前轮次的文字当作工具结果复读（表现为重复回复）。因此优先用 segments
      // （按流式到达顺序记录 reasoning/content/tool_calls 边界）重建为标准多轮消息序列，
      // 与 DeepSeek/OpenAI 官方工具调用格式一致：每条 assistant 消息 = 该轮文字 + 该轮
      // reasoning_content + 该轮 tool_calls，tool 结果紧随其后。
      const apiMessages: ChatMessage[] = [];
      for (const msg of chat.messages) {
        // 首轮生成时跳过当前（空占位）消息；continue 模式需包含已有内容和工具调用/结果
        if (msg.id === aiMessageId && !isContinue) continue;
        const content = adaptLegacyMessageContent(msg);
        // user 消息：气泡 content 只含摘要文本，引用内容（skill 全文等）在
        // blocks.reference_list 中携带，发送时重新序列化，确保完整注入模型上下文
        const apiContent = msg.role === 'user'
          ? buildChatMessageContentFromProtocol(
              serializeComposerMessage(
                content,
                (msg.blocks ?? []).find((b) => b.type === 'reference_list')?.references ?? [],
                [],
              ),
              activeModel.supportsMultimodal ?? false,
            )
          : buildChatMessageContentFromProtocol(content, false);

        if (msg.role === 'user') {
          apiMessages.push({ role: 'user', content: apiContent });
          continue;
        }

        // ── AI 消息：有 segments 时按轮次重建标准消息序列 ──────────────
        const segs = msg.segments ?? [];
        if (segs.length > 0) {
          let bufContent = '';
          let bufReasoning = '';
          let bufCalls: Array<{ id: string; name: string; input: unknown; output: string }> = [];
          const flush = () => {
            if (!bufContent && !bufReasoning && bufCalls.length === 0) return;
            const assistantMsg: ChatMessage = { role: 'assistant', content: bufContent };
            if (bufCalls.length > 0) {
              // DeepSeek 规范：进行工具调用的轮次必须回传 reasoning_content（缺失 400）；
              // 无工具调用的轮次传入会被忽略，不回传以节省 token
              if (bufReasoning) assistantMsg.reasoning_content = bufReasoning;
              assistantMsg.tool_calls = bufCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
              }));
              apiMessages.push(assistantMsg);
              // tool 结果紧随该条 assistant 消息
              for (const tc of bufCalls) {
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: tc.output });
              }
            } else {
              apiMessages.push(assistantMsg);
            }
            bufContent = '';
            bufReasoning = '';
            bufCalls = [];
          };
          for (const seg of segs) {
            if (seg.type === 'reasoning') {
              bufReasoning += seg.content;
            } else if (seg.type === 'content') {
              bufContent += seg.content;
            } else if (seg.type === 'tool_calls') {
              // 只回传已执行完毕的调用，避免 pending/running 状态没有对应 tool 结果
              for (const c of seg.calls) {
                const full = (msg.toolCalls ?? []).find((tc) => tc.id === c.id);
                if (full && (full.status === 'completed' || full.status === 'failed')) {
                  bufCalls.push({
                    id: full.id,
                    name: full.name,
                    input: full.input,
                    output: full.output ?? '',
                  });
                }
              }
              flush();
            }
          }
          flush();
          continue;
        }

        // ── 兼容旧格式（无 segments）：整条消息 + 全部 tool_calls ──────
        // 只包含已执行完毕的 tool calls，避免 pending/running 状态的工具没有对应 tool 结果而触
        // 发 "role 'tool' must be a response to a preceding message with 'tool_calls'" 错误
        const resolvedCalls = (msg.toolCalls ?? []).filter(
          (tc) => tc.status === 'completed' || tc.status === 'failed',
        );
        // DeepSeek 规范：仅进行工具调用的轮次必须回传 reasoning_content（缺失 400）；
        // 无工具调用的轮次传入会被忽略，不回传以节省 token
        const reasoningContent = resolvedCalls.length > 0 && msg.reasoning
          ? { reasoning_content: msg.reasoning }
          : {};
        if (resolvedCalls.length > 0) {
          apiMessages.push({
            role: 'assistant',
            content: apiContent,
            ...reasoningContent,
            tool_calls: resolvedCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
            })),
          });
          for (const tc of resolvedCalls) {
            apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: tc.output ?? '' });
          }
        } else {
          apiMessages.push({ role: 'assistant', content: apiContent, ...reasoningContent });
        }
      }

      // 续写模式：把中断前已生成的部分正文作为最后一条 assistant 消息，
      // 让模型从断点继续补全（而非重新生成）
      if (resumeContent) {
        apiMessages.push({ role: 'assistant', content: resumeContent });
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
              void runToolLoop(chatId, aiMessageId, resolvedModelId, isContinue, turnMessageId);
            } else if (event.event === 'error') {
              // 提取上游追踪数据（错误事件同样附带请求体，供排查 400 等问题）
              if (event.data.upstream_trace) {
                upstreamTrace = {
                  request: event.data.upstream_trace.request,
                  response: { rawEvents: event.data.upstream_trace.events },
                };
              }
              // 上游流中断/解码失败（服务端偶发断连）：自动续传一次——
              // 已生成的部分正文作为续写点继续补全（纯推理/工具轮中断则回退重新生成），
              // 先记录本次失败 trace 供排查，再清理占位消息
              if (
                event.data.code === 'UPSTREAM_STREAM_ERROR' &&
                !isAutoRetry &&
                !isContinue
              ) {
                finishTraceRecord();
                const partialMsg = useChatStore
                  .getState()
                  .chats.find((c) => c.id === chatId)
                  ?.messages.find((m) => m.id === aiMessageId);
                const partialContent = partialMsg?.content?.trim() ?? '';
                updateChatMessages(chatId, (msgs) => msgs.filter((m) => m.id !== aiMessageId));
                void triggerAIResponse(chatId, resolvedModelId, {
                  autoRetried: true,
                  resumeContent: partialContent || undefined,
                }).catch((err) => debugError('generation', 'auto retry failed', { error: err }));
                return;
              }
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
    resumeToolExecution,
    handleConfirmFileOp,
    handleRejectFileOp,
    handleStopGeneration,
  };
}
