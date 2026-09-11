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
