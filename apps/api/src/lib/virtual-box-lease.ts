import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';

/**
 * One instance runs the cloud virtual box, and the database decides which
 * (SCRUM-331).
 *
 * **What went wrong without this.** The virtual box is the ordinary
 * `@oto/box-agent` agent started by the `edge` role, and its identity is a
 * `core.box` row rather than anything the container owns. A Render rollover
 * runs the outgoing and incoming instances together for a few seconds, so for
 * those seconds TWO agents drove that one row: each minted itself a claim code,
 * which revokes the other's secret, and each was then refused and registered
 * again. Measured on staging: 637 refusals and 549 registrations of one box in
 * a day, every registration throwing the box's whole offline cache away because
 * a fresh registration has no etag. `render.yaml` holds the service at one
 * instance partly for this reason, and a note there says so — a comment cannot
 * hold a rollover to one instance, and this can.
 *
 * **The mechanism.** A session-level Postgres advisory lock on a key derived
 * from the box the virtual box stands for, taken on a connection this module
 * opens and holds for the life of the process. Session-level, not
 * transaction-level (`services/jobs.ts` uses that one, for the different job of
 * claiming a single tick): the lock has to outlive the statement that took it
 * and die with the process, and a lock that dies with the process is precisely
 * what a container Render has just stopped hands over.
 *
 * **Why a dedicated connection and not the pool.** An advisory lock belongs to
 * the session that took it. A pooled connection goes back to the pool when the
 * query ends, carries the lock away to whatever asks next, and is released on
 * an idle timeout at a moment nobody chose. So the lease owns one connection
 * outright — one more than the pool's ten per instance, which is inside the
 * budget `render.yaml` sets out — and closing it IS releasing the lease.
 *
 * **What an instance that does not win does.** It starts nothing: no agent is
 * constructed, so no claim code is minted and no registration happens. It
 * retries every few seconds and takes over the moment the connection holding
 * the lease goes away, which for a rollover is the moment Render stops the old
 * container. Losing the connection while holding is treated the same way as
 * never having won: the box is stopped and the loop goes back to asking, because
 * an agent running without the lease is the thing this file exists to prevent.
 */

/**
 * Ours, and deliberately not `services/jobs.ts`'s `0x070a`: a lease is not a
 * schedule, and two families of lock that can never collide are worth the one
 * extra constant.
 */
const LOCK_NAMESPACE = 0x070e;

/** How often a standing-by instance asks again, and a holder checks it still holds. */
const RETRY_INTERVAL_MS = 5_000;

/**
 * The advisory lock a virtual box is held under, as Postgres's two-integer
 * form. Exported so a test can name the same key, and so anybody reading
 * `pg_locks` on a live database can work out which row a `classid`/`objid`
 * pair belongs to.
 */
export function virtualBoxLockId(name: string): [namespace: number, key: number] {
  return [LOCK_NAMESPACE, createHash('sha256').update(name).digest().readInt32BE(0)];
}

/**
 * The one connection a lease holds, narrowed to what it uses.
 *
 * A `pg.Client` in production. Narrow because a test needs to be able to hand
 * over something else — and because the two events below are the whole of what
 * this file needs to know about a connection dying.
 */
export interface LeaseConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (err?: Error) => void): void;
}

export interface VirtualBoxLeaseOptions {
  /**
   * What is being leased, as a string every instance of this deployment
   * computes identically — the branch and slot of the box the agent stands
   * for. It is hashed into the lock key, so two deployments that do not share
   * a box do not share a lease.
   */
  name: string;
  /**
   * The same URL the pool was opened with. Undefined lets `pg` read the
   * standard `PG*` variables, which is what the pool would have done — and a
   * process that reached this point has one either way, because `getDb`
   * refuses to start without it.
   */
  databaseUrl: string | undefined;
  log: FastifyBaseLogger;
  /** Shows up in `pg_stat_activity`: which connection is holding the lease. */
  applicationName?: string;
  retryIntervalMs?: number;
  /** Start the box. Called only once the lease is actually held. */
  onAcquire: () => Promise<void> | void;
  /** Stop the box, because the lease is gone. Never called by `stop()`. */
  onLoss: (reason: string) => Promise<void> | void;
  /** How the dedicated connection is opened. A `pg.Client` unless a test says otherwise. */
  openConnection?: () => Promise<LeaseConnection>;
}

export interface VirtualBoxLease {
  /** True while this process holds the lease and the box is its to run. */
  readonly held: boolean;
  /**
   * One pass: acquire if we do not hold it, confirm the connection if we do.
   * The timer calls this; a test calls it directly. Passes never overlap.
   */
  tick(): Promise<boolean>;
  /** One pass now, then a pass every `retryIntervalMs`. */
  start(): Promise<void>;
  /**
   * Give the lease back by closing the connection that holds it.
   *
   * It does NOT stop the box: the caller does that first, because a new
   * instance may take the lease the instant this connection closes and two
   * agents overlapping is the fault this file exists to prevent.
   */
  stop(): Promise<void>;
}

async function connectDedicated(
  databaseUrl: string | undefined,
  applicationName: string,
): Promise<LeaseConnection> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: applicationName,
    // The probe is a `select 1`; on a half-open socket it would otherwise wait
    // forever with `held` still true. A bounded wait turns that into a loss
    // on the next pass, and the hand-over is delayed rather than never.
    statement_timeout: 5_000,
  });
  await client.connect();
  return {
    query: (sql, values) => client.query(sql, values as unknown[]),
    end: () => client.end(),
    on: (event, listener) => {
      if (event === 'error') client.on('error', (err) => listener(err));
      else client.on('end', () => listener());
    },
  };
}

export function createVirtualBoxLease(options: VirtualBoxLeaseOptions): VirtualBoxLease {
  const { name, log } = options;
  const [namespace, key] = virtualBoxLockId(name);
  const retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
  const open =
    options.openConnection ??
    (() =>
      connectDedicated(options.databaseUrl, options.applicationName ?? 'oto-api-virtual-box-lease'));

  let connection: LeaseConnection | null = null;
  let held = false;
  /** Set by the connection's own events, acted on by the next pass. */
  let broken: string | null = null;
  /** Said once per episode: a stand-by is a steady state, not news every tick. */
  let standingBySaid = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Passes run one at a time: the timer's must not overlap a caller's. */
  let queue: Promise<boolean> = Promise.resolve(false);

  async function close(): Promise<void> {
    const c = connection;
    connection = null;
    broken = null;
    if (!c) return;
    try {
      // Closing the session is what releases the advisory lock. There is no
      // `pg_advisory_unlock` anywhere in this file on purpose: unlocking and
      // then keeping the connection would leave a live session that no longer
      // means what its presence says.
      await c.end();
    } catch {
      // Already gone, which is the same outcome.
    }
  }

  async function lose(reason: string): Promise<void> {
    if (!held) {
      // Standing by with a connection that died: nothing is running, so there
      // is nothing to stop and nothing worth a line.
      await close();
      return;
    }
    held = false;
    standingBySaid = false;
    await close();
    log.warn(
      { lease: name, reason },
      'virtual box lease lost — the box is stopped until the lease can be taken again',
    );
    try {
      await options.onLoss(reason);
    } catch (err) {
      log.error({ lease: name, err }, 'the virtual box could not be stopped after losing its lease');
    }
  }

  async function connect(): Promise<boolean> {
    try {
      const c = await open();
      // An unhandled 'error' on a pg client takes the process down, and a
      // connection that ends is a lease that ended. Both are recorded and left
      // for the next pass rather than acted on here, so that losing the lease
      // cannot interleave with a pass that is halfway through taking it.
      c.on('error', (err) => {
        if (connection !== c) return;
        broken = err?.message ? `connection error: ${err.message}` : 'connection error';
        void tick();
      });
      c.on('end', () => {
        if (connection !== c) return;
        broken ??= 'connection closed';
        void tick();
      });
      connection = c;
      return true;
    } catch (err) {
      log.warn({ lease: name, err }, 'the virtual box lease connection could not be opened');
      return false;
    }
  }

  async function acquire(): Promise<boolean> {
    if (!connection && !(await connect())) return false;
    const c = connection;
    if (!c) return false;
    let locked = false;
    try {
      const result = await c.query('select pg_try_advisory_lock($1::int4, $2::int4) as locked', [
        namespace,
        key,
      ]);
      locked = result.rows[0]?.locked === true;
    } catch (err) {
      log.warn({ lease: name, err }, 'the virtual box lease could not be asked for');
      await close();
      return false;
    }
    if (!locked) {
      // The connection is kept between attempts on purpose: it is one
      // connection either way, and reconnecting every few seconds would be a
      // stand-by instance making noise in `pg_stat_activity` and in the
      // database's logs for as long as it stands by.
      if (!standingBySaid) {
        standingBySaid = true;
        log.info(
          { lease: name, retryIntervalMs },
          'another instance holds the virtual box lease — standing by',
        );
      }
      return false;
    }
    held = true;
    standingBySaid = false;
    log.info({ lease: name }, 'virtual box lease acquired — this instance runs the virtual box');
    try {
      await options.onAcquire();
    } catch (err) {
      // Hold nothing we are not using: giving the lock back lets another
      // instance try, which is better than one that cannot start the box
      // keeping every other one from trying.
      held = false;
      await close();
      log.error(
        { lease: name, err },
        'the virtual box did not start — the lease was given back for another instance to take',
      );
      return false;
    }
    return true;
  }

  /**
   * Still ours?
   *
   * Nothing but the session ending can take a session-level advisory lock away
   * — nothing in this process unlocks it — so the connection answering at all
   * is the whole check.
   */
  async function confirm(): Promise<boolean> {
    const c = connection;
    if (!c) {
      await lose('no connection');
      return false;
    }
    try {
      await c.query('select 1');
      return true;
    } catch (err) {
      await lose(err instanceof Error ? `connection probe failed: ${err.message}` : 'connection probe failed');
      return false;
    }
  }

  async function pass(): Promise<boolean> {
    if (stopped) return false;
    if (broken) {
      const reason = broken;
      broken = null;
      await lose(reason);
      return false;
    }
    if (held) return confirm();
    return acquire();
  }

  function tick(): Promise<boolean> {
    queue = queue.then(async () => {
      try {
        return await pass();
      } catch (err) {
        // A pass that throws must not break the chain every later pass waits on.
        log.error({ lease: name, err }, 'the virtual box lease pass failed');
        return false;
      }
    });
    return queue;
  }

  return {
    get held() {
      return held;
    },
    tick,
    async start() {
      stopped = false;
      await tick();
      timer = setInterval(() => void tick(), retryIntervalMs);
      // A pending timer must never be the reason the process cannot exit.
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      // Let whatever is in flight finish, or it could take the lease back
      // immediately after this closed the connection.
      await queue.catch(() => false);
      held = false;
      standingBySaid = false;
      await close();
    },
  };
}
