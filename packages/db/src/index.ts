import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

export * from './schema/index';
export { schema };

export type Db = NodePgDatabase<typeof schema>;

let _pool: pg.Pool | null = null;
let _db: Db | null = null;

/** Create (or reuse) the process-wide pool + Drizzle client. */
export function getDb(databaseUrl = process.env.DATABASE_URL): Db {
  if (_db) return _db;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set (see /oto-platform/.env.example)');
  }
  _pool = new pg.Pool({ connectionString: databaseUrl });
  _db = drizzle(_pool, { schema });
  return _db;
}

export async function closeDb(): Promise<void> {
  await _pool?.end();
  _pool = null;
  _db = null;
}
