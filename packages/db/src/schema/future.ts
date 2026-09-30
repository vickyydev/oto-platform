import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { station } from './fleet';
import { member } from './members';
import { ticketPackage } from './catalog';
import { paymentAttempt } from './sales';

// --- Sales and money (schema `pos`) ----------------------------------------
// Created in Sprint 1 so the data model accommodated M2–M4; the tickets that
// own them extend the columns. S2-01b renamed them to the names the rest of
// the sprint uses — `sale`, `sale_line`, `payment_attempt`, `band`,
// `stock_item` — while they are still empty, which is the only cheap moment
// to do it.
//
// `band` left too, with S2-11: the real table — a signed code, the sale it
// was paid on, its events — lives beside the ledger in `sales.ts`.
//
// `sale`, `sale_line` and `payment_attempt` have left this file: S2-09a
// (SCRUM-203) replaced the first two with the real ledger and they now live,
// with the discount rows and the receipt series, in `sales.ts`. The payment
// placeholder went with them because it is a row on a sale and S2-10a extends
// it there. What is left here is still what it says: tables Sprint 1 created
// so the shape was right, waiting for the ticket that owns them.

/**
 * THE WORDS A BOOKING'S STATUS MAY BE (S2-12, SCRUM-209), and what moves it:
 *
 *   pending    written by the booking site; nothing paid yet. Held until
 *              `expires_at` for a payment to arrive.
 *   paid       the gateway's backend notification AND a Payment Inquiry agreed
 *              (or the inquiry poller found it) — never the browser's return.
 *   redeemed   claimed at a counter, once (`booking_redemption`).
 *   expired    the hold ran out, or the gateway closed the payment unpaid.
 *   cancelled  the hosted page's payment failed.
 *
 * A late payment still confirms an expired or cancelled booking, and raises an
 * alert for a person (OD-A11): the money is the guest's either way.
 */
export const BOOKING_STATUSES = ['pending', 'paid', 'redeemed', 'expired', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Where a booking was made. `web` is the booking site; the others are for later tickets. */
export const BOOKING_CHANNELS = ['web', 'counter', 'import'] as const;
export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

export const booking = pos.table(
  'booking',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id),
    branchId: uuid('branch_id').notNull().references(() => branch.id),
    memberId: uuid('member_id').references(() => member.id),
    reference: text('reference').notNull(),
    /** The visit date the family chose. */
    bookingDate: date('booking_date').notNull(),
    status: text('status').notNull().default('pending'),
    totalSatang: bigint('total_satang', { mode: 'number' }).notNull().default(0),
    payload: jsonb('payload'),

    // --- S2-12 (SCRUM-209): checkout -----------------------------------------
    channel: text('channel').notNull().default('web'),
    /** The package, when the booking is for one; null when its lines name several. */
    packageId: uuid('package_id').references((): AnyPgColumn => ticketPackage.id, {
      onDelete: 'restrict',
    }),
    /** Head counts across the lines: what redemption issues bands for. */
    kidsCount: integer('kids_count').notNull().default(0),
    adultsCount: integer('adults_count').notNull().default(0),
    /**
     * The one gateway attempt this booking is paid through — station-less, on
     * the `WEB` invoice segment. Null before checkout, and on the rows the
     * prototype's simulated flow wrote as paid with no payment at all.
     */
    paymentAttemptId: uuid('payment_attempt_id').references((): AnyPgColumn => paymentAttempt.id, {
      onDelete: 'restrict',
    }),
    /** When the gateway's word (notification + inquiry, or the poller) made it paid. */
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    /** The end of the hold for an unpaid booking; the pending sweeper expires it after this. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    /**
     * The trading day the booking is FOR — the visit date. The money itself is
     * on the payment attempt's own business date, the day it was paid (OD-A10).
     */
    businessDate: date('business_date'),
    /** What the server priced, frozen: rate mode and why, tier, lines, socks, tax, total. */
    pricingSnapshot: jsonb('pricing_snapshot'),
    /** A fingerprint of the key the QR was signed with (`bookingQrKeyId`), never the key. */
    qrKeyId: text('qr_key_id'),
    /** The QR's signature (`mintBookingQr`), written when the booking is paid. */
    qrSignature: text('qr_signature'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('booking_branch_idx').on(t.branchId),
    index('booking_member_idx').on(t.memberId),
    index('booking_operator_idx').on(t.operatorId),
    index('booking_date_idx').on(t.bookingDate),
    uniqueIndex('booking_reference_unique').on(t.operatorId, t.reference),
    index('booking_package_idx').on(t.packageId),
    index('booking_payment_attempt_idx').on(t.paymentAttemptId),
    /** The pending sweeper's question: which unpaid holds have run out. */
    index('booking_status_expires_idx').on(t.status, t.expiresAt),
    index('booking_business_date_idx').on(t.businessDate),
    check(
      'booking_status_check',
      sql`${t.status} in ('pending','paid','redeemed','expired','cancelled')`,
    ),
    check('booking_channel_check', sql`${t.channel} in ('web','counter','import')`),
    check('booking_counts_check', sql`${t.kidsCount} >= 0 and ${t.adultsCount} >= 0`),
    /** A signature and the key that made it travel together. */
    check(
      'booking_qr_check',
      sql`(${t.qrSignature} is null) = (${t.qrKeyId} is null)`,
    ),
  ],
);

/**
 * A booking claimed at a counter, once — SCRUM-304.
 *
 * Until this table the whole of a redemption lived in `booking.payload`:
 * `{ redeemedAt, branchId, stationId, accountId, bandCodes }` written into the
 * jsonb beside the lines and the customer's phone. It worked, and
 * `services/bookings.ts` said at the time what it cost. Three things, and the
 * first is the one that matters:
 *
 *   - **nothing constrained it.** Who let a family through the gate was two ids
 *     inside a blob with no foreign key behind them, so a station id that names
 *     no station, or one that names a till at the other park, was a write the
 *     database would accept. The record of who was let in on a payment taken
 *     elsewhere is exactly the record that has to be answerable years later;
 *   - **nothing made it once.** `booking.status` carried "already redeemed" and
 *     the jsonb carried the details, so the guarantee rested entirely on the
 *     service taking the row `FOR UPDATE`. `booking_redemption_booking_unique`
 *     is that guarantee in the database, under a write that does not come
 *     through the service;
 *   - **nothing could report on it.** "How many bookings did Central redeem in
 *     October, and on which till" meant reading jsonb.
 *
 * Append-only: a redemption happened or it did not, so there is a `created_at`
 * and no `updated_at`, the shape `core.audit_log` and the sync ledger use. No
 * `archived_at` for the same reason — nothing here is ever taken back, and a
 * booking wrongly redeemed is a business correction with its own record, not a
 * row somebody hides.
 *
 * `redeemed_at` is separate from `created_at` deliberately: a redemption minted
 * on a box with no internet happened at the counter's clock and is written here
 * when the box reaches us, which are two different instants (the box-side
 * offline claim is S2-12). Today they are the same.
 *
 * IDs, not names. A till renamed, a member of staff who leaves and is archived,
 * a branch re-titled — none of that may change what this row says happened. The
 * names are resolved when it is read (`services/bookings.ts`).
 */
export const bookingRedemption = pos.table(
  'booking_redemption',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id, { onDelete: 'restrict' }),
    /** Where it was claimed — the booking's own branch today, and its own column for the day a park redeems another's. */
    branchId: uuid('branch_id').notNull().references(() => branch.id, { onDelete: 'restrict' }),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => booking.id, { onDelete: 'restrict' }),
    /** Null where the till was not seated at a station; never a station at another park. */
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').references(() => account.id, { onDelete: 'restrict' }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The bands handed over, where the surface minting them could not ask first. */
    bandCodes: jsonb('band_codes').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    /** One claim per booking. The row lock makes it once; this makes it true. */
    uniqueIndex('booking_redemption_booking_unique').on(t.bookingId),
    index('booking_redemption_operator_idx').on(t.operatorId),
    /** "What did this park redeem, and when" — the report the jsonb could not answer. */
    index('booking_redemption_branch_idx').on(t.branchId, t.redeemedAt),
    index('booking_redemption_station_idx').on(t.stationId),
    index('booking_redemption_account_idx').on(t.accountId),
  ],
);

export const attendee = pos.table(
  'attendee',
  {
    id: idPk(),
    bookingId: uuid('booking_id').references(() => booking.id),
    name: text('name').notNull(),
    ageYears: integer('age_years'),
    kind: text('kind').notNull().default('child'),
    payload: jsonb('payload'),
    ...timestamps,
  },
  (t) => [index('attendee_booking_idx').on(t.bookingId)],
);

export const wallet = pos.table(
  'wallet',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id),
    memberId: uuid('member_id').references(() => member.id),
    balanceSatang: bigint('balance_satang', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (t) => [index('wallet_member_idx').on(t.memberId), index('wallet_operator_idx').on(t.operatorId)],
);

/** Wallet ledger. No CASCADE, for the reason given on `sale_line`. */
export const walletEntry = pos.table(
  'wallet_entry',
  {
    id: idPk(),
    walletId: uuid('wallet_id').notNull().references(() => wallet.id),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('wallet_entry_wallet_idx').on(t.walletId)],
);

/** A stocked thing (Sprint 1 `item`) — renamed away from the bare word. */
export const stockItem = pos.table(
  'stock_item',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id),
    name: text('name').notNull(),
    sku: text('sku'),
    payload: jsonb('payload'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [index('stock_item_operator_idx').on(t.operatorId)],
);

export const stockLocation = pos.table(
  'stock_location',
  {
    id: idPk(),
    branchId: uuid('branch_id').notNull().references(() => branch.id),
    name: text('name').notNull(),
    ...timestamps,
  },
  (t) => [index('stock_location_branch_idx').on(t.branchId)],
);

export const stockLevel = pos.table(
  'stock_level',
  {
    id: idPk(),
    stockLocationId: uuid('stock_location_id').notNull().references(() => stockLocation.id),
    stockItemId: uuid('stock_item_id').notNull().references(() => stockItem.id),
    quantity: integer('quantity').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('stock_level_location_idx').on(t.stockLocationId),
    index('stock_level_item_idx').on(t.stockItemId),
  ],
);
