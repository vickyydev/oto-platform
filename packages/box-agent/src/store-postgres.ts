import {
  normaliseParam,
  toPositionalPlaceholders,
  type BoxSqlDriver,
  type SqlRow,
} from './store-sql';

/**
 * The virtual box's driver: the `edge` schema of the platform database (S2-05).
 *
 * The api already holds a pool open, and a box living inside that process has
 * no business opening a second one — the connection ceiling on the staging
 * database is budgeted per api instance, not per component. So the pool is
 * passed in, described structurally, and this package still has no dependency
 * on `pg`.
 */

export interface PgQueryResultLike {
  rows: SqlRow[];
}

export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
}

export interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgClientLike & { release(): void }>;
}

export function postgresBoxDriver(pool: PgPoolLike): BoxSqlDriver {
  return client(pool, false);
}

function client(handle: PgClientLike, inTransaction: boolean): BoxSqlDriver {
  const driver: BoxSqlDriver = {
    dialect: 'postgres',
    async query(sql, params = []) {
      const result = await handle.query(
        toPositionalPlaceholders(sql),
        params.map((value) => normaliseParam(value, 'postgres')),
      );
      return result.rows;
    },
    async transaction(fn) {
      // Already inside one: the caller wants atomicity, and it has it. Opening
      // a nested transaction here would mean a savepoint whose rollback the
      // caller cannot see, which is worse than doing nothing.
      if (inTransaction) return fn(driver);
      const pool = handle as PgPoolLike;
      if (typeof pool.connect !== 'function') {
        throw new Error('This Postgres handle cannot open a transaction; pass the pool');
      }
      const conn = await pool.connect();
      try {
        await conn.query('begin');
        const value = await fn(client(conn, true));
        await conn.query('commit');
        return value;
      } catch (error) {
        // The rollback is the part that must not throw over the top of the
        // real error: a connection already broken cannot roll back, and the
        // caller needs to see why the work failed, not why the cleanup did.
        try {
          await conn.query('rollback');
        } catch {
          /* the connection is gone; releasing it is all that is left */
        }
        throw error;
      } finally {
        conn.release();
      }
    },
    async close() {
      // The pool belongs to the api, which opened it and will close it. A
      // component closing a resource it was lent is how a redeploy turns into
      // an outage.
    },
  };
  return driver;
}
