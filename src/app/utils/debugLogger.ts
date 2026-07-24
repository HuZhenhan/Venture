/**
 * 调试日志工具
 * - 前缀识别方便过滤（在 logs/latest.log 中搜 [debug:upload] 即可）
 * - 自动截断超长内容（如 dataUrl），防止日志爆炸
 * - 通过 console.log/warn/error 输出，Electron 主进程会捕获并写入日志文件
 * - 生产环境下 debugLog 静默；debugWarn/debugError 保留以便定位线上问题
 */

const MAX_STRING_LENGTH = 200;

// Vite: import.meta.env.DEV in dev, PROD in prod build.
// Fallback: NODE_ENV !== 'production' when running in a non-Vite context.
const IS_DEV: boolean = (() => {
  try {
    // @ts-ignore - import.meta.env may not exist in non-Vite runtime
    if (typeof import.meta !== 'undefined' && import.meta && (import.meta as any).env) {
      // @ts-ignore
      return Boolean((import.meta as any).env.DEV);
    }
  } catch {
    // ignore
  }
  try {
    if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV) {
      return process.env.NODE_ENV !== 'production';
    }
  } catch {
    // ignore
  }
  return true;
})();

function truncate(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, MAX_STRING_LENGTH)}...(truncated, total=${value.length})`;
    }
    return value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 5).join('\n') };
  }
  if (Array.isArray(value)) {
    return value.map(truncate);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncate(v);
    }
    return out;
  }
  return value;
}

function formatArgs(args: unknown[]): string {
  return args.map((a) => {
    const t = truncate(a);
    if (typeof t === 'string') return t;
    try {
      return JSON.stringify(t);
    } catch {
      return String(t);
    }
  }).join(' ');
}

export function debugLog(scope: string, ...args: unknown[]) {
  if (!IS_DEV) return;
  console.log(`[debug:${scope}]`, formatArgs(args));
}

export function debugWarn(scope: string, ...args: unknown[]) {
  console.warn(`[debug:${scope}]`, formatArgs(args));
}

export function debugError(scope: string, ...args: unknown[]) {
  console.error(`[debug:${scope}]`, formatArgs(args));
}

/** 全局装载渲染进程未捕获错误钩子，保证任何异常都被记录 */
let installed = false;
export function installGlobalErrorLogger() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    const err = event.error;
    debugError('window.error', {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      col: event.colno,
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    debugError('unhandledrejection', {
      reason: reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : String(reason),
    });
  });

  debugLog('logger', 'global error logger installed');
}
