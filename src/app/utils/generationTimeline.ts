import { SAMPLE_DIFFS } from '../data/mockData';
import { Chat, ContentBlock, Message, Task } from '../types';

const INITIAL_REASONING =
  '正在根据 Apple 极简主义设计规范分析需求。我将首先构建核心的任务调度逻辑，随后注入物理级回弹动效 [0.32, 0.72, 0, 1]，最后完成灰阶材质的视觉修饰。';
const TASK_ONE_REASONING =
  '正在构建核心的任务调度器。为了确保逻辑的纯粹性，我将采用状态机模式来管理任务的生命周期，并预留动效挂钩。';
const TASK_ONE_OUTPUT =
  '核心调度系统已就绪。所有任务现在都能通过统一的 `TaskProvider` 进行状态分发。';
const TASK_TWO_REASONING =
  '物理回弹是本系统的灵魂。我正在应用 `[0.32, 0.72, 0, 1]` 贝塞尔曲线，这不仅是视觉上的顺滑，更是模拟了真实的物理惯性。';
const TASK_TWO_OUTPUT =
  '\n\n动效引擎已注入。您可以感受到在展开/收起组件时那种特有的\'粘滞感\'。';
const FINAL_OUTPUT =
  '\n\n所有精修已完成。现在的界面呈现出极致的灰阶层次感。';

export const INITIAL_PLAN_TASKS: Task[] = [
  { id: 't1', title: '初始化核心逻辑', status: 'pending' },
  { id: 't2', title: '实现物理级回弹动效', status: 'pending' },
  { id: 't3', title: '灰阶材质视觉精修', status: 'pending' },
];

export const TASK_TWO_STATUS_TASKS: Task[] = [
  { id: 't1', title: '初始化核心逻辑', status: 'completed' },
  { id: 't2', title: '实现物理级回弹动效', status: 'running', description: '计算贝塞尔曲线插值点...' },
  { id: 't3', title: '灰阶材质视觉精修', status: 'pending' },
];

export const FINAL_TASKS: Task[] = [
  { id: 't1', title: '初始化核心逻辑', status: 'completed' },
  { id: 't2', title: '实现物理级回弹动效', status: 'completed' },
  { id: 't3', title: '灰阶材质视觉精修', status: 'completed' },
];

export function buildInitialAiMessage(aiMessageId: string): Message {
  return {
    id: aiMessageId,
    role: 'ai',
    content: '',
    status: 'loading',
    blocks: [],
  };
}

export function updateChatMessage(
  chats: Chat[],
  chatId: string,
  messageId: string,
  updater: (message: Message) => Message
): Chat[] {
  return chats.map((chat) => {
    if (chat.id !== chatId) {
      return chat;
    }

    return {
      ...chat,
      messages: chat.messages.map((message) => (
        message.id === messageId ? updater(message) : message
      )),
    };
  });
}

export function appendBlocks(message: Message, blocks: ContentBlock[]): Message {
  return {
    ...message,
    blocks: [...(message.blocks || []), ...blocks],
  };
}

export function markLastReasoningDone(blocks: ContentBlock[]): ContentBlock[] {
  let lastReasoningIndex = -1;
  blocks.forEach((block, index) => {
    if (block.type === 'reasoning') {
      lastReasoningIndex = index;
    }
  });

  return blocks.map((block, index) => (
    index === lastReasoningIndex && block.type === 'reasoning'
      ? { ...block, status: 'done' as const }
      : block
  ));
}

export function buildInitialReasoningMessage(message: Message): Message {
  return {
    ...message,
    status: 'reasoning',
    blocks: [{ type: 'reasoning', content: INITIAL_REASONING, status: 'reasoning' }],
  };
}

export function buildPlanMessage(message: Message): Message {
  return appendBlocks(
    {
      ...message,
      blocks: markLastReasoningDone(message.blocks || []),
    },
    [{ type: 'tasks', tasks: INITIAL_PLAN_TASKS, id: 'plan-tasks' }]
  );
}

export function buildTaskOneReasoningMessage(message: Message): Message {
  return appendBlocks(message, [
    { type: 'reasoning', content: TASK_ONE_REASONING, status: 'reasoning' },
  ]);
}

export function buildTaskOneResultMessage(message: Message): Message {
  const blocks = message.blocks || [];
  const updatedBlocks: ContentBlock[] = [
    ...markLastReasoningDone(blocks),
    { type: 'text', content: TASK_ONE_OUTPUT },
    { type: 'diff', diff: SAMPLE_DIFFS[0] },
    {
      type: 'search_op',
      searchOp: {
        id: 'so-gen-1',
        type: 'file',
        query: 'oldAnimations.ts',
        status: 'completed',
        results: [{ path: 'src/app/utils/oldAnimations.ts' }],
      },
    },
    {
      type: 'search_op',
      searchOp: {
        id: 'so-gen-2',
        type: 'code',
        query: 'physicsBackEase',
        status: 'completed',
        results: [
          {
            path: 'src/app/utils/oldAnimations.ts',
            line: 12,
            match: 'export function physicsBackEase(val: number) {\n  return val * 0.32;\n}',
          },
        ],
      },
    },
    {
      type: 'web_search',
      search: {
        id: 'ws-gen-1',
        query: 'Apple Spring Animation Physics',
        status: 'completed',
        results: [
          {
            title: 'Designing Fluid Interfaces',
            url: 'https://developer.apple.com/videos/play/wwdc2018/803/',
            snippet: 'Learn how to create fluid, responsive, and natural-feeling interfaces using physics-based animations.',
          },
        ],
      },
    },
    {
      type: 'file_op',
      fileOp: {
        id: 'fo-gen-1',
        type: 'delete',
        source: 'src/app/utils/oldAnimations.ts',
        status: 'requires_confirmation',
      },
    },
  ];

  return {
    ...message,
    status: 'done',
    content: `${message.content || ''}${TASK_ONE_OUTPUT}`,
    blocks: updatedBlocks,
  };
}

export function buildTaskTwoStatusMessage(message: Message): Message {
  return appendBlocks(message, [
    { type: 'tasks', tasks: TASK_TWO_STATUS_TASKS, id: 'status-tasks-2' },
  ]);
}

export function buildTaskTwoReasoningMessage(message: Message): Message {
  return {
    ...appendBlocks(message, [
      { type: 'reasoning', content: TASK_TWO_REASONING, status: 'reasoning' },
    ]),
    status: 'reasoning',
  };
}

export function buildTaskTwoResultMessage(message: Message): Message {
  const updatedBlocks: ContentBlock[] = [
    ...markLastReasoningDone(message.blocks || []),
    { type: 'text', content: TASK_TWO_OUTPUT },
  ];

  return {
    ...message,
    status: 'typing',
    content: `${message.content || ''}${TASK_TWO_OUTPUT}`,
    blocks: updatedBlocks,
  };
}

export function buildFinalMessage(message: Message): Message {
  return appendBlocks(
    {
      ...message,
      status: 'done',
      content: `${message.content || ''}${FINAL_OUTPUT}`,
    },
    [
      { type: 'tasks', tasks: FINAL_TASKS, id: 'final-tasks' },
      { type: 'diff', diff: SAMPLE_DIFFS[1] },
      { type: 'text', content: FINAL_OUTPUT },
      {
        type: 'skill',
        skill: {
          id: 'sk-gen-1',
          name: 'figma-use',
          status: 'completed',
          params: '{\n  "action": "update_variables",\n  "theme": "dark_mode"\n}',
          output: 'Variables updated in Figma file successfully.',
        },
      },
      {
        type: 'ask',
        ask: {
          id: 'ask-gen-1',
          question: '基础动效和组件均已就绪，是否需要立即部署到预览环境？',
          options: [
            { id: 'opt-deploy', label: '确认部署并生成预览链接' },
            { id: 'opt-review', label: '暂不部署，我先Review代码' },
          ],
          allowMultiple: false,
          requiresText: false,
          status: 'pending',
        },
      },
    ]
  );
}

export function updateFileOpStatus(
  message: Message,
  fileOpId: string,
  status: 'completed' | 'failed'
): Message {
  return {
    ...message,
    blocks: message.blocks?.map((block) => (
      block.type === 'file_op' && block.fileOp.id === fileOpId
        ? { ...block, fileOp: { ...block.fileOp, status } }
        : block
    )),
  };
}
