export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Field paths reported by the API for validation failures; never values. */
    readonly fields?: readonly string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CSRF_COOKIE_NAME = 'bh_csrf';

/**
 * The CSRF cookie is intentionally readable by this origin (double-submit),
 * while the session cookie stays HttpOnly and is never touched by JavaScript.
 */
function readBrowserCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const entry = document.cookie.split('; ').find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : undefined;
}

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch('/api/v1/auth/csrf', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ApiError(503, 'CSRF_UNAVAILABLE', '无法建立安全会话，请刷新页面后重试');
  }
  const body = (await response.json()) as { csrfToken?: string };
  if (!body.csrfToken) {
    throw new ApiError(503, 'CSRF_UNAVAILABLE', '无法建立安全会话，请刷新页面后重试');
  }
  return body.csrfToken;
}

async function csrfToken(): Promise<string> {
  return readBrowserCookie(CSRF_COOKIE_NAME) ?? (await fetchCsrfToken());
}

export type ApiMethod = 'GET' | 'POST' | 'PATCH';

export interface ApiRequestOptions {
  method?: ApiMethod;
  body?: unknown;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  fields?: string[];
}

/**
 * Same-origin JSON transport shared by every admin feature. Non-GET requests
 * carry the double-submit CSRF token; server role checks remain the real
 * authorization boundary, so this client never assumes a hidden button is enough.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = await csrfToken();

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '网络请求失败，请检查网络连接后重试');
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = payload as Partial<ApiErrorBody> | null;
    throw new ApiError(
      response.status,
      error?.error ?? 'REQUEST_FAILED',
      error?.message ?? '请求失败，请稍后重试',
      Array.isArray(error?.fields) ? error.fields : undefined,
    );
  }

  return payload as T;
}
