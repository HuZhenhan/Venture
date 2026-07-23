import {
  CodeReference,
  ComposerDraftNode,
  ComposerReference,
  ContentBlock,
  ResourceComposerReference,
} from "../types";
import { ChatMessageContentPart } from "../services/chatStreamService";
import { isUploadedResourceReference } from "./uploadedResources";
import {
  getAttachmentResources,
  getVisibleText,
  serializeAttachment,
} from "./messageContentProtocol";

export const INSERT_CHAT_EVENT = "insert-chat";

export function getCodeReferenceSignature(reference: CodeReference) {
  return `${reference.diffId}:${reference.selectionStart}:${reference.selectionEnd}`;
}

export function createCodeComposerReference(reference: CodeReference): ComposerReference {
  return {
    id: reference.id,
    kind: "code",
    label: reference.fileName,
    detail: formatCodeReferenceLocation(reference),
    description: reference.excerpt.trim().split("\n")[0],
    codeReference: reference,
  };
}

export function getComposerReferenceSignature(reference: ComposerReference) {
  if (reference.kind === "code") {
    return `code:${getCodeReferenceSignature(reference.codeReference)}`;
  }

  if (reference.kind === "web") {
    return `web:${reference.url ?? reference.label}`;
  }

  if (reference.kind === "chat") {
    return `chat:${reference.chatId ?? reference.label}`;
  }

  return `${reference.kind}:${reference.filePath ?? reference.detail ?? reference.label}`;
}

export function mergeComposerReferences(
  existing: ComposerReference[],
  incoming: ComposerReference[],
) {
  const seen = new Set(existing.map(getComposerReferenceSignature));
  const merged = [...existing];

  incoming.forEach((reference) => {
    const signature = getComposerReferenceSignature(reference);
    if (!seen.has(signature)) {
      seen.add(signature);
      merged.push(reference);
    }
  });

  return merged;
}

export function formatCodeReferenceLocation(reference: CodeReference) {
  return reference.startLine === reference.endLine
    ? `${reference.fileName}:${reference.startLine}`
    : `${reference.fileName}:${reference.startLine}-${reference.endLine}`;
}

function serializeCodeReference(reference: CodeReference) {
  return [
    `引用代码 ${formatCodeReferenceLocation(reference)}`,
    `\`\`\`${reference.language}`,
    reference.excerpt,
    "```",
  ].join("\n");
}

function serializeResourceReference(reference: ResourceComposerReference) {
  if (reference.resource) {
    const { resource } = reference;
    const segments = [
      `引用资源 ${resource.name}`,
      `类型: ${resource.mimeType || resource.kind}`,
      `大小: ${resource.size} bytes`,
    ];

    if (resource.textContent) {
      segments.push("内容:", resource.textContent);
    }

    return segments.join("\n");
  }

  const segments = [`引用${getReferenceTypeLabel(reference.kind)} ${reference.label}`];

  if (reference.detail && reference.detail !== reference.label) {
    segments.push(reference.detail);
  }

  if (reference.kind === "web" && reference.url) {
    segments.push(reference.url);
  }

  return segments.join("\n");
}

function serializeComposerReference(reference: ComposerReference) {
  if (reference.kind === "code") {
    return serializeCodeReference(reference.codeReference);
  }

  return serializeResourceReference(reference);
}

export function draftNodesToText(nodes: ComposerDraftNode[], references: ComposerReference[]) {
  if (nodes.length === 0) return "";
  const referenceMap = new Map(references.map((reference) => [reference.id, reference]));

  return nodes.map((node) => {
    if (node.type === "text") return node.text;
    const reference = referenceMap.get(node.referenceId);
    return reference ? `【资源: ${reference.label}】` : "";
  }).join("").trim();
}

export function getReferenceTypeLabel(kind: ComposerReference["kind"]) {
  switch (kind) {
    case "code":
      return "代码";
    case "file":
      return "文件";
    case "folder":
      return "文件夹";
    case "doc":
      return "文档";
    case "chat":
      return "对话";
    case "symbol":
      return "符号";
    case "rule":
      return "规则";
    case "problem":
      return "问题";
    case "web":
      return "网页";
    default:
      return "引用";
  }
}

export function serializeComposerMessage(
  text: string,
  references: ComposerReference[],
  nodes: ComposerDraftNode[] = [],
) {
  const sections: string[] = [];
  const nodeText = draftNodesToText(nodes, references);
  const trimmedText = (nodeText || text).trim();

  if (trimmedText) {
    sections.push(trimmedText);
  }

  if (references.length > 0) {
    const uploaded = references.filter(isUploadedResourceReference);
    const regular = references.filter((reference) => !isUploadedResourceReference(reference));
    if (regular.length > 0) {
      sections.push(regular.map(serializeComposerReference).join("\n\n"));
    }
    sections.push(...uploaded.map((reference) => serializeAttachment(reference.resource)));
  }

  return sections.join("\n\n").trim();
}

export function buildComposerBlocks(
  text: string,
  references: ComposerReference[],
  nodes: ComposerDraftNode[] = [],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const nodeText = draftNodesToText(nodes, references);
  const trimmedText = (nodeText || text).trim();

  const regularReferences = references.filter((reference) => !isUploadedResourceReference(reference));
  if (regularReferences.length > 0) {
    blocks.push({ type: "reference_list", references: regularReferences });
  }

  if (trimmedText) {
    blocks.push({ type: "text", content: trimmedText });
  }

  return blocks;
}

export function getComposerTitle(text: string, references: ComposerReference[]) {
  const trimmedText = text.trim();
  if (trimmedText) {
    return trimmedText.slice(0, 30) + (trimmedText.length > 30 ? "..." : "");
  }

  if (references.length > 0) {
    return `引用 ${references[0].label}`;
  }

  return "新对话";
}

export function buildChatMessageContentFromProtocol(
  content: string,
  modelSupportsMultimodal: boolean,
): string | ChatMessageContentPart[] {
  const references = getAttachmentResources(content).map((resource): ResourceComposerReference => ({
    id: resource.id,
    kind: ['text', 'document', 'pdf', 'presentation'].includes(resource.kind) ? 'doc' : 'file',
    label: resource.name,
    detail: `${resource.size} bytes`,
    description: resource.mimeType,
    resource,
  }));
  return buildChatMessageContentParts(getVisibleText(content), references, modelSupportsMultimodal);
}

export function buildChatMessageContentParts(
  text: string,
  references: ComposerReference[],
  modelSupportsMultimodal: boolean,
  nodes: ComposerDraftNode[] = [],
): string | ChatMessageContentPart[] {
  const parts: ChatMessageContentPart[] = [];
  const trimmedText = (draftNodesToText(nodes, references) || text).trim();

  if (trimmedText) {
    parts.push({ type: "text", text: trimmedText });
  }

  references.forEach((reference) => {
    if (!isUploadedResourceReference(reference)) return;
    const { resource } = reference;

    if (resource.kind === "image" && modelSupportsMultimodal) {
      parts.push({ type: "image_url", image_url: { url: resource.dataUrl } });
      return;
    }

    if (resource.kind === "text" && resource.textContent) {
      parts.push({
        type: "text",
        text: `文件 ${resource.name} 的内容:\n${resource.textContent}`,
      });
      return;
    }

    parts.push({
      type: "text",
      text: [
        `用户上传了资源 ${resource.name}`,
        `类型: ${resource.mimeType || resource.kind}`,
        `大小: ${resource.size} bytes`,
        "当前聊天接口不支持直接解析该二进制文件；如果需要识别正文，请要求用户粘贴文本内容，或使用支持文件上传/文件 URL 的模型接口。",
      ].join("\n"),
    });
  });

  if (parts.length === 0) return "";
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}
