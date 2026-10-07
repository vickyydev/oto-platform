import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { opsExpectation, opsLast, type AlertSeverity, type Db } from '@oto/db';
import type { Env } from '../env';
import { purgeExpiredIdempotencyKeys } from '../plugins/idempotency';
import { ROLLUP_DAILY_JOB, ROLLUP_HOURLY_JOB, runDailyRollupJob, runHourlyRollupJob } from './analytics-rollup';
import { ROLLUP_BOOTH_JOB, runBoothRollupJob } from './analytics-booth';
import { BENEFIT_ROLLOVER_JOB, runBenefitRolloverJob } from './analytics-benefits';
import { BOOTH_DUTY_JOB, runMorningBoothDutySync } from './booth-duty';
import { EVENTS_CACHE_REFRESH_JOB, runEventsCacheRefresh } from './events';
import {
  expireStaleCommands,
  markSilentBoxesOffline,
  purgeOldBoxHeartbeats,
  withinOpeningHours,
} from './box';
import { purgeExpiredHandoffTokens } from './handoff';
import { OCCUPANCY_JOB, runOccupancyJob } from './occupancy';
import { flagPendingPayments, gatewayFor, pollPendingAttempts } from './payments/gateway';
import { PRINT_RETENTION_DAYS, purgeOldPrintJobs } from './print';
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
import {
  purgeOldStationEvents,
  purgeOldSyncAnomalies,
  purgeOldSyncChanges,
  purgeOldSyncEvents,
  syncSettings,
} from './sync';
import { runStockDailyJob, STOCK_DAILY_JOB } from './stock';
import { runWalletExpiryJob, runWalletLiabilityJob } from './wallet';

/** S2-14a round 3 — the wallet day-end jobs, named once (the runner, the tests, the Health page). */
export const WALLET_EXPIRY_JOB = 'job:wallet.expiry';
export const WALLET_LIABILITY_JOB = 'job:wallet.liability';

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
  /**
   * RESOLVING THE GATEWAY IS WHAT ANNOUNCES IT, and this is where a boot first
   * needs it: the poller below cannot be described without knowing which
   * `QrPayment` is live. `gatewayFor` memoises, so this is also the only time
   * the line is logged — "payment gateway: …", naming the provider and, when a
   * credential is unset, naming the VARIABLE and never its value
   * (`PAYMENT_GATEWAY.md:786-788`). A deployment quietly running a pretend
   * gateway therefore says so in its first few log lines, and a PRODUCTION
   * deployment never gets this far: `assertProductionSafe` refuses the boot.
   */
  gatewayFor(deps.env, deps.log);

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
        'Ages out operational runs, resolved alerts, box heartbeats, the sync ledger, the change feed, station telemetry and the print record, and expires stale box commands',
      intervalSeconds: deps.env.HOUSEKEEPING_INTERVAL_S,
      run: async ({ db }) => {
        const sync = syncSettings();
        return {
          detail: {
            ...(await legacySweeps(db, deps.env)),
            /**
             * The sync core's four windows (S2-05). The reasoning behind each
             * is on its table in `packages/db/src/schema/sync.ts`; what matters
             * here is what is NOT swept — `edge.sync_cursor`, which is what
             * keeps a replayed year-old batch recognisable after its ledger row
             * has gone, and `edge.sync_quarantine`, which is small by
             * construction and whose growth is itself the signal.
             */
            syncEventsDeleted: await purgeOldSyncEvents(db, sync.eventRetentionDays),
            syncAnomaliesDeleted: await purgeOldSyncAnomalies(db, sync.eventRetentionDays),
            syncChangesDeleted: await purgeOldSyncChanges(db, sync.changeRetentionDays),
            stationEventsDeleted: await purgeOldStationEvents(db, sync.stationEventRetentionDays),
            /**
             * The print record (S2-06), ninety days by `queued_at`. Every
             * question this table answers — did it print, why is the queue
             * stuck, which printer eats paper — is asked within days; the ones
             * asked in a year are asked of the sale and of the audit log,
             * neither of which is swept.
             */
            printJobsDeleted: await purgeOldPrintJobs(db, PRINT_RETENTION_DAYS),
          },
        };
      },
    },
    /**
     * THE INQUIRY POLLER (S2-10a) — the safety net under the payment webhook.
     *
     * "The poller and the webhook write through the same idempotent 'mark
     * paid' service, so whichever arrives first wins and the second is a
     * no-op" (`PAYMENT_GATEWAY.md:674-684`). The webhook is the fast path;
     * this is the one that has to work when the fast path does not — a
     * notification that never arrived, a deploy that was restarting when it
     * did, 2C2P answering `9999` to itself. The acceptance for this ticket
     * proves it by suppressing the webhook entirely.
     *
     * ITS INTERVAL IS THE DOCUMENT'S DIAL, and a deployment should turn it.
     * `PGW_INQUIRY_INTERVAL_S` defaults to three seconds, which is right for a
     * QR on a display in front of a guest and expensive as a global tick: one
     * `ops_run` row per tick is about 29,000 rows a day against roughly 8,600
     * at ten seconds, on a table that already prunes itself at
     * `OPS_RUN_RETENTION_DAYS`. The per-attempt back-off inside
     * `pollPendingAttempts` is what actually decides how often a given QR is
     * asked about, so raising this to ten costs at most seven seconds on the
     * ONE case where the webhook failed — which is why staging sets it in
     * `render.yaml` rather than running the local default.
     */
    {
      name: 'job:payments.inquiry',
      description: 'Asks the payment gateway about every QR still waiting, and settles the ones that were paid',
      intervalSeconds: deps.env.PGW_INQUIRY_INTERVAL_S,
      /**
       * A minute, not one interval. Three seconds of grace on a three-second
       * job would raise an alert on any busy tick, and what this expectation
       * is really watching for is the poller having stopped altogether.
       */
      graceSeconds: 60,
      run: async ({ db, env, log, now }) => ({
        detail: await pollPendingAttempts(db, env, log, now),
      }),
    },
    /**
     * `job:payments.pending` — NO TENDER WITH AN UNKNOWN OUTCOME IS LEFT
     * SILENT.
     *
     * A DIFFERENT DIAL FROM THE POLLER'S, and the plan is emphatic that the
     * two are not the same thing: `PGW_INQUIRY_MAX_MIN` (thirty) is when this
     * platform stops ASKING the gateway, and `PAYMENT_PENDING_MIN` (ten) is
     * when it stops waiting quietly and puts the attempt on the Failures page.
     * Ten minutes is a guest who has left the counter; half an hour is a
     * family who has left the mall.
     *
     * It covers the card terminal's `unknown` as well as the gateway's
     * pending states, deliberately: a tender that never came back from a
     * terminal is the same failure as one that never came back from a gateway,
     * and the rule is about the sale, not about the instrument.
     */
    {
      name: 'job:payments.pending',
      description: 'Flags payment attempts with no outcome on the Failures page, clears the flag when they are answered, and ends unpaid booking holds that have run out',
      intervalSeconds: 60,
      run: async ({ db, env, log, now }) => ({ detail: await flagPendingPayments(db, env, now, log) }),
    },
    /**
     * `job:booth.duty_sync` — THE DAY'S BOOTH STAFF, AT THE BRANCH'S OPEN
     * (SCRUM-473, plan D4).
     *
     * A five-minute tick that does the work once per booth per trading day:
     * the first tick at which the branch is open and the booth has no sync
     * recorded for today reads the OTO App's schedule and writes the day's
     * roster (`runMorningBoothDutySync` in `services/booth-duty.ts`). Every
     * other tick finds nothing due and costs one query per booth. "Sync now"
     * in the Console is the same sync on demand, and a booth synced that way
     * is not synced again by this job the same day.
     */
    {
      name: BOOTH_DUTY_JOB,
      description: "Reads the OTO App's schedule at each branch's open and writes the day's booth staff",
      intervalSeconds: 300,
      run: async ({ db, now }) => ({
        detail: await runMorningBoothDutySync(db, now, withinOpeningHours),
      }),
    },
    /**
     * `job:occupancy.facts` — THE HEAD COUNT, KEPT (S2-12 round 4).
     *
     * Every five minutes, for each branch with a gate: the live occupancy
     * projection at the current quarter-hour and the two hours before it,
     * upserted into `analytics.fact_occupancy_15min` (recomputed rather than
     * appended, so a passage from a gate box that was offline corrects the
     * buckets it belongs to); then the day-end clear of the trading days that
     * have ended — a week back, so a job that was down across a boundary still
     * closes the days it missed — which audits any group the gate still
     * counted inside at the boundary (`services/occupancy.ts`). Five minutes
     * so every quarter-hour is sampled at least twice.
     */
    {
      name: OCCUPANCY_JOB,
      description:
        "Writes each gate branch's head count per quarter-hour and records the groups still counted inside when a trading day ends",
      intervalSeconds: 300,
      run: async ({ db, now }) => ({ detail: await runOccupancyJob(db, now) }),
    },
    /**
     * `job:wallet.expiry` — THE BRANCH'S DAY ENDS, ITS CREDIT EXPIRES (S2-14a
     * round 3, plan §2.5).
     *
     * Every five minutes, for each live branch, the trading days that have
     * ENDED — a week back, as the occupancy day-end does, so a job that was
     * down across a boundary still closes the days it missed: every wallet
     * whose credit's expiry (recorded from the branch's `wallet_policy` when it
     * was granted — same day, N days, never) has passed loses what it held
     * through that day, as an `expire` entry keyed by branch, date and wallet
     * (`expireWalletsForDay` in `services/wallet.ts`). A rerun writes nothing
     * new. A counter cannot spend credit in the minutes between the boundary
     * and this tick: the spend checks the expiry's clock as well as the status.
     */
    {
      name: WALLET_EXPIRY_JOB,
      description: "Expires each branch's wallet credit at the end of its trading day, by the branch's wallet policy",
      intervalSeconds: 300,
      run: async ({ db, now }) => ({ detail: await runWalletExpiryJob(db, now) }),
    },
    /**
     * `job:wallet.liability` — THE OFFICE'S DAILY STORED-VALUE FACT (round 3).
     *
     * After the expiry above (array order is run order in `runDue`), each live
     * branch's ended days are recomputed from the ledger into
     * `analytics.fact_wallet_liability_daily` — granted, spent, refunded back,
     * expired, reactivated, outstanding — and upserted only when a figure
     * moved, so a quiet tick writes nothing and a late offline spend corrects
     * the day it belongs to. outstanding(D) = outstanding(D-1) + granted -
     * spent + refunded - expired + reactivated, exactly (wallet-r3-figures).
     */
    {
      name: WALLET_LIABILITY_JOB,
      description: "Writes each branch's daily wallet liability (granted, spent, refunded, expired, outstanding) from the ledger",
      intervalSeconds: 300,
      run: async ({ db, now }) => ({ detail: await runWalletLiabilityJob(db, now) }),
    },
    /**
     * `job:stock.daily` — THE OFFICE'S DAILY STOCK FACT AND THE SLIDING
     * REORDER POINT (S2-14b round 4, plan §2.5).
     *
     * Every five minutes, for each live branch, the trading days that have
     * ENDED — a week back, as the wallet jobs do — recomputed from the stock
     * ledger into `analytics.fact_stock_daily` per size (opening, sold,
     * refunded, received, transferred, adjusted, counted, closing, value) and
     * upserted only where a figure moved, so a quiet tick writes nothing and a
     * late offline sale corrects the day it belongs to; closing = opening +
     * the day's movements, sign-exact (`stockDayFacts`). Then the branch's
     * low-stock attention is re-read whole: the 30-day usage window behind the
     * trend reorder point (OD-27) slides with the date, not with a movement.
     */
    {
      name: STOCK_DAILY_JOB,
      description: "Writes each branch's daily stock fact per size from the ledger and re-reads its low-stock alerts as the 30-day usage window slides",
      intervalSeconds: 300,
      run: async ({ db, now }) => ({ detail: await runStockDailyJob(db, now) }),
    },
    /**
     * `job:rollup.daily` — THE DAY'S FIGURES, KEPT (S2-15b round 2, plan
     * docs/progress/plans/analytics/PLAN.md §8).
     *
     * Every `ROLLUP_INTERVAL_S`: today at every live branch, written as a
     * provisional `analytics.daily_summary` row under formula version 1 (the
     * prototype's Performance rule); every day a late fact marked in
     * `analytics.dirty_date` — a refund of an old sale, a box sale synced
     * days late — recomputed; and every provisional day that has since ended
     * rewritten without the flag. A row is written only when its figures
     * moved, a frozen legacy day never, and each branch-day under its own
     * lock (`services/analytics-rollup.ts`). Then the calendar
     * (`analytics.dim_date`) is brought up to date with the branch holidays.
     */
    {
      name: ROLLUP_DAILY_JOB,
      description:
        "Rolls each branch's trading days into the daily summary: today as provisional, every day a late fact marked, and each day once it has ended",
      intervalSeconds: deps.env.ROLLUP_INTERVAL_S,
      run: async ({ db, now }) => ({ detail: await runDailyRollupJob(db, now) }),
    },
    /**
     * `job:rollup.hourly` — the same money buckets per wall-clock hour, after
     * the daily rollup (array order is run order in `runDue`): today, and every
     * day the daily rollup recomputed, into `analytics.hourly_summary`.
     */
    {
      name: ROLLUP_HOURLY_JOB,
      description: "Rolls each branch's trading days into the hourly summary: today, and every day the daily rollup recomputed",
      intervalSeconds: deps.env.ROLLUP_INTERVAL_S,
      run: async ({ db, now }) => ({ detail: await runHourlyRollupJob(db, now) }),
    },
    /**
     * `job:rollup.booth` — THE BOOTH'S DAY (S2-15b round 5, plan §5, §8):
     * today at every live branch, and every day a booth fact marked (a spin
     * filed, its voucher linked, a booth voucher redeemed — migration 0065),
     * into `analytics.fact_booth_daily` per booth, staff member and prize. The
     * `#debug` distribution run never reaches it.
     */
    {
      name: ROLLUP_BOOTH_JOB,
      description: "Rolls each branch's booth spins and vouchers into the booth fact: today, and every day a booth fact marked",
      intervalSeconds: deps.env.ROLLUP_INTERVAL_S,
      run: async ({ db, now }) => ({ detail: await runBoothRollupJob(db, now) }),
    },
    /**
     * `job:benefit.period_rollover` — THE STAFF BENEFITS' PREVIOUS PERIOD,
     * CLOSED (S2-21 round 4, benefits PLAN §5).
     *
     * Every five minutes, as the other day-end jobs: each live branch's
     * trading days that have ENDED — a week back, and any still provisional
     * however old — rewritten final into `analytics.fact_benefit_daily`
     * (`runBenefitRolloverJob` in `services/analytics-benefits.ts`). The daily
     * rollup above writes the same rows as the day goes; this is the day
     * start's close, so the first tick after a branch's day turns over closes
     * yesterday and, on the first of a month, the month's staff credit period.
     * It is NOT what makes a new day's coffees or a new month's credit count
     * from zero — a period is a key, and a new key has never been counted
     * under — and registering it writes the expectation the watchdog raises
     * `ops.missing` from on the Health page when it stops.
     */
    {
      name: BENEFIT_ROLLOVER_JOB,
      description:
        "Closes each branch's staff benefit figures at its day start: every ended trading day, a week back and any still provisional, rewritten final into the benefits fact",
      intervalSeconds: 300,
      run: async ({ db, now }) => ({ detail: await runBenefitRolloverJob(db, now) }),
    },
    /**
     * `job:events.cache_refresh` — TODAY'S EVENTS FOR THE BOXES (S2-20 E1,
     * events-kiosk PLAN §5, §10, hazard H19).
     *
     * On the rollup cadence: every live branch's `events` cache item — its
     * events on its business day, a camp on every day of its range, each with
     * its children and the day's check-ins — built from the OTO App's views
     * exactly as a box is served it (`runEventsCacheRefresh` in
     * `services/events.ts`). A box's pull leaves that scope out rather than
     * failing over another app's fault, so this is where a broken seam is
     * loud: the job fails and the watchdog raises it, and registering the job
     * wrote the expectation that raises `ops.missing` when it stops.
     */
    {
      name: EVENTS_CACHE_REFRESH_JOB,
      description:
        "Builds each branch's events for today — a camp on every day of its range — from the OTO App for its boxes' offline copy, and fails when the OTO App's events cannot be read",
      intervalSeconds: deps.env.ROLLUP_INTERVAL_S,
      run: async ({ db, now }) => ({ detail: await runEventsCacheRefresh(db, now) }),
    },
  ];
}

/** The sweeps that existed before the sync core, unchanged. */
async function legacySweeps(db: Db, env: Env): Promise<Record<string, number>> {
  return {
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
     * Not a delete. `pollCommands` expires only for the box that is asking,
     * which is never the box that died with work queued for it, so a test print
     * aimed at a dead Pi showed as pending for ever. This closes those; nothing
     * is removed, because `box_command`'s restricting foreign key is what makes
     * "a box is archived, never deleted" a database fact.
     */
    commandsExpired: await expireStaleCommands(db),
  };
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
