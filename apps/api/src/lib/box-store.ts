import { SqlBoxStore, postgresBoxDriver, type PgPoolLike } from '@oto/box-agent';
import type { Db } from '@oto/db';

/**
 * The virtual box's store, over the api's own pool (S2-05).
 *
 * A box on a Raspberry Pi keeps its store in a SQLite file on its memory card.
 * The virtual box has no memory card: its store IS the `edge` schema of the
 * database this process is already holding open, which is the whole reason
 * `SqlBoxStore` has two dialects rather than two implementations. That is also
 * what makes the offline demo watchable on Render — toggle the box offline,
 * create three members, press Restart, and the outbox depth is still three,
 * because the queue was never in this process's memory.
 *
 * **One store per pool, not one per caller.** Two things in this process want
 * it — the agent started in `services/box.ts` and the station-session routes —
 * and one object serving both is what keeps the boot-time table probe
 * (`features()`) to one query instead of one per caller. It is no longer what
 * makes them agree about the CACHE: since SCRUM-275 the bundles are rows in
 * `edge.box_cache`, so two instances over the same database would read the same
 * cache, and a restarted api reads the cache the agent applied before it. The
 * pool is lent, never opened here: the connection ceiling on the staging
 * database is budgeted per api instance, and a component that opens its own
 * pool is a component that turns a redeploy into a connection-limit error.
 */
const perPool = new WeakMap<object, SqlBoxStore>();

/** node-postgres under Drizzle. Nothing else in this API has a `$client`. */
function poolOf(db: Db): PgPoolLike {
  const client = (db as { $client?: unknown }).$client;
  if (!client || typeof (client as PgPoolLike).query !== 'function') {
    throw new Error('This database handle is not a node-postgres pool; the box store needs one');
  }
  return client as PgPoolLike;
}

export function boxStoreFor(db: Db): SqlBoxStore {
  const pool = poolOf(db) as unknown as object;
  let held = perPool.get(pool);
  if (!held) {
    held = new SqlBoxStore({ driver: postgresBoxDriver(pool as PgPoolLike) });
    perPool.set(pool, held);
  }
  return held;
}
