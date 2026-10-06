import { sql } from 'drizzle-orm';
import { bigint, check, date, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { CashMovementKind, EodLine } from '@oto/shared';
import { idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';

// --- The End of Day (schema `pos`) — S2-15a round 1 (migration 0052) ----------
//
// The plan is docs/progress/plans/cash/PLAN.md §6 (revised 2 Oct, the owner's
// ruling on SCRUM-488): ONE combined cash count for the whole branch per
// business day, as the prototype's Today > End of Day has it. No drawer
// sessions, no per-drawer counts, no correction rows.

/**
 * ONE CLOSED DAY of one branch — written only at Close Day, never before.
 *
 * An open day is worked out fresh from the records every time it is read
 * (`services/end-of-day.ts`); only a closed day is stored, and it is read back
 * exactly as it was saved (the prototype's `closedEndOfDays`, kept in memory
 * there and lost on reload). `lines` is the snapshot of every channel as it
 * stood at close — expected, actual and difference — so a sale or a refund
 * recorded later never rewrites a closed day. A trigger refuses any UPDATE,
 * and a DELETE except under the demo reset's purge flag.
 */
export const endOfDay = pos.table(
  'end_of_day',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The branch's business date the figures cover (`businessDate` in @oto/shared). */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    lines: jsonb('lines').$type<EodLine[]>().notNull(),
    /** The one combined count of every drawer at the branch. */
    countedSatang: bigint('counted_satang', { mode: 'number' }),
    /** The start-of-day float: the previous close's float left, or the standard float. */
    floatSatang: bigint('float_satang', { mode: 'number' }).notNull(),
    /** The close the float was carried from; null = the standard float. */
    floatFromDate: date('float_from_date', { mode: 'string' }),
    /** Cash left in the drawers for tomorrow; the next day's float. */
    floatLeftSatang: bigint('float_left_satang', { mode: 'number' }),
    vouchersHandedOut: integer('vouchers_handed_out'),
    vouchersRedeemed: integer('vouchers_redeemed'),
    notes: text('notes'),
    totalExpectedSatang: bigint('total_expected_satang', { mode: 'number' }).notNull(),
    totalActualSatang: bigint('total_actual_satang', { mode: 'number' }).notNull(),
    totalDifferenceSatang: bigint('total_difference_satang', { mode: 'number' }).notNull(),
    closedByAccountId: uuid('closed_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    /** One close per branch per day: a second Close Day is refused. */
    uniqueIndex('end_of_day_branch_date_unique').on(t.branchId, t.businessDate),
    index('end_of_day_operator_idx').on(t.operatorId),
    index('end_of_day_closed_by_idx').on(t.closedByAccountId),
    check(
      'end_of_day_amounts_check',
      sql`${t.floatSatang} >= 0
          and (${t.countedSatang} is null or ${t.countedSatang} >= 0)
          and (${t.floatLeftSatang} is null or ${t.floatLeftSatang} >= 0)`,
    ),
    check(
      'end_of_day_vouchers_check',
      sql`(${t.vouchersHandedOut} is null or ${t.vouchersHandedOut} >= 0)
          and (${t.vouchersRedeemed} is null or ${t.vouchersRedeemed} >= 0)`,
    ),
    check('end_of_day_lines_check', sql`jsonb_typeof(${t.lines}) = 'array'`),
  ],
);

/**
 * CASH TAKEN OUT OF THE BRANCH'S DRAWERS during a business day (SCRUM-215;
 * the prototype has none): a paid-out, which somebody else approves, or a
 * safe drop, which somebody else witnesses. Both reduce the cash the day's one
 * combined count expects.
 *
 * Append-only: a trigger refuses any UPDATE, and a DELETE except under the
 * demo reset's purge flag. A wrong entry is explained in the day's notes, not
 * rewritten. `action_id` is one press of Record, so a retry records once.
 */
export const cashMovement = pos.table(
  'cash_movement',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The branch's business day it was taken out on. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    kind: text('kind').$type<CashMovementKind>().notNull(),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    /** Who took the cash out — the account signed in at the till. */
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /** A paid-out's approver: holds `pos:cash:approve` at the branch, never the actor. */
    approverAccountId: uuid('approver_account_id').references(() => account.id, { onDelete: 'restrict' }),
    /** A safe drop's witness: staff of the branch, never the actor. */
    witnessAccountId: uuid('witness_account_id').references(() => account.id, { onDelete: 'restrict' }),
    actionId: text('action_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cash_movement_action_unique').on(t.operatorId, t.actionId),
    index('cash_movement_branch_date_idx').on(t.branchId, t.businessDate),
    index('cash_movement_operator_idx').on(t.operatorId),
    index('cash_movement_actor_idx').on(t.actorAccountId),
    index('cash_movement_approver_idx').on(t.approverAccountId),
    index('cash_movement_witness_idx').on(t.witnessAccountId),
    check('cash_movement_kind_check', sql`${t.kind} in ('paid_out','safe_drop')`),
    check('cash_movement_amount_check', sql`${t.amountSatang} > 0`),
    check('cash_movement_reason_check', sql`length(trim(${t.reason})) > 0`),
    check('cash_movement_action_check', sql`length(${t.actionId}) between 1 and 200`),
    /** The second person is the right one for the kind, and never the actor. */
    check(
      'cash_movement_second_person_check',
      sql`(${t.kind} = 'paid_out' and ${t.approverAccountId} is not null and ${t.witnessAccountId} is null
             and ${t.approverAccountId} <> ${t.actorAccountId})
          or (${t.kind} = 'safe_drop' and ${t.witnessAccountId} is not null and ${t.approverAccountId} is null
             and ${t.witnessAccountId} <> ${t.actorAccountId})`,
    ),
  ],
);
