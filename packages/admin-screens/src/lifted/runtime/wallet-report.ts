import type { DiscountTransactions, PromoVoucherReport } from '@oto/shared';
import type { ReportQuery } from '../api/analyticsReports';
import type { ReportFilters, WalletCreditReport } from '../lib/reporting';
import type { Discount } from '../model/types';
import type { ReportCommonPorts } from './reports';

/** The three canonical reads and the operator's lifetime promo-code metadata. */
export interface WalletReportPorts extends ReportCommonPorts {
  discounts: readonly Discount[];
  metadataUnavailable?: string;
  walletReport: (filters: ReportFilters, limit?: number) => Promise<WalletCreditReport>;
  discountTransactions: (query: ReportQuery) => Promise<Pick<DiscountTransactions, 'promoRows'>>;
  voucherReport: (query: ReportQuery) => Promise<PromoVoucherReport>;
}
