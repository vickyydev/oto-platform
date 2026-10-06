import type { Satang } from './money';

/**
 * S2-15b (SCRUM-216) — THE DAY'S FIGURES, formula version 1.
 *
 * Formula version 1 is the prototype's Today > Performance rule, read from
 * `imports/oto-pos/artifacts/oto-till/src/mockApi.ts` `getFloorReport`
 * (2032-2145) and ported as it is; the plan is
 * `docs/progress/plans/analytics/PLAN.md` §3. The platform's rollup gathers
 * one `AnalyticsSaleFacts` per counted sale from the ledger and these pure
 * functions do the arithmetic, so the rule can be read, and tested, without a
 * database. The plan's §4 data-reliability rules (business date, branch rows
 * only, hours from the sale line, guests once per cart line, finalised and
 * refunded sales only) are applied where the facts are gathered, not here.
 *
 * Money is satang throughout.
 */

/** Recorded on every `analytics.daily_summary` row this code writes. */
export const ANALYTICS_FORMULA_VERSION = 1;

/**
 * Which system a summary row describes. `oto_pos` rows are written by the
 * platform's rollup; `pisell` and `papaya` rows are the frozen legacy days.
 */
export const ANALYTICS_SOURCES = ['oto_pos', 'pisell', 'papaya'] as const;
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];
export const ANALYTICS_PLATFORM_SOURCE: AnalyticsSource = 'oto_pos';

/** The five revenue bars, in the order `RevenueBars.tsx` draws them. */
export const ANALYTICS_REVENUE_BUCKETS = ['tickets', 'fnb', 'merch', 'parties', 'dropoff'] as const;
export type AnalyticsRevenueBucket = (typeof ANALYTICS_REVENUE_BUCKETS)[number];

/** The `by_channel` key for sales that redeemed a booth voucher. */
export const SALES_BOOTH_CHANNEL = 'Sales Booth';

/**
 * The marketing channel a consumed voucher's `promo.voucher.source` stands
 * for. Only the booth's channel has a name in the plan; every other source is
 * keyed by its own word.
 */
export function analyticsChannelOfVoucherSource(source: string): string {
  return source === 'booth' ? SALES_BOOTH_CHANNEL : source;
}

/**
 * What kind of record a sale is in the prototype's terms: a ticket sale
 * (`recordSale`), an F&B order (`recordFnbOrder`) or a merch order
 * (`recordMerchOrder`).
 */
export type AnalyticsSaleKind = 'ticket' | 'fnb' | 'merch';

/** One finalised or refunded sale of the day, as the rollup reads it. */
export interface AnalyticsSaleFacts {
  saleId: string;
  kind: AnalyticsSaleKind;
  /** A ticket sale with a drop-off service line: the whole sale is Drop-off. */
  dropOff: boolean;
  /** The wall-clock hour (0-23) the sale was rung up, at its branch. */
  hour: number;
  /** What the guest was charged: after discounts, gross of VAT and service. */
  grossSatang: Satang;
  /** Every refund of this sale, whenever it was made. */
  refundedSatang: Satang;
  /** Money taken on the sale other than stored-value credit (cash, card, QR, other tenders). */
  nonCreditSatang: Satang;
  /** Stored-value credit spent on the sale. */
  creditUsedSatang: Satang;
  /** Credit this sale's refunds put back on a wallet. */
  creditRestoredSatang: Satang;
  /** Participants, summed once per cart line. */
  kids: number;
  adults: number;
  /** Participants on ticket lines, by the hours the line's ticket was sold for. */
  mixOneHour: number;
  mixTwoHour: number;
  mixFullDay: number;
  /** Discounts other than comps, and comps (a manual discount of type `comp`). */
  discountSatang: Satang;
  compSatang: Satang;
  /** VAT (inside the price and added to it) and service charge, as charged. */
  vatSatang: Satang;
  serviceSatang: Satang;
  /** `by_channel` keys this sale counts under (from the vouchers it redeemed). */
  channels: string[];
}

export interface AnalyticsChannelFigures {
  /** Satang. */
  revenue: Satang;
  txn_count: number;
}

export interface AnalyticsDayFigures {
  ticketsSatang: Satang;
  fnbSatang: Satang;
  merchSatang: Satang;
  partiesSatang: Satang;
  dropoffSatang: Satang;
  /** The sum of the five buckets. */
  revenueSatang: Satang;
  txnCount: number;
  /** "excl. ฿X paid via credit". */
  creditPaidSatang: Satang;
  guestsKids: number;
  guestsAdults: number;
  mix1h: number;
  mix2h: number;
  mixFullDay: number;
  partiesCount: number;
  refundsSatang: Satang;
  discountsSatang: Satang;
  compsSatang: Satang;
  vatSatang: Satang;
  serviceSatang: Satang;
  byChannel: Record<string, AnalyticsChannelFigures>;
}

export interface AnalyticsHourFigures {
  hour: number;
  ticketsSatang: Satang;
  fnbSatang: Satang;
  merchSatang: Satang;
  partiesSatang: Satang;
  dropoffSatang: Satang;
  revenueSatang: Satang;
  txnCount: number;
  guests: number;
}

/** What one sale adds to the bars, and to "paid via credit". */
export interface AnalyticsSaleRevenue {
  bucket: Exclude<AnalyticsRevenueBucket, 'parties'>;
  amountSatang: Satang;
  creditPaidSatang: Satang;
}

/**
 * One sale's contribution, `getFloorReport`'s per-record arithmetic:
 *
 *   - a ticket sale: max(0, total − refunds), all of it to Drop-off when the
 *     sale carries the drop-off service and all of it to Tickets otherwise —
 *     never split by line;
 *   - an F&B or merch order: max(0, money taken other than credit − the cash
 *     part of its refunds), the cash part being refund − credit restored; the
 *     credit it spent, less credit restored, floored at zero, is "paid via
 *     credit" and is not revenue here (it was counted when the ticket or
 *     top-up was sold).
 */
export function analyticsSaleRevenueV1(sale: AnalyticsSaleFacts): AnalyticsSaleRevenue {
  if (sale.kind === 'ticket') {
    return {
      bucket: sale.dropOff ? 'dropoff' : 'tickets',
      amountSatang: Math.max(0, sale.grossSatang - sale.refundedSatang),
      creditPaidSatang: 0,
    };
  }
  const refundedCash = sale.refundedSatang - sale.creditRestoredSatang;
  return {
    bucket: sale.kind,
    amountSatang: Math.max(0, sale.nonCreditSatang - refundedCash),
    creditPaidSatang: Math.max(0, sale.creditUsedSatang - sale.creditRestoredSatang),
  };
}

const emptyBuckets = () => ({ tickets: 0, fnb: 0, merch: 0, parties: 0, dropoff: 0 });

/**
 * The day, formula version 1. Every counted sale is one transaction (a fully
 * refunded sale and a 100% comp included). Guests and the ticket mix come from
 * ticket sales only, as the prototype's come from `recordedSales` only.
 * Parties are zero: the platform takes no party payments yet (plan §6).
 */
export function summariseAnalyticsDayV1(sales: readonly AnalyticsSaleFacts[]): AnalyticsDayFigures {
  const buckets = emptyBuckets();
  const byChannel: Record<string, AnalyticsChannelFigures> = {};
  let creditPaid = 0;
  let kids = 0;
  let adults = 0;
  let mix1h = 0;
  let mix2h = 0;
  let mixFullDay = 0;
  let refunds = 0;
  let discounts = 0;
  let comps = 0;
  let vat = 0;
  let service = 0;
  for (const sale of sales) {
    const revenue = analyticsSaleRevenueV1(sale);
    buckets[revenue.bucket] += revenue.amountSatang;
    creditPaid += revenue.creditPaidSatang;
    if (sale.kind === 'ticket') {
      kids += sale.kids;
      adults += sale.adults;
      mix1h += sale.mixOneHour;
      mix2h += sale.mixTwoHour;
      mixFullDay += sale.mixFullDay;
    }
    refunds += sale.refundedSatang;
    discounts += sale.discountSatang;
    comps += sale.compSatang;
    vat += sale.vatSatang;
    service += sale.serviceSatang;
    for (const channel of new Set(sale.channels)) {
      const row = (byChannel[channel] ??= { revenue: 0, txn_count: 0 });
      row.revenue += revenue.amountSatang;
      row.txn_count += 1;
    }
  }
  return {
    ticketsSatang: buckets.tickets,
    fnbSatang: buckets.fnb,
    merchSatang: buckets.merch,
    partiesSatang: buckets.parties,
    dropoffSatang: buckets.dropoff,
    revenueSatang: buckets.tickets + buckets.fnb + buckets.merch + buckets.parties + buckets.dropoff,
    txnCount: sales.length,
    creditPaidSatang: creditPaid,
    guestsKids: kids,
    guestsAdults: adults,
    mix1h,
    mix2h,
    mixFullDay,
    partiesCount: 0,
    refundsSatang: refunds,
    discountsSatang: discounts,
    compsSatang: comps,
    vatSatang: vat,
    serviceSatang: service,
    byChannel,
  };
}

/**
 * The same money buckets per wall-clock hour, for the hours that had a sale.
 * Each hour is the day's rule applied to that hour's sales, so the hours of a
 * day add up to the day.
 */
export function summariseAnalyticsHoursV1(sales: readonly AnalyticsSaleFacts[]): AnalyticsHourFigures[] {
  const byHour = new Map<number, AnalyticsSaleFacts[]>();
  for (const sale of sales) {
    const list = byHour.get(sale.hour) ?? [];
    list.push(sale);
    byHour.set(sale.hour, list);
  }
  return [...byHour.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, list]) => {
      const day = summariseAnalyticsDayV1(list);
      return {
        hour,
        ticketsSatang: day.ticketsSatang,
        fnbSatang: day.fnbSatang,
        merchSatang: day.merchSatang,
        partiesSatang: day.partiesSatang,
        dropoffSatang: day.dropoffSatang,
        revenueSatang: day.revenueSatang,
        txnCount: day.txnCount,
        guests: day.guestsKids + day.guestsAdults,
      };
    });
}
