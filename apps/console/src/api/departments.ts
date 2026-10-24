import type { ApiBody, ApiResponse } from '@oto/api-types';
import { withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey, qs } from './client';

export type DepartmentDirectory = ApiResponse<'/departments/', 'get'>;
export type DirectoryDepartment = DepartmentDirectory['departments'][number];

export const departmentsApi = {
  read: (query: string) => api.get<ApiResponse<'/departments/', 'get'>>(`/departments${qs({ q: query })}`),
  sourceDestination: async (): Promise<string> => {
    const issued = await api.post<ApiResponse<'/auth/handoff', 'post'>>('/auth/handoff',
      { app: 'oto_app' } satisfies ApiBody<'/auth/handoff', 'post'>, { idempotencyKey: idemKey() });
    if (!issued?.launchUrl) throw new Error('OTO App has no configured destination.');
    try {
      const destination = new URL(issued.launchUrl);
      if (!['https:', 'http:'].includes(destination.protocol) || !/^#handoff=[^&]+$/.test(destination.hash)) {
        throw new Error();
      }
    } catch {
      throw new Error('OTO App has no configured destination.');
    }
    return withHandoffTarget(issued.launchUrl, '/departments');
  },
};
