import type { ApiResponse } from '@oto/api-types';
import { api, qs } from './client';

export type SuiteApps = ApiResponse<'/console/apps', 'get'>;
export type SuiteReleases = ApiResponse<'/console/releases', 'get'>;
export type SuiteAgents = ApiResponse<'/console/releases/agents', 'get'>;

/** Recorded metadata only; these reads never invoke a provider or deployment. */
export const suiteControlsApi = {
  apps: () => api.get<ApiResponse<'/console/apps', 'get'>>('/console/apps'),
  releases: (offset = 0) => api.get<ApiResponse<'/console/releases', 'get'>>(`/console/releases${qs({ limit: 50, offset })}`),
  agents: (offset = 0) => api.get<ApiResponse<'/console/releases/agents', 'get'>>(`/console/releases/agents${qs({ limit: 50, offset })}`),
};
