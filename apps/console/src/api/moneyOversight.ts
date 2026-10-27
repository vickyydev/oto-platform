import type { ApiResponse } from '@oto/api-types';
import { api, qs } from './client';

/**
 * SCRUM-647 — Money oversight. Eight reads, each audited on the server; the
 * page never writes. Types are the api's own generated contracts.
 */
export type MoneySales = ApiResponse<'/console/money/sales', 'get'>;
export type MoneyRefunds = ApiResponse<'/console/money/refunds', 'get'>;
export type MoneyDiscounts = ApiResponse<'/console/money/discounts', 'get'>;
export type MoneyCash = ApiResponse<'/console/money/cash', 'get'>;
export type MoneySettlement = ApiResponse<'/console/money/settlement', 'get'>;
export type MoneyWallets = ApiResponse<'/console/money/wallets', 'get'>;
export type MoneyCosts = ApiResponse<'/console/money/costs', 'get'>;
export type MoneyIntegrity = ApiResponse<'/console/money/integrity', 'get'>;
export type MoneyCashDay = MoneyCash['branches'][number]['days'][number];
export type MoneyIntegrityCheck = MoneyIntegrity['checks'][number];
export type MoneyTrace = MoneyIntegrityCheck['rows'][number]['trace'];

export interface MoneyFilters {
  /** Empty: every live park the reader may read. */
  branchIds: readonly string[];
  from: string;
  to: string;
}

/** The longest range one read covers (`MONEY_RANGE_MAX_DAYS` on the api). */
export const MONEY_RANGE_MAX_DAYS = 31;

const query = (f: MoneyFilters) => qs({ branches: f.branchIds.length ? f.branchIds.join(',') : undefined, from: f.from, to: f.to });

export const moneyOversightApi = {
  sales: (f: MoneyFilters) => api.get<ApiResponse<'/console/money/sales', 'get'>>(`/console/money/sales${query(f)}`),
  refunds: (f: MoneyFilters) => api.get<ApiResponse<'/console/money/refunds', 'get'>>(`/console/money/refunds${query(f)}`),
  discounts: (f: MoneyFilters) => api.get<ApiResponse<'/console/money/discounts', 'get'>>(`/console/money/discounts${query(f)}`),
  cash: (f: MoneyFilters) => api.get<ApiResponse<'/console/money/cash', 'get'>>(`/console/money/cash${query(f)}`),
  settlement: (f: MoneyFilters) => api.get<ApiResponse<'/console/money/settlement', 'get'>>(`/console/money/settlement${query(f)}`),
  wallets: (f: MoneyFilters) => api.get<ApiResponse<'/console/money/wallets', 'get'>>(`/console/money/wallets${query(f)}`),
  costs: (f: MoneyFilters) => api.get<ApiResponse<'/console/money/costs', 'get'>>(`/console/money/costs${query(f)}`),
  integrity: (f: MoneyFilters) => api.get<ApiResponse<'/console/money/integrity', 'get'>>(`/console/money/integrity${query(f)}`),
};
