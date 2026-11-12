import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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

// --- What a station is taken to hold, and under which composer (SCRUM-906) ---

/**
 * SCRUM-906 — A RELEASE IS NOT A CHANGE. A party's slips are compared, once a
 * minute, with what its plan would print now (SCRUM-861): a station holding
 * something else is sent a VOID and an UPDATED slip. When a release changes
 * what an unchanged plan prints — the whole kitchen plan reaching the till,
 * "Fried rice: Veggie" where "Veggie" printed, the cake on the kitchen slip —
 * every party whose slips already printed that day would otherwise be sent a
 * correction it never had.
 *
 * ONE ROW PER PARTY, DAY AND STATION: the composer the station's slip is read
 * under (`PARTY_SLIP_COMPOSER` and the shape the OTO App published the plan
 * in, e.g. "2:kp1"), and which slip it was last given ("print:<run>",
 * "change:<run>", or "none"). Every slip this release puts on paper writes its
 * row. A look that finds the station's newest slip with no row of the
 * composer it now reads under — a slip printed before the release — takes the
 * plan as composed now as what the station holds and prints nothing
 * (`rebased`, with `held` the lines it takes the station to hold); the next
 * real change of the plan is compared with that and printed as before.
 *
 * `held` carries the slip's lines and the party's name (no child's allergy,
 * no parent's number), as `party_slip_print.document` does.
 */
export const partySlipBaseline = pos.table(
  'party_slip_baseline',
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
    partyDate: date('party_date', { mode: 'string' }).notNull(),
    station: text('station').$type<PartySlipStationValue>().notNull(),
    /** The composer generation and the plan's published shape the station's slip is read under. */
    composer: text('composer').notNull(),
    /** The newest slip the station was given when the row was written: "print:<run>", "change:<run>" or "none". */
    source: text('source').notNull(),
    /** A look took the plan as composed now without printing it. */
    rebased: boolean('rebased').notNull().default(false),
    /** The fingerprint of what the station is taken to hold (`partySlipFingerprint`). */
    fingerprint: text('fingerprint').notNull(),
    /** What it is taken to hold: `{ lines, orderRef }`; null for nothing. */
    held: jsonb('held'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('party_slip_baseline_station_unique').on(t.eventId, t.partyDate, t.station),
    index('party_slip_baseline_operator_idx').on(t.operatorId),
    index('party_slip_baseline_branch_idx').on(t.branchId),
    check('party_slip_baseline_station_check', sql`${t.station} in ('kitchen','bar')`),
  ],
);

// --- When the schedule began printing a party with no package (SCRUM-906) ----

/** The kinds of party the schedule began printing in a release: a party with a kitchen plan and no package. */
export const PARTY_SLIP_SCHEDULE_KIND_VALUES = ['no_package'] as const;
export type PartySlipScheduleKindValue = (typeof PARTY_SLIP_SCHEDULE_KIND_VALUES)[number];

/**
 * SCRUM-906 — A RELEASE DOES NOT CATCH UP. Before SCRUM-906 the slip time's
 * job printed only a party with a package; from it, a party with a kitchen
 * plan and no package prints too (the owner's decision 8). No such party has
 * a scheduled run, so the first tick after the release would print at once
 * every one of the day whose slip time had already passed, parties already
 * over among them.
 *
 * ONE ROW PER PARK AND KIND: the job's clock at its first tick at the park
 * under the release (written by the job itself, so it is the moment the
 * release began printing there, whatever the deploy order). A party with no
 * package whose slip time passed before it is not printed by the schedule;
 * "Print party slips now" still prints it. From the next slip time on, a
 * party with no package prints as a party with a package does.
 */
export const partySlipScheduleStart = pos.table(
  'party_slip_schedule_start',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<PartySlipScheduleKindValue>().notNull(),
    /** The job's clock at its first tick at the park that printed this kind of party. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('party_slip_schedule_start_kind_unique').on(t.branchId, t.kind),
    index('party_slip_schedule_start_operator_idx').on(t.operatorId),
    check('party_slip_schedule_start_kind_check', sql`${t.kind} in ('no_package')`),
  ],
);
