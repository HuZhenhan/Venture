import { create } from 'zustand';
import { Chat, Message } from '../types';
import { debugLog, debugError } from '../utils/debugLogger';

function stripDataUrlsFromMessages(messages: Message[]): Message[] {
  return messages.map((msg) => ({
    ...msg,
    blocks: msg.blocks?.map((block) => {
      if (block.type !== 'reference_list') return block;
      return {
        ...block,
        references: block.references?.map((ref) => {
          if (ref.kind === 'code' || !ref.resource) return ref;
          
          const stripResource = { ...ref.resource };
          if ('dataUrl' in stripResource) {
            (stripResource as any).dataUrl = `[stripped-${stripResource.kind}]`;
          }
          
          return {
            ...ref,
            resource: stripResource as any,
          };
        }) ?? [],
      };
    }) ?? [],
  }));
}

export interface HistorySnapshot {
  id: string;
  timestamp: number;
  chatId: string;
  messages: Message[];
  description: string;
  metadata?: {
    action: 'message_sent' | 'message_regenerated' | 'message_deleted' | 'chat_cleared' | 'manual_checkpoint';
    messageCount: number;
    lastMessageRole: 'user' | 'ai';
  };
}

interface HistoryStore {
  snapshots: HistorySnapshot[];
  currentSnapshotIndex: number;

  createSnapshot: (
    chatId: string,
    messages: Message[],
    action: HistorySnapshot['metadata']['action'],
    description: string
  ) => void;

  undo: () => HistorySnapshot | null;

  redo: () => HistorySnapshot | null;

  canUndo: () => boolean;

  canRedo: () => boolean;

  getCurrentSnapshot: () => HistorySnapshot | null;

  getNextSnapshot: () => HistorySnapshot | null;

  clearHistory: () => void;

  clearChatHistory: (chatId: string) => void;

  getSnapshotHistory: (chatId: string) => HistorySnapshot[];

  restoreSnapshot: (snapshotId: string) => HistorySnapshot | null;

  deleteSnapshot: (snapshotId: string) => void;

  getSnapshotDiff: (
    fromIndex: number,
    toIndex: number
  ) => {
    added: Message[];
    removed: Message[];
    modified: Message[];
  };

  bulkCreateSnapshots: (snapshotsList: HistorySnapshot[]) => void;
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  snapshots: [],
  currentSnapshotIndex: -1,

  createSnapshot: (chatId, messages, action, description) => {
    const startTime = performance.now();
    let clonedMessages: Message[];
    try {
      const strippedMessages = stripDataUrlsFromMessages(messages);
      const serialized = JSON.stringify(strippedMessages);
      debugLog('history', 'createSnapshot start', {
        chatId,
        action,
        messageCount: messages.length,
        payloadBytes: serialized.length,
      });
      clonedMessages = JSON.parse(serialized);
    } catch (error) {
      debugError('history', 'createSnapshot clone failed', {
        chatId,
        action,
        messageCount: messages.length,
        error,
      });
      throw error;
    }

    set((state) => {
      const newSnapshots = state.snapshots.slice(0, state.currentSnapshotIndex + 1);

      const newSnapshot: HistorySnapshot = {
        id: `snapshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        chatId,
        messages: clonedMessages,
        description,
        metadata: {
          action,
          messageCount: messages.length,
          lastMessageRole: messages.length > 0 ? messages[messages.length - 1].role : 'user',
        },
      };

      newSnapshots.push(newSnapshot);

      return {
        snapshots: newSnapshots,
        currentSnapshotIndex: newSnapshots.length - 1,
      };
    });

    debugLog('history', 'createSnapshot done', {
      chatId,
      action,
      elapsedMs: Math.round(performance.now() - startTime),
    });
  },

  undo: () => {
    let result: HistorySnapshot | null = null;
    set((state) => {
      if (state.currentSnapshotIndex > 0) {
        const newIndex = state.currentSnapshotIndex - 1;
        result = state.snapshots[newIndex];
        return { currentSnapshotIndex: newIndex };
      }
      return state;
    });
    return result;
  },

  redo: () => {
    let result: HistorySnapshot | null = null;
    set((state) => {
      if (state.currentSnapshotIndex < state.snapshots.length - 1) {
        const newIndex = state.currentSnapshotIndex + 1;
        result = state.snapshots[newIndex];
        return { currentSnapshotIndex: newIndex };
      }
      return state;
    });
    return result;
  },

  canUndo: () => {
    const state = get();
    return state.currentSnapshotIndex > 0;
  },

  canRedo: () => {
    const state = get();
    return state.currentSnapshotIndex < state.snapshots.length - 1;
  },

  getCurrentSnapshot: () => {
    const state = get();
    if (state.currentSnapshotIndex >= 0 && state.currentSnapshotIndex < state.snapshots.length) {
      return state.snapshots[state.currentSnapshotIndex];
    }
    return null;
  },

  getNextSnapshot: () => {
    const state = get();
    const nextIndex = state.currentSnapshotIndex + 1;
    if (nextIndex < state.snapshots.length) {
      return state.snapshots[nextIndex];
    }
    return null;
  },

  clearHistory: () => {
    set({
      snapshots: [],
      currentSnapshotIndex: -1,
    });
  },

  clearChatHistory: (chatId) => {
    set((state) => {
      const filtered = state.snapshots.filter((s) => s.chatId !== chatId);
      return {
        snapshots: filtered,
        currentSnapshotIndex: Math.min(state.currentSnapshotIndex, filtered.length - 1),
      };
    });
  },

  getSnapshotHistory: (chatId) => {
    const state = get();
    return state.snapshots.filter((s) => s.chatId === chatId);
  },

  restoreSnapshot: (snapshotId) => {
    const state = get();
    const index = state.snapshots.findIndex((s) => s.id === snapshotId);
    if (index >= 0) {
      set({ currentSnapshotIndex: index });
      return state.snapshots[index];
    }
    return null;
  },

  deleteSnapshot: (snapshotId) => {
    set((state) => {
      const index = state.snapshots.findIndex((s) => s.id === snapshotId);
      if (index >= 0) {
        const newSnapshots = state.snapshots.filter((_, i) => i !== index);
        let newIndex = state.currentSnapshotIndex;
        if (index <= state.currentSnapshotIndex) {
          newIndex = Math.max(0, newIndex - 1);
        }
        return {
          snapshots: newSnapshots,
          currentSnapshotIndex: newIndex >= 0 ? newIndex : -1,
        };
      }
      return state;
    });
  },

  getSnapshotDiff: (fromIndex, toIndex) => {
    const state = get();
    const added: Message[] = [];
    const removed: Message[] = [];
    const modified: Message[] = [];

    if (fromIndex < 0 || toIndex < 0 || fromIndex >= state.snapshots.length || toIndex >= state.snapshots.length) {
      return { added, removed, modified };
    }

    const fromSnapshot = state.snapshots[fromIndex];
    const toSnapshot = state.snapshots[toIndex];

    const fromIds = new Set(fromSnapshot.messages.map((m) => m.id));
    const toIds = new Set(toSnapshot.messages.map((m) => m.id));

    toSnapshot.messages.forEach((msg) => {
      if (!fromIds.has(msg.id)) {
        added.push(msg);
      } else {
        const original = fromSnapshot.messages.find((m) => m.id === msg.id);
        if (original && JSON.stringify(original) !== JSON.stringify(msg)) {
          modified.push(msg);
        }
      }
    });

    fromSnapshot.messages.forEach((msg) => {
      if (!toIds.has(msg.id)) {
        removed.push(msg);
      }
    });

    return { added, removed, modified };
  },

  bulkCreateSnapshots: (snapshotsList) => {
    set((state) => {
      const newSnapshots = [...state.snapshots, ...snapshotsList];
      return {
        snapshots: newSnapshots,
        currentSnapshotIndex: newSnapshots.length - 1,
      };
    });
  },
}));
