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
import pg from 'pg';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  });
  await instance.initialise();
  await instance.start();
  embedded = instance;
  serverUrl = `postgres://oto:oto@localhost:${port}/postgres`;
  return serverUrl;
}

/** Create a fresh database on the test server and run migrations into it. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
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
