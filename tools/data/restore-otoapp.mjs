/**
 * Restore a production dump of the OTO App into the platform database's
 * `otoapp` schema (S2-22, first step: the park's own data on staging).
 *
 *   node tools/data/restore-otoapp.mjs prepare   # dump -> scratch -> rename -> custom-format archive
 *   node tools/data/restore-otoapp.mjs apply     # target: back up, replace otoapp, migrate, link, verify
 *   node tools/data/restore-otoapp.mjs verify    # counts and ledger on the target only
 *
 * The sequence is the one `apps/oto-app/script/restore-rehearsal.mjs` proves in
 * CI on sample rows: the Navicat file hard-codes `"public".`, so it is loaded
 * into a scratch database, the schema is renamed there, and only the renamed
 * archive travels to the target. 0000 is recorded as applied without running
 * it (the dump IS the baseline shape) and 0001 onwards run on the real rows.
 *
 * Environment:
 *   RESTORE_DUMP_PATH       the Navicat .sql file (prepare)
 *   RESTORE_WORK_DIR        work folder, outside the repository and OneDrive (default C:/oto-data/work)
 *   SCRATCH_DATABASE_URL    a disposable server with CREATE DATABASE rights (prepare)
 *   TARGET_DATABASE_URL     the platform database (apply, verify)
 *   RESTORE_CONFIRM         must equal the target database name (apply)
 *   RESTORE_MANIFEST        a prepare manifest to apply (default: the newest in RESTORE_WORK_DIR)
 *   PG_TOOLS_CONTAINER      docker container with psql/pg_dump/pg_restore and C:/oto-data at /data (default oto-restore-pg)
 *   PG_TOOLS_DATA_ROOT      host folder mounted at /data in that container (default C:/oto-data)
 *
 * Nothing here prints a row, a name, a phone or a connection string: counts,
 * hashes and statuses only. Reports go to the work folder, never the repo.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_DIR = join(ROOT, 'apps/oto-app');
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const require = createRequire(join(APP_DIR, 'package.json'));
const pg = require('pg');
const { assertTableInventory, quoteIdentifier } = await import(
  'file://' + join(APP_DIR, 'script/restore-rehearsal-lib.mjs').replace(/\\/g, '/')
);

const WORK_DIR = resolve(process.env.RESTORE_WORK_DIR ?? 'C:/oto-data/work');
const CONTAINER = process.env.PG_TOOLS_CONTAINER ?? 'oto-restore-pg';
const DATA_ROOT = resolve(process.env.PG_TOOLS_DATA_ROOT ?? 'C:/oto-data');
const SCHEMA = 'otoapp';
const VIEWS_SCHEMA = 'otoapp_v';

const say = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const fail = (message) => {
  console.error('STOP:', message);
  process.exit(1);
};

if (WORK_DIR.toLowerCase().startsWith(ROOT.toLowerCase()) || /onedrive/i.test(WORK_DIR)) {
  fail('RESTORE_WORK_DIR must be outside the repository and outside OneDrive.');
}
if (!WORK_DIR.toLowerCase().startsWith(DATA_ROOT.toLowerCase())) {
  fail('RESTORE_WORK_DIR must sit under PG_TOOLS_DATA_ROOT so the tools container can reach it.');
}
mkdirSync(WORK_DIR, { recursive: true });

// ---- helpers --------------------------------------------------------------

/** A host path under DATA_ROOT, as the tools container sees it. */
function inContainer(hostPath) {
  const full = resolve(hostPath);
  if (!full.toLowerCase().startsWith(DATA_ROOT.toLowerCase())) {
    throw new Error('A file the tools need is outside the mounted data folder.');
  }
  return '/data' + full.slice(DATA_ROOT.length).replace(/\\/g, '/');
}

/** libpq variables for a URL; localhost becomes the host as seen from the container. */
function pgEnv(url) {
  const value = new URL(url);
  let host = value.hostname;
  if (host === 'localhost' || host === '127.0.0.1') host = 'host.docker.internal';
  const env = {
    PGHOST: host,
    PGPORT: value.port || '5432',
    PGUSER: decodeURIComponent(value.username),
    PGPASSWORD: decodeURIComponent(value.password),
    PGDATABASE: decodeURIComponent(value.pathname.slice(1)),
    PGAPPNAME: 'oto-restore-otoapp',
  };
  if (value.searchParams.get('sslmode')) env.PGSSLMODE = value.searchParams.get('sslmode');
  else if (host !== 'host.docker.internal') env.PGSSLMODE = 'require';
  return env;
}

/** Run a Postgres client tool inside the container. Output is never echoed unless it fails. */
function pgTool(tool, args, url, label) {
  const env = pgEnv(url);
  const dockerArgs = ['exec', '-i'];
  for (const [k, v] of Object.entries(env)) dockerArgs.push('-e', `${k}=${v}`);
  dockerArgs.push(CONTAINER, tool, ...args);
  const started = Date.now();
  const result = spawnSync('docker', dockerArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    // The tool's stderr can carry a row from the dump; keep only its first line and length.
    const first = (result.stderr || result.stdout || '').split('\n').find((l) => l.trim()) ?? '';
    throw new Error(`${label} failed after ${seconds}s (${tool} exit ${result.status}): ${first.slice(0, 200)} [${(result.stderr || '').length} chars withheld]`);
  }
  say(`${label}: ok in ${seconds}s`);
  return result.stdout;
}

function dbName(url) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

function withDatabase(serverUrl, name) {
  const u = new URL(serverUrl);
  u.pathname = '/' + name;
  return u.toString();
}

async function connection(url, fn) {
  const needsSsl = !/localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const client = new pg.Client({ connectionString: url, application_name: 'oto-restore-otoapp', ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function tableCounts(client, schema) {
  const tables = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '__drizzle_migrations' ORDER BY tablename",
    [schema],
  );
  const counts = Object.create(null);
  for (const { tablename } of tables.rows) {
    const { rows } = await client.query(`SELECT count(*)::text AS n FROM ${quoteIdentifier(schema)}.${quoteIdentifier(tablename)}`);
    counts[tablename] = rows[0].n;
  }
  return counts;
}

async function structure(client, schema) {
  const one = async (sql) => Number((await client.query(sql, [schema])).rows[0].n);
  return {
    tables: await one('SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1'),
    enums: await one("SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype = 'e'"),
    sequences: await one('SELECT count(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = $1'),
    views: await one('SELECT count(*)::int AS n FROM pg_views WHERE schemaname = $1'),
    functions: await one('SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1'),
    primaryKeys: await one("SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.contype = 'p'"),
    foreignKeys: await one("SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.contype = 'f'"),
    indexes: await one('SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1'),
  };
}

function journal() {
  const j = JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta/_journal.json'), 'utf8'));
  if (j.entries[0]?.tag !== '0000_otoapp_baseline') fail('The app migration journal does not begin with the baseline.');
  return j;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function newestManifest() {
  const files = readdirSync(WORK_DIR).filter((f) => /^prepare-.*\.json$/.test(f)).sort();
  if (!files.length) fail('No prepare manifest in the work folder; run prepare first.');
  return join(WORK_DIR, files.at(-1));
}

function compare(before, after) {
  const differences = [];
  for (const [table, n] of Object.entries(before)) {
    if (after[table] === undefined) differences.push({ table, before: n, after: 'missing' });
    else if (after[table] !== n) differences.push({ table, before: n, after: after[table] });
  }
  return differences;
}

// ---- prepare --------------------------------------------------------------

async function prepare() {
  const dumpPath = process.env.RESTORE_DUMP_PATH;
  const serverUrl = process.env.SCRATCH_DATABASE_URL;
  if (!dumpPath || !existsSync(dumpPath)) fail('RESTORE_DUMP_PATH must name the Navicat .sql file.');
  if (!serverUrl) fail('SCRATCH_DATABASE_URL is required (a disposable server, never the target).');
  pgTool('psql', ['--version'], withDatabase(serverUrl, 'postgres'), 'tools check');
  const j = journal();

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const runDir = join(WORK_DIR, `restore-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const sourceCopy = join(runDir, 'source.sql');
  say('copying the dump into the work folder');
  copyFileSync(dumpPath, sourceCopy);
  const dumpSha = sha256File(sourceCopy);
  const dumpBytes = statSync(sourceCopy).size;
  const insertCount = (readFileSync(sourceCopy, 'latin1').match(/^INSERT INTO /gm) || []).length;

  const scratch = `otoapp_scratch_${stamp.toLowerCase()}`;
  const scratchUrl = withDatabase(serverUrl, scratch);
  await connection(withDatabase(serverUrl, 'postgres'), (c) => c.query(`CREATE DATABASE ${quoteIdentifier(scratch)}`));
  say('scratch database created');
  try {
    // A pg_dump plain file may create the public schema itself (an RDS source
    // owns it); a Navicat file never does. Make room so either loads.
    if (/^CREATE SCHEMA (IF NOT EXISTS )?("?public"?);/m.test(readFileSync(sourceCopy, 'latin1'))) {
      await connection(scratchUrl, (c) => c.query('DROP SCHEMA public CASCADE'));
      say('the dump creates public itself; dropped the empty one first');
    }
    pgTool('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-f', inContainer(sourceCopy)], scratchUrl, 'load dump into scratch public');

    const before = await connection(scratchUrl, async (c) => {
      const counts = await tableCounts(c, 'public');
      const shape = await structure(c, 'public');
      return { counts, shape };
    });
    const baselineSql = readFileSync(join(APP_MIGRATIONS, '0000_otoapp_baseline.sql'), 'utf8');
    try {
      assertTableInventory(baselineSql, before.counts);
      say(`structure matches the committed baseline: ${before.shape.tables} tables`);
    } catch (error) {
      writeFileSync(join(runDir, 'structure-difference.json'), JSON.stringify({ message: String(error.message), shape: before.shape }, null, 2));
      fail(`the dump's tables differ from the app's baseline; see ${join(runDir, 'structure-difference.json')}`);
    }
    if (before.shape.sequences !== 0) fail(`the dump declares ${before.shape.sequences} sequences; the restore assumes none (intake §7).`);

    await connection(scratchUrl, async (c) => {
      await c.query(`ALTER SCHEMA public RENAME TO ${SCHEMA}`);
      await c.query('CREATE SCHEMA public');
    });
    say('renamed public to otoapp in scratch');
    const archive = join(runDir, 'otoapp.dump');
    pgTool('pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--schema=${SCHEMA}`, '--file', inContainer(archive)], scratchUrl, 'archive the renamed schema');

    const rows = Object.values(before.counts).reduce((s, n) => s + Number(n), 0);
    const manifest = {
      kind: 'otoapp-restore-prepare',
      preparedAt: new Date().toISOString(),
      source: { file: basename(dumpPath), bytes: dumpBytes, sha256: dumpSha, insertStatements: insertCount },
      scratch: { database: scratch, server: new URL(serverUrl).hostname },
      shape: before.shape,
      tables: Object.keys(before.counts).length,
      rows,
      counts: before.counts,
      archive,
      archiveSha256: sha256File(archive),
      appJournalEntries: j.entries.length,
    };
    const manifestPath = join(WORK_DIR, `prepare-${stamp}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    say(`prepared: ${manifest.tables} tables, ${rows} rows, archive ${(statSync(archive).size / 1e6).toFixed(1)} MB`);
    say(`manifest: ${manifestPath}`);
  } finally {
    await connection(withDatabase(serverUrl, 'postgres'), (c) => c.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(scratch)} WITH (FORCE)`)).catch(() => say('scratch database could not be dropped; drop it by hand'));
    say('scratch database dropped');
  }
}

// ---- apply ----------------------------------------------------------------

async function apply() {
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) fail('TARGET_DATABASE_URL is required.');
  const target = dbName(targetUrl);
  if (process.env.RESTORE_CONFIRM !== target) fail(`RESTORE_CONFIRM must equal the target database name to replace its ${SCHEMA} schema.`);
  const manifestPath = process.env.RESTORE_MANIFEST ?? newestManifest();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== 'otoapp-restore-prepare') fail('Not a prepare manifest.');
  if (sha256File(manifest.archive) !== manifest.archiveSha256) fail('The archive has changed since prepare.');
  const j = journal();
  if (j.entries.length !== manifest.appJournalEntries) fail('The app migration journal changed since prepare; run prepare again.');
  pgTool('pg_restore', ['--version'], targetUrl, 'tools check');

  const runDir = dirname(manifest.archive);
  const report = { kind: 'otoapp-restore-apply', manifest: basename(manifestPath), target: { database: target, server: new URL(targetUrl).hostname }, startedAt: new Date().toISOString(), steps: [] };
  const step = (name, detail) => { report.steps.push({ at: new Date().toISOString(), name, ...detail }); writeFileSync(join(runDir, 'apply-report.json'), JSON.stringify(report, null, 2)); };

  // 1. Preflight: the target runs the current app schema, otherwise the deployed code and the rows would disagree.
  const pre = await connection(targetUrl, async (c) => {
    const ledger = await c.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.__drizzle_migrations`).then((r) => r.rows[0].n).catch(() => null);
    const counts = ledger === null ? {} : await tableCounts(c, SCHEMA);
    const dependents = await c.query(
      `SELECT DISTINCT n.nspname AS schema, c.relname AS name, c.relkind AS kind
         FROM pg_depend d
         JOIN pg_rewrite r ON r.oid = d.objid
         JOIN pg_class c ON c.oid = r.ev_class
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class src ON src.oid = d.refobjid
         JOIN pg_namespace sn ON sn.oid = src.relnamespace
        WHERE sn.nspname = $1 AND n.nspname <> $1
        ORDER BY 1, 2`,
      [SCHEMA],
    );
    const platformLedger = await c.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations').then((r) => r.rows[0].n).catch(() => null);
    return { ledger, counts, dependents: dependents.rows, platformLedger };
  });
  if (pre.ledger === null) fail(`the target has no ${SCHEMA}.__drizzle_migrations; it is not a platform database with the app installed.`);
  if (pre.ledger !== j.entries.length) fail(`the target's app ledger has ${pre.ledger} entries, the journal ${j.entries.length}; deploy the current app first.`);
  const foreignDependents = pre.dependents.filter((d) => d.schema !== VIEWS_SCHEMA);
  if (foreignDependents.length) fail(`objects outside ${SCHEMA}/${VIEWS_SCHEMA} depend on app tables: ${foreignDependents.map((d) => d.schema + '.' + d.name).join(', ')}`);
  step('preflight', { appLedger: pre.ledger, platformLedger: pre.platformLedger, currentTables: Object.keys(pre.counts).length, currentRows: Object.values(pre.counts).reduce((s, n) => s + Number(n), 0), seamViews: pre.dependents.length });
  say(`target ${target}: app ledger ${pre.ledger}, ${Object.keys(pre.counts).length} app tables, ${pre.dependents.length} seam views`);

  // 2. Back up what is there, so it can be put back.
  const backup = join(runDir, `target-${target}-${SCHEMA}-before.dump`);
  pgTool('pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--schema=${SCHEMA}`, `--schema=${VIEWS_SCHEMA}`, '--file', inContainer(backup)], targetUrl, 'back up the current otoapp schema');
  writeFileSync(join(runDir, 'target-before-counts.json'), JSON.stringify(pre.counts, null, 2));
  step('backup', { file: backup, bytes: statSync(backup).size });

  // 3. Replace the schema: drop (the seam views go with it) and restore the renamed archive.
  await connection(targetUrl, async (c) => {
    await c.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await c.query(`DROP SCHEMA IF EXISTS ${VIEWS_SCHEMA} CASCADE`);
  });
  step('drop', {});
  say('dropped the current otoapp schema');
  pgTool('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', target, inContainer(manifest.archive)], targetUrl, 'restore the production rows');
  step('restore', {});

  // 4. Record 0000 as applied (the rows are the baseline shape), then run 0001 onwards.
  await connection(targetUrl, async (c) => {
    await c.query(`CREATE TABLE ${SCHEMA}.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    const hash = createHash('sha256').update(readFileSync(join(APP_MIGRATIONS, `${j.entries[0].tag}.sql`), 'utf8')).digest('hex');
    await c.query(`INSERT INTO ${SCHEMA}.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [hash, String(j.entries[0].when)]);
  });
  step('baseline-recorded', {});
  const migrate = spawnSync(process.execPath, ['script/migrate.mjs'], { cwd: APP_DIR, encoding: 'utf8', env: { ...process.env, DATABASE_URL: targetUrl, DB_SCHEMA: SCHEMA } });
  if (migrate.status !== 0) {
    writeFileSync(join(runDir, 'migrate-output.txt'), (migrate.stdout || '') + '\n' + (migrate.stderr || ''));
    fail(`the app migrator failed; its output is in ${join(runDir, 'migrate-output.txt')} (the backup is ${backup})`);
  }
  const applied = (migrate.stdout.match(/applied|applying/gi) || []).length;
  step('migrate', { outputLines: migrate.stdout.split('\n').length, mentions: applied });
  say('app migrations 0001 onwards applied');

  // 5. Housekeeping the plan names: nobody's old session travels; the platform's links to vanished app users go.
  const house = await connection(targetUrl, async (c) => {
    const out = {};
    const hasSession = (await c.query("SELECT to_regclass($1) IS NOT NULL AS has", [`${SCHEMA}.session`])).rows[0].has;
    if (hasSession) {
      out.sessionsCleared = Number((await c.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.session`)).rows[0].n);
      await c.query(`TRUNCATE ${SCHEMA}.session`);
    }
    const stale = await c.query(
      `DELETE FROM core.app_identity ai WHERE ai.app = 'oto_app' AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.users u WHERE u.id::text = ai.external_user_id) RETURNING ai.id`,
    );
    out.staleIdentitiesRemoved = stale.rowCount;
    out.staleEmployeeMirrors = Number((await c.query(
      `SELECT count(*)::int AS n FROM core.employee e WHERE e.source = 'otoapp' AND e.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.employees a WHERE a.id::text = e.external_id)`,
    )).rows[0].n);
    out.unlinkedAppUsers = Number((await c.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.users WHERE platform_user_id IS NULL`)).rows[0].n);
    out.appBranches = Number((await c.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.branches`)).rows[0].n);
    return out;
  });
  step('housekeeping', house);
  say(`housekeeping: ${JSON.stringify(house)}`);

  // 6. Join the app's branches to the platform's parks (the platform-only pre-deploy never does this).
  const sync = spawnSync('pnpm', ['--filter', '@oto/db', 'exec', 'tsx', 'scripts/otoapp-branch-reconcile.ts'], { cwd: ROOT, encoding: 'utf8', shell: true, env: { ...process.env, DATABASE_URL: targetUrl } });
  writeFileSync(join(runDir, 'branch-reconcile-output.txt'), (sync.stdout || '') + '\n' + (sync.stderr || ''));
  const mapped = await connection(targetUrl, (c) => c.query(`SELECT count(*) FILTER (WHERE core_branch_id IS NOT NULL)::int AS mapped, count(*)::int AS total, count(*) FILTER (WHERE core_sync_status = 'APP_ONLY')::int AS app_only FROM ${SCHEMA}.branches`).then((r) => r.rows[0]));
  step('branch-reconcile', { ...mapped, exit: sync.status });
  say(`branches: ${mapped.mapped} of ${mapped.total} joined to a platform park, ${mapped.app_only} app-only${sync.status ? ' (some need a hand: see branch-reconcile-output.txt)' : ''}`);

  // 7. Verify.
  const result = await verifyAgainst(targetUrl, manifest, j);
  step('verify', result);
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(runDir, 'apply-report.json'), JSON.stringify(report, null, 2));
  if (!result.ok) fail(`verification failed; see ${join(runDir, 'apply-report.json')}`);
  say(`done: ${result.sourceTablesMatching} of ${manifest.tables} source tables hold the dump's counts; report ${join(runDir, 'apply-report.json')}`);
}

// ---- verify ---------------------------------------------------------------

async function verifyAgainst(targetUrl, manifest, j) {
  return connection(targetUrl, async (c) => {
    const counts = await tableCounts(c, SCHEMA);
    const shape = await structure(c, SCHEMA);
    const differences = compare(manifest.counts, counts);
    const ledger = (await c.query(`SELECT hash, created_at::text AS created_at FROM ${SCHEMA}.__drizzle_migrations ORDER BY created_at`)).rows;
    const ledgerOk = ledger.length === j.entries.length && ledger.every((row, i) =>
      row.created_at === String(j.entries[i].when) &&
      row.hash === createHash('sha256').update(readFileSync(join(APP_MIGRATIONS, `${j.entries[i].tag}.sql`), 'utf8')).digest('hex'));
    const views = Number((await c.query('SELECT count(*)::int AS n FROM pg_views WHERE schemaname = $1', [VIEWS_SCHEMA])).rows[0].n);
    const expectedSessionOnly = differences.length === 1 && differences[0].table === 'session' && differences[0].after === '0';
    // Sequences are asserted absent in the dump (prepare); the app's own
    // migrations add serial columns, so none is demanded here.
    const ok = (differences.length === 0 || expectedSessionOnly) && ledgerOk && views > 0;
    return {
      ok,
      sourceTablesMatching: manifest.tables - differences.length,
      differences: differences.slice(0, 20),
      tablesNow: Object.keys(counts).length,
      newTablesFromMigrations: Object.keys(counts).filter((t) => manifest.counts[t] === undefined).length,
      ledger: ledger.length,
      ledgerOk,
      seamViews: views,
      shape,
    };
  });
}

async function verify() {
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) fail('TARGET_DATABASE_URL is required.');
  const manifest = JSON.parse(readFileSync(process.env.RESTORE_MANIFEST ?? newestManifest(), 'utf8'));
  const result = await verifyAgainst(targetUrl, manifest, journal());
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

const mode = process.argv[2];
if (mode === 'prepare') await prepare();
else if (mode === 'apply') await apply();
else if (mode === 'verify') await verify();
else fail('usage: node tools/data/restore-otoapp.mjs prepare | apply | verify');
