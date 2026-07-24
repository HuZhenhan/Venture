import { create } from 'zustand';
import { patchAppData } from '../services/appDataService';

export const AVAILABLE_LANGUAGES = ['简体中文', 'English', '日本語'] as const;
export type AppLanguage = (typeof AVAILABLE_LANGUAGES)[number];

const PREFERENCES_STORAGE_KEY = 'app-preferences';
const DEFAULT_LANGUAGE: AppLanguage = '简体中文';
const DEFAULT_SEND_SHORTCUT = true;
const DEFAULT_AUTO_GENERATE_CONVERSATION_TITLES = true;
const DEFAULT_AUTO_GENERATE_REASONING_TITLES = true;

export interface AppPreferences {
  language: AppLanguage;
  sendShortcut: boolean;
  autoGenerateConversationTitles: boolean;
  autoGenerateReasoningTitles: boolean;
}

interface PreferencesState {
  language: AppLanguage;
  sendShortcut: boolean;
  autoGenerateConversationTitles: boolean;
  autoGenerateReasoningTitles: boolean;
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
      };
    }

    const parsedValue = JSON.parse(rawValue) as {
      language?: unknown;
      sendShortcut?: unknown;
      autoGenerateTitles?: unknown;
      autoGenerateConversationTitles?: unknown;
      autoGenerateReasoningTitles?: unknown;
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
    };
  } catch (error) {
    console.warn('Failed to read app preferences from storage.', error);
    return {
      language: DEFAULT_LANGUAGE,
      sendShortcut: DEFAULT_SEND_SHORTCUT,
      autoGenerateConversationTitles: DEFAULT_AUTO_GENERATE_CONVERSATION_TITLES,
      autoGenerateReasoningTitles: DEFAULT_AUTO_GENERATE_REASONING_TITLES,
    };
  }
}

function persistPreferences(preferences: AppPreferences) {
  if (typeof window === 'undefined') {
    return;
  }

  patchAppData({ preferences }).catch((error) => {
    console.warn('Failed to persist app preferences to backend.', error);
    try {
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    } catch (fallbackError) {
      console.warn('Failed to persist app preferences fallback.', fallbackError);
    }
  });
}

const initialPreferences = readStoredPreferences();

export const usePreferencesStore = create<PreferencesState>((set) => ({
  ...initialPreferences,
  hydratePreferences: (preferences) => set(preferences),
  setPreferences: (preferences) => {
    set((state) => {
      const next = { ...state, ...preferences };
      persistPreferences({
        language: next.language,
        sendShortcut: next.sendShortcut,
        autoGenerateConversationTitles: next.autoGenerateConversationTitles,
        autoGenerateReasoningTitles: next.autoGenerateReasoningTitles,
      });
      return preferences;
    });
  },
}));
