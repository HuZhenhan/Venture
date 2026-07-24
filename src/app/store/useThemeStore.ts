import { create } from 'zustand';
import { patchAppData } from '../services/appDataService';

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'theme-mode';
const FALLBACK_THEME: ThemeMode = 'system';

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return FALLBACK_THEME;
  }
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(storedTheme) ? storedTheme : FALLBACK_THEME;
  } catch (error) {
    console.warn('Failed to read theme from storage, falling back to system theme.', error);
    return FALLBACK_THEME;
  }
}

function persistTheme(theme: ThemeMode) {
  if (typeof window === 'undefined') {
    return;
  }
  applyThemeToDOM(theme);
  patchAppData({ theme }).catch((error) => {
    console.warn('Failed to persist theme selection to backend.', error);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (fallbackError) {
      console.warn('Failed to persist theme selection fallback.', fallbackError);
    }
  });
}

function applyThemeToDOM(theme: ThemeMode) {
  if (typeof window === 'undefined') {
    return;
  }
  
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  
  if (theme === 'system') {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.classList.add(systemTheme);
  } else {
    root.classList.add(theme);
  }
}

interface ThemeState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  hydrateTheme: (theme: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set) => {
  const initialTheme = readStoredTheme();
  
  return {
    theme: initialTheme,
    hydrateTheme: (theme: ThemeMode) => {
      applyThemeToDOM(theme);
      set({ theme });
    },
    setTheme: (theme: ThemeMode) => {
      persistTheme(theme);
      set({ theme });
    },
  };
});
