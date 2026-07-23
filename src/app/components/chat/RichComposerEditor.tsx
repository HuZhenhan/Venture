import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { ComposerDraftNode, ComposerReference } from "../../types";
import { isUploadedResourceReference } from "../../utils/uploadedResources";
import { debugLog, debugError } from "../../utils/debugLogger";

export interface RichComposerEditorHandle {
  focus: () => void;
  clear: () => void;
}

interface RichComposerEditorProps {
  references: ComposerReference[];
  placeholder: string;
  sendShortcut: boolean;
  disabled?: boolean;
  onDraftChange: (text: string, nodes: ComposerDraftNode[]) => void;
  onSubmit: () => void;
  onPasteFiles: (files: File[]) => void;
  onFocus: () => void;
}

function getReferenceText(reference: ComposerReference) {
  return `【资源: ${reference.label}】`;
}

function createTokenElement(reference: ComposerReference) {
  const token = document.createElement("span");
  token.contentEditable = "false";
  token.dataset.referenceId = reference.id;
  token.dataset.referenceLabel = reference.label;
  token.className = "mx-0.5 inline-flex max-w-[220px] select-all items-center gap-1 rounded-md border border-border bg-background/85 px-1.5 py-0.5 align-middle text-[12px] font-medium text-foreground shadow-sm";

  const icon = document.createElement("span");
  icon.className = "flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/70 text-[10px] text-muted-foreground";

  if (isUploadedResourceReference(reference) && reference.resource.kind === "image") {
    const img = document.createElement("img");
    img.src = reference.resource.dataUrl;
    img.alt = "";
    img.className = "h-full w-full object-cover";
    img.onerror = () => {
      img.style.display = 'none';
    };
    icon.appendChild(img);
  } else {
    icon.textContent = "file";
  }

  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = reference.label;

  token.appendChild(icon);
  token.appendChild(label);
  return token;
}

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function appendReferenceToken(root: HTMLElement, reference: ComposerReference) {
  if (root.querySelector(`[data-reference-id="${CSS.escape(reference.id)}"]`)) return;
  const token = createTokenElement(reference);
  if (root.textContent && !root.textContent.endsWith(" ")) {
    root.appendChild(document.createTextNode(" "));
  }
  root.appendChild(token);
  root.appendChild(document.createTextNode(" "));
  placeCaretAtEnd(root);
}

function parseDraft(root: HTMLElement, references: ComposerReference[]) {
  const referenceMap = new Map(references.map((reference) => [reference.id, reference]));
  const nodes: ComposerDraftNode[] = [];

  const walk = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text) nodes.push({ type: "text", text });
      return;
    }

    if (!(node instanceof HTMLElement)) return;

    const referenceId = node.dataset.referenceId;
    if (referenceId) {
      nodes.push({ type: "reference", referenceId });
      return;
    }

    if (node.tagName === "BR") {
      nodes.push({ type: "text", text: "\n" });
      return;
    }

    node.childNodes.forEach(walk);
    if (node.tagName === "DIV" || node.tagName === "P") {
      nodes.push({ type: "text", text: "\n" });
    }
  };

  root.childNodes.forEach(walk);
  const text = nodes.map((node) => {
    if (node.type === "text") return node.text;
    const reference = referenceMap.get(node.referenceId);
    return reference ? getReferenceText(reference) : "";
  }).join("").trim();

  return { text, nodes };
}

export const RichComposerEditor = forwardRef<RichComposerEditorHandle, RichComposerEditorProps>(
  function RichComposerEditor({
    references,
    placeholder,
    sendShortcut,
    disabled,
    onDraftChange,
    onSubmit,
    onPasteFiles,
    onFocus,
  }, ref) {
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const onDraftChangeRef = useRef(onDraftChange);
    onDraftChangeRef.current = onDraftChange;
    const effectRunCountRef = useRef(0);

    const emitDraftChange = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) return;
      try {
        const draft = parseDraft(editor, references);
        debugLog('editor', 'emitDraftChange', {
          textLength: draft.text.length,
          nodeCount: draft.nodes.length,
        });
        onDraftChangeRef.current(draft.text, draft.nodes);
      } catch (error) {
        debugError('editor', 'emitDraftChange failed', error);
        throw error;
      }
    }, [references]);

    useImperativeHandle(ref, () => ({
      focus: () => editorRef.current?.focus(),
      clear: () => {
        debugLog('editor', 'clear called');
        if (editorRef.current) {
          editorRef.current.innerHTML = "";
          onDraftChangeRef.current("", []);
        }
      },
    }), []);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;

      effectRunCountRef.current += 1;
      const runId = effectRunCountRef.current;
      debugLog('editor', 'sync effect run', {
        runId,
        referenceCount: references.length,
        referenceIds: references.map((r) => r.id),
      });

      let changed = false;

      try {
        references.forEach((reference) => {
          if (!editor.querySelector(`[data-reference-id="${CSS.escape(reference.id)}"]`)) {
            debugLog('editor', 'append token', { runId, id: reference.id, kind: reference.kind });
            appendReferenceToken(editor, reference);
            changed = true;
          }
        });

        editor.querySelectorAll<HTMLElement>("[data-reference-id]").forEach((token) => {
          const id = token.dataset.referenceId;
          if (id && !references.some((reference) => reference.id === id)) {
            debugLog('editor', 'remove token', { runId, id });
            token.remove();
            changed = true;
          }
        });

        if (changed) {
          const draft = parseDraft(editor, references);
          debugLog('editor', 'sync effect emit onDraftChange', {
            runId,
            textLength: draft.text.length,
            nodeCount: draft.nodes.length,
          });
          onDraftChangeRef.current(draft.text, draft.nodes);
        } else {
          debugLog('editor', 'sync effect no-op', { runId });
        }
      } catch (error) {
        debugError('editor', 'sync effect failed', { runId, error });
        throw error;
      }
    }, [references]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      const shouldSend = sendShortcut
        ? event.key === "Enter" && !event.shiftKey
        : event.key === "Enter" && !event.shiftKey && (event.metaKey || event.ctrlKey);

      if (shouldSend && !composingRef.current) {
        event.preventDefault();
        onSubmit();
      }
    };

    const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        onPasteFiles(files);
      }
    };

    return (
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className="min-h-[22px] max-h-40 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent p-0 text-left text-[15px] leading-[1.5] text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] custom-scrollbar-chat"
        role="textbox"
        aria-multiline="true"
        onFocus={onFocus}
        onInput={emitDraftChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
      />
    );
  },
);
