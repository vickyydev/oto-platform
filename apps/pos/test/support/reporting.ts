/** Run the canonical lifted calculations against the POS parity fixtures. */
import * as legacy from '@/mockApi';
import * as catalog from '@/store/catalogStore';
import * as cartWire from '@/lib/cartWire';
import * as pricingMode from '@/lib/pricingMode';
import { adminScreenApi } from '@/api/admin-screen-api';
import { createStockAdminApi } from '../../../../packages/admin-screens/src/lifted/api/stock';
import { createWalletAdminApi } from '../../../../packages/admin-screens/src/lifted/api/wallet';
import { createReportingHelpers } from '../../../../packages/admin-screens/src/lifted/lib/reporting';
export type * from '../../../../packages/admin-screens/src/lifted/lib/reporting';
const stock = createStockAdminApi(adminScreenApi, { writeThenRead: async (_branchId, write) => write() });
const wallet = createWalletAdminApi(adminScreenApi);
export const {
  defaultReportFilters, getBranchOptions, getFilteredSales, getFilteredFnbOrders, getFilteredMerchOrders,
  isDropOffSale, saleTaxBreakdown, fnbOrderTaxBreakdown, merchOrderTaxBreakdown, netAfterRefunds,
  salesByCategory, paymentMix, ticketSalesByTier, fnbSalesByItem, merchSalesByItem, ticketTypeSalesRows,
  ticketWeekdayWeekendSplit, eventCampRevenueRows, dropOffNannyRevenueRows, fnbProfitability,
  merchProfitability, platformCostOfGoods, withLedgerCost, walletCreditSummary, walletLedgerRows,
  platformWalletCreditReport, promoUsageSummary, promoUsageSummaryOf, discountAndCompImpact,
  promoDiscountImpact, discountImpactByOperator, promoDiscountImpactByType, taxReceiptRows,
  taxReceiptPaymentMethods, vatSummary, platformReportQuery,
} = createReportingHelpers({ legacy, catalog: new Proxy(catalog, {
  get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(Reflect.get(target, key), target, args) : value;
  },
}), cartWire, pricingMode, wallet, stock });
