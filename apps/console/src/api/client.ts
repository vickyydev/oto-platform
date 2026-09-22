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
 * rather than to show an error a reader cannot act on. A 404 is the only
 * status that means that: every other failure is a real failure and is shown
 * as one.
 */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string; details?: unknown } }
    | null;
  if (!res.ok) {
    const err = data?.error;
    // Session died mid-use (expiry, deactivation, signed out elsewhere): tell
    // the shell so the console returns to its sign-in panel rather than leaving
    // a dashboard of panels that all refuse.
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/public')) {
      window.dispatchEvent(new CustomEvent('oto:unauthorized'));
    }
    // 423: the session is alive but locked, by the till or another tab. The
    // password re-opens the same session from either side.
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
  patch: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('PATCH', path, body, opts),
  // A DELETE is a write like any other, and the platform's rule is that every
  // write carries a key: the api's idempotency plugin covers all four methods.
  delete: <T>(path: string, opts?: { idempotencyKey?: string }) =>
    request<T>('DELETE', path, undefined, opts),
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
