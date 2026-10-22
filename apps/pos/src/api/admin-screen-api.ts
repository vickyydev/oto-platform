import type { LiftedAdminApi } from '@oto/admin-screens';
import { api } from './client';

/** Bind the shared screen contract to the POS cookie/session transport. */
export const adminScreenApi: LiftedAdminApi = {
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
