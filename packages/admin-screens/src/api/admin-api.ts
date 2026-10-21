/** The host supplies its authenticated transport; the screens own no app session or catalogue store. */
export interface AdminApi {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
  patch: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
  put: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
  delete: <T>(path: string, options?: { idempotencyKey?: string }) => Promise<T>;
}
