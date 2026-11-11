import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idPk, pos, timestamps } from './helpers';
import { refund, sale } from './sales';
import { account, branch, operator } from './tenancy';

// --- The void and updated-items slips (schema `pos`) -------------------------
//
// SCRUM-861. A kitchen or bar ticket prints once, when the sale closes, and a
// party's slips print once at its slip time (SCRUM-805). When what the station
// was given no longer holds — the sale refunded in whole or in part, the BEO's
// plan changed after the slips went out — each affected station is sent a VOID
// slip of what it no longer makes and an UPDATED slip of what it still has to
// make. This table is the record of those slips, one row each, in the shape
// `pos.party_slip_print` keeps a party's: the slip as it was composed, the
// print job that put it on paper, and what became of it.

/** The two prep stations a slip goes to, kitchen first. */
export const PREP_SLIP_STATION_VALUES = ['kitchen', 'bar'] as const;
export type PrepSlipStationValue = (typeof PREP_SLIP_STATION_VALUES)[number];

/** A VOID slip (the lines taken off) or an UPDATED slip (what is still to make). */
export const PREP_SLIP_VARIANT_VALUES = ['void', 'updated'] as const;
export type PrepSlipVariantValue = (typeof PREP_SLIP_VARIANT_VALUES)[number];

/** What sent it: a sale's refund, or a party's plan changing after its slips printed. */
export const PREP_SLIP_SOURCE_VALUES = ['refund', 'party'] as const;
export type PrepSlipSourceValue = (typeof PREP_SLIP_SOURCE_VALUES)[number];

/**
 * What became of the slip: queued to the station's printer of its kind
 * (`printed`), or not queued — the station is not on a box, or has no printer
 * of that kind (`no_printer`). A station with nothing to say gets no row.
 */
export const PREP_SLIP_STATUS_VALUES = ['printed', 'no_printer'] as const;
export type PrepSlipStatusValue = (typeof PREP_SLIP_STATUS_VALUES)[number];

/**
 * ONE SLIP of one change, for one station. A refund's slips name the refund
 * and its sale; a party's name the OTO App's event, its day and the run (one
 * more per change seen, as `party_slip_print.run` counts printings) and carry
 * the fingerprint of the slip the station now holds, which is what makes a
 * change print once: the next look finds the same fingerprint and writes
 * nothing.
 *
 * `document` is the slip as it was composed (the prep ticket's data with its
 * variant) and is what the box prints for the job. It is kept, as a party's
 * is, so the record says what the kitchen was given: a refund's slip carries
 * the order's holder and allergy line exactly as the ticket it corrects did,
 * which the check-in record already keeps for a supervised child's stay.
 *
 * `print_job_id` names the job without a foreign key, for the reason
 * `print_job.reprint_of` has none: the print record is swept after ninety days
 * and this row outlives it.
 */
export const prepSlipPrint = pos.table(
  'prep_slip_print',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    source: text('source').$type<PrepSlipSourceValue>().notNull(),
    /** A refund's slip: the sale whose ticket it corrects, and the refund that sent it. */
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'restrict' }),
    refundId: uuid('refund_id').references(() => refund.id, { onDelete: 'restrict' }),
    /** A party's slip: the OTO App's party (no foreign key: the app's tables are its own, C10) and its day. */
    eventId: uuid('event_id'),
    partyDate: date('party_date', { mode: 'string' }),
    /** A party's: 1 for the first change seen after its slips printed, then one more per change. */
    run: integer('run'),
    /** A party's: the fingerprint of the slip this station now holds (`partySlipFingerprint`). */
    planFingerprint: text('plan_fingerprint'),
    station: text('station').$type<PrepSlipStationValue>().notNull(),
    variant: text('variant').$type<PrepSlipVariantValue>().notNull(),
    status: text('status').$type<PrepSlipStatusValue>().notNull(),
    printJobId: uuid('print_job_id'),
    document: jsonb('document').notNull(),
    /** When the slip was queued to its printer; null when it was not. */
    printedAt: timestamp('printed_at', { withTimezone: true, mode: 'date' }),
    /** Who made the refund; null for the party job. */
    requestedByAccountId: uuid('requested_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    actionId: text('action_id'),
    ...timestamps,
  },
  (t) => [
    /** A refund sends each station one slip of each kind, once. */
    uniqueIndex('prep_slip_print_refund_unique')
      .on(t.refundId, t.station, t.variant)
      .where(sql`refund_id is not null`),
    /** A party's change is one run: one slip of each kind per station in it. */
    uniqueIndex('prep_slip_print_party_unique')
      .on(t.eventId, t.partyDate, t.station, t.variant, t.run)
      .where(sql`event_id is not null`),
    index('prep_slip_print_operator_idx').on(t.operatorId),
    index('prep_slip_print_branch_idx').on(t.branchId),
    index('prep_slip_print_sale_idx').on(t.saleId),
    index('prep_slip_print_refund_idx').on(t.refundId),
    /** The job's question: what each of today's parties was last given. */
    index('prep_slip_print_party_idx').on(t.eventId, t.partyDate),
    index('prep_slip_print_job_idx').on(t.printJobId),
    index('prep_slip_print_requested_by_idx').on(t.requestedByAccountId),
    check('prep_slip_print_source_check', sql`${t.source} in ('refund','party')`),
    check('prep_slip_print_station_check', sql`${t.station} in ('kitchen','bar')`),
    check('prep_slip_print_variant_check', sql`${t.variant} in ('void','updated')`),
    check('prep_slip_print_status_check', sql`${t.status} in ('printed','no_printer')`),
    check('prep_slip_print_run_check', sql`${t.run} is null or ${t.run} > 0`),
    /** A refund's slip names its refund and its sale; a party's names its party, its day, its run and its fingerprint. */
    check(
      'prep_slip_print_refund_check',
      sql`(${t.source} = 'refund') = (${t.refundId} is not null and ${t.saleId} is not null)`,
    ),
    check(
      'prep_slip_print_party_check',
      sql`(${t.source} = 'party') = (${t.eventId} is not null and ${t.partyDate} is not null and ${t.run} is not null and ${t.planFingerprint} is not null)`,
    ),
    /** A printed slip has its job and its time; one that was not queued has neither. */
    check(
      'prep_slip_print_printed_check',
      sql`(${t.status} = 'printed') = (${t.printJobId} is not null and ${t.printedAt} is not null)`,
    ),
  ],
);
