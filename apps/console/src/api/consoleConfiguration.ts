import type { ApiResponse } from '@oto/api-types';
import { withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey } from './client';

export type AnalyticsMetadata = ApiResponse<'/console/analytics', 'get'>;
export type ConfigurationIndex = ApiResponse<'/console/configuration', 'get'>;
export type AnalyticsSummary = ApiResponse<'/analytics/summary', 'get'>;

export const consoleConfigurationApi = {
  analytics: () => api.get<ApiResponse<'/console/analytics', 'get'>>('/console/analytics'),
  configuration: (branchId: string) => api.get<ApiResponse<'/console/configuration', 'get'>>(
    '/console/configuration' + (branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''),
  ),
  summary: (from: string, to: string, branches: readonly string[]) => {
    const query = new URLSearchParams({ from, to, group: 'total', branches: branches.join(',') });
    return api.get<ApiResponse<'/analytics/summary', 'get'>>(`/analytics/summary?${query}`);
  },
  openInApp: async (target: { app: 'oto_app' | 'radar' | 'inbox'; path: string }, isCurrent: () => boolean) => {
    const issued = await api.post('/auth/handoff', { app: target.app }, { idempotencyKey: idemKey() });
    if (typeof issued !== 'object' || issued === null || !('launchUrl' in issued) ||
      typeof issued.launchUrl !== 'string' || !issued.launchUrl) {
      throw new Error('The settings owner has no configured destination.');
    }
    if (!isCurrent()) return;
    try {
      window.location.assign(withHandoffTarget(issued.launchUrl, target.path));
    } catch {
      throw new Error('The settings page could not be opened. Please try again.');
    }
  },
};
