/**
 * Rehearse the public-schema import on disposable databases only.
 * REHEARSAL_DATABASE_URL names a scratch server with CREATE DATABASE rights.
 * pg_dump, pg_restore and psql must be on PATH (or under REHEARSAL_PG_BIN).
 * Optional --structure <file> reads the local production structure without
 * copying it into the repository. Only counts and fingerprints are reported.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  quoteIdentifier,
  compareCounts,
  databaseUrl,
  runCommand,
} from './restore-rehearsal-lib.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(APP_DIR, '../..');
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const PLATFORM_MIGRATIONS = join(ROOT, 'packages/db/migrations');
const BASELINE = join(APP_MIGRATIONS, '0000_otoapp_baseline.sql');
const VIEWS = ['events', 'event_attendees', 'event_attendance', 'children', 'employees'];

function tool(name, bin) {
  return bin ? join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name;
}

function pgEnvironment(url) {
  const value = new URL(url);
  const env = {
    ...process.env,
    PGHOST: value.hostname,
    PGPORT: value.port || '5432',
    PGUSER: decodeURIComponent(value.username),
    PGPASSWORD: decodeURIComponent(value.password),
    PGDATABASE: decodeURIComponent(value.pathname.slice(1)),
    PGAPPNAME: 'oto-app-restore-rehearsal',
  };
  if (value.searchParams.has('sslmode')) env.PGSSLMODE = value.searchParams.get('sslmode');
  return env;
}

function command(executable, args, env, label, cwd = APP_DIR) {
  return runCommand(executable, args, env, label, cwd);
}

async function connection(url, fn) {
  const client = new pg.Client({
    connectionString: url,
    application_name: 'oto-app-restore-rehearsal',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function tableCounts(url, schema) {
  return connection(url, async (client) => {
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '__drizzle_migrations' ORDER BY tablename",
      [schema],
    );
    const counts = {};
    for (const { tablename } of tables.rows) {
      counts[tablename] = (
        await client.query(
          `SELECT count(*)::text AS n FROM ${quoteIdentifier(schema)}.${quoteIdentifier(tablename)}`,
        )
      ).rows[0].n;
    }
    return counts;
  });
}

async function appState(url) {
  return connection(url, async (client) => {
    const views = await client.query(
      "SELECT viewname FROM pg_views WHERE schemaname = 'otoapp_v' ORDER BY viewname",
    );
    const names = views.rows.map((row) => row.viewname);
    if (VIEWS.some((name) => !names.includes(name)))
      throw new Error('A required platform read view is missing.');
    const viewCounts = {};
    for (const name of names)
      viewCounts[name] = (
        await client.query(`SELECT count(*)::text AS n FROM otoapp_v.${quoteIdentifier(name)}`)
      ).rows[0].n;
    const migrations = (
      await client.query(
        'SELECT hash, created_at::text AS created_at FROM otoapp.__drizzle_migrations ORDER BY created_at',
      )
    ).rows;
    return { views: viewCounts, migrations };
  });
}

async function markBaseline(url, journal) {
  const sql = readFileSync(BASELINE, 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  await connection(url, async (client) => {
    await client.query(
      'CREATE TABLE otoapp.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    );
    await client.query(
      'INSERT INTO otoapp.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [hash, journal.entries[0].when],
    );
  });
}

async function applyPlatform(url) {
  await connection(url, (client) =>
    migrate(drizzle(client), { migrationsFolder: PLATFORM_MIGRATIONS }),
  );
}

function applyApp(url) {
  command(
    process.execPath,
    [join(APP_DIR, 'script/migrate.mjs')],
    { ...process.env, DATABASE_URL: url },
    'app migrations',
  );
}

export async function rehearseRestore({
  serverUrl = process.env.REHEARSAL_DATABASE_URL,
  structureFile,
  pgBin = process.env.REHEARSAL_PG_BIN,
} = {}) {
  if (!serverUrl)
    throw new Error(
      'REHEARSAL_DATABASE_URL is required; DATABASE_URL is never used as a fallback.',
    );
  // Check all tools before creating a database, so missing clients leave nothing.
  for (const name of ['pg_dump', 'pg_restore', 'psql'])
    command(tool(name, pgBin), ['--version'], process.env, `${name} availability`);
  const journal = JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta/_journal.json'), 'utf8'));
  if (journal.entries[0]?.tag !== '0000_otoapp_baseline')
    throw new Error('The migration journal does not begin with the expected baseline.');
  const nonce = randomUUID().replace(/-/g, '');
  const names = ['source', 'renamed', 'target'].map(
    (_, index) => `oto_rehearsal_${nonce}_${index}`,
  );
  const urls = names.map((name) => databaseUrl(serverUrl, name));
  const directory = mkdtempSync(join(tmpdir(), 'oto-app-rehearsal-'));
  const temporaryPath = relative(resolve(tmpdir()), resolve(directory));
  if (!temporaryPath || temporaryPath.startsWith('..') || temporaryPath.includes(':')) {
    throw new Error('Temporary archive cleanup stayed outside the permitted path.');
  }
  const created = [];
  let result;
  let cleanupFailed = false;
  try {
    await connection(serverUrl, async (admin) => {
      for (let i = 0; i < names.length; i += 1) {
        await admin.query(`CREATE DATABASE ${quoteIdentifier(names[i])}`);
        created.push(names[i]);
      }
    });
    const sourceFile = resolve(structureFile ?? BASELINE);
    command(
      tool('psql', pgBin),
      ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--single-transaction', '--file', sourceFile],
      pgEnvironment(urls[0]),
      'source structure',
    );
    const sourceTables = await tableCounts(urls[0], 'public');
    if (Object.keys(sourceTables).length !== 184)
      throw new Error('The input does not contain the 184 baseline app tables.');
    command(
      process.execPath,
      [join(APP_DIR, 'node_modules/tsx/dist/cli.mjs'), 'script/sample/main.ts'],
      {
        ...process.env,
        DATABASE_URL: urls[0],
        DB_SCHEMA: 'public',
        APP_ENV: 'dev',
        DEPLOY_ENV: 'local',
        OBJECT_STORAGE: 'local',
        STORAGE_ENV_PREFIX: 'rehearsal',
        OTOAPP_JOBS: 'platform',
      },
      'sample seed',
    );
    const before = await tableCounts(urls[0], 'public');
    const dump = join(directory, 'public.dump');
    command(
      tool('pg_dump', pgBin),
      ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--file', dump],
      pgEnvironment(urls[0]),
      'public dump',
    );
    // pg_dump owns the schema declaration; this database is freshly created.
    await connection(urls[1], (client) => client.query('DROP SCHEMA public'));
    command(
      tool('pg_restore', pgBin),
      ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', names[1], dump],
      pgEnvironment(urls[1]),
      'public restore',
    );
    await connection(urls[1], (client) => client.query('ALTER SCHEMA public RENAME TO otoapp'));
    const renamed = await tableCounts(urls[1], 'otoapp');
    if (compareCounts(before, renamed).length)
      throw new Error('Counts differ after the public-schema rename.');
    const appDump = join(directory, 'otoapp.dump');
    command(
      tool('pg_dump', pgBin),
      ['--format=custom', '--no-owner', '--no-acl', '--schema=otoapp', '--file', appDump],
      pgEnvironment(urls[1]),
      'renamed dump',
    );
    await applyPlatform(urls[2]);
    await connection(urls[2], async (client) => {
      const tables = (
        await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'otoapp'")
      ).rows[0].n;
      if (tables !== 0)
        throw new Error(
          'Platform migrations already contain app tables; the import cannot continue.',
        );
      await client.query('DROP SCHEMA otoapp');
    });
    command(
      tool('pg_restore', pgBin),
      ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', names[2], appDump],
      pgEnvironment(urls[2]),
      'platform import',
    );
    await markBaseline(urls[2], journal);
    const runs = [];
    for (let run = 1; run <= 2; run += 1) {
      applyApp(urls[2]);
      const counts = await tableCounts(urls[2], 'otoapp');
      const differences = compareCounts(before, counts);
      if (differences.length) throw new Error(`Source counts differ after migration run ${run}.`);
      const state = await appState(urls[2]);
      if (
        state.migrations.length !== journal.entries.length ||
        state.migrations.some(
          (row, i) =>
            row.created_at !== String(journal.entries[i].when) ||
            row.hash !==
              createHash('sha256')
                .update(readFileSync(join(APP_MIGRATIONS, `${journal.entries[i].tag}.sql`), 'utf8'))
                .digest('hex'),
        )
      ) {
        throw new Error('The restored app journal does not match every committed migration.');
      }
      runs.push({ run, counts, ...state });
    }
    if (
      JSON.stringify(runs[0].counts) !== JSON.stringify(runs[1].counts) ||
      JSON.stringify(runs[0].views) !== JSON.stringify(runs[1].views) ||
      JSON.stringify(runs[0].migrations) !== JSON.stringify(runs[1].migrations)
    )
      throw new Error('A second migration run changed the restored app.');
    result = {
      input: structureFile ? 'local structure' : 'committed baseline',
      inputSha256: createHash('sha256').update(readFileSync(sourceFile)).digest('hex'),
      sourceTables: Object.keys(before).length,
      sourceRows: Object.values(before).reduce((sum, n) => sum + Number(n), 0),
      platformMigrations: JSON.parse(
        readFileSync(join(PLATFORM_MIGRATIONS, 'meta/_journal.json'), 'utf8'),
      ).entries.length,
      appMigrations: journal.entries.length,
      counts: before,
      runs,
    };
  } finally {
    // Only databases whose CREATE succeeded in this invocation are eligible.
    for (const name of created.reverse()) {
      await connection(serverUrl, (admin) =>
        admin.query(`DROP DATABASE ${quoteIdentifier(name)} WITH (FORCE)`),
      ).catch(() => {
        cleanupFailed = true;
      });
    }
    rmSync(directory, { recursive: true, force: true });
  }
  if (cleanupFailed)
    throw new Error('The rehearsal ran, but a disposable database could not be removed.');
  return { ...result, cleanup: 'complete' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length && (args.length !== 2 || args[0] !== '--structure'))
      throw new Error('Usage: restore-rehearsal.mjs [--structure <file>]');
    console.log(JSON.stringify(await rehearseRestore({ structureFile: args[1] }), null, 2));
  } catch (error) {
    console.error(
      `restore: ${error instanceof Error && !('severity' in error) ? error.message : 'A database step did not complete; no database details were published.'}`,
    );
    process.exitCode = 1;
  }
}
