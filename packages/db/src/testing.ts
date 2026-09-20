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
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OTOAPP_MIGRATIONS = join(PKG_DIR, '..', '..', 'apps', 'oto-app', 'migrations');

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
  const server = await ensureServer();
  const name = `oto_test_${Date.now()}_${dbCounter++}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = server.replace(/\/[^/]*$/, `/${name}`);

  // Apply committed migrations with drizzle-kit (same path as production).
  execFileSync('node', [join(PKG_DIR, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG_DIR,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  if (opts.otoapp) await applyOtoAppMigrations(url);

  return {
    url,
    drop: async () => {
      const c = new pg.Client({ connectionString: server });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
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
