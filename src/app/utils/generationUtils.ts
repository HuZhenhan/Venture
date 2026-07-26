import { Message, Task } from '../types';

export function buildStoppedTasksSnapshot(tasks: Task[]): Task[] {
  return tasks.map((task) => {
    if (task.status === 'completed') {
      return task;
    }

    if (task.status === 'running') {
      return {
        ...task,
        status: 'failed',
        description: '已手动停止，当前步骤未继续执行。'
      };
    }

    return {
      ...task,
      status: 'failed',
      description: '已在执行前取消后续演示步骤。'
    };
  });
}

export function buildStoppedMessage(message: Message, stoppedTasks: Task[]): Message {
  const nextBlocks = (message.blocks || []).map((block) => {
    if (block.type === 'reasoning' && block.status === 'reasoning') {
      return { ...block, status: 'done' } as const;
    }

    return block;
  });

  if (stoppedTasks.length > 0) {
    nextBlocks.push({
      type: 'tasks',
      tasks: stoppedTasks,
      id: `stopped-tasks-${message.id}`
    });
  }

  nextBlocks.push({
    type: 'text',
    content: '\n\n已停止当前演示生成。后续步骤不会继续执行。'
  });

  return {
    ...message,
    status: 'done',
    content: `${message.content || ''}\n\n已停止当前演示生成。后续步骤不会继续执行。`,
    blocks: nextBlocks
  };
}
