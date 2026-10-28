// Fetch wrapper for the platform API, the same one the till and the launcher
// use (apps/pos/src/api/client.ts, apps/launcher/src/api/client.ts):
// same-origin through the /api rewrite, so the session cookie travels on its
// own and no CORS is involved.

import { API_PREFIX, apiUrl } from './url';

export { apiUrl };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * True when the API simply does not have this route on this deployment.
 *
 * The console ships ahead of parts of the observability API it reads, and the
 * pages are written to say "not on this deployment yet" for a missing route
 * rather than to show an error a reader cannot act on. The legacy unstructured
 * UNKNOWN404 keeps that fallback; a structured missing-record reason is a
 * real refusal and must remain visible.
 */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === 'UNKNOWN';
}

type RequestAuthority = { capture: () => number | null; isCurrent: (epoch: number) => boolean };
let requestAuthority: RequestAuthority | null = null;

/** The session provider owns this binding; an old cleanup cannot remove its successor. */
export function installRequestAuthority(authority: RequestAuthority): () => void {
  const binding = { ...authority };
  requestAuthority = binding;
  return () => { if (requestAuthority === binding) requestAuthority = null; };
}

function coordinator(method: string, path: string): boolean {
  return (method === 'GET' && ['/me', '/me/', '/me/permissions'].includes(path))
    || (method === 'PUT' && ['/me/session/branch', '/me/session/operator'].includes(path))
    || (method === 'POST' && ['/auth/sign-in', '/auth/sign-out', '/auth/unlock', '/auth/handoff/exchange'].includes(path));
}

function captureAuthority(method: string, path: string): () => void {
  if (coordinator(method, path)) return () => {};
  const binding = requestAuthority;
  if (!binding) return () => {};
  const epoch = binding.capture();
  const current = () => {
    if (epoch === null || requestAuthority !== binding || !binding.isCurrent(epoch)) {
      throw new ApiError(409, 'SESSION_CONTEXT_CHANGED', 'The current session changed. Read this page again.');
    }
  };
  current();
  return current;
}

function sessionEvents(method: string, path: string, status: number) {
  // Canonical reads and context mutations are checked by their provider epoch.
  // Their late errors must never invalidate a newer confirmed session.
  if (coordinator(method, path)) return;
  if (status === 401 && !path.startsWith('/auth') && !path.startsWith('/public')) {
    window.dispatchEvent(new CustomEvent('oto:unauthorized'));
  }
  if (status === 423) window.dispatchEvent(new CustomEvent('oto:session-locked'));
}

async function whileCurrent<T>(current: () => void, operation: () => Promise<T>): Promise<T> {
  try {
    const answer = await operation();
    current();
    return answer;
  } catch (failure) {
    current();
    throw failure;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const current = captureAuthority(method, path);
  const res = await whileCurrent(current, () => fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  current();
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string; details?: unknown } }
    | null;
  current();
  if (!res.ok) {
    const err = data?.error;
    // Session died mid-use (expiry, deactivation, signed out elsewhere): tell
    // the shell so the console returns to its sign-in panel rather than leaving
    // a dashboard of panels that all refuse.
    // 423: the session is alive but locked, by the till or another tab. The
    // password re-opens the same session from either side.
    sessionEvents(method, path, res.status);
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

async function requestFile(path: string, signal?: AbortSignal) {
    const current = captureAuthority('GET', path);
    const res = await whileCurrent(current, () => fetch(`${API_PREFIX}${path}`, { credentials: 'same-origin', signal }));
    current();
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: { code: string; message: string; details?: unknown } } | null;
      current();
      sessionEvents('GET', path, res.status);
      throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? res.statusText, data?.error?.details);
    }
    const disposition = res.headers.get('content-disposition');
    const filename = disposition ? (/filename="([^"]+)"/.exec(disposition)?.[1] ?? /filename=([^;]+)/.exec(disposition)?.[1]?.trim() ?? null) : null;
    const blob = await whileCurrent(current, () => res.blob());
    current();
    // `headers`: an export's own answers about itself (SCRUM-644 — rows, masking, next cursor).
    return { blob, filename, contentType: res.headers.get('content-type'), headers: res.headers };
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  getBlob: async (path: string, signal?: AbortSignal) => (await requestFile(path, signal)).blob,
  postBlob: async (path: string, body?: unknown, signal?: AbortSignal) => {
    const current = captureAuthority('POST', path);
    const response = await whileCurrent(current, () => fetch(`${API_PREFIX}${path}`, { method: 'POST', credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    current();
    if (!response.ok) {
      const answer = await response.json().catch(() => null) as { error?: { code: string; message: string } } | null;
      current();
      sessionEvents('POST', path, response.status);
      throw new ApiError(response.status, answer?.error?.code ?? 'UNKNOWN', answer?.error?.message ?? response.statusText);
    }
    const blob = await whileCurrent(current, () => response.blob());
    current();
    return blob;
  },
  getFile: requestFile,
  post: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('POST', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('PATCH', path, body, opts),
  // Booth staff are PUT onto a booth and a PIN is PUT onto a person (SCRUM-400):
  // the api's verbs for "make this so", which a retry repeats harmlessly.
  put: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('PUT', path, body, opts),
  // A DELETE is a write like any other, and the platform's rule is that every
  // write carries a key: the api's idempotency plugin covers all four methods.
  delete: <T>(path: string, opts?: { idempotencyKey?: string }) =>
    request<T>('DELETE', path, undefined, opts),
  deleteWithBody: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('DELETE', path, body, opts),
};

/**
 * A fresh key for one mutation, minted where the person pressed the button.
 *
 * The API stores the key with a hash of the request, so a double press, a
 * flaky connection or a retry lands one station, one device, one command —
 * and the second attempt gets the first attempt's answer back rather than a
 * second row. Same helper, same reasoning as apps/pos/src/api/client.ts.
 */
export const idemKey = (): string => crypto.randomUUID();

/** Query string from the filters a page holds, skipping anything unset. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}
