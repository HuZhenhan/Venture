const FALLBACK_BASE_URL = 'http://127.0.0.1:49527';

let resolvedBaseUrl: string | null = null;

export async function getBackendBaseUrl(): Promise<string> {
  if (resolvedBaseUrl) return resolvedBaseUrl;
  if (typeof window !== 'undefined' && window.desktopShell?.getBackendInfo) {
    try {
      const info = await window.desktopShell.getBackendInfo();
      resolvedBaseUrl = info.baseUrl;
      return resolvedBaseUrl;
    } catch {
    }
  }
  resolvedBaseUrl = FALLBACK_BASE_URL;
  return resolvedBaseUrl;
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
