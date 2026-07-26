import { Chat, CodeDiff, APIConfig } from '../types';

export const INITIAL_CHATS: Chat[] = [
  {
    id: '1',
    title: '关于设计哲学的探讨',
    mode: 'agent',
    messages: [
      { 
        id: 'm1', 
        role: 'user', 
        content: '你好，请自我介绍一下，顺便展示一下你的各种操作卡片。',
        blocks: [{ type: 'text', content: '你好，请自我介绍一下，顺便展示一下你的各种操作卡片。' }]
      },
      { 
        id: 'm2', 
        role: 'ai', 
        content: '你好，有什么我可以帮助你的吗？\n\n以下是我的各种操作卡片演示：',
        blocks: [
          { 
            type: 'reasoning', 
            content: '用户要求自我介绍，并展示各种操作卡片。我需要以 AI 助手的身份进行回复，体现出极致的 Apple 极简主义设计感，并在后续块中添加网页搜索、文件操作、Skill调用和询问卡片。',
            status: 'done'
          },
          {
            type: 'text',
            content: '你好。\n\n我是一个追求极致性能与设计美学平衡的智能系统。在这里，我将协助你以最纯粹、高效的方式处理复杂逻辑，并在灰阶与光影的交互中，共同探索智能的边界。\n\n以下是我的各种操作卡片演示：'
          },
          {
            type: 'web_search',
            search: {
              id: 'ws-1',
              query: 'Apple Design Guidelines 2026',
              status: 'completed',
              results: [
                { title: 'Human Interface Guidelines - Apple Developer', url: 'https://developer.apple.com/design/', snippet: 'Get in-depth information and UI resources for designing great apps that integrate seamlessly with Apple platforms.' }
              ]
            }
          },
          {
            type: 'search_op',
            searchOp: {
              id: 'so-1',
              type: 'file',
              query: 'LegacyButton.tsx',
              status: 'completed',
              results: [
                { path: 'src/old_components/LegacyButton.tsx' }
              ]
            }
          },
          {
            type: 'search_op',
            searchOp: {
              id: 'so-2',
              type: 'code',
              query: 'LegacyButton',
              status: 'completed',
              results: [
                { path: 'src/old_components/LegacyButton.tsx', line: 4, match: 'export function LegacyButton() {\n  return <button>Legacy</button>;\n}' }
              ]
            }
          },
          {
            type: 'file_op',
            fileOp: {
              id: 'fo-1',
              type: 'delete',
              source: 'src/old_components/LegacyButton.tsx',
              status: 'requires_confirmation'
            }
          },
          {
            type: 'skill',
            skill: {
              id: 'sk-1',
              name: 'figma-generate-design',
              status: 'completed',
              params: '{\n  "target": "ChatCard",\n  "style": "minimalist"\n}',
              output: 'Design generated successfully. View URL: figma.com/file/...'
            }
          },
          {
            type: 'ask',
            ask: {
              id: 'ask-1',
              question: '你希望为这些卡片选择哪种主题配色？',
              options: [
                { id: 'opt-light', label: '深空灰 (Dark Space Gray)' },
                { id: 'opt-dark', label: '银泽白 (Silver White)' }
              ],
              allowMultiple: false,
              requiresText: true,
              status: 'pending'
            }
          }
        ],
        status: 'done' 
      }
    ],
  }
];

export const SAMPLE_DIFFS: CodeDiff[] = [
  {
    id: 'diff-chat-context',
    file: 'src/app/components/ChatArea.tsx',
    summary: '恢复任务展开入口，并在输入框右侧加入上下文用量环',
    additions: 18,
    deletions: 3,
    lines: [
      { type: 'context', oldNumber: 615, newNumber: 615, content: '<div className="max-w-4xl mx-auto relative pointer-events-auto">' },
      { type: 'add', newNumber: 616, content: '<FloatingTaskIndicator tasks={currentTasks} isActive={isGenerating} />' },
      { type: 'context', oldNumber: 620, newNumber: 620, content: '<form onSubmit={handleSubmit} className="relative group">' },
      { type: 'remove', oldNumber: 646, content: '<div className="flex items-center flex-shrink-0 gap-1 pl-1">' },
      { type: 'add', newNumber: 647, content: '<ContextUsageRing input={42800} output={8600} cacheHit={74} />' },
      { type: 'add', newNumber: 648, content: '<div className="flex items-center flex-shrink-0 gap-1 pl-1">' },
    ],
  },

];

export const DEFAULT_API_CONFIGS: APIConfig[] = [
  {
    id: 'deepseek-default',
    name: 'DeepSeek Official',
    endpoint: 'https://api.deepseek.com',
    apiKey: 'sk-••••••••••••••••••••••••',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', enabled: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', enabled: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
    ]
  }
];
