import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeReference, ComposerReference, Message } from '../../../types';
import { useChatStore } from '../../../store/useChatStore';
import { useLayoutStore } from '../../../store/useLayoutStore';
import { useGeneration } from '../../../hooks/useGeneration';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { adaptLegacyMessageContent, setAskAnswer, skipAsk, getAskForms } from '../../../utils/messageContentProtocol';

export function useMessageListActions(chat: { id: string; messages: Message[] } | null, activeChatId: string | null) {
  const setActiveChatId = useChatStore((state) => state.setActiveChatId);
  const updateChatMessages = useChatStore((state) => state.updateChatMessages);
  const { openDiff, openCodeReference } = useLayoutStore();
  const { triggerAIResponse, handleConfirmFileOp, handleRejectFileOp } = useGeneration();
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
    if (!activeChatId) {
      return;
    }

    let allResolved = false;
    updateChatMessages(activeChatId, (messages) =>
      messages.map((message) => {
        if (message.id !== messageId) return message;
        const adaptedContent = adaptLegacyMessageContent(message);
        const newContent = setAskAnswer(adaptedContent, askId, answer);
        const asks = getAskForms(newContent);
        allResolved = asks.length > 0 && asks.every((ask) => ask.status !== 'pending');
        return {
          ...message,
          content: newContent,
        };
      }),
    );

    if (allResolved) {
      void triggerAIResponse(activeChatId, undefined, { continueMessageId: messageId });
    }
  }, [activeChatId, triggerAIResponse, updateChatMessages]);

  const handleSkipAskBlock = useCallback((messageId: string, askId: string) => {
    if (!activeChatId) {
      return;
    }

    let allResolved = false;
    updateChatMessages(activeChatId, (messages) =>
      messages.map((message) => {
        if (message.id !== messageId) return message;
        const adaptedContent = adaptLegacyMessageContent(message);
        const newContent = skipAsk(adaptedContent, askId);
        const asks = getAskForms(newContent);
        allResolved = asks.length > 0 && asks.every((ask) => ask.status !== 'pending');
        return {
          ...message,
          content: newContent,
        };
      }),
    );

    if (allResolved) {
      void triggerAIResponse(activeChatId, undefined, { continueMessageId: messageId });
    }
  }, [activeChatId, triggerAIResponse, updateChatMessages]);

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

  const handleUndo = useCallback((messageId?: string) => {
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

    updateChatMessages(activeChatId, (messages) => messages.slice(0, sliceIndex));
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
    handleMarkdownComplete,
    handleRegenerate,
    handleUndo,
  };
}
