import type { BoothReport } from '@oto/shared';
import { api, apiUrl, qs } from './client';

/**
 * Console > Booths > Report — S2-15b round 5 (plan
 * docs/progress/plans/analytics/PLAN.md §8). `GET /analytics/booths` reads
 * `analytics.fact_booth_daily`, the booth rollup's per-day funnel, for the
 * branches the account holds `analytics:read` at: one branch, or every one
 * when `branchId` is empty.
 */
export interface BoothReportQuery {
  branchId: string;
  from: string;
  to: string;
}

const params = (q: BoothReportQuery) => qs({ branches: q.branchId || undefined, from: q.from, to: q.to });

export const boothReportApi = {
  read: (q: BoothReportQuery) => api.get<BoothReport>('/analytics/booths' + params(q)),
  exportUrl: (q: BoothReportQuery) => apiUrl('/analytics/booths/export' + params(q)),
};
