import type { ApiBody, ApiResponse } from '@oto/api-types';
import type { AdminApi } from './admin-api';

export type AccountRow = ApiResponse<'/accounts/', 'get'>['accounts'][number];
export type SessionRow = ApiResponse<'/accounts/{id}/sessions', 'get'>['sessions'][number];
export type StaffTokenRow = ApiResponse<'/accounts/{id}/staff-tokens', 'get'>['tokens'][number];
export type StaffTokenSettings = ApiResponse<'/staff-tokens/settings', 'get'>;

export interface DenialRow {
  id: string;
  actorAccountId: string | null;
  requestId: string | null;
  after: { code: string; message: string; method: string; url: string } | null;
  createdAt: string;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const nullableString = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** Audit has no response schema yet. Read only these existing fields, and reject an unreadable list. */
export function readDenials(answer: unknown): DenialRow[] {
  if (!record(answer) || !Array.isArray(answer.entries)) throw new Error('The denial list did not return readable entries.');
  return answer.entries.map((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== 'string' || typeof entry.createdAt !== 'string') {
      throw new Error('The denial list contained an unreadable entry.');
    }
    const after = record(entry.after) ? entry.after : null;
    return {
      id: entry.id, createdAt: entry.createdAt,
      actorAccountId: nullableString(entry.actorAccountId), requestId: nullableString(entry.requestId),
      after: after ? {
        code: typeof after.code === 'string' ? after.code : 'DENIED',
        message: typeof after.message === 'string' ? after.message : '',
        method: typeof after.method === 'string' ? after.method : '',
        url: typeof after.url === 'string' ? after.url : '',
      } : null,
    };
  });
}

const freshKey = () => crypto.randomUUID();
const accountPath = (id: string) => `/accounts/${encodeURIComponent(id)}`;

export function createAccountsApi(api: AdminApi) {
  return {
    accounts: (q?: string) => api.get<ApiResponse<'/accounts/', 'get'>>(`/accounts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    createAccount: (body: ApiBody<'/accounts/', 'post'>) =>
      api.post<ApiResponse<'/accounts/', 'post'>>('/accounts', body, { idempotencyKey: freshKey() }),
    updateAccount: (id: string, patch: ApiBody<'/accounts/{id}', 'patch'>) =>
      api.patch<ApiResponse<'/accounts/{id}', 'patch'>>(accountPath(id), patch, { idempotencyKey: freshKey() }),
    tempPassword: (id: string) =>
      api.post<ApiResponse<'/accounts/{id}/temp-password', 'post'>>(`${accountPath(id)}/temp-password`, undefined, { idempotencyKey: freshKey() }),
    accountSessions: (id: string) => api.get<ApiResponse<'/accounts/{id}/sessions', 'get'>>(`${accountPath(id)}/sessions`),
    revokeSessions: (id: string) => api.post<ApiResponse<'/accounts/{id}/sessions/revoke', 'post'>>(`${accountPath(id)}/sessions/revoke`, undefined, { idempotencyKey: freshKey() }),
    accountStaffTokens: (id: string) => api.get<ApiResponse<'/accounts/{id}/staff-tokens', 'get'>>(`${accountPath(id)}/staff-tokens`),
    endStaffToken: (jti: string) => api.delete<ApiResponse<'/staff-tokens/{jti}', 'delete'>>(`/staff-tokens/${encodeURIComponent(jti)}`, { idempotencyKey: freshKey() }),
    staffTokenSettings: () => api.get<ApiResponse<'/staff-tokens/settings', 'get'>>('/staff-tokens/settings'),
    recentDenials: async (limit = 10) => ({ entries: readDenials(await api.get(`/audit?action=access.denied&limit=${limit}`)) }),
  };
}
