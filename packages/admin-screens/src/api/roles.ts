import type { ApiBody, ApiQuery, ApiResponse } from '@oto/api-types';
import type { AdminApi } from './admin-api';

export type RoleCatalogue = ApiResponse<'/roles/', 'get'>;
export type PermissionHolders = ApiResponse<'/roles/holders', 'get'>;
export type PermissionPreview = ApiResponse<'/roles/preview', 'get'>;
export type PreviewQuery = ApiQuery<'/roles/preview', 'get'>;
export type AccountPermissions = ApiResponse<'/accounts/{id}/permissions', 'get'>;
export type GrantRole = ApiBody<'/accounts/{id}/role-assignments', 'post'>;

function queryString(query: Record<string, string | null | undefined>): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) result.set(key, value);
  return result.toString();
}
const at = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}`;

export function createRolesApi(api: AdminApi) {
  return {
    catalogue: () => api.get<ApiResponse<'/roles/', 'get'>>('/roles'),
    holders: (permission: string) => api.get<ApiResponse<'/roles/holders', 'get'>>(`/roles/holders?permission=${encodeURIComponent(permission)}`),
    preview: (query: PreviewQuery) => api.get<ApiResponse<'/roles/preview', 'get'>>(`/roles/preview?${queryString(query)}`),
    accountPermissions: (accountId: string) => api.get<ApiResponse<'/accounts/{id}/permissions', 'get'>>(`${at(accountId)}/permissions`),
    grant: (accountId: string, body: GrantRole) => api.post<ApiResponse<'/accounts/{id}/role-assignments', 'post'>>(`${at(accountId)}/role-assignments`, body, { idempotencyKey: crypto.randomUUID() }),
    remove: (accountId: string, assignmentId: string) => api.delete<ApiResponse<'/accounts/{id}/role-assignments/{assignmentId}', 'delete'>>(`${at(accountId)}/role-assignments/${encodeURIComponent(assignmentId)}`, { idempotencyKey: crypto.randomUUID() }),
  };
}
