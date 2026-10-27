import type { ApiBody, ApiResponse } from '@oto/api-types';
import { api, qs } from './client';

export type SuiteApps = ApiResponse<'/console/apps', 'get'>;
export type SuiteReleases = ApiResponse<'/console/releases', 'get'>;
export type SuiteAgents = ApiResponse<'/console/releases/agents', 'get'>;
/** SCRUM-643: the typed flag catalogue, stored overrides and open two-admin approvals. */
export type SuiteFlags = ApiResponse<'/console/flags', 'get'>;
export type SuiteFlagPreview = ApiResponse<'/console/flags/preview', 'get'>;
export type SuiteMaintenanceSet = ApiBody<'/console/apps/{key}/maintenance', 'put'>;
export type SuiteFlagRequest = ApiBody<'/console/flags/approvals', 'post'>;
export type SuiteApproval = ApiResponse<'/console/flags/approvals', 'post'>;
type AppKey = SuiteApps['apps'][number]['key'];

/** Recorded metadata only; these reads never invoke a provider or deployment. */
export const suiteControlsApi = {
  apps: () => api.get<ApiResponse<'/console/apps', 'get'>>('/console/apps'),
  releases: (offset = 0) => api.get<ApiResponse<'/console/releases', 'get'>>(`/console/releases${qs({ limit: 50, offset })}`),
  agents: (offset = 0) => api.get<ApiResponse<'/console/releases/agents', 'get'>>(`/console/releases/agents${qs({ limit: 50, offset })}`),
  flags: () => api.get<SuiteFlags>('/console/flags'),
  /** The same resolver the consumers enforce with; writes nothing. */
  preview: (input: { key: string; scopeType: string; scopeId?: string; operatorId?: string; value: string }) =>
    api.get<SuiteFlagPreview>(`/console/flags/preview${qs(input)}`),
  /**
   * SCRUM-643 writes. Platform administrators only; each takes the typed
   * confirmation and a reason, and a caller-held key so a retry is the same change.
   */
  setMaintenance: (app: AppKey, body: SuiteMaintenanceSet, idempotencyKey: string) =>
    api.put<ApiResponse<'/console/apps/{key}/maintenance', 'put'>>(`/console/apps/${app}/maintenance`, body, { idempotencyKey }),
  clearMaintenance: (app: AppKey, body: ApiBody<'/console/apps/{key}/maintenance/clear', 'post'>, idempotencyKey: string) =>
    api.post<ApiResponse<'/console/apps/{key}/maintenance/clear', 'post'>>(`/console/apps/${app}/maintenance/clear`, body, { idempotencyKey }),
  /** Direct set, only when the server reports no second approval for kill switches (CONSOLE_DUAL_CONTROL). */
  setSwitch: (body: ApiBody<'/console/flags', 'put'>, idempotencyKey: string) =>
    api.put<ApiResponse<'/console/flags', 'put'>>('/console/flags', body, { idempotencyKey }),
  requestSwitch: (body: SuiteFlagRequest, idempotencyKey: string) =>
    api.post<SuiteApproval>('/console/flags/approvals', body, { idempotencyKey }),
  approveSwitch: (id: string, body: ApiBody<'/console/flags/approvals/{id}/approve', 'post'>, idempotencyKey: string) =>
    api.post<ApiResponse<'/console/flags/approvals/{id}/approve', 'post'>>(`/console/flags/approvals/${id}/approve`, body, { idempotencyKey }),
  applySwitch: (id: string, body: ApiBody<'/console/flags/approvals/{id}/apply', 'post'>, idempotencyKey: string) =>
    api.post<ApiResponse<'/console/flags/approvals/{id}/apply', 'post'>>(`/console/flags/approvals/${id}/apply`, body, { idempotencyKey }),
  clearSwitch: (body: ApiBody<'/console/flags/clear', 'post'>, idempotencyKey: string) =>
    api.post<ApiResponse<'/console/flags/clear', 'post'>>('/console/flags/clear', body, { idempotencyKey }),
};
