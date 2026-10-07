import { sql } from 'drizzle-orm';
import { bigint, check, date, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { box, station } from './fleet';
import { paymentAttempt } from './sales';

// --- The party tab: what the POS keeps of a party (schema `pos`) -------------
//
// S2-20 E4 (SCRUM-217; plan docs/progress/plans/events-kiosk/PLAN.md §8 and the
// E4 row of §9). The OTO App owns the party — its booking, its bill, its
// deposit (conflict C10). What the prototype keeps on the POS side
// (`PartyBooking.partyExtraCharges`, `.partyPayments`, the `updateParty` stamp)
// lives here, keyed by the OTO App's event id with no foreign key into the
// app's tables:
//
//   party_charge   extra tickets or F&B charged to the tab — a ledger entry,
//                  never a sale (Q3): no kitchen ticket, no stock, no bands;
//   party_payment  money taken against the balance. The money itself is a
//                  `pos.payment_attempt` (no sale behind it), so the amount,
//                  the tender, the trading day and when it was paid are the
//                  ledger's and are not copied here; this row says which party
//                  it was for, and that party's day when it was taken;
//   party_edit     an edit made at a till, and whether the OTO App has taken
//                  it yet (`sync_state`), written back through the app's
//                  directory API under the edit's own id.
//
// No tab row of its own: the bill's base and deposit are the OTO App's (read
// through its views each time, never copied), the row lock a payment's cap
// needs is a transaction lock on the party, and the edit stamp is the newest
// edit.

/** `PartyExtraCharge.kind` — extra play tickets, or F&B. */
export const PARTY_CHARGE_KIND_VALUES = ['ticket', 'fnb'] as const;
export type PartyChargeKindValue = (typeof PARTY_CHARGE_KIND_VALUES)[number];

/** Whether the OTO App has taken a till's edit (`event_attendee_link.sync_state`'s words). */
export const PARTY_EDIT_SYNC_STATES = ['synced', 'pending', 'failed'] as const;
export type PartyEditSyncState = (typeof PARTY_EDIT_SYNC_STATES)[number];

/**
 * A CHARGE ON A PARTY'S TAB (`addPartyExtraCharge`, mockApi.ts:3906). `id` is
 * the charge id the till minted, so a retry is the same charge. `items` is the
 * till's descriptive breakdown; `total_satang` is what is owed, after any
 * discount, never negative.
 */
export const partyCharge = pos.table(
  'party_charge',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The OTO App's party. No foreign key: the app's tables are its own (C10). */
    otoappEventId: uuid('otoapp_event_id').notNull(),
    kind: text('kind').$type<PartyChargeKindValue>().notNull(),
    /** `[{ name, qty, lineTotalSatang }]`, as the till listed them. */
    items: jsonb('items').notNull(),
    totalSatang: bigint('total_satang', { mode: 'number' }).notNull(),
    /** Who charged it. */
    accountId: uuid('account_id').references(() => account.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    /** `x-oto-action-id` of the press — the audit row's too. */
    actionId: text('action_id'),
    chargedAt: timestamp('charged_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [
    index('party_charge_operator_idx').on(t.operatorId),
    index('party_charge_branch_idx').on(t.branchId, t.chargedAt),
    /** A party's bill reads its charges. */
    index('party_charge_event_idx').on(t.otoappEventId, t.chargedAt),
    index('party_charge_account_idx').on(t.accountId),
    index('party_charge_station_idx').on(t.stationId),
    index('party_charge_box_idx').on(t.boxId),
    check('party_charge_kind_check', sql`${t.kind} in ('ticket','fnb')`),
    check('party_charge_total_check', sql`${t.totalSatang} >= 0`),
    check('party_charge_items_check', sql`jsonb_typeof(${t.items}) = 'array'`),
  ],
);

/**
 * MONEY TAKEN AGAINST A PARTY'S BALANCE (`addPartyPayment`, mockApi.ts:3938).
 * `id` is the payment id the till minted, so a retry is the same payment. The
 * money is the attempt's — one attempt per payment, and an attempt belongs to
 * at most one payment. `party_date` is the party's day when the money was
 * taken: End of Day counts a payment on the `party_prepay` line when its
 * trading day is that day (the prototype's rule, Q3's default).
 */
export const partyPayment = pos.table(
  'party_payment',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The OTO App's party. No foreign key: the app's tables are its own (C10). */
    otoappEventId: uuid('otoapp_event_id').notNull(),
    /** The tender: a real `pos.payment_attempt`, with no sale behind it. */
    paymentAttemptId: uuid('payment_attempt_id')
      .notNull()
      .references(() => paymentAttempt.id, { onDelete: 'restrict' }),
    partyDate: date('party_date', { mode: 'string' }).notNull(),
    /** Who took it. */
    accountId: uuid('account_id').references(() => account.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    actionId: text('action_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('party_payment_attempt_unique').on(t.paymentAttemptId),
    index('party_payment_operator_idx').on(t.operatorId),
    /** End of Day: a branch-day's party payments. */
    index('party_payment_branch_day_idx').on(t.branchId, t.partyDate),
    /** A party's bill reads its payments. */
    index('party_payment_event_idx').on(t.otoappEventId),
    index('party_payment_account_idx').on(t.accountId),
    index('party_payment_station_idx').on(t.stationId),
    index('party_payment_box_idx').on(t.boxId),
  ],
);

/**
 * AN EDIT A TILL MADE TO A PARTY (`updateParty`, mockApi.ts:3874), and its
 * write-back to the OTO App. `fields` holds only what the edit changed, as the
 * platform names it (`PartyEditFields`); the protected fields are never in it.
 * `id` is the edit id the till minted and the id the directory call carries.
 */
export const partyEdit = pos.table(
  'party_edit',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The OTO App's party. No foreign key: the app's tables are its own (C10). */
    otoappEventId: uuid('otoapp_event_id').notNull(),
    fields: jsonb('fields').notNull(),
    syncState: text('sync_state').$type<PartyEditSyncState>().notNull().default('pending'),
    /** Directory calls that carried this edit, the first included. */
    syncAttempts: integer('sync_attempts').notNull().default(0),
    /** The last refusal or fault, as `CODE: message`, short and scrubbed. Null once synced. */
    syncError: text('sync_error'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'date' }),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    /** Who edited. */
    accountId: uuid('account_id').references(() => account.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    actionId: text('action_id'),
    ...timestamps,
  },
  (t) => [
    index('party_edit_operator_idx').on(t.operatorId),
    index('party_edit_branch_idx').on(t.branchId, t.createdAt),
    /** A party's edits, oldest first: the stamp, and what the till changed that the app has not taken yet. */
    index('party_edit_event_idx').on(t.otoappEventId, t.createdAt),
    index('party_edit_account_idx').on(t.accountId),
    index('party_edit_station_idx').on(t.stationId),
    index('party_edit_box_idx').on(t.boxId),
    /** What still owes the OTO App a write. */
    index('party_edit_unsynced_idx')
      .on(t.syncState, t.createdAt)
      .where(sql`sync_state <> 'synced'`),
    check('party_edit_sync_check', sql`${t.syncState} in ('synced','pending','failed')`),
    check('party_edit_fields_check', sql`jsonb_typeof(${t.fields}) = 'object'`),
    /** Synced means the app answered. */
    check('party_edit_synced_check', sql`${t.syncState} <> 'synced' or ${t.syncedAt} is not null`),
  ],
);
