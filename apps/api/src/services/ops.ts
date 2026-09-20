import { redact } from '@oto/telemetry';
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  alert,
  alertDelivery,
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
