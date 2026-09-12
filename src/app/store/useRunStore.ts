import { create } from 'zustand';
import { listRuns, RunSummary, RunTerminalReason } from '../services/runService';
import { Task } from '../types';

interface RunState {
  runs: RunSummary[];
  connected: boolean;
  loading: boolean;
  init: () => void;
  refresh: (chatId?: string) => Promise<void>;
  runsForChat: (chatId?: string | null) => RunSummary[];
  tasksForChat: (chatId?: string | null) => Task[];
}

let pollTimer: number | null = null;
let lastChatId: string | undefined;
let taskSelectorCallCount = 0;
let taskCacheRuns: RunSummary[] | null = null;
let taskCacheChatId: string | null | undefined;
let taskCacheTasks: Task[] = [];

export const useRunStore = create<RunState>((set, get) => ({
  runs: [],
  connected: false,
  loading: false,

  init: () => {
    // #region agent log
    fetch('http://127.0.0.1:7562/ingest/572e99fe-bfce-422d-b9c9-bd5aa9018362',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6722c2'},body:JSON.stringify({sessionId:'6722c2',runId:'initial',hypothesisId:'H2',location:'useRunStore.ts:25',message:'run store init invoked',data:{pollTimerActive:pollTimer!==null,lastChatId:lastChatId??null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (pollTimer !== null) return;
    void get().refresh(lastChatId);
    pollTimer = window.setInterval(() => {
      void get().refresh(lastChatId);
    }, 1500);
  },

  refresh: async (chatId) => {
    lastChatId = chatId || undefined;
    // #region agent log
    fetch('http://127.0.0.1:7562/ingest/572e99fe-bfce-422d-b9c9-bd5aa9018362',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6722c2'},body:JSON.stringify({sessionId:'6722c2',runId:'initial',hypothesisId:'H3',location:'useRunStore.ts:38',message:'run refresh started',data:{chatId:chatId??null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    set({ loading: true });
    try {
      const runs = await listRuns(chatId || undefined);
      // #region agent log
      fetch('http://127.0.0.1:7562/ingest/572e99fe-bfce-422d-b9c9-bd5aa9018362',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6722c2'},body:JSON.stringify({sessionId:'6722c2',runId:'initial',hypothesisId:'H3',location:'useRunStore.ts:43',message:'run refresh succeeded',data:{chatId:chatId??null,runCount:runs.length,runIds:runs.map((run)=>run.id)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      set({ runs, connected: true, loading: false });
    } catch (error) {
      // #region agent log
      fetch('http://127.0.0.1:7562/ingest/572e99fe-bfce-422d-b9c9-bd5aa9018362',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6722c2'},body:JSON.stringify({sessionId:'6722c2',runId:'initial',hypothesisId:'H3',location:'useRunStore.ts:48',message:'run refresh failed',data:{chatId:chatId??null,error:error instanceof Error?error.message:String(error)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      set({ connected: false, loading: false });
    }
  },

  runsForChat: (chatId) => {
    const runs = get().runs;
    return chatId ? runs.filter((run) => !run.chatId || run.chatId === chatId) : runs;
  },

  tasksForChat: (chatId) => {
    const allRuns = get().runs;
    const runs = chatId ? allRuns.filter((run) => !run.chatId || run.chatId === chatId) : allRuns;
    if (taskCacheRuns !== allRuns || taskCacheChatId !== chatId) {
      taskCacheRuns = allRuns;
      taskCacheChatId = chatId;
      taskCacheTasks = runs.map(runToTask);
    }
    const tasks = taskCacheTasks;
    taskSelectorCallCount += 1;
    // #region agent log
    if (taskSelectorCallCount <= 20) fetch('http://127.0.0.1:7562/ingest/572e99fe-bfce-422d-b9c9-bd5aa9018362',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6722c2'},body:JSON.stringify({sessionId:'6722c2',runId:'post-fix',hypothesisId:'H1',location:'useRunStore.ts:78',message:'tasks selector returned cached snapshot',data:{callCount:taskSelectorCallCount,chatId:chatId??null,runCount:runs.length,taskCount:tasks.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return tasks;
  },
}));

function runToTask(run: RunSummary): Task {
  return {
    id: run.id,
    title: run.title,
    status: run.status === 'cancelled' ? 'failed' : run.status,
    description: describeRun(run),
  };
}

function describeRun(run: RunSummary): string | undefined {
  if (run.error) return run.error;
  if (run.terminalReason && run.terminalReason !== 'completed') {
    return terminalReasonLabel(run.terminalReason);
  }
  return run.kind;
}

function terminalReasonLabel(reason: RunTerminalReason): string {
  const labels: Record<RunTerminalReason, string> = {
    completed: '已完成',
    user_cancelled: '用户取消',
    upstream_error: '上游错误',
    tool_error: '工具错误',
    permission_denied: '权限拒绝',
    subagent_error: '子代理错误',
    workflow_error: '工作流错误',
    unknown_error: '未知错误',
  };
  return labels[reason];
}
