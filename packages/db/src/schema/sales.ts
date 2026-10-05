import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { box, device, station } from './fleet';
import { child, member, visit } from './members';
import { branchHoliday, product, ticketPackage } from './catalog';
import { booking } from './future';
import type { RefundAllocationEntry, RefundLineEntry, RefundMode } from '@oto/shared';

// --- The sales ledger (schema `pos`) ---------------------------------------
//
// S2-09a (SCRUM-203). Until this migration the till could reach "Pay ฿1,440"
// and nothing existed to write it to: `sale` and `sale_line` were the Sprint 1
// placeholders — an operator, a branch, a status, one `total_satang` and a
// jsonb — and the only code that touched them was the demo reset, deleting
// them. A refresh of the POS lost every sale it had taken.
//
// WHAT A SALE IS, and it is not designed here. The park's rules are in the
// prototype: `lib/sale.ts` (`buildSale`, `computeTotals`, `tillTaxInputs`) and
// `mockApi.ts:1295` (`recordSale`). Those rules are already ported, tested and
// versioned in `@oto/shared` — `pricing.ts`, `cart-totals.ts`, `tax.ts`,
// `discount.ts`, `promo.ts`, `rounding.ts`, `business-date.ts`. These tables
// are the place that engine's OUTPUT is kept, and the column list is taken
// from the engine's own result shapes so that nothing has to be re-derived to
// be read back:
//
//   TicketCartTotals  → the totals block on `sale`
//   TaxBreakdown      → `tax_breakdown`, and the per-line tax columns
//   CartUnit / LineBreakdownItem → one `sale_line` per unit
//   ManualDiscountRecord / AppliedPromo → one `sale_discount` per instrument
//
// THE ONE RULE THE SHAPE SERVES: a receipt has to be reproducible years later
// from the rows alone. Not "re-derivable by re-running today's catalogue
// against a stored cart" — the catalogue changes, the holidays change, the tax
// rates change, and `cart-totals.ts` says at length what re-deriving a
// historical sale under today's context does to it (`staleLines`, and the
// worked ฿520-reported-as-฿620 example). So every input that moved the money
// is frozen onto the row: the pricing mode and why, the tier at the time, the
// tax config that applied, the engine version that computed it, and the totals
// split into net, service and tax rather than one number.

/**
 * Where the guest bought, which is a question about the park's business.
 *
 * Distinct from `origin` below, which is a question about the plumbing. A
 * booking redeemed at the counter is `till` sold and `cloud` originated; the
 * same booking settled by the booking site is `booking` and `cloud`. Reports
 * read this one; sync diagnostics read the other.
 */
export const SALES_CHANNELS = ['till', 'kiosk', 'booking', 'booth', 'fnb', 'shop'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

/**
 * Which system wrote the fact.
 *
 *   box     rung up at a station on a branch box, possibly while it was
 *           offline, and carried up by the sync ledger. `occurred_at` is the
 *           box's clock and `clock_trust` says whether to believe it.
 *   cloud   written by the api itself — the virtual box on staging, a booking
 *           settled centrally, a back-office correction.
 *   import  migrated from the outgoing Pisell/Papaya systems (M3). Present so
 *           that a restored production figure can never be mistaken for one
 *           this platform took.
 */
export const SALE_ORIGINS = ['box', 'cloud', 'import'] as const;
export type SaleOrigin = (typeof SALE_ORIGINS)[number];

/**
 * THE LIFE OF A SALE, and the reason a void is a status rather than a delete:
 * "this sale was cancelled" and "this sale never happened" are different
 * answers, and only the first one is true when a receipt has already been
 * printed and its number consumed.
 *
 *   tendering  the cart has been committed and money is being taken. The OPEN
 *              cart is not here — it lives on the box in
 *              `edge.station_session.cart`, which is what the display mirrors.
 *              A row appears here when the till leaves the cart behind.
 *   paid       tenders cover the total (`pos.payment_attempt`, S2-10a).
 *   finalised  the receipt number is allocated and persisted, and the sale is
 *              closed. A ฿0 comp reaches this without ever being `paid` —
 *              there is no tender to take — which is why finalisation and
 *              payment are two states and not one.
 *   voided     cancelled. Before finalisation it is an abandoned cart with no
 *              receipt; after, the receipt number stays consumed and the row
 *              stays readable, because a gap in a till's numbering has to be
 *              explainable to the park's accountant.
 *   refunded   fully refunded (S2-11). A PARTIAL refund leaves the status at
 *              `finalised` and shows in `refunded_satang` — there is no sixth
 *              status, so S2-11 does not have to invent one; if it needs the
 *              distinction visible in a `where` clause, that is a decision to
 *              raise rather than a column to add quietly.
 */
export const SALE_STATUSES = ['tendering', 'paid', 'finalised', 'voided', 'refunded'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** Matches `edge.sync_event.clock_trust`: the same doubt about the same clock. */
export const SALE_CLOCK_TRUSTS = ['trusted', 'skewed', 'untrusted'] as const;
export type SaleClockTrust = (typeof SALE_CLOCK_TRUSTS)[number];

/**
 * Which document series a number came out of. `sale` is the abbreviated tax
 * invoice the till prints; `refund` is the credit note S2-11 will print, and it
 * has its own series so that a credit note never consumes a sale's number.
 * `end_of_day` (S2-15a round 2) numbers the End of Day receipt on the closing
 * counter, on a series of its own for the same reason.
 */
export const RECEIPT_SERIES_KINDS = ['sale', 'refund', 'end_of_day'] as const;
export type ReceiptSeriesKind = (typeof RECEIPT_SERIES_KINDS)[number];

/**
 * HOW A RECEIPT NUMBER IS ALLOCATED, decided here because it cannot be decided
 * later: the first sale fixes it for every sale after.
 *
 * **Per station, gapless within that station's series, allocated on the box.**
 * The number is `<station code_prefix>-<seq>` — "HKT1-000428", the shape
 * `packages/print`'s receipt template already prints.
 *
 * WHY NOT ONE GAPLESS SEQUENCE PER BRANCH, which is what an accountant asks
 * for first: a single branch-wide counter has a single allocator, and the
 * allocator is either the cloud (so no sale can be rung up while the mall's
 * internet is down — the park has a Pi per branch precisely because that
 * happens) or one nominated box (so the second till stops when the first box
 * does). Neither is acceptable at a counter with a queue. A per-station series
 * is the standard POS answer and the one the Revenue Department's practice for
 * abbreviated tax invoices is built around: each machine runs its own running
 * number and the machine is identified on the document.
 *
 * WHAT THIS ROW IS: the CLOUD's high-water mark for one series — the number a
 * box resumes from when it comes back, is reimaged, or is replaced. It is
 * already in the sync contract (`receipt_series` is a cache-bundle scope in
 * `packages/box-agent/src/contract.ts` and `apps/api/src/services/sync.ts`,
 * which ships `next_seq - 1` per station as the mark since SCRUM-275). The
 * box will allocate locally while offline once S2-12 gives it an allocator;
 * on reconnect the cloud advances `next_seq` past everything it has seen.
 *
 * WHAT STOPS TWO BOXES MINTING THE SAME NUMBER: a station belongs to exactly
 * one box, so two allocators for one series can only come from a
 * misconfiguration or a restored-from-backup box. `sale_receipt_unique` refuses
 * the second arrival, and the sync path turns that refusal into a
 * `sync_anomaly` rather than a lost sale — which is the acceptance criterion
 * S2-09a states.
 *
 * GAPS. Within a series the numbers are consecutive by construction, and the
 * two things that leave a visible gap are both explainable from the ledger: a
 * voided sale keeps its number (the row is still there), and a box that lost
 * its local store resumes from this high-water mark, which can skip the
 * numbers it had allocated but never sent. Both are answerable; a duplicate
 * would not be.
 *
 * A YEARLY RESET, if the park's accountant wants one, is a new `series` value
 * ("HKT1-2027"), not a counter reset: the unique key is (station, series,
 * kind), so the old series keeps its numbers and nothing is ever reissued.
 */
export const receiptSeries = pos.table(
  'receipt_series',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The allocator is the station, not the box: a station moved to another box keeps its series. */
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /** Printed on the document. Seeded from `station.code_prefix`; never rewritten. */
    series: text('series').notNull(),
    kind: text('kind').$type<ReceiptSeriesKind>().notNull().default('sale'),
    /**
     * The next number this series will issue — the cloud's high-water mark.
     * Starts at 1 rather than 0 so that a printed "000001" is a real first
     * sale and not an uninitialised counter.
     */
    nextSeq: bigint('next_seq', { mode: 'number' }).notNull().default(1),
    /** How wide the printed number is zero-padded, e.g. 6 → "000428". */
    seqPadding: integer('seq_padding').notNull().default(6),
    /** When the cloud last advanced this mark, for the fleet page. */
    lastIssuedAt: timestamp('last_issued_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('receipt_series_unique').on(t.stationId, t.series, t.kind),
    index('receipt_series_branch_idx').on(t.branchId, t.kind),
    index('receipt_series_operator_idx').on(t.operatorId),
    check('receipt_series_kind_check', sql`${t.kind} in ('sale','refund','end_of_day')`),
    check('receipt_series_next_check', sql`${t.nextSeq} > 0`),
    check('receipt_series_padding_check', sql`${t.seqPadding} between 1 and 12`),
  ],
);

/**
 * ONE SALE — the park's money record, and the row every later ticket hangs
 * off: payments (S2-10a), printing (S2-11), refunds (S2-11), wallets and stock
 * (S2-14), Today and the day-close report (S2-15), Radar (S2-18).
 *
 * `id` IS THE IDEMPOTENCY KEY. The till mints a UUIDv7 when it commits the
 * cart, so pressing Pay twice through a dropped connection sends the same id
 * twice and the primary key makes the second one a replay, answered with the
 * existing row and `x-oto-replay: true` (the platform's client-minted-id
 * convention). `sale_action_unique` is the second net: a retry that mints a
 * NEW id but carries the same `x-oto-action-id` is refused rather than
 * written, so a client bug cannot turn one press into two sales.
 *
 * IMMUTABLE ONCE FINALISED, and that is enforced by a trigger in the migration
 * (`pos.sale_freeze`), not by a convention: everything except the status and
 * the void/refund columns is frozen, so no service, script or psql session can
 * silently rewrite what a guest was charged. The trigger does NOT block
 * deletes — the staging demo reset wipes the day's facts on purpose — so what
 * it guarantees is "no quiet rewrite", not "indestructible".
 */
export const sale = pos.table(
  'sale',
  {
    /** UUIDv7, minted by the till in the transaction that commits the cart. */
    id: idPk(),

    // --- Where and when ----------------------------------------------------
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** Not nullable: the receipt series is the station's, so a sale without one cannot be numbered. */
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /**
     * The box that carried it. Null when the cloud wrote the sale with no box
     * in the path — a booking settled centrally, a back-office correction —
     * which is a different fact from "a box wrote it and we lost which one".
     */
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    /**
     * THE TRADING DAY, resolved once from the branch's `business_day_start`
     * (`businessDate` in `@oto/shared`) and never derived on a read. A sale at
     * 00:30 belongs to the day that is finishing: the park trades until 20:00
     * and the late party, the cash count and the day-close print all land
     * after midnight. Every report, cash-up and till roll counts on this
     * column, and `rateModeToday`'s ruling 3 says the same date also chose the
     * price — everything answers to the day printed on the receipt.
     */
    businessDate: date('business_date').notNull(),
    /**
     * The branch's day start and timezone AS THEY WERE. Frozen because a
     * branch that later moves its day start would otherwise silently re-answer
     * "which day was this sale on" for every sale it ever took, and because
     * reading the wall-clock time of a sale out of `occurred_at` needs the zone
     * that was in force.
     */
    businessDayStart: time('business_day_start').notNull(),
    timezone: text('timezone').notNull(),
    /** The wall time the till rang it up, as the writing clock saw it. Never overwritten. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** When the cloud took it. Equal to `occurred_at` for a cloud-written sale, later for a box's. */
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /**
     * Whether the writing box could vouch for its own clock. A Pi has no clock
     * battery; one that came up after a mall power cut with no NTP will stamp
     * a confident, wrong `occurred_at`, and a day's figures that look wrong
     * have to be explainable from the row itself.
     */
    clockTrust: text('clock_trust').$type<SaleClockTrust>().notNull().default('trusted'),
    origin: text('origin').$type<SaleOrigin>().notNull().default('cloud'),
    salesChannel: text('sales_channel').$type<SalesChannel>().notNull().default('till'),
    /** The box journal position this arrived at, for reconciling a sync gap. */
    boxSeq: bigint('box_seq', { mode: 'number' }),
    /**
     * The `edge.sync_event` it arrived as. No foreign key, deliberately: the
     * sync ledger is swept and a sale is not, so the pointer has to outlive
     * what it points at. Same rule as `core.audit_log.source_event_id`.
     */
    sourceEventId: uuid('source_event_id'),
    /** `x-oto-action-id`, carried till -> box -> cloud. */
    actionId: text('action_id'),

    // --- Who ---------------------------------------------------------------
    /**
     * The account that rang it up. Not nullable: the till cannot reach the pay
     * button without a signed-in staff session, and an unattributable money row
     * is the thing an investigation is looking for. If this ever cannot be
     * supplied the write fails loudly at the till instead of recording a sale
     * nobody made.
     */
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /**
     * The offline staff token the box verified, by its `jti`. No foreign key:
     * `core.staff_token` names a retention job it may one day be swept by, and
     * a restricting key would either block that sweep or take the attribution
     * with it. Same rule as `source_event_id` above.
     */
    staffTokenJti: uuid('staff_token_jti'),
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'restrict' }),
    visitId: uuid('visit_id').references(() => visit.id, { onDelete: 'restrict' }),
    bookingId: uuid('booking_id').references(() => booking.id, { onDelete: 'restrict' }),

    // --- What was charged, and why -----------------------------------------
    /**
     * The rate mode that priced every line, and the human reason the POS
     * header showed ("Weekend pricing — Songkran"). Stored rather than
     * recomputed: a holiday range added or withdrawn next year must not change
     * what this sale says it charged.
     */
    pricingMode: text('pricing_mode').notNull(),
    pricingModeReason: text('pricing_mode_reason').notNull(),
    /** The holiday range that forced weekend pricing, if one did. Name frozen beside the id. */
    holidayId: uuid('holiday_id').references(() => branchHoliday.id, { onDelete: 'restrict' }),
    holidayName: text('holiday_name'),
    /**
     * The member's tier AT THE TIME OF SALE (`crm.tier.code`), which is what
     * chose the prices. A walk-in is `tourist`. Text rather than a key to
     * `crm.tier`: a tier renamed or withdrawn later must not rewrite what this
     * guest was charged as.
     */
    customerTier: text('customer_tier').notNull(),
    /**
     * SCRUM-311 — the document check that chose that tier, when one did.
     *
     * Null on every sale priced from a member's record or from the operator's
     * default, which is most of them. When it is set, the row it names is the
     * passport or residence certificate reception checked at the counter
     * minutes earlier, with who checked it — so "why was this guest charged the
     * expat rate" is answerable from the ledger itself rather than by matching
     * a sale against the audit log by branch, tier and time.
     */
    tierClaimId: uuid('tier_claim_id').references((): AnyPgColumn => saleTierClaim.id, {
      onDelete: 'restrict',
    }),
    /** `PRICING_ENGINE_VERSION` from `@oto/shared` — which arithmetic produced the totals. */
    engineVersion: text('engine_version').notNull(),
    /** The catalogue bundle the box was holding, when it came from a box (sync `bundleVersion`). */
    catalogueVersion: text('catalogue_version'),
    /** The resolved `TaxConfigShape` that applied — the rates, the category rules, the placement. */
    taxConfig: jsonb('tax_config').notNull(),
    /** The computed `TaxBreakdown`: per-category base, mode, rate, service and tax. The receipt's rows. */
    taxBreakdown: jsonb('tax_breakdown').notNull(),

    // --- The money ---------------------------------------------------------
    // Satang, and split rather than totalled: "฿1,440" alone cannot answer the
    // accountant's question, the Revenue Department's, or a refund's.
    /** Σ line totals before any discount — the "Subtotal" the receipt prints. */
    subtotalSatang: bigint('subtotal_satang', { mode: 'number' }).notNull().default(0),
    /** Staff-applied discounts (`TicketCartTotals.manualDiscountTotal`). */
    manualDiscountSatang: bigint('manual_discount_satang', { mode: 'number' }).notNull().default(0),
    /** Scanned promo codes (`TicketCartTotals.promoDiscountTotal`). */
    promoDiscountSatang: bigint('promo_discount_satang', { mode: 'number' }).notNull().default(0),
    /** Both together. Checked against the two parts below. */
    discountSatang: bigint('discount_satang', { mode: 'number' }).notNull().default(0),
    /** Revenue excluding service charge and tax of either kind. */
    netSatang: bigint('net_satang', { mode: 'number' }).notNull().default(0),
    serviceChargeSatang: bigint('service_charge_satang', { mode: 'number' }).notNull().default(0),
    /**
     * VAT ALREADY INSIDE the price (the park's inclusive default) and VAT
     * ADDED on top, kept apart because they are different money: one is
     * reported on the receipt and the other is charged by it. Adding them into
     * a single "vat" column is exactly the mistake `TaxBreakdown.taxTotal`
     * warns about in `@oto/shared/tax.ts`.
     */
    taxInclusiveSatang: bigint('tax_inclusive_satang', { mode: 'number' }).notNull().default(0),
    taxExclusiveSatang: bigint('tax_exclusive_satang', { mode: 'number' }).notNull().default(0),
    /** What the guest pays (`TaxBreakdown.grandTotal`). */
    grossSatang: bigint('gross_satang', { mode: 'number' }).notNull().default(0),
    /**
     * Discount that found no base left to reduce and was dropped
     * (`TaxBreakdown.unappliedDiscount`). Zero on a normal sale; non-zero is
     * a promo stack that over-reached, and it is kept because the prototype
     * silently swallowed it.
     */
    unappliedDiscountSatang: bigint('unapplied_discount_satang', { mode: 'number' })
      .notNull()
      .default(0),
    /** Running total refunded (S2-11). Full refund also moves `status`. */
    refundedSatang: bigint('refunded_satang', { mode: 'number' }).notNull().default(0),

    // --- The document ------------------------------------------------------
    /** Allocated at finalisation, persisted BEFORE the receipt is printed. See `receiptSeries`. */
    receiptSeries: text('receipt_series'),
    receiptSeq: bigint('receipt_seq', { mode: 'number' }),
    /** The printed form, e.g. "HKT1-000428". Stored so a padding change cannot rewrite history. */
    receiptNumber: text('receipt_number'),

    // --- Lifecycle ---------------------------------------------------------
    status: text('status').$type<SaleStatus>().notNull().default('tendering'),
    finalisedAt: timestamp('finalised_at', { withTimezone: true, mode: 'date' }),
    voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
    voidedByAccountId: uuid('voided_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /** Required with a void: "cancelled" with no reason is what the report exists to stop. */
    voidReason: text('void_reason'),
    refundedAt: timestamp('refunded_at', { withTimezone: true, mode: 'date' }),
    /** Free-text staff note carried from the till (the prototype's sale note). */
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    // The day's sales, the cash-up, Today, the day-close report.
    index('sale_branch_date_idx').on(t.branchId, t.businessDate),
    index('sale_station_date_idx').on(t.stationId, t.businessDate),
    index('sale_operator_date_idx').on(t.operatorId, t.businessDate),
    index('sale_box_occurred_idx').on(t.boxId, t.occurredAt),
    index('sale_member_idx').on(t.memberId),
    index('sale_visit_idx').on(t.visitId),
    index('sale_booking_idx').on(t.bookingId),
    index('sale_account_idx').on(t.createdByAccountId),
    index('sale_voided_by_idx').on(t.voidedByAccountId),
    index('sale_holiday_idx').on(t.holidayId),
    index('sale_received_idx').on(t.receivedAt),
    /** "Show me what is still open at this station" — the till's own recovery. */
    index('sale_station_status_idx')
      .on(t.stationId, t.status)
      .where(sql`status in ('tendering','paid')`),
    /**
     * THE CONSTRAINT THE NUMBERING RESTS ON. Two boxes allocating in one series
     * collide here instead of printing the same number on two guests' receipts.
     */
    uniqueIndex('sale_receipt_unique')
      .on(t.stationId, t.receiptSeries, t.receiptSeq)
      .where(sql`receipt_seq is not null`),
    uniqueIndex('sale_receipt_number_unique')
      .on(t.branchId, t.receiptNumber)
      .where(sql`receipt_number is not null`),
    /** Pressing Pay twice: a retry that minted a new id is refused, not written. */
    uniqueIndex('sale_action_unique')
      .on(t.stationId, t.actionId)
      .where(sql`action_id is not null`),
    index('sale_source_event_idx').on(t.sourceEventId),
    /**
     * ONE DOCUMENT CHECK PRICES ONE SALE (SCRUM-311). The service spends the
     * claim with a conditional update in the same transaction, which is what
     * decides the race; this is the net under it, so no import, backfill or
     * psql session can point two sales at one passport check either.
     */
    uniqueIndex('sale_tier_claim_unique')
      .on(t.tierClaimId)
      .where(sql`tier_claim_id is not null`),

    check(
      'sale_status_check',
      sql`${t.status} in ('tendering','paid','finalised','voided','refunded')`,
    ),
    check('sale_origin_check', sql`${t.origin} in ('box','cloud','import')`),
    check(
      'sale_channel_check',
      sql`${t.salesChannel} in ('till','kiosk','booking','booth','fnb','shop')`,
    ),
    check('sale_pricing_mode_check', sql`${t.pricingMode} in ('weekday','weekend')`),
    check('sale_clock_trust_check', sql`${t.clockTrust} in ('trusted','skewed','untrusted')`),
    /** The totals have to add up, whoever wrote them. */
    check(
      'sale_totals_check',
      sql`${t.grossSatang} = ${t.netSatang} + ${t.serviceChargeSatang} + ${t.taxInclusiveSatang} + ${t.taxExclusiveSatang}`,
    ),
    check(
      'sale_discount_parts_check',
      sql`${t.discountSatang} = ${t.manualDiscountSatang} + ${t.promoDiscountSatang}`,
    ),
    check(
      'sale_non_negative_check',
      sql`${t.subtotalSatang} >= 0 and ${t.discountSatang} >= 0 and ${t.manualDiscountSatang} >= 0 and ${t.promoDiscountSatang} >= 0 and ${t.netSatang} >= 0 and ${t.serviceChargeSatang} >= 0 and ${t.taxInclusiveSatang} >= 0 and ${t.taxExclusiveSatang} >= 0 and ${t.grossSatang} >= 0 and ${t.unappliedDiscountSatang} >= 0 and ${t.refundedSatang} >= 0`,
    ),
    /** A refund can never exceed what was taken. */
    check('sale_refund_bound_check', sql`${t.refundedSatang} <= ${t.grossSatang}`),
    /** The three parts of a receipt number arrive together or not at all. */
    check(
      'sale_receipt_parts_check',
      sql`(${t.receiptNumber} is null and ${t.receiptSeries} is null and ${t.receiptSeq} is null)
          or (${t.receiptNumber} is not null and ${t.receiptSeries} is not null and ${t.receiptSeq} is not null and ${t.receiptSeq} > 0)`,
    ),
    /** A finalised or refunded sale has a number and a time; an abandoned cart has neither. */
    check(
      'sale_finalised_check',
      sql`${t.status} not in ('finalised','refunded') or (${t.receiptNumber} is not null and ${t.finalisedAt} is not null)`,
    ),
    check(
      'sale_void_check',
      sql`${t.status} <> 'voided' or (${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
    check('sale_refunded_check', sql`${t.status} <> 'refunded' or ${t.refundedAt} is not null`),
  ],
);

/**
 * A DOCUMENT CHECK AT THE COUNTER, recorded before it prices anything
 * (SCRUM-307, given its own table by SCRUM-311).
 *
 * WHAT IT IS FOR. A visitor whose passport reception has just checked is not a
 * member yet, so there is no record to read a tier from and the cart would
 * price at the operator's default. Reception records the check through
 * `POST /sales/tier-claims`, the cart names that ACTION ID, and the tier comes
 * from the row written here — never from the request body, which is the rule
 * the whole money path stands on (`services/sale.ts`, rule 2).
 *
 * WHY IT IS A TABLE AND NOT AN AUDIT ROW, which is where SCRUM-307 left it. A
 * claim is not only a fact about the past; it is a thing that gets SPENT. One
 * document check prices one sale, and nothing in an append-only log can hold
 * that: `spent_by_sale_id` is a column somebody has to be able to set, under a
 * conditional update, in the transaction that writes the sale. The audit row is
 * still written beside it — the log is the trail, this is the record.
 *
 * WHAT IS NOT HERE, and the omission is the point: no document number, no name,
 * no free-text note. The kind of document and its expiry are what price a cart;
 * anything that identifies the document would be an identity number sitting in
 * a table nothing ever sweeps. The durable evidence record — with its note — is
 * written against the MEMBER by `POST /members/:id/tier-verification` once the
 * visitor gives their details.
 *
 * TWO PREDICATES END A CLAIM. It is spent, or it is old: the resolver looks
 * only inside a 30-minute window from `created_at`
 * (`TIER_CLAIM_WINDOW_MS`), long enough for a party order rung up line by line
 * and short enough that a claim left behind by a visitor who walked away cannot
 * price the next person's cart later in the shift. Nothing is deleted when
 * either happens: the row stays as the record of what was checked.
 */
export const saleTierClaim = pos.table(
  'sale_tier_claim',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /** The branch the check was made at, from the SESSION rather than the body. */
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /**
     * The account that checked the document, also from the session. It is half
     * the resolver's predicate: a claim prices a cart for the session that made
     * it and for no other, so one till cannot price from a claim another till
     * recorded.
     */
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /**
     * `x-oto-action-id` of the tap that confirmed the document — the key the
     * cart names, and the claim's identity. Unique per operator, so one tap is
     * one claim however many times the request is retried.
     */
    actionId: text('action_id').notNull(),
    /** `crm.tier.code` the document supports. Text, as on `sale.customer_tier`. */
    toTier: text('to_tier').notNull(),
    /** `Passport`, `Residence certificate` — a KIND, never a number. */
    evidenceType: text('evidence_type').notNull(),
    /**
     * The document's own expiry, when it carries one. One that has passed
     * prices nothing; none recorded means it never expires, as at the
     * member verification step.
     */
    evidenceExpiresAt: date('evidence_expires_at'),
    /**
     * The sale this claim priced, once one did. Set by a conditional update
     * inside the sale's transaction — `where spent_by_sale_id is null` — so two
     * carts racing for one claim cannot both win it.
     */
    spentBySaleId: uuid('spent_by_sale_id').references((): AnyPgColumn => sale.id, {
      onDelete: 'restrict',
    }),
    spentAt: timestamp('spent_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    /** One tap, one claim — and what a cart's action id is looked up by. */
    uniqueIndex('sale_tier_claim_action_unique').on(t.operatorId, t.actionId),
    /** The resolver's own predicate: this account, this branch, inside the window. */
    index('sale_tier_claim_session_idx').on(t.accountId, t.branchId, t.createdAt),
    index('sale_tier_claim_branch_idx').on(t.branchId),
    index('sale_tier_claim_sale_idx').on(t.spentBySaleId),
    /** Spent means both, or neither: a claim cannot be half-spent. */
    check(
      'sale_tier_claim_spent_check',
      sql`(${t.spentBySaleId} is null) = (${t.spentAt} is null)`,
    ),
  ],
);

/**
 * WHAT A LINE IS: one discountable unit of the cart — the kids row, the paid
 * adults row, the free adults row, socks, each add-on, the drop-off service
 * fee, prepaid food, a free-item promo's item. Not one row per cart line.
 *
 * WHY, because it is the difference between a reproducible receipt and an
 * approximate one. One cart line can hold money from three taxable categories
 * at once — tickets, an add-on carrying a `taxCategoryOverride`, and a
 * drop-off fee — so a per-line tax rate is only meaningful on the unit. It is
 * also exactly the decomposition the engine already computes (`CartUnit` in
 * `cart-totals.ts`, built from `computeLineBreakdown`): storing the engine's
 * own units means the ledger holds what was computed rather than a summary of
 * it, and the discount ledger, the tax cascade and the printed rows all line
 * up because they are the same objects.
 *
 * `cart_line_id` keeps the cart line visible — it is the till's own line id, so
 * "these four rows were one 2 Hours Play for 2 kids and 3 adults" survives.
 *
 * No `updated_at`: a line is an immutable fact of a sale. The migration's
 * `pos.sale_line_freeze` trigger refuses to update one once its sale is
 * finalised.
 */
export const SALE_LINE_KINDS = [
  'kids',
  'adults_paid',
  'adults_free',
  'socks',
  'addon',
  'service_fee',
  'food_provision',
  'promo_item',
  /** Not written until S2-09b brings the F&B and shop carts; listed now so that ticket needs no migration. */
  'fnb_item',
  'merch_item',
] as const;
export type SaleLineKind = (typeof SALE_LINE_KINDS)[number];

export const saleLine = pos.table(
  'sale_line',
  {
    id: idPk(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sale.id, { onDelete: 'restrict' }),
    /**
     * Denormalised from the sale, and only these three. A day's line-level
     * report — the ticket mix, the add-on attach rate, Radar's facts — is
     * otherwise a join to a table an order of magnitude larger on every read,
     * for three values that are frozen at insert and cannot drift.
     */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date').notNull(),

    /** Receipt order, 1-based. The order the engine produced the units in. */
    lineNo: integer('line_no').notNull(),
    /** The till's cart line this unit came out of — the grouping a receipt prints under. */
    cartLineId: uuid('cart_line_id').notNull(),
    kind: text('kind').$type<SaleLineKind>().notNull(),
    /**
     * The engine's breakdown-row key (`LineBreakdownItem.key`): an add-on id,
     * the socks add-on id, `dropoff-service`. Text because the add-on
     * catalogue is still the prototype's (S2-09b owns the table); when it
     * lands, `product_id` carries the reference and this stays as the trace.
     */
    componentKey: text('component_key'),
    ticketPackageId: uuid('ticket_package_id').references(() => ticketPackage.id, {
      onDelete: 'restrict',
    }),
    productId: uuid('product_id').references(() => product.id, { onDelete: 'restrict' }),
    /** What the receipt showed, frozen: "2 Hours Play — Kids", "Regular Socks". */
    label: text('label').notNull(),
    /**
     * Reporting grouping from the catalogue. Null until S2-09b adds the
     * revenue category and sub-category columns to packages and add-ons; the
     * taxable category below is populated from day one because the engine
     * needs it to price.
     */
    revenueCategory: text('revenue_category'),
    revenueSubCategory: text('revenue_sub_category'),
    /** `TaxableCategory` in `@oto/shared` — tickets, addons, fnb, drop_off, stored_value… */
    taxableCategory: text('taxable_category').notNull(),

    // --- The money on this unit --------------------------------------------
    quantity: integer('quantity').notNull().default(1),
    /** Snapshot of the resolved unit price at this tier and rate mode. */
    unitSatang: bigint('unit_satang', { mode: 'number' }).notNull().default(0),
    /** quantity × unit, before any discount (`CartUnit.base`). */
    baseSatang: bigint('base_satang', { mode: 'number' }).notNull().default(0),
    /**
     * What the sale's discounts took off THIS unit. An apportionment: the
     * engine discounts units in order and taxes by category, so the
     * authoritative category figures are the sale's `tax_breakdown` and these
     * are the per-unit split of them. Kept because a refund, a receipt reprint
     * and a line-level report all need it, and re-deriving it later needs the
     * cart that no longer exists.
     */
    discountSatang: bigint('discount_satang', { mode: 'number' }).notNull().default(0),
    /** Revenue on this unit, excluding service and tax of either kind. */
    netSatang: bigint('net_satang', { mode: 'number' }).notNull().default(0),
    serviceChargeSatang: bigint('service_charge_satang', { mode: 'number' }).notNull().default(0),
    /** VAT attributable to this unit, whether added on top or already inside. */
    taxSatang: bigint('tax_satang', { mode: 'number' }).notNull().default(0),
    /** `TaxMode`: inclusive (inside `gross`), exclusive (added to it), none. */
    taxMode: text('tax_mode').notNull().default('inclusive'),
    /** Basis points, e.g. 700 = 7 %. The rate's own id and name beside it, frozen. */
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    taxRateId: text('tax_rate_id'),
    taxName: text('tax_name'),
    /** What the guest paid for this unit. */
    grossSatang: bigint('gross_satang', { mode: 'number' }).notNull().default(0),

    // --- What produced it ---------------------------------------------------
    /** The tier that chose the price, frozen: a later tier change must not re-price a sold line. */
    customerTier: text('customer_tier').notNull(),
    /**
     * The cart line's own participant counts, carried on every unit of that
     * line — so "2 kids and 3 adults, one of them free" is readable off the
     * ticket rows without reassembling the cart. `free_adult_count` is the
     * package's free-adult allowance as it was actually spent on this line.
     */
    kidCount: integer('kid_count').notNull().default(0),
    adultCount: integer('adult_count').notNull().default(0),
    freeAdultCount: integer('free_adult_count').notNull().default(0),
    /** The play length sold, from the package: hours and the printed label ("2 Hours"). */
    stayHours: integer('stay_hours'),
    stayDurationLabel: text('stay_duration_label'),
    /** Set once a unit is tied to a named child or to the band that was issued (S2-11, S2-13). */
    childId: uuid('child_id').references(() => child.id, { onDelete: 'restrict' }),
    bandId: uuid('band_id').references(() => band.id, { onDelete: 'restrict' }),
    /** Anything the engine carried that has no column yet — variant splits, promo item refs. */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sale_line_order_unique').on(t.saleId, t.lineNo),
    index('sale_line_sale_idx').on(t.saleId),
    index('sale_line_cart_line_idx').on(t.cartLineId),
    /** The day's line-level reports. */
    index('sale_line_branch_date_idx').on(t.branchId, t.businessDate),
    index('sale_line_operator_date_idx').on(t.operatorId, t.businessDate),
    /** The ticket mix: how many of this package sold on this day. */
    index('sale_line_package_date_idx').on(t.ticketPackageId, t.businessDate),
    index('sale_line_product_idx').on(t.productId),
    index('sale_line_category_date_idx').on(t.taxableCategory, t.businessDate),
    index('sale_line_child_idx').on(t.childId),
    index('sale_line_band_idx').on(t.bandId),
    check(
      'sale_line_kind_check',
      sql`${t.kind} in ('kids','adults_paid','adults_free','socks','addon','service_fee','food_provision','promo_item','fnb_item','merch_item')`,
    ),
    check('sale_line_tax_mode_check', sql`${t.taxMode} in ('inclusive','exclusive','none')`),
    check('sale_line_quantity_check', sql`${t.quantity} >= 0 and ${t.lineNo} > 0`),
    check(
      'sale_line_totals_check',
      sql`${t.grossSatang} = ${t.netSatang} + ${t.taxSatang} + ${t.serviceChargeSatang}`,
    ),
    check(
      'sale_line_non_negative_check',
      sql`${t.baseSatang} >= 0 and ${t.discountSatang} >= 0 and ${t.netSatang} >= 0 and ${t.serviceChargeSatang} >= 0 and ${t.taxSatang} >= 0 and ${t.grossSatang} >= 0 and ${t.taxRateBp} >= 0`,
    ),
  ],
);

/**
 * How a discount was applied, and it is a table rather than a jsonb blob
 * because three different readers ask three different questions of it: the
 * receipt prints the rows, the "discounts given" report groups them by reason
 * and by who applied them, and a refund has to undo them in the order they
 * ran.
 *
 * THE ORDER IS THE MONEY. `cart-totals.ts` states it: all manual discounts
 * first (line scope, then order scope), then promo codes each against the
 * balance the previous one left, then the whole discount into the tax cascade
 * — and reversing two of those steps moves a worked ฿2,130 bill by ฿20. So
 * `sequence` is stored, not sorted by id or by time.
 */
export const SALE_DISCOUNT_KINDS = ['manual', 'promo'] as const;
export type SaleDiscountKind = (typeof SALE_DISCOUNT_KINDS)[number];

export const saleDiscount = pos.table(
  'sale_discount',
  {
    id: idPk(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sale.id, { onDelete: 'restrict' }),
    /** Denormalised for the discounts-given report, as on `sale_line`. */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date').notNull(),

    /** 1-based, and it is the order the engine applied them in. */
    sequence: integer('sequence').notNull(),
    kind: text('kind').$type<SaleDiscountKind>().notNull(),
    /** `percent` | `fixed` | `comp` (manual) · `percent` | `fixed` | `free_item` (promo). */
    discountType: text('discount_type').notNull(),
    /** Basis points for a percent discount; the satang amount for a fixed one. Exactly one is set. */
    percentBp: integer('percent_bp'),
    valueSatang: bigint('value_satang', { mode: 'number' }),
    /** What it actually resolved to on this cart (`ManualDiscountRecord.amount`). */
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull().default(0),
    /**
     * `DiscountAllocation[]` — how the amount was attributed across taxable
     * categories. Without it the tax cascade cannot be reproduced: a discount
     * total on its own does not say which category absorbed it.
     */
    allocations: jsonb('allocations'),
    /** order | line | component, with what it was aimed at. */
    scope: text('scope').notNull().default('order'),
    targetLineId: uuid('target_line_id'),
    targetComponent: text('target_component'),
    targetLabel: text('target_label'),
    /** The promo code as scanned, and its label. Null for a manual discount. */
    code: text('code'),
    label: text('label'),
    /**
     * A code that found nothing left in its own scope and took nothing
     * (`AppliedPromo.exhaustedReason`). Kept because reception needs an answer
     * for the guest asking why their code did nothing — on the receipt a code
     * that spent zero is otherwise identical to one nobody scanned.
     */
    exhaustedReason: text('exhausted_reason'),
    /**
     * Why staff applied it. Required for a manual discount — the "discounts
     * given" report exists because a discount with no reason is unaccountable
     * — and the choices are branch-editable data, so this is the chosen text
     * and not an enum.
     */
    reason: text('reason'),
    note: text('note'),
    appliedByAccountId: uuid('applied_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /** The operator's name as it was, for the receipt and the report. */
    appliedByName: text('applied_by_name'),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sale_discount_order_unique').on(t.saleId, t.sequence),
    index('sale_discount_sale_idx').on(t.saleId),
    /** The discounts-given report: by day, by reason, by who. */
    index('sale_discount_branch_date_idx').on(t.branchId, t.businessDate),
    index('sale_discount_operator_date_idx').on(t.operatorId, t.businessDate),
    index('sale_discount_applied_by_idx').on(t.appliedByAccountId),
    index('sale_discount_code_idx').on(t.code),
    check('sale_discount_kind_check', sql`${t.kind} in ('manual','promo')`),
    check(
      'sale_discount_type_check',
      sql`${t.discountType} in ('percent','fixed','comp','free_item')`,
    ),
    check('sale_discount_scope_check', sql`${t.scope} in ('order','line','component')`),
    check('sale_discount_sequence_check', sql`${t.sequence} > 0`),
    check('sale_discount_amount_check', sql`${t.amountSatang} >= 0`),
    /** A manual discount names its reason and who applied it; a promo names its code. */
    check(
      'sale_discount_manual_check',
      sql`${t.kind} <> 'manual' or (${t.reason} is not null and ${t.appliedByAccountId} is not null)`,
    ),
    check('sale_discount_promo_check', sql`${t.kind} <> 'promo' or ${t.code} is not null`),
    /** A percent discount carries a percentage; a fixed one carries an amount. */
    check(
      'sale_discount_value_check',
      sql`(${t.discountType} <> 'percent' or ${t.percentBp} is not null)
          and (${t.discountType} <> 'fixed' or ${t.valueSatang} is not null)`,
    ),
  ],
);

/**
 * The tender vocabulary, as the DATABASE enforces it.
 *
 * Three lists, each a CHECK below, and each repeated from `@oto/shared`'s
 * `payments.ts` — where the till, the Console and the box agent read them —
 * because a schema file states its own vocabulary rather than importing the
 * API's (the same rule as `TAXABLE_CATEGORIES` above and `BOX_COMMAND_KINDS` in
 * `edge.ts`). The two copies are compared character for character by
 * `packages/db/test/migration-0019.test.ts`, so a word added to one and not the
 * other fails a test rather than a payment.
 *
 * Each word is documented once, in `@oto/shared/payments.ts`. Read it there.
 */
export const PAYMENT_METHODS = ['cash', 'card', 'qr', 'wallet', 'voucher', 'transfer', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_PROVIDERS = ['simulator', 'ghl', 'digio', '2c2p', 'manual'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_ATTEMPT_STATUSES = [
  'created',
  'sent_to_terminal',
  'approved',
  'declined',
  'cancelled',
  'unknown',
  'inquiring',
  'not_found',
  'awaiting_staff_confirmation',
  'awaiting_settlement',
] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/**
 * ONE ATTEMPT TO TAKE MONEY (S2-10a, SCRUM-206).
 *
 * "Attempt" is deliberate and it is the whole design: a card is declined, a QR
 * expires, a terminal answers nothing at all, and a sale carries several of
 * these before one succeeds — all of which have to survive for the day to be
 * reconciled. Until this migration the table was the Sprint 1 placeholder:
 * `sale_id`, a free-text `method`, an amount, a status with no CHECK, and a
 * jsonb. One writer, one value ever written (`'approved'`), and nowhere at all
 * to put a TID, an approval code, a gateway invoice number or the fact that a
 * terminal never came back.
 *
 * FOUR PROPERTIES THE COLUMN SET IS BUILT AROUND.
 *
 * 1. **The row is written before the money is asked for.** `created` is the
 *    first status and `action_id` is unique per operator, so the attempt IS the
 *    idempotency key: a tender retried down a dropped connection finds the row
 *    instead of charging the card twice. `status = 'finalised'` on the sale was
 *    the only net before this, and it stops being sufficient the moment a sale
 *    can be part-paid.
 * 2. **Several attempts per sale, and no unique index on `sale_id`.** Split
 *    tenders and an asynchronous QR both need an approved attempt sitting on an
 *    unfinalised sale. `outstandingOf` already sums N rows; the shape simply
 *    must not forbid it.
 * 3. **It answers the money questions from itself.** `business_date`,
 *    `station_id`, `operator_id`/`branch_id` and `paid_at` are on the row so
 *    the end-of-day (S2-15a) groups without a join and without a backfill; the
 *    tenancy columns are here rather than being read through `sale_id` because
 *    an attempt can exist before a sale does.
 * 4. **No PAN, ever.** What an adapter is allowed to keep is
 *    `ATTEMPT_ALLOW_LIST` in `@oto/shared`, applied where the frame is parsed;
 *    `packages/telemetry/src/redact.ts` is the second net under every
 *    `ops_run`. An approval code on THIS row is correct — it is the money
 *    record — and the same code in an `ops_run.detail` is redacted, because
 *    that is a page in a browser. The two are not in conflict.
 */
export const paymentAttempt = pos.table(
  'payment_attempt',
  {
    id: idPk(),

    // --- Whose, where and when ---------------------------------------------
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /**
     * Nullable, and that is the point of property 1 above: the attempt can be
     * opened before the cart is committed — a QR minted while the guest is
     * still choosing — and is tied to the sale when there is one.
     */
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    /**
     * Where it was taken. Null for money that reaches us with no counter in
     * the path — the booking site's own QR (S2-12), a back-office correction.
     */
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    /**
     * The terminal that answered. Null for cash, for the gateway, and for a
     * manual entry — three tenders where no device is involved at all, which
     * is a different fact from a device we failed to record.
     */
    deviceId: uuid('device_id').references(() => device.id, { onDelete: 'restrict' }),
    /** The trading day, resolved from the branch's day start exactly as `sale.business_date` is. */
    businessDate: date('business_date').notNull(),

    // --- What kind of money -------------------------------------------------
    /**
     * `PAYMENT_METHODS` in `@oto/shared` — what KIND of money this was. Not the
     * tender the park configured: "PromptPay" and a second acquirer's card are
     * rows in `pos.payment_method`, and behaviour keys off this word so that
     * renaming one of them changes a label and nothing else.
     */
    method: text('method').$type<PaymentMethod>().notNull(),
    /**
     * The configured tender's `code` as the till chose it (`pos.payment_method
     * .code`) — `promptpay`, `cash`. Kept beside `method` because otherwise the
     * ledger cannot say WHICH card acquirer or WHICH wallet took the money, and
     * the receipt cannot print the name the park gave it. No foreign key: a
     * tender archived next year must not take its own history with it.
     */
    methodCode: text('method_code'),
    /**
     * Who answered. `manual` covers both a staff-keyed approval code and cash —
     * in both cases a person recorded it and no device or gateway replied.
     */
    provider: text('provider').$type<PaymentProvider>().notNull().default('manual'),
    /** `PAYMENT_ATTEMPT_STATUSES` in `@oto/shared`, which documents each one. */
    status: text('status').$type<PaymentAttemptStatus>().notNull().default('created'),

    // --- The money ----------------------------------------------------------
    /** What was asked for. A part payment is a smaller amount, not a smaller sale. */
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull().default(0),
    /**
     * Cash: what was handed over and what went back. Columns rather than jsonb
     * because the cash-up counts them. The till's own change figure, when it
     * disagrees with the platform's, stays in `payload.tillChangeSatang`: that
     * is evidence of a disagreement, not a second figure to add up.
     */
    tenderedSatang: bigint('tendered_satang', { mode: 'number' }),
    changeSatang: bigint('change_satang', { mode: 'number' }),

    // --- What the terminal said --------------------------------------------
    /** The terminal's own reference: 12-char `pos_ref_no` (GHL) or 6-digit (Digio). */
    terminalRef: text('terminal_ref'),
    /**
     * Frozen onto the row rather than read off `core.device` later: a terminal
     * re-keyed to another merchant next year must not rewrite which merchant
     * took this money. For GHL they come from the device row (the card wire
     * carries neither); for Digio they arrive on the frame.
     */
    tid: text('tid'),
    mid: text('mid'),
    approvalCode: text('approval_code'),
    /** Four digits. The only part of a card number that may be stored at all. */
    last4: text('last4'),

    // --- What the gateway said ---------------------------------------------
    /**
     * OUR number, one per attempt, and unique FOR EVER — 2C2P refuses a reused
     * one (`5005`, `9015`), so a re-shown QR is a new attempt with a new
     * number. Built by `buildInvoiceNo` in `@oto/shared`; the CHECK below is
     * the same rule as a property of the column.
     */
    invoiceNo: text('invoice_no'),
    /** THEIR references, as they come back on the notification and the inquiry. */
    tranRef: text('tran_ref'),
    paymentId: text('payment_id'),
    /**
     * The EMVCo payload the display renders. Stored so that showing the QR
     * again — or re-rendering it after a refresh — never calls the gateway
     * back. It is a payment instruction, not a credential: it identifies the
     * merchant and the amount, and it is displayed on a screen to a stranger.
     */
    qrPayload: text('qr_payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),

    // --- How it ended -------------------------------------------------------
    /** When the money became ours, by whichever signal said so. */
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    /**
     * WHO SAID IT WAS PAID when no machine could. Set only on the
     * `awaiting_staff_confirmation` path — the NEXGO card sale that has no
     * QUERY to run — and the same decision is written to the audit log beside
     * it. A confirmation nobody is named on is the thing an investigation is
     * looking for.
     */
    staffConfirmedByAccountId: uuid('staff_confirmed_by').references(() => account.id, {
      onDelete: 'restrict',
    }),

    // --- How it reached us --------------------------------------------------
    /** Taken while the box could not reach the cloud. Shown on the till and on the Sale detail. */
    offline: boolean('offline').notNull().default(false),
    /** The box journal position it arrived at, as `sale.box_seq` is. */
    boxSeq: bigint('box_seq', { mode: 'number' }),
    /**
     * `x-oto-action-id`, minted where the person pressed Pay. Three things hang
     * off it: the replay guard (the unique below), the Box log line, and the
     * adapter's `ops_run` — which is the acceptance criterion "the action id on
     * an attempt matches the Box log line and the adapter ops_run".
     *
     * Text, not uuid, like `sale.action_id` and `box_command.action_id`: it is
     * a header value carried till → box → cloud, and the one place it must not
     * be is a type that refuses to record what actually arrived. The ticket's
     * own sketch said `uuid`; the two columns this one is compared against are
     * both `text`, and a `uuid` here would make a replay guard that throws on
     * the very requests it exists to recognise.
     */
    actionId: text('action_id'),
    /**
     * The adapter's answer after the allow-list projection, plus the few facts
     * with no column of their own (`tillChangeSatang`, `expired`). Never the
     * raw frame — that stays in the simulator.
     */
    payload: jsonb('payload'),
    ...timestamps,
  },
  (t) => [
    index('payment_attempt_sale_idx').on(t.saleId),
    index('payment_attempt_station_idx').on(t.stationId),
    index('payment_attempt_device_idx').on(t.deviceId),
    index('payment_attempt_staff_confirmed_idx').on(t.staffConfirmedByAccountId),
    /** `job:payments.pending`: everything unresolved and older than N minutes. */
    index('payment_attempt_status_created_idx').on(t.status, t.createdAt),
    /** The day's takings by tender — the cash-up, and S2-15a's end of day. */
    index('payment_attempt_operator_date_idx').on(t.operatorId, t.businessDate),
    index('payment_attempt_branch_date_idx').on(t.branchId, t.businessDate),
    /** The webhook and the inquiry both arrive holding one of these. */
    index('payment_attempt_tran_ref_idx').on(t.tranRef),
    /**
     * THE GATEWAY'S KEY, and it is unique for ever rather than per day or per
     * station: 2C2P's own uniqueness is global to the merchant, and a number we
     * reused would be refused at the counter with nothing a person could act
     * on. Device-less gateway attempts, including the simulator, share this
     * namespace. Hardware invoices are local to a terminal; their replay net
     * is the device/date/terminalRef key below.
     */
    uniqueIndex('payment_attempt_gateway_invoice_unique')
      .on(t.invoiceNo)
      .where(sql`invoice_no is not null and device_id is null`),
    /**
     * PRESSING PAY TWICE. The net under the tender path, in the same shape as
     * `sale_action_unique`: a retry that reached the database twice writes one
     * attempt, and the second insert is refused rather than charging a second
     * time. Scoped to the operator because the id is minted on a till.
     */
    uniqueIndex('payment_attempt_action_unique')
      .on(t.operatorId, t.actionId)
      .where(sql`action_id is not null`),
    /**
     * "Refs are unique per terminal per day" — the ticket's own test. The
     * counter that mints them is `edge.box_counter` under scope `terminal_ref`
     * (D-1), whose primary key already carries the business date; this is the
     * net under it for the write that does not come through the box.
     */
    uniqueIndex('payment_attempt_terminal_ref_unique')
      .on(t.deviceId, t.businessDate, t.terminalRef)
      .where(sql`device_id is not null and terminal_ref is not null`),
    check(
      'payment_attempt_method_check',
      sql`${t.method} in ('cash','card','qr','wallet','voucher','transfer','other')`,
    ),
    check(
      'payment_attempt_provider_check',
      sql`${t.provider} in ('simulator','ghl','digio','2c2p','manual')`,
    ),
    check(
      'payment_attempt_status_check',
      sql`${t.status} in ('created','sent_to_terminal','approved','declined','cancelled','unknown','inquiring','not_found','awaiting_staff_confirmation','awaiting_settlement')`,
    ),
    check(
      'payment_attempt_amount_check',
      sql`${t.amountSatang} >= 0
          and (${t.tenderedSatang} is null or ${t.tenderedSatang} >= 0)
          and (${t.changeSatang} is null or ${t.changeSatang} >= 0)`,
    ),
    /**
     * A SHORT TENDER IS NOT A TENDER. `changeFor` refuses one at the service
     * (400, rather than recording negative change); this is the same rule where
     * an import or a psql session cannot walk around it.
     */
    check(
      'payment_attempt_tendered_check',
      sql`${t.tenderedSatang} is null or ${t.tenderedSatang} >= ${t.amountSatang}`,
    ),
    /** The gateway's charset and length, as a property of the column. */
    check(
      'payment_attempt_invoice_no_check',
      sql`${t.invoiceNo} is null or ${t.invoiceNo} ~ '^[A-Z0-9]{1,20}$'`,
    ),
    /** Four digits or nothing. The column is the one place a longer string could start to look acceptable. */
    check('payment_attempt_last4_check', sql`${t.last4} is null or ${t.last4} ~ '^[0-9]{4}$'`),
    /** A staff confirmation is a status, not a note: the name and the state travel together. */
    check(
      'payment_attempt_staff_confirmed_check',
      sql`${t.staffConfirmedByAccountId} is null or ${t.status} <> 'created'`,
    ),
  ],
);

/**
 * ONE NOTIFICATION FROM THE PAYMENT GATEWAY, kept as it arrived.
 *
 * WHY IT IS NOT A UNIQUE INDEX ON THE ATTEMPT. 2C2P legitimately sends several
 * notifications about one payment — a pending one and a paid one, a retry after
 * our 200 was slow — so "this delivery has been seen" is a fact about the
 * delivery and not about the attempt. `PAYMENT_GATEWAY.md:650-654` names the
 * key: `(invoiceNo, tranRef)`, falling back to `paymentID` when `tranRef` is
 * absent. Both spellings are unique indexes below — TWO where the ticket's own
 * sketch said one `unique(invoice_no, tran_ref)`, because Postgres treats
 * nulls as distinct and that single index would have let every `tran_ref`-less
 * delivery through as often as it arrived, which is the exact thing the key
 * exists to stop. A CHECK closes the third case, the delivery that carries
 * neither. So a duplicate delivery is refused by the database rather than by
 * whichever branch of the handler happened to run first.
 *
 * WHY THE RAW ENVELOPE IS KEPT. It is the evidence in a dispute — the park says
 * a guest paid, the bank's statement disagrees — and it is the only copy of
 * what was actually signed. It is a payment notification, not a credential: it
 * carries an invoice number, an amount and a masked account number, and the
 * key that verified it never appears in it.
 */
export const paymentNotification = pos.table(
  'payment_notification',
  {
    id: idPk(),
    /**
     * The merchant's operator. Resolved from the matched attempt, or — for a
     * notification whose invoice matches nothing, which is a case the webhook
     * must still record — from the configured merchant that signed it. A
     * notification that fails the merchant check is refused before this row is
     * written and lives only as an `ops_run`.
     */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /** Null when the invoice number matches no attempt — `unmatched_payment`, alerted, answered 200. */
    attemptId: uuid('attempt_id').references((): AnyPgColumn => paymentAttempt.id, {
      onDelete: 'restrict',
    }),
    invoiceNo: text('invoice_no').notNull(),
    tranRef: text('tran_ref'),
    paymentId: text('payment_id'),
    /** 2C2P's `respCode` as it arrived, before any mapping to our own status words. */
    respCode: text('resp_code'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** The decoded claims, and the envelope they were decoded from. */
    raw: jsonb('raw'),
    /**
     * The `ops_run` that recorded the delivery — source IP, headers, outcome.
     * No foreign key: runs are pruned after a month and this record is the
     * park's evidence, so the pointer has to outlive what it points at. Same
     * rule as `sale.source_event_id`.
     */
    opsRunId: uuid('ops_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_notification_attempt_idx').on(t.attemptId),
    index('payment_notification_operator_idx').on(t.operatorId),
    index('payment_notification_invoice_idx').on(t.invoiceNo),
    index('payment_notification_received_idx').on(t.receivedAt),
    /**
     * The idempotency key, in two halves because Postgres treats nulls as
     * distinct: one delivery with a `tranRef`, one without. A single index over
     * both columns would let the same `tranRef`-less delivery through twice,
     * which is the exact thing the key exists to stop.
     */
    uniqueIndex('payment_notification_tran_unique')
      .on(t.invoiceNo, t.tranRef)
      .where(sql`tran_ref is not null`),
    uniqueIndex('payment_notification_payment_unique')
      .on(t.invoiceNo, t.paymentId)
      .where(sql`tran_ref is null and payment_id is not null`),
    /**
     * THE KEY IS NOT OPTIONAL. Both indexes above are partial, so a delivery
     * carrying neither reference is covered by neither and could be written as
     * many times as it arrived — the one shape that walks between them, and the
     * exact thing the key exists to stop. A notification with no reference at
     * all cannot be matched to an attempt or compared with a later one, so it
     * is not a delivery this table can hold: the handler refuses it and it
     * lives as an `ops_run` with its envelope, like a bad signature does
     * (`PAYMENT_GATEWAY.md:640-654`).
     */
    check(
      'payment_notification_key_check',
      sql`${t.tranRef} is not null or ${t.paymentId} is not null`,
    ),
  ],
);

// --- Bands and refunds (S2-11) ------------------------------------------------

/**
 * `kid` or `adult` — which printer, which template, whether an allergy line
 * can print on it. The prototype's `sale.bracelets.children` / `.adults`.
 */
export const BAND_KINDS = ['kid', 'adult'] as const;
export type BandKind = (typeof BAND_KINDS)[number];

/**
 * A band is a credential, and its status is the credential's, not the paper's.
 *
 *   active    admits at the gate.
 *   replaced  a NEW band (new id, new code) took over from this one — a lost
 *             band re-issued. Not what a reprint does: a reprint is the same
 *             band, the same code, on fresh paper (`band_event` `reprinted`).
 *   revoked   stopped on purpose; the gate refuses it.
 */
export const BAND_STATUSES = ['active', 'replaced', 'revoked'] as const;
export type BandStatus = (typeof BAND_STATUSES)[number];

/**
 * What can happen to a band, as `band_event.kind` records it. `minted` and
 * `reprinted` are written by S2-11; `scanned` by the box's band handler;
 * `replaced` and `revoked` by the tickets that re-issue and stop bands.
 * `entry`, `exit`, `denied`, `timeout` and `alarm` are the gate box's journal
 * (S2-12 round 2, `band.gate_event`): a passage credited to the band, a
 * refusal at the reader, an open nobody passed, reverse or tailgating after an
 * open — with station, box and reason in `detail`.
 */
export const BAND_EVENT_KINDS = [
  'minted',
  'reprinted',
  'replaced',
  'revoked',
  'scanned',
  'entry',
  'exit',
  'denied',
  'timeout',
  'alarm',
] as const;
export type BandEventKind = (typeof BAND_EVENT_KINDS)[number];

/**
 * THE WRISTBAND A VISITOR WEARS, and the signed code printed on it (S2-11).
 *
 * Replaces the Sprint 1 placeholder that sat in `future.ts` with a bare `code`
 * and a jsonb. What a band IS now: one person admitted on one sale, named by
 * a code the box can verify with no network (`mintBandCode` in `@oto/shared`).
 *
 * **The id is the code.** The band's UUIDv7 id is the ULID inside its code, so
 * a verified scan names this row without a lookup, and a reprint — same row,
 * same id — prints the same code. `band_code_unique` is therefore a net under
 * a property the arithmetic already has, not the thing that provides it.
 *
 * **Minted by the platform inside sale finalisation for now.** The format is
 * the box's already (station-prefixed, HMAC-signed), and minting moves to the
 * box with offline selling (SCRUM-269); the row does not change when it does.
 *
 * `printed_job_id` is the print job that put this band on paper most
 * recently. NO FOREIGN KEY, for the reason `print_job.reprint_of` has none: a
 * print job is swept after ninety days and a band is not, so the pointer has
 * to outlive what it points at.
 *
 * Statused, not archived: a band is never hidden, only stopped.
 */
export const band = pos.table(
  'band',
  {
    /** UUIDv7 — and the ULID inside the band's code. */
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The sale that paid for this person's admission. */
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sale.id, { onDelete: 'restrict' }),
    /** The ticket unit it was issued against — the kids row or the adults row. */
    saleLineId: uuid('sale_line_id').references((): AnyPgColumn => saleLine.id, {
      onDelete: 'restrict',
    }),
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'restrict' }),
    /** The child it was issued to, when the visit named one. Kids bands only. */
    childId: uuid('child_id').references(() => child.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<BandKind>().notNull(),
    /**
     * Whether this band operates the entrance gate (SCRUM-494). Taken from the
     * ticket package of the line it was issued against when it is minted —
     * online, on the box, or recorded from the box — and never changed after:
     * an adult band carries its package's Gate access, a kids band never has
     * it. The gate admits only bands with it; a band without it follows its
     * group in the occupancy count (`mockApi.ts:getLiveOccupancy`).
     */
    gateAccess: boolean('gate_access').notNull().default(false),
    /** The signed code, as `normaliseBandCode` stores it. A gate credential. */
    code: text('code').notNull(),
    status: text('status').$type<BandStatus>().notNull().default('active'),
    /** The most recent print job for this band. No foreign key — see above. */
    printedJobId: uuid('printed_job_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('band_code_unique').on(t.code),
    index('band_operator_idx').on(t.operatorId),
    index('band_branch_idx').on(t.branchId),
    index('band_sale_idx').on(t.saleId),
    index('band_sale_line_idx').on(t.saleLineId),
    index('band_member_idx').on(t.memberId),
    index('band_child_idx').on(t.childId),
    /** The box's `bands` scope: a branch's active bands. */
    index('band_branch_status_idx').on(t.branchId, t.status),
    check('band_kind_check', sql`${t.kind} in ('kid','adult')`),
    check('band_status_check', sql`${t.status} in ('active','replaced','revoked')`),
    /** An adult band names no child; the allergy line is the kids band's alone. */
    check('band_child_kind_check', sql`${t.childId} is null or ${t.kind} = 'kid'`),
    /** Kids' bands never operate the gate (`mockApi.ts:issueWalkInBands`). */
    check('band_gate_access_kind_check', sql`not ${t.gateAccess} or ${t.kind} = 'adult'`),
  ],
);

/**
 * What happened to a band, append-only (S2-11).
 *
 * The shape `booking_redemption` and `core.audit_log` use: a `created_at` and
 * no `updated_at`, because an event happened or it did not. `detail` carries
 * the facts of the event — the print job a reprint made and the one it
 * replaced, the reason — and NEVER the band's code, which is a credential
 * (`scanning.ts` in `@oto/shared` says why a code does not go into a log).
 */
export const bandEvent = pos.table(
  'band_event',
  {
    id: idPk(),
    bandId: uuid('band_id')
      .notNull()
      .references(() => band.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<BandEventKind>().notNull(),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('band_event_band_idx').on(t.bandId, t.createdAt),
    index('band_event_station_idx').on(t.stationId),
    index('band_event_box_idx').on(t.boxId),
    check(
      'band_event_kind_check',
      sql`${t.kind} in ('minted','reprinted','replaced','revoked','scanned','entry','exit','denied','timeout','alarm')`,
    ),
  ],
);

/**
 * ONE REFUND of a finalised sale (S2-11) — the prototype's `Refund`, kept.
 *
 * **Its own number, from its own series.** `receipt_series` already has the
 * `refund` kind for exactly this: a credit note never consumes a sale's
 * number, and the refund series is per station like the sale's, allocated
 * under the same row lock (`allocateReceipt`). The number is `<prefix>-R-<seq>`.
 *
 * **Who asked and who approved are two columns** even when they are the same
 * person today: approval is `pos:refund:approve`, a manager's, and "reception
 * asked, the manager approved" is the shape the next approval step writes
 * without a migration.
 *
 * **`lines` and `tender_allocation` are jsonb, and frozen.** `lines` is what
 * the refund covered (`RefundLineEntry` in `@oto/shared`) with whether each
 * returns to stock — applied by S2-14b. `tender_allocation` is how the money
 * went back (`RefundAllocationEntry`): which attempt, which route — wallet,
 * cash, a terminal void, the gateway — and where each slice stands. A slice
 * waiting on a terminal's or the gateway's answer is the one thing that moves
 * after the row is written, which is why the row has an `updated_at`.
 *
 * Append-only otherwise: a refund is never archived or edited. A wrong refund
 * is corrected by a sale, not by rewriting this row.
 */
export const refund = pos.table(
  'refund',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sale.id, { onDelete: 'restrict' }),
    /** The station whose refund series numbered it — where it was made. */
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /** e.g. `T1-R-000003`, from `receipt_series` kind `refund`. */
    number: text('number').notNull(),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    mode: text('mode').$type<RefundMode>().notNull(),
    /** Required, as a void's is: a refund with no reason is what the report exists to stop. */
    reason: text('reason').notNull(),
    note: text('note'),
    approvedByAccountId: uuid('approved_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    lines: jsonb('lines').$type<RefundLineEntry[]>().notNull().default([]),
    tenderAllocation: jsonb('tender_allocation')
      .$type<RefundAllocationEntry[]>()
      .notNull()
      .default([]),
    /** `x-oto-action-id`: one press of Refund, however many HTTP attempts it took. */
    actionId: text('action_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('refund_number_unique').on(t.branchId, t.number),
    uniqueIndex('refund_action_unique')
      .on(t.operatorId, t.actionId)
      .where(sql`action_id is not null`),
    index('refund_operator_idx').on(t.operatorId),
    index('refund_sale_idx').on(t.saleId),
    index('refund_station_idx').on(t.stationId),
    index('refund_branch_created_idx').on(t.branchId, t.createdAt),
    index('refund_approved_by_idx').on(t.approvedByAccountId),
    index('refund_created_by_idx').on(t.createdByAccountId),
    check('refund_amount_check', sql`${t.amountSatang} > 0`),
    check('refund_mode_check', sql`${t.mode} in ('whole','items','custom')`),
    check('refund_reason_check', sql`length(trim(${t.reason})) > 0`),
  ],
);
