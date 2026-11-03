// Thin fetch wrapper: attaches the JWT, points at /api (same-origin in
// production behind nginx; proxied by Vite in local dev — see
// vite.config.ts), and throws on non-2xx so callers can just await + catch.

const TOKEN_KEY = 'fratoo_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    throw new ApiError(401, 'Session expired — please log in again.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.message ?? `Request failed (HTTP ${res.status})`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Reports use a raw fetch (not the JSON helper above): the answer is a PDF or an HTML page, not JSON. */
async function fetchReport(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    clearToken();
    throw new ApiError(401, 'Session expired — please log in again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.message ?? 'Failed to make the report');
  }
  return res.blob();
}

/** The batch report as an A4 PDF (rendered on the server by Gotenberg). */
export async function downloadReportPdf(batchId: number, suggestedFilename: string): Promise<void> {
  const blob = await fetchReport(`/batches/${batchId}/report/pdf`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked later, not at once: some browsers (iOS) are still reading it after click().
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The report page in a new tab, to read or print from the browser. The tab is
 * opened before the fetch, while the click still counts as a user gesture
 * (popup blockers), then pointed at the page once it has loaded.
 */
export async function openReportPrintView(batchId: number): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const blob = await fetchReport(`/batches/${batchId}/report`);
    const url = URL.createObjectURL(new Blob([blob], { type: 'text/html' }));
    if (tab) tab.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
