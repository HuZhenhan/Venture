const FALLBACK_BASE_URL = 'http://127.0.0.1:49527';
const HEALTH_CHECK_MAX_RETRIES = 10;
const HEALTH_CHECK_INTERVAL_MS = 500;

let resolvedBaseUrl: string | null = null;
let healthCheckPromise: Promise<string> | null = null;

export async function getBackendBaseUrl(): Promise<string> {
  if (resolvedBaseUrl) return resolvedBaseUrl;

  // 复用同一个健康检查 Promise，避免并发重复检测
  if (healthCheckPromise) return healthCheckPromise;

  healthCheckPromise = (async () => {
    // Electron: 试用 desktopShell 获取后端信息
    if (typeof window !== 'undefined' && window.desktopShell?.getBackendInfo) {
      try {
        const info = await window.desktopShell.getBackendInfo();
        resolvedBaseUrl = info.baseUrl;
        return resolvedBaseUrl;
      } catch {
        // fallback
      }
    }

    const base = FALLBACK_BASE_URL;

    // 等待后端就绪（重试机制处理竞态）
    for (let i = 0; i < HEALTH_CHECK_MAX_RETRIES; i++) {
      try {
        const res = await fetch(`${base}/health`, { method: 'GET' });
        if (res.ok) {
          resolvedBaseUrl = base;
          return resolvedBaseUrl;
        }
      } catch {
        // 后端还没就绪，等待后重试
      }
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    }

    // 所有重试都失败了，仍然返回 base URL（让调用方自己处理错误）
    resolvedBaseUrl = base;
    return resolvedBaseUrl;
  })();

  return healthCheckPromise;
}

export interface BackendError {
  code: string;
  message: string;
  retryable: boolean;
}

export class BackendRequestError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  constructor(err: BackendError) {
    super(err.message);
    this.code = err.code;
    this.retryable = err.retryable;
  }
}

async function parseErrorResponse(res: Response): Promise<BackendRequestError> {
  try {
    const json = await res.json();
    if (json?.error) return new BackendRequestError(json.error);
  } catch {
  }
  return new BackendRequestError({
    code: 'UNKNOWN_ERROR',
    message: `HTTP ${res.status} ${res.statusText}`,
    retryable: false,
  });
}

export async function backendGet<T>(path: string): Promise<T> {
  const base = await getBackendBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return res.json() as Promise<T>;
}

export async function backendPost<T>(path: string, body: unknown): Promise<T> {
  const base = await getBackendBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return res.json() as Promise<T>;
}

export async function backendPatch<T>(path: string, body: unknown): Promise<T> {
  const base = await getBackendBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return res.json() as Promise<T>;
}

export async function backendPut<T>(path: string, body: unknown): Promise<T> {
  const base = await getBackendBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return res.json() as Promise<T>;
}

export async function backendDelete<T>(path: string): Promise<T> {
  const base = await getBackendBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return res.json() as Promise<T>;
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const base = await getBackendBaseUrl();
    const res = await fetch(`${base}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
