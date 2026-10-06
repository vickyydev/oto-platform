import { describe, expect, it } from 'vitest';
import {
  boothFunnelRatios,
  reportDominantTender,
  reportPaymentBumps,
  summariseReportDayV1,
  type ReportSaleFacts,
} from '../src/analytics-reports';

/**
 * S2-15b round 4 — the Reports panels' per-day arithmetic, the prototype's
 * `lib/reporting.ts` rules (plan §3), on facts shaped by hand.
 */

const category = (over: Partial<ReportSaleFacts['categories'][number]> = {}) => ({
  category: 'tickets',
  base: 9_346,
  gross: 10_000,
  tax: 654,
  secondaryTax: 0,
  taxMode: 'inclusive',
  secondaryTaxMode: 'none',
  serviceCharge: 0,
  ...over,
});

const ticketSale = (over: Partial<ReportSaleFacts> = {}): ReportSaleFacts => ({
  saleId: 's-1',
  kind: 'ticket',
  tier: 'tourist',
  grossSatang: 10_000,
  categories: [category()],
  tenders: [{ code: 'cash', method: 'cash', takenSatang: 10_000 }],
  refundSlices: [],
  cartLines: [],
  items: [],
  discounts: [],
  ...over,
});

describe('the payment mix (paymentMix)', () => {
  it('nets a ticket sale’s refunds per tender, floors at zero, and drops what is left at zero', () => {
    const bumps = reportPaymentBumps(
      ticketSale({
        tenders: [
          { code: 'card', method: 'card', takenSatang: 5_000 },
          { code: 'cash', method: 'cash', takenSatang: 3_000 },
          { code: 'cash', method: 'cash', takenSatang: 2_000 },
        ],
        refundSlices: [
          { code: 'cash', amountSatang: 1_500 },
          { code: 'card', amountSatang: 6_000 },
        ],
      }),
    );
    expect([...bumps]).toEqual([['cash', { method: 'cash', amountSatang: 3_500 }]]);
  });

  it('leaves an F&B or shop order’s tenders as taken, credit included', () => {
    const bumps = reportPaymentBumps({
      kind: 'fnb',
      tenders: [
        { code: 'wallet_credit', method: 'wallet', takenSatang: 4_000 },
        { code: 'cash', method: 'cash', takenSatang: 1_000 },
      ],
      refundSlices: [{ code: 'wallet_credit', amountSatang: 4_000 }],
    });
    expect([...bumps]).toEqual([
      ['wallet_credit', { method: 'wallet', amountSatang: 4_000 }],
      ['cash', { method: 'cash', amountSatang: 1_000 }],
    ]);
  });

  it('names a receipt’s tender, `split` for several and `unknown` for none (dominantTender)', () => {
    expect(reportDominantTender(['cash'])).toBe('cash');
    expect(reportDominantTender(['cash', 'cash'])).toBe('cash');
    expect(reportDominantTender(['card', 'cash'])).toBe('split');
    expect(reportDominantTender([])).toBe('unknown');
  });
});

describe('one day’s report rows', () => {
  const day = summariseReportDayV1([
    ticketSale({
      saleId: 'a',
      grossSatang: 32_500,
      categories: [category({ gross: 10_000 }), category({ category: 'drop_off', base: 21_028, gross: 22_500, tax: 1_472 })],
      cartLines: [
        { cartLineId: 'l1', packageId: 'p-2h', packageName: '2 Hours Play', kids: 1, adults: 1, hours: 2, ticketBaseSatang: 10_000, feeBaseSatang: 0, stay: false, service: null, promo: false },
        { cartLineId: 'stay', packageId: 'p-2h', packageName: '2 Hours Play', kids: 1, adults: 0, hours: 2, ticketBaseSatang: 0, feeBaseSatang: 22_500, stay: true, service: 'drop_off', promo: false },
        { cartLineId: 'stub', packageId: 'p-2h', packageName: '2 Hours Play', kids: 0, adults: 0, hours: null, ticketBaseSatang: 0, feeBaseSatang: 0, stay: false, service: null, promo: true },
      ],
      discounts: [
        { kind: 'manual', type: 'comp', code: null, label: null, reason: 'Staff', amountSatang: 0, appliedByAccountId: 'acc', appliedByName: 'Nok' },
        { kind: 'promo', type: 'fixed', code: '…47WP', label: '150 THB Voucher', reason: null, amountSatang: 0, appliedByAccountId: null, appliedByName: null },
      ],
    }),
    ticketSale({
      saleId: 'b',
      tier: 'expat',
      categories: [category({ taxMode: 'exclusive', tax: 700, gross: 10_700, base: 10_000 })],
      grossSatang: 10_700,
      cartLines: [
        { cartLineId: 'l2', packageId: 'p-2h', packageName: '2 Hours Play', kids: 2, adults: 1, hours: 2, ticketBaseSatang: 10_000, feeBaseSatang: 0, stay: false, service: null, promo: false },
      ],
    }),
    {
      ...ticketSale({ saleId: 'c', kind: 'fnb', tier: 'tourist' }),
      categories: [category({ category: 'fnb', base: 6_542, gross: 7_000, tax: 458 })],
      items: [
        { kind: 'fnb', productId: 'juice', label: 'Fresh Orange Juice', quantity: 2, revenueSatang: 14_000, costSatang: 0, costUntrackedQuantity: 2 },
      ],
    },
  ]);

  it('sums the category rows, VAT split by how it was charged, once per sale per category', () => {
    expect(day.categories).toEqual([
      { key: 'drop_off', grossSatang: 22_500, netSatang: 21_028, taxSatang: 1_472, taxInclusiveSatang: 1_472, taxExclusiveSatang: 0, serviceSatang: 0, txnCount: 1 },
      { key: 'fnb', grossSatang: 7_000, netSatang: 6_542, taxSatang: 458, taxInclusiveSatang: 458, taxExclusiveSatang: 0, serviceSatang: 0, txnCount: 1 },
      { key: 'tickets', grossSatang: 20_700, netSatang: 19_346, taxSatang: 1_354, taxInclusiveSatang: 654, taxExclusiveSatang: 700, serviceSatang: 0, txnCount: 2 },
    ]);
  });

  it('splits ticket sales by tier with the drop-off category apart, and counts ticket lines under their package without the stay or the stub', () => {
    const rows = (kind: string) => day.tickets.filter((t) => t.kind === kind);
    expect(rows('tier').map((t) => [t.key, t.saleCount, t.revenueSatang, t.dropoffSatang])).toEqual([
      ['expat', 1, 10_700, 0],
      ['tourist', 1, 10_000, 22_500],
    ]);
    expect(rows('ticket_type').map((t) => [t.key, t.label, t.lineCount, t.kids, t.adults, t.revenueSatang])).toEqual([
      ['p-2h', '2 Hours Play', 2, 3, 2, 20_000],
    ]);
    expect(rows('service').map((t) => [t.key, t.lineCount, t.hours, t.revenueSatang])).toEqual([['drop_off', 1, 2, 22_500]]);
  });

  it('keeps every manual discount and only the promos that took something', () => {
    expect(day.discounts.map((d) => [d.kind, d.discountType, d.amountSatang, d.useCount])).toEqual([['manual', 'comp', 0, 1]]);
  });

  it('carries the items with what their cost is known for', () => {
    expect(day.items).toEqual([
      { key: 'juice', kind: 'fnb', label: 'Fresh Orange Juice', quantity: 2, revenueSatang: 14_000, costSatang: 0, costUntrackedQuantity: 2 },
    ]);
  });
});

describe('the booth funnel’s ratios (plan question 14)', () => {
  it('is redeemed over issued, and the mean lag over the redeemed', () => {
    expect(boothFunnelRatios({ vouchersIssued: 8, vouchersRedeemed: 2, lagSumS: 7_201 })).toEqual({
      redemptionRate: 0.25,
      meanRedemptionLagS: 3_601,
    });
    expect(boothFunnelRatios({ vouchersIssued: 0, vouchersRedeemed: 0, lagSumS: 0 })).toEqual({
      redemptionRate: null,
      meanRedemptionLagS: null,
    });
  });
});
