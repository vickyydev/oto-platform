import { eq, sql } from 'drizzle-orm';
import { opsLast } from '@oto/db';
import type { App } from '../app';

/**
 * Liveness and readiness (S2-03).
 *
 * The distinction is the whole point. `/health` says the process is up.
 * `/ready` says it can serve, and Render takes a service out of rotation the
 * moment `/ready` is unhappy — so the only thing allowed to fail it is a
 * dependency without which no request can be answered at all. That is the
 * database and nothing else: a park must not lose its till because object
 * storage is unreachable or because a background job is late. Everything
 * else is reported as `degraded` with a 200, which is what the external
 * pinger raises `ready.degraded` from.
 */

/**
 * A readiness probe that waits is a readiness probe that fails. Render's
 * timeout is shorter than the pool's own connection timeout, so the check
 * gives up first and says so rather than being killed mid-answer.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * How late the watchdog may be, in runs rather than in seconds: three missed
 * ones is a job runner that has stopped, where one is a runner that is busy.
 * Derived from the schedule so changing the interval does not quietly leave
 * readiness measuring against the old one.
 */
const WATCHDOG_STALE_AFTER_RUNS = 3;

/** The job runner's own name for its heartbeat, in `ops_last`. */
const WATCHDOG_JOB = 'job:watchdog';

interface PoolState {
  total: number;
  idle: number;
  waiting: number;
  max: number | null;
}

/** node-postgres pool counters, when the client underneath is one. */
function poolState(app: App): PoolState | null {
  const client = (app.db as { $client?: unknown }).$client as
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

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error('probe timed out')), ms).unref(),
    ),
  ]);
}

export async function healthRoutes(app: App): Promise<void> {
  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));

  app.get('/ready', { config: { public: true } }, async (_req, reply) => {
    const started = Date.now();
    let databaseOk = false;
    try {
      await withTimeout(app.db.execute(sql`select 1`), PROBE_TIMEOUT_MS);
      databaseOk = true;
    } catch {
      databaseOk = false;
    }
    const latencyMs = Date.now() - started;

    /**
     * How long since the watchdog last succeeded. Read from `ops_last` rather
     * than from the runner, because the question readiness has to answer is
     * "has anything been watching", and a runner that has stopped cannot be
     * asked. Missing row, unapplied migration, unreachable table — all of them
     * answer "unknown" and none of them fails the probe: the job runner is not
     * what the till needs in order to take money.
     */
    let watchdogAgeS: number | null = null;
    let watchdogConfigured = false;
    try {
      const [row] = await withTimeout(
        app.db
          .select({ lastOkAt: opsLast.lastOkAt })
          .from(opsLast)
          .where(eq(opsLast.name, WATCHDOG_JOB))
          .limit(1),
        PROBE_TIMEOUT_MS,
      );
      watchdogConfigured = Boolean(row);
      if (row?.lastOkAt) {
        watchdogAgeS = Math.round((Date.now() - row.lastOkAt.getTime()) / 1000);
      }
    } catch {
      watchdogConfigured = false;
    }
    const staleAfterS = app.env.WATCHDOG_INTERVAL_S * WATCHDOG_STALE_AFTER_RUNS;
    const watchdogStale = watchdogAgeS !== null && watchdogAgeS > staleAfterS;

    const body = {
      status: !databaseOk ? 'not_ready' : watchdogStale ? 'degraded' : 'ready',
      checks: {
        database: { ok: databaseOk, latencyMs },
        pool: poolState(app),
        jobs: { configured: watchdogConfigured, watchdogAgeS, staleAfterS, stale: watchdogStale },
      },
    };
    return databaseOk ? body : reply.status(503).send(body);
  });
}
