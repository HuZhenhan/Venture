import { useEffect } from "react";
import { MainLayout } from "./components/MainLayout";
import { FpsOverlay } from "./components/debug/FpsOverlay";
import { useThemeStore } from "./store/useThemeStore";
import { useChatStore } from "./store/useChatStore";
import { usePreferencesStore } from "./store/usePreferencesStore";
import { getAppData } from "./services/appDataService";
import {
  installGlobalErrorLogger,
  debugLog,
} from "./utils/debugLogger";
import { printVentureBanner } from "../utils/bannerPrinter";

// 应用启动时立即安装全局错误捕获钩子（在 App 组件外，确保尽早生效）
installGlobalErrorLogger();
debugLog("app", "module loaded", {
  userAgent:
    typeof navigator !== "undefined"
      ? navigator.userAgent
      : "n/a",
});
printVentureBanner();

export default function App() {
  const theme = useThemeStore((state) => state.theme);
  const loadApiConfigs = useChatStore(
    (state) => state.loadApiConfigs,
  );

  useEffect(() => {
    debugLog("app", "App mounted");
    getAppData()
      .then((data) => {
        useChatStore
          .getState()
          .hydrateAppData(data.chats, data.activeChatId);
        usePreferencesStore
          .getState()
          .hydratePreferences(data.preferences);
        useThemeStore.getState().hydrateTheme(data.theme);
      })
      .catch((error) => {
        debugLog(
          "app",
          "load unified app data failed, keeping local fallback",
          { error },
        );
      });
    loadApiConfigs();
    return () => {
      debugLog("app", "App unmounted");
    };
  }, [loadApiConfigs]);

  useEffect(() => {
    const root = window.document.documentElement;

    const applyTheme = () => {
      root.classList.remove("light", "dark");
      if (theme === "system") {
        const systemTheme = window.matchMedia(
          "(prefers-color-scheme: dark)",
        ).matches
          ? "dark"
          : "light";
        root.classList.add(systemTheme);
      } else {
        root.classList.add(theme);
      }
    };

    applyTheme();

    if (theme === "system") {
      const mediaQuery = window.matchMedia(
        "(prefers-color-scheme: dark)",
      );
      const handleChange = () => applyTheme();
      mediaQuery.addEventListener("change", handleChange);
      return () =>
        mediaQuery.removeEventListener("change", handleChange);
    }
  }, [theme]);

  return (
    <>
      <MainLayout />
      <FpsOverlay />
    </>
  );
}