import { ComposerReference, ContentBlock, Message, ResourceComposerReference, ToolCall, AskForm, UploadedResource } from '../types';
import { isUploadedResourceReference } from './uploadedResources';

export type MessageContentTag =
  | 'thinking' | 'error' | 'attachment'
  | 'code' | 'time' | 'message' | 'suggestion' | 'title'
  | 'id' | 'name' | 'mime' | 'size' | 'kind' | 'text' | 'data';

export type MessageContentNode =
  | { type: 'text'; content: string }
  | { type: 'tag'; name: MessageContentTag; children: MessageContentNode[] };

const TAG_NAMES: readonly MessageContentTag[] = [
  'thinking', 'error', 'attachment', 'code', 'time', 'message', 'suggestion', 'title',
  'id', 'name', 'mime', 'size', 'kind', 'text', 'data',
];
const TAG_NAME_SET = new Set<string>(TAG_NAMES);
const TAG_PATTERN = /\[\/?([a-z]+)]/g;

function appendText(nodes: MessageContentNode[], content: string) {
  if (!content) return;
  const last = nodes[nodes.length - 1];
  if (last?.type === 'text') last.content += content;
  else nodes.push({ type: 'text', content });
}

export function parseMessageContent(content: string): MessageContentNode[] {
  const root: MessageContentNode[] = [];
  const stack: Array<{ name: MessageContentTag; children: MessageContentNode[] }> = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TAG_PATTERN.lastIndex = 0;

  while ((match = TAG_PATTERN.exec(content)) !== null) {
    const name = match[1];
    if (!TAG_NAME_SET.has(name)) continue;
    const target = stack.at(-1)?.children ?? root;
    appendText(target, content.slice(cursor, match.index));

    if (match[0][1] !== '/') {
      stack.push({ name: name as MessageContentTag, children: [] });
    } else if (stack.at(-1)?.name === name) {
      const completed = stack.pop();
      if (completed) (stack.at(-1)?.children ?? root).push({ type: 'tag', ...completed });
    } else {
      // 协议标签属于内部控制标记；流式响应重复发送闭合标签时不能泄漏到正文。
      // 失配闭合标签直接丢弃，避免 `/thinking` 等原始标记被 Markdown 渲染。
    }
    cursor = TAG_PATTERN.lastIndex;
  }

  appendText(stack.at(-1)?.children ?? root, content.slice(cursor));
  while (stack.length > 0) {
    const unclosed = stack.pop();
    if (unclosed) (stack.at(-1)?.children ?? root).push({ type: 'tag', ...unclosed });
  }
  return root;
}

export function serializeContentNodes(nodes: MessageContentNode[]): string {
  return nodes.map((node) => node.type === 'text'
    ? node.content
    : `[${node.name}]${serializeContentNodes(node.children)}[/${node.name}]`
  ).join('');
}

export function createTaggedContent(name: MessageContentTag, content: string): string {
  return `[${name}]${content}[/${name}]`;
}

export function getNodeText(node: MessageContentNode): string {
  return node.type === 'text' ? node.content : node.children.map(getNodeText).join('');
}

function childText(node: MessageContentNode, name: MessageContentTag): string {
  if (node.type !== 'tag') return '';
  return node.children
    .filter((child): child is Extract<MessageContentNode, { type: 'tag' }> => child.type === 'tag' && child.name === name)
    .map(getNodeText)
    .join('');
}

function field(name: MessageContentTag, value: string | number): string {
  return createTaggedContent(name, encodeURIComponent(String(value)));
}

function decodeField(node: MessageContentNode, name: MessageContentTag): string {
  const value = childText(node, name);
  try { return decodeURIComponent(value); } catch { return value; }
}

export function serializeAttachment(resource: UploadedResource): string {
  return createTaggedContent('attachment', [
    field('id', resource.id),
    field('name', resource.name),
    field('mime', resource.mimeType),
    field('size', resource.size),
    field('kind', resource.kind),
    resource.textContent ? field('text', resource.textContent) : '',
    createTaggedContent('data', resource.dataUrl),
  ].join(''));
}

export function parseAttachmentNode(node: MessageContentNode): UploadedResource | null {
  if (node.type !== 'tag' || node.name !== 'attachment') return null;
  const id = decodeField(node, 'id');
  const name = decodeField(node, 'name');
  const mimeType = decodeField(node, 'mime');
  const kind = decodeField(node, 'kind') as UploadedResource['kind'];
  const size = Number(decodeField(node, 'size'));
  const dataUrl = childText(node, 'data');
  const validKinds: UploadedResource['kind'][] = ['image', 'text', 'pdf', 'presentation', 'document', 'file'];
  if (!id || !name || !mimeType || !dataUrl || !Number.isFinite(size) || !validKinds.includes(kind)) return null;
  return { id, name, mimeType, size, kind, dataUrl, textContent: decodeField(node, 'text') || undefined };
}

export function attachmentToReference(resource: UploadedResource): ResourceComposerReference {
  return {
    id: resource.id,
    kind: ['text', 'document', 'pdf', 'presentation'].includes(resource.kind) ? 'doc' : 'file',
    label: resource.name,
    detail: `${resource.size} bytes`,
    description: resource.mimeType,
    resource,
  };
}

function uploadedReferences(blocks?: ContentBlock[]): ComposerReference[] {
  return (blocks ?? []).flatMap((block) => block.type === 'reference_list'
    ? block.references.filter(isUploadedResourceReference)
    : []
  );
}

export function adaptLegacyMessageContent(message: Message): string {
  if (/\[(?:thinking|error|attachment)]/.test(message.content)) return message.content;
  const protocolParts: string[] = [];
  const blocks = message.blocks ?? [];
  const textBlocks = blocks.filter((block) => block.type === 'text');

  for (const block of blocks) {
    if (block.type === 'reasoning') {
      const title = block.title ? createTaggedContent('title', block.title) : '';
      protocolParts.push(createTaggedContent('thinking', `${title}${block.content}`));
    } else if (block.type === 'text') {
      protocolParts.push(block.content);
    }
  }
  uploadedReferences(blocks).forEach((reference) => protocolParts.push(serializeAttachment(reference.resource)));
  if (textBlocks.length === 0 && message.content) protocolParts.push(message.content);
  return protocolParts.join('');
}

export function getResidualMessageBlocks(message: Message): ContentBlock[] {
  return (message.blocks ?? []).flatMap((block) => {
    if (block.type === 'text' || block.type === 'reasoning' || block.type === 'tool_call') return [];
    if (block.type !== 'reference_list') return [block];
    const references = block.references.filter((reference) => !isUploadedResourceReference(reference));
    return references.length > 0 ? [{ ...block, references }] : [];
  });
}

export function getAttachmentResources(content: string): UploadedResource[] {
  return parseMessageContent(content)
    .map(parseAttachmentNode)
    .filter((resource): resource is UploadedResource => resource !== null);
}

export function getThinkingText(content: string): string {
  return parseMessageContent(content)
    .filter((node): node is Extract<MessageContentNode, { type: 'tag' }> => node.type === 'tag' && node.name === 'thinking')
    .map((node) => node.children
      .filter((child) => child.type !== 'tag' || child.name !== 'title')
      .map(getNodeText).join(''))
    .join('\n').trim();
}

export function getVisibleText(content: string): string {
  return parseMessageContent(content).map((node) => {
    if (node.type === 'text') return node.content;
    if (node.name === 'thinking' || node.name === 'attachment') return '';
    if (node.name === 'error') return childText(node, 'message') || getNodeText(node);
    return getNodeText(node);
  }).join('').trim();
}

export interface StructuredError {
  code: string;
  time: string;
  message: string;
  suggestions: string[];
}

export function serializeError(error: StructuredError): string {
  return createTaggedContent('error', [
    createTaggedContent('code', error.code),
    createTaggedContent('time', error.time),
    createTaggedContent('message', error.message),
    ...error.suggestions.map((suggestion) => createTaggedContent('suggestion', suggestion)),
  ].join(''));
}

export function parseErrorNode(node: MessageContentNode): StructuredError | null {
  if (node.type !== 'tag' || node.name !== 'error') return null;
  const code = childText(node, 'code').trim();
  const message = childText(node, 'message').trim();
  if (!code || !message) return null;
  return {
    code,
    message,
    time: childText(node, 'time').trim(),
    suggestions: node.children
      .filter((child): child is Extract<MessageContentNode, { type: 'tag' }> => child.type === 'tag' && child.name === 'suggestion')
      .map(getNodeText).map((value) => value.trim()).filter(Boolean),
  };
}

// ─── AskUserQuestion Tool Call → AskForm 构造 ─────────────────────────────

/** 根据 ToolCall 输入构造 AskForm，供现有 AskCard/AskCardFull/AskCardInline 组件复用。 */
export function toolCallToAskForm(tool: ToolCall): AskForm | null {
  const input = tool.input as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') return null;

  const id = typeof input.id === 'string' ? input.id : tool.id;
  const question = typeof input.question === 'string' ? input.question : '';
  if (!question) return null;

  const optionsList = Array.isArray(input.options)
    ? (input.options as Array<{ id: string; label: string }>)
        .filter((opt) => opt && typeof opt.id === 'string' && typeof opt.label === 'string')
        .map((opt) => ({ id: opt.id, label: opt.label }))
    : [];

  const isSkipped = tool.output === '[skipped]';
  const isNeedsInput = tool.status === 'needs_user_input';

  let status: AskForm['status'] = 'answered';
  let answer: AskForm['answer'] | undefined;

  if (isSkipped) {
    status = 'skipped';
  } else if (isNeedsInput) {
    status = 'pending';
  } else if (tool.status === 'completed' && typeof tool.output === 'object' && tool.output !== null) {
    const out = tool.output as Record<string, unknown>;
    if (Array.isArray(out.selectedOptions) || typeof out.text === 'string') {
      answer = {
        selectedOptions: Array.isArray(out.selectedOptions) ? out.selectedOptions as string[] : undefined,
        text: typeof out.text === 'string' ? out.text : undefined,
      };
    }
  }

  return {
    id,
    question,
    options: optionsList.length > 0 ? optionsList : undefined,
    allowMultiple: input.allowMultiple === true ? true : undefined,
    requiresText: input.requiresText === true ? true : undefined,
    status,
    answer,
  };
}

