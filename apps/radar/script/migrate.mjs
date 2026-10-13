/**
 * Apply Radar's committed migrations into schema `radar` of the platform
 * database. This is the only way Radar's schema changes; the server never
 * migrates at boot and refuses to start until this has run.
 *
 * The table definitions carry no schema and the SQL in `migrations/` is
 * unqualified, so the schema is chosen here: `search_path` is set to `radar`
 * for the one connection everything runs on, and the Drizzle ledger goes to
 * `radar.__drizzle_migrations` so the record of what ran sits beside the
 * tables it describes.
 *
 * Unlike the OTO App's migrator this creates the schema when it is missing.
 * That keeps Radar's schema work inside this directory while its shape is
 * still settling (S2-18 R1–R3); once it settles, the schema and the runtime
 * role's grants may move into a platform migration like `otoapp`'s.
 *
 * Plain JavaScript on purpose: the runtime image installs with --omit=dev, so
 * neither tsx nor drizzle-kit exists where this runs. It needs only pg and
 * drizzle-orm, both production dependencies.
 *
 * Usage: npm run db:migrate   (DATABASE_URL in the environment)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const SCHEMA = "radar";
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(APP_DIR, "migrations");

function fail(message) {
  console.error(`\nmigrate: ${message}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is not set. It must point at the platform database.");

const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"));
const tags = journal.entries.map((entry) => entry.tag);

/**
 * Drizzle writes `REFERENCES "public"."y"` even for tables that declare no
 * schema. Left in, those would ignore the search path and reach into the
 * shared schema, so every generated file has `"public".` stripped before it is
 * committed, and this refuses to apply one where that was forgotten.
 */
for (const tag of tags) {
  const sql = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  if (sql.includes('"public".')) {
    fail(`migration ${tag}.sql qualifies a name with "public". Strip every "public". and run this again.`);
  }
}

const client = new pg.Client({ connectionString: url, application_name: "radar-migrate" });
await client.connect();

try {
  await client.query(`create schema if not exists ${SCHEMA}`);
  await client.query(`set search_path to ${SCHEMA}`);
  const path = await client.query("show search_path");
  const active = path.rows[0].search_path;
  if (active.replace(/"/g, "").trim() !== SCHEMA) {
    fail(`search_path is "${active}" after setting it to "${SCHEMA}"; refusing to apply anything.`);
  }

  const db = drizzle(client);
  const applied = () =>
    client
      .query(`select created_at from "${SCHEMA}"."__drizzle_migrations" order by created_at`)
      .then((r) => r.rows.map((row) => Number(row.created_at)))
      .catch(() => []);

  const before = await applied();
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: SCHEMA });
  const after = await applied();

  const ran = journal.entries.filter((entry) => after.includes(entry.when) && !before.includes(entry.when));
  if (ran.length === 0) {
    console.log(`migrate: ${SCHEMA} is up to date — ${after.length} migration(s) already applied.`);
  } else {
    for (const entry of ran) console.log(`migrate: applied ${entry.tag}`);
    console.log(`migrate: ${SCHEMA} now at ${after.length} of ${tags.length} migration(s).`);
  }
} finally {
  await client.end();
}
