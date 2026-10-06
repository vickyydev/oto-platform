// Admin > Reports — S2-15b round 4 (plan docs/progress/plans/analytics/PLAN.md).
//
// The four manager panels the prototype drew from this browser's own copy of
// the mock sales (`lib/reporting.ts`) read the platform's daily report rows
// instead: `GET /analytics/reports/*`. The answers keep `lib/reporting.ts`'s
// field names and are satang throughout, so the panels draw them as they drew
// the mock.
import type {
  DiscountReport,
  DiscountTransactions,
  ProfitabilityReport,
  ReportVatPeriod,
  SalesReport,
  TaxReceipts,
  VatReport,
} from '@oto/shared';
import { api } from './client';

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

export const analyticsReportsApi = {
  sales: (query: ReportQuery) => api.get<SalesReport>(`/analytics/reports/sales?${params(query)}`),
  profitability: (query: ReportQuery) =>
    api.get<ProfitabilityReport>(`/analytics/reports/profitability?${params(query)}`),
  discounts: (query: ReportQuery) => api.get<DiscountReport>(`/analytics/reports/discounts?${params(query)}`),
  discountTransactions: (query: ReportQuery) =>
    api.get<DiscountTransactions>(`/analytics/reports/discounts/transactions?${params(query)}`),
  vat: (query: ReportQuery, period: ReportVatPeriod) =>
    api.get<VatReport>(`/analytics/reports/tax/vat?${params(query, { period })}`),
  taxReceipts: (query: ReportQuery) => api.get<TaxReceipts>(`/analytics/reports/tax/receipts?${params(query)}`),
};
