import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeReference, ComposerReference, Message } from '../../../types';
import { useChatStore } from '../../../store/useChatStore';
import { useLayoutStore } from '../../../store/useLayoutStore';
import { useGeneration } from '../../../hooks/useGeneration';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { adaptLegacyMessageContent, getVisibleText } from '../../../utils/messageContentProtocol';
import { INSERT_CHAT_EVENT } from '../../../utils/codeReferences';
import { auditPermissionDecision, restoreTurn } from '../../../services/toolService';
import { getPermissionProfileForLevel, resolvePermissionForChat, toolSignature, USER_REJECTED_OUTPUT } from '../../../utils/toolPermissions';

export function useMessageListActions(chat: { id: string; messages: Message[] } | null, activeChatId: string | null) {
  const setActiveChatId = useChatStore((state) => state.setActiveChatId);
  const updateChatMessages = useChatStore((state) => state.updateChatMessages);
  const { openDiff, openCodeReference } = useLayoutStore();
  const { triggerAIResponse, resumeToolExecution, handleConfirmFileOp, handleRejectFileOp } = useGeneration();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showUndoConfirm, setShowUndoConfirm] = useState<string | null>(null);
  const chatRef = useRef(chat);
  const copiedTimerRef = useRef<number | null>(null);
  chatRef.current = chat;

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  const showCopiedState = useCallback((id: string) => {
    setCopiedId(id);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const handleCopy = useCallback((content: string, id: string) => {
    copyTextToClipboard(content)
      .then(() => showCopiedState(id))
      .catch((error) => {
        console.error('Copy failed', error);
      });
  }, [showCopiedState]);

  const handleOpenDiff = useCallback((id: string) => openDiff(id), [openDiff]);
  const handleOpenCodeReference = useCallback((reference: CodeReference) => openCodeReference(reference), [openCodeReference]);
  const handleOpenComposerReference = useCallback((reference: ComposerReference) => {
    if (reference.kind === 'code') {
      openCodeReference(reference.codeReference);
      return;
    }

    if (reference.kind === 'chat' && reference.chatId) {
      setActiveChatId(reference.chatId);
      return;
    }

    if (reference.diffId) {
      openDiff(reference.diffId);
      return;
    }

    if (reference.kind === 'web' && reference.url) {
      window.open(reference.url, '_blank', 'noopener,noreferrer');
    }
  }, [openCodeReference, openDiff, setActiveChatId]);

  const handleConfirmFileOpCb = useCallback((messageId: string, fileOpId: string) => {
    const currentChat = chatRef.current;
    if (currentChat) {
      handleConfirmFileOp(currentChat.id, messageId, fileOpId);
    }
  }, [handleConfirmFileOp]);

  const handleRejectFileOpCb = useCallback((messageId: string, fileOpId: string) => {
    const currentChat = chatRef.current;
    if (currentChat) {
      handleRejectFileOp(currentChat.id, messageId, fileOpId);
    }
  }, [handleRejectFileOp]);

  const handleUpdateAskBlock = useCallback((messageId: string, askId: string, answer: { selectedOptions?: string[]; text?: string }) => {
    if (!activeChatId) return;

    let allResolved = false;
    updateChatMessages(activeChatId, (messages) =>
      messages.map((message) => {
        if (message.id !== messageId) return message;
        // 找到对应 tool call 并更新为 completed
        const tcIndex = (message.toolCalls ?? []).findIndex(
          (tc) => tc.name === 'AskUserQuestion' && tc.status === 'needs_user_input'
        );
        if (tcIndex === -1) return message;
        const updatedCalls = (message.toolCalls ?? []).map((tc, i) =>
          i === tcIndex
            ? { ...tc, status: 'completed' as const, output: JSON.stringify(answer) }
            : tc
        );
        // 仍有 pending / needs_approval / needs_user_input 时不推进，等其余卡片处理完
        allResolved = updatedCalls.every((tc) => tc.status === 'completed' || tc.status === 'failed');
        return { ...message, toolCalls: updatedCalls };
      }),
    );

    if (allResolved) {
      void triggerAIResponse(activeChatId, undefined, { continueMessageId: messageId });
    }
  }, [activeChatId, triggerAIResponse, updateChatMessages]);

  const handleSkipAskBlock = useCallback((messageId: string, askId: string) => {
    if (!activeChatId) return;

    let allResolved = false;
    updateChatMessages(activeChatId, (messages) =>
      messages.map((message) => {
        if (message.id !== messageId) return message;
        const tcIndex = (message.toolCalls ?? []).findIndex(
          (tc) => tc.name === 'AskUserQuestion' && tc.status === 'needs_user_input'
        );
        if (tcIndex === -1) return message;
        const updatedCalls = (message.toolCalls ?? []).map((tc, i) =>
          i === tcIndex
            ? { ...tc, status: 'completed' as const, output: '[skipped]' }
            : tc
        );
        allResolved = updatedCalls.every((tc) => tc.status === 'completed' || tc.status === 'failed');
        return { ...message, toolCalls: updatedCalls };
      }),
    );

    if (allResolved) {
      void triggerAIResponse(activeChatId, undefined, { continueMessageId: messageId });
    }
  }, [activeChatId, triggerAIResponse, updateChatMessages]);

  // ── 工具权限询问卡片决策 ─────────────────────────────────────────────────
  // 同意：仅本次调用放行（打 approvalGranted 标记），工具状态回到 pending 并恢复执行流程。
  const handleApproveToolCall = useCallback((messageId: string, toolId: string) => {
    if (!activeChatId) return;
    updateChatMessages(activeChatId, (messages) =>
      messages.map((message) => {
        if (message.id !== messageId) return message;
        return {
          ...message,
          toolCalls: (message.toolCalls ?? []).map((tc) =>
            tc.id === toolId && tc.status === 'needs_approval'
              ? { ...tc, status: 'pending' as const, approvalGranted: true }
              : tc
          ),
        };
      }),
    );
    resumeToolExecution(activeChatId, messageId);
  }, [activeChatId, resumeToolExecution, updateChatMessages]);

  // 一律同意：把签名（工具名 + 规范化参数）写入会话白名单，然后同"同意"处理。
  const handleAlwaysApproveToolCall = useCallback((messageId: string, toolId: string) => {
    if (!activeChatId) return;
    const chat = useChatStore.getState().chats.find((c) => c.id === activeChatId);
    const message = chat?.messages.find((m) => m.id === messageId);
    const tool = message?.toolCalls?.find((tc) => tc.id === toolId);
    if (tool) {
      useChatStore.getState().addApprovedToolSignature(activeChatId, toolSignature(tool.name, tool.input));
    }
    updateChatMessages(activeChatId, (messages) =>
      messages.map((msg) => {
        if (msg.id !== messageId) return msg;
        return {
          ...msg,
          toolCalls: (msg.toolCalls ?? []).map((tc) =>
            tc.id === toolId && tc.status === 'needs_approval'
              ? { ...tc, status: 'pending' as const, approvalGranted: true }
              : tc
          ),
        };
      }),
    );
    resumeToolExecution(activeChatId, messageId);
  }, [activeChatId, resumeToolExecution, updateChatMessages]);

  const handleSessionApproveToolCall = useCallback((messageId: string, toolId: string) => {
    if (!activeChatId) return;
    const currentChat = useChatStore.getState().chats.find((c) => c.id === activeChatId);
    const message = currentChat?.messages.find((m) => m.id === messageId);
    const tool = message?.toolCalls?.find((tc) => tc.id === toolId);
    if (tool) {
      useChatStore.getState().addSessionApprovedToolSignature(activeChatId, toolSignature(tool.name, tool.input));
    }
    updateChatMessages(activeChatId, (messages) =>
      messages.map((msg) => {
        if (msg.id !== messageId) return msg;
        return {
          ...msg,
          toolCalls: (msg.toolCalls ?? []).map((tc) =>
            tc.id === toolId && tc.status === 'needs_approval'
              ? { ...tc, status: 'pending' as const, approvalGranted: true }
              : tc
          ),
        };
      }),
    );
    resumeToolExecution(activeChatId, messageId);
  }, [activeChatId, resumeToolExecution, updateChatMessages]);

  // 拒绝：标记为 failed 并回填拒绝说明给模型，然后恢复执行流程。
  const handleRejectToolCall = useCallback((messageId: string, toolId: string) => {
    if (!activeChatId) return;
    const currentChat = useChatStore.getState().chats.find((item) => item.id === activeChatId);
    const currentMessage = currentChat?.messages.find((message) => message.id === messageId);
    const rejectedTool = currentMessage?.toolCalls?.find((toolCall) => toolCall.id === toolId);
    if (currentChat && rejectedTool) {
      const permissionLevel = resolvePermissionForChat(currentChat, currentChat.mode);
      auditPermissionDecision({
        tool: rejectedTool.name,
        input: rejectedTool.input,
        chatId: activeChatId,
        turnMessageId: messageId,
        toolCallId: toolId,
        permissionProfile: getPermissionProfileForLevel(permissionLevel),
        approvalScope: 'once',
        userChoice: 'rejected',
      }).catch((error) => {
        console.warn('Failed to audit rejected tool permission.', error);
      });
    }
    updateChatMessages(activeChatId, (messages) =>
      messages.map((message) => {
        if (message.id !== messageId) return message;
        return {
          ...message,
          toolCalls: (message.toolCalls ?? []).map((tc) =>
            tc.id === toolId && tc.status === 'needs_approval'
              ? { ...tc, status: 'failed' as const, output: USER_REJECTED_OUTPUT }
              : tc
          ),
        };
      }),
    );
    resumeToolExecution(activeChatId, messageId);
  }, [activeChatId, resumeToolExecution, updateChatMessages]);

  const handleMarkdownComplete = useCallback((messageId: string) => {
    if (!activeChatId) {
      return;
    }

    updateChatMessages(activeChatId, (messages) =>
      messages.map((message) => (
        message.id === messageId && message.status !== 'done'
          ? ({ ...message, status: 'done' } as Message)
          : message
      )),
    );
  }, [activeChatId, updateChatMessages]);

  const handleRegenerate = useCallback((messageId?: string, modelId?: string) => {
    const currentChat = chatRef.current;
    if (!currentChat || !activeChatId) {
      return;
    }

    let targetIndex: number;
    if (messageId) {
      targetIndex = currentChat.messages.findIndex((message) => message.id === messageId);
      if (targetIndex === -1 || currentChat.messages[targetIndex].role !== 'ai') {
        return;
      }
    } else {
      targetIndex = currentChat.messages.length - 1;
      const lastMessage = currentChat.messages[targetIndex];
      if (lastMessage?.role !== 'ai') {
        return;
      }
    }

    updateChatMessages(activeChatId, (messages) => messages.slice(0, targetIndex));
    void triggerAIResponse(activeChatId, modelId);
  }, [activeChatId, triggerAIResponse, updateChatMessages]);

  const handleUndo = useCallback(async (messageId?: string) => {
    const currentChat = chatRef.current;
    if (!currentChat || !activeChatId) {
      return;
    }

    let sliceIndex: number;
    if (messageId) {
      const targetIndex = currentChat.messages.findIndex((message) => message.id === messageId);
      if (targetIndex === -1) {
        return;
      }
      let precedingUserIndex = -1;
      for (let i = targetIndex - 1; i >= 0; i -= 1) {
        if (currentChat.messages[i].role === 'user') {
          precedingUserIndex = i;
          break;
        }
      }
      sliceIndex = precedingUserIndex !== -1 ? precedingUserIndex : targetIndex;
    } else {
      sliceIndex = -1;
      for (let i = currentChat.messages.length - 1; i >= 0; i -= 1) {
        if (currentChat.messages[i].role === 'user') {
          sliceIndex = i;
          break;
        }
      }
      if (sliceIndex === -1) {
        setShowUndoConfirm(null);
        return;
      }
    }

    // 撤销前捕获被移除的用户消息文本，以便回填到输入框
    const undoneUserMessage = currentChat.messages[sliceIndex];
    const undoneText = undoneUserMessage && undoneUserMessage.role === 'user'
      ? getVisibleText(adaptLegacyMessageContent(undoneUserMessage))
      : '';

    // 调用文件回退 API：将该 turn 内修改的所有文件恢复到修改前状态。
    // turnId = 触发该 turn 的 user message ID。
    const turnMessageId = undoneUserMessage?.id;
    if (turnMessageId) {
      try {
        const result = await restoreTurn(activeChatId, turnMessageId);
        if (result.conflicts.length > 0) {
          // 有冲突：文件已写入冲突标记，在控制台记录详情
          console.warn('[Undo] 文件回退存在冲突：', result.conflicts);
        }
        if (result.errors.length > 0) {
          console.error('[Undo] 文件回退错误：', result.errors);
        }
      } catch (err) {
        // 回退 API 失败不阻止消息移除（消息层撤销仍可执行）
        console.error('[Undo] 文件回退 API 调用失败：', err);
      }
    }

    updateChatMessages(activeChatId, (messages) => messages.slice(0, sliceIndex));

    // 将被撤销的用户输入内容重新回填到输入框
    if (undoneText) {
      document.dispatchEvent(new CustomEvent(INSERT_CHAT_EVENT, { detail: { text: undoneText } }));
    }

    setShowUndoConfirm(null);
  }, [activeChatId, updateChatMessages]);

  return {
    copiedId,
    showUndoConfirm,
    setShowUndoConfirm,
    handleCopy,
    handleOpenDiff,
    handleOpenCodeReference,
    handleOpenComposerReference,
    handleConfirmFileOpCb,
    handleRejectFileOpCb,
    handleUpdateAskBlock,
    handleSkipAskBlock,
    handleApproveToolCall,
    handleSessionApproveToolCall,
    handleAlwaysApproveToolCall,
    handleRejectToolCall,
    handleMarkdownComplete,
    handleRegenerate,
    handleUndo,
  };
}
