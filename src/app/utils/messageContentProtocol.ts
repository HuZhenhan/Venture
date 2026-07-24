import { AskForm, AskOption, ComposerReference, ContentBlock, Message, ResourceComposerReference, UploadedResource } from '../types';
import { isUploadedResourceReference } from './uploadedResources';

export type MessageContentTag =
  | 'thinking' | 'error' | 'attachment'
  | 'code' | 'time' | 'message' | 'suggestion' | 'title'
  | 'id' | 'name' | 'mime' | 'size' | 'kind' | 'text' | 'data'
  | 'ask' | 'question' | 'option' | 'label' | 'answer' | 'selected' | 'multiple' | 'textinput' | 'skipped'
  | 'reply';

export type MessageContentNode =
  | { type: 'text'; content: string }
  | { type: 'tag'; name: MessageContentTag; children: MessageContentNode[] };

const TAG_NAMES: readonly MessageContentTag[] = [
  'thinking', 'error', 'attachment', 'code', 'time', 'message', 'suggestion', 'title',
  'id', 'name', 'mime', 'size', 'kind', 'text', 'data',
  'ask', 'question', 'option', 'label', 'answer', 'selected', 'multiple', 'textinput', 'skipped',
  'reply',
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
  if (/\[(?:thinking|error|attachment|ask)]/.test(message.content)) return message.content;
  const protocolParts: string[] = [];
  const blocks = message.blocks ?? [];
  const textBlocks = blocks.filter((block) => block.type === 'text');

  for (const block of blocks) {
    if (block.type === 'reasoning') {
      const title = block.title ? createTaggedContent('title', block.title) : '';
      protocolParts.push(createTaggedContent('thinking', `${title}${block.content}`));
    } else if (block.type === 'text') {
      protocolParts.push(block.content);
    } else if (block.type === 'ask') {
      protocolParts.push(serializeAsk(block.ask));
    }
  }
  uploadedReferences(blocks).forEach((reference) => protocolParts.push(serializeAttachment(reference.resource)));
  if (textBlocks.length === 0 && message.content) protocolParts.push(message.content);
  return protocolParts.join('');
}

export function getResidualMessageBlocks(message: Message): ContentBlock[] {
  return (message.blocks ?? []).flatMap((block) => {
    if (block.type === 'text' || block.type === 'reasoning' || block.type === 'ask') return [];
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
    if (node.name === 'ask') return formatAskVisibleText(node);
    return getNodeText(node);
  }).join('').trim();
}

export function setThinkingTitle(content: string, title: string): string {
  const nodes = parseMessageContent(content);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.type !== 'tag' || node.name !== 'thinking') continue;
    node.children = [
      { type: 'tag', name: 'title', children: [{ type: 'text', content: title }] },
      ...node.children.filter((child) => child.type !== 'tag' || child.name !== 'title'),
    ];
    break;
  }
  return serializeContentNodes(nodes);
}

export function closeOpenThinking(content: string): string {
  return content.endsWith('[/thinking]') || !content.includes('[thinking]') ? content : `${content}[/thinking]`;
}

function stripUpstreamThinkingMarkers(delta: string): string {
  // reasoning_content 已由本地协议包裹；部分兼容 OpenAI 的上游仍会在字段内输出同名标记。
  // 只移除控制标记，绝不删除其中的推理文本。
  return delta.replace(/\[\/?thinking\]/gi, '');
}

// 补丁：兼容少数模型在输出中重复生成 thinking 控制标签，只保留第一对标签。
export function keepFirstThinkingPair(content: string): string {
  const openPattern = /\[thinking\]/i;
  const closePattern = /\[\/thinking\]/i;
  const openMatch = openPattern.exec(content);
  if (!openMatch) return content.replace(/\[\/thinking\]/gi, '');

  const openIndex = openMatch.index;
  const contentStart = openIndex + openMatch[0].length;
  const closeMatch = closePattern.exec(content.slice(contentStart));
  const closeIndex = closeMatch ? contentStart + closeMatch.index : -1;
  const prefix = content.slice(0, openIndex);
  const thinking = content
    .slice(contentStart, closeIndex === -1 ? content.length : closeIndex)
    .replace(/\[\/?thinking\]/gi, '');
  const suffix = closeIndex === -1
    ? ''
    : content.slice(closeIndex + closeMatch![0].length).replace(/\[\/?thinking\]/gi, '');
  return `${prefix}[thinking]${thinking}[/thinking]${suffix}`;
}

export function appendThinkingContent(content: string, delta: string): string {
  const normalizedDelta = stripUpstreamThinkingMarkers(delta);
  if (!normalizedDelta) return content;
  return !content.includes('[thinking]') || content.endsWith('[/thinking]')
    ? `${content}[thinking]${normalizedDelta}`
    : `${content}${normalizedDelta}`;
}

export function appendVisibleContent(content: string, delta: string): string {
  return `${closeOpenThinking(content)}${stripUpstreamThinkingMarkers(delta)}`;
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

// ─── Ask Tool (question/answer protocol) ─────────────────────────────────────

export function serializeAsk(ask: AskForm): string {
  const parts: string[] = [
    field('id', ask.id),
    field('question', ask.question),
  ];
  if (ask.options) {
    for (const opt of ask.options) {
      parts.push(createTaggedContent('option', [
        field('id', opt.id),
        field('label', opt.label),
      ].join('')));
    }
  }
  if (ask.allowMultiple) parts.push(createTaggedContent('multiple', '1'));
  if (ask.requiresText) parts.push(createTaggedContent('textinput', '1'));
  if (ask.status === 'answered' && ask.answer) {
    const answerParts: string[] = [];
    if (ask.answer.selectedOptions) {
      for (const optId of ask.answer.selectedOptions) {
        answerParts.push(field('selected', optId));
      }
    }
    if (ask.answer.text) answerParts.push(field('text', ask.answer.text));
    parts.push(createTaggedContent('answer', answerParts.join('')));
  } else if (ask.status === 'skipped') {
    parts.push(createTaggedContent('skipped', '1'));
  }
  return createTaggedContent('ask', parts.join(''));
}

export function parseAskNode(node: MessageContentNode): AskForm | null {
  if (node.type !== 'tag' || node.name !== 'ask') return null;
  const id = decodeField(node, 'id');
  const question = decodeField(node, 'question');
  if (!id || !question) return null;

  const options: AskOption[] = node.children
    .filter((child): child is Extract<MessageContentNode, { type: 'tag' }> => child.type === 'tag' && child.name === 'option')
    .map((optNode) => ({
      id: decodeField(optNode, 'id'),
      label: decodeField(optNode, 'label'),
    }))
    .filter((opt) => opt.id && opt.label);

  const allowMultiple = childText(node, 'multiple').trim() === '1';
  const requiresText = childText(node, 'textinput').trim() === '1';

  const answerNode = node.children.find(
    (child): child is Extract<MessageContentNode, { type: 'tag' }> => child.type === 'tag' && child.name === 'answer',
  );

  const skippedNode = node.children.find(
    (child): child is Extract<MessageContentNode, { type: 'tag' }> => child.type === 'tag' && child.name === 'skipped',
  );

  let status: AskForm['status'] = 'pending';
  let answer: AskForm['answer'] | undefined;

  if (skippedNode && childText(skippedNode, '').trim() === '1') {
    status = 'skipped';
  } else if (answerNode) {
    status = 'answered';
    const selectedOptions = answerNode.children
      .filter((child): child is Extract<MessageContentNode, { type: 'tag' }> => child.type === 'tag' && child.name === 'selected')
      .map((child) => {
        const value = getNodeText(child);
        try { return decodeURIComponent(value); } catch { return value; }
      })
      .filter(Boolean);
    const text = decodeField(answerNode, 'text');
    answer = {
      selectedOptions: selectedOptions.length > 0 ? selectedOptions : undefined,
      text: text || undefined,
    };
  }

  return {
    id,
    question,
    options: options.length > 0 ? options : undefined,
    allowMultiple: allowMultiple || undefined,
    requiresText: requiresText || undefined,
    status,
    answer,
  };
}

export function getAskForms(content: string): AskForm[] {
  return parseMessageContent(content)
    .map(parseAskNode)
    .filter((ask): ask is AskForm => ask !== null);
}

export function setAskAnswer(
  content: string,
  askId: string,
  answer: { selectedOptions?: string[]; text?: string },
): string {
  const nodes = parseMessageContent(content);
  for (const node of nodes) {
    if (node.type !== 'tag' || node.name !== 'ask') continue;
    if (decodeField(node, 'id') !== askId) continue;

    // Remove any existing answer or skipped tags
    node.children = node.children.filter(
      (child) => !(child.type === 'tag' && (child.name === 'answer' || child.name === 'skipped')),
    );

    const answerChildren: MessageContentNode[] = [];
    if (answer.selectedOptions) {
      for (const optId of answer.selectedOptions) {
        answerChildren.push({
          type: 'tag',
          name: 'selected',
          children: [{ type: 'text', content: encodeURIComponent(optId) }],
        });
      }
    }
    if (answer.text) {
      answerChildren.push({
        type: 'tag',
        name: 'text',
        children: [{ type: 'text', content: encodeURIComponent(answer.text) }],
      });
    }
    node.children.push({ type: 'tag', name: 'answer', children: answerChildren });
    break;
  }
  return serializeContentNodes(nodes);
}

export function skipAsk(content: string, askId: string): string {
  const nodes = parseMessageContent(content);
  for (const node of nodes) {
    if (node.type !== 'tag' || node.name !== 'ask') continue;
    if (decodeField(node, 'id') !== askId) continue;

    // Remove any existing answer or skipped tags
    node.children = node.children.filter(
      (child) => !(child.type === 'tag' && (child.name === 'answer' || child.name === 'skipped')),
    );

    node.children.push({ type: 'tag', name: 'skipped', children: [{ type: 'text', content: '1' }] });
    break;
  }
  return serializeContentNodes(nodes);
}

function formatAskVisibleText(node: MessageContentNode): string {
  const ask = parseAskNode(node);
  if (!ask) return '';
  if (ask.status === 'answered' && ask.answer) {
    const selectedLabels = (ask.answer.selectedOptions || [])
      .map((id) => ask.options?.find((o) => o.id === id)?.label || id);
    const parts: string[] = [
      field('question', ask.question),
    ];
    if (selectedLabels.length > 0) parts.push(field('answer', selectedLabels.join(', ')));
    if (ask.answer.text) parts.push(field('text', ask.answer.text));
    return createTaggedContent('reply', parts.join(''));
  } else if (ask.status === 'skipped') {
    return createTaggedContent('reply', [
      field('question', ask.question),
      field('skipped', '1'),
    ].join(''));
  }
  // Pending ask (should not normally be sent to model, but just in case)
  return createTaggedContent('reply', [
    field('question', ask.question),
    field('status', 'pending'),
  ].join(''));
}