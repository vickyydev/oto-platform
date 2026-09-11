import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, idPk, timestamps } from './helpers';
import { branch, operator, account } from './tenancy';
import { member } from './members';

// --- Present but unused until later sprints (CLAUDE.md §4) -----------------
// Created now so the Sprint 1 data model accommodates M2–M4; columns are the
// sensible minimum and WILL be extended by their owning tickets.

export const booking = pgTable(
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
  ],
);

export const attendee = pgTable(
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

export const transaction = pgTable(
  'transaction',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id),
    branchId: uuid('branch_id').notNull().references(() => branch.id),
    memberId: uuid('member_id').references(() => member.id),
    createdByAccountId: uuid('created_by_account_id').references(() => account.id),
    kind: text('kind').notNull().default('sale'),
    status: text('status').notNull().default('draft'),
    totalSatang: bigint('total_satang', { mode: 'number' }).notNull().default(0),
    payload: jsonb('payload'),
    ...timestamps,
  },
  (t) => [
    index('transaction_branch_idx').on(t.branchId),
    index('transaction_member_idx').on(t.memberId),
    index('transaction_operator_idx').on(t.operatorId),
    index('transaction_account_idx').on(t.createdByAccountId),
  ],
);

export const transactionLine = pgTable(
  'transaction_line',
  {
    id: idPk(),
    transactionId: uuid('transaction_id').notNull().references(() => transaction.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitSatang: bigint('unit_satang', { mode: 'number' }).notNull().default(0),
    totalSatang: bigint('total_satang', { mode: 'number' }).notNull().default(0),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('transaction_line_tx_idx').on(t.transactionId)],
);

export const payment = pgTable(
  'payment',
  {
    id: idPk(),
    transactionId: uuid('transaction_id').references(() => transaction.id),
    method: text('method').notNull(),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('recorded'),
    payload: jsonb('payload'),
    ...timestamps,
  },
  (t) => [index('payment_tx_idx').on(t.transactionId)],
);

export const wallet = pgTable(
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

export const walletEntry = pgTable(
  'wallet_entry',
  {
    id: idPk(),
    walletId: uuid('wallet_id').notNull().references(() => wallet.id, { onDelete: 'cascade' }),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('wallet_entry_wallet_idx').on(t.walletId)],
);

export const wristband = pgTable(
  'wristband',
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
  (t) => [index('wristband_branch_idx').on(t.branchId), index('wristband_code_idx').on(t.code), index('wristband_operator_idx').on(t.operatorId)],
);

export const item = pgTable(
  'item',
  {
    id: idPk(),
    operatorId: uuid('operator_id').notNull().references(() => operator.id),
    name: text('name').notNull(),
    sku: text('sku'),
    payload: jsonb('payload'),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [index('item_operator_idx').on(t.operatorId)],
);

export const stockLocation = pgTable(
  'stock_location',
  {
    id: idPk(),
    branchId: uuid('branch_id').notNull().references(() => branch.id),
    name: text('name').notNull(),
    ...timestamps,
  },
  (t) => [index('stock_location_branch_idx').on(t.branchId)],
);

export const stockLevel = pgTable(
  'stock_level',
  {
    id: idPk(),
    stockLocationId: uuid('stock_location_id').notNull().references(() => stockLocation.id),
    itemId: uuid('item_id').notNull().references(() => item.id),
    quantity: integer('quantity').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('stock_level_location_idx').on(t.stockLocationId), index('stock_level_item_idx').on(t.itemId)],
);
