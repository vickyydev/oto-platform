import type { ApiBody, ApiResponse } from '@oto/api-types';
import { withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey, qs } from './client';

export type StaffSummary = ApiResponse<'/staff/summary', 'get'>;

export const STAFF_SOURCE_TARGETS = Object.freeze({
  working: '/timekeeping-review?tab=live',
  attendance: '/timekeeping-review?tab=issues',
  leave: '/scheduling',
  payroll: '/payroll',
} as const);
export type StaffSource = keyof typeof STAFF_SOURCE_TARGETS;

export const staffApi = {
  read: (branchId?: string | null) => api.get<ApiResponse<'/staff/summary', 'get'>>(`/staff/summary${qs({ branchId: branchId ?? undefined })}`),
  sourceDestination: async (source: StaffSource): Promise<string> => {
    if (!Object.hasOwn(STAFF_SOURCE_TARGETS, source)) throw new Error('That staff page is not available.');
    const issued = await api.post<ApiResponse<'/auth/handoff', 'post'>>('/auth/handoff',
      { app: 'oto_app' } satisfies ApiBody<'/auth/handoff', 'post'>, { idempotencyKey: idemKey() });
    if (!issued?.launchUrl) throw new Error('OTO App has no configured destination.');
    try {
      const destination = new URL(issued.launchUrl);
      if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password
        || !/^#handoff=[^&]+$/.test(destination.hash)) throw new Error();
    } catch {
      throw new Error('OTO App has no configured destination.');
    }
    return withHandoffTarget(issued.launchUrl, STAFF_SOURCE_TARGETS[source]);
  },
};
