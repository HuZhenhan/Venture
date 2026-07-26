import { create } from 'zustand';
import { patchAppData } from '../services/appDataService';

export const AVAILABLE_LANGUAGES = ['简体中文', 'English', '日本語'] as const;
export type AppLanguage = (typeof AVAILABLE_LANGUAGES)[number];

const PREFERENCES_STORAGE_KEY = 'app-preferences';
const DEFAULT_LANGUAGE: AppLanguage = '简体中文';
const DEFAULT_SEND_SHORTCUT = true;
const DEFAULT_AUTO_GENERATE_CONVERSATION_TITLES = true;
const DEFAULT_AUTO_GENERATE_REASONING_TITLES = true;
const DEFAULT_DEBUG_MODE = false;

export interface AppPreferences {
  language: AppLanguage;
  sendShortcut: boolean;
  autoGenerateConversationTitles: boolean;
  autoGenerateReasoningTitles: boolean;
  debugMode: boolean;
}

interface PreferencesState {
  language: AppLanguage;
  sendShortcut: boolean;
  autoGenerateConversationTitles: boolean;
  autoGenerateReasoningTitles: boolean;
  debugMode: boolean;
  setPreferences: (preferences: Partial<AppPreferences>) => void;
  hydratePreferences: (preferences: AppPreferences) => void;
}

function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && AVAILABLE_LANGUAGES.includes(value as AppLanguage);
}

function readStoredPreferences() {
  if (typeof window === 'undefined') {
    return {
      language: DEFAULT_LANGUAGE,
      sendShortcut: DEFAULT_SEND_SHORTCUT,
      autoGenerateConversationTitles: DEFAULT_AUTO_GENERATE_CONVERSATION_TITLES,
      autoGenerateReasoningTitles: DEFAULT_AUTO_GENERATE_REASONING_TITLES,
      debugMode: DEFAULT_DEBUG_MODE,
    };
  }

  try {
    const rawValue = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!rawValue) {
      return {
        language: DEFAULT_LANGUAGE,
        sendShortcut: DEFAULT_SEND_SHORTCUT,
        autoGenerateConversationTitles: DEFAULT_AUTO_GENERATE_CONVERSATION_TITLES,
        autoGenerateReasoningTitles: DEFAULT_AUTO_GENERATE_REASONING_TITLES,
        debugMode: DEFAULT_DEBUG_MODE,
      };
    }

    const parsedValue = JSON.parse(rawValue) as {
      language?: unknown;
      sendShortcut?: unknown;
      autoGenerateTitles?: unknown;
      autoGenerateConversationTitles?: unknown;
      autoGenerateReasoningTitles?: unknown;
      debugMode?: unknown;
    };
    const legacyAutoGenerateTitles =
      typeof parsedValue.autoGenerateTitles === 'boolean' ? parsedValue.autoGenerateTitles : undefined;
    return {
      language: isAppLanguage(parsedValue.language) ? parsedValue.language : DEFAULT_LANGUAGE,
      sendShortcut: typeof parsedValue.sendShortcut === 'boolean' ? parsedValue.sendShortcut : DEFAULT_SEND_SHORTCUT,
      autoGenerateConversationTitles: typeof parsedValue.autoGenerateConversationTitles === 'boolean'
        ? parsedValue.autoGenerateConversationTitles
        : legacyAutoGenerateTitles ?? DEFAULT_AUTO_GENERATE_CONVERSATION_TITLES,
      autoGenerateReasoningTitles: typeof parsedValue.autoGenerateReasoningTitles === 'boolean'
        ? parsedValue.autoGenerateReasoningTitles
        : legacyAutoGenerateTitles ?? DEFAULT_AUTO_GENERATE_REASONING_TITLES,
      debugMode: typeof parsedValue.debugMode === 'boolean' ? parsedValue.debugMode : DEFAULT_DEBUG_MODE,
    };
  } catch (error) {
    console.warn('Failed to read app preferences from storage.', error);
    return {
      language: DEFAULT_LANGUAGE,
      sendShortcut: DEFAULT_SEND_SHORTCUT,
      autoGenerateConversationTitles: DEFAULT_AUTO_GENERATE_CONVERSATION_TITLES,
      autoGenerateReasoningTitles: DEFAULT_AUTO_GENERATE_REASONING_TITLES,
      debugMode: DEFAULT_DEBUG_MODE,
    };
  }
}

function persistPreferences(preferences: AppPreferences) {
  if (typeof window === 'undefined') {
    return;
  }

  // 总是先写入 localStorage，确保即使后端不可达或后端 struct 缺少新字段（如 debugMode）
  // 被反序列化丢弃，重启后仍能从 localStorage 恢复完整偏好。
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch (fallbackError) {
    console.warn('Failed to persist app preferences to localStorage.', fallbackError);
  }

  patchAppData({ preferences }).catch((error) => {
    console.warn('Failed to persist app preferences to backend.', error);
  });
}

const initialPreferences = readStoredPreferences();

export const usePreferencesStore = create<PreferencesState>((set) => ({
  ...initialPreferences,
  hydratePreferences: (preferences) => set((state) => ({
    ...preferences,
    // debugMode 是纯客户端运行时开关，不从后端 hydrate。
    // 原因：后端旧数据文件不含 debug_mode 字段，反序列化时 #[serde(default)] 会填 false，
    // 若直接覆盖会把用户已开启的 debugMode 重置为 false。
    // debugMode 通过 localStorage 持久化（persistPreferences 总是写 localStorage）。
    debugMode: state.debugMode,
  })),
  setPreferences: (preferences) => {
    set((state) => {
      const next = { ...state, ...preferences };
      persistPreferences({
        language: next.language,
        sendShortcut: next.sendShortcut,
        autoGenerateConversationTitles: next.autoGenerateConversationTitles,
        autoGenerateReasoningTitles: next.autoGenerateReasoningTitles,
        debugMode: next.debugMode,
      });
      return preferences;
    });
  },
}));
