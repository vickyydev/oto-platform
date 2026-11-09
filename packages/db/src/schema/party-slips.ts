import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';

// --- A party's kitchen and bar slips (schema `pos`) --------------------------
//
// SCRUM-805 (birthday plan §5; the owner's decision 3 of 2026-11-09). On the
// day of a party the kitchen and bar slips for its food and drinks print at the
// party's slip time (the BEO's, 11:00 when it says nothing), from the set menu
// and bar plan the OTO App publishes for it, to the kitchen and bar printers of
// the station the branch names (`core.branch.party_slips_station_id`). Until a
// park names one, nothing is queued and the slip is recorded "no printer".

/** The two prep stations a party prints a slip for, kitchen first. */
export const PARTY_SLIP_STATION_VALUES = ['kitchen', 'bar'] as const;
export type PartySlipStationValue = (typeof PARTY_SLIP_STATION_VALUES)[number];

/**
 * What became of one slip: queued to its printer (`printed`); not queued, no
 * station named for the park or no printer of its kind on that station
 * (`no_printer`); or nothing on the plan for that station (`nothing_to_print`).
 */
export const PARTY_SLIP_STATUS_VALUES = ['printed', 'no_printer', 'nothing_to_print'] as const;
export type PartySlipStatusValue = (typeof PARTY_SLIP_STATUS_VALUES)[number];

/** Who printed it: the job at the slip time, or staff pressing "Print party slips now". */
export const PARTY_SLIP_TRIGGER_VALUES = ['schedule', 'reprint'] as const;
export type PartySlipTriggerValue = (typeof PARTY_SLIP_TRIGGER_VALUES)[number];

/**
 * ONE SLIP OF ONE RUN for one party on one day. A run is one printing of the
 * party's slips — the job's at the slip time, or a press of "Print party slips
 * now" — and writes one row per station, so a reprint is a new run and new rows
 * and the first stays as it was.
 *
 * `document` is the slip as it was composed (the prep ticket's data, with the
 * party heading and the ready-by line) and is what the box prints for the job:
 * the OTO App may change the plan after the slip went to the kitchen, and the
 * record keeps what the kitchen was given. It carries the party's name, its
 * counts and its menu — no child's allergy and no parent's number. Null when
 * there was nothing to print.
 *
 * `print_job_id` names the job without a foreign key, for the reason
 * `print_job.reprint_of` has none: the print record is swept after ninety days
 * and this row outlives it.
 */
export const partySlipPrint = pos.table(
  'party_slip_print',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** The OTO App's party. No foreign key: the app's tables are its own (C10). */
    eventId: uuid('event_id').notNull(),
    /** The party's day, as the plan dates it. */
    partyDate: date('party_date', { mode: 'string' }).notNull(),
    station: text('station').$type<PartySlipStationValue>().notNull(),
    /** 1 for the party's first printing that day, then one more per run. */
    run: integer('run').notNull(),
    trigger: text('trigger').$type<PartySlipTriggerValue>().notNull(),
    status: text('status').$type<PartySlipStatusValue>().notNull(),
    printJobId: uuid('print_job_id'),
    document: jsonb('document'),
    /** When the slip was queued to its printer; null when it was not. */
    printedAt: timestamp('printed_at', { withTimezone: true, mode: 'date' }),
    /** Who pressed "Print party slips now"; null for the job. */
    requestedByAccountId: uuid('requested_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    actionId: text('action_id'),
    ...timestamps,
  },
  (t) => [
    /** One row per station per run: a reprint is the next run. */
    uniqueIndex('party_slip_print_run_unique').on(t.eventId, t.partyDate, t.station, t.run),
    index('party_slip_print_operator_idx').on(t.operatorId),
    /** The job's question: which of the branch's parties today have printed. */
    index('party_slip_print_branch_date_idx').on(t.branchId, t.partyDate),
    index('party_slip_print_job_idx').on(t.printJobId),
    index('party_slip_print_requested_by_idx').on(t.requestedByAccountId),
    check('party_slip_print_station_check', sql`${t.station} in ('kitchen','bar')`),
    check('party_slip_print_status_check', sql`${t.status} in ('printed','no_printer','nothing_to_print')`),
    check('party_slip_print_trigger_check', sql`${t.trigger} in ('schedule','reprint')`),
    check('party_slip_print_run_check', sql`${t.run} > 0`),
    /** A printed slip has its job and its time; one that was not queued has neither. */
    check(
      'party_slip_print_printed_check',
      sql`(${t.status} = 'printed') = (${t.printJobId} is not null and ${t.printedAt} is not null)`,
    ),
    /** Nothing to print is the one slip with no document. */
    check(
      'party_slip_print_document_check',
      sql`(${t.status} = 'nothing_to_print') = (${t.document} is null)`,
    ),
  ],
);
