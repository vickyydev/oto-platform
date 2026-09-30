import { redact } from '@oto/telemetry';
import { createHash } from 'node:crypto';
import {
  and,
  asc,
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
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FastifyBaseLogger } from 'fastify';
import {
  alert,
  alertDelivery,
  box,
  branch,
  device,
  opsExpectation,
  opsLast,
  opsRun,
  station,
  syncAnomaly,
  type AlertDeliveryEvent,
  type AlertSeverity,
  type Db,
  type OpsKind,
  type OpsOutcome,
  type SyncAnomalyKind,
} from '@oto/db';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import { AppError } from '../lib/errors';
import { isPgError, scrubPgError } from '../lib/scrub';
import type { BranchReach } from './access-control';
import { boxSettings, withinOpeningHours } from './box';
import { occupancyHealthCheck } from './occupancy';
import { syncSettings } from './sync';
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
  /**
   * Supplied only where the run's id has to be known BEFORE it is recorded —
   * a sync push stamps `sync_event.batch_id` with it inside the transaction
   * that applies the batch, so the Console can open the whole push from one
   * event (S2-05). Everywhere else it is minted here.
   */
  id?: string;
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
  const id = input.id ?? newId();
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
  /** The boxes at every branch of this operator, and what each is reporting. */
  boxes: BoxHealth[];
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

/**
 * SCRUM-265 — HOW FAR ACROSS THE ESTATE THE HEALTH PAGE LOOKS.
 *
 * Everything below used to narrow on `operatorId` and stop there. While one
 * park was open that was the right answer by accident, because the operator
 * and the branch were the same set of boxes. With two open it handed a manager
 * at one park the other park's box names, every device on them, their printer
 * labels, paper status, agent versions, outbox depth and clock offset.
 *
 * So the reach is the caller's, computed from their GRANTS by `branchReach`
 * and passed in — never from `auth.branchId`, which `PUT /me/session/branch`
 * lets any signed-in account move to any branch in the operator (SCRUM-264).
 * An operator-wide or platform-wide grant still reads the whole fleet; a
 * branch-scoped one reads its own branches and nothing else.
 *
 * `undefined` means no branch narrowing at all, which is what the watchdog
 * passes: a condition is true whoever happens to be looking, and the sweep is
 * nobody's session.
 */
export type HealthReach = BranchReach | undefined;

/**
 * The branch clause a reach comes to, against one branch column, or `null` for
 * "every branch".
 *
 * A reach of no branches is a real answer and not a missing filter — the
 * caller holds the permission nowhere — so it comes back as `false` rather
 * than as an absent clause, which would have widened it to everything. Rows
 * with a NULL branch are excluded by `inArray` and that is deliberate: they
 * are the deployment's own events, not a branch's, and the same ruling the
 * audit log already makes (`routes/audit.ts`, SCRUM-249).
 */
function reachClause(reach: HealthReach, column: AnyPgColumn): SQL | null {
  if (!reach || reach.kind === 'operator') return null;
  if (reach.branchIds.length === 0) return sql`false`;
  return inArray(column, reach.branchIds);
}

/**
 * SCRUM-299 — THE REACH, SAID OUT LOUD.
 *
 * Every list under `/ops` is already narrowed to the branches the caller holds
 * the permission at, and none of them said so. A manager at one park opened
 * Failures, read an empty list, and had no way to tell "my park has nothing
 * wrong" from "this page is not showing me my park" — the two look identical,
 * and only the administrator, who sees rows, can tell the page works at all.
 *
 * So the answer carries the reach it was computed at. Named branches, not ids:
 * an id names nothing to somebody reading a screen, and the line the Console
 * draws from this is the same line the Devices page already draws.
 *
 * An operator-wide reach lists no branches, deliberately. It is every branch of
 * the operator INCLUDING the ones that open later, which no list of ids can say.
 */
export interface ReachView {
  scope: 'operator' | 'branch';
  /** Empty for an operator-wide reach; possibly empty for a branch one too,
   *  which is a real answer: the caller holds the permission at no branch. */
  branches: Array<{ id: string; name: string }>;
}

/**
 * The reach as names. The lookup is scoped to the operator, so a grant naming
 * a branch outside it contributes nothing rather than disclosing its name.
 */
export async function describeReach(
  db: Db,
  operatorId: string,
  reach: BranchReach,
): Promise<ReachView> {
  if (reach.kind === 'operator') return { scope: 'operator', branches: [] };
  if (reach.branchIds.length === 0) return { scope: 'branch', branches: [] };
  const rows = await db
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.operatorId, operatorId), inArray(branch.id, reach.branchIds)))
    .orderBy(asc(branch.name));
  return { scope: 'branch', branches: rows };
}

export interface HealthDeps {
  db: Db;
  /** Alerts are filtered to this operator, plus the platform-wide ones. */
  operatorId: string;
  /** The caller's branch reach (SCRUM-265). Omitted only by callers that are
   *  nobody's session — the watchdog. */
  reach?: HealthReach;
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

/**
 * Open alerts for this operator, plus the platform-wide ones (operator null),
 * narrowed to the caller's branch reach.
 *
 * SCRUM-265: an alert carries the branch it is about, so "Receipt Printer 1 at
 * Central Floresta is out of paper" is a sentence about one park. A manager at
 * the other park can do nothing with it and should not be reading it, and the
 * boxes it names are ones they cannot otherwise see. A branch-scoped caller
 * therefore gets the alerts of their own branches only — the deployment's own
 * alerts, which carry no branch, go with the rows they are about.
 */
export async function openAlerts(deps: HealthDeps, limit = 50): Promise<AlertRow[]> {
  const branchClause = reachClause(deps.reach, alert.branchId);
  const rows = await deps.db
    .select()
    .from(alert)
    .where(
      and(
        isNull(alert.resolvedAt),
        or(isNull(alert.operatorId), eq(alert.operatorId, deps.operatorId)),
        ...(branchClause ? [branchClause] : []),
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

  /**
   * S2-12 round 4 — the live head count and whether the gate behind it is
   * current, per gate branch in the caller's reach (`services/occupancy.ts`).
   * Probed like the others: a slow count must not hold the whole page.
   */
  checks.push(
    await probe(
      () => occupancyHealthCheck(deps.db, deps.operatorId, deps.reach, new Date(now)),
      {
        key: 'occupancy',
        label: 'Live occupancy',
        status: 'unknown',
        value: null,
        detail: 'the count did not answer',
      } as HealthCheck,
    ),
  );

  return checks;
}

// --- The fleet: what Health says about a box, and what the watchdog raises --
//
// Both come out of ONE evaluation, and that is the point of this section.
//
// S2-03 already has a rule written twice — `jobRegister` and `runWatchdog` each
// work out lateness from `last_ok_at` and the expectation's grace — and the
// comments in both say they must agree. A box carries five rules rather than
// one, so here they are evaluated once, in `evaluateBox`, and both readers take
// the same answer: the page shows the conditions that are true, the watchdog
// opens those and closes the rest. The page can no more disagree with the alert
// than a number can disagree with itself.
//
// `withinOpeningHours` and `boxSettings` come from `services/box.ts`, and
// `syncSettings` from `services/sync.ts`; both of those import `recordRun` from
// this file, so all three modules are circular. Nothing calls across while a
// module is being loaded, so that is safe, and the alternative is a second copy
// of the opening-hours rule and of `SYNC_STALE_AFTER_S`'s default living here.
// A second copy is precisely the disagreement this section exists to prevent.
//
// Nothing here selects a person, a box secret or a claim code. A box's name,
// its slot and its device labels are what a page read over a shoulder in a back
// office is allowed to carry.

/**
 * Whether the park is open at a branch right now — and whether anybody has said.
 *
 * `not_set` is emphatically not `closed`. A branch with no opening hours has
 * never been asked the question, and the difference is what decides whether a
 * silent box is worth waking somebody for: answering "closed" would stay quiet
 * through a busy Saturday, and answering "open" would raise at three in the
 * morning about a park that is shut. So the offline rule does not fire at all,
 * and the box says on the page that the hours are missing.
 */
export type OpeningHoursState = 'open' | 'closed' | 'not_set';

/** More than this between the box's clock and ours and the box is not trusted to date anything. */
const CLOCK_TOLERANCE_MS = 60_000;

export interface BoxDeviceHealth {
  id: string;
  kind: string;
  label: string;
  reachability: string;
  /** Only a printer reports paper; `unknown` on everything else. */
  paperStatus: string;
  /** The short, non-leaking label the box reported for its last fault. */
  lastError: string | null;
  lastSeenAt: string | null;
}

/**
 * What a booth's own heartbeat block said, as the box measured it (S2-07a).
 *
 * Every field is carried through unchanged, including the tri-state
 * reachability: `unknown` is "the box has not managed to ask", which is not
 * `unreachable`, and Health must not draw a fault from it. A missing field
 * reads as `unknown` or null here for the same reason — never as a cheerful
 * default.
 */
export interface BoothReport {
  /** `booth.booth_config_version.version`. **Null means it has never synced a wheel.** */
  configVersion: number | null;
  printerReachable: string;
  paperStatus: string;
  /** The box's whole outbox depth, which is what the booth module reports. */
  vouchersPending: number | null;
  lastSpinAt: string | null;
  /** Whether SOMEBODY is signed in. Never who. */
  staffSignedIn: boolean;
  /** `booth.booth_prize` ids at their cap today — configuration, not people. */
  dailyCapsReached: string[];
}

/** One booth station on a box, with what the cloud and the box each know of it. */
export interface BoxBoothHealth {
  stationId: string;
  name: string;
  codePrefix: string | null;
  /**
   * The heartbeat's booth block, or null where the box has not sent one.
   *
   * **Null is not evidence that the booth is running nothing**: a box that has
   * never called home since this field existed, and an agent older than
   * S2-07a, both leave it null. The heartbeat's age beside it is what tells a
   * reader which.
   */
  reported: BoothReport | null;
  /**
   * Vouchers this booth issued on the trading day below with nobody signed in
   * (D13) — counted from the cloud's own rows, not from the heartbeat.
   *
   * **Null means it could not be counted**, which is a third answer and not
   * zero: `fleetHealth` leaves it null when the query fails, and the condition
   * is then not evaluated at all rather than evaluated as "nothing is wrong".
   */
  unattributedToday: number | null;
  /** The branch's trading day the count was taken over, not the calendar one. */
  businessDate: string;
}

export interface BoxHealth {
  id: string;
  name: string;
  slot: string;
  role: string;
  /** The column: `unclaimed`, `online`, `offline` or `disabled`. */
  status: string;
  state: HealthState;
  branchId: string;
  branchName: string;
  openingHours: OpeningHoursState;
  agentVersion: string | null;
  minAgentVersion: string;
  agentBelowMinimum: boolean;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  uptimeSeconds: number | null;
  /** Unsynced events waiting on the box — the number that says whether offline is safe. */
  outboxDepth: number | null;
  /**
   * How long the oldest unsynced event has been waiting, in seconds (S2-05).
   * A depth that is not moving is the difference between a box that is busy
   * and a box whose sync path is broken, and only the age can tell them apart.
   */
  oldestUnackedAgeS: number | null;
  /** Events this box sent that could not be applied and are waiting on a person. */
  quarantineOpen: number;
  /** When the cloud last accepted a batch from it. Null means never. */
  lastSyncAt: string | null;
  /** Positive means the box's clock is ahead of ours. */
  clockOffsetMs: number | null;
  /** Null on the virtual box, which has no thermometer — not zero, which reads as cold. */
  tempC: number | null;
  currentEpoch: number;
  /** The config bundle the box last said it had applied. */
  configVersion: string | null;
  devices: BoxDeviceHealth[];
  /**
   * The booths this box drives (S2-07a). Empty on every till, which is what
   * the Console's booth section filters on.
   *
   * A list rather than one booth, because `core.station` can hold two of kind
   * `booth` against one box even though the heartbeat's block is a single
   * object. Where there are two, neither gets the reported block — see
   * `evaluateBox`.
   */
  booths: BoxBoothHealth[];
  /** The alert keys true about this box right now. The same list the watchdog raises from. */
  conditions: string[];
  /** One sentence for the tile: what this box's state means. */
  detail: string | null;
}

/**
 * One rule about one box or one of its devices, evaluated.
 *
 * `active` is what the watchdog acts on in both directions — open it when true,
 * close it when false — so a rule that stops being true is a rule that resolves
 * itself without anybody pressing anything.
 */
export interface FleetCondition {
  /** The identity of the CONDITION: `box.offline:<box id>`. */
  key: string;
  category: string;
  severity: AlertSeverity;
  subject: string;
  operatorId: string;
  branchId: string;
  active: boolean;
  /** The sentence while it is true. */
  summary: string;
  detail: Record<string, unknown>;
  /**
   * How it reads when it stops being true. A box that started reporting again
   * has recovered; one that is still silent at 21:05 has not — the park has
   * simply closed — and writing "recovered" on that row would be a lie in the
   * one record somebody reads back after an incident.
   */
  clear: { category: string; reason: string; summary: string };
}

export interface FleetSnapshot {
  boxes: BoxHealth[];
  /** Every rule evaluated, true and false alike. */
  conditions: FleetCondition[];
}

interface FleetBoxRow {
  id: string;
  operatorId: string;
  branchId: string;
  name: string;
  slot: string;
  role: string;
  status: string;
  agentVersion: string | null;
  registeredAt: Date | null;
  currentEpoch: number;
  lastHeartbeatAt: Date | null;
  lastStatus: unknown;
  branchName: string;
  timezone: string;
  /** `HH:MM:SS` from `core.branch`; the trading day a booth's counts are taken over. */
  businessDayStart: string;
  openingHours: unknown;
}

interface FleetDeviceRow {
  id: string;
  boxId: string;
  kind: string;
  label: string;
  reachability: string;
  paperStatus: string;
  lastError: string | null;
  lastSeenAt: Date | null;
}

/**
 * A booth station on a box, with the one number only the cloud can answer
 * (S2-07a).
 *
 * Gathered once per evaluation and handed in beside the devices, for the same
 * reason they are: `evaluateBox` is pure, it runs on every Health page load
 * and every watchdog tick, and the page and the alert must be reading the same
 * numbers.
 */
export interface FleetBoothRow {
  stationId: string;
  boxId: string;
  name: string;
  codePrefix: string | null;
  /** See `BoxBoothHealth.unattributedToday`: null is "could not count", not zero. */
  unattributedToday: number | null;
  businessDate: string;
}

function statusOf(row: FleetBoxRow): Record<string, unknown> | null {
  const value = row.lastStatus;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function statusNumber(status: Record<string, unknown> | null, key: string): number | null {
  const value = status?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function statusText(status: Record<string, unknown> | null, key: string): string | null {
  const value = status?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One entry of a heartbeat's `errors`: what went wrong, as an identity and a count, never a message. */
interface ReportedFault {
  fingerprint: string;
  code: string;
  count: number;
}

/**
 * The faults a box reported in its last heartbeat — fingerprint, code and
 * count, never a message. Read defensively because it comes off a jsonb column
 * written by whatever agent version the box is running, and a box on an older
 * build simply reports none.
 */
function statusErrors(status: Record<string, unknown> | null): ReportedFault[] {
  const value = status?.errors;
  if (!Array.isArray(value)) return [];
  const out: ReportedFault[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.code !== 'string' || typeof e.fingerprint !== 'string') continue;
    out.push({
      fingerprint: e.fingerprint,
      code: e.code,
      count: typeof e.count === 'number' && Number.isFinite(e.count) ? e.count : 1,
    });
  }
  return out;
}

/**
 * The box's store cannot be used (SCRUM-403): `store:damaged` or
 * `store:unreadable`, the one entry the agent that stands in for such a box
 * puts first in its heartbeat's `errors` (`reportingStoreFault`,
 * runner/runtime.ts), coded `box.store_damaged` / `box.store_unreadable`.
 * Either half names it, so an agent that renames one still files here.
 */
function isStoreFault(fault: ReportedFault): boolean {
  return fault.fingerprint.startsWith('store:') || fault.code.startsWith('box.store_');
}

/** Which problem the store has — `damaged` or `unreadable` — read off the fault's identity. */
function storeProblemOf(fault: ReportedFault): string {
  if (fault.fingerprint.startsWith('store:')) return fault.fingerprint.slice('store:'.length);
  return fault.code.replace(/^box\.store_/, '');
}

/**
 * A box claimed again onto a new store, refusing every fact until Reset the
 * store gives it a journal epoch (`journalFaultReports`, agent.ts).
 */
function isJournalWait(fault: ReportedFault): boolean {
  return (
    fault.fingerprint === 'journal:awaiting_epoch' || fault.code === 'box.journal_awaiting_epoch'
  );
}

/**
 * The booth block off the last heartbeat (S2-07a).
 *
 * Read defensively for the same reason `statusErrors` is: it comes off a jsonb
 * column written by whatever agent version the box happens to be running, and
 * a box on a build older than S2-07a sends no block at all. Absent or
 * unreadable answers null, which the caller reports as "not reported" rather
 * than as a booth that is running nothing.
 *
 * A field that is present but the wrong type falls back to the answer the box
 * itself gives when it cannot measure: `unknown` for the two device states,
 * null for the version, the count and the last spin, `false` for signed-in and
 * an empty list for the caps. Nothing here is defaulted upwards — the two that
 * are not nullable are the two whose false answer is the quiet one.
 */
function boothReport(status: Record<string, unknown> | null): BoothReport | null {
  const value = status?.booth;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const b = value as Record<string, unknown>;
  const caps = Array.isArray(b.dailyCapsReached)
    ? b.dailyCapsReached.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    configVersion:
      typeof b.configVersion === 'number' && Number.isFinite(b.configVersion)
        ? b.configVersion
        : null,
    printerReachable: typeof b.printerReachable === 'string' ? b.printerReachable : 'unknown',
    paperStatus: typeof b.paperStatus === 'string' ? b.paperStatus : 'unknown',
    vouchersPending:
      typeof b.vouchersPending === 'number' && Number.isFinite(b.vouchersPending)
        ? b.vouchersPending
        : null,
    lastSpinAt: typeof b.lastSpinAt === 'string' ? b.lastSpinAt : null,
    staffSignedIn: b.staffSignedIn === true,
    dailyCapsReached: caps,
  };
}

/**
 * How a booth is named in something a person reads: "Booth 1 (B1)".
 *
 * `code_prefix` is nullable on `core.station` — a booth nobody has allocated
 * one to yet — so a missing prefix drops the bracket rather than printing
 * "(null)". The same shape `services/sync-booth.ts` uses when it names a booth
 * in a collision alert, so one booth reads the same way in both.
 */
function boothSubject(b: FleetBoothRow): string {
  return b.codePrefix ? `${b.name} (${b.codePrefix})` : b.name;
}

/**
 * Dotted comparison, the same reading the agent applies to itself. Anything
 * unparseable counts as new enough: refusing a box because its version string
 * was unexpected would be a worse failure than running it.
 */
export function versionBelow(version: string, minimum: string): boolean {
  const parts = (v: string): number[] =>
    v.split('.').map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const a = parts(version);
  const b = parts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/** How long, in words somebody reads rather than a count of seconds. */
function elapsedWords(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3_600)} hours`;
}

export interface BoxRuleSettings {
  /** `BOX_OFFLINE_AFTER_S`: silence longer than this and the box is offline. */
  offlineAfterS: number;
  minAgentVersion: string;
  /** `SYNC_STALE_AFTER_S`: a box that is talking but whose facts are not arriving. */
  syncStaleAfterS: number;
}

/**
 * What the sync core knows about one box, gathered once per evaluation and
 * handed in beside its devices (S2-05).
 *
 * Passed in rather than queried here for the same reason the devices are: this
 * function is pure, it runs on every Health page load and every watchdog tick,
 * and the page and the alert must be reading the same numbers.
 */
export interface BoxSyncState {
  /** Queued or sending, from `edge.box_outbox` where that store is ours. */
  outboxDepth: number | null;
  /** Reported by the box on its heartbeat, or measured from our copy of its outbox. */
  oldestUnackedAgeS: number | null;
  quarantineOpen: number;
  epochRegressedOpen: number;
  lastSyncAt: Date | null;
  /**
   * How many journal positions the ledger holds above the box's sync cursor, on
   * its current epoch. Zero is the healthy answer and the usual one: the cursor
   * is the contiguous prefix of what has arrived, so anything above it means a
   * position in between never did (S2-05).
   */
  cursorBehindBy: number;
  /** The first position the cursor cannot claim — the hole itself. Null when there is none. */
  cursorHoleAt: number | null;
}

/**
 * Every rule about one box, decided.
 *
 * The one that matters most is the first: a box that has stopped calling home
 * is only raised DURING OPENING HOURS. A park that is shut is not a park with a
 * broken till, and an alert at three in the morning that means nothing is how
 * everybody learns to ignore alerts — including the one that arrives on a
 * Saturday afternoon and does mean something. The status column still moves to
 * `offline` whatever the hour, because that is a fact; whether it is worth
 * telling anybody is the judgement, and that is what the hours decide.
 *
 * The device rules are the other half of the same thought. They fire only while
 * the box is reporting, because paper and reachability are only as fresh as the
 * last heartbeat: calling a printer unreachable on the evidence of a box we
 * cannot hear from would be inventing a second fault out of the first one.
 */
export function evaluateBox(
  row: FleetBoxRow,
  devices: FleetDeviceRow[],
  settings: BoxRuleSettings,
  now: number,
  sync?: BoxSyncState,
  booths: FleetBoothRow[] = [],
): { health: BoxHealth; conditions: FleetCondition[] } {
  const last = statusOf(row);
  const heartbeatAgeSeconds = secondsSince(row.lastHeartbeatAt, now);
  const openingHours: OpeningHoursState =
    row.openingHours == null
      ? 'not_set'
      : withinOpeningHours(row.openingHours, row.timezone, new Date(now))
        ? 'open'
        : 'closed';

  /**
   * A box nobody has registered against yet, and one an administrator has taken
   * out of service, are both expected to be quiet. Neither is a fault, and
   * neither may raise.
   */
  const expectedAlive = row.registeredAt !== null && row.status !== 'disabled';
  const silent = heartbeatAgeSeconds === null || heartbeatAgeSeconds > settings.offlineAfterS;
  /** Reporting means what this box can see, we can see — and only then. */
  const reporting = expectedAlive && !silent;

  const clockOffsetMs = statusNumber(last, 'clockOffsetMs');
  const agentVersion = row.agentVersion ?? statusText(last, 'agentVersion');
  const agentBelowMinimum =
    agentVersion !== null && versionBelow(agentVersion, settings.minAgentVersion);

  const subject = `${row.name} (${row.slot})`;
  const scope = { operatorId: row.operatorId, branchId: row.branchId };
  const conditions: FleetCondition[] = [];

  /**
   * The queue, read before the offline rule rather than beside the sync rules
   * below, because the recovery line spends it (S2-07a).
   *
   * `sync?.*` is our own copy of the box's outbox — real for the virtual box,
   * whose store IS this database, and empty for a Raspberry Pi, whose queue is
   * a SQLite file we cannot reach. So the box's own report is the fallback,
   * and null means neither side could say.
   */
  const outboxDepth = sync?.outboxDepth ?? statusNumber(last, 'outboxDepth');
  const oldestUnackedAgeS = sync?.oldestUnackedAgeS ?? statusNumber(last, 'oldestUnackedAgeS');

  /**
   * What the recovery line can honestly say about a box that has come back.
   *
   * It carries what is STILL WAITING, not what was handed over: nothing keeps
   * a copy of the depth at the moment a box went quiet, so "it synced 43
   * events" is not a number this side holds. "43 are still waiting" is, it is
   * measured the same way on every tick, and it answers the question somebody
   * actually asks on seeing a booth come back — has it caught up yet.
   *
   * A null depth says nothing at all rather than "nothing is waiting": on a Pi
   * that means we hold no copy of its queue, which is not the same sentence.
   */
  const caughtUpWords =
    outboxDepth === null
      ? ''
      : outboxDepth === 0
        ? ', and nothing of its is still waiting to be handed over'
        : ` — ${outboxDepth} event(s) of its are still waiting to be handed over`;

  /**
   * Why the offline condition stopped being true, which is not always "the box
   * came back". It also stops at 21:00 because the park closed, and it stops
   * when an administrator takes the box out of service — and an incident read
   * back six months later deserves to say which of the three happened.
   */
  const offlineClear = (): FleetCondition['clear'] => {
    if (reporting) {
      return {
        category: 'box.online',
        reason: 'recovered',
        summary: `${subject} is calling home again${caughtUpWords}`,
      };
    }
    if (!expectedAlive) {
      return {
        category: 'box.offline',
        reason: 'taken out of service',
        summary: `${subject} is silent, and it has been taken out of service`,
      };
    }
    if (openingHours === 'not_set') {
      return {
        category: 'box.offline',
        reason: 'opening hours are not set',
        summary: `${subject} is silent, and nobody has said when ${row.branchName} is open`,
      };
    }
    return {
      category: 'box.offline',
      reason: `${row.branchName} is closed`,
      summary: `${subject} is silent, and ${row.branchName} is closed`,
    };
  };

  // --- The box has stopped calling home, and the park is open.
  conditions.push({
    key: `box.offline:${row.id}`,
    category: 'box.offline',
    // The stations on it cannot sell, print or open a gate. Nothing else in
    // this file is worth the loudest word; this is.
    severity: 'critical',
    subject,
    ...scope,
    active: expectedAlive && silent && openingHours === 'open',
    summary:
      heartbeatAgeSeconds === null
        ? `${subject} has never called home, and ${row.branchName} is open`
        : `${subject} has not called home for ${elapsedWords(heartbeatAgeSeconds)} while ${row.branchName} is open — the stations on it cannot sell`,
    detail: {
      slot: row.slot,
      status: row.status,
      branch: row.branchName,
      heartbeatAgeSeconds,
      offlineAfterSeconds: settings.offlineAfterS,
      lastHeartbeatAt: iso(row.lastHeartbeatAt),
    },
    clear: offlineClear(),
  });

  /**
   * What the box said was going wrong, in its last heartbeat's `errors`,
   * split three ways before any rule reads it (SCRUM-445). Every entry there
   * has one shape — a fingerprint, a code and a count — and not one meaning,
   * and a single rule reading the whole list filed a booth whose memory card
   * had failed under the heading for a config bundle that did not apply,
   * with a sentence about its till refusing to unlock offline.
   *
   *  - `store:damaged` / `store:unreadable` is the store itself, reported by
   *    the agent that stands in for a box whose store cannot be used
   *    (SCRUM-403): the booth is not running, and a person has to go to it.
   *  - `journal:awaiting_epoch` is a box claimed again onto a new store,
   *    refusing every fact until Reset the store gives it a journal epoch.
   *  - Everything else is a scope of the offline copy that did not land
   *    (S2-06), which is what the `box.cache_incomplete` rule below was
   *    written for and all it reads now.
   */
  const reportedFaults = statusErrors(last);
  const storeFault = reportedFaults.find(isStoreFault) ?? null;
  const journalWait = reportedFaults.find(isJournalWait) ?? null;
  const cacheFaults = reportedFaults.filter((e) => !isStoreFault(e) && !isJournalWait(e));

  /**
   * --- Its store cannot be used, and the booth needs service.
   *
   * The box stays up and keeps calling home — it is the only way anybody in
   * a back office hears of this — but it records nothing, and the television
   * at the booth says so. Restarting does not cure it and the watchdog on the
   * Pi leaves it running; the store is tried again every minute and comes
   * back by itself if the card recovers, and otherwise the way back is a new
   * box claimed on the Pi (PI_BOOTH.md, section 7, "A damaged store"). The
   * Console adds that pointer under this heading.
   *
   * Read off `last_status`, so it holds while the box is silent and closes on
   * the first heartbeat that carries no store fault — or when an administrator
   * takes the box out of service, which is what happens to the damaged box
   * once its Pi has been claimed as a new one, and is said as such.
   */
  const storeProblem = storeFault ? storeProblemOf(storeFault) : null;
  const storeWords =
    storeProblem === 'damaged'
      ? 'its store is damaged'
      : storeProblem === 'unreadable'
        ? 'its store could not be read'
        : storeProblem
          ? `its store is ${storeProblem}`
          : 'its store cannot be used';
  conditions.push({
    key: `box.needs_service:${row.id}`,
    category: 'box.needs_service',
    severity: 'warning',
    subject,
    ...scope,
    active: expectedAlive && storeFault !== null,
    summary: `${subject} needs service at the booth: ${storeWords} — it stays up and records nothing, and tries its memory card again every minute`,
    detail: {
      slot: row.slot,
      store: storeProblem,
      code: storeFault?.code ?? null,
      /** Failed looks at the store since the agent started, as the box counts them. */
      checks: storeFault?.count ?? 0,
    },
    clear: expectedAlive
      ? {
          category: 'box.needs_service',
          reason: 'recovered',
          summary: `${subject} is running on its store again`,
        }
      : {
          category: 'box.needs_service',
          reason: 'taken out of service',
          summary: `${subject} needed service, and it has been taken out of service`,
        },
  });

  /**
   * --- It is waiting for Reset the store.
   *
   * A claim that registered the same box again onto a new store: that store
   * would reuse journal numbers the platform already holds, so the box refuses
   * to record anything until Console → Devices → the box → Reset the store
   * mints it a new epoch (`box.ts`, `reset_store`). Not a fault in the store
   * and not an incomplete offline copy — a press somebody has to make.
   */
  conditions.push({
    key: `box.awaiting_reset:${row.id}`,
    category: 'box.awaiting_reset',
    severity: 'warning',
    subject,
    ...scope,
    active: expectedAlive && journalWait !== null,
    summary: `${subject} is waiting for Reset the store — it was claimed again onto a new store and records nothing until the reset gives it a new journal epoch`,
    detail: {
      slot: row.slot,
      /** Facts the box refused while waiting, as it counts them — at least one. */
      refused: journalWait?.count ?? 0,
      currentEpoch: row.currentEpoch,
    },
    clear: expectedAlive
      ? {
          category: 'box.awaiting_reset',
          reason: 'reset',
          summary: `${subject} has its new journal epoch and is recording again`,
        }
      : {
          category: 'box.awaiting_reset',
          reason: 'taken out of service',
          summary: `${subject} was waiting for Reset the store, and it has been taken out of service`,
        },
  });

  /**
   * --- Its clock is out, and the box corrects for it.
   *
   * Since SCRUM-402 the box measures its clock against the platform's on
   * every heartbeat and stamps, prints and dates its trading day on the
   * corrected time, so a clock hours out no longer files a sale on the wrong
   * business date by itself. What this raises is still the machine's clock —
   * a Pi with no clock battery after a power cut — and what the reader has to
   * weigh is the MEASUREMENT (SCRUM-439): whether the box has taken one, and
   * how old it is. A box that has not measured yet stamps on its own clock
   * until it does, and a reboot sets the measurement aside (SCRUM-402), so
   * the box is back on its own clock until the next heartbeat is answered.
   *
   * `clockMeasuredBy` and `clockMeasuredAt` are what `recordHeartbeat`
   * (`box.ts`) wrote down: `box` when the box declared its own measurement,
   * `platform` when it declared none and this side computed the offset from
   * its `reportedAt`. An agent too old to say either reads as unmeasured,
   * which is also the truth about what it stamps.
   */
  const offsetSeconds = clockOffsetMs === null ? 0 : Math.round(clockOffsetMs / 1000);
  const clockMeasuredBy = statusText(last, 'clockMeasuredBy');
  const clockMeasuredAt = statusText(last, 'clockMeasuredAt');
  const clockMeasuredAtMs = clockMeasuredAt === null ? NaN : Date.parse(clockMeasuredAt);
  const clockMeasuredAgeSeconds = Number.isFinite(clockMeasuredAtMs)
    ? secondsSince(new Date(clockMeasuredAtMs), now)
    : null;
  const clockWords = `${subject}'s clock is ${Math.abs(offsetSeconds)}s ${offsetSeconds >= 0 ? 'ahead of' : 'behind'} ours`;
  const measuredWords =
    clockMeasuredAgeSeconds === null
      ? 'the box measured that itself'
      : clockMeasuredAgeSeconds < 5
        ? 'the box measured that just now'
        : `the box measured that ${elapsedWords(clockMeasuredAgeSeconds)} ago`;
  conditions.push({
    key: `box.clock:${row.id}`,
    category: 'box.clock',
    severity: 'warning',
    subject,
    ...scope,
    active: reporting && clockOffsetMs !== null && Math.abs(clockOffsetMs) > CLOCK_TOLERANCE_MS,
    summary:
      clockMeasuredBy === 'box'
        ? `${clockWords} — ${measuredWords} and corrects what it stamps; only that measurement going stale, or a reboot before it measures again, would date things wrongly`
        : `${clockWords} and the box has not measured that yet — until it does, what it stamps is dated by its own clock`,
    detail: {
      slot: row.slot,
      clockOffsetMs,
      toleranceMs: CLOCK_TOLERANCE_MS,
      clockMeasuredBy,
      clockMeasuredAt: Number.isFinite(clockMeasuredAtMs) ? clockMeasuredAt : null,
      clockMeasuredAgeSeconds,
    },
    clear: {
      category: 'box.clock',
      reason: 'recovered',
      summary: `${subject}'s clock is back within a minute of ours`,
    },
  });

  // --- It is running an agent this build no longer supports.
  conditions.push({
    key: `box.agent:${row.id}`,
    category: 'box.agent',
    severity: 'warning',
    subject,
    ...scope,
    active: expectedAlive && agentBelowMinimum,
    summary: `${subject} is running agent ${agentVersion ?? 'unknown'}, below the ${settings.minAgentVersion} this build supports`,
    detail: { slot: row.slot, agentVersion, minSupportedAgentVersion: settings.minAgentVersion },
    clear: {
      category: 'box.agent',
      reason: 'recovered',
      summary: `${subject} is running agent ${agentVersion ?? 'unknown'}, which this build supports`,
    },
  });

  /**
   * --- And the two sync rules (S2-05), which are about a quieter fault than
   * everything above: a box that is answering every heartbeat while the facts
   * it produced are not arriving.
   *
   * **Online but not syncing.** The offline rule cannot see this — the box is
   * calling home, so by every measure above it is healthy — and yet a counter
   * whose sales are sitting in an outbox is a counter whose takings exist in
   * one place, on a Pi, in a mall. On a till it fires only while the box is
   * REPORTING, because an offline box is expected to hold a queue: that is
   * what offline mode is for.
   *
   * **A booth is the exception, and D10 is why.** A booth put offline keeps
   * drawing prizes and printing paper the park owes, so "still working, not
   * yet reported" and "broken" are different sentences and only this rule can
   * say the first one — `box.offline` says the second. A booth nobody noticed
   * was offline all day is worth knowing about.
   *
   * What keeps the offline demonstration quiet is the threshold and not this
   * clause: a demonstration shorter than `SYNC_STALE_AFTER_S` never trips it,
   * and one left running longer does — which is the case D10 asks to hear
   * about, said in the same sentence whether somebody meant it or not.
   *
   * **It measures honestly only where the queue is ours.** A deliberately
   * offline box stops heartbeating altogether — `refreshOffline` in the agent
   * returns before the send — so the age this reads is either `edge.box_outbox`,
   * which is the virtual box's real queue and goes on ageing, or the number
   * frozen on the last heartbeat the box managed, which is a Raspberry Pi and
   * does not. A Pi that went offline holding nothing therefore never trips
   * this however long it stays away, and `box.offline` is the only thing said
   * about it.
   */
  const boothQueueReadable = booths.length > 0;
  conditions.push({
    key: `sync.stale:${row.id}`,
    category: 'sync.stale',
    severity: 'warning',
    subject,
    ...scope,
    active:
      (reporting || (boothQueueReadable && expectedAlive)) &&
      oldestUnackedAgeS !== null &&
      oldestUnackedAgeS > settings.syncStaleAfterS,
    summary: reporting
      ? `${subject} is calling home but its oldest unsynced event has been waiting ${elapsedWords(oldestUnackedAgeS ?? 0)} — ${outboxDepth ?? 'some'} event(s) exist only on the box`
      : `${subject} has been holding ${outboxDepth ?? 'some'} event(s) for ${elapsedWords(oldestUnackedAgeS ?? 0)} without handing any over — the booth is still working, and nothing it has done is recorded anywhere else`,
    detail: {
      slot: row.slot,
      outboxDepth,
      oldestUnackedAgeS,
      staleAfterSeconds: settings.syncStaleAfterS,
    },
    clear: {
      category: 'sync.stale',
      reason: 'recovered',
      summary: `${subject} is syncing again — nothing has been waiting longer than ${settings.syncStaleAfterS}s`,
    },
  });

  /**
   * **The box's last cache pull was incomplete** (S2-06).
   *
   * The box reports these itself, in the heartbeat's `errors`, because it is
   * the only thing that knows: a scope the cloud truncated, a write its store
   * refused, or a staff list that arrived without the deny-list governing it
   * and so was not applied. The cloud cannot infer any of that from a healthy
   * heartbeat, which is exactly how a box came to hold a current staff list
   * and no record of who had been stopped — reporting healthy the whole time.
   *
   * Raised whatever the hour, because it does not depend on anybody being at
   * the counter, and it closes on the next pull in which every scope lands.
   * The till, meanwhile, refuses an offline unlock it cannot check, so the
   * visible symptom and this alert have the same cause.
   *
   * `cacheFaults` is the heartbeat's `errors` with the store fault and the
   * journal wait taken out (SCRUM-445, above): those two have their own
   * headings, and this sentence about a till refusing to unlock was never
   * true of them.
   */
  const cacheFaultCount = cacheFaults.reduce((n, e) => n + e.count, 0);
  conditions.push({
    key: `box.cache_incomplete:${row.id}`,
    category: 'box.cache_incomplete',
    severity: 'warning',
    subject,
    ...scope,
    active: expectedAlive && cacheFaults.length > 0,
    summary: `${subject} could not apply part of its offline copy (${cacheFaults
      .map((e) => e.code)
      .join(', ')}) — until it pulls a complete one, its till refuses to unlock offline`,
    detail: { slot: row.slot, faults: cacheFaults, occurrences: cacheFaultCount },
    clear: {
      category: 'box.cache_incomplete',
      reason: 'recovered',
      summary: `${subject} has applied a complete offline copy again`,
    },
  });

  /**
   * **Quarantine non-empty.** An event the cloud refused is a fact nobody has
   * recorded anywhere, waiting on a person to replay or discard it. Unlike
   * everything else here it does not depend on the box being reachable — the
   * rows are already in this database, and the box that sent them may since
   * have been unplugged — so it fires whatever the box is doing now. Raised by
   * the push as it happens and closed by this, from the same count, so the two
   * cannot tell different stories.
   */
  const quarantineOpen = sync?.quarantineOpen ?? 0;
  conditions.push({
    key: `sync.quarantine:${row.id}`,
    category: 'sync.quarantine',
    severity: 'warning',
    subject,
    ...scope,
    active: quarantineOpen - (sync?.epochRegressedOpen ?? 0) > 0,
    summary: `${quarantineOpen} event(s) from ${subject} could not be applied and are waiting on Failures > Quarantine`,
    detail: { slot: row.slot, quarantineOpen, epochRegressedOpen: sync?.epochRegressedOpen ?? 0 },
    clear: {
      category: 'sync.quarantine',
      reason: 'cleared',
      summary: `Everything quarantined from ${subject} has been replayed or discarded`,
    },
  });

  /**
   * **The cursor is behind the ledger.** The cursor is the contiguous prefix of
   * what has arrived from a box, so a ledger row above it means a position in
   * between never arrived at all — a queue row damaged on the way up and not yet
   * re-sent, or a store that has lost part of its journal. It stalls the number
   * the heartbeat and the till's banner both read as "where the box has got to",
   * and it is invisible to `sync.stale` above, which measures the age of a queue
   * that is still draining perfectly well.
   *
   * Unlike the offline and device rules it does not wait for the box to be
   * REPORTING: the rows are already in this database, and a box that lost
   * positions and was then unplugged still lost them. It does hold to the same
   * rule as everything else about a box nobody has registered against or that an
   * administrator has taken out of service, which is expected to be quiet. It
   * closes on its own when the missing position arrives or when the store is
   * reset, because a reset mints a new epoch and this reads the current one.
   */
  const cursorBehindBy = sync?.cursorBehindBy ?? 0;
  const cursorHoleAt = sync?.cursorHoleAt ?? null;
  conditions.push({
    key: `sync.cursor_stalled:${row.id}`,
    category: 'sync.cursor_stalled',
    severity: 'warning',
    subject,
    ...scope,
    active: expectedAlive && cursorBehindBy > 0,
    summary: `${subject} has ${cursorBehindBy} event(s) recorded above journal position ${cursorHoleAt ?? 0}, which has never arrived — its sync cursor cannot move past it`,
    detail: { slot: row.slot, cursorBehindBy, cursorHoleAt, currentEpoch: row.currentEpoch },
    clear: {
      category: 'sync.cursor_stalled',
      reason: 'recovered',
      summary: `${subject} has nothing filed above its sync cursor — everything it has sent is accounted for`,
    },
  });

  /**
   * A replay from a journal the box no longer has. Its own condition rather
   * than one more quarantine reason, because the answer is different: nothing
   * is wrong with the events, the box is sending from a store that was wiped,
   * and what a person does about it is check the box rather than the data.
   */
  conditions.push({
    key: `sync.epoch_regressed:${row.id}`,
    category: 'sync.epoch_regressed',
    severity: 'warning',
    subject,
    ...scope,
    active: (sync?.epochRegressedOpen ?? 0) > 0,
    summary: `${subject} sent ${sync?.epochRegressedOpen ?? 0} event(s) from a journal epoch replaced when its store was reset`,
    detail: { slot: row.slot, currentEpoch: row.currentEpoch },
    clear: {
      category: 'sync.epoch_regressed',
      reason: 'cleared',
      summary: `${subject} is sending from epoch ${row.currentEpoch} again`,
    },
  });

  // --- And what the box says about the things plugged into it.
  /**
   * Two audiences, two rules, and the difference is what somebody can do about
   * it before the doors open.
   *
   * A device that did not answer waits for opening hours, like the box itself:
   * the park's printers are switched off at the end of the night, and calling
   * a powered-down printer a fault at four in the morning is raising an alert
   * about somebody having gone home. Note what that means for paper — a
   * printer that is switched off cannot be asked about its paper either, so
   * the box's probe reports `unknown` (`unknownHealth` in the agent's printer
   * adapter) and never `out`.
   *
   * So `paperStatus === 'out'` is only ever a printer that answered and said
   * it has no paper, which stays true until somebody changes the roll. It is
   * raised whenever the box is reporting it, closed park or not, because the
   * person who can fix it is the morning shift and the alternative is finding
   * out at the first sale of the day. It is a `warning` and not a `critical`,
   * so what it does out of hours is wait on the Health page rather than wake
   * anybody.
   */
  const deviceAnswering = reporting && openingHours === 'open';
  for (const d of devices) {
    const where = `${d.label} on ${row.name}`;
    const deviceDetail = { slot: row.slot, deviceKind: d.kind, deviceLabel: d.label };
    if (d.kind.endsWith('printer')) {
      conditions.push({
        key: `device.paper:${d.id}`,
        category: 'device.paper',
        severity: 'warning',
        subject: where,
        ...scope,
        active: reporting && d.paperStatus === 'out',
        summary: `${where} is out of paper`,
        detail: { ...deviceDetail, paperStatus: d.paperStatus },
        clear: { category: 'device.paper', reason: 'recovered', summary: `${where} has paper again` },
      });
    }
    /**
     * Every kind, not only the printers the ticket names. A terminal the box
     * cannot reach stops a card payment and a scanner it cannot reach stops a
     * band being read; the rule is identical and so is the sentence.
     */
    conditions.push({
      key: `device.unreachable:${d.id}`,
      category: 'device.unreachable',
      severity: 'warning',
      subject: where,
      ...scope,
      active: deviceAnswering && d.reachability === 'unreachable',
      summary: `${where} did not answer the box`,
      detail: { ...deviceDetail, reachability: d.reachability, lastError: d.lastError },
      clear: {
        category: 'device.unreachable',
        reason: 'recovered',
        summary: `${where} is answering the box again`,
      },
    });
  }

  /**
   * --- And the booth, which adds exactly two rules to the ones above (S2-07a).
   *
   * Everything else a booth can suffer is already a rule about a box or a
   * device and is not written twice here. A booth that has gone quiet is
   * `box.offline`; its printer out of paper is `device.paper` on the printer
   * row the same heartbeat updates; a printer that did not answer is
   * `device.unreachable`. A booth is a box with a printer, and a second set of
   * booth-shaped copies would be two rules that can disagree about one fault.
   *
   * The reported block is attached to the booth only when the box drives ONE
   * of them. The heartbeat carries a single object with no station on it, so
   * on a box with two booth stations there is no honest way to say which one
   * it describes — and guessing would put one booth's paper state under the
   * other booth's name.
   */
  const reportedBooth = boothReport(last);
  for (const b of booths) {
    const name = boothSubject(b);
    const mine = booths.length === 1 ? reportedBooth : null;

    /**
     * **Vouchers issued with nobody signed in** (D13).
     *
     * One condition carrying a count, never one alert per voucher: sixty
     * unattributed vouchers at one booth bump one row sixty times, because
     * what somebody has to act on is "this booth is giving prizes away with
     * nobody signed in", once.
     *
     * It is raised twice over, from two directions, exactly as
     * `sync.quarantine` is: the push opens it the moment an unattributed
     * voucher lands (`services/sync-booth.ts`), and this closes it from the
     * count when it stops being true. The same key, so the two cannot tell
     * different stories, and neither leaves a row nothing will ever resolve.
     *
     * No `expectedAlive` guard, for the same reason quarantine has none: the
     * rows are already in this database and the booth that issued them may
     * since have been unplugged. Whether it is reachable now has no bearing on
     * whether it gave something away this morning.
     *
     * **Not evaluated at all where the count could not be taken.** A failed
     * count is not zero, and emitting the condition as inactive would let the
     * watchdog close a standing alert on the strength of a query that never
     * answered.
     */
    if (b.unattributedToday !== null) {
      const n = b.unattributedToday;
      conditions.push({
        key: `booth.unattributed:${b.stationId}`,
        category: 'booth.unattributed',
        severity: 'warning',
        subject: name,
        ...scope,
        active: n > 0,
        summary: `${name} has issued ${n} voucher(s) today with nobody signed in — the wheel keeps working, and the prizes are attributed to no one`,
        detail: {
          slot: row.slot,
          stationId: b.stationId,
          unattributedToday: n,
          businessDate: b.businessDate,
        },
        /**
         * A plain statement of what is now true rather than a claim about why.
         * Within one trading day this count only ever grows — a spin filed
         * with no staff member keeps its null — so in practice it closes when
         * the day rolls over, and saying "recovered" would read as somebody
         * having fixed the sign-in.
         */
        clear: {
          category: 'booth.unattributed',
          reason: 'nothing unattributed today',
          summary: `${name} has issued no unattributed vouchers on ${b.businessDate}`,
        },
      });
    }

    /**
     * **A prize has reached its daily cap.**
     *
     * `info`, because this is the wheel working as designed: D5 renormalises
     * the draw over what is left and the booth keeps running. It is worth
     * knowing — a cap set too low takes the headline prize out of the wheel
     * before lunch — and it is not a fault, so it goes on the page and in the
     * alert list without painting the box amber or moving the platform's
     * verdict.
     *
     * Read from the heartbeat and therefore only while the box is REPORTING,
     * like the device rules: a cap list from a box we can no longer hear from
     * says nothing about the wheel running now.
     */
    const capped = mine?.dailyCapsReached ?? [];
    conditions.push({
      key: `booth.prize_cap:${b.stationId}`,
      category: 'booth.prize_cap',
      severity: 'info',
      subject: name,
      ...scope,
      active: reporting && capped.length > 0,
      summary: `${name} has reached today's cap on ${capped.length === 1 ? 'one of its prizes' : `${capped.length} of its prizes`} — the wheel keeps spinning and shares the odds out over the rest`,
      detail: { slot: row.slot, stationId: b.stationId, prizeIds: capped },
      /**
       * Two ways for this to stop being true, and they are not the same news.
       * A booth that reported an empty list has capacity again; a booth that
       * stopped reporting has told us nothing, and writing "every prize is
       * available" on that would be inventing an answer out of silence.
       */
      clear: reporting
        ? {
            category: 'booth.prize_cap',
            reason: 'capacity again',
            summary: `${name} has prizes left on every slice of its wheel`,
          }
        : {
            category: 'booth.prize_cap',
            reason: 'the booth stopped reporting',
            summary: `${name} has stopped reporting, so nothing is known about its caps`,
          },
    });
  }

  const active = conditions.filter((c) => c.active);
  /**
   * The box's state comes from the worst thing that is WRONG, and `info` is
   * not wrong — it is news (S2-07a). A daily cap reached every afternoon must
   * not leave a booth permanently amber, because a tile that is always amber
   * is a tile nobody reads.
   *
   * Every condition written before this ticket is `warning` or `critical`, so
   * this changes the answer for none of them. The informational line is still
   * shown under the tile when there is nothing worse to say.
   */
  const worst =
    active.find((c) => c.severity === 'critical') ??
    active.find((c) => c.severity === 'warning') ??
    null;
  const news = worst ?? active[0] ?? null;

  /**
   * The tile's state, and the sentence under it. Silence that is not alertable
   * is still shown — `warn` where nobody has set opening hours, because that is
   * a gap somebody has to close, and `unknown` where the park is simply shut,
   * because nothing is expected of a box at four in the morning.
   */
  let state: HealthState;
  let detail: string | null;
  if (row.registeredAt === null) {
    state = 'unknown';
    detail = 'Waiting for its claim code to be redeemed — no agent has registered here yet.';
  } else if (row.status === 'disabled') {
    state = 'unknown';
    detail = 'Taken out of service by an administrator.';
  } else if (silent && openingHours === 'open') {
    state = 'down';
    detail = news?.summary ?? null;
  } else if (silent && openingHours === 'not_set') {
    state = 'warn';
    detail = `Silent, and opening hours are not set for ${row.branchName} — so nothing here is raised. Set them on the Branches panel.`;
  } else if (silent) {
    state = 'unknown';
    detail = `Silent, and ${row.branchName} is closed. A box is only called offline during trading.`;
  } else if (worst) {
    state = worst.severity === 'critical' ? 'down' : 'warn';
    detail = worst.summary;
  } else {
    state = 'ok';
    // A box with nothing wrong, and possibly something worth saying anyway.
    detail = news?.summary ?? null;
  }

  return {
    health: {
      id: row.id,
      name: row.name,
      slot: row.slot,
      role: row.role,
      status: row.status,
      state,
      branchId: row.branchId,
      branchName: row.branchName,
      openingHours,
      agentVersion,
      minAgentVersion: settings.minAgentVersion,
      agentBelowMinimum,
      lastHeartbeatAt: iso(row.lastHeartbeatAt),
      heartbeatAgeSeconds,
      uptimeSeconds: statusNumber(last, 'uptimeS'),
      outboxDepth,
      oldestUnackedAgeS,
      quarantineOpen,
      lastSyncAt: iso(sync?.lastSyncAt ?? null),
      clockOffsetMs,
      tempC: statusNumber(last, 'tempC'),
      currentEpoch: row.currentEpoch,
      configVersion: statusText(last, 'configVersion'),
      devices: devices.map((d) => ({
        id: d.id,
        kind: d.kind,
        label: d.label,
        reachability: d.reachability,
        paperStatus: d.paperStatus,
        lastError: d.lastError,
        lastSeenAt: iso(d.lastSeenAt),
      })),
      booths: booths.map((b) => ({
        stationId: b.stationId,
        name: b.name,
        codePrefix: b.codePrefix,
        // Same rule as the conditions above: one booth on the box, or nobody
        // gets the block the heartbeat could not say which booth it was about.
        reported: booths.length === 1 ? reportedBooth : null,
        unattributedToday: b.unattributedToday,
        businessDate: b.businessDate,
      })),
      conditions: active.map((c) => c.key),
      detail,
    },
    conditions,
  };
}

/**
 * Every live box, evaluated — for the Health page and for the watchdog.
 *
 * Read from `box.last_heartbeat_at` and `box.last_status`, the denormalised
 * newest report, rather than from `edge.box_heartbeat`: this runs on every
 * Health page load and on every watchdog tick, and it must stay one row per box
 * rather than the newest of half a million.
 *
 * `operatorId` narrows it to one tenant and `reach` to the branches the caller
 * actually holds (SCRUM-265); the watchdog passes neither, because a condition
 * is true whoever happens to be looking.
 */
export async function fleetHealth(
  deps: { db: Db; operatorId?: string | null; reach?: HealthReach },
  now = Date.now(),
): Promise<FleetSnapshot> {
  const settings = boxSettings();
  const rules: BoxRuleSettings = {
    offlineAfterS: settings.offlineAfterS,
    minAgentVersion: settings.minAgentVersion,
    syncStaleAfterS: syncSettings().staleAfterS,
  };

  const scope = deps.operatorId ? eq(box.operatorId, deps.operatorId) : undefined;
  // The branch half of the same question, and the reason it is a separate
  // clause: an operator-wide grant covers branches that do not exist yet, so
  // there is no list of ids that means "all of them".
  const withinReach = reachClause(deps.reach, box.branchId);
  const rows = (await deps.db
    .select({
      id: box.id,
      operatorId: box.operatorId,
      branchId: box.branchId,
      name: box.name,
      slot: box.slot,
      role: box.role,
      status: box.status,
      agentVersion: box.agentVersion,
      registeredAt: box.registeredAt,
      currentEpoch: box.currentEpoch,
      lastHeartbeatAt: box.lastHeartbeatAt,
      lastStatus: box.lastStatus,
      branchName: branch.name,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
      openingHours: branch.openingHours,
    })
    .from(box)
    .innerJoin(branch, eq(box.branchId, branch.id))
    .where(and(isNull(box.archivedAt), scope, withinReach ?? undefined))
    .orderBy(asc(branch.name), asc(box.slot))) as FleetBoxRow[];

  if (rows.length === 0) return { boxes: [], conditions: [] };

  const devices = (await deps.db
    .select({
      id: device.id,
      boxId: device.boxId,
      kind: device.kind,
      label: device.label,
      reachability: device.reachability,
      paperStatus: device.paperStatus,
      lastError: device.lastError,
      lastSeenAt: device.lastSeenAt,
    })
    .from(device)
    .where(
      and(
        inArray(
          device.boxId,
          rows.map((r) => r.id),
        ),
        isNull(device.archivedAt),
      ),
    )
    .orderBy(asc(device.label))) as FleetDeviceRow[];

  const byBox = new Map<string, FleetDeviceRow[]>();
  for (const d of devices) {
    const list = byBox.get(d.boxId) ?? [];
    list.push(d);
    byBox.set(d.boxId, list);
  }

  const sync = await boxSyncStates(
    deps.db,
    rows.map((r) => r.id),
    now,
  );

  const booths = await boxBooths(deps.db, rows, new Date(now));

  const snapshot: FleetSnapshot = { boxes: [], conditions: [] };
  for (const row of rows) {
    const { health, conditions } = evaluateBox(
      row,
      byBox.get(row.id) ?? [],
      rules,
      now,
      sync.get(row.id),
      booths.get(row.id) ?? [],
    );
    snapshot.boxes.push(health);
    snapshot.conditions.push(...conditions);
  }
  return snapshot;
}

/**
 * The booths on a set of boxes, and the one number about each that only the
 * cloud can answer (S2-07a).
 *
 * Two statements, and neither runs at all on a fleet with no booth — which is
 * every deployment until one is configured, and every till-only branch after
 * that. A booth is a station of kind `booth` with a `box_id`, which is the
 * same resolution `services/booth.ts` uses for `/booth/*`.
 *
 * The count is taken over each branch's TRADING day rather than the calendar
 * one, from `business_day_start`: a booth still spinning at half past midnight
 * is on the same day's figures as the afternoon, and D13's condition would
 * otherwise close itself at midnight while the wheel was still running.
 *
 * **What a failed lookup does, since the two rules differ.** An empty answer
 * here means `evaluateBox` emits no booth conditions at all, and a condition
 * that is not emitted is neither opened nor closed by the watchdog — so a
 * standing `booth.unattributed` survives a station query that did not answer.
 * `sync.stale` is not so lucky: it is emitted for every box, and without the
 * booth list its D10 clause is simply absent, so a silent booth's stale-sync
 * alert would close on that tick and reopen on the next one that answers.
 * That is a warning flapping once on a failed 2-second query, and it is said
 * here rather than engineered around.
 */
async function boxBooths(
  db: Db,
  rows: FleetBoxRow[],
  now: Date,
): Promise<Map<string, FleetBoothRow[]>> {
  const out = new Map<string, FleetBoothRow[]>();
  const byBox = new Map(rows.map((r) => [r.id, r]));

  const stations = await probe(
    async () =>
      (await db
        .select({
          stationId: station.id,
          boxId: station.boxId,
          name: station.name,
          codePrefix: station.codePrefix,
        })
        .from(station)
        .where(
          and(
            eq(station.kind, 'booth'),
            inArray(
              station.boxId,
              rows.map((r) => r.id),
            ),
            isNull(station.archivedAt),
          ),
        )
        .orderBy(asc(station.name))) as Array<{
        stationId: string;
        boxId: string;
        name: string;
        codePrefix: string | null;
      }>,
    [] as Array<{ stationId: string; boxId: string; name: string; codePrefix: string | null }>,
  );
  if (stations.length === 0) return out;

  const dated = stations.map((s) => {
    const owner = byBox.get(s.boxId)!;
    return {
      ...s,
      businessDate: businessDate(now, owner.timezone, parseDayStart(owner.businessDayStart)),
    };
  });

  /**
   * Vouchers issued at each booth today with nobody signed in.
   *
   * It reads `promo.voucher.issued_by_account_id` — **the very column the push
   * raises D13's alert from** — rather than `booth.spin.staff_account_id`
   * beside it. The two are written from one booth session and should agree,
   * but they are two columns from two sources, and this count is what CLOSES
   * the alert that column opened. Reading a second copy would let the
   * condition close an alert the push was still right to raise.
   *
   * What it cannot see is a voucher whose spin has not arrived: the link is
   * `booth.spin.voucher_id`, and until both facts land the pair is not joined.
   * Normally they travel in one batch. Where the spin is refused and
   * quarantined the voucher stays uncounted here, and the quarantine is its
   * own condition.
   *
   * `simulated = false` leaves out the `#debug` distribution run, which must
   * not raise anything about attribution: nobody is meant to be signed in for
   * it.
   */
  const counts = await probe(
    async () => {
      const ids = sql.join(
        dated.map((s) => sql`${s.stationId}::uuid`),
        sql`, `,
      );
      const dates = sql.join(
        [...new Set(dated.map((s) => s.businessDate))].map((d) => sql`${d}::date`),
        sql`, `,
      );
      const { rows: counted } = await db.execute<{
        station_id: string;
        business_date: string;
        n: string;
      }>(
        sql`select s.station_id, s.business_date::text as business_date, count(*)::text as n
              from booth.spin s
              join promo.voucher v on v.id = s.voucher_id
             where s.station_id in (${ids})
               and s.business_date in (${dates})
               and s.simulated = false
               and v.issued_by_account_id is null
             group by s.station_id, s.business_date`,
      );
      return counted;
    },
    /**
     * `null` rather than an empty list, and the difference is the whole point:
     * an empty result is "no booth issued an unattributed voucher today", and
     * a failed or timed-out query is "nobody knows". `evaluateBox` leaves the
     * condition unevaluated for the second, so a standing alert is not closed
     * by a query that never answered.
     */
    null as Array<{ station_id: string; business_date: string; n: string }> | null,
  );
  const counted = new Map(
    (counts ?? []).map((r) => [`${r.station_id}|${r.business_date}`, Number(r.n)]),
  );

  for (const s of dated) {
    const list = out.get(s.boxId) ?? [];
    list.push({
      stationId: s.stationId,
      boxId: s.boxId,
      name: s.name,
      codePrefix: s.codePrefix,
      unattributedToday:
        counts === null ? null : (counted.get(`${s.stationId}|${s.businessDate}`) ?? 0),
      businessDate: s.businessDate,
    });
    out.set(s.boxId, list);
  }
  return out;
}

/**
 * The sync numbers for a set of boxes, in three statements rather than three
 * per box (S2-05).
 *
 * Written here rather than imported from `services/sync.ts` on purpose: that
 * file already imports `recordRun` and `raiseAlert` from this one, and a
 * two-way runtime import between them would be a cycle with no upside. The
 * queries are small and belong to the page that reads them.
 *
 * `edge.box_outbox` is the box's own store, which on the virtual box IS this
 * database and on a Raspberry Pi is a SQLite file we cannot see. An empty
 * answer therefore means "we hold no copy", not "nothing is queued", which is
 * why `evaluateBox` falls back to what the box reported on its heartbeat.
 */
async function boxSyncStates(
  db: Db,
  boxIds: string[],
  now: number,
): Promise<Map<string, BoxSyncState>> {
  const out = new Map<string, BoxSyncState>();
  if (boxIds.length === 0) return out;
  for (const id of boxIds) {
    out.set(id, {
      outboxDepth: null,
      oldestUnackedAgeS: null,
      quarantineOpen: 0,
      epochRegressedOpen: 0,
      lastSyncAt: null,
      cursorBehindBy: 0,
      cursorHoleAt: null,
    });
  }

  const ids = sql.join(
    boxIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // A raw statement's `min(created_at)` arrives as `pg`'s text, not a Date
  // (SCRUM-475); the reader below wraps it in `new Date()` for that reason.
  const outbox = await probe(
    async () =>
      (
        await db.execute<{ box_id: string; depth: string; oldest: string | Date | null }>(
          sql`select box_id, count(*)::text as depth, min(created_at) as oldest
                from edge.box_outbox
               where state in ('queued','sending') and box_id in (${ids})
               group by box_id`,
        )
      ).rows,
    [] as Array<{ box_id: string; depth: string; oldest: string | Date | null }>,
  );
  for (const row of outbox) {
    const state = out.get(row.box_id);
    if (!state) continue;
    state.outboxDepth = Number(row.depth);
    state.oldestUnackedAgeS = row.oldest
      ? Math.max(0, Math.round((now - new Date(row.oldest).getTime()) / 1000))
      : null;
  }

  const quarantine = await probe(
    async () =>
      (
        await db.execute<{ box_id: string; open: string; epoch: string }>(
          sql`select box_id,
                     count(*)::text as open,
                     count(*) filter (where reason = 'epoch_regressed')::text as epoch
                from edge.sync_quarantine
               where status = 'open' and box_id in (${ids})
               group by box_id`,
        )
      ).rows,
    [] as Array<{ box_id: string; open: string; epoch: string }>,
  );
  for (const row of quarantine) {
    const state = out.get(row.box_id);
    if (!state) continue;
    state.quarantineOpen = Number(row.open);
    state.epochRegressedOpen = Number(row.epoch);
  }

  const cursors = await probe(
    async () =>
      (
        await db.execute<{ box_id: string; last_push_at: Date | null }>(
          sql`select box_id, max(last_push_at) as last_push_at
                from edge.sync_cursor
               where box_id in (${ids})
               group by box_id`,
        )
      ).rows,
    [] as Array<{ box_id: string; last_push_at: Date | null }>,
  );
  for (const row of cursors) {
    const state = out.get(row.box_id);
    if (!state) continue;
    state.lastSyncAt = row.last_push_at ? new Date(row.last_push_at) : null;
  }

  /**
   * How far the cursor is behind the ledger on the box's CURRENT epoch (S2-05).
   *
   * The ledger only, never quarantine: a filed event is a position the cloud
   * refused rather than one it is missing, and counting those would open this on
   * every press of "Inject poison event" — a control that must cost the box
   * nothing. A count of rows rather than `max(box_seq) - last_box_seq`, because
   * the number a person acts on is how many facts are stranded above the hole,
   * not how wide the numbering is; a box that once sealed an event a million
   * positions ahead would otherwise report a million.
   *
   * One index-only aggregate per box on `sync_event_journal_unique`, on a page
   * load and a watchdog tick rather than on a push. Its range is empty on a
   * healthy box, which is the case that has to be free; on a stalled one it
   * counts every position that has arrived since the hole, so a hole left open
   * for weeks makes this a longer scan — by which time `sync.cursor_stalled` has
   * been open for weeks too.
   */
  const stalled = await probe(
    async () =>
      (
        await db.execute<{ box_id: string; behind: string; hole: string | null }>(
          sql`select c.box_id,
                     count(e.box_seq)::text as behind,
                     case when count(e.box_seq) > 0
                          then (c.last_box_seq + 1)::text end as hole
                from edge.sync_cursor c
                join core.box b
                  on b.id = c.box_id and b.current_epoch = c.journal_epoch
                left join edge.sync_event e
                  on e.box_id = c.box_id
                 and e.journal_epoch = c.journal_epoch
                 and e.box_seq > c.last_box_seq
               where c.box_id in (${ids})
               group by c.box_id, c.last_box_seq`,
        )
      ).rows,
    [] as Array<{ box_id: string; behind: string; hole: string | null }>,
  );
  for (const row of stalled) {
    const state = out.get(row.box_id);
    if (!state) continue;
    state.cursorBehindBy = Number(row.behind);
    state.cursorHoleAt = row.hole === null ? null : Number(row.hole);
  }

  return out;
}

/**
 * One verdict for the page. `down` is kept for something that is actually
 * broken — a dependency failing, a job the watchdog calls critical, a box that
 * has gone quiet while the park is open, an open critical alert — so that the
 * loudest state stays worth reacting to.
 */
function overallStatus(
  checks: HealthCheck[],
  jobs: JobStatus[],
  boxes: BoxHealth[],
  alerts: AlertRow[],
): HealthState {
  if (checks.some((c) => c.status === 'down') || jobs.some((j) => j.status === 'down')) return 'down';
  if (boxes.some((b) => b.state === 'down')) return 'down';
  if (alerts.some((a) => a.severity === 'critical' && !a.acknowledgedAt)) return 'down';
  if (checks.some((c) => c.status === 'warn') || jobs.some((j) => j.status === 'warn')) return 'warn';
  if (boxes.some((b) => b.state === 'warn')) return 'warn';
  /**
   * `info` is news and not a fault, so it is listed without moving the
   * verdict (S2-07a). A booth reaching a prize's daily cap every afternoon
   * would otherwise leave the whole platform reading "1 thing needs
   * attention" until somebody acknowledged a row that says the wheel is
   * working.
   *
   * One alert raised before this ticket is also `info` and this changes what
   * it does: the Console's own test control, whose summary reads "A test
   * alert, raised from the Console. Nothing is wrong." It is still open, still
   * listed and still acknowledgeable; it no longer contradicts itself by
   * turning the headline amber.
   */
  if (alerts.some((a) => a.severity !== 'info' && !a.acknowledgedAt)) return 'warn';
  return 'ok';
}

/** Everything the Health page reads, in one answer. */
export async function healthSnapshot(deps: HealthDeps): Promise<HealthSnapshot> {
  const now = Date.now();
  /**
   * SCRUM-301 — the DEPLOYMENT's own state, answered only where it is somebody's.
   *
   * The dependency checks and the job register belong to no branch: a database
   * probe, a storage probe, a retention sweep that has not run. A branch-scoped
   * caller cannot act on any of them — the acknowledge and retry paths ask for
   * `admin:ops:manage` at the row's own branch, and a row with no branch is
   * asked about with none, which a branch-scoped grant does not cover — so
   * putting them on her page opened it on a failure that was never hers to fix.
   *
   * The boxes and the alerts below are already hers: both are narrowed by the
   * same reach, and `status` is then computed from what is left, so the verdict
   * she is answered with is about her park. An operator-wide caller's answer is
   * unchanged, and so is one that names no reach at all — `reach` is optional
   * on `HealthDeps`, though `GET /ops/health` is the only caller today and it
   * always names one.
   */
  const estateWide = !deps.reach || deps.reach.kind === 'operator';
  // Sequential rather than parallel: these share one small pool, and a health
  // page must never be the reason a till waits for a connection.
  const checks = estateWide ? await healthChecks(deps, now) : [];
  const jobs = estateWide ? await probe(() => jobRegister(deps, now), [] as JobStatus[]) : [];
  const fleet = await probe(
    () => fleetHealth({ db: deps.db, operatorId: deps.operatorId, reach: deps.reach }, now),
    { boxes: [], conditions: [] } as FleetSnapshot,
  );
  const alerts = await probe(() => openAlerts(deps), [] as AlertRow[]);
  const watchdogCheck = checks.find((c) => c.key === 'watchdog');

  return {
    status: overallStatus(checks, jobs, fleet.boxes, alerts),
    checks,
    jobs,
    boxes: fleet.boxes,
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
  /** SCRUM-265, as on the Health page: the caller's grants, not their session. */
  reach?: HealthReach;
  windowHours: number;
  kind?: string;
  cursor?: string;
  limit: number;
}

/**
 * The cursor is the sort key itself — a timestamp, and the tiebreak that gives
 * rows sharing that timestamp a total order — so a page resumes exactly where
 * the previous one stopped even as new rows arrive. Same shape as the audit
 * log's (routes/audit.ts).
 *
 * Exported because every keyset list under `/ops` uses this one encoding: the
 * failure groups below (newest failure + fingerprint), and the quarantine list
 * in `services/sync.ts` and the anomaly list further down this file (received
 * or detected time + row id). One format means a cursor is decoded the same way
 * and rejected the same way wherever it arrives.
 */
export function encodeCursor(at: string, tiebreak: string): string {
  return Buffer.from(`${at}|${tiebreak}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): { at: string; tiebreak: string } {
  const [at, tiebreak] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!at || !tiebreak || Number.isNaN(Date.parse(at))) {
    throw new AppError(400, 'BAD_REQUEST', 'Invalid cursor');
  }
  return { at, tiebreak };
}

/**
 * Row-wise comparison on the sort key, which is what makes the tie-break free:
 * groups sharing a last-seen timestamp still have a total order.
 */
function groupCursorClause(c: { at: string; tiebreak: string }): SQL {
  return sql`(max(${opsRun.startedAt}), ${opsRun.fingerprint}) < (${c.at}::timestamptz, ${c.tiebreak})`;
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
 *
 * SCRUM-265: a group carries the branch, station, request and action ids of
 * its newest run, so an unscoped page told a manager at one park which till at
 * the other park kept failing to print. Narrowed by the caller's reach, which
 * for a branch-scoped caller also drops the untenanted rows — a sweep, an
 * uncaught exception — because those are the deployment's, not a branch's.
 */
export async function failureGroups(db: Db, q: FailureQuery): Promise<FailurePage> {
  const since = new Date(Date.now() - q.windowHours * 3_600_000);
  const withinReach = reachClause(q.reach, opsRun.branchId);
  const clauses: SQL[] = [
    eq(opsRun.outcome, 'failed'),
    gte(opsRun.startedAt, since),
    isNotNull(opsRun.fingerprint),
    // A run belongs to this operator or to the platform (a job, a sweep, an
    // uncaught exception — none of which has a tenant).
    or(isNull(opsRun.operatorId), eq(opsRun.operatorId, q.operatorId))!,
  ];
  if (withinReach) clauses.push(withinReach);
  if (q.kind) clauses.push(eq(opsRun.kind, q.kind as OpsKind));

  const cursorClause = q.cursor ? groupCursorClause(decodeCursor(q.cursor)) : undefined;

  const rows = await db
    .select({
      fingerprint: sql<string>`${opsRun.fingerprint}`,
      kind: newestOf<string>(opsRun.kind),
      name: newestOf<string>(opsRun.name),
      count: sql<number>`count(*)::int`,
      // Aggregates are not decoded on their own: `pg` returns them as text
      // (SCRUM-475), so each borrows the column's decoder to be the Date it claims.
      firstSeenAt: sql`min(${opsRun.startedAt})`.mapWith(opsRun.startedAt),
      lastSeenAt: sql`max(${opsRun.startedAt})`.mapWith(opsRun.startedAt),
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
      groups.length === q.limit && last ? encodeCursor(last.lastSeenAt, last.fingerprint) : null,
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
          withinReach ?? undefined,
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

/**
 * The individual runs behind one group, newest first.
 *
 * Reached by a fingerprint typed into a query string, so it is narrowed by the
 * same reach as the list that offers the fingerprint (SCRUM-265) — otherwise
 * the group is hidden and its rows are one guess away.
 */
export async function runsForFingerprint(
  db: Db,
  q: { operatorId: string; reach?: HealthReach; fingerprint: string; limit: number },
): Promise<OpsRunRow[]> {
  const rows = await db
    .select()
    .from(opsRun)
    .where(
      and(
        eq(opsRun.fingerprint, q.fingerprint),
        or(isNull(opsRun.operatorId), eq(opsRun.operatorId, q.operatorId))!,
        reachClause(q.reach, opsRun.branchId) ?? undefined,
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

/**
 * One run, for the retry route to decide what it is being asked to re-run.
 *
 * SCRUM-281 — scoped to the operator, like every list above it. A run id
 * carries no tenancy, and this selected by id alone: an administrator of one
 * operator could name another's run, and the audit row for the retry was then
 * filed under the CALLER's operator for somebody else's sweep, which corrupts
 * the one record meant to settle who did what.
 *
 * `operator_id is null` is kept in reach deliberately, and it is the same
 * clause `failureGroups` and `runsForFingerprint` use: a scheduled sweep
 * belongs to the platform rather than to a tenant, and the Failures page that
 * offers the retry button is reading exactly those rows.
 */
export async function findRun(db: Db, id: string, operatorId: string) {
  const [row] = await db
    .select()
    .from(opsRun)
    .where(and(eq(opsRun.id, id), or(isNull(opsRun.operatorId), eq(opsRun.operatorId, operatorId))))
    .limit(1);
  return row ?? null;
}

/**
 * One alert, inside the caller's reach — the load half of load-then-check
 * (SCRUM-281).
 *
 * The acknowledge route had no load at all, so it acted on an id and an id
 * alone. Same reach as `findRun`: this operator's alerts, plus the
 * platform-wide ones the Health page shows everybody.
 */
export async function findAlert(
  db: Db,
  id: string,
  operatorId: string,
): Promise<{ id: string; key: string; branchId: string | null } | null> {
  const [row] = await db
    .select({ id: alert.id, key: alert.key, branchId: alert.branchId })
    .from(alert)
    .where(and(eq(alert.id, id), or(isNull(alert.operatorId), eq(alert.operatorId, operatorId))))
    .limit(1);
  return row ?? null;
}

// --- Anomalies (S2-05) ------------------------------------------------------
//
// The other half of the Failures > Quarantine tab. A quarantined event is one
// the cloud REFUSED and a person has to decide about; an anomaly is one it
// APPLIED, with a judgement worth recording — a clock it could not trust, a
// batch that arrived twice, a journal position that never came, the same phone
// number created at two boxes and merged. Nobody is waiting on these, and that
// is exactly why they need somewhere to be read: until this route existed they
// accumulated where nothing could show them.
//
// Read here rather than in `services/sync.ts`, where the quarantine list lives,
// because the page this answers is the Failures page: the cursor encoding, the
// `iso` helper and the 400 on a bad cursor are all in this file, and a second
// copy of any of them is how two lists under one prefix start disagreeing.

export interface SyncAnomalyRow {
  id: string;
  boxId: string;
  /** Denormalised: a box id alone names nothing to a person on call. */
  boxName: string | null;
  kind: string;
  eventId: string | null;
  /** The other event, where the kind is about a pair — the second half of a merge. */
  relatedEventId: string | null;
  /** Ids, counts and dates. See `safeDetail`. */
  detail: Record<string, unknown> | null;
  actionId: string | null;
  detectedAt: string;
}

export interface SyncAnomalyPage {
  anomalies: SyncAnomalyRow[];
  nextCursor: string | null;
}

export interface AnomalyQuery {
  operatorId: string;
  /** SCRUM-265 — through the box's branch, since the row carries none. */
  reach?: HealthReach;
  kind?: string;
  boxId?: string;
  cursor?: string;
  limit: number;
}

/**
 * What a row is allowed to carry onto the page.
 *
 * `sync_anomaly.detail` is already scrubbed where it is written (`pushEvents`
 * in `services/sync.ts` puts every detail through `scrubDetail` before the
 * insert), and what the call sites put there is ids, counts and dates. This
 * runs the same redactor again on the way out, for the two cases the write
 * path cannot cover: a row written by an earlier build, and a call site added
 * later that forgets. It is the same redactor, not a stronger one — a key
 * deny-list plus a value-shape sweep, which is a good filter and not a proof —
 * so the rule that actually keeps this page clean is still the one upstream:
 * a detail names things, never quotes a value.
 *
 * Twenty to fifty small objects per page; the cost does not signify.
 */
function safeDetail(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const scrubbed = scrubDetail(value);
  return scrubbed !== null && typeof scrubbed === 'object' && !Array.isArray(scrubbed)
    ? (scrubbed as Record<string, unknown>)
    : null;
}

/**
 * The anomaly record, newest first.
 *
 * **Paginated rather than grouped, unlike the failure list, and the difference
 * is what the rows mean.** Sixty failures behind one fingerprint are one break
 * repeating: the sixtieth says nothing the first did not, so collapsing them to
 * a row with a count of sixty loses nothing and is the only way the page stays
 * readable. Sixty anomalies are sixty different facts from the park. A `merge`
 * names the two member ids it reconciled; a `clock_recomputed` names the two
 * candidate trading days for one event; a `sequence_gap` names the positions
 * that went missing. Grouped by kind and box they would collapse to six rows
 * carrying no ids at all — which is the whole of what somebody opens this to
 * find. They are also not a work queue: an anomaly needs no decision, so there
 * is no backlog to make tractable by collapsing it.
 *
 * So: keyset pagination on `(detected_at, id)` — `id` is a UUIDv7, so it is a
 * total order and a stable tiebreak for rows sharing a timestamp — and the
 * Console asks for twenty at a time with a "Load more".
 *
 * Tenancy comes through the box, because `sync_anomaly` carries no operator of
 * its own; the schema says why (`packages/db/src/schema/sync.ts`).
 */
export async function anomalyPage(db: Db, q: AnomalyQuery): Promise<SyncAnomalyPage> {
  const clauses: SQL[] = [eq(box.operatorId, q.operatorId)];
  // The branch comes off the same joined box row the tenancy does, so the
  // reach costs no extra join (SCRUM-265).
  const withinReach = reachClause(q.reach, box.branchId);
  if (withinReach) clauses.push(withinReach);
  if (q.kind) clauses.push(eq(syncAnomaly.kind, q.kind as SyncAnomalyKind));
  if (q.boxId) clauses.push(eq(syncAnomaly.boxId, q.boxId));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    clauses.push(
      sql`(${syncAnomaly.detectedAt}, ${syncAnomaly.id}) < (${c.at}::timestamptz, ${c.tiebreak}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: syncAnomaly.id,
      boxId: syncAnomaly.boxId,
      boxName: box.name,
      kind: syncAnomaly.kind,
      eventId: syncAnomaly.eventId,
      relatedEventId: syncAnomaly.relatedEventId,
      detail: syncAnomaly.detail,
      actionId: syncAnomaly.actionId,
      detectedAt: syncAnomaly.detectedAt,
    })
    .from(syncAnomaly)
    .innerJoin(box, eq(syncAnomaly.boxId, box.id))
    .where(and(...clauses))
    .orderBy(desc(syncAnomaly.detectedAt), desc(syncAnomaly.id))
    .limit(q.limit);

  const anomalies: SyncAnomalyRow[] = rows.map((r) => ({
    id: r.id,
    boxId: r.boxId,
    boxName: r.boxName,
    kind: r.kind,
    eventId: r.eventId,
    relatedEventId: r.relatedEventId,
    detail: safeDetail(r.detail),
    actionId: r.actionId,
    detectedAt: iso(r.detectedAt)!,
  }));

  const last = anomalies[anomalies.length - 1];
  return {
    anomalies,
    // A short page is the last page; a full one may not be.
    nextCursor:
      anomalies.length === q.limit && last ? encodeCursor(last.detectedAt, last.id) : null,
  };
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
  operatorId: string,
): Promise<{ id: string; key: string; branchId: string | null } | null> {
  const now = new Date();
  const [row] = await exec
    .update(alert)
    .set({ status: 'acknowledged', acknowledgedAt: now, acknowledgedByAccountId: accountId, updatedAt: now })
    .where(
      and(
        eq(alert.id, id),
        // SCRUM-281 — the tenancy is in the statement that writes, not only in
        // the load that preceded it. The route checks the caller's permission
        // at this row's branch; the statement that then acts carries the same
        // reach, so the two cannot come apart.
        or(isNull(alert.operatorId), eq(alert.operatorId, operatorId)),
        isNull(alert.resolvedAt),
        isNull(alert.acknowledgedAt),
      ),
    )
    .returning({ id: alert.id, key: alert.key, branchId: alert.branchId });
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
    HANDOFF_APP_ORIGINS: string;
  };
  /** Null when this instance was built without object storage. */
  storage: { probe(): Promise<{ state: string; reason?: string }> } | null;
  watchdogJob: string;
}

/**
 * The other apps in the suite, asked whether they are up (S2-17a).
 *
 * A lifted app is a dependency like any outside service: the launcher shows a
 * tile for it, somebody presses it, and when it is down the only honest answer
 * on this page is that it is down. We know where each one lives because
 * `HANDOFF_APP_ORIGINS` already says so — it is the list of origins a token
 * may be spent at, so an app that can be signed into is an app worth
 * reporting, and nothing new has to be configured for this to work.
 *
 * Only apps with a health endpoint we can name are asked. The static sites
 * (the POS, the console) are CDN-served and have nothing to answer with.
 */
const APP_HEALTH: Record<string, { path: string; name: string; purpose: string }> = {
  oto_app: {
    path: '/api/status',
    name: 'OTO App',
    purpose: "The park's HR and daily operations, on the otoapp schema of this database.",
  },
};

async function suiteAppProviders(env: { HANDOFF_APP_ORIGINS: string }): Promise<IntegrationProvider[]> {
  const out: IntegrationProvider[] = [];
  for (const entry of env.HANDOFF_APP_ORIGINS.split(',')) {
    const [app, origin] = entry.split('=').map((s) => s?.trim());
    const known = app ? APP_HEALTH[app] : undefined;
    if (!known || !origin) continue;

    // A deployment across the sea that is asleep takes seconds to answer, and
    // this page must not take seconds. Unreachable here means "did not answer
    // quickly", which the card says rather than claiming the app is down.
    const health = await probe(
      async () => {
        const res = await fetch(`${origin}${known.path}`, {
          signal: AbortSignal.timeout(4_000),
          headers: { accept: 'application/json' },
        });
        return { ok: res.ok, status: res.status };
      },
      { ok: false, status: 0 },
      5_000,
    );
    out.push({
      key: app!,
      name: known.name,
      purpose: known.purpose,
      category: 'Suite apps',
      state: health.ok ? 'configured' : 'degraded',
      endpoint: origin,
      detail: health.ok
        ? null
        : health.status === 0
          ? 'Did not answer within four seconds. It may be starting, or down.'
          : `Answered ${health.status} rather than 200.`,
    });
  }
  return out;
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

  // --- The other apps in the suite
  providers.push(...(await suiteAppProviders(env)));

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
