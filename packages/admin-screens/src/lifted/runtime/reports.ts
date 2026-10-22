import type { BranchOption, ReportFilters } from '../lib/reporting';
import type { ReportQuery, createAnalyticsReportsApi } from '../api/analyticsReports';

export interface ReportCommonPorts {
  contextKey: unknown;
  defaultFilters: () => ReportFilters;
  branchOptions: readonly BranchOption[];
  queryForFilters: (filters: ReportFilters) => ReportQuery | null;
}

export type ReportFilterPorts = Pick<ReportCommonPorts, 'branchOptions'>;
export type ReportRequestPorts = Pick<ReportCommonPorts, 'contextKey' | 'queryForFilters'>;
type AnalyticsReportsApi = ReturnType<typeof createAnalyticsReportsApi>;

export interface SalesReportPorts extends ReportCommonPorts {
  api: Pick<AnalyticsReportsApi, 'sales'>;
}
export interface ProfitabilityReportPorts extends ReportCommonPorts {
  api: Pick<AnalyticsReportsApi, 'profitability'>;
}
export interface DiscountCompReportPorts extends ReportCommonPorts {
  api: Pick<AnalyticsReportsApi, 'discounts' | 'discountTransactions'>;
}
export interface TaxVatReportPorts extends ReportCommonPorts {
  api: Pick<AnalyticsReportsApi, 'vat' | 'taxReceipts'>;
}
