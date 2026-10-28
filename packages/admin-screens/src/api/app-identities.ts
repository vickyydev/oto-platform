import type { ApiBody, ApiResponse } from '@oto/api-types';
import { PERMISSIONS, type Permission } from '@oto/shared/permissions';
import type { AdminApi } from './admin-api';

export type AppAccessPermission = Extract<Permission, `app:${string}:access`>;
export type AppKey = AppAccessPermission extends `app:${infer Key}:access` ? Key : never;
const isAppAccess = (permission: Permission): permission is AppAccessPermission =>
  permission.startsWith('app:') && permission.endsWith(':access');
export const APP_KEYS: AppKey[] = PERMISSIONS.filter(isAppAccess).map(
  permission => permission.slice('app:'.length, -':access'.length) as AppKey,
);
export const appAccessPermission = (app: AppKey): AppAccessPermission => `app:${app}:access`;
export type AppIdentity = ApiResponse<'/admin/apps/users/{accountId}', 'get'>['identities'][number];
export type UnlinkedOtoAppUsers = ApiResponse<'/admin/apps/oto_app/unlinked-users', 'get'>;
export type UnlinkedOtoAppUser = UnlinkedOtoAppUsers['users'][number];
type ProvisionBody = ApiBody<'/admin/apps/{app}/users', 'post'>;
type LinkBody = Pick<ProvisionBody, 'externalUserId' | 'otoApp' | 'branchIds'> & { accountId: string };
export type OtoAppRole = NonNullable<ProvisionBody['otoApp']>['role'];

/** The existing app vocabulary; the later role-mapping phase does not change this picker. */
export const OTO_APP_ROLES = [
  { value: 'global_admin', label: 'Global admin' },
  { value: 'operator_admin', label: 'Operator admin' },
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'staff', label: 'Staff' },
] as const satisfies ReadonlyArray<{ value: OtoAppRole; label: string }>;

/** Explicit route absence and legacy Fastify UNKNOWN404; named records retain their real reason. */
export const isMissingRoute = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'status' in error && error.status === 404 &&
  'code' in error && (error.code === 'UNKNOWN' || error.code === 'ROUTE_NOT_FOUND');

const key = () => crypto.randomUUID();
const accountPath = (app: AppKey, accountId: string) =>
  `/admin/apps/${encodeURIComponent(app)}/users/${encodeURIComponent(accountId)}`;

export function createAppIdentitiesApi(api: AdminApi) {
  return {
    list: (accountId: string) => api.get<ApiResponse<'/admin/apps/users/{accountId}', 'get'>>(
      `/admin/apps/users/${encodeURIComponent(accountId)}`,
    ),
    link: (app: AppKey, body: LinkBody) => api.post<ApiResponse<'/admin/apps/{app}/users', 'post'>>(
      `/admin/apps/${encodeURIComponent(app)}/users`, body, { idempotencyKey: key() },
    ),
    setOtoAppBranches: (accountId: string, branchIds: string[] | null) =>
      api.put<ApiResponse<'/admin/apps/oto_app/users/{accountId}/branches', 'put'>>(
        `/admin/apps/oto_app/users/${encodeURIComponent(accountId)}/branches`, { branchIds }, { idempotencyKey: key() },
      ),
    unlink: (app: AppKey, accountId: string) => api.delete<ApiResponse<'/admin/apps/{app}/users/{accountId}', 'delete'>>(
      accountPath(app, accountId), { idempotencyKey: key() },
    ),
    unlinkedOtoAppUsers: () => api.get<ApiResponse<'/admin/apps/oto_app/unlinked-users', 'get'>>('/admin/apps/oto_app/unlinked-users'),
  };
}
