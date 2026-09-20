import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { core, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { station } from './platform';

// --- The operational record (schema `core`) --------------------------------
//
// S2-03. One rule behind all five tables: **anything that can fail silently is
// written down here**. Render keeps its log stream for days, the park runs for
// years, and the failures that matter are the quiet ones — a sweep that stopped
// running, a receipt that never printed, a payment webhook nobody matched. A
// log line is not a record of those; a row is.
//
// The line between this and `audit_log`: audit answers "who did what to which
// record", `ops_run` answers "what did the system do, and did it work". An
// actor therefore appears in audit and not here, which is also why these
// tables can be pruned and the audit log cannot.

/**
 * What produced a run.
 *
 * `http`, `process`, `job`, `client` and `adapter` are written from S2-03;
 * the rest are the vocabulary the tickets after it use (S2-04 devices, S2-05
 * sync, S2-10 the gateway webhook, S2-13 integrations, the console's own
 * actions) and are named now so widening the CHECK is not a migration in the
 * middle of each of them.
 */
export const OPS_KINDS = [
  'http',
  'process',
  'job',
  'client',
  'adapter',
  'device',
  'sync',
  'webhook',
  'integration',
  'console',
] as const;
export type OpsKind = (typeof OPS_KINDS)[number];

/**
 * `skipped` is a first-class outcome, not a non-event: a job that declined to
 * run because another instance held the lock looks exactly like a job that
 * never fired unless it says so.
 */
export const OPS_OUTCOMES = ['ok', 'failed', 'skipped'] as const;
export type OpsOutcome = (typeof OPS_OUTCOMES)[number];

/**
 * `ops_last` carries one state `ops_run` cannot: `running`. A run row is
 * written when the operation ends, so it has no use for it — but the claim a
 * job makes before it starts is exactly what stops a second instance running
 * the same tick, and that claim has to say what it is. A `running` left behind
 * by a process that died is not a lie either: it is the most useful thing the
 * Health page could show about it.
 */
export const OPS_LAST_OUTCOMES = ['running', 'ok', 'failed', 'skipped'] as const;
export type OpsLastOutcome = (typeof OPS_LAST_OUTCOMES)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/**
 * One row per notable operation or failure.
 *
 * Written at completion rather than at start: a row that exists means the
 * operation reached an end, so "no row" and "still running" are never the same
 * thing on the Failures page. A job that hangs is not caught by this table at
 * all — that is what `ops_expectation` and the watchdog are for.
 *
 * This table grows faster than anything else in the system, so it is indexed
 * for the three questions the Console actually asks (recent failures, by kind,
 * by name) rather than for every column it holds, and
 * `job:housekeeping.retention` deletes rows older than
 * `OPS_RUN_RETENTION_DAYS`.
 */
export const opsRun = core.table(
  'ops_run',
  {
    id: idPk(),
    kind: text('kind').$type<OpsKind>().notNull(),
    /**
     * The operation, in the same vocabulary as the audit action and the log
     * line: `job:housekeeping.idempotency`, `adapter:2c2p.do_payment`,
     * `http:POST /members`. One name ties the three together.
     */
    name: text('name').notNull(),
    outcome: text('outcome').$type<OpsOutcome>().notNull(),
    /**
     * Scrubbed by the service before it gets here (see services/ops.ts). No
     * phone, name, allergy or terminal payload ever reaches this column: it is
     * read on a Console page by whoever is on shift, and it outlives the
     * incident by a month.
     */
    detail: jsonb('detail'),
    /** Short, non-leaking label — an AppError code, a SQLSTATE, an error name. */
    errorCode: text('error_code'),
    /** The message, truncated and scrubbed. Null on success. */
    errorMessage: text('error_message'),
    /**
     * What groups a hundred instances of the same break into one line on the
     * Failures page: kind, name and error code, hashed. Null on success, so
     * the index below carries only failures worth grouping.
     */
    fingerprint: text('fingerprint'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Stored rather than derived: sorting the slowest runs is a Console query. */
    durationMs: integer('duration_ms').notNull(),
    /** The request this run belongs to, where one exists (S2-01a shape). */
    requestId: text('request_id'),
    /**
     * One user action can cross the till, the box, a device and the cloud
     * (`x-oto-action-id`). This is what makes those four records one story.
     */
    actionId: text('action_id'),
    operatorId: uuid('operator_id').references(() => operator.id),
    branchId: uuid('branch_id').references(() => branch.id),
    stationId: uuid('station_id').references(() => station.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // Recency, and what the retention sweep deletes by. A btree is read
    // backwards for `order by started_at desc` just as well as forwards.
    index('ops_run_started_idx').on(t.startedAt),
    index('ops_run_kind_started_idx').on(t.kind, t.startedAt),
    index('ops_run_name_started_idx').on(t.name, t.startedAt),
    index('ops_run_outcome_started_idx').on(t.outcome, t.startedAt),
    index('ops_run_fingerprint_idx').on(t.fingerprint, t.startedAt),
    // "Find everything about request X" — the runbook this ticket promises.
    index('ops_run_request_idx').on(t.requestId),
    index('ops_run_action_idx').on(t.actionId),
    index('ops_run_operator_idx').on(t.operatorId),
    index('ops_run_branch_idx').on(t.branchId),
    index('ops_run_station_idx').on(t.stationId),
    check('ops_run_kind_check', sql`${t.kind} in ('http','process','job','client','adapter','device','sync','webhook','integration','console')`),
    check('ops_run_outcome_check', sql`${t.outcome} in ('ok','failed','skipped')`),
  ],
);

/**
 * The latest state of each named thing, so "is this healthy" is one row rather
 * than a scan of the largest table in the database. Health asks that question
 * for every job and every box on every page load; `ops_run` answers it only by
 * reading millions of rows to find a handful.
 *
 * It is also the schedule itself. A job is due when `last_started_at` is old
 * enough, and that fact lives here rather than in a process, which is what
 * stops two api instances running one schedule twice (services/jobs.ts).
 *
 * The primary key is the name alone: anything scoped — a box, a station, a
 * branch — carries its scope in the name (`box.heartbeat:<id>`), so one row
 * per thing stays literally true.
 */
export const opsLast = core.table(
  'ops_last',
  {
    name: text('name').primaryKey(),
    kind: text('kind').$type<OpsKind>().notNull(),
    /**
     * Set null rather than cascade: the run is pruned after a month, the
     * "is this healthy" row must survive it.
     */
    lastRunId: uuid('last_run_id').references(() => opsRun.id, { onDelete: 'set null' }),
    lastOutcome: text('last_outcome').$type<OpsLastOutcome>().notNull(),
    lastStartedAt: timestamp('last_started_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastFinishedAt: timestamp('last_finished_at', { withTimezone: true, mode: 'date' }),
    lastDurationMs: integer('last_duration_ms'),
    /** What the watchdog compares against the expectation: the last success. */
    lastOkAt: timestamp('last_ok_at', { withTimezone: true, mode: 'date' }),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true, mode: 'date' }),
    /**
     * Reset to zero by a success. One failure is noise; the same job failing
     * three times is the thing worth waking someone for.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    errorCode: text('error_code'),
    fingerprint: text('fingerprint'),
    ...timestamps,
  },
  (t) => [
    index('ops_last_kind_idx').on(t.kind),
    index('ops_last_outcome_idx').on(t.lastOutcome),
    index('ops_last_run_idx').on(t.lastRunId),
    check('ops_last_outcome_check', sql`${t.lastOutcome} in ('running','ok','failed','skipped')`),
  ],
);

/**
 * What SHOULD have happened, and how recently.
 *
 * Without this table the system can only report failures it witnessed. A sweep
 * that stopped being scheduled, a box that stopped calling home, a rollup
 * nobody registered — each of those is invisible in `ops_run` precisely
 * because nothing ran. The watchdog reads this against `ops_last` and raises
 * for the difference, which is the one check that catches a silence.
 *
 * `defineJob` upserts a row per job on start-up, so registering a job is the
 * same act as promising it will run; other tickets insert rows of their own
 * (a box heartbeat, a nightly rollup).
 */
export const opsExpectation = core.table(
  'ops_expectation',
  {
    /** Matches `ops_run.name` / `ops_last.name` exactly — that is the join. */
    name: text('name').primaryKey(),
    kind: text('kind').$type<OpsKind>().notNull().default('job'),
    /** One line for the Health page: what this is and why it matters. */
    description: text('description'),
    /** How often a success is expected. */
    intervalSeconds: integer('interval_seconds').notNull(),
    /**
     * How late is late. A job on a 60-second interval that runs at 61 seconds
     * is not an incident; one that has not run in ten minutes is.
     */
    graceSeconds: integer('grace_seconds').notNull().default(60),
    severity: text('severity').$type<AlertSeverity>().notNull().default('warning'),
    /**
     * Turned off rather than deleted: a rule someone decided not to enforce is
     * itself worth being able to see.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** Planned silence — a maintenance window — without deleting the rule. */
    mutedUntil: timestamp('muted_until', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    index('ops_expectation_enabled_idx').on(t.enabled),
    check('ops_expectation_interval_check', sql`${t.intervalSeconds} > 0`),
    check('ops_expectation_grace_check', sql`${t.graceSeconds} >= 0`),
    check('ops_expectation_severity_check', sql`${t.severity} in ('info','warning','critical')`),
  ],
);

/**
 * A condition someone should know about, with a life of its own: raised once,
 * updated while it persists, resolved when it clears.
 *
 * The dedupe is the partial unique index below — at most one unresolved alert
 * per `key` — and it is what stops a job that is broken for an hour from
 * raising sixty alerts. A repeat detection bumps `last_seen_at` and
 * `occurrences` on the row that is already open.
 */
export const alert = core.table(
  'alert',
  {
    id: idPk(),
    /**
     * The identity of the CONDITION, not of this occurrence:
     * `ops.missing:job:watchdog`, `ops.failing:job:demo.fail`. Two detections
     * of the same condition must produce the same key or the dedupe is a
     * decoration.
     */
    key: text('key').notNull(),
    /** The family, for routing later: `ops.missing`, `box.offline`. */
    category: text('category').notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull().default('warning'),
    status: text('status').$type<AlertStatus>().notNull().default('open'),
    /** What it is about — a job name, a box id — in one short string. */
    subject: text('subject').notNull(),
    /** One line a person can act on without opening anything. */
    summary: text('summary').notNull(),
    /** Scrubbed, like `ops_run.detail`. */
    detail: jsonb('detail'),
    operatorId: uuid('operator_id').references(() => operator.id),
    branchId: uuid('branch_id').references(() => branch.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    occurrences: integer('occurrences').notNull().default(1),
    /**
     * How many times this condition cleared and came back inside the flap
     * window. A high number is the signal itself: something is oscillating,
     * which is worse than something that is plainly down.
     */
    reopenCount: integer('reopen_count').notNull().default(0),
    /** When a channel was last told. Null means it was raised but never sent. */
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true, mode: 'date' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
    acknowledgedByAccountId: uuid('acknowledged_by_account_id').references(() => account.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    /** `recovered`, `manual`, `expired` — why it stopped being true. */
    resolvedReason: text('resolved_reason'),
    ...timestamps,
  },
  (t) => [
    /**
     * The dedupe, enforced by the database rather than by a read-then-write in
     * the watchdog — two api instances can run the same check in the same
     * second, and the lesson from the idempotency claim and the hand-off jti is
     * that only a single statement settles a race.
     */
    uniqueIndex('alert_open_key_unique').on(t.key).where(sql`resolved_at is null`),
    /** The flap lookup: the most recent resolved alert for this key. */
    index('alert_key_resolved_idx').on(t.key, t.resolvedAt),
    index('alert_status_seen_idx').on(t.status, t.lastSeenAt),
    index('alert_operator_idx').on(t.operatorId),
    index('alert_branch_idx').on(t.branchId),
    index('alert_acknowledged_by_idx').on(t.acknowledgedByAccountId),
    check('alert_severity_check', sql`${t.severity} in ('info','warning','critical')`),
    check('alert_status_check', sql`${t.status} in ('open','acknowledged','resolved')`),
  ],
);

/** What a delivery was about, so a resolution notice is distinguishable from a raise. */
export const ALERT_DELIVERY_EVENTS = ['opened', 'reopened', 'resolved', 'test'] as const;
export type AlertDeliveryEvent = (typeof ALERT_DELIVERY_EVENTS)[number];

/**
 * One row per attempt to tell someone. A channel that quietly stopped
 * delivering is the same class of problem as a job that quietly stopped
 * running, so the attempt is recorded whether or not it worked.
 */
export const alertDelivery = core.table(
  'alert_delivery',
  {
    id: idPk(),
    /** Cascade: a delivery without its alert says nothing at all. */
    alertId: uuid('alert_id')
      .notNull()
      .references(() => alert.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    event: text('event').$type<AlertDeliveryEvent>().notNull(),
    /** `sent` or `failed` — the attempt, not the alert. */
    status: text('status').notNull(),
    /**
     * A non-secret label for where it went: `console`, or a webhook's host. A
     * Slack or LINE webhook URL is a bearer credential, so the URL itself is
     * never stored here.
     */
    target: text('target'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('alert_delivery_alert_idx').on(t.alertId, t.attemptedAt),
    index('alert_delivery_attempted_idx').on(t.attemptedAt),
    check('alert_delivery_event_check', sql`${t.event} in ('opened','reopened','resolved','test')`),
    check('alert_delivery_status_check', sql`${t.status} in ('sent','failed')`),
  ],
);
