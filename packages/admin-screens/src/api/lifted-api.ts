import type { AdminApi } from './admin-api';

export interface LiftedRequestOptions {
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface AdminFile {
  blob: Blob;
  filename: string | null;
  contentType: string | null;
}

/** Required transport capabilities of a host rendering the lifted POS panels. */
export interface LiftedAdminApi extends AdminApi {
  href: (path: string) => string;
  get: <T>(path: string, options?: LiftedRequestOptions) => Promise<T>;
  post: <T>(path: string, body?: unknown, options?: LiftedRequestOptions) => Promise<T>;
  patch: <T>(path: string, body?: unknown, options?: LiftedRequestOptions) => Promise<T>;
  put: <T>(path: string, body?: unknown, options?: LiftedRequestOptions) => Promise<T>;
  delete: <T>(path: string, options?: LiftedRequestOptions) => Promise<T>;
  deleteWithBody: <T>(path: string, body?: unknown, options?: LiftedRequestOptions) => Promise<T>;
  getBlob: (path: string, signal?: AbortSignal) => Promise<Blob>;
  postBlob: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Blob>;
  getFile: (path: string, signal?: AbortSignal) => Promise<AdminFile>;
}
