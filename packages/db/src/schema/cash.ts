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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { analytics, idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { device, station } from './fleet';
import { paymentAttempt, refund } from './sales';

/**
 * S2-15a — cash sessions and the End of Day (plan
 * docs/progress/plans/cash/PLAN.md §2.1). Migration 0052 lands every table at
 * once; round 1 writes `cash_session` and `cash_movement` (and stamps
 * `pos.refund.business_date`), round 2 the End of Day and its lines and
 * corrections, round 3 the settlement batches and lines, and the daily fact.
 *
 * MONEY IS SATANG, ALWAYS POSITIVE ON A MOVEMENT. The kind says which way it
 * went, so a sum never depends on somebody remembering a sign.
 */

export const CASH_SESSION_STATUSES = ['open', 'closed'] as const;
export type CashSessionStatus = (typeof CASH_SESSION_STATUSES)[number];

export const CASH_MOVEMENT_KINDS = ['float', 'paid_out', 'safe_drop', 'top_up', 'refund_out'] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

/**
 * ONE DRAWER, OPEN TO CLOSE (OD-CS1): a session per station drawer, with its
 * own count and variance, held against whoever closed it.
 *
 * The opening float is the drawer's last close's float-left, else the
 * branch's default (`core.branch.cash_default_float_satang`, ฿6,000);
 * `float_source_session_id` names the close it was carried from, so the
 * screen's "carried from … close" is a fact rather than a guess.
 *
 * At close the figures are FROZEN on the row — expected, counted, variance,
 * the tolerance in force and the float left for tomorrow — so a later
 * correction is visible as a correction (round 2's `eod_correction`) and
 * never rewrites what the closer signed.
 */
export const cashSession = pos.table(
  'cash_session',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /** The trading day it opened on, from the branch's day start — never the UTC slice. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    status: text('status').$type<CashSessionStatus>().notNull().default('open'),
    openedByAccountId: uuid('opened_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    openingFloatSatang: bigint('opening_float_satang', { mode: 'number' }).notNull(),
    /** The close this float was carried from; null when it is the branch default. */
    floatSourceSessionId: uuid('float_source_session_id').references((): AnyPgColumn => cashSession.id, {
      onDelete: 'restrict',
    }),
    closedByAccountId: uuid('closed_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    countedSatang: bigint('counted_satang', { mode: 'number' }),
    expectedSatang: bigint('expected_satang', { mode: 'number' }),
    /** counted − expected: positive over, negative short. */
    varianceSatang: bigint('variance_satang', { mode: 'number' }),
    /** The branch tolerance in force at close (OD-CS3), frozen with the figures. */
    toleranceSatang: bigint('tolerance_satang', { mode: 'number' }),
    /** What stays in the drawer for the next session: the carry-over. */
    floatLeftSatang: bigint('float_left_satang', { mode: 'number' }),
    /** Required when the variance is outside the tolerance. */
    notes: text('notes'),
    /** The sign-off: who put their name to the count, and when. The closer, in round 1. */
    signedOffByAccountId: uuid('signed_off_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    signedOffAt: timestamp('signed_off_at', { withTimezone: true, mode: 'date' }),
    /** `x-oto-action-id` of the press that opened it, and of the one that closed it. */
    openActionId: text('open_action_id'),
    closeActionId: text('close_action_id'),
    ...timestamps,
  },
  (t) => [
    /** One open session per station drawer. Partial, so history is unlimited. */
    uniqueIndex('cash_session_one_open_per_station')
      .on(t.stationId)
      .where(sql`status = 'open'`),
    uniqueIndex('cash_session_open_action_unique')
      .on(t.operatorId, t.openActionId)
      .where(sql`open_action_id is not null`),
    uniqueIndex('cash_session_close_action_unique')
      .on(t.operatorId, t.closeActionId)
      .where(sql`close_action_id is not null`),
    index('cash_session_operator_idx').on(t.operatorId),
    index('cash_session_branch_date_idx').on(t.branchId, t.businessDate),
    index('cash_session_station_opened_idx').on(t.stationId, t.openedAt),
    index('cash_session_opened_by_idx').on(t.openedByAccountId),
    index('cash_session_closed_by_idx').on(t.closedByAccountId),
    index('cash_session_signed_off_by_idx').on(t.signedOffByAccountId),
    index('cash_session_float_source_idx').on(t.floatSourceSessionId),
    check('cash_session_status_check', sql`${t.status} in ('open','closed')`),
    check(
      'cash_session_amounts_check',
      sql`${t.openingFloatSatang} >= 0
          and (${t.countedSatang} is null or ${t.countedSatang} >= 0)
          and (${t.floatLeftSatang} is null or ${t.floatLeftSatang} >= 0)
          and (${t.toleranceSatang} is null or ${t.toleranceSatang} >= 0)`,
    ),
    /** A closed session carries its whole close; an open one carries none of it. */
    check(
      'cash_session_close_check',
      sql`(${t.status} = 'open'
             and ${t.closedAt} is null and ${t.closedByAccountId} is null and ${t.countedSatang} is null
             and ${t.expectedSatang} is null and ${t.varianceSatang} is null and ${t.signedOffAt} is null)
          or (${t.status} = 'closed'
             and ${t.closedAt} is not null and ${t.closedByAccountId} is not null
             and ${t.countedSatang} is not null and ${t.expectedSatang} is not null
             and ${t.varianceSatang} = ${t.countedSatang} - ${t.expectedSatang}
             and ${t.floatLeftSatang} is not null and ${t.floatLeftSatang} <= ${t.countedSatang}
             and ${t.toleranceSatang} is not null
             and ${t.signedOffByAccountId} is not null and ${t.signedOffAt} is not null)`,
    ),
    /** An out-of-tolerance close says why (the prototype closed with no note: not ported). */
    check(
      'cash_session_variance_note_check',
      sql`${t.status} = 'open' or abs(${t.varianceSatang}) <= ${t.toleranceSatang}
          or length(trim(coalesce(${t.notes}, ''))) > 0`,
    ),
  ],
);

/**
 * THE DRAWER'S LEDGER — append-only (a trigger refuses UPDATE and DELETE except
 * under the demo reset's `oto.cash_ledger_purge` flag), action-keyed.
 *
 *   float       the opening float, written once when the session opens;
 *   paid_out    money out for an expense — an approver, not the actor, with
 *               pos:cash:approve;
 *   safe_drop   money moved to the safe — a witness, not the actor;
 *   top_up      money put in mid-session;
 *   refund_out  a cash refund slice handed back from this drawer.
 *
 * Expected cash = float + cash takings − refund_out − paid_out − safe_drop + top_up.
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
    sessionId: uuid('session_id')
      .notNull()
      .references(() => cashSession.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<CashMovementKind>().notNull(),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    reason: text('reason'),
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    approverAccountId: uuid('approver_account_id').references(() => account.id, { onDelete: 'restrict' }),
    witnessAccountId: uuid('witness_account_id').references(() => account.id, { onDelete: 'restrict' }),
    /** The refund a `refund_out` hands back. */
    refundId: uuid('refund_id').references(() => refund.id, { onDelete: 'restrict' }),
    /** The day the money moved, at the branch. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    actionId: text('action_id').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('cash_movement_action_unique').on(t.operatorId, t.actionId),
    index('cash_movement_session_idx').on(t.sessionId, t.createdAt),
    index('cash_movement_branch_date_idx').on(t.branchId, t.businessDate),
    index('cash_movement_station_idx').on(t.stationId),
    index('cash_movement_actor_idx').on(t.actorAccountId),
    index('cash_movement_approver_idx').on(t.approverAccountId),
    index('cash_movement_witness_idx').on(t.witnessAccountId),
    index('cash_movement_refund_idx').on(t.refundId),
    check(
      'cash_movement_kind_check',
      sql`${t.kind} in ('float','paid_out','safe_drop','top_up','refund_out')`,
    ),
    check(
      'cash_movement_amount_check',
      sql`${t.amountSatang} > 0 or (${t.kind} = 'float' and ${t.amountSatang} = 0)`,
    ),
    check(
      'cash_movement_approver_check',
      sql`${t.kind} <> 'paid_out'
          or (${t.approverAccountId} is not null and ${t.approverAccountId} <> ${t.actorAccountId})`,
    ),
    check(
      'cash_movement_witness_check',
      sql`${t.kind} <> 'safe_drop'
          or (${t.witnessAccountId} is not null and ${t.witnessAccountId} <> ${t.actorAccountId})`,
    ),
    check('cash_movement_refund_check', sql`(${t.kind} = 'refund_out') = (${t.refundId} is not null)`),
    check(
      'cash_movement_reason_check',
      sql`${t.kind} not in ('paid_out','safe_drop','top_up') or length(trim(coalesce(${t.reason}, ''))) > 0`,
    ),
  ],
);

// --- Round 2: the branch End of Day ---------------------------------------------

export const END_OF_DAY_STATUSES = ['open', 'provisional', 'closed'] as const;
export type EndOfDayStatus = (typeof END_OF_DAY_STATUSES)[number];

/** One per branch and business date; closed by a manager (OD-CS2). */
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
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    status: text('status').$type<EndOfDayStatus>().notNull().default('open'),
    closedByAccountId: uuid('closed_by_account_id').references(() => account.id, { onDelete: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    totals: jsonb('totals').$type<Record<string, unknown>>().notNull().default({}),
    notes: text('notes'),
    /** The End of Day slip's number, on the closing counter's own series (R-47). */
    slipNumber: text('slip_number'),
    /** The lines as they stood at close. */
    snapshot: jsonb('snapshot'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('end_of_day_branch_date_unique').on(t.branchId, t.businessDate),
    index('end_of_day_operator_idx').on(t.operatorId),
    index('end_of_day_closed_by_idx').on(t.closedByAccountId),
    check('end_of_day_status_check', sql`${t.status} in ('open','provisional','closed')`),
    check(
      'end_of_day_closed_check',
      sql`(${t.status} = 'closed') = (${t.closedAt} is not null and ${t.closedByAccountId} is not null)`,
    ),
  ],
);

export const RECON_CHANNELS = [
  'cash',
  'card',
  'qr',
  'transfer',
  'wallet_credit',
  'paid_online',
  'booking_web',
  'other',
] as const;
export type ReconChannel = (typeof RECON_CHANNELS)[number];

export const RECON_LINE_STATUSES = ['pending', 'ok', 'off'] as const;
export type ReconLineStatus = (typeof RECON_LINE_STATUSES)[number];

/**
 * One line of a day's reconciliation: cash per session, card per TID, qr,
 * transfer — and wallet_credit, paid_online and booking_web BESIDE the takings
 * (OD-CS6), never counted against a drawer.
 */
export const reconLine = pos.table(
  'recon_line',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    endOfDayId: uuid('end_of_day_id')
      .notNull()
      .references(() => endOfDay.id, { onDelete: 'restrict' }),
    channel: text('channel').$type<ReconChannel>().notNull(),
    /** The line's identity within its day: `cash:<sessionId>`, `card:<tid>`, `qr`, … */
    key: text('key').notNull(),
    cashSessionId: uuid('cash_session_id').references(() => cashSession.id, { onDelete: 'restrict' }),
    tid: text('tid'),
    methodCode: text('method_code'),
    besideTakings: boolean('beside_takings').notNull().default(false),
    expectedSatang: bigint('expected_satang', { mode: 'number' }).notNull().default(0),
    actualSatang: bigint('actual_satang', { mode: 'number' }),
    differenceSatang: bigint('difference_satang', { mode: 'number' }),
    status: text('status').$type<ReconLineStatus>().notNull().default('pending'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('recon_line_day_key_unique').on(t.endOfDayId, t.key),
    index('recon_line_operator_idx').on(t.operatorId),
    index('recon_line_branch_idx').on(t.branchId),
    index('recon_line_session_idx').on(t.cashSessionId),
    check(
      'recon_line_channel_check',
      sql`${t.channel} in ('cash','card','qr','transfer','wallet_credit','paid_online','booking_web','other')`,
    ),
    check('recon_line_status_check', sql`${t.status} in ('pending','ok','off')`),
    check(
      'recon_line_beside_check',
      sql`not ${t.besideTakings} or ${t.channel} in ('wallet_credit','paid_online','booking_web')`,
    ),
  ],
);

export const EOD_CORRECTION_KINDS = ['late_sync', 'gateway_settle', 'refund_fallback', 'other'] as const;
export type EodCorrectionKind = (typeof EOD_CORRECTION_KINDS)[number];

/**
 * A fact that arrived after its day closed (OD-CS5), recorded against that
 * day and acknowledged by a manager. A closed day's figures are never
 * rewritten; this row is how the change is seen.
 */
export const eodCorrection = pos.table(
  'eod_correction',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    endOfDayId: uuid('end_of_day_id')
      .notNull()
      .references(() => endOfDay.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    kind: text('kind').$type<EodCorrectionKind>().notNull(),
    channel: text('channel'),
    /** Signed: what the fact changes the day's figure by. */
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    sourceEntityType: text('source_entity_type'),
    sourceEntityId: uuid('source_entity_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    acknowledgedByAccountId: uuid('acknowledged_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    index('eod_correction_day_idx').on(t.endOfDayId),
    index('eod_correction_operator_idx').on(t.operatorId),
    index('eod_correction_branch_date_idx').on(t.branchId, t.businessDate),
    index('eod_correction_acknowledged_by_idx').on(t.acknowledgedByAccountId),
    check(
      'eod_correction_kind_check',
      sql`${t.kind} in ('late_sync','gateway_settle','refund_fallback','other')`,
    ),
    check(
      'eod_correction_ack_check',
      sql`(${t.acknowledgedAt} is null) = (${t.acknowledgedByAccountId} is null)`,
    ),
  ],
);

// --- Round 3: settlement ---------------------------------------------------------

export const SETTLEMENT_SOURCES = ['terminal', 'gateway_file'] as const;
export type SettlementSource = (typeof SETTLEMENT_SOURCES)[number];

/** One terminal's settle() for a day, or one imported gateway settlement file's batch. */
export const settlementBatch = pos.table(
  'settlement_batch',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id').references(() => device.id, { onDelete: 'restrict' }),
    source: text('source').$type<SettlementSource>().notNull(),
    tid: text('tid'),
    mid: text('mid'),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    batchNo: text('batch_no'),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    totalSatang: bigint('total_satang', { mode: 'number' }).notNull().default(0),
    lineCount: integer('line_count').notNull().default(0),
    /** The allow-listed answer or the file's header; never a card number. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    actionId: text('action_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('settlement_batch_action_unique')
      .on(t.operatorId, t.actionId)
      .where(sql`action_id is not null`),
    index('settlement_batch_operator_idx').on(t.operatorId),
    index('settlement_batch_branch_date_idx').on(t.branchId, t.businessDate),
    index('settlement_batch_device_idx').on(t.deviceId),
    check('settlement_batch_source_check', sql`${t.source} in ('terminal','gateway_file')`),
    check('settlement_batch_counts_check', sql`${t.lineCount} >= 0`),
  ],
);

export const SETTLEMENT_MATCH_STATUSES = ['matched', 'unmatched', 'missing'] as const;
export type SettlementMatchStatus = (typeof SETTLEMENT_MATCH_STATUSES)[number];

/** One line of a batch, matched to the attempt it settles (or flagged). */
export const settlementLine = pos.table(
  'settlement_line',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => settlementBatch.id, { onDelete: 'restrict' }),
    paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempt.id, { onDelete: 'restrict' }),
    invoiceNo: text('invoice_no'),
    tranRef: text('tran_ref'),
    approvalCode: text('approval_code'),
    rrn: text('rrn'),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    matchStatus: text('match_status').$type<SettlementMatchStatus>().notNull().default('unmatched'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index('settlement_line_batch_idx').on(t.batchId),
    index('settlement_line_operator_idx').on(t.operatorId),
    index('settlement_line_attempt_idx').on(t.paymentAttemptId),
    index('settlement_line_invoice_idx').on(t.invoiceNo),
    index('settlement_line_tran_ref_idx').on(t.tranRef),
    check('settlement_line_match_check', sql`${t.matchStatus} in ('matched','unmatched','missing')`),
  ],
);

/**
 * The day's money per branch, date and channel line, following the landed
 * daily-fact pattern (`fact_stock_daily`). Written by round 2's close and read
 * by S2-15b.
 */
export const factCashDaily = analytics.table(
  'fact_cash_daily',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    channel: text('channel').$type<ReconChannel>().notNull(),
    /** The recon line's key: `cash:<sessionId>`, `card:<tid>`, `qr`, … */
    key: text('key').notNull(),
    besideTakings: boolean('beside_takings').notNull().default(false),
    expectedSatang: bigint('expected_satang', { mode: 'number' }).notNull().default(0),
    actualSatang: bigint('actual_satang', { mode: 'number' }),
    differenceSatang: bigint('difference_satang', { mode: 'number' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fact_cash_daily_unique').on(t.branchId, t.businessDate, t.key),
    index('fact_cash_daily_operator_idx').on(t.operatorId),
    index('fact_cash_daily_branch_date_idx').on(t.branchId, t.businessDate),
    check(
      'fact_cash_daily_channel_check',
      sql`${t.channel} in ('cash','card','qr','transfer','wallet_credit','paid_online','booking_web','other')`,
    ),
  ],
);
