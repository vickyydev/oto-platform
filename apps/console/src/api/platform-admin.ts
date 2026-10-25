import type { ApiQuery, ApiResponse } from '@oto/api-types';
import { api, qs } from './client';

export type PlatformAlerts = ApiResponse<'/platform/alerts', 'get'>;
export type PlatformJobs = ApiResponse<'/platform/jobs', 'get'>;
export type PlatformEnvironment = ApiResponse<'/platform/environment', 'get'>;
export type PlatformAlertQuery = ApiQuery<'/platform/alerts', 'get'>;

/** Read only. Jobs and environment deliberately accept no caller query. */
export const platformAdminApi = {
  alerts: (query: PlatformAlertQuery) => api.get<ApiResponse<'/platform/alerts', 'get'>>(`/platform/alerts${qs({ ...query })}`),
  jobs: () => api.get<ApiResponse<'/platform/jobs', 'get'>>('/platform/jobs'),
  environment: () => api.get<ApiResponse<'/platform/environment', 'get'>>('/platform/environment'),
};
