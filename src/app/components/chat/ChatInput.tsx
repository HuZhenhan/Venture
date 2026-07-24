import React from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Send, 
  Plus, 
  Hash,
  ChevronDown, 
  Square
} from "lucide-react";
import { useChatStore } from "../../store/useChatStore";
import { useLayoutStore } from "../../store/useLayoutStore";
import { usePreferencesStore } from "../../store/usePreferencesStore";
import { useChatComposer } from "../../hooks/useChatComposer";
import { FloatingTaskIndicator } from "../FloatingTaskIndicator";
import { APPLE_CURVE } from "../../constants";
import { ComposerReference } from "../../types";
import { mergeComposerReferences } from "../../utils/codeReferences";
import { parseDebugCommand } from "../../utils/debugCommands";
import { startClickLogging, stopClickLogging } from "../../utils/debugClickLogger";
import { ComposerReferenceMenu } from "./ComposerReferenceMenu";
import { ComposerReferencePill } from "./cards/ComposerReferencePill";
import { RichComposerEditor } from "./RichComposerEditor";
import { ACCEPTED_ATTACHMENT_TYPES } from "../../utils/uploadedResources";

interface ChatInputProps {
  inputAreaRef?: React.RefObject<HTMLDivElement>;
  onMessageSent?: () => void;
}

export function ChatInput({ inputAreaRef, onMessageSent }: ChatInputProps = {}) {
  const currentTasks = useChatStore((state) => state.currentTasks);
  const setActiveChatId = useChatStore((state) => state.setActiveChatId);
  const sendShortcut = usePreferencesStore((state) => state.sendShortcut);
  const openCodeReferenceAction = useLayoutStore((state) => state.openCodeReference);
  const openDiffAction = useLayoutStore((state) => state.openDiff);
  const setOccupancyMonitorDebug = useLayoutStore((state) => state.setOccupancyMonitorDebug);
  const setOriginalContentDebug = useLayoutStore((state) => state.setOriginalContentDebug);
  const setRawResponseDebug = useLayoutStore((state) => state.setRawResponseDebug);
  const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
  const setShowTestButton = useLayoutStore((state) => state.setShowTestButton);
  const setShowLayoutDebug = useLayoutStore((state) => state.setShowLayoutDebug);
  const [isReferenceMenuOpen, setIsReferenceMenuOpen] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const {
    availableModels,
    closeModelMenu,
    composerRef,
    draftReferences,
    draftMessage,
    draftNodes,
    editorRef,
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
  } = useChatComposer({ onMessageSent });

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(event.target as Node)) {
        setIsReferenceMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [composerRef]);

  const openComposerReference = React.useCallback((reference: ComposerReference) => {
    if (reference.kind !== "code" && reference.resource?.dataUrl) {
      window.open(reference.resource.dataUrl, "_blank", "noopener,noreferrer");
      return;
    }

    if (reference.kind === "code") {
      openCodeReferenceAction(reference.codeReference);
      return;
    }

    if (reference.kind === "chat" && reference.chatId) {
      setActiveChatId(reference.chatId);
      return;
    }

    if (reference.diffId) {
      openDiffAction(reference.diffId);
      return;
    }

    if (reference.kind === "web" && reference.url) {
      window.open(reference.url, "_blank", "noopener,noreferrer");
    }
  }, [openCodeReferenceAction, openDiffAction, setActiveChatId]);

  const handleEditorSubmit = React.useCallback(() => {
    const debugCommand = parseDebugCommand(draftMessage);
    if (debugCommand) {
      if (debugCommand.module === 'OriginalContent') {
        setOriginalContentDebug(debugCommand.enabled);
      } else if (debugCommand.module === 'RawResponse') {
        setRawResponseDebug(debugCommand.enabled);
      } else if (debugCommand.module === 'Sidebar') {
        toggleSidebar();
      } else if (debugCommand.module === 'ClickLog') {
        if (debugCommand.enabled) startClickLogging();
        else stopClickLogging();
      } else if (debugCommand.module === 'TestButton') {
        setShowTestButton(debugCommand.enabled);
      } else if (debugCommand.module === 'Layout') {
        setShowLayoutDebug(debugCommand.enabled);
      } else {
        setOccupancyMonitorDebug(debugCommand.enabled);
      }

      setDraftMessage("");
      setDraftNodes([]);
      editorRef.current?.clear();
      return;
    }

    handleSubmit();
  }, [draftMessage, editorRef, handleSubmit, setDraftMessage, setDraftNodes, setOccupancyMonitorDebug, setOriginalContentDebug, setRawResponseDebug, toggleSidebar, setShowTestButton, setShowLayoutDebug]);

  return (
    <div ref={inputAreaRef} className="absolute bottom-0 left-0 right-0 p-4 sm:p-6 pointer-events-none z-40">
      <div className="max-w-4xl mx-auto relative pointer-events-auto">
        <div className="flex items-end gap-3 w-full">
          <form 
            onSubmit={handleSubmit} 
            className="relative group flex-1 min-w-0 flex flex-col items-center w-full transition-transform duration-500 focus-within:scale-[1.01]"
          >
            <FloatingTaskIndicator tasks={currentTasks} isActive={isGenerating} />
            <div className="w-full relative mt-[-1px]">
              <AnimatePresence>
                {isReferenceMenuOpen ? (
                  <ComposerReferenceMenu
                    onClose={() => setIsReferenceMenuOpen(false)}
                    onSelect={(reference) => {
                      setDraftReferences((prev) => mergeComposerReferences(prev, [reference]));
                      setDraftNodes((prev) => [...prev, { type: "reference", referenceId: reference.id }, { type: "text", text: " " }]);
                    }}
                  />
                ) : null}
              </AnimatePresence>
              <div className={`absolute inset-0 rounded-[24px] border border-border bg-background/60 shadow-lg transition-all duration-500 ${
                isInputFocused ? 'bg-background/80 shadow-xl' : ''
              }`} />
              <div
                ref={composerRef}
                onMouseDown={(e) => {
                  if (e.target instanceof HTMLElement && e.target.closest('[data-composer-action="true"]')) {
                    return;
                  }
                  preserveComposerFocus(e);
                }}
                className={`relative flex flex-col gap-1.5 px-4 py-2.5 sm:px-5 sm:py-2.5 min-h-[56px] rounded-[24px] border border-border bg-input-background shadow-lg transition-all duration-500 ${
                  isInputFocused ? 'bg-background border-border' : ''
                }`}
              >
                {draftReferences.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    {draftReferences.map((reference) => (
                      <ComposerReferencePill
                        key={reference.id}
                        reference={reference}
                        onClick={openComposerReference}
                        onRemove={(referenceId) => {
                          setDraftReferences((prev) =>
                            prev.filter((item) => item.id !== referenceId)
                          );
                          setDraftNodes((prev) => prev.filter((node) => node.type !== "reference" || node.referenceId !== referenceId));
                        }}
                      />
                    ))}
                  </div>
                )}
                <RichComposerEditor
                  ref={editorRef}
                  references={draftReferences}
                  placeholder="发送消息给 AI..."
                  sendShortcut={sendShortcut}
                  disabled={isGenerating}
                  onDraftChange={handleDraftChange}
                  onSubmit={handleEditorSubmit}
                  onPasteFiles={handleFilesSelected}
                  onFocus={() => setIsInputFocused(true)}
                />
                <div className="flex items-center justify-between gap-3 border-t border-border pt-1.5">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-visible">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept={ACCEPTED_ATTACHMENT_TYPES}
                      className="hidden"
                      onChange={(event) => {
                        if (event.target.files) {
                          void handleFilesSelected(event.target.files);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                    <button
                      type="button"
                      data-composer-action="true"
                      onMouseDown={preserveComposerFocus}
                      onClick={() => fileInputRef.current?.click()}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground active:scale-90"
                      aria-label="上传文件"
                    >
                      <Plus size={16} strokeWidth={1.8} />
                    </button>
                    <button
                      type="button"
                      data-composer-action="true"
                      onMouseDown={preserveComposerFocus}
                      onClick={() => setIsReferenceMenuOpen((current) => !current)}
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all active:scale-90 ${
                        isReferenceMenuOpen
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      }`}
                      aria-label="打开引用菜单"
                    >
                      <Hash size={15} strokeWidth={2.1} />
                    </button>
                    <div className="relative min-w-0" ref={modelMenuRef}>
                      <button
                        type="button"
                        data-composer-action="true"
                        onMouseDown={preserveComposerFocus}
                        onClick={toggleModelMenu}
                        className="flex h-8 max-w-[44vw] sm:max-w-full items-center gap-1.5 rounded-xl px-2.5 text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground active:scale-95"
                      >
                        <span className="truncate text-[12px] font-medium tracking-tight">{selectedModel?.name || "选择模型"}</span>
                        <ChevronDown size={12} className={`shrink-0 transition-transform duration-500 ${isModelMenuOpen ? 'rotate-180' : ''}`} />
                      </button>
                      <AnimatePresence>
                        {isModelMenuOpen && (
                          <>
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] cursor-default bg-transparent" onMouseDown={closeModelMenu} />
                            <motion.div initial={{ opacity: 0, y: 10, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.96 }} transition={{ duration: 0.4, ease: APPLE_CURVE }} className="absolute bottom-full left-0 mb-3 w-52 max-w-[calc(100vw-2rem)] bg-background rounded-2xl border border-border shadow-lg overflow-hidden z-[101] p-1.5 origin-bottom-left transform-gpu antialiased" onMouseDown={(e) => e.stopPropagation()}>
                              <div className="px-3 py-2 mb-1 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.05em]">选择模型</div>
                              <div className="max-h-64 overflow-y-auto custom-scrollbar-chat px-0.5">
                                {availableModels.map((model) => (
                                  <button key={model.id} type="button" onMouseDown={(event) => handleModelSelect(event, model.id)} className="flex items-center justify-between w-full px-3 py-2.5 rounded-xl hover:bg-muted/50 active:bg-muted transition-all text-left group/item">
                                    <div className="flex flex-col gap-0.5">
                                      <span className={`text-[13px] tracking-tight transition-colors ${selectedModelId === model.id ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground group-hover/item:text-foreground'}`}>{model.name}</span>
                                      <span className="text-[10px] text-muted-foreground font-medium">{model.provider}</span>
                                    </div>
                                    {selectedModelId === model.id && <motion.div layoutId="active-model-dot" className="w-1.5 h-1.5 rounded-full bg-foreground" transition={{ type: "spring", stiffness: 500, damping: 30 }} />}
                                  </button>
                                ))}
                              </div>
                              <div className="h-[1px] bg-border my-1.5 mx-1.5" />
                              <button type="button" onMouseDown={handleOpenSettings} className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl hover:bg-muted/50 active:bg-muted transition-all text-left text-foreground group/add">
                                <div className="w-5 h-5 rounded-full bg-muted/50 flex items-center justify-center group-hover/add:bg-muted transition-colors"><Plus size={12} strokeWidth={2.5} /></div>
                                <span className="text-[13px] font-semibold tracking-tight">添加自定义模型</span>
                              </button>
                            </motion.div>
                          </>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                  <button type={isGenerating ? "button" : "button"} data-composer-action="true" onMouseDown={preserveComposerFocus} onClick={isGenerating ? handleStopGeneration : handleEditorSubmit} disabled={((!draftMessage.trim() && draftReferences.length === 0) || availableModels.length === 0) && !isGenerating} className={`relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-xl transition-all duration-300 active:scale-90 ${((draftMessage.trim() || draftReferences.length > 0) && availableModels.length > 0) || isGenerating ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground cursor-not-allowed opacity-40"}`} title={availableModels.length === 0 ? "未启用任何模型" : undefined}>
                    <AnimatePresence mode="wait">
                      {isGenerating ? (
                        <motion.div key="stop" initial={{ opacity: 0, scale: 0.5, rotate: -90 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} exit={{ opacity: 0, scale: 0.5, rotate: 90 }} transition={{ duration: 0.2, ease: "easeOut" }}><Square size={14} fill="currentColor" strokeWidth={0} /></motion.div>
                      ) : (
                        <motion.div key="send" initial={{ opacity: 1 }} exit={{ x: 20, y: -20, opacity: 0, transition: { duration: 0.3, ease: [0.34, 1.56, 0.64, 1] } }}><Send size={15} strokeWidth={2.5} /></motion.div>
                      )}
                    </AnimatePresence>
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
