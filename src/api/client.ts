const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

if (import.meta.env.DEV && /:8081(\/|$)/.test(BASE_URL)) {
  console.warn(
    '[api] VITE_API_URL must point to the Spring Cloud Gateway (default :8080), not the backend (:8081). ' +
      'Browser requests cannot send X-Gateway-Internal; calls to :8081 return 403 and the login page user list will be empty.',
  );
}

const TOKEN_STORAGE_KEY = 'jira_auth_token';

/**
 * fetch() rejects with an opaque TypeError ("Failed to fetch") when the server is
 * unreachable (gateway down/restarting) — surface something actionable instead.
 */
async function fetchOrConnectError(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error('Cannot reach the server — please check that the backend is running, then try again.');
  }
}

let inMemoryToken: string | null = localStorage.getItem(TOKEN_STORAGE_KEY);

export function setAuthToken(token: string) {
  inMemoryToken = token;
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearAuthToken() {
  inMemoryToken = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function getStoredAuthToken(): string | null {
  return inMemoryToken ?? localStorage.getItem(TOKEN_STORAGE_KEY);
}

/**
 * Paths that must not send a Bearer token: the API gateway validates JWT on every request that includes one.
 * Stale/invalid tokens would break login and user bootstrap (401) even though these routes are permitAll.
 */
function shouldSendBearer(path: string): boolean {
  return !path.startsWith('/api/auth') && !path.startsWith('/api/users');
}

/**
 * A 401 on a request we authenticated means the stored JWT expired/was revoked.
 * Without this the failure is swallowed by callers' `.catch` and the UI hangs on
 * "Loading…" forever. Clear the session and let UserContext bounce to /login.
 */
function handleUnauthorized(bearerSent: boolean) {
  if (!bearerSent) return;
  clearAuthToken();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('auth:session-expired'));
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getStoredAuthToken();
  const mergedHeaders: HeadersInit = {
    ...(options?.headers ?? {}),
  };
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (!isFormData && !(mergedHeaders as Record<string, string>)['Content-Type']) {
    (mergedHeaders as Record<string, string>)['Content-Type'] = 'application/json';
  }
  if (
    token &&
    shouldSendBearer(path) &&
    !(mergedHeaders as Record<string, string>).Authorization
  ) {
    (mergedHeaders as Record<string, string>).Authorization = `Bearer ${token}`;
  }

  const bearerSent = Boolean((mergedHeaders as Record<string, string>).Authorization);
  const res = await fetchOrConnectError(`${BASE_URL}${path}`, {
    ...options,
    headers: mergedHeaders,
  });
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized(bearerSent);
    const text = await res.text().catch(() => '');
    let message = `API error ${res.status}`;
    if (text) {
      try {
        const body = JSON.parse(text) as { message?: string; error?: string };
        message = body.message ?? body.error ?? text;
      } catch {
        message = text;
      }
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;

  // Some endpoints return 200 with an empty body.
  // Avoid JSON.parse errors for those responses.
  const contentLength = res.headers.get('content-length');
  const contentType = res.headers.get('content-type') ?? '';
  if (contentLength === '0') return undefined as T;
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    if (!text.trim()) return undefined as T;
    return text as T;
  }

  const text = await res.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

async function raw(path: string, options?: RequestInit): Promise<Response> {
  const token = getStoredAuthToken();
  const mergedHeaders: HeadersInit = {
    ...(options?.headers ?? {}),
  };
  if (
    token &&
    shouldSendBearer(path) &&
    !(mergedHeaders as Record<string, string>).Authorization
  ) {
    (mergedHeaders as Record<string, string>).Authorization = `Bearer ${token}`;
  }
  const bearerSent = Boolean((mergedHeaders as Record<string, string>).Authorization);
  const res = await fetchOrConnectError(`${BASE_URL}${path}`, {
    ...options,
    headers: mergedHeaders,
  });
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized(bearerSent);
    const text = await res.text().catch(() => '');
    let message = `API error ${res.status}`;
    if (text) {
      try {
        const body = JSON.parse(text) as { message?: string; error?: string };
        message = body.message ?? body.error ?? text;
      } catch {
        message = text;
      }
    }
    throw new Error(message);
  }
  return res;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  postForm: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: 'POST', body: formData, headers: {} }),
  getBlob: async (path: string) => {
    const res = await raw(path);
    return res.blob();
  },
};
