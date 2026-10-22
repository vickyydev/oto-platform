import type { ApiResponse } from '@oto/api-types';
// Admin > Reports — S2-15b round 4 (plan docs/progress/plans/analytics/PLAN.md).
//
// The four manager panels the prototype drew from this browser's own copy of
// the mock sales (`lib/reporting.ts`) read the platform's daily report rows
// instead: `GET /analytics/reports/*`. The answers keep `lib/reporting.ts`'s
// field names and are satang throughout, so the panels draw them as they drew
// the mock.
import type {ReportVatPeriod} from '@oto/shared';
import type { LiftedAdminApi } from '../../api/lifted-api';

/** Platform branch ids (absent: every branch this account may read reports for) and the business dates. */
export interface ReportQuery {
  branches?: readonly string[];
  from: string;
  to: string;
}

function params(query: ReportQuery, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (query.branches && query.branches.length > 0) p.set('branches', query.branches.join(','));
  p.set('from', query.from);
  p.set('to', query.to);
  for (const [key, value] of Object.entries(extra)) p.set(key, value);
  return p.toString();
}

export function createAnalyticsReportsApi(api: LiftedAdminApi) {
  return {
  sales: (query: ReportQuery) => api.get<ApiResponse<'/analytics/reports/sales', 'get'>>(`/analytics/reports/sales?${params(query)}`),
  profitability: (query: ReportQuery) =>
    api.get<ApiResponse<'/analytics/reports/profitability', 'get'>>(`/analytics/reports/profitability?${params(query)}`),
  discounts: (query: ReportQuery) => api.get<ApiResponse<'/analytics/reports/discounts', 'get'>>(`/analytics/reports/discounts?${params(query)}`),
  discountTransactions: (query: ReportQuery) =>
    api.get<ApiResponse<'/analytics/reports/discounts/transactions', 'get'>>(`/analytics/reports/discounts/transactions?${params(query)}`),
  vat: (query: ReportQuery, period: ReportVatPeriod) =>
    api.get<ApiResponse<'/analytics/reports/tax/vat', 'get'>>(`/analytics/reports/tax/vat?${params(query, { period })}`),
  taxReceipts: (query: ReportQuery) => api.get<ApiResponse<'/analytics/reports/tax/receipts', 'get'>>(`/analytics/reports/tax/receipts?${params(query)}`),
  };
}
