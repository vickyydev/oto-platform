import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to reconcile birthday branch colors");
}

const migrationPath = path.resolve(
  process.cwd(),
  "migrations/0016_add_calendar_event_color_system.sql",
);
const reconciliationSql = await readFile(migrationPath, "utf8");
const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(reconciliationSql);
  console.log("Birthday branch color reconciliation completed.");
} catch (error) {
  console.error("Birthday branch color reconciliation failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}