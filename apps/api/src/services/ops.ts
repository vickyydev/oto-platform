import { redact } from '@oto/telemetry';
import { createHash } from 'node:crypto';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  alert,
  alertDelivery,
  opsExpectation,
  opsLast,
  opsRun,
  type AlertDeliveryEvent,
  type AlertSeverity,
  type Db,
  type OpsKind,
  type OpsOutcome,
} from '@oto/db';
import { newId } from '@oto/shared';
import { AppError } from '../lib/errors';
import { isPgError, scrubPgError } from '../lib/scrub';
import type { Exec } from './tx';

/**
 * The operational record (S2-03).
 *
 * `audit_log` answers "who changed which record". This answers the other
 * question, the one a log stream cannot answer a week later: **did the system
 * do what it was supposed to, and if not, since when.** Everything that can
 * fail where nobody is watching — a sweep, a print, a webhook, a terminal
 * call, a browser that threw — writes a row through here.
 *
 * Two rules hold the whole thing up:
 *   - nothing personal is ever written down. Detail payloads are scrubbed
 *     here rather than at each call site, because a call site added in a hurry
 *     at 9pm is exactly the one that would forget;
 *   - a failure row is written AFTER any rollback, on the pool — the same rule
 *     as the failure audit row in `services/tx.ts`, and for the same reason:
 *     the record of an attempt has to outlive the transaction that failed.
 */

// --- Redaction --------------------------------------------------------------

/**
 * Redaction is @oto/telemetry's job, not this file's (S2-03). The local
 * version here was key-only and exact-match, which misses the shape that
 * actually leaked in Sprint 1 - a phone inside a string under a key nobody
 * listed, which is exactly how Postgres reports a unique violation. Worse for
 * this table specifically, it walked own enumerable properties, and an Error's
 * message and stack are neither: every failure detail would have been
 * recorded as an empty object, on the one table whose whole purpose is saying
 * what went wrong.
 */
export const scrubDetail = redact;

/** Longest string this file writes into a record; the redactor has its own. */
const MAX_STRING = 500;

// --- Errors -----------------------------------------------------------------

export interface ErrorInfo {
  code: string;
  message: string;
}

/**
 * A short, non-leaking description of why something failed. A pg error is
 * reduced to its structural fields first: `detail` is where Postgres writes
 * `Key (phone)=(+66…) already exists`.
 */
export function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message.slice(0, MAX_STRING) };
  }
  if (isPgError(err)) {
    const safe = scrubPgError(err);
    return {
      code: `pg:${String(safe.pgCode ?? 'unknown')}`,
      message: [safe.constraint, safe.message].filter(Boolean).join(' — ').slice(0, MAX_STRING),
    };
  }
  if (err instanceof Error) {
    return { code: err.name || 'Error', message: err.message.slice(0, MAX_STRING) };
  }
  return { code: 'UNKNOWN', message: String(err).slice(0, MAX_STRING) };
}

/**
 * What collapses a hundred instances of one break into a single line on the
 * Failures page. The message is deliberately not part of it — messages carry
 * ids and counts that differ every time, and grouping by them groups nothing.
 */
export function errorFingerprint(kind: OpsKind, name: string, errorCode: string): string {
  return createHash('sha256').update(`${kind}\n${name}\n${errorCode}`).digest('hex').slice(0, 16);
}

// --- Runs -------------------------------------------------------------------

export interface RecordRunInput {
  kind: OpsKind;
  /** `job:housekeeping.idempotency`, `adapter:2c2p.do_payment`, `http:POST /members`. */
  name: string;
  outcome: OpsOutcome;
  startedAt: Date;
  finishedAt?: Date;
  detail?: unknown;
  /** The thrown value; reduced to a code and a scrubbed message. */
  error?: unknown;
  requestId?: string | null;
  actionId?: string | null;
  operatorId?: string | null;
  branchId?: string | null;
  stationId?: string | null;
}

export interface RecordedRun {
  id: string;
  fingerprint: string | null;
  durationMs: number;
}

/**
 * Write one run, and bring `ops_last` up to date with it.
 *
 * `skipped` reaches `ops_run` but never `ops_last`: a run that declined to
 * happen is worth seeing, and it is emphatically not an answer to "when did
 * this last work" or to "is this due" — both of which read `ops_last`.
 */
export async function recordRun(exec: Exec, input: RecordRunInput): Promise<RecordedRun> {
  const id = newId();
  const finishedAt = input.finishedAt ?? new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - input.startedAt.getTime());
  const failed = input.outcome === 'failed';
  const info = input.error !== undefined ? errorInfo(input.error) : null;
  const errorCode = info?.code ?? (failed ? 'UNKNOWN' : null);
  const fingerprint = errorCode ? errorFingerprint(input.kind, input.name, errorCode) : null;

  await exec.insert(opsRun).values({
    id,
    kind: input.kind,
    name: input.name,
    outcome: input.outcome,
    detail: (input.detail === undefined ? null : scrubDetail(input.detail)) as never,
    errorCode,
    errorMessage: info?.message ?? null,
    fingerprint,
    startedAt: input.startedAt,
    finishedAt,
    durationMs,
    requestId: input.requestId ?? null,
    actionId: input.actionId ?? null,
    operatorId: input.operatorId ?? null,
    branchId: input.branchId ?? null,
    stationId: input.stationId ?? null,
  });

  if (input.outcome !== 'skipped') {
    await exec
      .insert(opsLast)
      .values({
        name: input.name,
        kind: input.kind,
        lastRunId: id,
        lastOutcome: input.outcome,
        lastStartedAt: input.startedAt,
        lastFinishedAt: finishedAt,
        lastDurationMs: durationMs,
        lastOkAt: failed ? null : finishedAt,
        lastFailedAt: failed ? finishedAt : null,
        consecutiveFailures: failed ? 1 : 0,
        errorCode,
        fingerprint,
      })
      .onConflictDoUpdate({
        target: opsLast.name,
        set: {
          kind: sql`excluded.kind`,
          lastRunId: sql`excluded.last_run_id`,
          lastOutcome: sql`excluded.last_outcome`,
          lastStartedAt: sql`excluded.last_started_at`,
          lastFinishedAt: sql`excluded.last_finished_at`,
          lastDurationMs: sql`excluded.last_duration_ms`,
          // Keep the last success and the last failure, whichever this was:
          // "it broke at 14:02 and last worked at 09:15" is the sentence the
          // Health page has to be able to say.
          lastOkAt: sql`coalesce(excluded.last_ok_at, ops_last.last_ok_at)`,
          lastFailedAt: sql`coalesce(excluded.last_failed_at, ops_last.last_failed_at)`,
          consecutiveFailures: sql`case when excluded.last_outcome = 'failed' then ops_last.consecutive_failures + 1 else 0 end`,
          errorCode: sql`excluded.error_code`,
          fingerprint: sql`excluded.fingerprint`,
          updatedAt: new Date(),
        },
      });
  }

  return { id, fingerprint, durationMs };
}

// --- Alerts -----------------------------------------------------------------

export interface AlertInput {
  /**
   * The identity of the CONDITION, not of this sighting:
   * `ops.missing:job:watchdog`. Two detections of one condition must produce
   * one key, or the dedupe below is decoration.
   */
  key: string;
  category: string;
  subject: string;
  summary: string;
  severity?: AlertSeverity;
  detail?: unknown;
  operatorId?: string | null;
  branchId?: string | null;
}

/** What happened to the alert row — which is also what decides delivery. */
export type AlertOutcome = 'opened' | 'reopened' | 'repeated';

export interface RaisedAlert {
  id: string;
  outcome: AlertOutcome;
  occurrences: number;
}

/**
 * Raise a condition, at most once.
 *
 * Three ways this can land, and the difference between them is the whole
 * point of the table:
 *   - the condition is already open → bump it. A job broken for an hour is one
 *     alert with sixty sightings, not sixty alerts;
 *   - it was resolved moments ago and is back → reopen the same row without
 *     telling anyone again. That is flap suppression: a condition oscillating
 *     every minute must not put sixty messages in front of someone, because
 *     the reliable response to that is to mute the channel;
 *   - otherwise → a new alert, and a delivery.
 */
export async function raiseAlert(
  db: Db,
  input: AlertInput,
  opts: { flapWindowSeconds: number },
): Promise<RaisedAlert> {
  const now = new Date();
  const severity = input.severity ?? 'warning';
  const detail = (input.detail === undefined ? null : scrubDetail(input.detail)) as never;

  const bumped = await db
    .update(alert)
    .set({
      lastSeenAt: now,
      occurrences: sql`occurrences + 1`,
      severity,
      summary: input.summary,
      detail,
      updatedAt: now,
    })
    .where(and(eq(alert.key, input.key), isNull(alert.resolvedAt)))
    .returning({ id: alert.id, occurrences: alert.occurrences });
  if (bumped[0]) {
    return { id: bumped[0].id, outcome: 'repeated', occurrences: bumped[0].occurrences };
  }

  const since = new Date(now.getTime() - opts.flapWindowSeconds * 1000);
  const [recent] = await db
    .select({ id: alert.id })
    .from(alert)
    .where(and(eq(alert.key, input.key), gte(alert.resolvedAt, since)))
    .orderBy(desc(alert.resolvedAt))
    .limit(1);
  if (recent) {
    // Conditional on still being resolved: two watchdogs in the same second
    // must not both reopen it, and the partial unique index would refuse the
    // second anyway.
    const reopened = await db
      .update(alert)
      .set({
        status: 'open',
        resolvedAt: null,
        resolvedReason: null,
        lastSeenAt: now,
        occurrences: sql`occurrences + 1`,
        reopenCount: sql`reopen_count + 1`,
        severity,
        summary: input.summary,
        detail,
        updatedAt: now,
      })
      .where(and(eq(alert.id, recent.id), sql`resolved_at is not null`))
      .returning({ id: alert.id, occurrences: alert.occurrences });
    if (reopened[0]) {
      return { id: reopened[0].id, outcome: 'reopened', occurrences: reopened[0].occurrences };
    }
  }

  const id = newId();
  await db.insert(alert).values({
    id,
    key: input.key,
    category: input.category,
    severity,
    status: 'open',
    subject: input.subject,
    summary: input.summary,
    detail,
    operatorId: input.operatorId ?? null,
    branchId: input.branchId ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
  });
  return { id, outcome: 'opened', occurrences: 1 };
}

export interface ResolvedAlert {
  id: string;
  /** Whether anyone was ever told it opened — if not, nobody needs telling it closed. */
  wasNotified: boolean;
}

/** Close a condition that has stopped being true. Silent if it was not open. */
export async function resolveAlert(
  db: Db,
  key: string,
  reason: string,
): Promise<ResolvedAlert | null> {
  const now = new Date();
  const [row] = await db
    .update(alert)
    .set({ status: 'resolved', resolvedAt: now, resolvedReason: reason, updatedAt: now })
    .where(and(eq(alert.key, key), isNull(alert.resolvedAt)))
    .returning({ id: alert.id, lastNotifiedAt: alert.lastNotifiedAt });
  if (!row) return null;
  return { id: row.id, wasNotified: row.lastNotifiedAt !== null };
}

// --- Delivery ---------------------------------------------------------------

export interface AlertMessage {
  alertId: string;
  key: string;
  category: string;
  severity: AlertSeverity;
  subject: string;
  summary: string;
  event: AlertDeliveryEvent;
}

/**
 * Where an alert goes. The console channel is the one built today; a webhook
 * and an email channel are the same three lines each, and the reason they are
 * not here yet is that nobody has said which address they should reach
 * (OPEN_QUESTIONS §4).
 *
 * `target` is a label for the record — `console`, a webhook's host — never a
 * URL. A Slack or LINE webhook URL is a bearer credential.
 */
export interface AlertChannel {
  readonly name: string;
  deliver(message: AlertMessage): Promise<{ target?: string }>;
}

export function consoleAlertChannel(log: FastifyBaseLogger): AlertChannel {
  return {
    name: 'console',
    async deliver(message) {
      const line = {
        alertId: message.alertId,
        alertKey: message.key,
        category: message.category,
        severity: message.severity,
        subject: message.subject,
        event: message.event,
      };
      if (message.severity === 'critical') log.error(line, message.summary);
      else log.warn(line, message.summary);
      return { target: 'console' };
    },
  };
}

const CHANNEL_BUILDERS: Record<string, (log: FastifyBaseLogger) => AlertChannel> = {
  console: consoleAlertChannel,
};

/**
 * Build the channels this deployment asked for, and refuse the ones that do
 * not exist yet.
 *
 * Refusing at boot rather than dropping the message is the point of the whole
 * ticket: a channel configured to an implementation that was never written
 * would deliver nothing, report nothing, and look configured — which is the
 * precise failure mode everything here exists to make impossible.
 */
export function buildAlertChannels(channels: string, log: FastifyBaseLogger): AlertChannel[] {
  const names = channels
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return names.map((name) => {
    const build = CHANNEL_BUILDERS[name];
    if (!build) {
      throw new Error(
        `ALERT_CHANNELS names "${name}", which has no implementation on this build. ` +
          `Available: ${Object.keys(CHANNEL_BUILDERS).join(', ')}.`,
      );
    }
    return build(log);
  });
}

/**
 * Attempt every channel and record every attempt. A channel that throws is
 * recorded and stepped over: an alert nobody could deliver must not take down
 * the watchdog that raised it, which is the only thing still watching.
 */
export async function deliverAlert(
  db: Db,
  channels: AlertChannel[],
  message: AlertMessage,
  log?: FastifyBaseLogger,
): Promise<void> {
  let anySent = false;
  for (const channel of channels) {
    const startedAt = Date.now();
    try {
      const { target } = await channel.deliver(message);
      anySent = true;
      await db.insert(alertDelivery).values({
        id: newId(),
        alertId: message.alertId,
        channel: channel.name,
        event: message.event,
        status: 'sent',
        target: target ?? channel.name,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const info = errorInfo(err);
      log?.error({ channel: channel.name, alertKey: message.key, code: info.code }, 'alert delivery failed');
      await db.insert(alertDelivery).values({
        id: newId(),
        alertId: message.alertId,
        channel: channel.name,
        event: message.event,
        status: 'failed',
        target: channel.name,
        error: `${info.code}: ${info.message}`.slice(0, MAX_STRING),
        durationMs: Date.now() - startedAt,
      });
    }
  }
  if (anySent) {
    await db.update(alert).set({ lastNotifiedAt: new Date() }).where(eq(alert.id, message.alertId));
  }
}

// --- Retention --------------------------------------------------------------

/**
 * `ops_run` grows faster than anything else in the database — one row per
 * failed request, per job run, per device call — so it is the one table that
 * must prune itself from the day it exists. `job:housekeeping.retention` calls
 * this hourly with `OPS_RUN_RETENTION_DAYS`.
 *
 * `ops_last` and `ops_expectation` are never pruned: there is one row per
 * named thing, a few dozen in total, and they are the answer to "is this
 * healthy" long after the runs behind them are gone.
 */
export async function purgeOldOpsRuns(db: Db, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const gone = await db.delete(opsRun).where(lt(opsRun.startedAt, cutoff)).returning({ id: opsRun.id });
  return gone.length;
}

/** Resolved alerts age out with their runs; open ones stay until they close. */
export async function purgeResolvedAlerts(db: Db, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const gone = await db
    .delete(alert)
    .where(and(lt(alert.resolvedAt, cutoff), sql`resolved_at is not null`))
    .returning({ id: alert.id });
  return gone.length;
}

// --- Reading it back --------------------------------------------------------
//
// Everything below answers the Console's Health and Failures pages. Two rules
// hold here, and both are stricter than the write path's:
//
//  - **a read must not be able to take the service down.** Every probe carries
//    a deadline and degrades to `unknown` rather than throwing. A Health page
//    that answers 500 because one counter was slow reports nothing at the exact
//    moment somebody needs it to report something — the same reasoning
//    `routes/health.ts` states for `/ready`;
//  - **nothing personal leaves here.** These pages are read by whoever is on
//    call, on a screen in a back office. Names, phones and credentials are not
//    masked on the way out; they are never selected in the first place.

/** Same deadline `/ready` gives its probes: shorter than the pool's own wait. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Run a probe, and answer with `fallback` if it fails or is slow. The work
 * itself is not cancelled — a query already in flight will finish into a
 * connection nobody is waiting on, which costs far less than a page that
 * cannot render.
 */
export async function probe<T>(work: () => Promise<T>, fallback: T, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), ms);
        timer.unref();
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export type HealthState = 'ok' | 'warn' | 'down' | 'unknown';

export interface HealthCheck {
  key: string;
  label: string;
  status: HealthState;
  /** A number worth showing on the tile — a latency, an age, a queue depth. */
  value?: number | string | null;
  unit?: string | null;
  detail?: string | null;
}

export interface JobStatus {
  name: string;
  status: HealthState;
  /** When it last finished, whatever the outcome. Null if it never has. */
  lastRunAt: string | null;
  lastOutcome: string | null;
  expectedEverySeconds: number | null;
  /** Seconds since it last finished — so "runs and fails" reads differently
   *  from "stopped running", which are two different problems. */
  ageSeconds: number | null;
  lastError: string | null;
}

export interface AlertRow {
  id: string;
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  count: number;
}

export interface HealthSnapshot {
  status: HealthState;
  checks: HealthCheck[];
  jobs: JobStatus[];
  alerts: AlertRow[];
  watchdogAgeSeconds: number | null;
  generatedAt: string;
}

interface PoolState {
  total: number;
  idle: number;
  waiting: number;
  max: number | null;
}

/**
 * node-postgres pool counters. `/ready` reports the same three and keeps its
 * own copy of this (routes/health.ts): a service must not import from a route,
 * and the readiness probe must not acquire a dependency on anything that can
 * grow.
 */
function poolState(db: Db): PoolState | null {
  const client = (db as { $client?: unknown }).$client as
    | { totalCount?: number; idleCount?: number; waitingCount?: number; options?: { max?: number } }
    | undefined;
  if (!client || typeof client.totalCount !== 'number') return null;
  return {
    total: client.totalCount,
    idle: client.idleCount ?? 0,
    waiting: client.waitingCount ?? 0,
    max: client.options?.max ?? null,
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function secondsSince(value: Date | null | undefined, now: number): number | null {
  if (!value) return null;
  return Math.max(0, Math.round((now - value.getTime()) / 1000));
}

export interface HealthDeps {
  db: Db;
  /** Alerts are filtered to this operator, plus the platform-wide ones. */
  operatorId: string;
  /** `WATCHDOG_JOB` — passed in rather than imported, or services/jobs.ts and
   *  this file would import each other. */
  watchdogJob: string;
  watchdogIntervalSeconds: number;
  /** `ALERT_FAILURE_THRESHOLD`: failures in a row before a job reads as down. */
  failureThreshold: number;
}

/**
 * How late the watchdog may be before the tile says so, in runs rather than in
 * seconds — three missed ones is a runner that has stopped, where one is a
 * runner that is busy. The same rule `/ready` applies, so the two never
 * disagree about the same number.
 */
const WATCHDOG_STALE_AFTER_RUNS = 3;

/**
 * The job register: every job the platform expects, with when it last ran and
 * how late it is.
 *
 * Read from `ops_expectation` and `ops_last` — the DATABASE — and never from
 * the in-process runner. An api instance that does not carry the `jobs` role
 * still has to answer this correctly, and a runner that has stopped cannot be
 * asked whether it has stopped. It is the same argument `/ready` already makes
 * for the watchdog's age.
 */
export async function jobRegister(deps: HealthDeps, now = Date.now()): Promise<JobStatus[]> {
  const { db, failureThreshold } = deps;
  const expectations = await db.select().from(opsExpectation);
  const lasts = await db.select().from(opsLast);
  const lastByName = new Map(lasts.map((l) => [l.name, l]));

  /**
   * The message behind the code, from the run `ops_last` points at. One extra
   * query for the whole register rather than one per job — and it tolerates
   * the run having been pruned since, which `ops_last` survives by design.
   */
  const runIds = lasts.map((l) => l.lastRunId).filter((id): id is string => Boolean(id));
  const messages = new Map<string, string | null>();
  if (runIds.length > 0) {
    const rows = await db
      .select({ id: opsRun.id, errorCode: opsRun.errorCode, errorMessage: opsRun.errorMessage })
      .from(opsRun)
      .where(inArray(opsRun.id, runIds));
    for (const row of rows) messages.set(row.id, row.errorMessage ?? row.errorCode);
  }

  const status = (
    expectation: (typeof expectations)[number] | undefined,
    last: (typeof lasts)[number] | undefined,
  ): HealthState => {
    // Something that runs and is not declared cannot be late — nothing said
    // when it was due. All this row can report is its last outcome.
    if (!expectation) return last?.lastOutcome === 'failed' ? 'warn' : 'ok';
    // A rule somebody turned off, or muted for a maintenance window, is not a
    // fault. It is still worth showing, which is why it is not filtered out.
    if (!expectation.enabled) return 'unknown';
    if (expectation.mutedUntil && expectation.mutedUntil.getTime() > now) return 'unknown';
    /**
     * Late is measured from the last SUCCESS, with the expectation's own
     * creation as the baseline when there has never been one — exactly what
     * `runWatchdog` measures, so the page and the alert can never disagree
     * about whether something is overdue.
     */
    const since = last?.lastOkAt ?? expectation.createdAt;
    const dueBy = since.getTime() + (expectation.intervalSeconds + expectation.graceSeconds) * 1000;
    if (now > dueBy) return expectation.severity === 'critical' ? 'down' : 'warn';
    if (last && last.consecutiveFailures >= failureThreshold) return 'down';
    if (last?.lastOutcome === 'failed') return 'warn';
    if (!last) return 'unknown'; // declared, not yet due, never run
    return 'ok';
  };

  const row = (
    name: string,
    expectation: (typeof expectations)[number] | undefined,
    last: (typeof lasts)[number] | undefined,
  ): JobStatus => ({
    name,
    status: status(expectation, last),
    lastRunAt: iso(last?.lastFinishedAt ?? last?.lastStartedAt ?? null),
    lastOutcome: last?.lastOutcome ?? null,
    expectedEverySeconds: expectation?.intervalSeconds ?? null,
    ageSeconds: secondsSince(last?.lastFinishedAt ?? last?.lastStartedAt ?? null, now),
    lastError: last?.lastRunId ? (messages.get(last.lastRunId) ?? last.errorCode) : (last?.errorCode ?? null),
  });

  const declared = expectations.map((e) => row(e.name, e, lastByName.get(e.name)));
  /**
   * Jobs that have run without declaring an expectation. They are the blind
   * spot the watchdog cannot see — nothing said when they were due, so nothing
   * can notice their silence — which is precisely why they belong on this list
   * rather than off it.
   */
  const declaredNames = new Set(expectations.map((e) => e.name));
  const undeclared = lasts
    .filter((l) => l.kind === 'job' && !declaredNames.has(l.name))
    .map((l) => row(l.name, undefined, l));

  return [...declared, ...undeclared].sort((a, b) => a.name.localeCompare(b.name));
}

/** Open alerts for this operator, plus the platform-wide ones (operator null). */
export async function openAlerts(deps: HealthDeps, limit = 50): Promise<AlertRow[]> {
  const rows = await deps.db
    .select()
    .from(alert)
    .where(
      and(
        isNull(alert.resolvedAt),
        or(isNull(alert.operatorId), eq(alert.operatorId, deps.operatorId)),
      ),
    )
    .orderBy(desc(alert.lastSeenAt))
    .limit(limit);

  return rows.map((a) => ({
    id: a.id,
    key: a.key,
    severity: a.severity,
    // The summary is the sentence somebody can act on; the subject is the
    // thing it is about. Neither is ever a person.
    title: a.summary,
    detail: [a.subject, a.reopenCount > 0 ? `recovered and broke again ${a.reopenCount}×` : null]
      .filter(Boolean)
      .join(' · '),
    openedAt: iso(a.firstSeenAt)!,
    acknowledgedAt: iso(a.acknowledgedAt),
    resolvedAt: iso(a.resolvedAt),
    count: a.occurrences,
  }));
}

/** The dependency tiles: what each reported on the last check. */
export async function healthChecks(deps: HealthDeps, now = Date.now()): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  /**
   * No `api` tile here on purpose. The Console mints that one itself from its
   * own round trip to `/ready` and prepends it, so a second tile under the
   * same key would be a duplicate row — and a duplicate React key.
   */
  const started = Date.now();
  const databaseOk = await probe(
    async () => {
      await deps.db.execute(sql`select 1`);
      return true;
    },
    false,
  );
  checks.push({
    key: 'database',
    label: 'Database',
    status: databaseOk ? 'ok' : 'down',
    value: Date.now() - started,
    unit: 'ms',
    detail: databaseOk ? null : 'the probe did not answer',
  });

  const pool = poolState(deps.db);
  checks.push(
    pool
      ? {
          key: 'pool',
          label: 'Connection pool',
          // Something waiting for a connection is not yet a fault, but it is
          // the first sign of one and it is invisible in every other number.
          status: pool.waiting > 0 ? 'warn' : 'ok',
          value: pool.max ? `${pool.total}/${pool.max}` : String(pool.total),
          detail: `${pool.idle} idle, ${pool.waiting} waiting`,
        }
      : { key: 'pool', label: 'Connection pool', status: 'unknown', value: null, detail: 'the driver does not report counters' },
  );

  const watchdog = await probe(
    () =>
      deps.db
        .select({ lastOkAt: opsLast.lastOkAt })
        .from(opsLast)
        .where(eq(opsLast.name, deps.watchdogJob))
        .limit(1),
    null as { lastOkAt: Date | null }[] | null,
  );
  const staleAfterS = deps.watchdogIntervalSeconds * WATCHDOG_STALE_AFTER_RUNS;
  const ageS = watchdog?.[0] ? secondsSince(watchdog[0].lastOkAt, now) : null;
  checks.push({
    key: 'watchdog',
    label: 'Watchdog',
    // Never reported is not the same as late: on an instance with no jobs role
    // and an empty register, there is nothing to be late.
    status: watchdog === null ? 'unknown' : ageS === null ? 'unknown' : ageS > staleAfterS ? 'warn' : 'ok',
    value: ageS,
    unit: ageS === null ? null : 's',
    detail:
      watchdog === null
        ? 'the register could not be read'
        : ageS === null
          ? 'the job runner has never reported here'
          : `late after ${staleAfterS}s`,
  });

  return checks;
}

/**
 * One verdict for the page. `down` is kept for something that is actually
 * broken — a dependency failing, a job the watchdog calls critical, an open
 * critical alert — so that the loudest state stays worth reacting to.
 */
function overallStatus(checks: HealthCheck[], jobs: JobStatus[], alerts: AlertRow[]): HealthState {
  if (checks.some((c) => c.status === 'down') || jobs.some((j) => j.status === 'down')) return 'down';
  if (alerts.some((a) => a.severity === 'critical' && !a.acknowledgedAt)) return 'down';
  if (checks.some((c) => c.status === 'warn') || jobs.some((j) => j.status === 'warn')) return 'warn';
  if (alerts.some((a) => !a.acknowledgedAt)) return 'warn';
  return 'ok';
}

/** Everything the Health page reads, in one answer. */
export async function healthSnapshot(deps: HealthDeps): Promise<HealthSnapshot> {
  const now = Date.now();
  // Sequential rather than parallel: these share one small pool, and a health
  // page must never be the reason a till waits for a connection.
  const checks = await healthChecks(deps, now);
  const jobs = await probe(() => jobRegister(deps, now), [] as JobStatus[]);
  const alerts = await probe(() => openAlerts(deps), [] as AlertRow[]);
  const watchdogCheck = checks.find((c) => c.key === 'watchdog');

  return {
    status: overallStatus(checks, jobs, alerts),
    checks,
    jobs,
    alerts,
    watchdogAgeSeconds: typeof watchdogCheck?.value === 'number' ? watchdogCheck.value : null,
    generatedAt: new Date(now).toISOString(),
  };
}

// --- Failures ---------------------------------------------------------------

export interface FailureGroup {
  fingerprint: string;
  kind: string;
  name: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastError: string | null;
  lastRunId: string | null;
  /** False for anything whose re-run is not safe to start from a console. */
  retryable: boolean;
  branchId: string | null;
  stationId: string | null;
  actionId: string | null;
  requestId: string | null;
}

export interface FailurePage {
  groups: FailureGroup[];
  nextCursor: string | null;
  /** Failures in the window that carry no fingerprint, so cannot be grouped. */
  ungrouped?: number;
}

export interface FailureQuery {
  operatorId: string;
  windowHours: number;
  kind?: string;
  cursor?: string;
  limit: number;
}

/**
 * The cursor is the sort key itself — the last group's newest failure and its
 * fingerprint — so a page resumes exactly where the previous one stopped even
 * as new failures arrive. Same shape as the audit log's (routes/audit.ts).
 */
function encodeGroupCursor(lastSeenAt: string, fingerprint: string): string {
  return Buffer.from(`${lastSeenAt}|${fingerprint}`, 'utf8').toString('base64url');
}

function decodeGroupCursor(raw: string): { lastSeenAt: string; fingerprint: string } {
  const [lastSeenAt, fingerprint] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!lastSeenAt || !fingerprint || Number.isNaN(Date.parse(lastSeenAt))) {
    throw new AppError(400, 'BAD_REQUEST', 'Invalid cursor');
  }
  return { lastSeenAt, fingerprint };
}

/**
 * Row-wise comparison on the sort key, which is what makes the tie-break free:
 * groups sharing a last-seen timestamp still have a total order.
 */
function groupCursorClause(c: { lastSeenAt: string; fingerprint: string }): SQL {
  return sql`(max(${opsRun.startedAt}), ${opsRun.fingerprint}) < (${c.lastSeenAt}::timestamptz, ${c.fingerprint})`;
}

/**
 * `(array_agg(x order by started_at desc))[1]` — the newest value in the
 * group: the last error, the run a retry would re-run, and the ids that make
 * one failure findable in the audit log beside it.
 */
function newestOf<T>(column: SQLWrapper): SQL<T | null> {
  return sql<T | null>`(array_agg(${column} order by ${opsRun.startedAt} desc))[1]`;
}

/** `code: message`, both already scrubbed on write. Either may be absent. */
function errorLine(code: string | null, message: string | null): string | null {
  if (code && message) return `${code}: ${message}`;
  return code ?? message ?? null;
}

/**
 * Everything that failed in the window, grouped by fingerprint.
 *
 * The grouping is the point of the page. One printer that cannot be reached
 * writes a failure every thirty seconds; as sixty rows it reads as sixty
 * problems and buries the one other thing that broke this afternoon. As one
 * row with a count of sixty it reads as what it is — and the count is the
 * number that separates "happened once" from "happening continuously".
 *
 * Only `failed` rows are here. A `skipped` run is a run that declined to
 * happen — a job whose tick another instance had already claimed — which is
 * worth recording and is emphatically not a failure.
 */
export async function failureGroups(db: Db, q: FailureQuery): Promise<FailurePage> {
  const since = new Date(Date.now() - q.windowHours * 3_600_000);
  const clauses: SQL[] = [
    eq(opsRun.outcome, 'failed'),
    gte(opsRun.startedAt, since),
    isNotNull(opsRun.fingerprint),
    // A run belongs to this operator or to the platform (a job, a sweep, an
    // uncaught exception — none of which has a tenant).
    or(isNull(opsRun.operatorId), eq(opsRun.operatorId, q.operatorId))!,
  ];
  if (q.kind) clauses.push(eq(opsRun.kind, q.kind as OpsKind));

  const cursorClause = q.cursor ? groupCursorClause(decodeGroupCursor(q.cursor)) : undefined;

  const rows = await db
    .select({
      fingerprint: sql<string>`${opsRun.fingerprint}`,
      kind: newestOf<string>(opsRun.kind),
      name: newestOf<string>(opsRun.name),
      count: sql<number>`count(*)::int`,
      firstSeenAt: sql<Date>`min(${opsRun.startedAt})`,
      lastSeenAt: sql<Date>`max(${opsRun.startedAt})`,
      errorCode: newestOf<string>(opsRun.errorCode),
      errorMessage: newestOf<string>(opsRun.errorMessage),
      lastRunId: newestOf<string>(opsRun.id),
      branchId: newestOf<string>(opsRun.branchId),
      stationId: newestOf<string>(opsRun.stationId),
      actionId: newestOf<string>(opsRun.actionId),
      requestId: newestOf<string>(opsRun.requestId),
    })
    .from(opsRun)
    .where(and(...clauses))
    .groupBy(opsRun.fingerprint)
    .having(cursorClause)
    .orderBy(sql`max(${opsRun.startedAt}) desc`, sql`${opsRun.fingerprint} desc`)
    .limit(q.limit);

  const groups: FailureGroup[] = rows.map((r) => ({
    fingerprint: r.fingerprint,
    // Neither can actually be null — both columns are NOT NULL and a group has
    // at least one row — but a fallback that guesses would put a wrong word on
    // the page, so it says so instead.
    kind: r.kind ?? 'unknown',
    name: r.name ?? 'unknown',
    count: r.count,
    firstSeenAt: iso(r.firstSeenAt)!,
    lastSeenAt: iso(r.lastSeenAt)!,
    lastError: errorLine(r.errorCode, r.errorMessage),
    lastRunId: r.lastRunId,
    // Only a scheduled job is safe to start again from here. Anything that
    // took money, printed, opened a gate or told a device to do something has
    // already half-happened, and re-running it turns one failure into two
    // events.
    retryable: r.kind === 'job',
    branchId: r.branchId,
    stationId: r.stationId,
    actionId: r.actionId,
    requestId: r.requestId,
  }));

  const last = groups[groups.length - 1];
  const page: FailurePage = {
    groups,
    // A short page is the last page; a full one may not be.
    nextCursor:
      groups.length === q.limit && last ? encodeGroupCursor(last.lastSeenAt, last.fingerprint) : null,
  };

  // Only worth the second scan on the first page: it is a property of the
  // window, not of the page, and paging does not change it.
  if (!q.cursor) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(opsRun)
      .where(
        and(
          eq(opsRun.outcome, 'failed'),
          gte(opsRun.startedAt, since),
          isNull(opsRun.fingerprint),
          or(isNull(opsRun.operatorId), eq(opsRun.operatorId, q.operatorId))!,
        ),
      );
    page.ungrouped = row?.count ?? 0;
  }

  return page;
}

export interface OpsRunRow {
  id: string;
  kind: string;
  name: string;
  outcome: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  fingerprint: string | null;
  requestId: string | null;
  actionId: string | null;
  branchId: string | null;
  stationId: string | null;
}

/** The individual runs behind one group, newest first. */
export async function runsForFingerprint(
  db: Db,
  q: { operatorId: string; fingerprint: string; limit: number },
): Promise<OpsRunRow[]> {
  const rows = await db
    .select()
    .from(opsRun)
    .where(
      and(
        eq(opsRun.fingerprint, q.fingerprint),
        or(isNull(opsRun.operatorId), eq(opsRun.operatorId, q.operatorId))!,
      ),
    )
    .orderBy(desc(opsRun.startedAt))
    .limit(q.limit);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    outcome: r.outcome,
    startedAt: iso(r.startedAt)!,
    finishedAt: iso(r.finishedAt),
    durationMs: r.durationMs,
    error: errorLine(r.errorCode, r.errorMessage),
    fingerprint: r.fingerprint,
    requestId: r.requestId,
    actionId: r.actionId,
    branchId: r.branchId,
    stationId: r.stationId,
  }));
}

/** One run, for the retry route to decide what it is being asked to re-run. */
export async function findRun(db: Db, id: string) {
  const [row] = await db.select().from(opsRun).where(eq(opsRun.id, id)).limit(1);
  return row ?? null;
}

/**
 * Take an alert. Not a resolution: acknowledging says somebody is on it, and
 * the condition stops being true when the thing recovers and the watchdog
 * closes it — which is the only honest way for it to close.
 */
export async function acknowledgeAlert(
  exec: Exec,
  id: string,
  accountId: string,
): Promise<{ id: string; key: string } | null> {
  const now = new Date();
  const [row] = await exec
    .update(alert)
    .set({ status: 'acknowledged', acknowledgedAt: now, acknowledgedByAccountId: accountId, updatedAt: now })
    .where(and(eq(alert.id, id), isNull(alert.resolvedAt), isNull(alert.acknowledgedAt)))
    .returning({ id: alert.id, key: alert.key });
  return row ?? null;
}

// --- Integrations -----------------------------------------------------------
//
// The outside services this platform leans on, and what each is doing. NAMES
// AND STATES ONLY: a provider is configured or it is not, and where it is not,
// what is named is the VARIABLE that is unset — never its value, never a
// partial value, never a masked one. A masked secret on a screen is still a
// secret on a screen, and this page is read over shoulders in a back office.

export type IntegrationState = 'configured' | 'missing' | 'disabled' | 'degraded' | 'unknown';

export interface IntegrationProvider {
  key: string;
  name: string;
  purpose: string;
  category: string;
  state: IntegrationState;
  /** Unset variables, by NAME. */
  missingVars?: string[];
  /** A public address only — a host we call, never anything bearing a token. */
  endpoint?: string | null;
  lastDeliveryAt?: string | null;
  lastDeliveryOutcome?: string | null;
  detail?: string | null;
}

export interface EnvVariable {
  name: string;
  present: boolean;
  required: boolean;
  purpose: string;
  provider: string | null;
}

export interface IntegrationsSnapshot {
  providers: IntegrationProvider[];
  variables: EnvVariable[];
}

/**
 * Whether this deployment has been given a value for a variable — read from
 * the process environment by NAME, never by value, and never from any file.
 *
 * Deliberately not `env.X`: half of those carry a default, so a parsed value
 * cannot tell "somebody set this" from "nobody did and the schema filled it
 * in", and "what still has to be provisioned" is exactly the first question.
 */
function isSet(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

export interface IntegrationDeps {
  db: Db;
  env: {
    DEPLOY_ENV: string;
    SMS_ADAPTER: string;
    ALERT_CHANNELS: string;
    PROCESS_ROLES: string;
    MINIO_ENDPOINT: string;
    MINIO_PORT: number;
    MINIO_USE_SSL: boolean;
    SENTRY_DSN?: string;
  };
  /** Null when this instance was built without object storage. */
  storage: { probe(): Promise<{ state: string; reason?: string }> } | null;
  watchdogJob: string;
}

/** The Twilio variables, by name, that a complete credential needs. */
function twilioMissing(): string[] {
  const missing: string[] = [];
  // Required in both shapes: it names the account in the URL path rather than
  // authenticating, so an API key does not replace it (services/sms.ts).
  if (!isSet('TWILIO_ACCOUNT_SID')) missing.push('TWILIO_ACCOUNT_SID');
  if (!isSet('TWILIO_FROM')) missing.push('TWILIO_FROM');
  const key = isSet('TWILIO_API_KEY_SID') && isSet('TWILIO_API_KEY_SECRET');
  if (!key && !isSet('TWILIO_AUTH_TOKEN')) {
    missing.push(isSet('TWILIO_API_KEY_SID') ? 'TWILIO_API_KEY_SECRET' : 'TWILIO_API_KEY_SID');
  }
  return missing;
}

export async function integrationsSnapshot(deps: IntegrationDeps): Promise<IntegrationsSnapshot> {
  const { env } = deps;
  const providers: IntegrationProvider[] = [];

  /**
   * The last time an adapter was exercised, from the operational record.
   * Nothing writes an `adapter:sms.send` row today, so the SMS card simply
   * has no delivery to show — and starts showing one the day a send is
   * recorded, without this file changing.
   */
  const names = ['adapter:sms.send', deps.watchdogJob];
  const lasts = await probe(
    () => deps.db.select().from(opsLast).where(inArray(opsLast.name, names)),
    [] as Array<{ name: string; lastOutcome: string; lastFinishedAt: Date | null; lastStartedAt: Date }>,
  );
  const lastByName = new Map(lasts.map((l) => [l.name, l]));
  const lastOf = (name: string) => {
    const row = lastByName.get(name);
    if (!row) return { lastDeliveryAt: null, lastDeliveryOutcome: null };
    return {
      lastDeliveryAt: iso(row.lastFinishedAt ?? row.lastStartedAt),
      lastDeliveryOutcome: row.lastOutcome,
    };
  };

  // --- SMS
  const smsMissing = env.SMS_ADAPTER === 'twilio' ? twilioMissing() : [];
  providers.push({
    key: 'sms',
    name: env.SMS_ADAPTER === 'twilio' ? 'SMS — Twilio' : `SMS — ${env.SMS_ADAPTER}`,
    purpose: 'Verification codes for account setup and password recovery.',
    category: 'Messaging',
    state:
      env.SMS_ADAPTER === 'twilio'
        ? smsMissing.length === 0
          ? 'configured'
          : 'missing'
        : env.SMS_ADAPTER === 'console'
          ? // Genuinely how a code is delivered on a developer's machine, and a
            // configuration error anywhere else — which `assertProductionSafe`
            // already refuses at boot.
            env.DEPLOY_ENV === 'local'
            ? 'configured'
            : 'degraded'
          : 'unknown',
    missingVars: smsMissing.length > 0 ? smsMissing : undefined,
    endpoint: env.SMS_ADAPTER === 'twilio' ? 'api.twilio.com' : null,
    detail:
      env.SMS_ADAPTER === 'console'
        ? 'Codes are written to the api log, not sent. A local machine only.'
        : null,
    ...lastOf('adapter:sms.send'),
  });

  // --- Object storage
  /**
   * Six seconds, one longer than the storage client's own deadline, so the
   * inner one wins and the card can say WHY it did not answer rather than
   * only that something took too long.
   */
  const storageProbe = deps.storage
    ? await probe(() => deps.storage!.probe(), { state: 'unreachable', reason: 'probe timed out' }, 6_000)
    : null;
  providers.push({
    key: 'storage',
    name: 'Object storage (S3)',
    purpose: 'Profile photos and every uploaded file, behind short-lived signed URLs.',
    category: 'Storage',
    state: !storageProbe
      ? 'disabled'
      : storageProbe.state === 'ready'
        ? 'configured'
        : 'degraded',
    // Host and port only. The keys are what make this reachable, and they are
    // not on this page in any form.
    endpoint: `${env.MINIO_ENDPOINT}:${env.MINIO_PORT}${env.MINIO_USE_SSL ? ' (TLS)' : ''}`,
    detail: !storageProbe
      ? 'This instance was built without object storage.'
      : storageProbe.state === 'no-bucket'
        ? 'The bucket does not exist, or this credential may not ask.'
        : storageProbe.state === 'unreachable'
          ? `Did not answer: ${storageProbe.reason ?? 'unknown'}`
          : null,
  });

  // --- The job runner
  const roles = env.PROCESS_ROLES.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
  const carriesJobs = roles.includes('jobs');
  providers.push({
    key: 'jobs',
    name: 'Scheduled jobs',
    purpose: 'The sweeps and the watchdog that notices when something stopped running.',
    category: 'Platform',
    state: carriesJobs ? 'configured' : 'disabled',
    detail: carriesJobs
      ? `This process carries: ${roles.join(', ')}.`
      : `PROCESS_ROLES does not name jobs on this process (${roles.join(', ') || 'none'}), so another one runs them.`,
    ...lastOf(deps.watchdogJob),
  });

  // --- Alert channels
  const channels = env.ALERT_CHANNELS.split(',').map((c) => c.trim()).filter(Boolean);
  const lastDelivery = await probe(
    () =>
      deps.db
        .select({
          channel: alertDelivery.channel,
          status: alertDelivery.status,
          attemptedAt: alertDelivery.attemptedAt,
        })
        .from(alertDelivery)
        .orderBy(desc(alertDelivery.attemptedAt))
        .limit(1),
    [] as Array<{ channel: string; status: string; attemptedAt: Date }>,
  );
  providers.push({
    key: 'alerts',
    name: 'Alert channels',
    purpose: 'Where an alert goes when the watchdog raises one.',
    category: 'Platform',
    state: channels.length === 0 ? 'disabled' : 'configured',
    detail:
      channels.length === 0
        ? 'ALERT_CHANNELS is empty — an alert would be raised and delivered nowhere.'
        : `Delivering to: ${channels.join(', ')}.` +
          (channels.every((c) => c === 'console')
            ? ' The console channel writes to the api log, which nobody is watching at 9pm.'
            : ''),
    lastDeliveryAt: iso(lastDelivery[0]?.attemptedAt ?? null),
    lastDeliveryOutcome: lastDelivery[0] ? `${lastDelivery[0].channel} · ${lastDelivery[0].status}` : null,
  });

  // --- Error reporting
  providers.push({
    key: 'sentry',
    name: 'Error reporting (Sentry)',
    purpose: 'Where an unhandled server error is reported, with its stack.',
    category: 'Platform',
    state: env.SENTRY_DSN ? 'configured' : 'disabled',
    missingVars: env.SENTRY_DSN ? undefined : ['SENTRY_DSN'],
    detail: env.SENTRY_DSN ? null : 'Unset, so the reporter is a no-op and errors go to the log only.',
  });

  const onDeployment = env.DEPLOY_ENV !== 'local';
  const twilio = env.SMS_ADAPTER === 'twilio';
  const variables: EnvVariable[] = [
    { name: 'DATABASE_URL', required: true, provider: null, purpose: 'The database this deployment reads and writes.' },
    { name: 'ALLOWED_ORIGINS', required: onDeployment, provider: null, purpose: 'Browser origins allowed to send a state-changing request.' },
    { name: 'SMS_ADAPTER', required: true, provider: 'sms', purpose: 'Which SMS adapter delivers verification codes.' },
    { name: 'TWILIO_ACCOUNT_SID', required: twilio, provider: 'sms', purpose: 'Names the Twilio account in the request path.' },
    { name: 'TWILIO_API_KEY_SID', required: false, provider: 'sms', purpose: 'The credential shape to prefer — revoked and rotated on its own.' },
    { name: 'TWILIO_API_KEY_SECRET', required: false, provider: 'sms', purpose: 'The other half of the API key.' },
    { name: 'TWILIO_AUTH_TOKEN', required: false, provider: 'sms', purpose: 'The account master password — the fallback when no API key exists.' },
    { name: 'TWILIO_FROM', required: twilio, provider: 'sms', purpose: 'The sending number, or a Messaging Service SID.' },
    { name: 'MINIO_ENDPOINT', required: onDeployment, provider: 'storage', purpose: 'The bare S3 host — no scheme, no path.' },
    { name: 'MINIO_PORT', required: onDeployment, provider: 'storage', purpose: '443 for an S3 endpoint over TLS.' },
    { name: 'MINIO_USE_SSL', required: onDeployment, provider: 'storage', purpose: 'A presigned URL is a bearer credential; it must not travel in the clear.' },
    { name: 'MINIO_ACCESS_KEY', required: onDeployment, provider: 'storage', purpose: 'Object storage credential.' },
    { name: 'MINIO_SECRET_KEY', required: onDeployment, provider: 'storage', purpose: 'Object storage credential.' },
    { name: 'MINIO_BUCKET', required: onDeployment, provider: 'storage', purpose: 'The bucket uploads land in. Created by a person, never by the api.' },
    { name: 'MINIO_REGION', required: false, provider: 'storage', purpose: 'Signing region — "auto" for Cloudflare R2.' },
    { name: 'HANDOFF_SIGNING_KEY', required: false, provider: null, purpose: 'Signs the suite hand-off; empty means the launcher hand-off is off.' },
    { name: 'HANDOFF_APP_ORIGINS', required: false, provider: null, purpose: 'Where each app lives, so a token for the till cannot be spent on the console.' },
    { name: 'ALERT_CHANNELS', required: false, provider: 'alerts', purpose: 'Where an alert is delivered. Console until a channel is chosen.' },
    { name: 'SENTRY_DSN', required: false, provider: 'sentry', purpose: 'Error reporting. A no-op while unset.' },
  ].map((v) => ({ ...v, present: isSet(v.name) }));

  return { providers, variables };
}
