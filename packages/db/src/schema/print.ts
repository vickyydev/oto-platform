import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, edge, idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { box, device, station } from './fleet';
import type { PrintKind, PrintTemplateFields, PrintTemplateType } from '@oto/shared';

// --- Printing (schemas `pos` and `edge`) ------------------------------------
//
// S2-06. Two tables that sit either side of a line worth drawing carefully,
// because the ticket asks the question directly: a print job is a fact about a
// device, but a receipt reprint is a fact about a sale. Which schema owns it?
//
// **The template is configuration and lives in `pos`.** It is branch-scoped
// content — what a receipt shows — read only by the till and the box, and read
// together with the catalogue it prices from. That is the same argument S2-01b
// used to put the catalogue, its holiday calendar and its tax rules in `pos`
// rather than in `core`, and the same answer. It also travels to a box in the
// `catalogue` cache scope, so no new scope is needed and the CHECK on
// `edge.sync_change.scope` does not move.
//
// **The job is transport and lives in `edge`.** A print job is the record of
// one attempt to push bytes at a machine: it has a device, a queue, a retry, a
// paper-out and a retention window. What it was ABOUT — the sale, the band, the
// voucher — lives in `pos` and `crm` and is never swept, and the enduring fact
// that somebody reprinted a receipt is an `audit_log` row, which is also never
// swept. So the sale keeps the answer to "who reprinted this and why" and this
// table keeps the answer to "did the paper come out", which is the division
// `edge.sync_event` already makes between the envelope and the fact inside it.
//
// The practical test for anybody tempted to move it later: if this table were
// dropped tomorrow, could the park still close its day and answer a tax query?
// Yes — every number comes from the sale. That is what makes it edge.
//
// **ON DELETE.** Restrict on every key, including the box. `edge.station_event`
// and `edge.box_heartbeat` cascade because thirty days of telemetry about a box
// that no longer exists is worth nothing to anybody; this is not that. A print
// job is evidence about whether a guest was given a receipt, and the line
// `sync.ts` draws is the one that applies: a sweep with a number attached to it
// may delete these rows, and a side effect of somebody deleting a row somewhere
// else may not.

/**
 * What a branch may change about a printout.
 *
 * Six editable types against nine printouts — the mismatch is the prototype's
 * and is deliberate: `item_voucher` borrows the credit voucher's template,
 * while `booth_voucher` and `test_page` have none. The vocabulary, the field
 * keys and which fields apply to which type all live in
 * `@oto/shared/print.ts`, so the Console can draw the editor without importing
 * the Node-only renderer.
 *
 * **One row per (branch, type).** The prototype's admin panel is a list, but
 * `catalogStore.getPrintTemplate` takes the FIRST template matching a type, so
 * a second one of the same type would be invisible and editing it would change
 * nothing — a trap rather than a feature. The unique index below makes that
 * state unreachable instead of merely unlikely. If a branch ever wants two
 * receipt layouts to switch between, that is an `active` column and a partial
 * unique index on it: an expand, a switch and a contract, in a later migration.
 *
 * **A branch with no rows prints everything.** `printFieldOn` in `@oto/shared`
 * returns true for every applicable field when there is no template, which is
 * what the prototype does and the only safe direction — a new branch prints a
 * full receipt rather than a blank one. So nothing has to seed a branch before
 * it can sell.
 */
export const printTemplate = pos.table(
  'print_template',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /**
     * Content is per branch, not per operator: a second branch has its own tax
     * id, its own address and its own footer. Not nullable — there is no
     * operator-wide default row, because "no row" already means "print
     * everything" and two kinds of absence would be one too many.
     */
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** One of `PRINT_TEMPLATE_TYPES`. */
    type: text('type').$type<PrintTemplateType>().notNull(),
    /** What the admin list calls it: "Standard receipt". */
    name: text('name').notNull(),
    showLogo: boolean('show_logo').notNull().default(true),
    /** Printed verbatim at the top. Length-capped by zod at the API boundary. */
    headerText: text('header_text'),
    footerText: text('footer_text'),
    /**
     * The toggles, as the prototype stores them: every key optional, an absent
     * key read the same as `false`, and a `true` on a field the type does not
     * use inert rather than an error. Validated by `PrintTemplateFieldsSchema`.
     */
    fields: jsonb('fields').$type<PrintTemplateFields>().notNull().default({}),
    /**
     * Bumped on every edit.
     *
     * This is what makes "toggling a template field changes the next preview
     * without a redeploy" work on a box that is not the one the edit was made
     * on: the delta goes into `edge.sync_change` with this number in its
     * `version` column, and a box applying two deltas out of order keeps the
     * higher one.
     */
    version: integer('version').notNull().default(1),
    ...timestamps,
    /** Archived rather than deleted, so a print job may still name it. */
    ...archivedAt,
  },
  (t) => [
    index('print_template_operator_idx').on(t.operatorId),
    /** The branch's whole set, which is what the admin panel and the cache bundle read. */
    index('print_template_branch_idx').on(t.branchId),
    /**
     * Partial, so archiving a template frees its type for the one that replaces
     * it — the same shape as `station_name_unique`.
     */
    uniqueIndex('print_template_branch_type_unique')
      .on(t.branchId, t.type)
      .where(sql`archived_at is null`),
    check(
      'print_template_type_check',
      sql`${t.type} in ('receipt','kids_wristband','adult_wristband','kitchen_ticket','bar_ticket','credit_voucher')`,
    ),
    check('print_template_version_check', sql`${t.version} > 0`),
  ],
);

/**
 * One attempt to print one thing.
 *
 * **The id is minted on the box**, inside the transaction that queues the job,
 * exactly as `box_outbox.event_id` is. A box that loses the answer to a push
 * re-sends — that is the normal condition, not the exception — so the insert is
 * `on conflict do nothing` and a lost acknowledgement costs one wasted insert
 * rather than a second receipt appearing in the record.
 *
 * **Nothing rendered is stored here.** No document, no device bytes, no
 * preview. A receipt carries a member's name and what they bought; a kids' band
 * carries a child's name and an allergy line. This table is read on a Console
 * page and swept on a timer, which is precisely the wrong place for either. A
 * reprint re-renders from the sale (S2-11), which is also the only way a
 * reprint can pick up a correction.
 *
 * **Retention: 90 days**, `PRINT_JOB_RETENTION_DAYS` in `@oto/shared`. The
 * questions this table answers — did it print, why is the queue stuck, which
 * printer eats paper — are asked within days; the ones asked in a year are
 * asked of the sale and of the audit log, neither of which is swept. The sweep
 * belongs beside `purgeOldSyncEvents` in `job:housekeeping.retention`
 * (`apps/api/src/services/jobs.ts`), deleting by `queued_at`.
 * `print_job_queued_idx` exists for that delete as much as for any read. **It
 * is not wired yet** — the API half of S2-06 does that, and until it does this
 * table grows without bound.
 */
export const PRINT_JOB_STATUSES = ['queued', 'printed', 'failed', 'skipped'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

export const printJob = edge.table(
  'print_job',
  {
    /** UUIDv7, minted on the box with the job. */
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /**
     * Null for a job that belongs to the box rather than to a station — a test
     * page fired at a device from the Console's Devices area before any station
     * has been assigned to it.
     */
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    /**
     * Null when the job was SKIPPED for want of a printer, which is the whole
     * reason this column is nullable: "jobs to an unassigned device are skipped
     * with a non-blocking note on the till" is an acceptance criterion, and the
     * row that records it has no device to name. The CHECK below is what stops
     * that nullability leaking into the printed case.
     */
    deviceId: uuid('device_id').references(() => device.id, { onDelete: 'restrict' }),
    /**
     * Which `station_device` role chose the device — `receipt`, `kitchen`,
     * `bar`, `kids_band`, `adult_band`. Kept beside the device rather than
     * derived from it, because routing is the thing that goes wrong: "why did
     * the bar ticket come out of the kitchen printer" is answered by comparing
     * this with the assignment as it stands now.
     */
    role: text('role'),
    /** One of `PRINT_KINDS` in `@oto/shared` — the nine printouts. */
    kind: text('kind').$type<PrintKind>().notNull(),
    /**
     * The template applied, where the printout has one, and the version of it
     * that was applied. The pair is the answer to "this receipt is missing the
     * logo and the template says it should have one": either the job ran under
     * an older version, or it did not use a template at all.
     */
    templateId: uuid('template_id').references(() => printTemplate.id, { onDelete: 'restrict' }),
    templateVersion: integer('template_version'),
    copies: smallint('copies').notNull().default(1),
    status: text('status').$type<PrintJobStatus>().notNull().default('queued'),
    /**
     * What the printout is about: `sale`, `band`, `voucher`, `booking`,
     * `visit`, `station`. One pair rather than a nullable column per entity —
     * the shape `edge.sync_change` already uses — so a ticket that prints
     * something new adds a word to the vocabulary in `@oto/shared` instead of a
     * migration here.
     *
     * Text, not uuid: a band code and a receipt number are not uuids. No
     * foreign key, for the reason `sync_quarantine.event_id` has none — the
     * column has to be able to name a row in another schema, of a type that
     * changes per row, and a constraint cannot express that.
     */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    attempts: integer('attempts').notNull().default(0),
    /** Short, non-leaking, as `ops_run.error_code` is — this is read on a Console page. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /**
     * The ORIGINAL job this is a copy of — never the job it was copied from.
     *
     * A reprint of a reprint of a reprint would otherwise be a linked list
     * somebody has to walk to count the copies of one receipt, and every link
     * is a row the 90-day sweep may already have deleted, leaving a chain with
     * a hole in it and no way to tell how long it used to be. Flattened to
     * depth one, the count is `where reprint_of = $root` and the sweep cannot
     * corrupt anything.
     *
     * **The database does not enforce the flattening** — a CHECK cannot read
     * another row — and does not pretend to. `reprintRootOf` in `@oto/shared`
     * is the one place that decides what a new job's `reprint_of` should be;
     * the only thing checked here is that a job is not a reprint of itself.
     *
     * No foreign key, deliberately, and for a reason particular to this column:
     * a reprint is NEWER than its original, so a sweep by age reaches the
     * original first. A restricting key would block the sweep and a cascading
     * one would delete the copy along with the original. The same rule as
     * `box_command.action_id` — a pointer has to be able to outlive what it
     * points at.
     */
    reprintOf: uuid('reprint_of'),
    /** Why. A reprint with no reason is a receipt nobody can account for. */
    reprintReason: text('reprint_reason'),
    /** Who asked for it: a test print, a reprint. Null for a job the till raised itself. */
    requestedByAccountId: uuid('requested_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    /** `x-oto-action-id`, minted where the person tapped and carried till -> box -> cloud. */
    actionId: text('action_id'),
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Set when the bytes start going to the device. A job in flight is still `queued`. */
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    /** The box's own history, newest first, and the Console's per-box panel. */
    index('print_job_box_queued_idx').on(t.boxId, t.queuedAt),
    /**
     * The retry queue: what is still outstanding on one box, in the order it
     * was asked for. Partial, so the index holds the queue rather than every
     * job ever printed — which also makes a count over it the queue depth the
     * heartbeat reports.
     */
    index('print_job_pending_idx')
      .on(t.boxId, t.queuedAt)
      .where(sql`status = 'queued'`),
    /** "What is stuck on this printer", which is what a paper-out alert links to. */
    index('print_job_device_queued_idx').on(t.deviceId, t.queuedAt),
    index('print_job_station_queued_idx').on(t.stationId, t.queuedAt),
    /** The Console filters by branch over a date range, as it does for every edge table. */
    index('print_job_branch_queued_idx').on(t.branchId, t.queuedAt),
    /** "Was this receipt printed, and how many times?" */
    index('print_job_subject_idx').on(t.subjectType, t.subjectId),
    /** The copies of one original. Partial: most jobs are not reprints. */
    index('print_job_reprint_idx')
      .on(t.reprintOf)
      .where(sql`reprint_of is not null`),
    /** Following one action across the till, the box and the cloud. */
    index('print_job_action_idx').on(t.actionId),
    /** The retention sweep's delete, and nothing else. */
    index('print_job_queued_idx').on(t.queuedAt),
    index('print_job_operator_idx').on(t.operatorId),
    index('print_job_template_idx').on(t.templateId),
    index('print_job_requested_by_idx').on(t.requestedByAccountId),
    check('print_job_status_check', sql`${t.status} in ('queued','printed','failed','skipped')`),
    check(
      'print_job_kind_check',
      sql`${t.kind} in ('receipt','kitchen_ticket','bar_ticket','kids_wristband','adult_wristband','credit_voucher','item_voucher','booth_voucher','test_page')`,
    ),
    check(
      'print_job_role_check',
      sql`${t.role} is null or ${t.role} in ('receipt','kids_band','adult_band','kitchen','bar','scanner','card_terminal','qr_terminal','gate','cash_drawer')`,
    ),
    check(
      'print_job_subject_check',
      sql`${t.subjectType} is null or ${t.subjectType} in ('sale','sale_line','band','voucher','booking','visit','station','wallet')`,
    ),
    check('print_job_copies_check', sql`${t.copies} > 0`),
    check('print_job_attempts_check', sql`${t.attempts} >= 0`),
    check('print_job_template_version_check', sql`${t.templateVersion} is null or ${t.templateVersion} > 0`),
    /**
     * A job cannot have printed on no printer. The column is nullable for the
     * skipped case and this is what keeps that from meaning anything else.
     */
    check(
      'print_job_printed_device_check',
      sql`${t.status} <> 'printed' or ${t.deviceId} is not null`,
    ),
    /** A resolved job has a finishing time; a queued one has not finished. */
    check(
      'print_job_finished_check',
      sql`(${t.status} = 'queued') = (${t.finishedAt} is null)`,
    ),
    check('print_job_reprint_self_check', sql`${t.reprintOf} is null or ${t.reprintOf} <> ${t.id}`),
  ],
);
