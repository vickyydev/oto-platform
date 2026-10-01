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
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  WalletEntryKind,
  WalletEntrySource,
  WalletExpiryPolicy,
  WalletKeyKind,
  WalletPrepaidUnusedPolicy,
  WalletStatus,
} from '@oto/shared';
import { analytics, idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { box, station } from './fleet';
import { member } from './members';
import { paymentAttempt, refund, sale } from './sales';

// --- Stored value (schema `pos`) — S2-14a round 1 (migration 0045) ----------
//
// The plan is docs/progress/plans/wallet/PLAN.md §2.1. The Sprint 1
// placeholders `pos.wallet` / `pos.wallet_entry` (until now in `future.ts`)
// were empty everywhere and are reshaped in place, forward-only.
//
// THE LEDGER IS THE TRUTH. The prototype kept a wallet's balance as a number
// on the wristband and a ledger beside it that nothing reconciled
// (`mockApi.ts:376-394`, `initWalletLedger`); here every movement is a
// `wallet_entry`, and `wallet.balance_satang` is a projection of them that is
// only ever written in the same transaction as its entry, under
// `SELECT … FOR UPDATE` on the wallet row (`services/wallet.ts`). The tests
// assert balance == sum(entries) after every flow.
//
// ONE WALLET, SEVERAL KEYS. The prototype resolved a band code and its
// `QR-<id>` voucher to the same record (`mockApi.ts:325-333`); here each is a
// `wallet_key` row, unique per operator on (kind, value), so a lookup is
// key → wallet and two keys can never name two wallets.

/** A stored-value account: one person's ticket credit, or a child's prepaid food. */
export const wallet = pos.table(
  'wallet',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /**
     * The park that issued it. A credit voucher is spendable at the park it was
     * printed at; the branch's `wallet_policy` decides when it expires. Null
     * only on a row no flow writes (the placeholder had none).
     */
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    /** A backlink when the sale named a member. A walk-in wallet is anonymous (OD-W5). */
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'restrict' }),
    /** Printed on the voucher: "Walk-in guest", "Booking child", a child's name. */
    holderName: text('holder_name'),
    /**
     * THE GUARDED PROJECTION of `wallet_entry.amount_satang`, never written on
     * its own: only in the transaction that writes the entry, under a row lock.
     */
    balanceSatang: bigint('balance_satang', { mode: 'number' }).notNull().default(0),
    status: text('status').$type<WalletStatus>().notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    index('wallet_member_idx').on(t.memberId),
    index('wallet_operator_idx').on(t.operatorId),
    index('wallet_branch_idx').on(t.branchId),
    check('wallet_status_check', sql`${t.status} in ('active','expired')`),
    check('wallet_balance_check', sql`${t.balanceSatang} >= 0`),
  ],
);

/**
 * How a wallet is found: the band on a wrist, the voucher's QR, the child's
 * record (a child's prepaid food, one wallet per child), a verified member's
 * phone. `value` is the band's normalised code, the `QR-…` string, the child
 * id or the E.164 phone.
 */
export const walletKey = pos.table(
  'wallet_key',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallet.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<WalletKeyKind>().notNull(),
    value: text('value').notNull(),
    ...timestamps,
  },
  (t) => [
    /** One wallet per key, per operator — the lookup and the double-spend defence's first half. */
    uniqueIndex('wallet_key_value_unique').on(t.operatorId, t.kind, t.value),
    index('wallet_key_wallet_idx').on(t.walletId),
    check('wallet_key_kind_check', sql`${t.kind} in ('band','voucher_qr','child','phone')`),
    check('wallet_key_value_check', sql`length(${t.value}) between 1 and 200`),
  ],
);

/**
 * The wallet ledger. No CASCADE, for the reason given on `sale_line`.
 *
 * `action_id` is unique per operator: it is the idempotency key AND the
 * concurrency key — a grant is keyed by its sale and person, a spend by its
 * payment attempt, a refund by its refund — so a replay finds the entry it
 * already wrote and two racing writers get one row.
 *
 * `amount_satang` is signed: a grant, a refund back to the wallet and a
 * reactivation add; a spend and an expiry take away. `balance_after` is the
 * wallet's balance once this entry landed, so a ledger reads as a statement.
 */
export const walletEntry = pos.table(
  'wallet_entry',
  {
    id: idPk(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallet.id, { onDelete: 'restrict' }),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    actionId: text('action_id').notNull(),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    kind: text('kind').$type<WalletEntryKind>().notNull(),
    source: text('source').$type<WalletEntrySource>().notNull(),
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    refundId: uuid('refund_id').references(() => refund.id, { onDelete: 'restrict' }),
    paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempt.id, {
      onDelete: 'restrict',
    }),
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    /** Written by a box with no internet and synced later (round 4). */
    offline: boolean('offline').notNull().default(false),
    /** The trading day this movement belongs to at its branch (`businessDate` in @oto/shared). */
    businessDate: date('business_date', { mode: 'string' }),
    actorAccountId: uuid('actor_account_id').references(() => account.id, { onDelete: 'restrict' }),
    /** On a grant: when its credit stops being spendable, by the branch's `wallet_policy`. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    /** Facts of the entry with no column: which person on the sale, the stay a load was for. */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_entry_action_unique').on(t.operatorId, t.actionId),
    index('wallet_entry_wallet_idx').on(t.walletId, t.createdAt),
    index('wallet_entry_sale_idx').on(t.saleId),
    index('wallet_entry_refund_idx').on(t.refundId),
    index('wallet_entry_attempt_idx').on(t.paymentAttemptId),
    index('wallet_entry_branch_date_idx').on(t.branchId, t.businessDate),
    index('wallet_entry_station_idx').on(t.stationId),
    index('wallet_entry_box_idx').on(t.boxId),
    index('wallet_entry_actor_idx').on(t.actorAccountId),
    check('wallet_entry_kind_check', sql`${t.kind} in ('grant','spend','refund','expire','reactivate')`),
    check(
      'wallet_entry_source_check',
      sql`${t.source} in ('ticket_sale','prepaid_food','fnb_order','merch_order','refund','expiry','reactivation')`,
    ),
    check(
      'wallet_entry_sign_check',
      sql`(${t.kind} in ('grant','refund','reactivate') and ${t.amountSatang} > 0) or (${t.kind} in ('spend','expire') and ${t.amountSatang} < 0)`,
    ),
    check('wallet_entry_balance_after_check', sql`${t.balanceAfter} >= 0`),
    check('wallet_entry_action_check', sql`length(${t.actionId}) between 1 and 200`),
  ],
);

/**
 * THE BRANCH'S WALLET RULES, changeable without a deploy (OD-W1 = OD-14):
 * when credit expires (seeded `same_day`), how much a wallet may spend per day
 * on a box with no internet (seeded ฿300), and what happens to a child's
 * unused prepaid food at pickup (seeded `refund`, the landed drop-off seed).
 */
export const walletPolicy = pos.table(
  'wallet_policy',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    expiry: text('expiry').$type<WalletExpiryPolicy>().notNull().default('same_day'),
    /** Only for `days_n`: how many business days a grant stays spendable. */
    expiryDays: integer('expiry_days'),
    offlineCapSatang: bigint('offline_cap_satang', { mode: 'number' }).notNull().default(30000),
    prepaidUnused: text('prepaid_unused').$type<WalletPrepaidUnusedPolicy>().notNull().default('refund'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('wallet_policy_branch_unique').on(t.branchId),
    index('wallet_policy_operator_idx').on(t.operatorId),
    check('wallet_policy_expiry_check', sql`${t.expiry} in ('same_day','days_n','never')`),
    check(
      'wallet_policy_days_check',
      sql`(${t.expiry} = 'days_n' and ${t.expiryDays} is not null and ${t.expiryDays} >= 1) or (${t.expiry} <> 'days_n' and ${t.expiryDays} is null)`,
    ),
    check('wallet_policy_cap_check', sql`${t.offlineCapSatang} >= 0`),
    check('wallet_policy_prepaid_check', sql`${t.prepaidUnused} in ('refund','forfeit')`),
  ],
);

/**
 * THE OFFICE'S VIEW OF STORED VALUE, one row per branch per trading day:
 * what was granted, spent, refunded back, expired and reactivated, and what
 * was outstanding at the end of it. Written by the round-3 job; idempotent on
 * (branch, date) like `fact_occupancy_15min`.
 */
export const factWalletLiabilityDaily = analytics.table(
  'fact_wallet_liability_daily',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    grantedSatang: bigint('granted_satang', { mode: 'number' }).notNull().default(0),
    spentSatang: bigint('spent_satang', { mode: 'number' }).notNull().default(0),
    refundedSatang: bigint('refunded_satang', { mode: 'number' }).notNull().default(0),
    expiredSatang: bigint('expired_satang', { mode: 'number' }).notNull().default(0),
    reactivatedSatang: bigint('reactivated_satang', { mode: 'number' }).notNull().default(0),
    outstandingSatang: bigint('outstanding_satang', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fact_wallet_liability_daily_branch_date_unique').on(t.branchId, t.businessDate),
    index('fact_wallet_liability_daily_operator_idx').on(t.operatorId),
    check(
      'fact_wallet_liability_daily_amounts_check',
      sql`${t.grantedSatang} >= 0 and ${t.spentSatang} >= 0 and ${t.refundedSatang} >= 0 and ${t.expiredSatang} >= 0 and ${t.reactivatedSatang} >= 0 and ${t.outstandingSatang} >= 0`,
    ),
  ],
);

/** Payload carried on a ticket-sale grant entry: which person on the sale it was. */
export interface WalletGrantEntryPayload {
  cartLineId: string;
  role: 'adult' | 'kid';
  /** This person's place among the line's adults (paid first) or its kids — pairs the wallet to its band. */
  ordinal: number;
  /** The person's place among the sale's earning persons, adults then kids per line. */
  personIndex: number;
  gateAccess: boolean;
  /** The list price the credit was computed from (OD-W2). */
  listUnitSatang: number;
}
