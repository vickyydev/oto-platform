import path from "path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./db";

const PRE_MIGRATOR_BASELINE_MS = 1769597568302;

function logDb(message: string): void {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${time} [db] ${message}`);
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), "migrations");

  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      "id" SERIAL PRIMARY KEY,
      "hash" text NOT NULL,
      "created_at" bigint
    )
  `);

  const tracker = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
  );
  const trackerCount = Number(tracker.rows[0]?.count ?? "0");

  if (trackerCount === 0) {
    const legacy = await db.execute<{ tbl: string | null }>(
      sql`SELECT to_regclass('public.branches')::text AS tbl`,
    );
    const dbWasBootstrappedBeforeMigrator = legacy.rows[0]?.tbl != null;

    if (dbWasBootstrappedBeforeMigrator) {
      await db.execute(sql`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES ('pre-migrator-baseline', ${PRE_MIGRATOR_BASELINE_MS})
      `);
      logDb(
        "detected pre-migrator schema; seeded baseline so only new migrations apply",
      );
    } else {
      logDb("fresh database detected; applying full migration history");
    }
  }

  await migrate(db, { migrationsFolder });
  logDb("migrations applied");
}
