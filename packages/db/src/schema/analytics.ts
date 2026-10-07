import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { analytics, idPk, timestamps } from './helpers';
import { account, branch, employee, operator } from './tenancy';
import { station } from './fleet';
import { boothPrize } from './booth';

/**
 * THE HEAD COUNT, A QUARTER-HOUR AT A TIME (S2-12 round 4) — the platform's
 * first fact table, in the `analytics` schema the helpers reserve for facts.
 *
 * One row per branch per quarter-hour: how many adults and children the live
 * occupancy projection (`apps/api/src/services/occupancy.ts`) counted inside
 * at that quarter-hour. The projection reads the gate's journal
 * (`pos.band_event` entry / exit) and is the only writer's source; nothing
 * here is typed in or estimated.
 *
 * `bucket_start` is the quarter-hour's first instant (UTC, :00/:15/:30/:45);
 * `business_date` is the trading day it falls in at the branch, so a report
 * for "Saturday" reads Saturday's buckets including the ones after midnight.
 *
 * Idempotent by construction: the job upserts on (branch, bucket), so running
 * it twice in one quarter-hour — two instances, a restart — rewrites the same
 * row with the count at that moment rather than adding a second one.
 */
export const factOccupancy15min = analytics.table(
  'fact_occupancy_15min',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    bucketStart: timestamp('bucket_start', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    adults: integer('adults').notNull(),
    kids: integer('kids').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fact_occupancy_15min_branch_bucket_unique').on(t.branchId, t.bucketStart),
    index('fact_occupancy_15min_operator_idx').on(t.operatorId),
    index('fact_occupancy_15min_branch_date_idx').on(t.branchId, t.businessDate),
    check('fact_occupancy_15min_counts_check', sql`${t.adults} >= 0 and ${t.kids} >= 0`),
  ],
);

// --- The summaries (S2-15b, SCRUM-216; migration 0064) ----------------------
//
// The plan is docs/progress/plans/analytics/PLAN.md §7. Every table here is
// written by the jobs process only (`apps/api/src/services/analytics-rollup.ts`)
// and read by Today > Performance, the Reports panels, the booth report and
// Radar. The vocabularies are repeated from `@oto/shared/analytics.ts`, as the
// sales ledger repeats its own: a schema file states the words its CHECKs hold.

/** `ANALYTICS_SOURCES` in `@oto/shared`. */
export const ANALYTICS_SUMMARY_SOURCES = ['oto_pos', 'pisell', 'papaya'] as const;
export type AnalyticsSummarySource = (typeof ANALYTICS_SUMMARY_SOURCES)[number];

/**
 * ONE BRANCH'S TRADING DAY, AS ONE SOURCE REPORTS IT — the figure set Today >
 * Performance shows, under the formula that produced it.
 *
 *   formula_version  which rule computed the row. 1 is the prototype's
 *                    Performance rule (`getFloorReport`); a legacy source keeps
 *                    its own.
 *   provisional      the day had not ended at its branch when the row was
 *                    written. The next rollup after the day ends rewrites it
 *                    without the flag.
 *   frozen           a legacy fixture day. The rollup never writes a frozen row.
 *   input_fingerprint the hash of the figures as written, so an unchanged
 *                    recompute writes nothing.
 *
 * The five buckets add up to `revenue_satang` on an `oto_pos` row (the CHECK);
 * `by_channel` is channel → `{revenue, txn_count}`, revenue in satang, and a
 * sale is counted under every channel it redeemed a voucher of.
 */
export const dailySummary = analytics.table(
  'daily_summary',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    source: text('source').$type<AnalyticsSummarySource>().notNull().default('oto_pos'),
    formulaVersion: integer('formula_version').notNull(),
    provisional: boolean('provisional').notNull().default(false),
    frozen: boolean('frozen').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ticketsSatang: bigint('tickets_satang', { mode: 'number' }).notNull().default(0),
    fnbSatang: bigint('fnb_satang', { mode: 'number' }).notNull().default(0),
    merchSatang: bigint('merch_satang', { mode: 'number' }).notNull().default(0),
    partiesSatang: bigint('parties_satang', { mode: 'number' }).notNull().default(0),
    dropoffSatang: bigint('dropoff_satang', { mode: 'number' }).notNull().default(0),
    revenueSatang: bigint('revenue_satang', { mode: 'number' }).notNull().default(0),
    txnCount: integer('txn_count').notNull().default(0),
    creditPaidSatang: bigint('credit_paid_satang', { mode: 'number' }).notNull().default(0),
    guestsKids: integer('guests_kids').notNull().default(0),
    guestsAdults: integer('guests_adults').notNull().default(0),
    mix1h: integer('mix_1h').notNull().default(0),
    mix2h: integer('mix_2h').notNull().default(0),
    mixFullDay: integer('mix_full_day').notNull().default(0),
    partiesCount: integer('parties_count').notNull().default(0),
    refundsSatang: bigint('refunds_satang', { mode: 'number' }).notNull().default(0),
    discountsSatang: bigint('discounts_satang', { mode: 'number' }).notNull().default(0),
    compsSatang: bigint('comps_satang', { mode: 'number' }).notNull().default(0),
    vatSatang: bigint('vat_satang', { mode: 'number' }).notNull().default(0),
    serviceSatang: bigint('service_satang', { mode: 'number' }).notNull().default(0),
    byChannel: jsonb('by_channel')
      .$type<Record<string, { revenue: number; txn_count: number }>>()
      .notNull()
      .default({}),
    inputFingerprint: text('input_fingerprint').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('daily_summary_branch_date_source_unique').on(t.branchId, t.businessDate, t.source),
    index('daily_summary_operator_date_idx').on(t.operatorId, t.businessDate),
    /** The rollup's own look-up: rows still provisional, per branch. */
    index('daily_summary_provisional_idx')
      .on(t.branchId, t.businessDate)
      .where(sql`provisional`),
    check('daily_summary_source_check', sql`${t.source} in ('oto_pos','pisell','papaya')`),
    check('daily_summary_formula_check', sql`${t.formulaVersion} > 0`),
    check(
      'daily_summary_amounts_check',
      sql`${t.ticketsSatang} >= 0 and ${t.fnbSatang} >= 0 and ${t.merchSatang} >= 0 and ${t.partiesSatang} >= 0 and ${t.dropoffSatang} >= 0 and ${t.revenueSatang} >= 0 and ${t.creditPaidSatang} >= 0 and ${t.refundsSatang} >= 0 and ${t.discountsSatang} >= 0 and ${t.compsSatang} >= 0 and ${t.vatSatang} >= 0 and ${t.serviceSatang} >= 0`,
    ),
    check(
      'daily_summary_counts_check',
      sql`${t.txnCount} >= 0 and ${t.guestsKids} >= 0 and ${t.guestsAdults} >= 0 and ${t.mix1h} >= 0 and ${t.mix2h} >= 0 and ${t.mixFullDay} >= 0 and ${t.partiesCount} >= 0`,
    ),
    /** Revenue is the sum of the five bars on a platform row. */
    check(
      'daily_summary_revenue_check',
      sql`${t.source} <> 'oto_pos' or ${t.revenueSatang} = ${t.ticketsSatang} + ${t.fnbSatang} + ${t.merchSatang} + ${t.partiesSatang} + ${t.dropoffSatang}`,
    ),
    /** A frozen day is a closed one. */
    check('daily_summary_frozen_check', sql`not (${t.frozen} and ${t.provisional})`),
    check('daily_summary_by_channel_check', sql`jsonb_typeof(${t.byChannel}) = 'object'`),
  ],
);

/**
 * THE SAME MONEY BUCKETS PER HOUR — for Radar's 15-minute refresh and its
 * hourly chart. `hour` is the wall-clock hour (0-23) the sale was rung up at
 * its branch, inside the business date it belongs to. Only hours that had a
 * sale have a row; the hours of a day add up to the day.
 */
export const hourlySummary = analytics.table(
  'hourly_summary',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    hour: smallint('hour').notNull(),
    source: text('source').$type<AnalyticsSummarySource>().notNull().default('oto_pos'),
    formulaVersion: integer('formula_version').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ticketsSatang: bigint('tickets_satang', { mode: 'number' }).notNull().default(0),
    fnbSatang: bigint('fnb_satang', { mode: 'number' }).notNull().default(0),
    merchSatang: bigint('merch_satang', { mode: 'number' }).notNull().default(0),
    partiesSatang: bigint('parties_satang', { mode: 'number' }).notNull().default(0),
    dropoffSatang: bigint('dropoff_satang', { mode: 'number' }).notNull().default(0),
    revenueSatang: bigint('revenue_satang', { mode: 'number' }).notNull().default(0),
    txnCount: integer('txn_count').notNull().default(0),
    guests: integer('guests').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('hourly_summary_branch_date_hour_source_unique').on(
      t.branchId,
      t.businessDate,
      t.hour,
      t.source,
    ),
    index('hourly_summary_operator_date_idx').on(t.operatorId, t.businessDate),
    check('hourly_summary_hour_check', sql`${t.hour} between 0 and 23`),
    check('hourly_summary_source_check', sql`${t.source} in ('oto_pos','pisell','papaya')`),
    check(
      'hourly_summary_amounts_check',
      sql`${t.ticketsSatang} >= 0 and ${t.fnbSatang} >= 0 and ${t.merchSatang} >= 0 and ${t.partiesSatang} >= 0 and ${t.dropoffSatang} >= 0 and ${t.revenueSatang} >= 0 and ${t.txnCount} >= 0 and ${t.guests} >= 0`,
    ),
    check(
      'hourly_summary_revenue_check',
      sql`${t.source} <> 'oto_pos' or ${t.revenueSatang} = ${t.ticketsSatang} + ${t.fnbSatang} + ${t.merchSatang} + ${t.partiesSatang} + ${t.dropoffSatang}`,
    ),
  ],
);

/**
 * THE REPORTS PANELS' ROWS (Sales, Profitability, Discounts and Comps, Tax and
 * VAT), one row per branch, business date, source and key. Created here and
 * filled by the Reports round (plan §8 round 4); the per-transaction lists are
 * read through a date-bounded report query instead (plan question 13).
 *
 *   daily_category_summary  key = revenue category
 *   daily_tender_summary    key = tender code (`payment_attempt.method_code`)
 *   daily_item_summary      key = product id, or the line's component key
 *   daily_discount_summary  key = the discount's kind, type and code or reason
 */
export const dailyCategorySummary = analytics.table(
  'daily_category_summary',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    source: text('source').$type<AnalyticsSummarySource>().notNull().default('oto_pos'),
    key: text('key').notNull(),
    grossSatang: bigint('gross_satang', { mode: 'number' }).notNull().default(0),
    netSatang: bigint('net_satang', { mode: 'number' }).notNull().default(0),
    taxSatang: bigint('tax_satang', { mode: 'number' }).notNull().default(0),
    serviceSatang: bigint('service_satang', { mode: 'number' }).notNull().default(0),
    /**
     * `tax_satang` split by how it was charged (migration 0065, Reports round
     * 4): VAT already inside the price and VAT added on top are different
     * money, and the Tax & VAT panel shows them as two columns.
     */
    taxInclusiveSatang: bigint('tax_inclusive_satang', { mode: 'number' }).notNull().default(0),
    taxExclusiveSatang: bigint('tax_exclusive_satang', { mode: 'number' }).notNull().default(0),
    txnCount: integer('txn_count').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('daily_category_summary_unique').on(t.branchId, t.businessDate, t.source, t.key),
    index('daily_category_summary_operator_date_idx').on(t.operatorId, t.businessDate),
    check('daily_category_summary_source_check', sql`${t.source} in ('oto_pos','pisell','papaya')`),
    check('daily_category_summary_count_check', sql`${t.txnCount} >= 0`),
    check(
      'daily_category_summary_tax_split_check',
      sql`${t.taxInclusiveSatang} >= 0 and ${t.taxExclusiveSatang} >= 0`,
    ),
  ],
);

export const dailyTenderSummary = analytics.table(
  'daily_tender_summary',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    source: text('source').$type<AnalyticsSummarySource>().notNull().default('oto_pos'),
    key: text('key').notNull(),
    /** `pos.payment_attempt.method` of the tender: what kind of money it is. */
    method: text('method'),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull().default(0),
    refundedSatang: bigint('refunded_satang', { mode: 'number' }).notNull().default(0),
    txnCount: integer('txn_count').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('daily_tender_summary_unique').on(t.branchId, t.businessDate, t.source, t.key),
    index('daily_tender_summary_operator_date_idx').on(t.operatorId, t.businessDate),
    check('daily_tender_summary_source_check', sql`${t.source} in ('oto_pos','pisell','papaya')`),
    check(
      'daily_tender_summary_amounts_check',
      sql`${t.amountSatang} >= 0 and ${t.refundedSatang} >= 0 and ${t.txnCount} >= 0`,
    ),
  ],
);

export const dailyItemSummary = analytics.table(
  'daily_item_summary',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    source: text('source').$type<AnalyticsSummarySource>().notNull().default('oto_pos'),
    key: text('key').notNull(),
    /** `fnb` or `merch`, as the panel groups it. */
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    quantity: integer('quantity').notNull().default(0),
    revenueSatang: bigint('revenue_satang', { mode: 'number' }).notNull().default(0),
    /** What the units cost the park, for the units whose cost is known. */
    costSatang: bigint('cost_satang', { mode: 'number' }).notNull().default(0),
    /**
     * Units sold with no cost known (migration 0065): no cost frozen on the
     * stock movement and none on the product. Above zero, the Profitability
     * panel flags the item "no cost set" and its margin is understated.
     */
    costUntrackedQuantity: integer('cost_untracked_quantity').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('daily_item_summary_unique').on(t.branchId, t.businessDate, t.source, t.key),
    index('daily_item_summary_operator_date_idx').on(t.operatorId, t.businessDate),
    check('daily_item_summary_source_check', sql`${t.source} in ('oto_pos','pisell','papaya')`),
    check(
      'daily_item_summary_amounts_check',
      sql`${t.quantity} >= 0 and ${t.revenueSatang} >= 0 and ${t.costSatang} >= 0`,
    ),
    check('daily_item_summary_kind_check', sql`${t.kind} in ('fnb','merch')`),
    check(
      'daily_item_summary_untracked_check',
      sql`${t.costUntrackedQuantity} >= 0 and ${t.costUntrackedQuantity} <= ${t.quantity}`,
    ),
  ],
);

/**
 * THE TICKET SIDE OF THE SALES PANEL (migration 0065, Reports round 4), one
 * row per branch, business date, source, kind and key:
 *
 *   tier         key = the customer tier the sale was priced at. `sale_count`
 *                ticket sales; `revenue_satang` what they took less the
 *                drop-off category, `dropoff_satang` the drop-off category
 *                (the prototype's `ticketSalesByTier`). The two together are
 *                the ticket sales' totals, which the weekday / weekend split
 *                reads by the day's rate mode (`analytics.dim_date`).
 *   ticket_type  key = the ticket package. `line_count` cart lines, `kids`,
 *                `adults`, `revenue_satang` the lines' list price before
 *                discounts (`ticketTypeSalesRows`); a child's drop-off stay is
 *                not a ticket line here, as the prototype's drop-off line is not.
 *   service      key = `drop_off` or `nanny`. `line_count` sessions, `hours`
 *                the play hours chosen, `revenue_satang` the service fees
 *                (`dropOffNannyRevenueRows`).
 */
export const DAILY_TICKET_SUMMARY_KINDS = ['tier', 'ticket_type', 'service'] as const;
export type DailyTicketSummaryKind = (typeof DAILY_TICKET_SUMMARY_KINDS)[number];

export const dailyTicketSummary = analytics.table(
  'daily_ticket_summary',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    source: text('source').$type<AnalyticsSummarySource>().notNull().default('oto_pos'),
    kind: text('kind').$type<DailyTicketSummaryKind>().notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    saleCount: integer('sale_count').notNull().default(0),
    lineCount: integer('line_count').notNull().default(0),
    kids: integer('kids').notNull().default(0),
    adults: integer('adults').notNull().default(0),
    hours: integer('hours').notNull().default(0),
    /** Signed: a ticket sale's total less its drop-off category is not floored, as in the prototype. */
    revenueSatang: bigint('revenue_satang', { mode: 'number' }).notNull().default(0),
    dropoffSatang: bigint('dropoff_satang', { mode: 'number' }).notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('daily_ticket_summary_unique').on(t.branchId, t.businessDate, t.source, t.kind, t.key),
    index('daily_ticket_summary_operator_date_idx').on(t.operatorId, t.businessDate),
    check('daily_ticket_summary_source_check', sql`${t.source} in ('oto_pos','pisell','papaya')`),
    check('daily_ticket_summary_kind_check', sql`${t.kind} in ('tier','ticket_type','service')`),
    check(
      'daily_ticket_summary_counts_check',
      sql`${t.saleCount} >= 0 and ${t.lineCount} >= 0 and ${t.kids} >= 0 and ${t.adults} >= 0 and ${t.hours} >= 0 and ${t.dropoffSatang} >= 0`,
    ),
  ],
);

export const dailyDiscountSummary = analytics.table(
  'daily_discount_summary',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    source: text('source').$type<AnalyticsSummarySource>().notNull().default('oto_pos'),
    key: text('key').notNull(),
    /** `manual` | `promo`, as `pos.sale_discount.kind`. */
    kind: text('kind').notNull(),
    discountType: text('discount_type').notNull(),
    /** A promo's code as scanned; a voucher's shown as its last four (`maskVoucherCode`). */
    code: text('code'),
    reason: text('reason'),
    /** A promo's label as the receipt printed it (migration 0065). */
    label: text('label'),
    /**
     * Who applied a manual discount, and their name as the sale froze it
     * (migration 0065): the "By operator" card groups by the name.
     */
    appliedByAccountId: uuid('applied_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    appliedByName: text('applied_by_name'),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull().default(0),
    useCount: integer('use_count').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('daily_discount_summary_unique').on(t.branchId, t.businessDate, t.source, t.key),
    index('daily_discount_summary_operator_date_idx').on(t.operatorId, t.businessDate),
    index('daily_discount_summary_applied_by_idx').on(t.appliedByAccountId),
    check('daily_discount_summary_source_check', sql`${t.source} in ('oto_pos','pisell','papaya')`),
    check('daily_discount_summary_kind_check', sql`${t.kind} in ('manual','promo')`),
    check(
      'daily_discount_summary_amounts_check',
      sql`${t.amountSatang} >= 0 and ${t.useCount} >= 0`,
    ),
  ],
);

/**
 * THE BOOTH'S DAY, by booth, staff member and prize (plan §5; filled by round
 * 5): spins, vouchers issued and redeemed, the summed issue-to-redeem lag,
 * the booth's uptime and the prize cost. A spin with nobody signed in has no
 * staff member and a spin that won nothing has no prize, so the unique index
 * reads both through `coalesce` — two unattributed rows of one booth's day
 * are the same row.
 */
const NO_ID = sql.raw(`'00000000-0000-0000-0000-000000000000'::uuid`);

export const factBoothDaily = analytics.table(
  'fact_booth_daily',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** The booth: a station of kind `booth`. */
    boothId: uuid('booth_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    staffAccountId: uuid('staff_account_id').references(() => account.id, { onDelete: 'restrict' }),
    prizeId: uuid('prize_id').references(() => boothPrize.id, { onDelete: 'restrict' }),
    spins: integer('spins').notNull().default(0),
    vouchersIssued: integer('vouchers_issued').notNull().default(0),
    vouchersRedeemed: integer('vouchers_redeemed').notNull().default(0),
    redemptionLagSumS: bigint('redemption_lag_sum_s', { mode: 'number' }).notNull().default(0),
    uptimeS: bigint('uptime_s', { mode: 'number' }).notNull().default(0),
    prizeCostSatang: bigint('prize_cost_satang', { mode: 'number' }).notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fact_booth_daily_unique').on(
      t.branchId,
      t.businessDate,
      t.boothId,
      sql`coalesce(${t.staffAccountId}, ${NO_ID})`,
      sql`coalesce(${t.prizeId}, ${NO_ID})`,
    ),
    index('fact_booth_daily_operator_date_idx').on(t.operatorId, t.businessDate),
    index('fact_booth_daily_booth_idx').on(t.boothId),
    index('fact_booth_daily_staff_idx').on(t.staffAccountId),
    index('fact_booth_daily_prize_idx').on(t.prizeId),
    check(
      'fact_booth_daily_counts_check',
      sql`${t.spins} >= 0 and ${t.vouchersIssued} >= 0 and ${t.vouchersRedeemed} >= 0 and ${t.redemptionLagSumS} >= 0 and ${t.uptimeS} >= 0 and ${t.prizeCostSatang} >= 0`,
    ),
  ],
);

/**
 * THE STAFF BENEFITS' DAY (S2-21, SCRUM-218, round 4 of
 * docs/progress/plans/benefits/PLAN.md §5, §7): per branch, trading day,
 * beneficiary and benefit role, what the staff benefits took off the bills of
 * the day's recorded orders, split the prototype's four ways — comp, free
 * items, staff credit, standing discount — each with how many applications
 * used that stage, and the free-item units relieved.
 *
 * Read from `promo.benefit_application` — the live applications of the
 * branch-day's finalised and refunded sales, as the Staff Benefits Audit log
 * lists them — and from nothing else. A refund leaves a row as it was: the
 * relief was given and its quota stays used (plan Q4's default).
 *
 *   applied_satang  what came off the bills (the cascade may cap the relief
 *                   under the order's own manual discounts, H15);
 *   provisional     the day had not ended at its branch when the row was
 *                   written. `job:benefit.period_rollover` closes each ended
 *                   day — rewrites its rows final — at the branch's day start.
 *
 * Written by the daily rollup in the same transaction as the day's report
 * rows, and by the rollover, each under the branch-day's benefit lock; a row
 * is written only where a figure moved and a row the day no longer has is
 * removed, so a replayed run writes nothing.
 */
export const factBenefitDaily = analytics.table(
  'fact_benefit_daily',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** The beneficiary: whose QR it was. */
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** Their benefit role on the application, as it was snapshotted. */
    benefitRole: text('benefit_role').notNull(),
    applications: integer('applications').notNull().default(0),
    compCount: integer('comp_count').notNull().default(0),
    compedSatang: bigint('comped_satang', { mode: 'number' }).notNull().default(0),
    freeItemsCount: integer('free_items_count').notNull().default(0),
    freeItemUnits: integer('free_item_units').notNull().default(0),
    freeItemsSatang: bigint('free_items_satang', { mode: 'number' }).notNull().default(0),
    creditCount: integer('credit_count').notNull().default(0),
    creditSatang: bigint('credit_satang', { mode: 'number' }).notNull().default(0),
    discountCount: integer('discount_count').notNull().default(0),
    discountSatang: bigint('discount_satang', { mode: 'number' }).notNull().default(0),
    totalReliefSatang: bigint('total_relief_satang', { mode: 'number' }).notNull().default(0),
    appliedSatang: bigint('applied_satang', { mode: 'number' }).notNull().default(0),
    provisional: boolean('provisional').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fact_benefit_daily_unique').on(t.branchId, t.businessDate, t.employeeId, t.benefitRole),
    index('fact_benefit_daily_operator_date_idx').on(t.operatorId, t.businessDate),
    index('fact_benefit_daily_employee_idx').on(t.employeeId, t.businessDate),
    /** The rollover's look-up: rows still provisional, per branch. */
    index('fact_benefit_daily_provisional_idx')
      .on(t.branchId, t.businessDate)
      .where(sql`provisional`),
    check('fact_benefit_daily_role_check', sql`${t.benefitRole} in ('owner','manager','staff')`),
    check(
      'fact_benefit_daily_counts_check',
      sql`${t.applications} > 0 and ${t.compCount} >= 0 and ${t.freeItemsCount} >= 0 and ${t.freeItemUnits} >= 0 and ${t.creditCount} >= 0 and ${t.discountCount} >= 0
          and ${t.compCount} <= ${t.applications} and ${t.freeItemsCount} <= ${t.applications} and ${t.creditCount} <= ${t.applications} and ${t.discountCount} <= ${t.applications}`,
    ),
    check(
      'fact_benefit_daily_amounts_check',
      sql`${t.compedSatang} >= 0 and ${t.freeItemsSatang} >= 0 and ${t.creditSatang} >= 0 and ${t.discountSatang} >= 0 and ${t.appliedSatang} >= 0
          and ${t.totalReliefSatang} = ${t.compedSatang} + ${t.freeItemsSatang} + ${t.creditSatang} + ${t.discountSatang}
          and ${t.appliedSatang} <= ${t.totalReliefSatang}`,
    ),
  ],
);

/**
 * THE CALENDAR, PER BRANCH: each day's ISO weekday (1 = Monday … 7 = Sunday)
 * and its rate mode by the pricing resolver's own rule
 * (`getRateModeForDate`): inside a live `branch_holiday` range it is
 * `holiday` (priced as a weekend), Saturday and Sunday are `weekend`, the
 * rest `weekday`. Written by the rollup job from the branch's holidays, so a
 * holiday added or withdrawn reaches it on the next run.
 */
export const DIM_DATE_RATE_MODES = ['weekday', 'weekend', 'holiday'] as const;
export type DimDateRateMode = (typeof DIM_DATE_RATE_MODES)[number];

export const dimDate = analytics.table(
  'dim_date',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    date: date('date', { mode: 'string' }).notNull(),
    weekday: smallint('weekday').notNull(),
    rateMode: text('rate_mode').$type<DimDateRateMode>().notNull(),
    holidayName: text('holiday_name'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('dim_date_branch_date_unique').on(t.branchId, t.date),
    index('dim_date_operator_idx').on(t.operatorId),
    check('dim_date_weekday_check', sql`${t.weekday} between 1 and 7`),
    check('dim_date_rate_mode_check', sql`${t.rateMode} in ('weekday','weekend','holiday')`),
    check(
      'dim_date_holiday_check',
      sql`(${t.rateMode} = 'holiday') = (${t.holidayName} is not null)`,
    ),
  ],
);

/**
 * WHICH DAYS NEED ROLLING AGAIN, AND FOR WHOM.
 *
 *   sales   a fact behind the day's sales figures landed: a sale finalised,
 *           voided, refunded or deleted, a tender taken, a wallet movement on
 *           a sale. Read by the daily rollup.
 *   hourly  the daily rollup recomputed the day; read by the hourly summariser.
 *   booth   a booth fact landed (the booth report, round 5).
 *   wallet  a wallet movement landed; read by the wallet liability job.
 *
 * WRITTEN BY THE DATABASE, at the commit of the transaction that wrote the
 * fact (the deferred triggers of migration 0064), so every writer marks the
 * day — the till, the sync apply path, a back-office correction — and a sale
 * synced days late marks its own business date, not the day it arrived.
 *
 * THE CLAIM. A mark on a row that already exists bumps `mark_count` and clears
 * the claim. A job claims rows (`claimed_at`, `claimed_by`), recomputes their
 * days, and deletes each row only if its `mark_count` is still the one it
 * claimed — a mark that landed meanwhile keeps the row for the next run. A
 * claim older than the job's stale window is taken again, so a job that died
 * mid-run loses nothing.
 */
export const DIRTY_DATE_KINDS = ['sales', 'hourly', 'booth', 'wallet'] as const;
export type DirtyDateKind = (typeof DIRTY_DATE_KINDS)[number];

export const dirtyDate = analytics.table(
  'dirty_date',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    kind: text('kind').$type<DirtyDateKind>().notNull(),
    /** What marked it most recently, e.g. `sale:finalised`, `refund`, `wallet_entry`. */
    reason: text('reason').notNull(),
    markedAt: timestamp('marked_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Bumped by every mark; a claim is released by deleting only the count it claimed. */
    markCount: bigint('mark_count', { mode: 'number' }).notNull().default(1),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
    /** The run that claimed it. */
    claimedBy: text('claimed_by'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('dirty_date_branch_date_kind_unique').on(t.branchId, t.businessDate, t.kind),
    index('dirty_date_operator_idx').on(t.operatorId),
    index('dirty_date_kind_claim_idx').on(t.kind, t.claimedAt),
    check('dirty_date_kind_check', sql`${t.kind} in ('sales','hourly','booth','wallet')`),
    check('dirty_date_claim_check', sql`(${t.claimedAt} is null) = (${t.claimedBy} is null)`),
    check('dirty_date_mark_count_check', sql`${t.markCount} > 0`),
  ],
);

/**
 * WHICH SOURCE A BRANCH REPORTS (plan §5, filled by round 6): `oto_pos`, or
 * the legacy system it ran before (`pisell`, `papaya`), and which Radar should
 * show (`oto_pos`, `legacy`, or `both` side by side). One row per branch; a
 * branch with no row reports `oto_pos`.
 */
export const branchSourceSwitch = analytics.table(
  'branch_source_switch',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    source: text('source').$type<AnalyticsSummarySource>().notNull().default('oto_pos'),
    preference: text('preference').notNull().default('oto_pos'),
    switchedAt: timestamp('switched_at', { withTimezone: true, mode: 'date' }).notNull(),
    actorAccountId: uuid('actor_account_id').references(() => account.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('branch_source_switch_branch_unique').on(t.branchId),
    index('branch_source_switch_operator_idx').on(t.operatorId),
    index('branch_source_switch_actor_idx').on(t.actorAccountId),
    check('branch_source_switch_source_check', sql`${t.source} in ('oto_pos','pisell','papaya')`),
    check(
      'branch_source_switch_preference_check',
      sql`${t.preference} in ('oto_pos','legacy','both')`,
    ),
  ],
);
