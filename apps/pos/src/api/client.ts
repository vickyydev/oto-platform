// Minimal fetch wrapper for the platform API. Same-origin via the Vite /api
// proxy (session cookie flows automatically). Every mutating helper can carry
// an Idempotency-Key.

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
 * The admin screens ship ahead of parts of the API they read — the app
 * provisioning routes are being built alongside the Apps panel — and a screen
 * in that position should say "not on this deployment yet" rather than show an
 * error the reader cannot act on. The console's helper (apps/console/src/api/
 * client.ts) reads any 404 that way because every route it calls answers 404
 * for one reason only. Here they do not: "that account is not linked to this
 * app" and "no such account" are 404s with meanings of their own, and telling
 * someone the feature is undeployed when the real answer is "already unlinked"
 * sends them to the wrong person. So the code decides. An unrouted request
 * never reaches our error handler — it gets Fastify's own 404 body, which
 * carries none of our codes and arrives here as `UNKNOWN`.
 */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === 'UNKNOWN';
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
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
    // shell so the POS returns to the lock screen instead of failing quietly.
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/public')) {
      window.dispatchEvent(new CustomEvent('oto:unauthorized'));
    }
    // 423: the session is alive but locked (another tab, or the box). Show
    // the lock screen rather than an error the operator cannot act on.
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
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export const idemKey = (): string => crypto.randomUUID();
