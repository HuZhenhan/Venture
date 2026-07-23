import type { Chat } from '../types';
import type { AppPreferences } from '../store/usePreferencesStore';
import type { ThemeMode } from '../store/useThemeStore';
import { backendGet, backendPatch, backendPost, backendPut, BackendRequestError } from './backendClient';

export interface AppData {
  chats: Chat[];
  activeChatId: string | null;
  preferences: AppPreferences;
  theme: ThemeMode;
  updatedAt: number;
}

export interface AppDataPatch {
  chats?: Chat[];
  activeChatId?: string | null;
  preferences?: AppPreferences;
  theme?: ThemeMode;
}

export interface LegacyLocalDataSummary {
  sourceId: string;
  label: string;
  origin: string;
  chatCount: number;
  hasPreferences: boolean;
  hasTheme: boolean;
}

const CHATS_STORAGE_KEY = 'venture-chats';
const ACTIVE_CHAT_ID_STORAGE_KEY = 'venture-active-chat-id';
const PREFERENCES_STORAGE_KEY = 'app-preferences';
const THEME_STORAGE_KEY = 'theme-mode';
const DEFAULT_PREFERENCES: AppPreferences = {
  language: '简体中文',
  sendShortcut: true,
  autoGenerateConversationTitles: true,
  autoGenerateReasoningTitles: true,
};

// 旧版/未重启的后端可能没有 app-data 路由；404 后本次运行直接熔断，避免每次状态变更重复请求。
let appDataBackendUnavailable = false;
let appDataBackendWarningShown = false;

function isAppDataNotFound(error: unknown): boolean {
  return error instanceof BackendRequestError && error.message.includes('HTTP 404');
}

function fallbackAppData(patch: AppDataPatch = {}): AppData {
  const legacy = readLegacyLocalData();
  return {
    chats: patch.chats ?? legacy.chats ?? [],
    activeChatId: patch.activeChatId !== undefined ? patch.activeChatId : legacy.activeChatId ?? null,
    preferences: patch.preferences ?? legacy.preferences ?? DEFAULT_PREFERENCES,
    theme: patch.theme ?? legacy.theme ?? 'system',
    updatedAt: Date.now(),
  };
}

function warnAppDataFallback(message: string, error?: unknown): void {
  if (appDataBackendWarningShown) return;
  appDataBackendWarningShown = true;
  console.warn(message, error);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function readLegacyLocalData(): AppDataPatch {
  if (typeof window === 'undefined') return {};
  const chats = readJson<Chat[]>(CHATS_STORAGE_KEY) ?? undefined;
  const activeChatId = window.localStorage.getItem(ACTIVE_CHAT_ID_STORAGE_KEY);
  const preferences = normalizePreferences(readJson<Partial<AppPreferences> & { autoGenerateTitles?: boolean }>(PREFERENCES_STORAGE_KEY));
  const rawTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  return {
    ...(chats ? { chats } : {}),
    ...(activeChatId ? { activeChatId } : {}),
    ...(preferences ? { preferences } : {}),
    ...(isThemeMode(rawTheme) ? { theme: rawTheme } : {}),
  };
}

export function getLegacyLocalDataSummary(): LegacyLocalDataSummary | null {
  if (typeof window === 'undefined') return null;
  const legacy = readLegacyLocalData();
  const hasData = Boolean(
    legacy.chats?.length || legacy.activeChatId || legacy.preferences || legacy.theme
  );
  if (!hasData) return null;
  return {
    sourceId: 'local-storage-current-origin',
    label: '当前入口 localStorage',
    origin: window.location.origin,
    chatCount: legacy.chats?.length ?? 0,
    hasPreferences: Boolean(legacy.preferences),
    hasTheme: Boolean(legacy.theme),
  };
}

export async function getAppData(): Promise<AppData> {
  if (appDataBackendUnavailable) return fallbackAppData();
  try {
    return await backendGet<AppData>('/api/app-data');
  } catch (error) {
    if (isAppDataNotFound(error)) appDataBackendUnavailable = true;
    warnAppDataFallback('Failed to fetch app data from backend, falling back to local storage:', error);
    return fallbackAppData();
  }
}

export async function replaceAppData(data: AppData): Promise<AppData> {
  if (appDataBackendUnavailable) {
    saveToLocalStorage(data);
    return data;
  }
  try {
    return await backendPut<AppData>('/api/app-data', data);
  } catch (error) {
    if (isAppDataNotFound(error)) appDataBackendUnavailable = true;
    warnAppDataFallback('Failed to replace app data on backend, saving to local storage:', error);
    saveToLocalStorage(data);
    return data;
  }
}

export async function patchAppData(patch: AppDataPatch): Promise<AppData> {
  if (appDataBackendUnavailable) {
    const updated = fallbackAppData(patch);
    saveToLocalStorage(updated);
    return updated;
  }
  try {
    return await backendPatch<AppData>('/api/app-data', patch);
  } catch (error) {
    if (isAppDataNotFound(error)) appDataBackendUnavailable = true;
    warnAppDataFallback('Failed to patch app data on backend, updating local storage:', error);
    const updated = fallbackAppData(patch);
    saveToLocalStorage(updated);
    return updated;
  }
}

function saveToLocalStorage(data: AppDataPatch & { updatedAt?: number }) {
  if (typeof window === 'undefined') return;
  if (data.chats) window.localStorage.setItem(CHATS_STORAGE_KEY, JSON.stringify(data.chats));
  if (data.activeChatId !== undefined) window.localStorage.setItem(ACTIVE_CHAT_ID_STORAGE_KEY, data.activeChatId || '');
  if (data.preferences) window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(data.preferences));
  if (data.theme) window.localStorage.setItem(THEME_STORAGE_KEY, data.theme);
}

export async function migrateLegacyLocalData(): Promise<AppData> {
  const source = readLegacyLocalData();
  return backendPost<AppData>('/api/app-data/migrate', { source });
}

function normalizePreferences(
  value: (Partial<AppPreferences> & { autoGenerateTitles?: boolean }) | null,
): AppPreferences | null {
  if (!value) return null;
  const legacyAutoGenerateTitles =
    typeof value.autoGenerateTitles === 'boolean' ? value.autoGenerateTitles : undefined;
  return {
    language: value.language === 'English' || value.language === '日本語' || value.language === '简体中文'
      ? value.language
      : DEFAULT_PREFERENCES.language,
    sendShortcut: typeof value.sendShortcut === 'boolean' ? value.sendShortcut : DEFAULT_PREFERENCES.sendShortcut,
    autoGenerateConversationTitles: typeof value.autoGenerateConversationTitles === 'boolean'
      ? value.autoGenerateConversationTitles
      : legacyAutoGenerateTitles ?? DEFAULT_PREFERENCES.autoGenerateConversationTitles,
    autoGenerateReasoningTitles: typeof value.autoGenerateReasoningTitles === 'boolean'
      ? value.autoGenerateReasoningTitles
      : legacyAutoGenerateTitles ?? DEFAULT_PREFERENCES.autoGenerateReasoningTitles,
  };
}
