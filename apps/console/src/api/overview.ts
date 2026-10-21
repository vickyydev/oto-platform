import { withHandoffTarget } from '@oto/shared/handoff-target';
import type { ApiResponse } from '@oto/api-types';
import { api, idemKey, qs } from './client';

export type OverviewSnapshot = ApiResponse<'/overview', 'get'>;
export type OverviewTotals = OverviewSnapshot['totals'];
export type OverviewBranch = OverviewSnapshot['branches'][number];
export type OverviewPark = OverviewSnapshot['parks'][number];

export type OverviewSource = 'performance' | 'occupancy' | 'inbox';

const sourceTargets: Record<OverviewSource, { app: 'pos' | 'inbox'; path: string }> = {
  performance: { app: 'pos', path: '/today' },
  occupancy: { app: 'pos', path: '/today' },
  inbox: { app: 'inbox', path: '/?unanswered=1' },
};

export const overviewApi = {
  read: (branchId: string) => api.get<ApiResponse<'/overview', 'get'>>(`/overview${qs({ branchId })}`),
  /** The existing sign-on seam supplies the configured origin and preserves the source app's guards. */
  openSource: async (source: OverviewSource) => {
    const target = sourceTargets[source];
    const issued = await api.post('/auth/handoff', { app: target.app }, {
      idempotencyKey: idemKey(),
    });
    if (typeof issued !== 'object' || issued === null || !('launchUrl' in issued) ||
      typeof issued.launchUrl !== 'string' || !issued.launchUrl) {
      throw new Error('This source app has no configured destination.');
    }
    window.location.assign(withHandoffTarget(issued.launchUrl, target.path));
  },
};
