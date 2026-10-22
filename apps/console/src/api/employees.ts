import type { ApiResponse } from '@oto/api-types';
import { safeTargetPath, withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey, qs } from './client';

export type EmployeeDirectory = ApiResponse<'/employees/', 'get'>;
export type DirectoryEmployee = EmployeeDirectory['employees'][number];

/** Source employee IDs are opaque strings; the existing handoff rule validates the target. */
export function employeeSourcePath(employee: Pick<DirectoryEmployee, 'source' | 'externalId'>): string | null {
  if (employee.source !== 'otoapp' || !employee.externalId?.trim()) return null;
  try {
    return safeTargetPath(`/employees/${encodeURIComponent(employee.externalId)}`);
  } catch {
    return null;
  }
}

export const employeesApi = {
  read: (query: string) => api.get<ApiResponse<'/employees/', 'get'>>(`/employees${qs({ q: query })}`),
  sourceDestination: async (employee: DirectoryEmployee): Promise<string> => {
    const target = employeeSourcePath(employee);
    if (!target) throw new Error('The source employee link is unavailable.');
    const issued = await api.post('/auth/handoff', { app: 'oto_app' }, { idempotencyKey: idemKey() });
    if (typeof issued !== 'object' || issued === null || !('launchUrl' in issued) ||
      typeof issued.launchUrl !== 'string' || !issued.launchUrl) {
      throw new Error('OTO App has no configured destination.');
    }
    return withHandoffTarget(issued.launchUrl, target);
  },
};
