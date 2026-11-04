import { sql } from 'drizzle-orm';
import { bigint, check, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { station } from './fleet';
import { sale } from './sales';

/**
 * What a sale was parked as (SCRUM-774): `held` took no money; `part_paid` was
 * parked after a part payment, with the paid amount and the balance on it.
 */
export const SALE_HOLD_KINDS = ['held', 'part_paid'] as const;
export type SaleHoldKind = (typeof SALE_HOLD_KINDS)[number];

/**
 * How a hold ended: taken back to a till (`resumed`), closed by its payment
 * (`paid`), voided from the list or at a till (`voided`), voided by the
 * midnight job (`not_collected`), or refunded whole (`refunded`).
 */
export const SALE_HOLD_RELEASES = ['resumed', 'paid', 'voided', 'not_collected', 'refunded'] as const;
export type SaleHoldRelease = (typeof SALE_HOLD_RELEASES)[number];

/**
 * A SALE PARKED IN THE BRANCH'S HELD SALES LIST (SCRUM-774).
 *
 * The sale itself stays what it was — `tendering`, on the ledger, with
 * whatever money was taken on it — and nothing is issued for it: bands, the
 * receipt, check-in and wallet credit all wait for the call that brings the
 * balance to zero, exactly as for any open sale. This row is the parking
 * ticket: who parked it, under which name or band, with which note, from
 * which till, and how it ended. One sale has at most one hold open at a time
 * (`sale_hold_open_unique`); a sale resumed and parked again gets a new row,
 * so the history of where it waited is kept.
 *
 * `paid_satang` and `balance_satang` are as they stood when it was parked —
 * the list reads the money live from the sale's attempts; these say what the
 * person parking it saw. `flagged_at` is set by the midnight job on a
 * part-paid sale it does not void, so the manager can see it was flagged.
 */
export const saleHold = pos.table(
  'sale_hold',
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
    kind: text('kind').$type<SaleHoldKind>().notNull(),
    /** The customer's name or band the sale is parked under — what the list is read by. */
    label: text('label').notNull(),
    note: text('note'),
    paidSatang: bigint('paid_satang', { mode: 'number' }).notNull().default(0),
    balanceSatang: bigint('balance_satang', { mode: 'number' }).notNull(),
    heldByAccountId: uuid('held_by_account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    heldStationId: uuid('held_station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    heldAt: timestamp('held_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** `x-oto-action-id` of the press that parked it: a retry finds this row. */
    actionId: text('action_id'),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    /** Null when the platform ended it on its own (the midnight job, a payment arriving). */
    releasedByAccountId: uuid('released_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    releasedReason: text('released_reason').$type<SaleHoldRelease>(),
    /** The till that took it back, when it was resumed. */
    resumedStationId: uuid('resumed_station_id').references(() => station.id, {
      onDelete: 'restrict',
    }),
    /** `x-oto-action-id` of the resume press, so its retry answers the same. */
    resumeActionId: text('resume_action_id'),
    /** Set by the midnight job on a part-paid sale it leaves for the manager. */
    flaggedAt: timestamp('flagged_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    /** One open hold per sale: the list shows a sale once. */
    uniqueIndex('sale_hold_open_unique').on(t.saleId).where(sql`released_at is null`),
    uniqueIndex('sale_hold_action_unique')
      .on(t.operatorId, t.actionId)
      .where(sql`action_id is not null`),
    /** The branch's Held sales list, oldest first. */
    index('sale_hold_branch_open_idx').on(t.branchId, t.heldAt).where(sql`released_at is null`),
    index('sale_hold_operator_idx').on(t.operatorId),
    index('sale_hold_branch_idx').on(t.branchId),
    index('sale_hold_sale_idx').on(t.saleId),
    index('sale_hold_held_by_idx').on(t.heldByAccountId),
    index('sale_hold_held_station_idx').on(t.heldStationId),
    index('sale_hold_released_by_idx').on(t.releasedByAccountId),
    index('sale_hold_resumed_station_idx').on(t.resumedStationId),
    check('sale_hold_kind_check', sql`${t.kind} in ('held','part_paid')`),
    check(
      'sale_hold_released_check',
      sql`(${t.releasedAt} is null) = (${t.releasedReason} is null)
          and (${t.releasedReason} is null or ${t.releasedReason} in ('resumed','paid','voided','not_collected','refunded'))`,
    ),
    check(
      'sale_hold_money_check',
      sql`${t.paidSatang} >= 0 and ${t.balanceSatang} > 0
          and ((${t.kind} = 'held' and ${t.paidSatang} = 0) or (${t.kind} = 'part_paid' and ${t.paidSatang} > 0))`,
    ),
    check('sale_hold_label_check', sql`length(btrim(${t.label})) between 1 and 80`),
  ],
);
