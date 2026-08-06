import { create } from 'zustand';
import {
  getAgentTrace,
  listScripts,
  type ScriptSummary,
  type TraceEntry,
} from '../services/agentService';

/**
 * 手机助手 agent 状态（规格书 8.2）：
 * - 脚本注册表缓存（脚本管理面板）
 * - 执行轨迹（tool 调用列表、状态、耗时）
 * - report_progress 悬浮提示（不中断循环）
 */
interface AgentState {
  scripts: ScriptSummary[];
  scriptsLoading: boolean;
  scriptsError: string | null;
  trace: TraceEntry[];
  traceLoading: boolean;
  /** report_progress 悬浮提示（最近一条 + 时间戳，UI 自动消隐） */
  progressMessage: { message: string; ts: number } | null;
  /** 无障碍权限引导弹窗（首次执行 agent 工具且未开启权限时打开） */
  permissionDialogOpen: boolean;
  /** 触发引导的工具名（弹窗文案展示用） */
  permissionDialogTool: string | null;

  refreshScripts: () => Promise<void>;
  refreshTrace: (chatId?: string, limit?: number) => Promise<void>;
  setProgressMessage: (message: string) => void;
  clearProgressMessage: () => void;
  setPermissionDialog: (open: boolean, toolName?: string) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  scripts: [],
  scriptsLoading: false,
  scriptsError: null,
  trace: [],
  traceLoading: false,
  progressMessage: null,
  permissionDialogOpen: false,
  permissionDialogTool: null,

  refreshScripts: async () => {
    set({ scriptsLoading: true, scriptsError: null });
    try {
      const scripts = await listScripts();
      set({ scripts, scriptsLoading: false });
    } catch (err) {
      set({
        scriptsLoading: false,
        scriptsError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  refreshTrace: async (chatId?: string, limit = 100) => {
    set({ traceLoading: true });
    try {
      const trace = await getAgentTrace(chatId, limit);
      set({ trace, traceLoading: false });
    } catch {
      set({ traceLoading: false });
    }
  },

  setProgressMessage: (message) => set({ progressMessage: { message, ts: Date.now() } }),
  clearProgressMessage: () => set({ progressMessage: null }),
  setPermissionDialog: (open, toolName) =>
    set({ permissionDialogOpen: open, permissionDialogTool: open ? (toolName ?? null) : null }),
}));
