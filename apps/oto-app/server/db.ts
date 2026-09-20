import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { DB_SCHEMA } from "./config/env";

const { Pool } = pg;

// DATABASE_URL is checked in config/env, which this import has already
// evaluated. It is one of several things that have to be right before a
// connection is worth making, and reporting them one at a time — which is what
// a throw here did — turns one fix into several deploys.

/**
 * The app's tables live in schema `otoapp` of the platform database, beside
 * core, crm, pos and the rest. Every one of its 184 table definitions emits an
 * unqualified name, and so does the raw SQL and the session store, so the
 * schema is chosen by `search_path` rather than by rewriting the definitions.
 *
 * It goes on the connection, as a startup parameter, not as a `SET` in a
 * `connect` handler: a startup parameter is part of the handshake, so it is in
 * force before the pool can hand the client to a query. A `SET` issued from an
 * async handler is a race, and the query that wins it reads `public`.
 *
 * The database role carries `ALTER ROLE oto_app SET search_path = otoapp` as
 * well. Both, deliberately: the role default is the safety net for anything
 * that connects without this file — psql, a migration, a one-off script — and
 * this line is the safety net for a connection made as some other role.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${DB_SCHEMA}`,
  /**
   * Ten, which is the share budgeted for this app in the database's connection
   * ceiling (render.yaml, the note above the blueprint's `databases:` block).
   * It was the node-postgres default anyway; it is written down so that raising
   * it is a decision against that budget rather than an accident.
   */
  max: 10,
  application_name: "oto-app",
});

export const db = drizzle(pool, { schema });

/**
 * Prove the search path resolved before the app serves anything.
 *
 * `current_schema()` answers with the first schema on the path that actually
 * EXISTS, which is exactly the question worth asking. Measured against an
 * empty Postgres 16, the three cases answer differently and all three matter:
 * with `otoapp` present it is `otoapp`; with the schema not yet created it is
 * NULL, because the path names one schema and that schema is not there; with
 * the connection option missing altogether it is `public`, which is what this
 * app did before and is the outcome to fear — 184 unqualified table names
 * landing in the middle of another application's schema, quietly, with
 * everything reporting healthy.
 */
export async function assertSearchPath(): Promise<void> {
  const { rows } = await pool.query<{ schema: string | null; path: string }>(
    "select current_schema() as schema, current_setting('search_path') as path",
  );
  const resolved = rows[0]?.schema ?? null;
  if (resolved !== DB_SCHEMA) {
    throw new Error(
      `Refusing to start: search_path resolves to ${resolved ?? "nothing"}, not ${DB_SCHEMA}. ` +
        `The connection asked for "${DB_SCHEMA}" and the server answered "${rows[0]?.path ?? "?"}" — ` +
        `either the schema does not exist yet (run the migrations) or this role cannot see it.`,
    );
  }
}
