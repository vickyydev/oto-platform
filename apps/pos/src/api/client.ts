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

/**
 * Nothing answered at all — the request never reached a server.
 *
 * DELIBERATELY NOT AN `ApiError`. The two are different facts and the till
 * tells them apart in two places that matter: the offline banner counts a
 * no-answer as a miss and an ApiError as proof the platform is reachable
 * (`components/shared/StationLinkBanner.tsx`), and the lock screen shows an
 * error's message to somebody standing at the counter. `fetch` rejects with
 * "Failed to fetch", which is the browser's words for its own plumbing and
 * tells a person on reception nothing; this says what happened in theirs.
 *
 * It matters most on the one screen the service worker can serve with no
 * network at all: the shell comes up, the sign-in is typed, and the only
 * honest answer is that nothing is there to check it against.
 */
export class NetworkError extends Error {
  constructor(public readonly cause?: unknown) {
    super('No answer from the platform. This screen has no connection.');
    this.name = 'NetworkError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new NetworkError(err);
  }
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

/**
 * The same request, for a route that answers with bytes rather than JSON.
 *
 * A rendered preview is a PNG, and it travels here rather than through an
 * `<img src>` for two reasons: the draft being previewed is a request body,
 * and this is the one place that knows every route lives behind `/api`. A
 * failure still arrives as an error envelope, so the JSON path below is the
 * same one `request` takes.
 */
async function requestBlob(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError(err);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as
      | { error?: { code: string; message: string; details?: unknown } }
      | null;
    const err = data?.error;
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/public')) {
      window.dispatchEvent(new CustomEvent('oto:unauthorized'));
    }
    if (res.status === 423) {
      window.dispatchEvent(new CustomEvent('oto:session-locked'));
    }
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? res.statusText, err?.details);
  }
  return res.blob();
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
    request<T>('POST', path, body, opts),
  postBlob: (path: string, body?: unknown, signal?: AbortSignal) =>
    requestBlob('POST', path, body, signal),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export const idemKey = (): string => crypto.randomUUID();
