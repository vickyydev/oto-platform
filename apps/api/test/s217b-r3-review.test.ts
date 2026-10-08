import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, opsLast, opsRun, type Db } from '@oto/db';
import { isoDateInTz, newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { loadEnv, type Env } from '../src/env';
import { buildOtoAppNightJobs, createJobRunner, type JobDefinition } from '../src/services/jobs';
import { recordRun } from '../src/services/ops';
import {
  DIRECTORY_UNREACHABLE,
  buildOtoAppJobsClient,
  type NightJobAnswer,
  type OtoAppNightJob,
} from '../src/services/otoapp-directory';
import {
  DEPARTED_ACCOUNT_CASE,
  NIGHT_STEP_FAILED,
  OTOAPP_DEPARTED_ACCOUNT_RUN,
  OTOAPP_MIDNIGHT_JOB,
  OTOAPP_PRESENCE_JOB,
  OTOAPP_RECONCILE_JOB,
  nightGroupsDone,
  type NightJobSummary,
} from '../src/services/otoapp-jobs';

/**
 * S2-17b round 3 — THE REVIEW, from the attacking side (SCRUM-193 under
 * SCRUM-191; docs/progress/plans/otoapp-lift/PLAN.md section 5 "The app's jobs
 * on the platform runner", section 8 round 3, hazards H7-H9, Q4 and Q22-Q26).
 *
 *  1. ONCE PER BANGKOK DATE, at its edges (H8/H9): the UTC straddle of
 *     Bangkok midnight (17:00Z) and of 03:00 (20:00Z), a night that fails at
 *     00:04 and is run at the next tick, the done-set read only from park
 *     groups a run recorded FINISHED (a failed, locked or other-date group is
 *     never done), the clock past 01:00 with the 00:01 batch never run, and
 *     two runners on the schedule plus a Run now at once.
 *  2. THE DUPLICATE-WORK HAZARD: a call that outlives the timeout is run again
 *     at the next tick, so the night's second batch is real — and, against the
 *     app itself, the second midnight batch of one date makes a SECOND
 *     instance of a recurring task due before 07:00 Bangkok (a new finding,
 *     pinned `it.fails`); a timer under `inprocess` on another instance takes
 *     none of the endpoint's batch lock (pinned `it.fails`, the last test).
 *  3. TENANT ISOLATION: a key bound to one park group never runs another's
 *     batch (named, configured against the wrong one, revoked, inactive), and
 *     — a new finding, pinned `it.fails` — a park group the app holds but
 *     OTOAPP_JOBS_KEYS does not name loses its whole night under `platform`
 *     with every run green.
 *  4. THE SWALLOWED-ERROR PROMISE, step by step against the real app: each of
 *     the five catching steps the builder's own checks did not force
 *     (autoCheckout, taskGeneration, presenceReconciliation, statusTransitions,
 *     departedLogins) answers a failed step in words and the batch carries on;
 *     end to end, the platform's run fails naming the step and the next tick
 *     finishes the night once.
 *  5. Q4 — the leaver listing names exactly the accounts the app's own rule
 *     reaches (checked against the app's real 03:00 batch), invited and
 *     today's leavers left out, the email-only link listed as Q23 says, once
 *     per night, and it never switches anyone off.
 *  6. THE SEAMS: no client app or package names the jobs endpoint or its keys;
 *     a key never reaches a log line, a request body or a run's record; a
 *     Run now replayed with its idempotency key does not run twice, and is
 *     audited once.
 *  7. THE MANUAL TRIGGERS under both switches, over HTTP.
 *  8. A park group the app answers "already running" at every tick of a date
 *     leaves the night undone with every run green (pinned `it.fails`).
 *
 * Sections 1-3 (stand-in parts), 5, 6 and 8 run against a stand-in app; the
 * rest against the real app when its node_modules are present.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);

const BANGKOK = 'Asia/Bangkok';
const at = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let ctx: TestContext;
let db: Db;
let appPool: pg.Pool;
let dbUrl: string;
let admin: string;
let oto: string;
let central: string;
let chalong: string;

const key = () => `odk_${randomBytes(32).toString('base64url')}`;
/** Park group A (anchored to OTO through Central) and B. The stand-in answers both. */
const tenantA = newId();
const tenantB = newId();
const keyA = key();
const keyB = key();

// =============================================================================
// The stand-in app (the same contract the builder's suite drives)
// =============================================================================

interface StubCall {
  job: string;
  tenantId: string;
}

type StubReply =
  | { kind: 'answer'; status: number; body: unknown }
  | { kind: 'drop' }
  | { kind: 'hold'; until: Promise<void>; then: StubReply };

const STEPS: Record<OtoAppNightJob, Array<{ step: string; onFailure: 'continue' | 'stop'; counts: Record<string, number> }>> = {
  midnight: [
    { step: 'autoCheckout', onFailure: 'continue', counts: { checkedOut: 0 } },
    { step: 'autoClockOut', onFailure: 'continue', counts: { autoClockedOut: 0 } },
    { step: 'taskGeneration', onFailure: 'continue', counts: { generated: 0 } },
  ],
  reconcile: [
    { step: 'presenceReconciliation', onFailure: 'continue', counts: { stuckClockIns: 0, presenceMismatches: 0, repairs: 0, anomalies: 0 } },
    { step: 'statusTransitions', onFailure: 'continue', counts: { transitioned: 0 } },
    { step: 'departedLogins', onFailure: 'continue', counts: { deactivated: 0 } },
    { step: 'availabilityCleanup', onFailure: 'stop', counts: { deleted: 0 } },
  ],
  presence: [
    { step: 'presenceReconciliation', onFailure: 'continue', counts: { stuckClockIns: 0, presenceMismatches: 0, repairs: 0, anomalies: 0 } },
  ],
};

function answer(job: OtoAppNightJob, tenantId: string): NightJobAnswer {
  const now = new Date().toISOString();
  return { job, tenantId, ok: true, startedAt: now, finishedAt: now, steps: STEPS[job].map((s) => ({ ...s, ok: true })) };
}

const KEYS: Record<string, string> = {};

class StubApp {
  calls: StubCall[] = [];
  reply: (call: StubCall) => StubReply = (call) => this.ok(call);
  private server: Server | null = null;
  origin = '';

  ok(call: StubCall): StubReply {
    return { kind: 'answer', status: 200, body: answer(call.job as OtoAppNightJob, call.tenantId) };
  }

  reset(): void {
    this.calls = [];
    this.reply = (call) => this.ok(call);
  }

  callsFor(job: string, tenantId?: string): StubCall[] {
    return this.calls.filter((c) => c.job === job && (!tenantId || c.tenantId === tenantId));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const m = /^\/api\/directory\/jobs\/([a-z]+)\/run$/.exec(req.url ?? '');
    const send = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !m) return send(404, { error: 'not_found', message: 'Not found' });
    const body = (raw ? JSON.parse(raw) : {}) as { tenantId?: string };
    const tenantId = body.tenantId ?? '';
    if (req.headers.authorization !== `Bearer ${KEYS[tenantId]}`) {
      return send(403, { error: 'Invalid directory key', message: 'The key is not one this app issued, or it has been revoked' });
    }
    const call: StubCall = { job: m[1]!, tenantId };
    this.calls.push(call);
    let reply = this.reply(call);
    while (reply.kind === 'hold') {
      await reply.until;
      reply = reply.then;
    }
    if (reply.kind === 'drop') {
      req.socket.destroy();
      return;
    }
    send(reply.status, reply.body);
  }
}

const stub = new StubApp();

const envFor = (groups: Array<[string, string]>, extra: Partial<Record<keyof Env, string>> = {}): Env =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
    PROCESS_ROLES: 'api,jobs',
    OTOAPP_DIRECTORY_URL: stub.origin,
    OTOAPP_JOBS_KEYS: groups.map(([t, k]) => `${t}:${k}`).join(','),
    OTOAPP_JOBS_TIMEOUT_MS: '5000',
    ...extra,
  });

const AB = (): Env => envFor([[tenantA, keyA], [tenantB, keyB]]);

function nightJob(name: OtoAppNightJob, clock: () => Date, env: Env = AB()): JobDefinition {
  const job = buildOtoAppNightJobs({ env, log: ctx.app.log }, { clock }).find((j) => j.name === `job:otoapp.${name}`);
  if (!job) throw new Error(`no ${name} job`);
  return job;
}

const runnerFor = (job: JobDefinition, env: Env = AB()) =>
  createJobRunner({ db, env, log: ctx.app.log, channels: [], jobs: [job] });

const runsFor = async (job: string, date?: string) =>
  db
    .select()
    .from(opsRun)
    .where(and(eq(opsRun.name, job), eq(opsRun.kind, 'job'), date ? sql`${opsRun.detail} ->> 'date' = ${date}` : undefined))
    .orderBy(desc(opsRun.startedAt));

const detailOf = (run: { detail: unknown }) => run.detail as NightJobSummary;

const successesFor = async (job: string, date: string, tenantId: string) =>
  (await runsFor(job, date)).filter((r) =>
    detailOf(r).groups?.some((g) => g.tenantId === tenantId && g.outcome === 'ran' && g.ok),
  ).length;

// =============================================================================
// The app's rows
// =============================================================================

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await appPool.query<T>(text, params)).rows;

const scrypt = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

const tag = () => newId().replace(/-/g, '').slice(-8);
/** The app keeps naive UTC timestamps: "30 hours ago" is always before today's Bangkok midnight. */
const LONG_AGO = "(now() at time zone 'utc') - interval '30 hours'";
const PASSWORD = 'zz-r3rev-pw';

async function appTenant(label: string): Promise<string> {
  const id = newId();
  await q(`insert into tenants (id, name, slug) values ($1, $2, $3)`, [id, `ZZ r3rev ${label}`, `zz-r3rev-${label}-${tag()}`]);
  return id;
}

async function appBranch(tenant: string, coreBranchId: string | null = null): Promise<string> {
  const id = newId();
  await q(`insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ r3rev', $4)`, [
    id,
    tenant,
    `ZZ r3rev park ${tag()}`,
    coreBranchId,
  ]);
  return id;
}

async function appEmployee(tenant: string, branch: string, fields: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
  const all: Record<string, unknown> = {
    id,
    tenant_id: tenant,
    branch_id: branch,
    full_name: `ZZ r3rev ${tag()}`,
    nickname: 'ZZ',
    email: `zz-r3rev-e-${tag()}@example.com`,
    ...fields,
  };
  const cols = Object.keys(all);
  await q(`insert into employees (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(all));
  return id;
}

async function appUser(opts: { email?: string; platformUserId?: string | null; role?: string; active?: boolean } = {}) {
  const id = newId();
  const email = opts.email ?? `zz-r3rev-u-${tag()}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, $5, $6, false, $7)`,
    [id, email, scrypt(PASSWORD), `ZZ r3rev user ${tag()}`, opts.role ?? 'staff', opts.active ?? true, opts.platformUserId ?? null],
  );
  return { id, email };
}

async function staleClockIn(tenant: string, branch: string, employee: string): Promise<void> {
  await q(
    `insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time, auth_method)
     values ($1, $2, $3, 'IN', ${LONG_AGO}, 'PIN')`,
    [tenant, employee, branch],
  );
}

const outsOf = async (employee: string) =>
  Number((await q<{ n: string }>(`select count(*) as n from time_events where employee_id = $1 and event_type = 'OUT'`, [employee]))[0]!.n);

async function directoryKey(tenant: string, scopes: string[], state: 'active' | 'revoked' | 'inactive' = 'active') {
  const k = key();
  await q(
    `insert into directory_clients (tenant_id, name, key_hash, scopes, is_active, revoked_at)
     values ($1, 'ZZ r3rev', $2, $3, $4, $5)`,
    [tenant, createHash('sha256').update(k).digest('hex'), scopes, state !== 'inactive', state === 'revoked' ? new Date() : null],
  );
  return k;
}

let phoneSeq = 0;
async function platformAccount(operatorId: string, status: 'active' | 'inactive' | 'invited' = 'active'): Promise<string> {
  const id = newId();
  await db.insert(account).values({
    id,
    operatorId,
    phone: `+669000084${String(10 + phoneSeq++).padStart(2, '0')}`,
    passwordHash: null,
    phoneVerifiedAt: status === 'invited' ? null : new Date(),
    status,
  });
  return id;
}

/** Yesterday and today, as Bangkok dates, for the app's real clock. */
function bangkokDays(): { today: string; yesterday: string } {
  const today = isoDateInTz(new Date(), BANGKOK);
  const yesterday = isoDateInTz(new Date(at(today, '12:00').getTime() - 24 * 3_600_000), BANGKOK);
  return { today, yesterday };
}

beforeAll(async () => {
  await stub.start();
  KEYS[tenantA] = keyA;
  KEYS[tenantB] = keyB;
  ctx = await createTestContext({
    otoapp: true,
    env: {
      OPS_TEST_CONTROLS: 'true',
      PROCESS_ROLES: 'api,jobs',
      OTOAPP_DIRECTORY_URL: stub.origin,
      OTOAPP_JOBS_KEYS: `${tenantA}:${keyA}`,
      OTOAPP_JOBS_TIMEOUT_MS: '5000',
    },
  });
  db = ctx.db;
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  oto = await operatorIdByName(db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(db, CHALONG_BRANCH_CODE);
  dbUrl = (db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=otoapp', max: 4 });
  for (const [id, label] of [
    [tenantA, 'a'],
    [tenantB, 'b'],
  ] as const) {
    await q(`insert into tenants (id, name, slug) values ($1, $2, $3)`, [id, `ZZ r3rev ${label}`, `zz-r3rev-${label}-${id.slice(-6)}`]);
  }
  await appBranch(tenantA, central);
}, 240_000);

afterAll(async () => {
  for (const child of children) child.kill();
  await appPool?.end();
  await ctx?.close();
  await stub.close();
  await teardownAll();
});

// =============================================================================
// 1. Once per Bangkok date, at its edges
// =============================================================================

describe('1. once per Bangkok date, at its edges (H8, H9)', () => {
  it('the UTC straddle: 17:00:59Z is still not due, 17:01Z runs the NEW Bangkok date, 16:59:59Z the next day is still that date', async () => {
    stub.reset();
    let clock = new Date('2026-12-01T17:00:59.999Z'); // Bangkok 2026-12-02 00:00:59.999
    const job = nightJob('midnight', () => clock);
    const runner = runnerFor(job);

    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, '2026-12-02'))[0]!)).toMatchObject({ date: '2026-12-02', due: false });
    expect(stub.calls).toEqual([]);

    clock = new Date('2026-12-01T17:01:00.000Z'); // Bangkok 00:01 on 2026-12-02
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, '2026-12-02'))[0]!).groups.map((g) => g.outcome)).toEqual(['ran', 'ran']);

    clock = new Date('2026-12-02T16:59:59.999Z'); // Bangkok 23:59:59.999, still 2026-12-02
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, '2026-12-02'))[0]!).groups.map((g) => g.outcome)).toEqual(['done', 'done']);
    expect(stub.calls).toHaveLength(2);

    clock = new Date('2026-12-02T17:00:30.000Z'); // Bangkok 00:00:30 on 2026-12-03: a new date, not yet due
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, '2026-12-03'))[0]!)).toMatchObject({ date: '2026-12-03', due: false });
    expect(stub.calls).toHaveLength(2);

    clock = new Date('2026-12-02T17:01:00.000Z');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.calls).toHaveLength(4);
    expect(await successesFor(job.name, '2026-12-02', tenantA)).toBe(1);
    expect(await successesFor(job.name, '2026-12-03', tenantA)).toBe(1);
  });

  it('the 03:00 batch at 19:59:59Z and 20:00:00Z', async () => {
    stub.reset();
    let clock = new Date('2026-12-04T19:59:59.000Z'); // Bangkok 02:59:59 on 2026-12-05
    const job = nightJob('reconcile', () => clock);
    const runner = runnerFor(job);
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, '2026-12-05'))[0]!)).toMatchObject({ due: false, reason: 'Not due before 03:00 Bangkok time.' });
    clock = new Date('2026-12-04T20:00:00.000Z');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('reconcile')).toHaveLength(2);
    expect(await successesFor(job.name, '2026-12-05', tenantB)).toBe(1);
  });

  it('a night that fails at 00:04 is not done; the 00:09 tick runs it; the 00:14 tick finds it done', async () => {
    stub.reset();
    const date = '2026-12-06';
    let clock = at(date, '00:04');
    const job = nightJob('midnight', () => clock);
    const runner = runnerFor(job);
    stub.reply = () => ({ kind: 'answer', status: 503, body: { error: 'Service Unavailable', message: 'restarting' } });
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    expect([...(await nightGroupsDone(db, job.name, date))]).toEqual([]);

    stub.reset();
    clock = at(date, '00:09');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect([...(await nightGroupsDone(db, job.name, date))].sort()).toEqual([tenantA, tenantB].sort());
    clock = at(date, '00:14');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.calls).toHaveLength(2);
    expect(await successesFor(job.name, date, tenantA)).toBe(1);
    expect(await successesFor(job.name, date, tenantB)).toBe(1);
  });

  it('"done" is read only from park groups a run recorded FINISHED for that date, under that job', async () => {
    const name = 'job:zz-r3rev.night';
    const date = '2026-12-07';
    const [t1, t2, t3, t4, t5, t6] = [newId(), newId(), newId(), newId(), newId(), newId()];
    const started = new Date();
    // A failed run: one park group failed, one finished, one locked, one whose platform step failed.
    await recordRun(db, {
      kind: 'job',
      name,
      outcome: 'failed',
      startedAt: started,
      error: new Error('one park group failed'),
      detail: {
        date,
        groups: [
          { tenantId: t1, outcome: 'failed', ok: false },
          { tenantId: t2, outcome: 'ran', ok: true },
          { tenantId: t3, outcome: 'locked', ok: false },
          { tenantId: t6, outcome: 'failed', ok: false, code: 'OTOAPP_DEPARTED_LISTING_FAILED' },
        ],
      },
    });
    // Another date, a "not due" run, and the same date under another job.
    await recordRun(db, { kind: 'job', name, outcome: 'ok', startedAt: started, detail: { date: '2026-12-08', groups: [{ tenantId: t4, outcome: 'ran', ok: true }] } });
    await recordRun(db, { kind: 'job', name, outcome: 'ok', startedAt: started, detail: { date, due: false, groups: [] } });
    await recordRun(db, { kind: 'job', name: 'job:zz-r3rev.other', outcome: 'ok', startedAt: started, detail: { date, groups: [{ tenantId: t5, outcome: 'ran', ok: true }] } });
    expect([...(await nightGroupsDone(db, name, date))]).toEqual([t2]);
    // The failed one finishes later: done from then on.
    await recordRun(db, { kind: 'job', name, outcome: 'ok', startedAt: new Date(), detail: { date, groups: [{ tenantId: t1, outcome: 'ran', ok: true }, { tenantId: t2, outcome: 'done', ok: true }] } });
    expect([...(await nightGroupsDone(db, name, date))].sort()).toEqual([t1, t2].sort());
  });

  it('the clock past 01:00 with the 00:01 batch never run: the first tick (05:37) runs it for that date', async () => {
    stub.reset();
    const job = nightJob('midnight', () => at('2026-12-08', '05:37'));
    expect(await runnerFor(job).runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, '2026-12-08'))[0]!).groups.map((g) => [g.tenantId, g.outcome])).toEqual([
      [tenantA, 'ran'],
      [tenantB, 'ran'],
    ]);
  });

  it('two runners on the schedule at once, then a Run now beside them: the app is called once per park group, and Health ends on the run that ran', async () => {
    stub.reset();
    const date = '2026-12-09';
    await db.delete(opsLast).where(eq(opsLast.name, OTOAPP_MIDNIGHT_JOB));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    stub.reply = (call) => ({ kind: 'hold', until: gate, then: stub.ok(call) });
    const one = runnerFor(nightJob('midnight', () => at(date, '00:30')));
    const two = runnerFor(nightJob('midnight', () => at(date, '00:30')));

    const p1 = one.runJob(OTOAPP_MIDNIGHT_JOB);
    const p2 = two.runJob(OTOAPP_MIDNIGHT_JOB);
    await expect.poll(() => stub.calls.length, { timeout: 10_000 }).toBe(1);
    // Run now on the second instance while the first is inside the app.
    expect(await two.runJob(OTOAPP_MIDNIGHT_JOB, { force: true })).toBe('locked');
    open();
    const outcomes = (await Promise.all([p1, p2])).sort();
    expect(outcomes[1]).toBe('ok');
    expect(['locked', 'not_due']).toContain(outcomes[0]);
    expect(stub.callsFor('midnight', tenantA)).toHaveLength(1);
    expect(stub.callsFor('midnight', tenantB)).toHaveLength(1);
    expect(await successesFor(OTOAPP_MIDNIGHT_JOB, date, tenantA)).toBe(1);
    // The refused press claimed the tick ('running') but recorded nothing; the
    // run that ran recorded after it, so Health does not stay on 'running'.
    const [last] = await db.select().from(opsLast).where(eq(opsLast.name, OTOAPP_MIDNIGHT_JOB));
    const [newest] = await runsFor(OTOAPP_MIDNIGHT_JOB, date);
    expect(last).toMatchObject({ lastOutcome: 'ok', lastRunId: newest!.id });
  });
});

// =============================================================================
// 2. The duplicate-work hazard (stand-in part)
// =============================================================================

describe('2. the duplicate-work hazard — what makes a second batch for one date real', () => {
  it('a call that outlives OTOAPP_JOBS_TIMEOUT_MS fails the run though the app finished it, so the next tick runs the night AGAIN', async () => {
    stub.reset();
    const date = '2026-12-10';
    const env = envFor([[tenantA, keyA]], { OTOAPP_JOBS_TIMEOUT_MS: '1000' });
    let clock = at(date, '00:06');
    const job = nightJob('midnight', () => clock, env);
    const runner = runnerFor(job, env);
    // The app takes 1.5 s and finishes; the platform stopped listening at 1 s.
    stub.reply = (call) => ({ kind: 'hold', until: sleep(1500), then: stub.ok(call) });
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    expect((await runsFor(job.name, date))[0]).toMatchObject({ outcome: 'failed', errorCode: DIRECTORY_UNREACHABLE });
    await sleep(700);
    stub.reply = (call) => stub.ok(call);
    clock = at(date, '00:11');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    // The app ran the batch twice for one date: every step's repeat-safety is
    // load-bearing (PLAN section 10, "every step ... is safe to repeat") —
    // and, against the app itself (section J4), one step was not (F2, now
    // fixed: task generation finds a date's instance by the date it was made for).
    expect(stub.callsFor('midnight', tenantA)).toHaveLength(2);
    expect(await successesFor(job.name, date, tenantA)).toBe(1);
  });
});

// =============================================================================
// 3. Tenant isolation (stand-in part): a park group nobody holds a key for
// =============================================================================

describe('3. tenant isolation — a park group the app holds but OTOAPP_JOBS_KEYS does not name', () => {
  const tenantU = newId();

  beforeAll(async () => {
    await q(`insert into tenants (id, name, slug) values ($1, 'ZZ r3rev unkeyed', $2)`, [tenantU, `zz-r3rev-u-${tenantU.slice(-6)}`]);
    const branch = await appBranch(tenantU);
    await appEmployee(tenantU, branch);
  });

  it('the app holds park group U (it is in the employee view the platform already reads)', async () => {
    const rows = await db.execute<{ n: string }>(sql`select count(*)::text as n from otoapp_v.employees where tenant_id = ${tenantU}::uuid`);
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  /**
   * FINDING (MEDIUM, apps/api/src/services/otoapp-jobs.ts:258 — the loop runs
   * `client.tenantIds`, the keyed park groups, and nothing else). Under
   * `OTOAPP_JOBS=platform` the app starts NO timer for ANY park group
   * (apps/oto-app/server/scheduled-jobs.ts:640), so a park group with no entry
   * in OTOAPP_JOBS_KEYS loses its whole night — no auto clock-out, no
   * LEAVING->LEFT, no leaver's app login switched off, no recurring tasks, no
   * presence repair — while every run of all three jobs is green and nothing
   * reaches Failures or the watchdog (H7: "stops and nobody notices"). Q22's
   * hand-over says "issue the jobs:run key" in the singular; any second park
   * group is one omission away from this.
   * FIX: each run reads the park groups the app holds (distinct `tenant_id` of
   * `otoapp_v.employees`, through otoapp-employees.ts, the declared seam) and
   * fails, naming each one with no key (e.g. code
   * OTOAPP_NIGHT_JOB_UNKEYED) — or the app's endpoint answers the park groups
   * with no active `jobs:run` client and the platform fails on them.
   */
  it.fails('FINDING: a run under keys for A alone names park group U, which nobody runs any more', async () => {
    stub.reset();
    const date = '2026-12-11';
    const env = envFor([[tenantA, keyA]]);
    const job = nightJob('midnight', () => at(date, '00:30'), env);
    const outcome = await runnerFor(job, env).runJob(job.name, { force: true });
    const [run] = await runsFor(job.name, date);
    expect(stub.callsFor('midnight', tenantU)).toEqual([]);
    expect(`${outcome} ${JSON.stringify(run!.detail)} ${run!.errorMessage ?? ''}`).toContain(tenantU);
  });
});

// =============================================================================
// 5. Q4: the leaver listing (stand-in part)
// =============================================================================

describe('5. Q4 — the leaver listing names exactly the accounts it should, once a night, and switches nobody off', () => {
  const people = { yesterday: '', today: '', invited: '', emailOnly: '', stayer: '' };
  const date = '2026-12-20'; // midnight = 2026-12-19T17:00Z

  beforeAll(async () => {
    const branch = (await q<{ id: string }>('select id from branches where tenant_id = $1', [tenantA]))[0]!.id;
    const person = async (lastWorkingDay: string | null, status: 'active' | 'invited' = 'active') => {
      const acct = await platformAccount(oto, status);
      const user = await appUser({ platformUserId: acct, active: true });
      await appEmployee(tenantA, branch, { user_id: user.id, email: user.email, last_working_day: lastWorkingDay });
      return acct;
    };
    people.yesterday = await person('2026-12-19 00:00:00');
    people.today = await person('2026-12-20 00:00:00');
    people.invited = await person('2026-10-01 00:00:00', 'invited');
    people.stayer = await person(null);
    // Linked by the app's email fallback only: the user is carried by no employee.
    people.emailOnly = await platformAccount(oto);
    const loose = await appUser({ platformUserId: people.emailOnly });
    await appEmployee(tenantA, branch, { email: loose.email.toUpperCase(), last_working_day: '2026-10-01 00:00:00' });
  });

  const cases = async (d: string) =>
    db.select().from(opsRun).where(and(eq(opsRun.name, OTOAPP_DEPARTED_ACCOUNT_RUN), sql`${opsRun.detail} ->> 'date' = ${d}`));

  it('yesterday\'s leaver and the email-linked leaver are listed; today\'s leaver, the invited account and the stayer are not', async () => {
    stub.reset();
    const env = envFor([[tenantA, keyA]]);
    const job = nightJob('reconcile', () => at(date, '03:05'), env);
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    const listed = (await cases(date)).map((c) => (c.detail as { accountId: string }).accountId).sort();
    expect(listed).toEqual([people.yesterday, people.emailOnly].sort());
    for (const c of await cases(date)) expect(c).toMatchObject({ kind: 'integration', outcome: 'failed', errorCode: DEPARTED_ACCOUNT_CASE, operatorId: oto });
  });

  it('it switches nobody off: every account keeps its status and no account audit row is written', async () => {
    const ids = Object.values(people);
    const rows = await db.select({ id: account.id, status: account.status }).from(account).where(inArray(account.id, ids));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [people.yesterday]: 'active',
      [people.today]: 'active',
      [people.invited]: 'invited',
      [people.emailOnly]: 'active',
      [people.stayer]: 'active',
    });
    const audits = await db.select().from(auditLog).where(inArray(auditLog.entityId, ids));
    expect(audits).toEqual([]);
  });

  it('once a night: later ticks of the same date file nothing more; the next night files the standing cases again', async () => {
    const env = envFor([[tenantA, keyA]]);
    for (const time of ['03:10', '12:00', '23:59']) {
      const job = nightJob('reconcile', () => at(date, time), env);
      expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    }
    expect(await cases(date)).toHaveLength(2);
    const next = nightJob('reconcile', () => at('2026-12-21', '03:00'), env);
    expect(await runnerFor(next, env).runJob(next.name, { force: true })).toBe('ok');
    // Today's leaver of the 20th is yesterday's leaver of the 21st.
    expect((await cases('2026-12-21')).map((c) => (c.detail as { accountId: string }).accountId).sort()).toEqual(
      [people.yesterday, people.today, people.emailOnly].sort(),
    );
  });
});

// =============================================================================
// 6. The seams
// =============================================================================

describe('6. the seams — the endpoint and its keys stay where they belong', () => {
  function* sources(dir: string): Generator<string> {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'build', '.turbo', 'coverage'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* sources(p);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) yield p;
    }
  }
  const naming = (dirs: string[], pattern: RegExp) =>
    dirs
      .flatMap((d) => [...sources(join(ROOT, d))])
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
      .sort();

  it('no client app or package names the jobs endpoint, the jobs:run scope or OTOAPP_JOBS_KEYS', () => {
    const packages = readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/src`);
    expect(naming(['apps/pos/src', 'apps/booth/src', 'apps/console/src', 'apps/launcher/src', ...packages], /directory\/jobs|jobs:run|OTOAPP_JOBS_KEYS/)).toEqual([]);
  });

  it('inside the api only the client, the jobs service and env name them; only the two repositories name otoapp_v', () => {
    expect(naming(['apps/api/src'], /directory\/jobs|OTOAPP_JOBS_KEYS/)).toEqual([
      'apps/api/src/env.ts',
      'apps/api/src/services/otoapp-directory.ts',
      'apps/api/src/services/otoapp-jobs.ts',
    ]);
    expect(naming(['apps/api/src'], /otoapp_v/)).toEqual([
      'apps/api/src/services/otoapp-employees.ts',
      'apps/api/src/services/otoapp-events.ts',
    ]);
  });

  it('a key travels only in the Authorization header: never in the body, never in a log line, never in a run record', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const logged: unknown[] = [];
    const log = {
      warn: (...args: unknown[]) => logged.push(args),
      error: (...args: unknown[]) => logged.push(args),
      info: (...args: unknown[]) => logged.push(args),
      debug: (...args: unknown[]) => logged.push(args),
    } as unknown as FastifyBaseLogger;
    const failing = buildOtoAppJobsClient(
      { OTOAPP_DIRECTORY_URL: 'http://127.0.0.1:9', OTOAPP_JOBS_KEYS: `${tenantA}:${keyA}`, OTOAPP_JOBS_TIMEOUT_MS: 1000 },
      log,
      (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), init: init ?? {} });
        throw new Error(`connect ECONNREFUSED (Bearer ${keyA})`);
      }) as typeof fetch,
    );
    const res = await failing.run('presence', tenantA);
    expect(res).toMatchObject({ ok: false, code: DIRECTORY_UNREACHABLE });
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${keyA}`);
    expect(String(sent[0]!.init.body)).not.toContain(keyA.slice(4));
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(keyA.slice(4));

    const records = await db
      .select({ detail: opsRun.detail, errorMessage: opsRun.errorMessage })
      .from(opsRun)
      .where(inArray(opsRun.name, [OTOAPP_MIDNIGHT_JOB, OTOAPP_RECONCILE_JOB, OTOAPP_PRESENCE_JOB, OTOAPP_DEPARTED_ACCOUNT_RUN]));
    expect(records.length).toBeGreaterThan(5);
    const all = JSON.stringify(records);
    for (const k of [keyA, keyB]) expect(all).not.toContain(k.slice(4));
  });

  it('Run now replayed with its idempotency key runs once and is audited once', async () => {
    stub.reset();
    const before = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ops.test_control'), sql`${auditLog.after} ->> 'control' = 'otoapp.presence'`));
    const idem = newId();
    const press = () =>
      ctx.app.inject({ method: 'POST', url: '/ops/test-controls/otoapp.presence', headers: { cookie: admin, 'idempotency-key': idem } });
    const first = await press();
    const second = await press();
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(stub.callsFor('presence', tenantA)).toHaveLength(1);
    const after = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ops.test_control'), sql`${auditLog.after} ->> 'control' = 'otoapp.presence'`));
    expect(after.length - before.length).toBe(1);
  });
});

// =============================================================================
// 8. "Already running" at every tick
// =============================================================================

describe('8. a park group the app answers "already running" at every tick of a date', () => {
  /**
   * FINDING (LOW-MEDIUM, apps/api/src/services/otoapp-jobs.ts:265-268 — a 409
   * `job_running` is `locked`, ok:false but not failed, and the run records
   * ok). The app's lock is held only by a batch in flight; under `platform`
   * the only other caller is a platform call that timed out — or a batch that
   * hangs (a row lock, an unreturned query), which holds the app's session
   * lock indefinitely. Then every tick of the date answers `locked`, every run
   * is green (`lastOkAt` refreshed every five minutes, so `ops.missing` never
   * fires and `ops.failing` never counts), and the night is never done:
   * nothing on Failures, nothing on the watchdog — H7's silence.
   * FIX: a park group still `locked` at a second tick for the same date (or at
   * the date's last tick) fails the run with OTOAPP_JOB_RUNNING, so Failures
   * and `ops.failing` see it; the first, transient `locked` can stay green.
   */
  it.fails('FINDING: locked at 00:06, 06:00, 12:00, 18:00 and 23:59 — some run of the date fails', async () => {
    stub.reset();
    const date = '2026-12-12';
    const env = envFor([[tenantA, keyA]]);
    stub.reply = () => ({ kind: 'answer', status: 409, body: { error: 'job_running', message: "This park group's batch is already running, so it was not started a second time." } });
    for (const time of ['00:06', '06:00', '12:00', '18:00', '23:59']) {
      const job = nightJob('midnight', () => at(date, time), env);
      await runnerFor(job, env).runJob(job.name, { force: true });
    }
    const runs = await runsFor(OTOAPP_MIDNIGHT_JOB, date);
    expect(runs).toHaveLength(5);
    expect([...(await nightGroupsDone(db, OTOAPP_MIDNIGHT_JOB, date))]).toEqual([]);
    expect(runs.some((r) => r.outcome === 'failed')).toBe(true);
  });
});

// =============================================================================
// J. The real app
// =============================================================================

const children: ChildProcess[] = [];

const HARNESS_ENV = {
  NODE_ENV: 'test',
  APP_ENV: 'dev',
  STORAGE_ENV_PREFIX: 'zz-r3rev',
  OBJECT_STORAGE: 'local',
  OTOAPP_LEGACY_LOGIN: 'true',
  LOG_LEVEL: 'warn',
  DEPLOY_ENV: 'local',
  // The app keeps naive UTC timestamps and computes Bangkok midnight by hand;
  // Render runs it in UTC.
  TZ: 'UTC',
};

const tsxCli = () => join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs');

async function serve(env: Record<string, string>): Promise<string> {
  const child = spawn(process.execPath, [tsxCli(), 'tests/harness/serve-routes.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}:\n${output}`));
    });
  });
}

/** Run a script in the app's own module graph (tsx), and wait for it to finish. */
async function inApp(code: string, env: Record<string, string>): Promise<string> {
  const child = spawn(process.execPath, [tsxCli(), '--input-type=module', '-e', code], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (c: Buffer) => (output += c.toString('utf8')));
  child.stderr!.on('data', (c: Buffer) => (output += c.toString('utf8')));
  const code_ = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  if (code_ !== 0) throw new Error(`app script exited ${code_}:\n${output}`);
  return output;
}

type Answer = { status: number; body: Record<string, unknown> & Partial<NightJobAnswer> };

describe.skipIf(!HAS_APP_RUNTIME)('J. the real app', () => {
  let origin = { platform: '', inprocess: '' };

  const post = async (base: string, name: string, k: string | null, body: unknown = {}): Promise<Answer> => {
    const res = await fetch(`${base}/api/directory/jobs/${name}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Answer['body'] };
  };

  const stepOf = (a: Answer, step: string) => {
    const found = a.body.steps?.find((s) => s.step === step);
    if (!found) throw new Error(`no step ${step} in ${JSON.stringify(a.body)}`);
    return found;
  };

  /** A refusal for one table and one park group, made for one check and dropped after it. */
  async function refusing<T>(name: string, table: string, when: string, fn: () => Promise<T>, timing = 'before update'): Promise<T> {
    await q(`create or replace function zz_rev_refuse_${name}() returns trigger language plpgsql as $$
             begin raise exception 'zz review: ${name} refused'; end $$`);
    await q(`create trigger zz_rev_refuse_${name} ${timing} on ${table} for each row when (${when}) execute function zz_rev_refuse_${name}()`);
    try {
      return await fn();
    } finally {
      await q(`drop trigger zz_rev_refuse_${name} on ${table}`);
      await q(`drop function zz_rev_refuse_${name}()`);
    }
  }

  beforeAll(async () => {
    const [platform, inprocess] = await Promise.all([
      serve({ OTOAPP_JOBS: 'platform', DATABASE_URL: dbUrl }),
      serve({ OTOAPP_JOBS: 'inprocess', DATABASE_URL: dbUrl }),
    ]);
    origin = { platform, inprocess };
  }, 300_000);

  // ---------------------------------------------------------------------------
  // J1. Tenant isolation over HTTP
  // ---------------------------------------------------------------------------

  describe('J1. a key bound to one park group never runs another\'s batch', () => {
    const g = { P: '', Q: '', branchP: '', branchQ: '', clockedP: '', clockedQ: '', keyQ: '' };

    beforeAll(async () => {
      g.P = await appTenant('p');
      g.Q = await appTenant('q');
      g.branchP = await appBranch(g.P);
      g.branchQ = await appBranch(g.Q);
      g.clockedP = await appEmployee(g.P, g.branchP);
      g.clockedQ = await appEmployee(g.Q, g.branchQ);
      await staleClockIn(g.P, g.branchP, g.clockedP);
      await staleClockIn(g.Q, g.branchQ, g.clockedQ);
      g.keyQ = await directoryKey(g.Q, ['jobs:run']);
    });

    it("OTOAPP_JOBS_KEYS pairing P with Q's key: the platform's run fails in the app's words, and neither park group is touched", async () => {
      const env = envFor([[g.P, g.keyQ]], { OTOAPP_DIRECTORY_URL: origin.platform });
      const date = bangkokDays().today;
      const job = nightJob('midnight', () => at(date, '12:00'), env);
      expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('failed');
      const [run] = (await runsFor(job.name, date)).filter((r) => detailOf(r).groups?.some((x) => x.tenantId === g.P));
      expect(run!.errorCode).toBe('OTOAPP_PARK_GROUP_NOT_FOUND');
      expect([await outsOf(g.clockedP), await outsOf(g.clockedQ)]).toEqual([0, 0]);
    });

    it("Q's key naming P: 404; revoked or inactive keys of Q: 403; none of them runs anything", async () => {
      expect(await post(origin.platform, 'midnight', g.keyQ, { tenantId: g.P })).toEqual({
        status: 404,
        body: { error: 'park_group_not_found', message: 'Park group not found' },
      });
      for (const state of ['revoked', 'inactive'] as const) {
        const k = await directoryKey(g.Q, ['jobs:run'], state);
        expect((await post(origin.platform, 'midnight', k, { tenantId: g.Q })).status, state).toBe(403);
      }
      expect([await outsOf(g.clockedP), await outsOf(g.clockedQ)]).toEqual([0, 0]);
    });

    it("Q's key with no park group named (or Q named in capitals) runs Q's batch and only Q's", async () => {
      const ran = await post(origin.platform, 'midnight', g.keyQ);
      expect(ran.status, JSON.stringify(ran.body)).toBe(200);
      expect(ran.body.tenantId).toBe(g.Q);
      expect([await outsOf(g.clockedP), await outsOf(g.clockedQ)]).toEqual([0, 1]);
      const upper = await post(origin.platform, 'midnight', g.keyQ, { tenantId: g.Q.toUpperCase() });
      expect(upper.status, JSON.stringify(upper.body)).toBe(200);
      expect([await outsOf(g.clockedP), await outsOf(g.clockedQ)]).toEqual([0, 1]);
    });
  });

  // ---------------------------------------------------------------------------
  // J2. Every catching step answers its error as a failed step
  // ---------------------------------------------------------------------------

  describe('J2. the swallowed-error promise, step by step', () => {
    const w = { tenant: '', branch: '', key: '' };

    beforeAll(async () => {
      w.tenant = await appTenant('w');
      w.branch = await appBranch(w.tenant);
      w.key = await directoryKey(w.tenant, ['jobs:run']);
    });

    const expectFailedStep = (a: Answer, step: string, all: string[]) => {
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.ok).toBe(false);
      const failed = stepOf(a, step);
      expect(failed).toMatchObject({ ok: false, onFailure: 'continue' });
      expect(String(failed.error)).toContain(`zz review: ${step} refused`);
      // The app's batch carried on past it, as in-process: every other step ran and finished.
      for (const other of all.filter((s) => s !== step)) {
        expect(stepOf(a, other), other).toMatchObject({ ok: true });
        expect(stepOf(a, other).skipped, other).toBeUndefined();
      }
    };

    const MIDNIGHT = ['autoCheckout', 'autoClockOut', 'taskGeneration'];
    const RECONCILE = ['presenceReconciliation', 'statusTransitions', 'departedLogins', 'availabilityCleanup'];

    it('taskGeneration', async () => {
      await q(`insert into tasks (tenant_id, branch_id, title, recurrence, is_recurring_definition) values ($1, $2, 'ZZ r3rev daily', 'daily', true)`, [
        w.tenant,
        w.branch,
      ]);
      const a = await refusing('taskGeneration', 'tasks', `new.tenant_id = '${w.tenant}'`, () => post(origin.platform, 'midnight', w.key), 'before insert');
      expectFailedStep(a, 'taskGeneration', MIDNIGHT);
    });

    it('autoCheckout', async () => {
      await q(
        `insert into service_checkins (tenant_id, branch_id, status, parent_full_name, whatsapp_phone_raw, child_full_name, checked_in_at)
         values ($1, $2, 'in_park', 'ZZ r3rev parent', '+66000000000', 'ZZ r3rev child', ${LONG_AGO})`,
        [w.tenant, w.branch],
      );
      const a = await refusing('autoCheckout', 'service_checkins', `old.tenant_id = '${w.tenant}'`, () => post(origin.platform, 'midnight', w.key));
      expectFailedStep(a, 'autoCheckout', MIDNIGHT);
    });

    it('presenceReconciliation (the six-hourly check)', async () => {
      const e = await appEmployee(w.tenant, w.branch);
      await q(`insert into employee_presence (employee_id, tenant_id, is_clocked_in, current_work_branch_id) values ($1, $2, false, $3)`, [
        e,
        w.tenant,
        w.branch,
      ]);
      const a = await refusing('presenceReconciliation', 'employee_presence', `old.tenant_id = '${w.tenant}'`, () =>
        post(origin.platform, 'presence', w.key),
      );
      expectFailedStep(a, 'presenceReconciliation', ['presenceReconciliation']);
    });

    it('statusTransitions', async () => {
      await appEmployee(w.tenant, w.branch, { employment_state: 'LEAVING', last_working_day: '2020-01-01 00:00:00' });
      const a = await refusing('statusTransitions', 'employees', `old.tenant_id = '${w.tenant}' and new.employment_state = 'LEFT'`, () =>
        post(origin.platform, 'reconcile', w.key),
      );
      expectFailedStep(a, 'statusTransitions', RECONCILE);
    });

    it('departedLogins', async () => {
      const u = await appUser();
      await appEmployee(w.tenant, w.branch, { user_id: u.id, email: u.email, last_working_day: '2020-01-01 00:00:00' });
      const a = await refusing('departedLogins', 'users', `old.id = '${u.id}'`, () => post(origin.platform, 'reconcile', w.key));
      expectFailedStep(a, 'departedLogins', RECONCILE);
    });

    it('end to end: the platform run fails naming the step; the next tick finishes the night, once', async () => {
      const t = await appTenant('w2');
      const branch = await appBranch(t);
      const k = await directoryKey(t, ['jobs:run']);
      const u = await appUser();
      await appEmployee(t, branch, { user_id: u.id, email: u.email, last_working_day: '2020-01-01 00:00:00' });
      const env = envFor([[t, k]], { OTOAPP_DIRECTORY_URL: origin.platform });
      const { today } = bangkokDays();
      let clock = at(today, '12:00');
      const job = nightJob('reconcile', () => clock, env);
      const runner = runnerFor(job, env);

      await refusing('departedLogins', 'users', `old.id = '${u.id}'`, async () => {
        expect(await runner.runJob(job.name, { force: true })).toBe('failed');
      });
      const failed = (await runsFor(job.name, today)).find((r) => detailOf(r).groups?.some((x) => x.tenantId === t))!;
      expect(failed.errorCode).toBe(NIGHT_STEP_FAILED);
      expect(failed.errorMessage).toContain(`park group ${t}: departedLogins failed (the batch carried on): zz review: departedLogins refused`);
      expect((await q<{ a: boolean }>('select is_active as a from users where id = $1', [u.id]))[0]!.a).toBe(true);

      clock = at(today, '12:05');
      expect(await runner.runJob(job.name, { force: true })).toBe('ok');
      clock = at(today, '12:10');
      expect(await runner.runJob(job.name, { force: true })).toBe('ok');
      expect((await q<{ a: boolean }>('select is_active as a from users where id = $1', [u.id]))[0]!.a).toBe(false);
      expect(await successesFor(job.name, today, t)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // J3. Q4 against the app's own rule
  // ---------------------------------------------------------------------------

  describe("J3. Q4 — the platform lists exactly the active accounts of the logins the app's 03:00 batch switches off", () => {
    it('the same night, the same people: yesterday\'s leavers in, today\'s out, an inactive account never listed', async () => {
      const x = await appTenant('x');
      const branch = await appBranch(x, chalong);
      const k = await directoryKey(x, ['jobs:run']);
      const { today, yesterday } = bangkokDays();
      const person = async (lastWorkingDay: string | null, status: 'active' | 'inactive' = 'active') => {
        const acct = await platformAccount(oto, status);
        const user = await appUser({ platformUserId: acct });
        await appEmployee(x, branch, { user_id: user.id, email: user.email, last_working_day: lastWorkingDay });
        return { acct, user: user.id };
      };
      const gone = await person(`${yesterday} 00:00:00`);
      const lastDayToday = await person(`${today} 00:00:00`);
      const goneSwitchedOff = await person(`${yesterday} 00:00:00`, 'inactive');
      const staying = await person(null);

      const env = envFor([[x, k]], { OTOAPP_DIRECTORY_URL: origin.platform });
      const job = nightJob('reconcile', () => at(today, '12:00'), env);
      expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');

      const appActive = async (id: string) => (await q<{ a: boolean }>('select is_active as a from users where id = $1', [id]))[0]!.a;
      // The app's own rule, as its batch just applied it.
      expect({
        gone: await appActive(gone.user),
        lastDayToday: await appActive(lastDayToday.user),
        goneSwitchedOff: await appActive(goneSwitchedOff.user),
        staying: await appActive(staying.user),
      }).toEqual({ gone: false, lastDayToday: true, goneSwitchedOff: false, staying: true });

      const run = (await runsFor(job.name, today)).find((r) => detailOf(r).groups?.some((g) => g.tenantId === x))!;
      const group = detailOf(run).groups.find((g) => g.tenantId === x)!;
      expect(group).toMatchObject({ outcome: 'ran', ok: true });
      expect(group.departedAccounts!.accountIds).toEqual([gone.acct]);
      // And never switched off by the platform.
      const statuses = await db
        .select({ id: account.id, status: account.status })
        .from(account)
        .where(inArray(account.id, [gone.acct, lastDayToday.acct, goneSwitchedOff.acct, staying.acct]));
      expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({
        [gone.acct]: 'active',
        [lastDayToday.acct]: 'active',
        [goneSwitchedOff.acct]: 'inactive',
        [staying.acct]: 'active',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // J4. The second batch of one date, against the app's task generation
  // ---------------------------------------------------------------------------

  describe('J4. a second midnight batch for one Bangkok date (a retry, a timed-out call, the switch day)', () => {
    const t = { tenant: '', early: '', late: '' };
    /** Instances of each definition after the first batch, then after the second. */
    const after = { early: [] as number[], late: [] as number[] };

    const instances = async (definition: string) =>
      Number((await q<{ n: string }>('select count(*) as n from tasks where parent_task_id = $1', [definition]))[0]!.n);

    beforeAll(async () => {
      t.tenant = await appTenant('t');
      const branch = await appBranch(t.tenant);
      const k = await directoryKey(t.tenant, ['jobs:run']);
      const def = async (time: string) =>
        (
          await q<{ id: string }>(
            `insert into tasks (tenant_id, branch_id, title, recurrence, is_recurring_definition, preferred_due_time)
             values ($1, $2, $3, 'daily', true, $4) returning id`,
            [t.tenant, branch, `ZZ r3rev daily at ${time}`, time],
          )
        )[0]!.id;
      t.early = await def('06:30');
      t.late = await def('18:00');
      for (let i = 0; i < 2; i += 1) {
        const a = await post(origin.platform, 'midnight', k);
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(a.body.ok, JSON.stringify(a.body)).toBe(true);
        after.early.push(await instances(t.early));
        after.late.push(await instances(t.late));
      }
    }, 120_000);

    it('a recurring task due at 18:00 is made by the first batch and not again by the second', () => {
      expect(after.late).toEqual([1, 1]);
    });

    /**
     * FINDING F2 (MEDIUM, data reliability — apps/oto-app/server/core/taskGeneration.ts:72-82,
     * reached from scheduled-jobs.ts:353). The "already made today?" check
     * looks for an instance due inside `startOfDay(thailandNow)`..`endOfDay`,
     * computed on a Date shifted +7 h in a UTC process: 07:00 to 06:59 Bangkok.
     * An instance due BEFORE 07:00 Bangkok (`${date}T06:30:00+07:00`, stored
     * as the previous UTC day) is never found, so every second midnight batch
     * of one date makes it again. In-process the batch ran once a day and this
     * never showed; round 3's own design runs it again — a failed park group's
     * whole batch at the next tick, a timed-out call (section 2 above), the
     * switch day (PLAN section 10 "changes nothing"), Q25's alternative — on
     * the stated ground that "every step ... is safe to repeat". The app's
     * Tasks screens offer any "Preferred time", so an opening checklist at
     * 06:30 is enough.
     * FIX (ours to make: a duplicate row is a data-reliability fault): look the
     * instance up by `parent_task_id` + `generated_for_date = dateStr` (the
     * column the insert already fills), or compute the window as the Bangkok
     * day of `dateStr` (`${dateStr}T00:00:00+07:00` + 24 h); and correct the
     * PLAN section 10 / Q25 sentences until then.
     * FIXED (the fix round): the first — the instance is looked up by
     * `parent_task_id` + `generated_for_date`. Flipped from `it.fails`.
     */
    it('F2 fixed: a recurring task due at 06:30 is made by the first batch and not again by the second', async () => {
      expect(after.early).toEqual([1, 1]);
      // Made for today's Bangkok date, due 06:30 Bangkok on it.
      const rows = await q<{ d: string }>('select generated_for_date as d from tasks where parent_task_id = $1', [t.early]);
      expect(rows.map((r) => r.d)).toEqual([bangkokDays().today]);
    });
  });

  // ---------------------------------------------------------------------------
  // J5. The manual triggers, under both switches
  // ---------------------------------------------------------------------------

  describe('J5. the two manual triggers', () => {
    it('under platform both refuse in words and write nothing; under inprocess they reach the caller\'s park group only', async () => {
      const p = await appTenant('mp');
      const r = await appTenant('mr');
      const bp = await appBranch(p);
      const br = await appBranch(r);
      const adminUser = await appUser({ role: 'admin' });
      await q(`insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')`, [p, adminUser.id]);
      const leaverP = await appUser();
      await appEmployee(p, bp, { user_id: leaverP.id, email: leaverP.email, last_working_day: '2020-01-01 00:00:00' });
      const leaverR = await appUser();
      await appEmployee(r, br, { user_id: leaverR.id, email: leaverR.email, last_working_day: '2020-01-01 00:00:00' });
      const leavingP = await appEmployee(p, bp, { employment_state: 'LEAVING', last_working_day: '2020-01-01 00:00:00' });
      const leavingR = await appEmployee(r, br, { employment_state: 'LEAVING', last_working_day: '2020-01-01 00:00:00' });

      const active = async (id: string) => (await q<{ a: boolean }>('select is_active as a from users where id = $1', [id]))[0]!.a;
      const stateOf = async (id: string) => (await q<{ s: string }>('select employment_state as s from employees where id = $1', [id]))[0]!.s;
      const snapshot = async () => ({
        leaverP: await active(leaverP.id),
        leaverR: await active(leaverR.id),
        leavingP: await stateOf(leavingP),
        leavingR: await stateOf(leavingR),
      });
      const signIn = async (base: string) => {
        const res = await fetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identifier: adminUser.email, password: PASSWORD }),
        });
        expect(res.status).toBe(200);
        return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      };
      const trigger = async (base: string, cookie: string, path: string) => {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const untouched = { leaverP: true, leaverR: true, leavingP: 'LEAVING', leavingR: 'LEAVING' };

      const onPlatform = await signIn(origin.platform);
      for (const path of ['/api/admin/run-departed-deactivation', '/api/scheduler/transition-left']) {
        const res = await trigger(origin.platform, onPlatform, path);
        expect(res, path).toMatchObject({ status: 409, body: { reason: 'jobs_on_platform' } });
      }
      expect(await snapshot()).toEqual(untouched);

      const inProcess = await signIn(origin.inprocess);
      expect((await trigger(origin.inprocess, inProcess, '/api/scheduler/transition-left')).status).toBe(200);
      expect((await trigger(origin.inprocess, inProcess, '/api/admin/run-departed-deactivation')).status).toBe(200);
      expect(await snapshot()).toEqual({ leaverP: false, leaverR: true, leavingP: 'LEFT', leavingR: 'LEAVING' });
    });
  });

  // ---------------------------------------------------------------------------
  // J6 (LAST: it runs the in-process 00:01 batch for every park group in this
  // database). A misconfigured deployment: one instance on its own timers.
  // ---------------------------------------------------------------------------

  describe('J6. an instance still on OTOAPP_JOBS=inprocess beside one serving the platform', () => {
    const m = { tenant: '', employee: '', key: '' };
    /** The endpoint's per-park-group batch lock (apps/oto-app/server/directory/jobRoutes.ts, namespace 0x0712). */
    const LOCK = (tenant: string): unknown[] => [0x0712, `otoapp_night:midnight:${tenant}`];

    beforeAll(async () => {
      m.tenant = await appTenant('m');
      const branch = await appBranch(m.tenant);
      m.employee = await appEmployee(m.tenant, branch);
      await staleClockIn(m.tenant, branch, m.employee);
      m.key = await directoryKey(m.tenant, ['jobs:run']);
    });

    it("while the platform's call holds M's batch, the endpoint refuses a second one (409)", async () => {
      const holder = await appPool.connect();
      try {
        await holder.query('select pg_advisory_lock($1::int4, hashtext($2))', LOCK(m.tenant));
        const res = await post(origin.platform, 'midnight', m.key);
        expect(res).toMatchObject({ status: 409, body: { error: 'job_running' } });
        expect(await outsOf(m.employee)).toBe(0);
      } finally {
        await holder.query('select pg_advisory_unlock($1::int4, hashtext($2))', LOCK(m.tenant));
        holder.release();
      }
    });

    /**
     * FINDING (LOW, apps/oto-app/server/scheduled-jobs.ts:581-583 —
     * `runNightBatchInProcess` takes no lock). The only guard against the
     * in-process timers and the platform running one batch side by side is
     * the switch read per PROCESS (`JOBS_MODE`). Two instances that disagree —
     * a rolling deploy across the flip, a second service on the same
     * database, a forgotten preview — run the 00:01 batch twice AT ONCE: both
     * read the same stale clock-ins before either writes, so each writes its
     * own OUT (H8's "one OUT per stale IN" broken), and task generation's
     * check-then-insert doubles too.
     * FIX: the in-process batch takes the endpoint's per-park-group lock
     * (`otoapp_night:<batch>:<tenant>`, namespace 0x0712) around each park
     * group's part and skips a park group whose lock it cannot take — the
     * same lock, so the two can never overlap whatever the switch says.
     */
    it.fails("FINDING: the in-process 00:01 timer stands down for M while the platform's call holds M's batch", async () => {
      const holder = await appPool.connect();
      try {
        await holder.query('select pg_advisory_lock($1::int4, hashtext($2))', LOCK(m.tenant));
        const out = await inApp(
          `await import('./server/config/env.ts');
           const realTimeout = globalThis.setTimeout;
           const timers = [];
           const capture = (fn) => { timers.push(fn); return realTimeout(() => undefined, 0).unref(); };
           globalThis.setTimeout = capture;
           globalThis.setInterval = capture;
           const { startScheduledJobs } = await import('./server/scheduled-jobs.ts');
           startScheduledJobs('inprocess');
           await timers[0]();
           console.log('ZZ_INPROCESS_MIDNIGHT_FIRED');
           process.exit(0);`,
          { OTOAPP_JOBS: 'inprocess', DATABASE_URL: dbUrl },
        );
        expect(out).toContain('ZZ_INPROCESS_MIDNIGHT_FIRED');
        expect(await outsOf(m.employee)).toBe(0);
      } finally {
        await holder.query('select pg_advisory_unlock($1::int4, hashtext($2))', LOCK(m.tenant));
        holder.release();
      }
    }, 180_000);
  });
});
