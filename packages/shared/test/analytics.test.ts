import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_FORMULA_VERSION,
  ANALYTICS_REVENUE_BUCKETS,
  SALES_BOOTH_CHANNEL,
  analyticsChannelOfVoucherSource,
  analyticsSaleRevenueV1,
  summariseAnalyticsDayV1,
  summariseAnalyticsHoursV1,
  type AnalyticsSaleFacts,
} from '../src/analytics';

/**
 * S2-15b (SCRUM-216) — formula version 1, the prototype's Performance rule
 * (`mockApi.ts` getFloorReport), on facts built by hand.
 */

function sale(over: Partial<AnalyticsSaleFacts>): AnalyticsSaleFacts {
  return {
    saleId: 's',
    kind: 'ticket',
    dropOff: false,
    hour: 10,
    grossSatang: 0,
    refundedSatang: 0,
    nonCreditSatang: 0,
    creditUsedSatang: 0,
    creditRestoredSatang: 0,
    kids: 0,
    adults: 0,
    mixOneHour: 0,
    mixTwoHour: 0,
    mixFullDay: 0,
    discountSatang: 0,
    compSatang: 0,
    vatSatang: 0,
    serviceSatang: 0,
    channels: [],
    ...over,
  };
}

describe('formula version 1', () => {
  it('is version 1, with the five bars in the order the page draws them', () => {
    expect(ANALYTICS_FORMULA_VERSION).toBe(1);
    expect(ANALYTICS_REVENUE_BUCKETS).toEqual(['tickets', 'fnb', 'merch', 'parties', 'dropoff']);
    expect(analyticsChannelOfVoucherSource('booth')).toBe(SALES_BOOTH_CHANNEL);
    expect(analyticsChannelOfVoucherSource('campaign')).toBe('campaign');
  });

  it('a ticket sale counts its total less its refunds, whole, in Tickets or in Drop-off', () => {
    expect(analyticsSaleRevenueV1(sale({ grossSatang: 124_000, refundedSatang: 24_000 }))).toEqual({
      bucket: 'tickets',
      amountSatang: 100_000,
      creditPaidSatang: 0,
    });
    // A sale with a ticket line and the drop-off service is all Drop-off.
    expect(analyticsSaleRevenueV1(sale({ grossSatang: 119_000, dropOff: true }))).toMatchObject({
      bucket: 'dropoff',
      amountSatang: 119_000,
    });
    // Refunded past its total: never below zero.
    expect(analyticsSaleRevenueV1(sale({ grossSatang: 50_000, refundedSatang: 60_000 })).amountSatang).toBe(0);
  });

  it('an F&B or merch order counts money other than credit, less the cash part of its refunds', () => {
    // ฿450: ฿200 credit and ฿250 cash; refunded ฿150, ฿50 of it back to the wallet.
    const order = sale({
      kind: 'fnb',
      grossSatang: 45_000,
      nonCreditSatang: 25_000,
      creditUsedSatang: 20_000,
      refundedSatang: 15_000,
      creditRestoredSatang: 5_000,
    });
    expect(analyticsSaleRevenueV1(order)).toEqual({ bucket: 'fnb', amountSatang: 15_000, creditPaidSatang: 15_000 });
    // Paid wholly in credit: nothing in the bar, all of it "paid via credit".
    expect(analyticsSaleRevenueV1(sale({ kind: 'merch', grossSatang: 12_000, creditUsedSatang: 12_000 }))).toEqual({
      bucket: 'merch',
      amountSatang: 0,
      creditPaidSatang: 12_000,
    });
  });

  it('sums a day: every counted sale is a transaction, guests and the mix come from ticket sales', () => {
    const day = summariseAnalyticsDayV1([
      sale({ saleId: 'a', grossSatang: 124_000, kids: 1, adults: 1, mixTwoHour: 2, vatSatang: 8_112 }),
      sale({ saleId: 'b', grossSatang: 0, kids: 1, mixOneHour: 1, compSatang: 69_000 }),
      sale({ saleId: 'c', grossSatang: 179_000, kids: 1, adults: 2, mixFullDay: 3, channels: [SALES_BOOTH_CHANNEL] }),
      sale({ saleId: 'd', kind: 'fnb', grossSatang: 30_000, nonCreditSatang: 30_000, kids: 4 }),
      sale({ saleId: 'e', grossSatang: 119_000, dropOff: true, kids: 1, mixTwoHour: 1 }),
    ]);
    expect(day).toEqual({
      ticketsSatang: 303_000,
      fnbSatang: 30_000,
      merchSatang: 0,
      partiesSatang: 0,
      dropoffSatang: 119_000,
      revenueSatang: 452_000,
      txnCount: 5,
      creditPaidSatang: 0,
      guestsKids: 4,
      guestsAdults: 3,
      mix1h: 1,
      mix2h: 3,
      mixFullDay: 3,
      partiesCount: 0,
      refundsSatang: 0,
      discountsSatang: 0,
      compsSatang: 69_000,
      vatSatang: 8_112,
      serviceSatang: 0,
      byChannel: { [SALES_BOOTH_CHANNEL]: { revenue: 179_000, txn_count: 1 } },
    });
  });

  it('an empty day is all zeros', () => {
    const day = summariseAnalyticsDayV1([]);
    expect(day.revenueSatang).toBe(0);
    expect(day.txnCount).toBe(0);
    expect(day.byChannel).toEqual({});
  });

  it('splits a day by hour, and the hours add up to the day', () => {
    const sales = [
      sale({ saleId: 'a', hour: 10, grossSatang: 124_000, kids: 1, adults: 1 }),
      sale({ saleId: 'b', hour: 10, grossSatang: 222_000, kids: 3 }),
      sale({ saleId: 'c', hour: 14, kind: 'merch', grossSatang: 12_000, nonCreditSatang: 12_000 }),
      sale({ saleId: 'd', hour: 1, grossSatang: 50_000 }),
    ];
    const hours = summariseAnalyticsHoursV1(sales);
    expect(hours.map((h) => [h.hour, h.revenueSatang, h.txnCount, h.guests])).toEqual([
      [1, 50_000, 1, 0],
      [10, 346_000, 2, 5],
      [14, 12_000, 1, 0],
    ]);
    const day = summariseAnalyticsDayV1(sales);
    expect(hours.reduce((sum, h) => sum + h.revenueSatang, 0)).toBe(day.revenueSatang);
    expect(hours.reduce((sum, h) => sum + h.txnCount, 0)).toBe(day.txnCount);
  });
});
