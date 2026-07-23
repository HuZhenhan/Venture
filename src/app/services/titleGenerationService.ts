import { streamChat, type ChatMessage } from './chatStreamService';

const TITLE_SYSTEM_PROMPT = [
  'You generate concise UI titles for an AI Agent product.',
  'Output only one short title with no quotes, markdown, emoji, labels, or explanation.',
  'Use the same language as the provided content when possible.',
  'Keep Chinese titles within 12 characters and English titles within 6 words.',
].join(' ');

function cleanGeneratedTitle(rawTitle: string): string | null {
  const firstLine = rawTitle
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return null;
  }

  const title = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^(标题|Title)[:：]\s*/i, '')
    .replace(/["'“”‘’`*_]/g, '')
    .replace(/[。.!！?？,，;；:：]+$/g, '')
    .trim();

  return title ? title.slice(0, 36) : null;
}

async function requestGeneratedTitle(modelId: string, userPrompt: string): Promise<string | null> {
  let content = '';
  let reasoningFallback = '';
  const messages: ChatMessage[] = [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  await streamChat(
    {
      modelId,
      messages,
      contextWindow: 2,
      temperature: 0.2,
      maxTokens: 48,
    },
    (event) => {
      if (event.event === 'content_delta') {
        content += event.data.delta;
      } else if (event.event === 'reasoning_delta') {
        reasoningFallback += event.data.delta;
      }
    }
  );

  return cleanGeneratedTitle(content) ?? cleanGeneratedTitle(reasoningFallback);
}

export async function generateConversationTitle(params: {
  modelId: string;
  userMessage: string;
  assistantMessage: string;
}): Promise<string | null> {
  const prompt = [
    'Create a short title for this conversation.',
    '',
    `User: ${Array.from(params.userMessage).slice(0, 1200).join('')}`,
    '',
    `Assistant: ${Array.from(params.assistantMessage).slice(0, 1200).join('')}`,
  ].join('\n');

  return requestGeneratedTitle(params.modelId, prompt);
}

export async function generateReasoningTitle(params: {
  modelId: string;
  reasoning: string;
  assistantMessage: string;
}): Promise<string | null> {
  const prompt = [
    'Create a short title for this completed thinking/reasoning process.',
    '',
    `Reasoning: ${Array.from(params.reasoning).slice(0, 1800).join('')}`,
    '',
    `Final answer context: ${Array.from(params.assistantMessage).slice(0, 600).join('')}`,
  ].join('\n');

  return requestGeneratedTitle(params.modelId, prompt);
}
