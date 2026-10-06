import { z } from 'zod';
import { isCalendarDate } from './end-of-day';
import type { Satang } from './money';
import type { Permission } from './permissions';

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

/** The systems a branch ran before the platform: their days are frozen rows, never rolled. */
export type AnalyticsLegacySource = Exclude<AnalyticsSource, 'oto_pos'>;
export const ANALYTICS_LEGACY_SOURCES = ['pisell', 'papaya'] as const satisfies readonly AnalyticsLegacySource[];

/**
 * The formula each legacy source's days were computed under (plan §9 question
 * 7's default: a legacy source keeps its own version). Radar's Pisell pipeline
 * is v30 (Central Floresta) and its Papaya pipeline v21 (Robinson Chalong),
 * intake notes 03 and 04.
 */
export const ANALYTICS_LEGACY_FORMULA_VERSIONS: Record<AnalyticsLegacySource, number> = { pisell: 30, papaya: 21 };

export function isLegacyAnalyticsSource(source: AnalyticsSource): source is AnalyticsLegacySource {
  return source !== ANALYTICS_PLATFORM_SOURCE;
}

// --- Which source a branch reports (round 6) --------------------------------------------

/**
 * Radar's preference for a branch (S2-18): its own legacy figures, the
 * platform's, or both side by side. Stored beside the source the summary
 * serves; neither decides the other.
 */
export const ANALYTICS_SOURCE_PREFERENCES = ['oto_pos', 'legacy', 'both'] as const;
export type AnalyticsSourcePreference = (typeof ANALYTICS_SOURCE_PREFERENCES)[number];

/** A branch with no switch row reports the platform's own figures. */
export const DEFAULT_BRANCH_SOURCE = { source: ANALYTICS_PLATFORM_SOURCE, preference: 'oto_pos' } as const satisfies {
  source: AnalyticsSource;
  preference: AnalyticsSourcePreference;
};

/** `PUT /analytics/sources/:branchId`. */
export const BranchSourceBodySchema = z.object({
  source: z.enum(ANALYTICS_SOURCES),
  preference: z.enum(ANALYTICS_SOURCE_PREFERENCES),
});
export type BranchSourceBody = z.infer<typeof BranchSourceBodySchema>;

/** One branch's switch as the routes answer it. */
export const BranchSourceSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string(),
  source: z.enum(ANALYTICS_SOURCES),
  preference: z.enum(ANALYTICS_SOURCE_PREFERENCES),
  /** When the branch was last switched; null while it has never been (it reports `oto_pos`). */
  switchedAt: z.string().nullable(),
  /** Who switched it last; null while it has never been switched. */
  actorAccountId: z.string().uuid().nullable(),
});
export type BranchSource = z.infer<typeof BranchSourceSchema>;

/** `GET /analytics/sources`. */
export const BranchSourcesSchema = z.object({
  branches: z.array(BranchSourceSchema),
  /** Requested branches of the operator the caller may not read: left out. */
  omitted: z.array(z.string().uuid()),
});
export type BranchSources = z.infer<typeof BranchSourcesSchema>;

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

// --- Adding days up (round 3) ---------------------------------------------------------

/** A day with no sale: every figure zero, no channel. */
export function emptyAnalyticsDayFigures(): AnalyticsDayFigures {
  return summariseAnalyticsDayV1([]);
}

/**
 * Several stored days — of one branch over a range, or of several branches on
 * one date — added up figure by figure. Every figure of formula version 1 is
 * a sum over sales, so the sum of two days is the day the two would have made
 * together; `by_channel` is added channel by channel.
 */
export function sumAnalyticsDayFigures(days: readonly AnalyticsDayFigures[]): AnalyticsDayFigures {
  const total = emptyAnalyticsDayFigures();
  for (const day of days) {
    total.ticketsSatang += day.ticketsSatang;
    total.fnbSatang += day.fnbSatang;
    total.merchSatang += day.merchSatang;
    total.partiesSatang += day.partiesSatang;
    total.dropoffSatang += day.dropoffSatang;
    total.revenueSatang += day.revenueSatang;
    total.txnCount += day.txnCount;
    total.creditPaidSatang += day.creditPaidSatang;
    total.guestsKids += day.guestsKids;
    total.guestsAdults += day.guestsAdults;
    total.mix1h += day.mix1h;
    total.mix2h += day.mix2h;
    total.mixFullDay += day.mixFullDay;
    total.partiesCount += day.partiesCount;
    total.refundsSatang += day.refundsSatang;
    total.discountsSatang += day.discountsSatang;
    total.compsSatang += day.compsSatang;
    total.vatSatang += day.vatSatang;
    total.serviceSatang += day.serviceSatang;
    for (const [channel, figures] of Object.entries(day.byChannel)) {
      const row = (total.byChannel[channel] ??= { revenue: 0, txn_count: 0 });
      row.revenue += figures.revenue;
      row.txn_count += figures.txn_count;
    }
  }
  return total;
}

// --- The wire: GET /analytics/summary (round 3) ---------------------------------------

/**
 * Who may read ONE branch's figures: the Today screen's own permission
 * (`pos:cash:read`, which every counter role holds — the prototype shows
 * Performance to anybody who opens Today, plan §9 question 9) or
 * `analytics:read` (Radar and the manager reports). Held at the branch, or
 * operator-wide; a branch the caller holds neither at is never read.
 */
export const ANALYTICS_SUMMARY_PERMISSIONS = ['pos:cash:read', 'analytics:read'] as const satisfies readonly Permission[];

/**
 * What adds a branch into an answer that covers MORE than one (All branches,
 * or several named): `analytics:read` there, and nothing else (plan §9
 * question 9's default — "All branches only across the branches a person holds
 * analytics:read on"). The Today screen's permission opens a branch on its own
 * and never into a total.
 */
export const ANALYTICS_MERGE_PERMISSION = 'analytics:read' as const satisfies Permission;

/** `day`: one row per business date; `total`: one row for the whole range. */
export const ANALYTICS_SUMMARY_GROUPS = ['day', 'total'] as const;
export type AnalyticsSummaryGroup = (typeof ANALYTICS_SUMMARY_GROUPS)[number];

/** The longest range one request reads: a year and a day. */
export const ANALYTICS_SUMMARY_MAX_DAYS = 366;
/** The most branches one request names. */
export const ANALYTICS_SUMMARY_MAX_BRANCHES = 50;

const SUMMARY_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD')
  .refine(isCalendarDate, 'That date is not on the calendar.');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_LIST = new RegExp(`^${UUID}(,${UUID}){0,${ANALYTICS_SUMMARY_MAX_BRANCHES - 1}}$`, 'i');

export const AnalyticsSummaryQuerySchema = z.object({
  /**
   * Comma-separated branch ids. Absent: every live branch the caller may read
   * (more than one: those it holds `analytics:read` at, `ANALYTICS_MERGE_PERMISSION`).
   */
  branches: z.string().regex(UUID_LIST, 'branches is a comma-separated list of branch ids').optional(),
  from: SUMMARY_DATE,
  to: SUMMARY_DATE,
  group: z.enum(ANALYTICS_SUMMARY_GROUPS).default('day'),
});
export type AnalyticsSummaryQuery = z.input<typeof AnalyticsSummaryQuerySchema>;

/** The branch ids a `branches` parameter names, each once, in the order given. */
export function analyticsSummaryBranchIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0))];
}

const SatangSchema = z.number().int();
const CountSchema = z.number().int().min(0);

/** The figure set of one row: a stored day, or days added up. */
export const AnalyticsDayFiguresSchema = z.object({
  ticketsSatang: SatangSchema,
  fnbSatang: SatangSchema,
  merchSatang: SatangSchema,
  partiesSatang: SatangSchema,
  dropoffSatang: SatangSchema,
  revenueSatang: SatangSchema,
  txnCount: CountSchema,
  creditPaidSatang: SatangSchema,
  guestsKids: CountSchema,
  guestsAdults: CountSchema,
  mix1h: CountSchema,
  mix2h: CountSchema,
  mixFullDay: CountSchema,
  partiesCount: CountSchema,
  refundsSatang: SatangSchema,
  discountsSatang: SatangSchema,
  compsSatang: SatangSchema,
  vatSatang: SatangSchema,
  serviceSatang: SatangSchema,
  byChannel: z.record(z.string(), z.object({ revenue: SatangSchema, txn_count: CountSchema })),
});

export const AnalyticsSummaryRowSchema = AnalyticsDayFiguresSchema.extend({
  /** The business date; null on a `total` row. */
  businessDate: SUMMARY_DATE.nullable(),
  /**
   * Still moving: a day that has not ended at its branch (today); a stored day
   * the rollup wrote while it was open and has not rewritten since it ended;
   * or an ended day with no stored row that the rollup's queue still holds (it
   * traded, and has not been written yet). An ended day with no row and
   * nothing queued had no sale, and is final. A row of several days is
   * provisional when any of them is.
   */
  provisional: z.boolean(),
  /**
   * How many branch-days in the row had a stored summary. The rest had no sale
   * or, when the row is provisional, may not have been written yet.
   */
  rolledDays: CountSchema,
  /** When the newest stored day in the row was last rewritten; null when none was stored. */
  computedAt: z.string().nullable(),
  /** The formula every stored day in the row was written under; null when none was stored or they differ. */
  formulaVersion: z.number().int().positive().nullable(),
});
export type AnalyticsSummaryRow = z.infer<typeof AnalyticsSummaryRowSchema>;

/** The same money buckets for one wall-clock hour, added up over the answer's branches. */
export const AnalyticsSummaryHourSchema = z.object({
  hour: z.number().int().min(0).max(23),
  ticketsSatang: SatangSchema,
  fnbSatang: SatangSchema,
  merchSatang: SatangSchema,
  partiesSatang: SatangSchema,
  dropoffSatang: SatangSchema,
  revenueSatang: SatangSchema,
  txnCount: CountSchema,
  guests: CountSchema,
});
export type AnalyticsSummaryHour = z.infer<typeof AnalyticsSummaryHourSchema>;

export const AnalyticsSummaryBranchSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string(),
  /**
   * Which system's days this branch's rows are (round 6, its
   * `analytics.branch_source_switch`; no switch is `oto_pos`). A branch on a
   * legacy source (`pisell`, `papaya`) is answered from that source's frozen
   * days, which no rollup writes: a day with no frozen row reads as zero and
   * final, and the branch has no hours.
   */
  source: z.enum(ANALYTICS_SOURCES),
  timezone: z.string(),
  /** `HH:MM` — the business day starts here, so a day is never a UTC slice. */
  businessDayStart: z.string(),
  /** The business date in progress at the branch now. */
  today: SUMMARY_DATE,
  /**
   * When the rollup last brought this branch's figures up to date: the start
   * of the newest successful daily rollup (each one rolls today at every live
   * branch), or when it last wrote today's row here, whichever is later (an
   * archived branch: its newest row). A rewrite of an older day does not
   * count, so a run that fails before today's write never makes the branch
   * look fresher. Null when it has never rolled this branch. A branch on a
   * legacy source: when the newest of that source's frozen days was written.
   */
  lastRolledUpAt: z.string().nullable(),
  /** This branch's own rows, by the request's `group`. */
  rows: z.array(AnalyticsSummaryRowSchema),
});
export type AnalyticsSummaryBranch = z.infer<typeof AnalyticsSummaryBranchSchema>;

export const AnalyticsSummarySchema = z.object({
  from: SUMMARY_DATE,
  to: SUMMARY_DATE,
  group: z.enum(ANALYTICS_SUMMARY_GROUPS),
  /** The one source every branch below reports; null when they report different ones (each branch says its own). */
  source: z.enum(ANALYTICS_SOURCES).nullable(),
  /**
   * The branches added up below: those requested, or every one the caller may
   * read. When more than one, only those the caller holds `analytics:read` at
   * (`ANALYTICS_MERGE_PERMISSION`); the Today screen's permission reads one
   * branch on its own.
   */
  branches: z.array(AnalyticsSummaryBranchSchema),
  /**
   * Requested branches of the caller's operator that are left out, never added
   * in: the caller may not read them, or may read them only one at a time.
   */
  omitted: z.array(z.string().uuid()),
  /** Every live branch the caller may read on its own, whatever was requested. */
  readable: z.array(z.object({ branchId: z.string().uuid(), name: z.string() })),
  /**
   * Every live branch the caller may add up (`analytics:read` there): what
   * "All branches" covers, offered on the Today screen when there is more
   * than one (plan §9 question 9's default).
   */
  mergeable: z.array(z.object({ branchId: z.string().uuid(), name: z.string() })),
  /** `branches` added up: one row per date for `day`, one row for `total`. */
  merged: z.array(AnalyticsSummaryRowSchema),
  /**
   * For a one-day range: the merged day by wall-clock hour, the hours that had
   * a sale, of the branches that report `oto_pos` (a legacy source keeps no
   * hours). Null otherwise.
   */
  hours: z.array(AnalyticsSummaryHourSchema).nullable(),
  /** The oldest of the branches' `lastRolledUpAt`: the whole answer is at least this fresh. Null if any branch was never rolled. */
  lastRolledUpAt: z.string().nullable(),
});
export type AnalyticsSummary = z.infer<typeof AnalyticsSummarySchema>;
