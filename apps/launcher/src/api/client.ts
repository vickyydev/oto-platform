// Fetch wrapper for the platform API, the same one the till uses
// (apps/pos/src/api/client.ts): same-origin through the /api rewrite, so the
// session cookie travels on its own and no CORS is involved.

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
 * What one call may add. Most of the launcher's writes want no replay key: a
 * sign-in is a new session and a hand-off is a credential the API deliberately
 * keeps out of the replay store. The assistant's answer feedback (SCRUM-591
 * I3a) is a plain mutation and carries one; the ask itself does not need one,
 * because the API answers a resend by the ask's own client-named id.
 *
 * `onResponse` sees the headers of a successful answer — the ask panel reads
 * `x-oto-replay` from it to know an answer came from the ask's row.
 */
export interface RequestOptions {
  idempotencyKey?: string;
  onResponse?: (headers: Headers) => void;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
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
    // Session died mid-use (expiry, deactivation, reset elsewhere): tell the
    // shell so the launcher returns to its sign-in panel rather than leaving a
    // grid of tiles that all refuse.
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/public')) {
      window.dispatchEvent(new CustomEvent('oto:unauthorized'));
    }
    // 423: the session is alive but locked, by the till or another tab. The
    // launcher cannot unlock it — that is the till's own password prompt — so
    // it says so instead of failing quietly.
    if (res.status === 423) {
      window.dispatchEvent(new CustomEvent('oto:session-locked'));
    }
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? res.statusText, err?.details);
  }
  opts.onResponse?.(res.headers);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
};
