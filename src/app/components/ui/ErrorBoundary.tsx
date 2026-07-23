import React, { Component, ErrorInfo, ReactNode } from "react";
import { debugError } from "../../utils/debugLogger";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    debugError('errorBoundary', 'componentDidCatch', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="p-6 my-4 bg-red-50/50 dark:bg-red-500/10 border border-red-200/50 dark:border-red-500/20 rounded-2xl text-left">
            <div className="flex items-center gap-2 mb-2">
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-red-500 dark:text-red-400">
                <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1"/>
                <path d="M6 3.5V6.5M6 8.5H6.005" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              </svg>
              <h3 className="text-[13px] font-bold text-red-600 dark:text-red-400 uppercase tracking-wider">组件渲染发生异常</h3>
            </div>
            <p className="text-[12px] text-muted-foreground mb-2 leading-relaxed">
              由于数据转换或组件内部状态原因，该卡片渲染失败。
            </p>
            <pre className="text-[10px] font-mono text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-500/10 p-2.5 rounded-lg overflow-x-auto whitespace-pre-wrap break-all border border-red-100 dark:border-red-500/20">
              {this.state.error?.toString() || "未知错误"}
            </pre>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
