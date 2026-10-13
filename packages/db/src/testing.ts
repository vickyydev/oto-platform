/**
 * Test database helper. Integration tests run against a real Postgres:
 *   - If TEST_DATABASE_URL is set (CI service container, or the local Docker
 *     Postgres), that server is used and a throwaway database is created on it.
 *   - Otherwise an embedded Postgres 16 is started on a free port (no Docker
 *     needed), used for the whole test run, and cleaned up afterwards.
 * Either way each call returns a FRESH database with migrations applied.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OTOAPP_MIGRATIONS = join(PKG_DIR, '..', '..', 'apps', 'oto-app', 'migrations');

// =============================================================================
// Naming a setup failure (SCRUM-510)
// =============================================================================
//
// Under CI load a suite has fallen over in setup with nothing but
// "Unknown Error: undefined" — a rejection whose reason carried no name and no
// message — and then a teardown crash on the context that was never built.
// Every boot step below runs through `setupStep`, which names the step and
// writes the whole cause chain into the message itself, so the line survives
// the trip from the worker to the reporter even when `cause` does not.
//
// Only node built-ins are used here: the api CI shards install no app
// node_modules, and a formatter that reached for one would replace the real
// cause with its own module-not-found.

/** Fields worth printing from a pg, socket, child-process or Postgres error. */
const DETAIL_FIELDS = [
  'code',
  'errno',
  'syscall',
  'address',
  'port',
  'severity',
  'detail',
  'hint',
  'where',
  'schema',
  'table',
  'constraint',
  'routine',
  'status',
  'signal',
] as const;

const MAX_DEPTH = 6;

function describeOne(err: unknown): string {
  if (err === undefined) return 'the step rejected with undefined (no error object, no message)';
  if (err === null) return 'the step rejected with null (no error object, no message)';
  if (typeof err !== 'object') return `a non-Error value was thrown: ${inspect(err)}`;
  const e = err as Record<string, unknown> & { name?: unknown; message?: unknown };
  const name = typeof e.name === 'string' && e.name ? e.name : (err.constructor?.name ?? 'Object');
  const message = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : '(empty message)';
  const fields = DETAIL_FIELDS.filter((k) => e[k] !== undefined && e[k] !== null && e[k] !== '').map(
    (k) => `${k}=${String(e[k])}`,
  );
  const lines = [`${name}: ${message}${fields.length ? ` [${fields.join(' ')}]` : ''}`];
  // A child process (execFileSync) keeps what it printed on the error itself.
  for (const stream of ['stderr', 'stdout'] as const) {
    const out = e[stream];
    const text = out instanceof Buffer ? out.toString('utf8') : typeof out === 'string' ? out : '';
    if (text.trim()) lines.push(`${stream}:\n${text.trim()}`);
  }
  // A plain object with no message at all: show what it is.
  if (!(err instanceof Error) && message === '(empty message)') lines.push(inspect(err, { depth: 2 }));
  return lines.join('\n');
}

/**
 * The whole cause chain of a failure, one link per line: each `cause`, and each
 * member of an AggregateError (which is what a `localhost` connect that fails
 * on both ::1 and 127.0.0.1 throws, with an empty message of its own).
 */
export function describeFailure(err: unknown, depth = 0): string {
  const head = describeOne(err);
  if (depth >= MAX_DEPTH || !err || typeof err !== 'object') return head;
  const parts = [head];
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    errors.forEach((inner, i) => {
      parts.push(`  [${i + 1}/${errors.length}] ${describeFailure(inner, depth + 1).replace(/\n/g, '\n  ')}`);
    });
  }
  if ('cause' in err && (err as { cause?: unknown }).cause !== undefined) {
    parts.push(`caused by: ${describeFailure((err as { cause?: unknown }).cause, depth + 1)}`);
  }
  return parts.join('\n');
}

/** A harness failure (setup or teardown) that names the step and carries the original as `cause`. */
export class TestSetupError extends Error {
  readonly step: string;
  readonly reason: string;
  constructor(step: string, cause: unknown) {
    const inner = cause instanceof TestSetupError ? cause : null;
    const path = inner ? `${step} > ${inner.step}` : step;
    const reason = inner ? inner.reason : describeFailure(cause);
    super(`test harness step "${path}" failed: ${reason}`, { cause: inner ? inner.cause : cause });
    this.name = 'TestSetupError';
    this.step = path;
    this.reason = reason;
  }
}

/** Run one boot step; if it fails, throw a `TestSetupError` that names it. */
export async function setupStep<T>(step: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new TestSetupError(step, err);
  }
}

let embedded: { stop: () => Promise<void> } | null = null;
let serverUrl: string | null = null; // connection string to the server's postgres db
let dbCounter = 0;

async function ensureServer(): Promise<string> {
  if (serverUrl) return serverUrl;
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    serverUrl = external;
    return serverUrl;
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = mkdtempSync(join(tmpdir(), 'oto-pg-'));
  const port = 54330 + Math.floor(Math.random() * 1000);
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'oto',
    password: 'oto',
    port,
    persistent: false,
    // Windows initdb defaults to the OS locale (e.g. WIN1252), which cannot
    // store the seed's zh/th/ru translations — force UTF8 like production.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await instance.initialise();
  await instance.start();
  embedded = instance;
  serverUrl = `postgres://oto:oto@localhost:${port}/postgres`;
  return serverUrl;
}

/**
 * Apply the OTO App's committed migrations into schema `otoapp`.
 *
 * The app's own `script/migrate.mjs` is the supported path and the one a
 * deploy runs. It cannot be used from here: the app is deliberately outside
 * this pnpm workspace (`pnpm-workspace.yaml`), so its `node_modules` is not
 * installed by `pnpm install` and does not exist in CI at all. This runs the
 * same committed SQL through the same migrator, on one connection with
 * `search_path` set to `otoapp`, using this package's own `pg` and
 * `drizzle-orm` — the app's 184 table definitions carry no schema, so the
 * search path is the only thing deciding where they land.
 */
export async function applyOtoAppMigrations(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: 'oto-test-otoapp' });
  await client.connect();
  try {
    // `otoapp` comes from the platform's own migration 0008; without it every
    // unqualified CREATE TABLE below would land in `public`.
    await client.query('set search_path to otoapp');
    const active = (await client.query('show search_path')).rows[0].search_path as string;
    if (active.replace(/"/g, '').trim() !== 'otoapp') {
      throw new Error(`search_path is "${active}" after setting it; refusing to apply anything`);
    }
    await migrate(drizzle(client), {
      migrationsFolder: OTOAPP_MIGRATIONS,
      migrationsSchema: 'otoapp',
    });
  } finally {
    await client.end();
  }
}

/**
 * Create a fresh database on the test server and run migrations into it.
 *
 * `otoapp` is opt-in: the app's baseline builds 184 tables and 65 enum types,
 * which is several seconds no test that never reads them should pay.
 */
export async function createTestDatabase(
  opts: { otoapp?: boolean } = {},
): Promise<{ url: string; drop: () => Promise<void> }> {
  const server = await setupStep(
    process.env.TEST_DATABASE_URL ? 'use the test Postgres server' : 'start the embedded test Postgres server',
    ensureServer,
  );
  // The process id and a random tail keep parallel workers apart: each worker's
  // counter starts at zero, and two of them starting in the same millisecond
  // once collided on the database name.
  // A loaded CI runner occasionally fails a CREATE or the migrate child process
  // once; three tries, each on a fresh name, and a readable error after the last.
  let name = '';
  let url = '';
  // Every attempt's failure is kept, each under the step that died, so the
  // final error says whether the tries failed the same way or three different ways.
  const failures: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    name = `oto_test_${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 6)}_${dbCounter++}`;
    url = server.replace(/\/[^/]*$/, `/${name}`);
    try {
      const admin = new pg.Client({ connectionString: server, application_name: 'oto-test-create' });
      await setupStep('connect to the test Postgres server', () => admin.connect());
      try {
        await setupStep(`CREATE DATABASE ${name}`, () => admin.query(`CREATE DATABASE ${name}`));
      } finally {
        await admin.end().catch(() => undefined);
      }
      // Apply committed migrations with drizzle-kit (same path as production).
      await setupStep(`apply migrations to ${name} (drizzle-kit migrate)`, () => {
        execFileSync('node', [join(PKG_DIR, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
          cwd: PKG_DIR,
          env: { ...process.env, DATABASE_URL: url },
          stdio: 'pipe',
        });
      });
      break;
    } catch (err) {
      failures.push(
        `attempt ${attempt}: ${err instanceof TestSetupError ? `step "${err.step}": ${err.reason}` : describeFailure(err)}`,
      );
      const cleanup = new pg.Client({ connectionString: server });
      await cleanup.connect().catch(() => undefined);
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await cleanup.end().catch(() => undefined);
      if (attempt >= 3) {
        // Each attempt's cause chain is already written out in `failures`.
        throw new TestSetupError(
          'create a migrated test database',
          new Error(`all ${attempt} tries failed:\n${failures.join('\n')}`),
        );
      }
    }
  }

  if (opts.otoapp) {
    await setupStep(`apply the OTO App migrations to ${name} (schema otoapp)`, () => applyOtoAppMigrations(url));
  }

  return {
    url,
    drop: async () => {
      const c = new pg.Client({ connectionString: server });
      await setupStep(`teardown: connect to drop ${name}`, () => c.connect());
      try {
        await setupStep(`teardown: DROP DATABASE ${name}`, () =>
          c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
        );
      } finally {
        await c.end().catch(() => undefined);
      }
    },
  };
}

export async function stopTestServer(): Promise<void> {
  if (embedded) {
    await embedded.stop();
    embedded = null;
  }
  serverUrl = null;
}
