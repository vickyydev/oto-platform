import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { station } from './fleet';
import { member } from './members';

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

export const booking = pos.table(
  'booking',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id),
    branchId: uuid('branch_id').notNull().references(() => branch.id),
    memberId: uuid('member_id').references(() => member.id),
    reference: text('reference').notNull(),
    bookingDate: date('booking_date').notNull(),
    status: text('status').notNull().default('pending'),
    totalSatang: bigint('total_satang', { mode: 'number' }).notNull().default(0),
    payload: jsonb('payload'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    index('booking_branch_idx').on(t.branchId),
    index('booking_member_idx').on(t.memberId),
    index('booking_operator_idx').on(t.operatorId),
    index('booking_date_idx').on(t.bookingDate),
    uniqueIndex('booking_reference_unique').on(t.operatorId, t.reference),
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
