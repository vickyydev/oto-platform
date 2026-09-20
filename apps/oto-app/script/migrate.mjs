/**
 * Apply this app's committed migrations into schema `otoapp` of the platform
 * database.
 *
 * The 184 table definitions carry no schema and the SQL in `migrations/` is
 * unqualified, so the schema is chosen here: `search_path` is set to `otoapp`
 * for the one connection everything runs on, and the Drizzle bookkeeping table
 * goes to `otoapp.__drizzle_migrations` so the record of what ran travels with
 * the tables it describes.
 *
 * The database is shared with the POS, the booth and the console. That is why
 * this refuses to run rather than improvising when the schema is missing: an
 * unqualified `CREATE TABLE` with the default search path would put 184 tables
 * into `public`, where every unqualified name any other application resolves
 * would find them first.
 *
 * Plain JavaScript on purpose: the runtime image installs with `--omit=dev`,
 * so neither `tsx` nor `drizzle-kit` exists where this has to run. It needs
 * only `pg` and `drizzle-orm`, both production dependencies.
 *
 * Usage: npm run db:migrate   (DATABASE_URL in the environment)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const SCHEMA = "otoapp";
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(APP_DIR, "migrations");

function fail(message) {
  console.error(`\nmigrate: ${message}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  fail("DATABASE_URL is not set. It must point at the platform database.");
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"));
const tags = journal.entries.map((entry) => entry.tag);

/**
 * Drizzle writes `CREATE TYPE "public"."x"` and `REFERENCES "public"."y"` even
 * for tables that declare no schema, because it models an unqualified table as
 * living in `public`. Left in, those statements would ignore the search path
 * and put enum types — and then the constraints that depend on them — into the
 * shared schema. Every generated file therefore has `"public".` stripped
 * before it is committed, and this refuses to apply one where that was
 * forgotten.
 */
for (const tag of tags) {
  const sql = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  if (sql.includes('"public".')) {
    fail(
      `migration ${tag}.sql qualifies a name with "public". Strip every ` +
        `"public". from the generated SQL so the statement follows search_path, ` +
        `then run this again.`,
    );
  }
}

const client = new pg.Client({ connectionString: url, application_name: "oto-app-migrate" });
await client.connect();

try {
  const schema = await client.query("select 1 from pg_namespace where nspname = $1", [SCHEMA]);
  if (schema.rowCount === 0) {
    fail(
      `schema "${SCHEMA}" does not exist on this database. The platform's own ` +
        `migrations create it; run those first (pnpm db:migrate at the ` +
        `repository root). Nothing was applied — without that schema these ` +
        `migrations would create 184 tables in "public" and shadow every other ` +
        `application's tables on this database.`,
    );
  }

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

  const ran = journal.entries.filter(
    (entry) => after.includes(entry.when) && !before.includes(entry.when),
  );
  if (ran.length === 0) {
    console.log(`migrate: ${SCHEMA} is up to date — ${after.length} migration(s) already applied.`);
  } else {
    for (const entry of ran) console.log(`migrate: applied ${entry.tag}`);
    console.log(`migrate: ${SCHEMA} now at ${after.length} of ${tags.length} migration(s).`);
  }
} finally {
  await client.end();
}
