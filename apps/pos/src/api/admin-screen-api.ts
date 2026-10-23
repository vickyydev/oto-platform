interface RequestOptions { idempotencyKey?: string; headers?: Record<string, string>; signal?: AbortSignal }
interface NativeTransport {
  href: (path: string) => string;
  get: <T>(path: string, options?: RequestOptions) => Promise<T>;
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  put: <T>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  delete: <T>(path: string, options?: RequestOptions) => Promise<T>;
  deleteWithBody: <T>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  getBlob: (path: string, signal?: AbortSignal) => Promise<Blob>;
  postBlob: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Blob>;
  getFile: (path: string, signal?: AbortSignal) => Promise<{ blob: Blob; filename: string | null; contentType: string | null }>;
}
import { api } from './client';

/** The POS cookie/session transport, retaining its existing explicit forwarding boundary. */
export const adminScreenApi: NativeTransport = {
  href: (path) => `/api${path}`,
  get: (path, options) => api.get(path, options),
  post: (path, body, options) => api.post(path, body, options),
  patch: (path, body, options) => api.patch(path, body, options),
  put: (path, body, options) => api.put(path, body, options),
  // POS accepts a body in its second argument; shared base DELETE accepts options.
  delete: (path, options) => api.delete(path, undefined, options),
  deleteWithBody: (path, body, options) => api.delete(path, body, options),
  getBlob: (path, signal) => api.getBlob(path, signal),
  postBlob: (path, body, signal) => api.postBlob(path, body, signal),
  getFile: (path, signal) => api.getFile(path, signal),
};
