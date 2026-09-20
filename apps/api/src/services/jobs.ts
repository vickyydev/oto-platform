import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { opsExpectation, opsLast, type AlertSeverity, type Db } from '@oto/db';
import type { Env } from '../env';
import { purgeExpiredIdempotencyKeys } from '../plugins/idempotency';
import { expireStaleCommands, markSilentBoxesOffline, purgeOldBoxHeartbeats } from './box';
import { purgeExpiredHandoffTokens } from './handoff';
import {
  buildAlertChannels,
  deliverAlert,
  fleetHealth,
  purgeOldOpsRuns,
  purgeResolvedAlerts,
  raiseAlert,
  recordRun,
  resolveAlert,
  type AlertChannel,
} from './ops';

/**
 * The job runner and the watchdog (S2-03).
 *
 * **Why this and not pg-boss.** pg-boss is a queue: jobs with payloads,
 * retries, priorities, dead letters, a managed `pgboss` schema and a migration
 * step of its own that every deploy must run and that this repository's
 * expand/contract rule (CONTRIBUTING.md) does not cover. What this ticket
 * actually needs is a handful of periodic sweeps that must not run twice —
 * there is no payload, no retry policy and no queue. The whole mechanism below
 * is a timer, an advisory lock and a row, and it is small enough to read in one
 * sitting, which is worth more here than a feature set nothing uses yet. When
 * something genuinely queue-shaped arrives — gateway status polling with
 * back-off, a webhook outbox — that is a queue, and it can be added behind the
 * same `JobDefinition` seam without moving any of this.
 *
 * **What stops two instances running one schedule twice.** Not the lock: a
 * lock is only held while a process lives, so it says nothing about whether a
 * tick already happened. The schedule lives in `ops_last.last_started_at` — a
 * row — and the advisory lock exists to make the read-and-claim of that row a
 * single decision. An instance that loses the race finds the tick claimed and
 * stands down. A process that dies mid-job leaves the claim standing and the
 * job simply runs again at its next interval, which is the right answer for a
 * sweep and is documented rather than clever.
 *
 * The api carries `jobs` in `PROCESS_ROLES` today, which is also why
 * `render.yaml` keeps autoscaling commented out: a second instance is safe as
 * far as this file is concerned, but not as far as the rest of the edge role
 * is.
 */

/** Ours, so a lock here can never collide with another tool's advisory lock. */
const LOCK_NAMESPACE = 0x070a;

/** Named once: `/ready` reports this job's age, and the watchdog is it. */
export const WATCHDOG_JOB = 'job:watchdog';

/**
 * Timers drift, and a tick arriving a few milliseconds early must not be
 * skipped and then wait a whole interval. A job is due at 90% of its interval,
 * which is far enough below one tick to be forgiving and far enough above half
 * that two instances cannot interleave into double the rate.
 */
const DUE_TOLERANCE = 0.9;

/**
 * The advisory lock a schedule is claimed under, as Postgres's two-integer
 * form. Exported because the only honest way to test "an instance that cannot
 * take the lock stands down" is for the test to take that exact lock.
 */
export function scheduleLockId(name: string): [namespace: number, key: number] {
  return [LOCK_NAMESPACE, createHash('sha256').update(name).digest().readInt32BE(0)];
}

export interface JobContext {
  db: Db;
  env: Env;
  log: FastifyBaseLogger;
  /** When the tick was claimed. Jobs use this rather than a fresh clock read. */
  now: Date;
}

export interface JobResult {
  /** Scrubbed and written to `ops_run.detail` — counts, not contents. */
  detail?: Record<string, unknown>;
}

export interface JobDefinition {
  /** `job:` prefixed, and the same string in `ops_run`, `ops_last` and the alert key. */
  name: string;
  /** One line for the Health page. */
  description: string;
  intervalSeconds: number;
  /** How late counts as missed. Defaults to one interval, at least 60 s. */
  graceSeconds?: number;
  /** How loudly the watchdog complains when this one stops running. */
  severity?: AlertSeverity;
  run(ctx: JobContext): Promise<JobResult | void>;
}

export type JobOutcome = 'ok' | 'failed' | 'locked' | 'not_due' | 'disabled';

export interface JobDeps {
  db: Db;
  env: Env;
  log: FastifyBaseLogger;
  channels: AlertChannel[];
}

// --- The watchdog -----------------------------------------------------------

export interface WatchdogSummary extends Record<string, unknown> {
  expectations: number;
  missing: number;
  failing: number;
  /** Live boxes examined, and how many of them this pass moved to `offline`. */
  boxes: number;
  boxesSilenced: number;
  opened: number;
  resolved: number;
}

/**
 * The one check that can notice a silence.
 *
 * Everything else in the observability design records what happened. This
 * compares what SHOULD have happened (`ops_expectation`) with what last did
 * (`ops_last`) and raises for the difference — which is how a sweep that
 * stopped being scheduled, or a box that stopped calling home, becomes visible
 * at all. It also raises for the opposite case, a job that runs faithfully and
 * fails every time, once it has failed `ALERT_FAILURE_THRESHOLD` times in a
 * row: one failure is noise, three is a pattern.
 *
 * Alerts are deduped, auto-resolved on recovery and flap-suppressed by
 * `raiseAlert`; this function decides only what is true right now.
 */
export async function runWatchdog(deps: JobDeps): Promise<WatchdogSummary> {
  const { db, env, log, channels } = deps;
  const now = new Date();
  const flapWindowSeconds = env.ALERT_FLAP_WINDOW_S;

  const expectations = await db.select().from(opsExpectation).where(eq(opsExpectation.enabled, true));
  const lasts = await db.select().from(opsLast);
  const byName = new Map(lasts.map((l) => [l.name, l]));

  const summary: WatchdogSummary = {
    expectations: expectations.length,
    missing: 0,
    failing: 0,
    boxes: 0,
    boxesSilenced: 0,
    opened: 0,
    resolved: 0,
  };

  const open = async (
    key: string,
    category: string,
    severity: AlertSeverity,
    subject: string,
    summaryLine: string,
    detail: Record<string, unknown>,
    /** A job belongs to nobody; a box belongs to a branch of an operator. */
    scope?: { operatorId: string; branchId: string },
  ): Promise<void> => {
    const raised = await raiseAlert(
      db,
      { key, category, severity, subject, summary: summaryLine, detail, ...scope },
      { flapWindowSeconds },
    );
    // Only a genuinely new condition is delivered. A repeat is the same
    // condition still being true, and a reopen inside the flap window is a
    // condition oscillating — sending either would train whoever receives
    // these to stop reading them.
    if (raised.outcome === 'opened') {
      summary.opened += 1;
      await deliverAlert(
        db,
        channels,
        { alertId: raised.id, key, category, severity, subject, summary: summaryLine, event: 'opened' },
        log,
      );
    }
  };

  /**
   * `clear` is how a condition stops being true, in its own words. A job that
   * ran again has recovered, and that is the default; a box that is still
   * silent at 21:05 has not, and writing "recovered" on that row would be a lie
   * in the one record somebody reads back after an incident.
   */
  const close = async (
    key: string,
    category: string,
    subject: string,
    clear?: { category: string; reason: string; summary: string },
  ): Promise<void> => {
    const resolved = await resolveAlert(db, key, clear?.reason ?? 'recovered');
    if (!resolved) return;
    summary.resolved += 1;
    if (resolved.wasNotified) {
      await deliverAlert(
        db,
        channels,
        {
          alertId: resolved.id,
          key,
          category: clear?.category ?? category,
          severity: 'info',
          subject,
          summary: clear?.summary ?? `${subject} has recovered`,
          event: 'resolved',
        },
        log,
      );
    }
  };

  /**
   * Only declared expectations are alerted on, in both directions.
   *
   * The temptation is to alert on any `ops_last` row failing repeatedly, which
   * would catch a broken route too — but a route only reaches `ops_last` when
   * it FAILS, so nothing would ever bring its failure count back to zero and
   * the alert would never resolve. Repeated failures of undeclared things are
   * shown on the Failures page, grouped by fingerprint, where they belong.
   * Declaring an expectation is how something asks to be alerted on.
   */
  for (const expectation of expectations) {
    if (expectation.mutedUntil && expectation.mutedUntil > now) continue;
    const last = byName.get(expectation.name);
    /**
     * The baseline when nothing has ever succeeded is the expectation's own
     * creation, not the process start: a job registered three days ago that
     * has never once run is exactly the failure this table exists to catch,
     * and restarting the service must not keep resetting its deadline.
     */
    const since = last?.lastOkAt ?? expectation.createdAt;
    const dueBy = since.getTime() + (expectation.intervalSeconds + expectation.graceSeconds) * 1000;
    const key = `ops.missing:${expectation.name}`;
    if (now.getTime() > dueBy) {
      summary.missing += 1;
      const overdueS = Math.round((now.getTime() - dueBy) / 1000);
      await open(
        key,
        'ops.missing',
        expectation.severity,
        expectation.name,
        `${expectation.name} has not succeeded since ${since.toISOString()} (${overdueS}s past its deadline)`,
        {
          expectedEverySeconds: expectation.intervalSeconds,
          graceSeconds: expectation.graceSeconds,
          lastOkAt: last?.lastOkAt?.toISOString() ?? null,
          lastOutcome: last?.lastOutcome ?? null,
          overdueSeconds: overdueS,
        },
      );
    } else {
      await close(key, 'ops.missing', expectation.name);
    }

    /**
     * The other half: something that runs faithfully and fails every time.
     * The missing rule would eventually catch it too — it has no recent
     * success — but an hourly sweep would take an hour to say so, and this
     * says it after three attempts and names the error code, which is the
     * part someone can act on.
     */
    const failKey = `ops.failing:${expectation.name}`;
    if (last && last.consecutiveFailures >= env.ALERT_FAILURE_THRESHOLD) {
      summary.failing += 1;
      await open(
        failKey,
        'ops.failing',
        expectation.severity,
        expectation.name,
        `${expectation.name} has failed ${last.consecutiveFailures} times in a row (${last.errorCode ?? 'unknown'})`,
        {
          consecutiveFailures: last.consecutiveFailures,
          errorCode: last.errorCode,
          fingerprint: last.fingerprint,
          lastFailedAt: last.lastFailedAt?.toISOString() ?? null,
          lastOkAt: last.lastOkAt?.toISOString() ?? null,
        },
      );
    } else {
      await close(failKey, 'ops.failing', expectation.name);
    }
  }

  /**
   * And then the fleet, which is the same check pointed at a machine in a mall
   * rather than at a sweep in this process.
   *
   * Two steps, in this order and for different reasons. `markSilentBoxesOffline`
   * writes the FACT — a box that has not called home within
   * `BOX_OFFLINE_AFTER_S` is offline — unconditionally, whatever the hour,
   * because the Devices page, the station picker and the config bundle all read
   * that column and none of them cares what time it is. `fleetHealth` then
   * makes the JUDGEMENT, and that one does care: a silent box is only raised
   * while the park is open.
   *
   * Every condition comes back evaluated, true and false alike, so a rule that
   * has stopped being true closes itself here without anybody pressing
   * anything — and it is the same evaluation the Health page renders, so the
   * page and the alert cannot tell two different stories about one box.
   */
  const silenced = await markSilentBoxesOffline(db);
  summary.boxesSilenced = silenced.length;
  if (silenced.length > 0) {
    log.warn(
      { boxes: silenced.map((b) => ({ slot: b.slot, duringOpeningHours: b.duringOpeningHours })) },
      'boxes moved to offline after silence',
    );
  }

  const fleet = await fleetHealth({ db }, now.getTime());
  summary.boxes = fleet.boxes.length;
  for (const c of fleet.conditions) {
    const scope = { operatorId: c.operatorId, branchId: c.branchId };
    if (c.active) await open(c.key, c.category, c.severity, c.subject, c.summary, c.detail, scope);
    else await close(c.key, c.category, c.subject, c.clear);
  }

  return summary;
}

// --- The jobs that exist today ---------------------------------------------

/**
 * Two of these three sweeps have existed since S2-01b and S2-02 and have never
 * once run: `purgeExpiredIdempotencyKeys` and `purgeExpiredHandoffTokens` were
 * written, exported, tested — and scheduled by nothing. That is the shape of
 * silent failure this whole ticket is about, which is why they are the first
 * things registered here.
 */
export function buildDefaultJobs(deps: JobDeps): JobDefinition[] {
  return [
    {
      name: WATCHDOG_JOB,
      description: 'Compares what should have run with what did, and raises alerts',
      intervalSeconds: deps.env.WATCHDOG_INTERVAL_S,
      /**
       * One missed tick is a busy minute; five is the watchdog itself being
       * down, which nothing else in the system can report — `/ready` answers
       * that from `ops_last`, and the external pinger answers it when the
       * whole process is gone.
       */
      graceSeconds: deps.env.WATCHDOG_INTERVAL_S * 4,
      severity: 'critical',
      run: async () => ({ detail: await runWatchdog(deps) }),
    },
    {
      name: 'job:housekeeping.idempotency',
      description: 'Deletes idempotency keys whose replay window has passed',
      intervalSeconds: deps.env.HOUSEKEEPING_INTERVAL_S,
      run: async ({ db }) => ({ detail: { deleted: await purgeExpiredIdempotencyKeys(db) } }),
    },
    {
      name: 'job:housekeeping.handoff',
      description: 'Deletes hand-off tokens whose 60-second window has passed',
      intervalSeconds: deps.env.HOUSEKEEPING_INTERVAL_S,
      run: async ({ db }) => ({ detail: { deleted: await purgeExpiredHandoffTokens(db) } }),
    },
    {
      name: 'job:housekeeping.retention',
      description:
        'Ages out operational runs, resolved alerts and box heartbeats, and expires stale box commands',
      intervalSeconds: deps.env.HOUSEKEEPING_INTERVAL_S,
      run: async ({ db, env }) => ({
        detail: {
          runsDeleted: await purgeOldOpsRuns(db, env.OPS_RUN_RETENTION_DAYS),
          alertsDeleted: await purgeResolvedAlerts(db, env.OPS_RUN_RETENTION_DAYS),
          /**
           * A row a minute per box, forever, is around half a million a year
           * each — so `edge.box_heartbeat` is a retention problem from the day
           * it exists rather than later. "Is this box well right now" is
           * answered from `box.last_status` and never touches this table, which
           * is what makes throwing its history away after two weeks cheap.
           */
          heartbeatsDeleted: await purgeOldBoxHeartbeats(db),
          /**
           * Not a delete. `pollCommands` expires only for the box that is
           * asking, which is never the box that died with work queued for it,
           * so a test print aimed at a dead Pi showed as pending for ever.
           * This closes those; nothing is removed, because `box_command`'s
           * restricting foreign key is what makes "a box is archived, never
           * deleted" a database fact.
           */
          commandsExpired: await expireStaleCommands(db),
        },
      }),
    },
  ];
}

// --- The runner -------------------------------------------------------------

export interface JobRunner {
  /** False unless `PROCESS_ROLES` names `jobs`; every method is then a no-op. */
  readonly enabled: boolean;
  readonly jobs: JobDefinition[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One pass over every job, running the ones that are due. */
  runDue(): Promise<Record<string, JobOutcome>>;
  /** Run one job now. `force` skips the due check — the console's "Run now". */
  runJob(name: string, opts?: { force?: boolean }): Promise<JobOutcome>;
  /**
   * Seconds since the watchdog last succeeded, or null if it never has.
   *
   * `/ready` reports this, and that is the answer to "who watches the
   * watchdog": nothing inside this process can raise an alert about the thing
   * that raises alerts, so the age is published instead and the external
   * pinger notices when it stops moving. It reads the row rather than a
   * counter in memory, so it is still true on an instance that does not carry
   * the jobs role.
   */
  watchdogAgeSeconds(): Promise<number | null>;
}

export interface JobRunnerOptions {
  db: Db;
  env: Env;
  log: FastifyBaseLogger;
  /** Defaults to the jobs above; tests and later tickets add their own. */
  jobs?: JobDefinition[];
  /** Defaults to what `ALERT_CHANNELS` asks for. */
  channels?: AlertChannel[];
}

export function processRoles(env: Env): string[] {
  return env.PROCESS_ROLES.split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

export function createJobRunner(opts: JobRunnerOptions): JobRunner {
  const { db, env } = opts;
  const log = opts.log.child({ module: 'jobs' });
  // Built here rather than on first use: a channel name with no implementation
  // must stop the process at boot, not on the night it is first needed.
  const channels = opts.channels ?? buildAlertChannels(env.ALERT_CHANNELS, log);
  const jobs = opts.jobs ?? buildDefaultJobs({ db, env, log, channels });
  const enabled = processRoles(env).includes('jobs');

  const timers = new Map<string, NodeJS.Timeout>();
  /** In-process guard: a job that overruns its interval must not overlap itself. */
  const running = new Set<string>();

  const graceOf = (job: JobDefinition): number =>
    job.graceSeconds ?? Math.max(60, job.intervalSeconds);

  /**
   * Registering a job is the same act as promising it will run, so it writes
   * the expectation the watchdog measures it against. `enabled` and
   * `muted_until` are deliberately left alone on conflict: those are decisions
   * a person made on the Console, and a deploy must not quietly undo them.
   */
  async function registerExpectations(): Promise<void> {
    for (const job of jobs) {
      await db
        .insert(opsExpectation)
        .values({
          name: job.name,
          kind: 'job',
          description: job.description,
          intervalSeconds: job.intervalSeconds,
          graceSeconds: graceOf(job),
          severity: job.severity ?? 'warning',
        })
        .onConflictDoUpdate({
          target: opsExpectation.name,
          set: {
            kind: sql`excluded.kind`,
            description: sql`excluded.description`,
            intervalSeconds: sql`excluded.interval_seconds`,
            graceSeconds: sql`excluded.grace_seconds`,
            severity: sql`excluded.severity`,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * Decide, once, whether this instance runs this tick — and write the
   * decision down before releasing the lock, so the answer survives the
   * process that made it.
   */
  async function claimTick(job: JobDefinition, force: boolean): Promise<Date | 'locked' | 'not_due'> {
    const [namespace, key] = scheduleLockId(job.name);
    return db.transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${namespace}::int4, ${key}::int4) as locked`,
      );
      if (!lock.rows[0]?.locked) return 'locked';

      const [last] = await tx
        .select({ lastStartedAt: opsLast.lastStartedAt })
        .from(opsLast)
        .where(eq(opsLast.name, job.name))
        .limit(1);

      const now = new Date();
      if (!force && last) {
        const elapsed = now.getTime() - last.lastStartedAt.getTime();
        if (elapsed < job.intervalSeconds * 1000 * DUE_TOLERANCE) return 'not_due';
      }

      await tx
        .insert(opsLast)
        .values({
          name: job.name,
          kind: 'job',
          lastOutcome: 'running',
          lastStartedAt: now,
        })
        .onConflictDoUpdate({
          target: opsLast.name,
          set: { lastOutcome: sql`excluded.last_outcome`, lastStartedAt: sql`excluded.last_started_at`, updatedAt: now },
        });
      return now;
    });
  }

  async function runJob(name: string, options: { force?: boolean } = {}): Promise<JobOutcome> {
    const job = jobs.find((j) => j.name === name);
    if (!job) throw new Error(`No job named ${name}`);
    if (!enabled) return 'disabled';
    if (running.has(job.name)) return 'locked';

    const claim = await claimTick(job, options.force ?? false);
    if (claim === 'locked' || claim === 'not_due') return claim;

    running.add(job.name);
    const startedAt = claim;
    try {
      const result = await job.run({ db, env, log, now: startedAt });
      await recordRun(db, {
        kind: 'job',
        name: job.name,
        outcome: 'ok',
        startedAt,
        detail: result?.detail,
      });
      return 'ok';
    } catch (err) {
      /**
       * On the pool, after whatever the job did has rolled back — the same
       * rule as the failure audit row in `services/tx.ts`. A record of an
       * attempt that dies with the transaction that failed is no record.
       */
      try {
        await recordRun(db, { kind: 'job', name: job.name, outcome: 'failed', startedAt, error: err });
      } catch (recordErr) {
        // Never let the record of a failure replace the failure itself.
        log.error({ err: recordErr, job: job.name }, 'job failure could not be recorded');
      }
      log.error({ err, job: job.name }, 'job failed');
      return 'failed';
    } finally {
      running.delete(job.name);
    }
  }

  async function runDue(): Promise<Record<string, JobOutcome>> {
    const outcomes: Record<string, JobOutcome> = {};
    // Sequential on purpose: these share one small pool, and a sweep that
    // waits a second behind another is nobody's problem.
    for (const job of jobs) {
      outcomes[job.name] = await runJob(job.name);
    }
    return outcomes;
  }

  return {
    enabled,
    jobs,
    async start() {
      if (!enabled) {
        log.info({ roles: processRoles(env) }, 'job runner idle — this process does not carry the jobs role');
        return;
      }
      await registerExpectations();
      // One pass at boot, still subject to the due check: a deploy every ten
      // minutes must not run the hourly sweeps six times an hour, and a
      // deploy after an outage should catch up immediately.
      await runDue();
      for (const job of jobs) {
        const timer = setInterval(() => {
          void runJob(job.name).catch((err) => log.error({ err, job: job.name }, 'job tick failed'));
        }, job.intervalSeconds * 1000);
        // A pending timer must never be the reason the process cannot exit.
        timer.unref();
        timers.set(job.name, timer);
      }
      log.info({ jobs: jobs.map((j) => j.name) }, 'job runner started');
    },
    async stop() {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
    },
    runDue,
    runJob,
    async watchdogAgeSeconds() {
      const [row] = await db
        .select({ lastOkAt: opsLast.lastOkAt })
        .from(opsLast)
        .where(eq(opsLast.name, WATCHDOG_JOB))
        .limit(1);
      if (!row?.lastOkAt) return null;
      return Math.max(0, Math.round((Date.now() - row.lastOkAt.getTime()) / 1000));
    },
  };
}
