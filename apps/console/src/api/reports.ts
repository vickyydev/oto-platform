import { withHandoffTarget } from '@oto/shared/handoff-target';
import type { ApiResponse } from '@oto/api-types';
import { createAnalyticsReportsApi, type ReportQuery } from '@oto/admin-screens/lifted/api/analyticsReports';
import { createWalletAdminApi } from '@oto/admin-screens/lifted/api/wallet';
import { createVoucherPromotionsApi } from '@oto/admin-screens/lifted/api/voucherPromotions';
import { createMenuCatalogueApi } from '@oto/admin-screens/lifted/api/menu';
import { createWalletReportReader } from '@oto/admin-screens/lifted/lib/reporting';
import { api, apiUrl, idemKey } from './client';

const transport = { ...api, href: apiUrl };
const wallet = createWalletAdminApi(transport);
const vouchers = createVoucherPromotionsApi(transport);

/** Reuse the native report transports and row mappers without a POS store. */
export const reportsApi = {
  parks: async () => {
    // Only the metadata is used. Each returned `today` is the server's current
    // trading date, independent of this one-day bootstrap query's figures.
    const day = new Date().toISOString().slice(0, 10);
    const answer = await api.get<ApiResponse<'/analytics/summary', 'get'>>(
      `/analytics/summary?from=${day}&to=${day}&group=total`,
    );
    return answer.branches.map(park => ({ id: park.branchId, name: park.name,
      timezone: park.timezone, businessDayStart: park.businessDayStart, today: park.today }));
  },
  analytics: createAnalyticsReportsApi(transport),
  walletReader: (branches: readonly { id: string }[]) => createWalletReportReader({
    getBranches: () => branches.map(branch => ({ id: branch.id, apiId: branch.id })),
    getWalletReport: wallet.getWalletReport,
  }),
  voucherReport: (query: ReportQuery) => vouchers.report({
    branchApiId: query.branches?.[0] ?? null, from: query.from, to: query.to,
  }),
  discounts: async () => {
    const menu = createMenuCatalogueApi(transport);
    return menu.mapDiscounts((await menu.menuApi.discounts()).discounts);
  },
  openRadar: async (isCurrent: () => boolean = () => true) => {
    const issued = await api.post('/auth/handoff', { app: 'radar' }, { idempotencyKey: idemKey() });
    if (typeof issued !== 'object' || issued === null || !('launchUrl' in issued) ||
      typeof issued.launchUrl !== 'string' || !issued.launchUrl) {
      throw new Error('Radar has no configured destination.');
    }
    if (!isCurrent()) return;
    try {
      window.location.assign(withHandoffTarget(issued.launchUrl, '/'));
    } catch {
      // Browser navigation errors may contain the one-use destination.
      throw new Error('Radar could not be opened. Please try again.');
    }
  },
};
