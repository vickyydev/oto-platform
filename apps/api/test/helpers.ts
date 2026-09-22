import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
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

/**
 * The second operator's administrator (SCRUM-289).
 *
 * Holds `operator_admin` scoped to its own operator and nothing wider, so it
 * is the foreign principal every tenancy assertion needs: anything it can
 * read or change that belongs to OTO is a tenancy hole, and until this account
 * existed in the default fixture no test could say so without building a
 * tenant by hand first. Nine did; the other thirty-five did not, which is why
 * SCRUM-280 and SCRUM-281 reached staging.
 */
export const SECOND_OPERATOR_ADMIN = { phone: '+66900000009', password: 'second1234' };

/** The seeded branch slugs. Central Floresta keeps the prototype's original. */
export const CENTRAL_BRANCH_CODE = 'hkt-central';
export const CHALONG_BRANCH_CODE = 'robinson-chalong';
/** The second operator's only branch. Never OTO's — that is the point of it. */
export const SECOND_OPERATOR_BRANCH_CODE = 'second-operator-1';

/**
 * The seeded operators, by name. `OTO` is the park; the other is the foreign
 * tenant above. A test that needs a specific one looks it up by name rather
 * than taking the first row, because "the first row" is exactly the habit a
 * single-operator fixture taught.
 */
export const OTO_OPERATOR_NAME = 'OTO';
export const SECOND_OPERATOR_NAME = 'Second Operator';

/** The operator id for a seeded operator name. */
export async function operatorIdByName(db: Db, name: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.operator.id })
    .from(schema.operator)
    .where(eq(schema.operator.name, name))
    .limit(1);
  if (!row) throw new Error(`No seeded operator named ${name}`);
  return row.id;
}

/**
 * The branch id for a seeded branch code, inside one operator.
 *
 * `branch_code_unique` is keyed on (operator, code), so a code is a name in a
 * tenant and not on the platform — the same reason `boxBySlot` below takes an
 * operator. No two seeded branches share a code today; scoping it anyway is
 * what stops this growing into the next unscoped lookup.
 */
export async function branchIdByCode(
  db: Db,
  code: string,
  operatorName: string = OTO_OPERATOR_NAME,
): Promise<string> {
  const operatorId = await operatorIdByName(db, operatorName);
  const [row] = await db
    .select({ id: schema.branch.id })
    .from(schema.branch)
    .where(and(eq(schema.branch.operatorId, operatorId), eq(schema.branch.code, code)))
    .limit(1);
  if (!row) throw new Error(`No seeded branch with code ${code} for operator ${operatorName}`);
  return row.id;
}

/**
 * A seeded box, by slot, inside one operator (SCRUM-289).
 *
 * A slot is unique within a BRANCH — `box_slot_unique` says so — so `virtual-1`
 * names one box per branch and more than one across the platform. Ten places in
 * this suite looked that slot up with no operator on the predicate; while the
 * fixture held a single tenant that read as precise and was not, and the row
 * that came back was whichever one Postgres happened to return first. Five
 * broke the day a second operator appeared. The other five went on passing,
 * which is the worse half of the story.
 *
 * This is what to reach for instead. It throws rather than returning undefined,
 * because a fixture lookup that finds nothing is a broken test and not a
 * failing assertion.
 */
export async function boxBySlot(
  db: Db,
  slot: string,
  operatorName: string = OTO_OPERATOR_NAME,
): Promise<typeof schema.box.$inferSelect> {
  const operatorId = await operatorIdByName(db, operatorName);
  const [row] = await db
    .select()
    .from(schema.box)
    .where(and(eq(schema.box.operatorId, operatorId), eq(schema.box.slot, slot)))
    .limit(1);
  if (!row) throw new Error(`No seeded box in slot ${slot} for operator ${operatorName}`);
  return row;
}

export async function teardownAll(): Promise<void> {
  await stopTestServer();
}
