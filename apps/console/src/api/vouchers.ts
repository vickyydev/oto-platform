import { api, apiUrl, qs } from './client';

export const VOUCHER_LEDGER_STATUSES = [
  'issued',
  'printed',
  'held',
  'redeemed',
  'expired',
  'void',
] as const;
export type VoucherLedgerStatus = (typeof VOUCHER_LEDGER_STATUSES)[number];

export interface VoucherValue {
  kind: 'money' | 'percent' | 'item' | 'ticket' | 'gift';
  text: string;
  redeemedSatang: number | null;
}

export interface LedgerPerson {
  accountId: string;
  name: string | null;
  code: string;
}

export interface VoucherLedgerRow {
  id: string;
  issuedAt: string;
  businessDate: string;
  type: { id: string; code: string; nameEn: string; nameTh: string | null; kind: string };
  prize: { id: string; nameEn: string } | null;
  value: VoucherValue;
  place: { kind: 'booth' | 'counter' | 'import'; stationId: string | null; name: string };
  issuedBy: LedgerPerson | null;
  codeLast4: string;
  source: string;
  status: VoucherLedgerStatus;
  printCount: number;
  expiresAt: string | null;
  redeemed: {
    at: string;
    branchName: string | null;
    stationName: string | null;
    by: LedgerPerson | null;
    saleId: string | null;
    receiptNumber: string | null;
  } | null;
}

export interface VoucherTypeTotals {
  type: { id: string; code: string; nameEn: string; kind: string };
  valueKind: VoucherValue['kind'];
  issued: number;
  redeemed: number;
  redemptionRate: number | null;
  expired: number;
  handedOverSatang: number;
}

export interface VoucherLedgerFilters {
  from?: string;
  to?: string;
  definitionId?: string;
  stationId?: string;
  issuedBy?: string;
  status?: VoucherLedgerStatus;
}

export interface VoucherLedger {
  range: { from: string; to: string };
  total: number;
  rows: VoucherLedgerRow[];
  totals: VoucherTypeTotals[];
}

export interface BoothSpinRow {
  id: string;
  occurredAt: string;
  staff: LedgerPerson | null;
  outcome: 'prize' | 'no_prize';
  prize: { id: string; nameEn: string } | null;
  codeLast4: string | null;
  print: 'printed' | 'failed' | 'not_reported' | null;
  redeemed: boolean;
  redeemedAt: string | null;
  clockSuspect: boolean;
}

export interface BoothSpins {
  businessDate: string;
  total: number;
  summary: { spins: number; unattributed: number; printed: number; redeemed: number };
  spins: BoothSpinRow[];
}

export const voucherLedgerApi = {
  list: (branchId: string, filters: VoucherLedgerFilters, offset = 0) =>
    api.get<VoucherLedger>('/vouchers' + qs({ branchId, ...filters, limit: 50, offset })),
  exportUrl: (branchId: string, filters: VoucherLedgerFilters) =>
    apiUrl('/vouchers/export' + qs({ branchId, ...filters })),
  spins: (id: string, date: string, offset = 0) =>
    api.get<BoothSpins>(
      '/booths/' + encodeURIComponent(id) + '/spins' + qs({ date, limit: 50, offset }),
    ),
};
