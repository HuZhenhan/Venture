import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, '../src/app/utils/messageContentProtocol.ts');
const source = readFileSync(sourcePath, 'utf8');

assert.match(source, /export function appendThinkingContent/);
assert.match(source, /export function appendVisibleContent/);

const tagPattern = /\[\/?([a-z]+)]/g;
const tagNames = new Set([
  'thinking', 'error', 'attachment', 'code', 'time', 'message', 'suggestion', 'title',
  'id', 'name', 'mime', 'size', 'kind', 'text', 'data',
]);
const controlTagPattern = /\[\/?(?:thinking|error|attachment|code|time|message|suggestion|title|id|name|mime|size|kind|text|data)]/g;

function appendText(nodes, content) {
  if (!content) return;
  const last = nodes.length > 0 ? nodes[nodes.length - 1] : null;
  if (last?.type === 'text') last.content += content;
  else nodes.push({ type: 'text', content });
}

function parseMessageContent(content) {
  const root = [];
  const stack = [];
  let cursor = 0;
  tagPattern.lastIndex = 0;
  let match;
  while ((match = tagPattern.exec(content)) !== null) {
    const name = match[1];
    if (!tagNames.has(name)) continue;
    const target = stack.length > 0 ? stack[stack.length - 1].children : root;
    appendText(target, content.slice(cursor, match.index));
    if (match[0][1] !== '/') {
      stack.push({ name, children: [] });
    } else if (stack.length > 0 && stack[stack.length - 1].name === name) {
      const completed = stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1].children : root;
      parent.push({ type: 'tag', ...completed });
    }
    cursor = tagPattern.lastIndex;
  }
  const lastTarget = stack.length > 0 ? stack[stack.length - 1].children : root;
  appendText(lastTarget, content.slice(cursor));
  while (stack.length > 0) {
    const unclosed = stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].children : root;
    parent.push({ type: 'tag', ...unclosed });
  }
  return root;
}

function getNodeText(node) {
  return node.type === 'text' ? node.content : node.children.map(getNodeText).join('');
}

function appendThinkingContent(content, delta) {
  const cleanDelta = delta.replace(controlTagPattern, '');
  if (!cleanDelta) return content;
  const close = '[/thinking]';
  if (content.endsWith(close)) return `${content.slice(0, -close.length)}${cleanDelta}${close}`;
  return `${content}[thinking]${cleanDelta}[/thinking]`;
}

function appendVisibleContent(content, delta) {
  const cleanDelta = delta.replace(controlTagPattern, '');
  return cleanDelta ? `${content}${cleanDelta}` : content;
}

let content = '';
content = appendThinkingContent(content, '[thinking]step 1');
content = appendThinkingContent(content, ' -> step 2[/thinking]');
content = appendVisibleContent(content, ' answer with leaked [/thinking] marker');

const nodes = parseMessageContent(content);
assert.equal(nodes.length, 2);
assert.equal(nodes[0].type, 'tag');
assert.equal(nodes[0].name, 'thinking');
assert.equal(getNodeText(nodes[0]), 'step 1 -> step 2');
assert.equal(nodes[1].type, 'text');
assert.equal(nodes[1].content, ' answer with leaked  marker');
assert.equal(content.includes('[/thinking] marker'), false);

const mismatched = parseMessageContent('visible[/thinking] text');
assert.deepEqual(mismatched, [{ type: 'text', content: 'visible text' }]);

console.log('messageContentProtocol validation passed');
