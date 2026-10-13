import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Production DB can cold-start; give connections time instead of failing fast.
  connectionTimeoutMillis: 30_000,
  keepAlive: true,
  max: 10,
});

// Without this handler, an idle-client error (e.g. server closed the
// connection during a DB cold start) crashes the whole process.
pool.on("error", (err) => {
  console.error("[db] Unexpected idle-client error:", err.message);
});

export const db = drizzle(pool, { schema });
