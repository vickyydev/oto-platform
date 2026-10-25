import { withHandoffTarget } from '@oto/shared/handoff-target';
import type { ApiResponse } from '@oto/api-types';
import { api, idemKey, qs } from './client';

export type OverviewSnapshot = ApiResponse<'/overview', 'get'>;
export type OverviewTotals = OverviewSnapshot['totals'];
export type OverviewBranch = OverviewSnapshot['branches'][number];
export type OverviewPark = OverviewSnapshot['parks'][number];
export type OverviewAggregates = OverviewSnapshot['aggregates'];
export type OverviewDecisions = OverviewSnapshot['decisions'];

export type OverviewSource = 'performance' | 'occupancy' | 'inbox' | 'end-of-day';

const sourceTargets: Record<OverviewSource, { app: 'pos' | 'inbox'; path: string }> = {
  performance: { app: 'pos', path: '/today' },
  occupancy: { app: 'pos', path: '/today' },
  inbox: { app: 'inbox', path: '/?unanswered=1' },
  'end-of-day': { app: 'pos', path: '/today' },
};

export const overviewApi = {
  read: (branchId: string) => api.get<ApiResponse<'/overview', 'get'>>(`/overview${qs({ branchId })}`),
  /** The existing sign-on seam supplies the configured origin and preserves the source app's guards. */
  openSource: async (source: OverviewSource, isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    const target = sourceTargets[source];
    const issued = await api.post('/auth/handoff', { app: target.app }, {
      idempotencyKey: idemKey(),
    });
    if (!isCurrent()) return;
    if (typeof issued !== 'object' || issued === null || !('launchUrl' in issued) ||
      typeof issued.launchUrl !== 'string' || !issued.launchUrl) {
      throw new Error('This source app has no configured destination.');
    }
    try { window.location.assign(withHandoffTarget(issued.launchUrl, target.path)); }
    catch { throw new Error('The source screen could not be opened. Try again.'); }
  },
};
