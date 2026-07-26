import { createRoot } from "react-dom/client";
import App from "./app/App.tsx";
import { ErrorBoundary } from "./app/components/ui/ErrorBoundary.tsx";
import "./styles/index.css";
import { useThemeStore } from "./app/store/useThemeStore.ts";

function initializeTheme() {
  try {
    const storedTheme = window.localStorage.getItem('theme-mode');
    const theme = (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') 
      ? storedTheme 
      : 'system';
    
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    
    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  } catch (error) {
    console.warn('Failed to initialize theme:', error);
    document.documentElement.classList.add('light');
  }
}

initializeTheme();

useThemeStore.setState(() => {
  return {};
});

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary
    fallback={
      <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
        <div className="w-full max-w-[420px] rounded-[28px] border border-border bg-background px-6 py-7 shadow-[0_24px_60px_-32px_rgba(0,0,0,0.28)]">
          <p className="text-[12px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">Runtime Error</p>
          <h1 className="mt-3 text-[24px] font-semibold tracking-tight text-foreground">界面加载失败</h1>
          <p className="mt-3 text-[14px] leading-6 text-muted-foreground">
            应用在初始化时触发了运行时异常。请刷新页面重试；如果仍然出现，请打开控制台查看错误信息。
          </p>
        </div>
      </div>
    }
  >
    <App />
  </ErrorBoundary>
);
