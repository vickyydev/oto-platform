import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { seed } from '@oto/db/seed';
import { buildApp, type App } from '../src/app';
import { loadEnv, type Env } from '../src/env';
import type { SmsSender } from '../src/services/sms';
import { _resetThrottle } from '../src/services/auth';
import { buildFileStorage } from '../src/services/files';

export interface TestContext {
  app: App;
  db: Db;
  smsLog: string[];
  /**
   * Throw the api away and build a new one on the SAME database — what a
   * Render "Restart" or a deploy does. Anything that must survive a restart
   * (the auth throttle, S2-01a) is asserted across this call.
   */
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

/** Fresh database + migrations + seed + app instance. */
export async function createTestContext(
  opts: {
    files?: boolean;
    /**
     * Also build the OTO App's tables in schema `otoapp`. Off by default: its
     * baseline is 184 tables, and only the provisioning tests read them.
     */
    otoapp?: boolean;
    env?: Partial<Record<keyof Env, string>>;
  } = {},
): Promise<TestContext> {
  const { url, drop } = await createTestDatabase({ otoapp: opts.otoapp });
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema }) as Db;
  await seed(db);
  // Throttle counters live in Postgres now (S2-01a), so the reset needs the
  // database and each test gets a fresh one anyway — this is belt and braces.
  await _resetThrottle(db);

  const smsLog: string[] = [];
  const sms: SmsSender = {
    async send(_phone, message) {
      smsLog.push(message);
    },
  };

  const build = async (): Promise<App> => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url, ...opts.env });
    const app = await buildApp({
      env,
      db,
      fileStorage: opts.files ? buildFileStorage(env) : null,
    });
    // Replace the console SMS adapter with the capturing one.
    (app as { sms: SmsSender }).sms = sms;
    return app;
  };

  const ctx: TestContext = {
    app: await build(),
    db,
    smsLog,
    restart: async () => {
      await ctx.app.close();
      ctx.app = await build();
    },
    close: async () => {
      await ctx.app.close();
      await pool.end();
      await drop();
    },
  };
  return ctx;
}

export function lastCode(smsLog: string[]): string {
  const last = smsLog[smsLog.length - 1] ?? '';
  const m = last.match(/(\d{6})/);
  if (!m) throw new Error(`No code found in SMS log: ${last}`);
  return m[1]!;
}

/** Sign in and return the session cookie header value. */
export async function signInAs(app: App, phone: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { phone, password } });
  if (res.statusCode !== 200) {
    throw new Error(`sign-in failed (${res.statusCode}): ${res.body}`);
  }
  const setCookie = res.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return cookie!.split(';')[0]!;
}

export const ADMIN = { phone: '+66900000001', password: 'admin1234' };
export const RECEPTION = { phone: '+66900000002', password: 'reception1234' };
/**
 * The seeded branch managers, one per park, each holding `branch_manager`
 * scoped to their own branch and nothing wider. A branch-scoped grant and an
 * operator-wide one behave identically while only one branch exists, so these
 * two are what make a scope assertion mean anything.
 */
export const BRANCH_MANAGER = { phone: '+66900000004', password: 'manager1234' };
export const CHALONG_MANAGER = { phone: '+66900000005', password: 'manager1234' };

/** The seeded branch slugs. Central Floresta keeps the prototype's original. */
export const CENTRAL_BRANCH_CODE = 'hkt-central';
export const CHALONG_BRANCH_CODE = 'robinson-chalong';

export async function teardownAll(): Promise<void> {
  await stopTestServer();
}
