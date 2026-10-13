import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

/**
 * Radar's tables live in schema `radar` of the platform database. The table
 * definitions and the raw SQL are unqualified, so the schema is chosen by the
 * connection's search_path — the same approach as the OTO App's `otoapp`.
 */
export const DB_SCHEMA = "radar";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set (a direct, non-pooled Postgres URL).");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Every connection resolves unqualified names in `radar` only, so nothing
  // Radar creates or reads can land in, or shadow, another app's schema.
  options: `-c search_path=${DB_SCHEMA}`,
  connectionTimeoutMillis: 30_000,
  keepAlive: true,
  max: 10,
});

// Without this handler, an idle-client error (e.g. the server closed the
// connection) crashes the whole process.
pool.on("error", (err) => {
  console.error("[db] Unexpected idle-client error:", err.message);
});

export const db = drizzle(pool, { schema });

/**
 * Refuse to serve unless `npm run db:migrate` has built the schema. Boot never
 * creates tables itself.
 */
export async function assertSchemaReady(): Promise<void> {
  const res = await pool.query<{ ready: string | null }>(
    "select to_regclass($1)::text as ready",
    [`${DB_SCHEMA}.__drizzle_migrations`],
  );
  if (!res.rows[0]?.ready) {
    throw new Error(
      `schema "${DB_SCHEMA}" has no migration ledger; run \`npm run db:migrate\` before starting Radar.`,
    );
  }
}
