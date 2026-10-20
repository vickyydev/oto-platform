// Fetch wrapper for the platform API, the same one the Console, the till and
// the launcher use (apps/console/src/api/client.ts): same-origin through the
// /api rewrite, so the session cookie travels on its own and no CORS is
// involved.

import { API_PREFIX } from './url';

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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  // A file (the birthday brochure, SCRUM-590) goes as its own bytes under its
  // own type; everything else is JSON.
  const raw = typeof Blob !== 'undefined' && body instanceof Blob;
  const res = await fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': raw ? (body as Blob).type || 'application/octet-stream' : 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: raw ? (body as Blob) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string; details?: unknown } }
    | null;
  if (!res.ok) {
    const err = data?.error;
    // The session died mid-use (expiry, deactivation, signed out elsewhere):
    // tell the shell, so the Inbox returns to its sign-in panel rather than
    // leaving a workspace whose every read refuses.
    if (res.status === 401 && !path.startsWith('/auth')) {
      window.dispatchEvent(new CustomEvent('oto:unauthorized'));
    }
    // 423: alive but locked, by the till or another tab. The password re-opens
    // the same session from either side.
    if (res.status === 423) {
      window.dispatchEvent(new CustomEvent('oto:session-locked'));
    }
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('PATCH', path, body, opts),
  delete: <T>(path: string, opts?: { idempotencyKey?: string }) => request<T>('DELETE', path, undefined, opts),
};

/**
 * A fresh key for one mutation, minted where it happens. Every write carries
 * one (the api's idempotency plugin covers all four methods): the read
 * marker, the actions, the reply, the template settings and the simulator.
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
