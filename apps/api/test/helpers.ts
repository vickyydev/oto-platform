import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { seed } from '@oto/db/seed';
import { buildApp, type App } from '../src/app';
import { loadEnv } from '../src/env';
import type { SmsSender } from '../src/services/sms';
import { _resetThrottle } from '../src/services/auth';
import { buildFileStorage } from '../src/services/files';

export interface TestContext {
  app: App;
  db: Db;
  smsLog: string[];
  close: () => Promise<void>;
}

/** Fresh database + migrations + seed + app instance. */
export async function createTestContext(opts: { files?: boolean } = {}): Promise<TestContext> {
  _resetThrottle();
  const { url, drop } = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema }) as Db;
  await seed(db);

  const smsLog: string[] = [];
  const sms: SmsSender = {
    async send(_phone, message) {
      smsLog.push(message);
    },
  };

  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: url });
  const app = await buildApp({
    env,
    db,
    fileStorage: opts.files ? buildFileStorage(env) : null,
  });
  // Replace the console SMS adapter with the capturing one.
  (app as { sms: SmsSender }).sms = sms;

  return {
    app,
    db,
    smsLog,
    close: async () => {
      await app.close();
      await pool.end();
      await drop();
    },
  };
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

export async function teardownAll(): Promise<void> {
  await stopTestServer();
}
