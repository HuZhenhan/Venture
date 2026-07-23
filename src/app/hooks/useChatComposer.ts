import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import { useLayoutStore } from '../store/useLayoutStore';
import { useGeneration } from './useGeneration';
import { ComposerDraftNode, ComposerReference, InsertChatPayload } from '../types';
import {
  buildComposerBlocks,
  getComposerTitle,
  INSERT_CHAT_EVENT,
  mergeComposerReferences,
  serializeComposerMessage,
} from '../utils/codeReferences';
import { createUploadedResourceReference, isImageResource, readFileAsUploadedResource } from '../utils/uploadedResources';
import { debugLog, debugError } from '../utils/debugLogger';
import { toast } from 'sonner';

interface ComposerEditorHandle {
  focus: () => void;
  clear: () => void;
}

interface UseChatComposerArgs {
  onMessageSent?: () => void;
}

export function useChatComposer({ onMessageSent }: UseChatComposerArgs) {
  const apiConfigs = useChatStore((state) => state.apiConfigs);
  const activeChatId = useChatStore((state) => state.activeChatId);
  const addChat = useChatStore((state) => state.addChat);
  const appendChatMessage = useChatStore((state) => state.appendChatMessage);
  const preSelectedMode = useChatStore((state) => state.preSelectedMode);
  const draftMessage = useChatStore((state) => state.draftMessage);
  const setDraftMessage = useChatStore((state) => state.setDraftMessage);
  const draftNodes = useChatStore((state) => state.draftNodes);
  const setDraftNodes = useChatStore((state) => state.setDraftNodes);
  const draftReferences = useChatStore((state) => state.draftReferences);
  const setDraftReferences = useChatStore((state) => state.setDraftReferences);
  const generatingChatId = useChatStore((state) => state.generatingChatId);
  const showPanel = useLayoutStore((state) => state.showPanel);
  const { triggerAIResponse, handleStopGeneration } = useGeneration();

  const editorRef = useRef<ComposerEditorHandle>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);

  const isGenerating = generatingChatId !== null;

  const availableModels = useMemo(() => (
    apiConfigs.flatMap((config) =>
      config.models.filter((model) => model.enabled).map((model) => ({
        id: model.id,
        name: model.name,
        provider: config.name,
        supportsMultimodal: model.supportsMultimodal ?? false,
      })),
    )
  ), [apiConfigs]);

  const [selectedModelId, setSelectedModelId] = useState(availableModels[0]?.id || '');

  const selectedModel = useMemo(
    () => availableModels.find((model) => model.id === selectedModelId)
      || null,
    [availableModels, selectedModelId],
  );

  const focusComposer = useCallback(() => {
    setIsInputFocused(true);
    editorRef.current?.focus();
  }, []);

  const preserveComposerFocus = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    focusComposer();
  }, [focusComposer]);

  const closeModelMenu = useCallback(() => {
    setIsModelMenuOpen(false);
  }, []);

  const toggleModelMenu = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setIsModelMenuOpen((current) => !current);
  }, []);

  const handleModelSelect = useCallback((event: React.MouseEvent, modelId: string) => {
    event.preventDefault();
    focusComposer();
    setSelectedModelId(modelId);
    closeModelMenu();
  }, [closeModelMenu, focusComposer]);

  const handleOpenSettings = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    focusComposer();
    closeModelMenu();
    showPanel('settings');
  }, [closeModelMenu, focusComposer, showPanel]);

  const handleDraftChange = useCallback((text: string, nodes: ComposerDraftNode[]) => {
    setDraftMessage(text);
    setDraftNodes(nodes);
    const referenceIds = new Set(nodes.filter((node) => node.type === 'reference').map((node) => node.referenceId));
    setDraftReferences((previous) => {
      const next = previous.filter((reference) => referenceIds.has(reference.id));
      return next.length === previous.length ? previous : next;
    });
  }, [setDraftMessage, setDraftNodes, setDraftReferences]);

  const handleFilesSelected = useCallback(async (files: File[] | FileList) => {
    const incoming = Array.from(files);
    debugLog('upload', 'handleFilesSelected called', {
      count: incoming.length,
      files: incoming.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    });
    if (incoming.length === 0) return;

    if (!isMountedRef.current) {
      debugLog('upload', 'skip: not mounted');
      return;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const currentSupportsImages = selectedModel?.supportsMultimodal ?? false;
    const nextReferences: ComposerReference[] = [];

    for (const file of incoming) {
      if (signal.aborted) {
        debugLog('upload', 'aborted before reading', { file: file.name });
        return;
      }

      try {
        debugLog('upload', 'reading file start', { name: file.name, size: file.size });
        const resource = await readFileAsUploadedResource(file);
        debugLog('upload', 'reading file done', {
          name: file.name,
          kind: resource.kind,
          dataUrlLength: resource.dataUrl?.length ?? 0,
        });
        if (signal.aborted) {
          debugLog('upload', 'aborted after reading', { file: file.name });
          return;
        }

        const reference = createUploadedResourceReference(resource);

        if (isImageResource(reference) && !currentSupportsImages) {
          debugLog('upload', 'image blocked (no multimodal)', { name: file.name });
          window.alert('当前模型未开启多模态能力，无法上传图片。请在模型设置中开启多模态，或切换支持图片的模型。');
          continue;
        }

        nextReferences.push(reference);
      } catch (error) {
        debugError('upload', 'read file failed', { name: file.name, error });
        if (signal.aborted) return;
        toast.error(error instanceof Error ? error.message : '读取文件失败');
      }
    }

    if (signal.aborted || !isMountedRef.current || nextReferences.length === 0) {
      debugLog('upload', 'skip commit', {
        aborted: signal.aborted,
        mounted: isMountedRef.current,
        pending: nextReferences.length,
      });
      return;
    }

    debugLog('upload', 'commit references', {
      count: nextReferences.length,
      ids: nextReferences.map((r) => r.id),
    });
    setDraftReferences((previous) => mergeComposerReferences(previous, nextReferences));
    focusComposer();
    debugLog('upload', 'commit done');
  }, [focusComposer, selectedModel?.supportsMultimodal, setDraftReferences]);

  const handleSubmit = useCallback((event?: React.FormEvent) => {
    event?.preventDefault();
    const trimmedInput = draftMessage.trim();
    const hasReferences = draftReferences.length > 0;
    if ((!trimmedInput && !hasReferences) || isGenerating) {
      return;
    }

    if (availableModels.length === 0) {
      toast.error('未找到可用模型，请先在设置中添加并启用模型。');
      return;
    }

    if (!selectedModelId) {
      toast.error('请先选择一个模型。');
      return;
    }

    const serializedContent = serializeComposerMessage(trimmedInput, draftReferences, draftNodes);
    const messageBlocks = buildComposerBlocks(trimmedInput, draftReferences, draftNodes);

    let targetChatId = activeChatId;
    if (!targetChatId) {
      const newChat = {
        id: crypto.randomUUID(),
        title: getComposerTitle(trimmedInput, draftReferences),
        mode: preSelectedMode,
        messages: [],
      };
      addChat(newChat);
      targetChatId = newChat.id;
    }

    appendChatMessage(targetChatId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: serializedContent,
      blocks: messageBlocks,
    });

    setDraftMessage('');
    setDraftNodes([]);
    setDraftReferences([]);
    editorRef.current?.clear();
    onMessageSent?.();
    void triggerAIResponse(targetChatId, selectedModelId).catch((err) => {
      debugError('composer', 'triggerAIResponse failed', { error: err });
    });
  }, [
    activeChatId,
    addChat,
    appendChatMessage,
    availableModels.length,
    draftReferences,
    draftNodes,
    draftMessage,
    isGenerating,
    onMessageSent,
    preSelectedMode,
    selectedModelId,
    setDraftReferences,
    setDraftMessage,
    setDraftNodes,
    triggerAIResponse,
  ]);

  useEffect(() => {
    const currentModelIds = apiConfigs.flatMap((config) =>
      config.models.filter((model) => model.enabled).map((model) => model.id),
    );

    if (currentModelIds.length > 0) {
      setSelectedModelId((current) => (currentModelIds.includes(current) ? current : currentModelIds[0]));
    }
  }, [apiConfigs]);

  useEffect(() => {
    const handleInsert = (event: Event) => {
      const customEvent = event as CustomEvent<InsertChatPayload | string>;
      const detail = typeof customEvent.detail === 'string'
        ? { text: customEvent.detail }
        : (customEvent.detail ?? {});

      if (detail.text) {
        setDraftMessage((previous) => (previous ? `${previous}\n\n${detail.text}` : detail.text ?? ''));
        setDraftNodes((previous) => [
          ...previous,
          { type: 'text', text: previous.length > 0 ? `\n\n${detail.text}` : detail.text ?? '' },
        ]);
      }
      if (detail.references?.length) {
        setDraftReferences((previous) => mergeComposerReferences(previous, detail.references ?? []));
      }
      focusComposer();
    };

    document.addEventListener(INSERT_CHAT_EVENT, handleInsert);
    return () => document.removeEventListener(INSERT_CHAT_EVENT, handleInsert);
  }, [focusComposer, setDraftMessage, setDraftNodes, setDraftReferences]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(event.target as Node)) {
        setIsInputFocused(false);
      }
      if (isModelMenuOpen && modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        closeModelMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [closeModelMenu, isModelMenuOpen]);

  return {
    availableModels,
    closeModelMenu,
    composerRef,
    draftReferences,
    draftMessage,
    draftNodes,
    editorRef,
    focusComposer,
    handleDraftChange,
    handleFilesSelected,
    handleOpenSettings,
    handleModelSelect,
    handleStopGeneration,
    handleSubmit,
    isGenerating,
    isInputFocused,
    isModelMenuOpen,
    modelMenuRef,
    preserveComposerFocus,
    selectedModel,
    selectedModelId,
    setDraftReferences,
    setDraftMessage,
    setDraftNodes,
    setIsInputFocused,
    toggleModelMenu,
  };
}
