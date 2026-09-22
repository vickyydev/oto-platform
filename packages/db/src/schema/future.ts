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
import { branch, operator } from './tenancy';
import { member } from './members';

// --- Sales and money (schema `pos`) ----------------------------------------
// Created in Sprint 1 so the data model accommodated M2–M4; the tickets that
// own them extend the columns. S2-01b renamed them to the names the rest of
// the sprint uses — `sale`, `sale_line`, `payment_attempt`, `band`,
// `stock_item` — while they are still empty, which is the only cheap moment
// to do it.
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

/** The wristband a visitor wears (Sprint 1 `wristband`). */
export const band = pos.table(
  'band',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id),
    branchId: uuid('branch_id').references(() => branch.id),
    code: text('code').notNull(),
    kind: text('kind').notNull().default('kid'),
    status: text('status').notNull().default('inactive'),
    payload: jsonb('payload'),
    ...timestamps,
  },
  (t) => [
    index('band_branch_idx').on(t.branchId),
    index('band_code_idx').on(t.code),
    index('band_operator_idx').on(t.operatorId),
  ],
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
