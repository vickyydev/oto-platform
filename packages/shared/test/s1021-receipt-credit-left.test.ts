import { describe, expect, it } from 'vitest';
import {
  RECEIPT_CREDIT_LEFT_LABEL,
  RECEIPT_CREDIT_LEFT_LABEL_TH,
  receiptCreditLeftRow,
  saleReceiptDocument,
  type SalePrintSnapshot,
} from '../src/index';

/**
 * SCRUM-1021 — the credit left on each band a food or shop sale was paid
 * from, on its receipt (the owner's answer of 19 November 2026), in English
 * on the row and Thai under it, with the band's short code.
 */

const snapshot = (over: Partial<SalePrintSnapshot> = {}): SalePrintSnapshot => ({
  saleId: '018f0000-0000-7000-8000-0000005a1e02',
  receiptNumber: 'T1-000044',
  at: '2026-11-19T07:05:00.000Z',
  timezone: 'Asia/Bangkok',
  operatorName: 'OTO',
  branchName: 'HKT Central',
  staffName: 'Nok',
  memberNickname: null,
  lines: [
    { id: 'l-fries', kind: 'fnb_item', label: 'French Fries', quantity: 1, grossSatang: 9_000, ticket: false, payload: null, stayHours: null, stayDurationLabel: null },
  ],
  subtotalSatang: 9_000,
  grossSatang: 9_000,
  taxBreakdown: {
    netSubtotal: 8_411,
    discountTotal: 0,
    serviceChargeTotal: 0,
    exclusiveTaxTotal: 0,
    inclusiveTaxTotal: 589,
    taxTotal: 589,
    categories: [],
  } as unknown as SalePrintSnapshot['taxBreakdown'],
  tenders: [],
  bands: [],
  orderChildren: [],
  note: null,
  ...over,
});

describe('SCRUM-1021 — the credit left on the receipt', () => {
  it('one row per band, the balance after the sale, Thai and the short code under it', () => {
    expect(receiptCreditLeftRow({ balanceAfterSatang: 121_050, bandShortCode: 'T1-7KMQ4X', holderName: 'ZZ TEST Mint' })).toEqual({
      label: RECEIPT_CREDIT_LEFT_LABEL,
      amount: '฿1,210.50',
      detail: `${RECEIPT_CREDIT_LEFT_LABEL_TH} · Band T1-7KMQ4X`,
    });
    // A wallet on no band is named by its holder; never below zero.
    expect(receiptCreditLeftRow({ balanceAfterSatang: -5, bandShortCode: null, holderName: 'Voucher credit' })).toEqual({
      label: 'Credit left',
      amount: '฿0',
      detail: 'เครดิตคงเหลือ · Voucher credit',
    });
  });

  it('the receipt carries it when the sale was paid from a band, and not otherwise', () => {
    const paid = saleReceiptDocument(
      snapshot({ walletsLeft: [{ balanceAfterSatang: 26_000, bandShortCode: 'T1-7KMQ4X', holderName: null }] }),
    );
    expect(paid.creditLeft).toEqual([{ label: 'Credit left', amount: '฿260', detail: 'เครดิตคงเหลือ · Band T1-7KMQ4X' }]);
    expect(saleReceiptDocument(snapshot()).creditLeft).toBeUndefined();
    expect(saleReceiptDocument(snapshot({ walletsLeft: [] })).creditLeft).toBeUndefined();
  });
});
