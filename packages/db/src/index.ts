import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

export * from './schema/index';
export { schema };

/**
 * The OTO App's `users` table, for the one service on the platform api that
 * provisions into it. Exported here and not from `./schema/index`, which is
 * what `drizzle.config.ts` reads — see the file for why.
 */
export * from './schema/otoapp';

export type Db = NodePgDatabase<typeof schema>;

let _pool: pg.Pool | null = null;
let _db: Db | null = null;

/**
 * Pool settings (S2-01b). Render's managed Postgres allows a modest number of
 * connections and the api is one service among several on the same database,
 * so the pool is deliberately small. A query that cannot finish in ten
 * seconds is a query holding a connection the till needs.
 */
export interface PoolOptions {
  /** Connections this process may hold. */
  max?: number;
  /** Milliseconds before the server cancels a single statement. */
  statementTimeoutMs?: number;
  /** Shows up in pg_stat_activity — which process is holding what. */
  applicationName?: string;
}

/** Create (or reuse) the process-wide pool + Drizzle client. */
export function getDb(databaseUrl = process.env.DATABASE_URL, opts: PoolOptions = {}): Db {
  if (_db) return _db;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set (see .env.example at the repository root)');
  }
  _pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 10,
    // A connection idle this long is returned to the server.
    idleTimeoutMillis: 30_000,
    // Fail fast when the database is unreachable rather than queueing.
    connectionTimeoutMillis: 10_000,
    statement_timeout: opts.statementTimeoutMs ?? 10_000,
    // Postgres kills a connection idle inside a transaction: a forgotten
    // BEGIN must not pin a connection for the rest of the day.
    idle_in_transaction_session_timeout: 30_000,
    application_name: opts.applicationName ?? 'oto-api',
  });
  // A pool error (server restart, network drop) must not take the process
  // down: pg emits it on the pool, and an unhandled 'error' event is fatal.
  _pool.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', code: (err as { code?: string }).code }));
  });
  _db = drizzle(_pool, { schema });
  return _db;
}

export async function closeDb(): Promise<void> {
  await _pool?.end();
  _pool = null;
  _db = null;
}
