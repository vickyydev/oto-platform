/**
 * Prove that a database built from the committed migrations matches the
 * committed snapshot (S2-01b).
 *
 * The schema-move migration is hand-written, so nothing else checks that the
 * SQL and the TypeScript still describe the same database. This does: it
 * migrates a throwaway database, reads the catalogue back, and compares
 * tables, columns, foreign keys (names AND their ON DELETE), indexes and
 * check constraints against `meta/<latest>_snapshot.json`. It also fails if
 * any application table is left in `public`.
 *
 * Usage: pnpm --filter @oto/db exec tsx scripts/verify-schema.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const META = join(PKG, 'migrations', 'meta');

interface SnapshotIndex {
  name: string;
  isUnique: boolean;
  columns: Array<{ expression: string }>;
}
interface SnapshotFk {
  name: string;
  onDelete?: string;
}
interface SnapshotTable {
  name: string;
  schema: string;
  columns: Record<string, { name: string; type: string; notNull: boolean }>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<string, SnapshotFk>;
  checkConstraints?: Record<string, { name: string }>;
}

const latest = readdirSync(META)
  .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
  .sort()
  .at(-1)!;
const snapshot = JSON.parse(readFileSync(join(META, latest), 'utf8')) as {
  tables: Record<string, SnapshotTable>;
};

const problems: string[] = [];
const note = (m: string) => problems.push(m);

const { url, drop } = await createTestDatabase();
const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // Migrations must be re-runnable: the second pass has to be a clean no-op.
  execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  const schemas = await client.query<{ nspname: string }>(
    `select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`,
  );
  console.log(`schemas: ${schemas.rows.map((r) => r.nspname).join(', ')}`);

  // Nothing of ours may be left behind in public.
  const stray = await client.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  for (const r of stray.rows) note(`table left in public: ${r.tablename}`);

  const dbTables = await client.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
     where table_schema in ('core','crm','pos','promo','booth','analytics','edge')
       and table_type = 'BASE TABLE'`,
  );
  const present = new Set(dbTables.rows.map((r) => `${r.table_schema}.${r.table_name}`));

  const columns = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `select table_schema, table_name, column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema in ('core','crm','pos','promo','booth','analytics','edge')`,
  );
  const colKey = (s: string, t: string, c: string) => `${s}.${t}.${c}`;
  const dbColumns = new Map(
    columns.rows.map((r) => [colKey(r.table_schema, r.table_name, r.column_name), r]),
  );

  const constraints = await client.query<{
    nspname: string;
    relname: string;
    conname: string;
    contype: string;
    confdeltype: string;
  }>(
    `select n.nspname, c.relname, con.conname, con.contype, con.confdeltype
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('core','crm','pos','promo','booth','analytics','edge')`,
  );
  const dbConstraints = new Map(
    constraints.rows.map((r) => [`${r.nspname}.${r.relname}.${r.conname}`, r]),
  );

  const indexes = await client.query<{ schemaname: string; tablename: string; indexname: string; indexdef: string }>(
    `select schemaname, tablename, indexname, indexdef from pg_indexes
     where schemaname in ('core','crm','pos','promo','booth','analytics','edge')`,
  );
  const dbIndexes = new Map(
    indexes.rows.map((r) => [`${r.schemaname}.${r.tablename}.${r.indexname}`, r]),
  );

  // Postgres spells ON DELETE as a single letter; the snapshot spells it out.
  const DELETE_ACTION: Record<string, string> = {
    a: 'no action',
    r: 'restrict',
    c: 'cascade',
    n: 'set null',
    d: 'set default',
  };

  for (const key of Object.keys(snapshot.tables)) {
    const t = snapshot.tables[key]!;
    const qualified = `${t.schema}.${t.name}`;
    if (!present.has(qualified)) {
      note(`missing table: ${qualified}`);
      continue;
    }
    for (const c of Object.values(t.columns)) {
      const db = dbColumns.get(colKey(t.schema, t.name, c.name));
      if (!db) {
        note(`missing column: ${qualified}.${c.name}`);
        continue;
      }
      const dbNotNull = db.is_nullable === 'NO';
      if (dbNotNull !== c.notNull) {
        note(`${qualified}.${c.name} notNull is ${dbNotNull}, snapshot says ${c.notNull}`);
      }
    }
    for (const fk of Object.values(t.foreignKeys)) {
      const db = dbConstraints.get(`${t.schema}.${t.name}.${fk.name}`);
      if (!db) {
        note(`missing foreign key: ${qualified}.${fk.name}`);
        continue;
      }
      const onDelete = DELETE_ACTION[db.confdeltype] ?? '?';
      const expected = fk.onDelete ?? 'no action';
      if (onDelete !== expected) {
        note(`${qualified}.${fk.name} ON DELETE is ${onDelete}, snapshot says ${expected}`);
      }
    }
    for (const idx of Object.values(t.indexes)) {
      const db = dbIndexes.get(`${t.schema}.${t.name}.${idx.name}`);
      if (!db) {
        note(`missing index: ${qualified}.${idx.name}`);
        continue;
      }
      const dbUnique = db.indexdef.startsWith('CREATE UNIQUE');
      if (dbUnique !== idx.isUnique) {
        note(`${qualified}.${idx.name} unique is ${dbUnique}, snapshot says ${idx.isUnique}`);
      }
    }
    for (const chk of Object.values(t.checkConstraints ?? {})) {
      if (!dbConstraints.has(`${t.schema}.${t.name}.${chk.name}`)) {
        note(`missing check constraint: ${qualified}.${chk.name}`);
      }
    }
  }

  // Anything in the database that the snapshot does not know about.
  for (const q of present) {
    if (!Object.values(snapshot.tables).some((t) => `${t.schema}.${t.name}` === q)) {
      note(`table not in the snapshot: ${q}`);
    }
  }
} finally {
  await client.end();
  await drop();
  await stopTestServer();
}

if (problems.length) {
  console.error(`schema verification FAILED against ${latest}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`schema verified against ${latest}: tables, columns, foreign keys, indexes and checks all match, and public is empty.`);
