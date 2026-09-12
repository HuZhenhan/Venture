import { create } from 'zustand';
import { APIConfig, Chat, ChatMode, ComposerDraftNode, ComposerReference, Message, Task, ToolPermissionLevel, ToolPermissionsByMode, TraceRecord } from '../types';
import { appendMessageToChat, updateChatEntry, updateChatMessagesInList } from './chatState';
import { listProviders } from '../services/modelConfigService';
import { patchAppData } from '../services/appDataService';
import { debugLog, debugError } from '../utils/debugLogger';
import { TOOL_PERMISSION_OPTIONS } from '../utils/toolPermissions';

const CHATS_STORAGE_KEY = 'venture-chats';
const ACTIVE_CHAT_ID_STORAGE_KEY = 'venture-active-chat-id';
const PRESELECTED_MODE_STORAGE_KEY = 'venture-preselected-mode';
const PRESELECTED_PERMISSIONS_STORAGE_KEY = 'venture-preselected-permissions';

function readStoredPreSelectedMode(): ChatMode {
  if (typeof window === 'undefined') return 'agent';
  try {
    const raw = window.localStorage.getItem(PRESELECTED_MODE_STORAGE_KEY);
    if (raw === 'agent' || raw === 'plan' || raw === 'yolo') return raw;
    return 'agent';
  } catch {
    return 'agent';
  }
}

function readStoredPreSelectedPermissions(): ToolPermissionsByMode {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PRESELECTED_PERMISSIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ToolPermissionsByMode;
    // 校验每个模式的权限级别合法（不在可选范围内则丢弃）
    const result: ToolPermissionsByMode = {};
    (Object.keys(parsed) as ChatMode[]).forEach((mode) => {
      const level = parsed[mode];
      if (level && TOOL_PERMISSION_OPTIONS[mode]?.includes(level)) {
        result[mode] = level;
      }
    });
    return result;
  } catch {
    return {};
  }
}

function readStoredChats(): Chat[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CHATS_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Chat[];
  } catch {
    return [];
  }
}

function readStoredActiveChatId(availableChats: Chat[]): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const id = window.localStorage.getItem(ACTIVE_CHAT_ID_STORAGE_KEY);
    if (!id) return null;
    return availableChats.some(c => c.id === id) ? id : null;
  } catch {
    return null;
  }
}

let persistTimeout: number | null = null;
let pendingChatsToPersist: Chat[] | null = null;

const PERSIST_QUOTA_FALLBACK_LIMITS = [40, 20, 10, 5];

function isQuotaError(error: unknown): boolean {
  if (!error) return false;
  const anyErr = error as { name?: string; code?: number };
  if (anyErr.name === 'QuotaExceededError' || anyErr.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return true;
  }
  if (typeof anyErr.code === 'number' && (anyErr.code === 22 || anyErr.code === 1014)) {
    return true;
  }
  return false;
}

function trySerializeAndStore(chats: Chat[]): boolean {
  const serialized = JSON.stringify(chats);
  if (serialized.length > 500_000) {
    debugLog('store', 'persistChats large payload', {
      chatCount: chats.length,
      bytes: serialized.length,
    });
  }
  window.localStorage.setItem(CHATS_STORAGE_KEY, serialized);
  return true;
}

function writeChatsLocalWithQuotaFallback(chats: Chat[]) {
  try {
    trySerializeAndStore(chats);
    return;
  } catch (error) {
    if (!isQuotaError(error)) {
      debugError('store', 'persistChats failed', {
        chatCount: chats.length,
        error,
      });
      return;
    }
    debugError('store', 'persistChats quota exceeded, entering fallback', {
      chatCount: chats.length,
    });
  }

  for (const limit of PERSIST_QUOTA_FALLBACK_LIMITS) {
    if (chats.length <= limit) continue;
    const trimmed = chats.slice(0, limit);
    try {
      trySerializeAndStore(trimmed);
      debugError('store', 'persistChats fallback truncated', {
        keptCount: trimmed.length,
        droppedCount: chats.length - trimmed.length,
      });
      return;
    } catch (error) {
      if (!isQuotaError(error)) {
        debugError('store', 'persistChats fallback failed', { limit, error });
        return;
      }
    }
  }

  try {
    window.localStorage.removeItem(CHATS_STORAGE_KEY);
    debugError('store', 'persistChats aborted, storage cleared');
  } catch (error) {
    debugError('store', 'persistChats removeItem failed', { error });
  }
}

function writeChatsWithQuotaFallback(chats: Chat[]) {
  patchAppData({ chats }).catch((error) => {
    debugError('store', 'persistChats to backend failed, using local fallback', { error });
    writeChatsLocalWithQuotaFallback(chats);
  });
}

function flushPersistChatsInternal() {
  if (typeof window === 'undefined') return;
  if (persistTimeout !== null) {
    window.clearTimeout(persistTimeout);
    persistTimeout = null;
  }
  const chatsToSave = pendingChatsToPersist;
  pendingChatsToPersist = null;
  if (!chatsToSave) return;
  writeChatsWithQuotaFallback(chatsToSave);
}

export function flushPersistChats() {
  flushPersistChatsInternal();
}

function persistChats(chats: Chat[]) {
  if (typeof window === 'undefined') return;
  pendingChatsToPersist = chats;

  if (persistTimeout === null) {
    persistTimeout = window.setTimeout(() => {
      persistTimeout = null;
      const chatsToSave = pendingChatsToPersist;
      pendingChatsToPersist = null;
      if (!chatsToSave) return;
      writeChatsWithQuotaFallback(chatsToSave);
    }, 1000); // Throttle persistence to at most once per second
  }
}

if (typeof window !== 'undefined') {
  const flushOnUnload = () => flushPersistChatsInternal();
  window.addEventListener('beforeunload', flushOnUnload);
  window.addEventListener('pagehide', flushOnUnload);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnUnload();
  });
}

function persistActiveChatId(id: string | null) {
  if (typeof window === 'undefined') return;
  patchAppData({ activeChatId: id }).catch((error) => {
    debugError('store', 'persistActiveChatId to backend failed', { error });
    try {
      if (id === null) {
        window.localStorage.removeItem(ACTIVE_CHAT_ID_STORAGE_KEY);
      } else {
        window.localStorage.setItem(ACTIVE_CHAT_ID_STORAGE_KEY, id);
      }
    } catch {
    }
  });
}

const initialChats = readStoredChats();
const initialActiveChatId = readStoredActiveChatId(initialChats);
const initialPreSelectedMode = readStoredPreSelectedMode();
const initialPreSelectedPermissions = readStoredPreSelectedPermissions();

interface GenerationSession {
  chatId: string;
  messageId: string;
}

interface ChatState {
  chats: Chat[];
  activeChatId: string | null;
  apiConfigs: APIConfig[];
  apiConfigsLoaded: boolean;
  generatingChatId: string | null;
  generationSession: GenerationSession | null;
  currentTasks: Task[];
  preSelectedMode: ChatMode;
  /** 新会话（尚无 activeChat 时）预选的各模式权限级别。 */
  preSelectedPermissions: ToolPermissionsByMode;
  /** 仅当前运行期有效的会话授权签名，不持久化。 */
  sessionApprovedToolCalls: Record<string, string[]>;
  draftMessage: string;
  draftNodes: ComposerDraftNode[];
  draftReferences: ComposerReference[];

  // Trace state (in-memory only, not persisted)
  tracedChatId: string | null;
  traceRecords: TraceRecord[];
  /// 用户请求追踪但当前没有 activeChatId 时置 true，
  /// 等下次发送消息创建新 chat 时自动绑定 tracedChatId。
  traceRequested: boolean;

  // Actions
  setActiveChatId: (id: string | null) => void;
  setChats: (chats: Chat[] | ((prev: Chat[]) => Chat[])) => void;
  hydrateAppData: (chats: Chat[], activeChatId: string | null) => void;
  setApiConfigs: (configs: APIConfig[] | ((prev: APIConfig[]) => APIConfig[])) => void;
  loadApiConfigs: () => Promise<void>;
  setGeneratingChatId: (id: string | null) => void;
  setGenerationSession: (session: GenerationSession | null) => void;
  setCurrentTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void;
  setPreSelectedMode: (mode: ChatMode) => void;
  /** 设置新会话预选权限（某模式下）。 */
  setPreSelectedPermission: (mode: ChatMode, level: ToolPermissionLevel) => void;
  /** 设置会话在某模式下的权限级别（随会话持久化）。 */
  setChatPermission: (id: string, mode: ChatMode, level: ToolPermissionLevel) => void;
  /** 追加"一律同意"白名单签名（随会话持久化，去重）。 */
  addApprovedToolSignature: (id: string, signature: string) => void;
  /** 追加本运行期会话授权签名（不持久化）。 */
  addSessionApprovedToolSignature: (id: string, signature: string) => void;
  /** 撤销单条"一律同意"白名单签名。 */
  removeApprovedToolSignature: (id: string, signature: string) => void;
  /** 清空当前会话的所有"一律同意"白名单签名。 */
  clearApprovedToolSignatures: (id: string) => void;
  setDraftMessage: (msg: string | ((prev: string) => string)) => void;
  setDraftNodes: (nodes: ComposerDraftNode[] | ((prev: ComposerDraftNode[]) => ComposerDraftNode[])) => void;
  setDraftReferences: (references: ComposerReference[] | ((prev: ComposerReference[]) => ComposerReference[])) => void;
  
  // Helpers
  getActiveChat: () => Chat | null;
  addChat: (chat: Chat) => void;
  deleteChat: (id: string) => void;
  updateChat: (id: string, updates: Partial<Chat>) => void;
  updateChatWith: (id: string, updater: (chat: Chat) => Chat) => void;
  updateChatMessages: (id: string, updater: (messages: Message[]) => Message[]) => void;
  appendChatMessage: (id: string, message: Message) => void;
  renameChat: (id: string, title: string) => void;
  setChatMode: (id: string, mode: ChatMode) => void;
  cloneChat: (id: string) => void;

  // Trace actions
  setTracedChatId: (id: string | null) => void;
  setTraceRequested: (requested: boolean) => void;
  addTraceRecord: (record: TraceRecord) => void;
  clearTraceRecords: () => void;
  /// 仅清空追踪记录数组，保留 tracedChatId（让用户继续追踪但清空历史）。
  clearTraceRecordsOnly: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: initialChats,
  activeChatId: initialActiveChatId,
  apiConfigs: [],
  apiConfigsLoaded: false,
  generatingChatId: null,
  generationSession: null,
  currentTasks: [],
  preSelectedMode: initialPreSelectedMode,
  preSelectedPermissions: initialPreSelectedPermissions,
  sessionApprovedToolCalls: {},
  draftMessage: '',
  draftNodes: [],
  draftReferences: [],

  tracedChatId: null,
  traceRecords: [],
  traceRequested: false,

  setActiveChatId: (id) => {
    persistActiveChatId(id);
    set({ activeChatId: id });
  },
  
  setChats: (chats) => set((state) => {
    const next = typeof chats === 'function' ? chats(state.chats) : chats;
    persistChats(next);
    return { chats: next };
  }),

  hydrateAppData: (chats, activeChatId) => set({
    chats,
    activeChatId: activeChatId && chats.some((chat) => chat.id === activeChatId) ? activeChatId : null,
  }),
  
  setApiConfigs: (configs) => set((state) => ({
    apiConfigs: typeof configs === 'function' ? configs(state.apiConfigs) : configs
  })),

  loadApiConfigs: async () => {
    try {
      const configs = await listProviders();
      set({ apiConfigs: configs, apiConfigsLoaded: true });
    } catch {
      set({ apiConfigs: [], apiConfigsLoaded: true });
    }
  },
  
  setGeneratingChatId: (id) => set({ generatingChatId: id }),
  setGenerationSession: (session) => set({ generationSession: session }),
  
  setCurrentTasks: (tasks) => set((state) => ({
    currentTasks: typeof tasks === 'function' ? tasks(state.currentTasks) : tasks
  })),
  
  setPreSelectedMode: (mode) => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(PRESELECTED_MODE_STORAGE_KEY, mode);
      } catch {
      }
    }
    set({ preSelectedMode: mode });
  },

  setPreSelectedPermission: (mode, level) => set((state) => {
    const preSelectedPermissions = { ...state.preSelectedPermissions, [mode]: level };
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(PRESELECTED_PERMISSIONS_STORAGE_KEY, JSON.stringify(preSelectedPermissions));
      } catch {
      }
    }
    return { preSelectedPermissions };
  }),

  setChatPermission: (id, mode, level) => set((state) => {
    const chats = updateChatEntry(state.chats, id, (chat) => ({
      ...chat,
      permissions: { ...(chat.permissions ?? {}), [mode]: level },
    }));
    persistChats(chats);
    return { chats };
  }),

  addApprovedToolSignature: (id, signature) => set((state) => {
    const chats = updateChatEntry(state.chats, id, (chat) => {
      const existing = chat.approvedToolCalls ?? [];
      if (existing.includes(signature)) return chat;
      return { ...chat, approvedToolCalls: [...existing, signature] };
    });
    persistChats(chats);
    return { chats };
  }),

  addSessionApprovedToolSignature: (id, signature) => set((state) => {
    const existing = state.sessionApprovedToolCalls[id] ?? [];
    if (existing.includes(signature)) return state;
    return {
      sessionApprovedToolCalls: {
        ...state.sessionApprovedToolCalls,
        [id]: [...existing, signature],
      },
    };
  }),

  removeApprovedToolSignature: (id, signature) => set((state) => {
    const chats = updateChatEntry(state.chats, id, (chat) => ({
      ...chat,
      approvedToolCalls: (chat.approvedToolCalls ?? []).filter((item) => item !== signature),
    }));
    persistChats(chats);
    return { chats };
  }),

  clearApprovedToolSignatures: (id) => set((state) => {
    const chats = updateChatEntry(state.chats, id, (chat) => ({
      ...chat,
      approvedToolCalls: [],
    }));
    persistChats(chats);
    return { chats };
  }),
  
  setDraftMessage: (msg) => set((state) => ({
    draftMessage: typeof msg === 'function' ? msg(state.draftMessage) : msg
  })),

  setDraftNodes: (nodes) => set((state) => ({
    draftNodes: typeof nodes === 'function' ? nodes(state.draftNodes) : nodes
  })),

  setDraftReferences: (references) => set((state) => {
    const next = typeof references === 'function' ? references(state.draftReferences) : references;
    if (next !== state.draftReferences) {
      debugLog('store', 'setDraftReferences', {
        prevCount: state.draftReferences.length,
        nextCount: next.length,
        prevIds: state.draftReferences.map((r) => r.id),
        nextIds: next.map((r) => r.id),
      });
    }
    return { draftReferences: next };
  }),

  getActiveChat: () => {
    const { chats, activeChatId } = get();
    return chats.find(c => c.id === activeChatId) || null;
  },

  addChat: (chat) => set((state) => {
    const chats = [chat, ...state.chats];
    persistChats(chats);
    persistActiveChatId(chat.id);
    return { chats, activeChatId: chat.id };
  }),

  deleteChat: (id) => set((state) => {
    const chats = state.chats.filter(c => c.id !== id);
    const activeChatId = state.activeChatId === id ? null : state.activeChatId;
    persistChats(chats);
    persistActiveChatId(activeChatId);
    return { chats, activeChatId };
  }),

  updateChat: (id, updates) => set((state) => {
    const chats = state.chats.map(c => c.id === id ? { ...c, ...updates } : c);
    persistChats(chats);
    return { chats };
  }),

  updateChatWith: (id, updater) => set((state) => {
    const chats = updateChatEntry(state.chats, id, updater);
    persistChats(chats);
    return { chats };
  }),

  updateChatMessages: (id, updater) => set((state) => {
    const chats = updateChatMessagesInList(state.chats, id, updater);
    persistChats(chats);
    return { chats };
  }),

  appendChatMessage: (id, message) => set((state) => {
    const chats = appendMessageToChat(state.chats, id, message);
    persistChats(chats);
    return { chats };
  }),

  renameChat: (id, title) => set((state) => {
    const chats = updateChatEntry(state.chats, id, (chat) => ({ ...chat, title }));
    persistChats(chats);
    return { chats };
  }),

  setChatMode: (id, mode) => set((state) => {
    const chats = updateChatEntry(state.chats, id, (chat) => ({ ...chat, mode }));
    persistChats(chats);
    return { chats };
  }),
  
  cloneChat: (id) => set((state) => {
    const chat = state.chats.find(c => c.id === id);
    if (!chat) return state;
    const newChat = {
      ...chat,
      id: crypto.randomUUID(),
      title: `${chat.title} (副本)`,
      messages: chat.messages.map(m => ({ ...m, id: crypto.randomUUID() }))
    };
    const chats = [newChat, ...state.chats];
    persistChats(chats);
    persistActiveChatId(newChat.id);
    return { chats, activeChatId: newChat.id };
  }),

  setTracedChatId: (id) => set({ tracedChatId: id }),
  setTraceRequested: (requested) => set({ traceRequested: requested }),
  addTraceRecord: (record) => set((state) => ({
    traceRecords: [...state.traceRecords, record],
  })),
  clearTraceRecords: () => set({ traceRecords: [], tracedChatId: null, traceRequested: false }),
  clearTraceRecordsOnly: () => set({ traceRecords: [] }),
}));
