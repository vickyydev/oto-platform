import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, opsExpectation, opsLast, opsRun, type Db } from '@oto/db';
import { createTestDatabase } from '@oto/db/testing';
import { isoDateInTz, newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { loadEnv, type Env } from '../src/env';
import {
  buildDefaultJobs,
  buildOtoAppNightJobs,
  createJobRunner,
  exclusiveRunLockId,
  runWatchdog,
  type JobDefinition,
} from '../src/services/jobs';
import {
  DIRECTORY_UNREACHABLE,
  NIGHT_JOB_RUNNING,
  buildOtoAppJobsClient,
  parseOtoAppJobKeys,
  type NightJobAnswer,
  type OtoAppNightJob,
} from '../src/services/otoapp-directory';
import {
  DEPARTED_ACCOUNT_CASE,
  FORCED_FAILURE_CODE,
  NIGHT_JOB_UNKEYED,
  NIGHT_STEP_FAILED,
  OTOAPP_DEPARTED_ACCOUNT_RUN,
  OTOAPP_MIDNIGHT_JOB,
  OTOAPP_PRESENCE_JOB,
  OTOAPP_RECONCILE_JOB,
  nightGroupsDone,
  type NightJobSummary,
} from '../src/services/otoapp-jobs';

/**
 * S2-17b round 3 (SCRUM-193 under SCRUM-191) — THE OTO APP'S NIGHT WORK ON THE
 * PLATFORM'S RUNNER, proved (docs/progress/plans/otoapp-lift/PLAN.md section 5
 * "The app's jobs on the platform runner", section 8 round 3; hazards H7-H9,
 * question Q4).
 *
 *  A. The three jobs are registered as the registry registers every job:
 *     their intervals, `exclusive`, the expectations written at
 *     registration, and their place on Health.
 *  B. A deployment with no OTO App night work configured runs each as a no-op
 *     that says so, and calls nothing.
 *  C. Once per Bangkok date: before the hour nothing is due; past it, each
 *     park group's batch runs at the first tick; every later tick that day
 *     finds it done and runs nothing (H8: two batches for one date, one
 *     success). The six-hourly check has no date and runs every time.
 *  D. H8, two invocations at once: one runs and one is `locked` — the
 *     runner's exclusive run lock, held from before the run until after its
 *     record — and the app is called once.
 *  E. H9, the app down: the first invocation fails, naming the park group;
 *     the next tick runs it; the date is done once. A park group that failed
 *     beside one that finished is the only one run again.
 *  F. Every swallowed error is a failed step: the run fails, its error names
 *     the park group, the step, what the app's batch did next and the words,
 *     and its detail keeps every step. The app's refusals (inprocess, wrong
 *     scope, another park group) fail the run in their own codes; the app
 *     already running that park group's batch is `locked`, not failed.
 *  G. Q4 — the platform's 03:00 run lists each leaver whose platform account
 *     is still active on Failures, as the employee copy raises its cases;
 *     never an inactive account, another operator's, or someone still working.
 *  H. The Console: Run now for each job, for the platform administrator only;
 *     a forced failure lands on Failures and its Retry succeeds; a run that
 *     stops raises the watchdog's missing-run alert (H7).
 *  I. OTOAPP_JOBS_KEYS: read, refused when malformed without the key ever in
 *     the message, and empty in a test unless a test passes one.
 *  K. The review's F1 (the fix round): a park group the app holds staff in
 *     with no key here fails every run naming it (OTOAPP_NIGHT_JOB_UNKEYED),
 *     while the keyed park groups still run and are done once; with its key
 *     it runs; a deployment holding no key at all is still the no-op.
 *  J. The real app (when its node_modules are present): its night-job
 *     endpoint over HTTP — the scope refusals, the inprocess refusal, the
 *     platform's midnight job against it writing ONE clock-out per stale
 *     clock-in across runs, the app down and back (H9), no timers under
 *     `platform`, the manual triggers' two answers, the review's F2 (a second
 *     batch of one date makes no second task instance, due at 06:30 or 18:00)
 *     and F4 (the in-process batch stands down for a park group the
 *     endpoint's lock holds) — and the app's own check
 *     (apps/oto-app/tests/night-jobs.check.ts) against a fresh database.
 *
 *  The review's F3 is in F: "already running" again at a later tick fails.
 *  From K on, the app holds staff in park groups a run's key list leaves out,
 *  so such a run fails for those park groups alone (F1) — read so in J.
 *
 * Sections A to I run against a stand-in app: a small HTTP server here that
 * answers the endpoint exactly as the app's lib/nightJobs.ts shapes it, and
 * can be told to fail, hang, refuse or drop the connection.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);

const BANGKOK = 'Asia/Bangkok';
const at = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);

let ctx: TestContext;
let db: Db;
let appPool: pg.Pool;
let admin: string;
let oto: string;
let second: string;
let central: string;

const key = () => `odk_${randomBytes(32).toString('base64url')}`;
/** Park group A, mapped to OTO's Central, and B. The stand-in answers both. */
const tenantA = newId();
const tenantB = newId();
const keyA = key();
const keyB = key();

// =============================================================================
// The stand-in app
// =============================================================================

interface StubCall {
  job: string;
  tenantId: string;
  auth: string | null;
}

type StubReply =
  | { kind: 'answer'; status: number; body: unknown }
  | { kind: 'drop' }
  | { kind: 'hold'; until: Promise<void>; then: StubReply };

const STEPS: Record<OtoAppNightJob, Array<{ step: string; onFailure: 'continue' | 'stop'; counts: Record<string, number> }>> = {
  midnight: [
    { step: 'autoCheckout', onFailure: 'continue', counts: { checkedOut: 0 } },
    { step: 'autoClockOut', onFailure: 'continue', counts: { autoClockedOut: 2 } },
    { step: 'taskGeneration', onFailure: 'continue', counts: { generated: 1 } },
  ],
  reconcile: [
    { step: 'presenceReconciliation', onFailure: 'continue', counts: { stuckClockIns: 0, presenceMismatches: 0, repairs: 0, anomalies: 0 } },
    { step: 'statusTransitions', onFailure: 'continue', counts: { transitioned: 1 } },
    { step: 'departedLogins', onFailure: 'continue', counts: { deactivated: 1 } },
    { step: 'availabilityCleanup', onFailure: 'stop', counts: { deleted: 0 } },
  ],
  presence: [
    { step: 'presenceReconciliation', onFailure: 'continue', counts: { stuckClockIns: 0, presenceMismatches: 1, repairs: 1, anomalies: 0 } },
  ],
  // Round 4b's two Attention batches, which the stand-in answers on the same terms.
  attention: [{ step: 'attentionReconciliation', onFailure: 'continue', counts: { created: 0, updated: 0, resolved: 0, errors: 0 } }],
  no_show: [{ step: 'noShowCheck', onFailure: 'continue', counts: { created: 0, resolved: 0, outsideHours: 0 } }],
};

/** The app's answer to one park group's batch, every step ok unless told otherwise. */
function answer(
  job: OtoAppNightJob,
  tenantId: string,
  failed: Record<string, string> = {},
): NightJobAnswer {
  const steps = STEPS[job].map((s) =>
    failed[s.step] ? { ...s, ok: false, error: failed[s.step] } : { ...s, ok: true },
  );
  const now = new Date().toISOString();
  return { job, tenantId, ok: steps.every((s) => s.ok), startedAt: now, finishedAt: now, steps };
}

const KEYS: Record<string, string> = {};

class StubApp {
  calls: StubCall[] = [];
  /** What the next calls get; by default, the app's own ok answer. */
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
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !m) return send(404, { error: 'not_found', message: 'Not found' });
    const body = (raw ? JSON.parse(raw) : {}) as { tenantId?: string };
    const auth = req.headers.authorization ?? null;
    const tenantId = body.tenantId ?? '';
    // The real app's key check: the key names the park group.
    if (auth !== `Bearer ${KEYS[tenantId]}`) {
      return send(403, { error: 'Invalid directory key', message: 'The key is not one this app issued, or it has been revoked' });
    }
    const call: StubCall = { job: m[1]!, tenantId, auth };
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

/** One of the three jobs, against the stand-in, at a clock of the test's choosing. */
function nightJob(name: OtoAppNightJob, clock: () => Date, env: Env = envFor([[tenantA, keyA], [tenantB, keyB]])): JobDefinition {
  const jobs = buildOtoAppNightJobs({ env, log: ctx.app.log }, { clock });
  const job = jobs.find((j) => j.name === `job:otoapp.${name}`);
  if (!job) throw new Error(`no ${name} job`);
  return job;
}

const runnerFor = (job: JobDefinition, env: Env = envFor([[tenantA, keyA], [tenantB, keyB]])) =>
  createJobRunner({ db, env, log: ctx.app.log, channels: [], jobs: [job] });

/** The runs of one job whose detail names a date, newest first. */
const runsFor = async (job: string, date?: string) =>
  db
    .select()
    .from(opsRun)
    .where(
      and(
        eq(opsRun.name, job),
        eq(opsRun.kind, 'job'),
        date ? sql`${opsRun.detail} ->> 'date' = ${date}` : undefined,
      ),
    )
    .orderBy(desc(opsRun.startedAt));

const detailOf = (run: { detail: unknown }) => run.detail as NightJobSummary;

/** How many runs recorded a park group's batch as RUN (not "already done") for a date. */
const successesFor = async (job: string, date: string, tenantId: string) =>
  (await runsFor(job, date)).filter((r) =>
    detailOf(r).groups?.some((g) => g.tenantId === tenantId && g.outcome === 'ran' && g.ok),
  ).length;

/** The newest run of a job for a date that names a park group, and that park group's part in it. */
async function latestFor(job: string, date: string, tenantId: string) {
  const run = (await runsFor(job, date)).find((r) => detailOf(r).groups?.some((g) => g.tenantId === tenantId));
  if (!run) throw new Error(`no ${job} run for ${date} names ${tenantId}`);
  return { run, group: detailOf(run).groups.find((g) => g.tenantId === tenantId)! };
}

/** Review F1, as J meets it: the run failed for park groups it holds no key for, and for nothing else. */
function failedOnlyUnkeyed(run: { outcome: string; errorCode: string | null; detail: unknown }): void {
  expect(run.outcome).toBe('failed');
  expect(run.errorCode).toBe(NIGHT_JOB_UNKEYED);
  const failed = detailOf(run).groups.filter((g) => g.outcome === 'failed');
  expect(failed.length).toBeGreaterThan(0);
  for (const g of failed) expect(g.code, g.tenantId).toBe(NIGHT_JOB_UNKEYED);
}

// =============================================================================
// The app's rows (park group A, for Q4)
// =============================================================================

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await appPool.query<T>(text, params)).rows;

const scrypt = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

let appCentral = '';
let phoneSeq = 0;

async function platformAccount(operatorId: string, status: 'active' | 'inactive' = 'active'): Promise<string> {
  const id = newId();
  await db.insert(account).values({
    id,
    operatorId,
    phone: `+669000083${String(10 + phoneSeq++).padStart(2, '0')}`,
    passwordHash: null,
    phoneVerifiedAt: new Date(),
    status,
  });
  return id;
}

/** An app employee in park group A with their own login, linked to a platform account. */
async function appPerson(opts: { platformUserId: string; lastWorkingDay: string | null; label: string }) {
  const user = newId();
  const email = `zz-r3-${opts.label}-${user.slice(-6)}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, 'staff', $5, false, $6)`,
    [user, email, scrypt('zz-r3'), `ZZ r3 ${opts.label}`, opts.lastWorkingDay === null, opts.platformUserId],
  );
  const employee = newId();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, user_id, last_working_day)
     values ($1, $2, $3, $4, 'ZZ', $5, $6, $7)`,
    [employee, tenantA, appCentral, `ZZ r3 ${opts.label}`, email, user, opts.lastWorkingDay],
  );
  return { user, employee };
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
  second = await operatorIdByName(db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(db, CENTRAL_BRANCH_CODE);
  const dbUrl = (db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=otoapp', max: 4 });
  for (const [id, label] of [
    [tenantA, 'a'],
    [tenantB, 'b'],
  ] as const) {
    await q(`insert into tenants (id, name, slug) values ($1, $2, $3)`, [id, `ZZ r3 ${label}`, `zz-r3-${label}-${id.slice(-6)}`]);
  }
  appCentral = newId();
  await q(`insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, 'ZZ r3 Central', 'ZZ r3', $3)`, [
    appCentral,
    tenantA,
    central,
  ]);
}, 240_000);

afterAll(async () => {
  for (const child of children) child.kill();
  await appPool?.end();
  await ctx?.close();
  await stub.close();
  await teardownAll();
});

// =============================================================================
// A. Registered as every job is
// =============================================================================

describe('A. the three jobs, registered as the registry registers every job', () => {
  it('midnight and reconcile tick every five minutes, presence every six hours, all exclusive, each with its expectation', async () => {
    const env = envFor([]);
    const all = buildDefaultJobs({ db, env, log: ctx.app.log, channels: [] });
    // Round 3's three; round 4b's two Attention jobs are s217b-r4b.test.ts's.
    const ours = all.filter((j) => [OTOAPP_MIDNIGHT_JOB, OTOAPP_RECONCILE_JOB, OTOAPP_PRESENCE_JOB].includes(j.name));
    expect(ours.map((j) => [j.name, j.intervalSeconds, j.exclusive])).toEqual([
      [OTOAPP_MIDNIGHT_JOB, 300, true],
      [OTOAPP_RECONCILE_JOB, 300, true],
      [OTOAPP_PRESENCE_JOB, 21_600, true],
    ]);
    for (const j of ours) expect(j.description).toMatch(/^Runs the OTO App's /);
    const runner = createJobRunner({ db, env, log: ctx.app.log, channels: [], jobs: ours });
    await runner.start();
    await runner.stop();
    const expectations = await db.select().from(opsExpectation);
    for (const j of ours) {
      expect(expectations.find((e) => e.name === j.name), j.name).toMatchObject({
        kind: 'job',
        intervalSeconds: j.intervalSeconds,
        enabled: true,
        description: j.description,
      });
    }
    const health = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: admin } });
    expect(health.statusCode, health.body).toBe(200);
    const names = (health.json() as { jobs: Array<{ name: string; lastRunAt: string | null; lastOutcome: string | null }> }).jobs;
    for (const j of ours) {
      const row = names.find((n) => n.name === j.name);
      expect(row, j.name).toBeTruthy();
      // start() ran each once (a no-op here): Health shows when.
      expect(row!.lastOutcome).toBe('ok');
      expect(row!.lastRunAt).not.toBeNull();
    }
  });
});

// =============================================================================
// B. No OTO App configured: a no-op that says so
// =============================================================================

describe('B. a deployment with no OTO App night work runs each job as a no-op that says so', () => {
  it('no keys: ok, configured false, a reason naming the variables, and nothing called', async () => {
    stub.reset();
    const env = envFor([]);
    for (const name of ['midnight', 'reconcile', 'presence'] as const) {
      const job = nightJob(name, () => at('2026-11-01', '12:00'), env);
      expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
      const [run] = await runsFor(job.name);
      expect(detailOf(run!)).toMatchObject({ configured: false, due: false, groups: [], failed: 0 });
      expect(detailOf(run!).reason).toMatch(/OTOAPP_DIRECTORY_URL or OTOAPP_JOBS_KEYS/);
    }
    expect(stub.calls).toEqual([]);
  });

  it('a URL with no keys, or keys with no URL, is the same no-op', () => {
    const noUrl = buildOtoAppJobsClient({ OTOAPP_DIRECTORY_URL: '', OTOAPP_JOBS_KEYS: `${tenantA}:${keyA}`, OTOAPP_JOBS_TIMEOUT_MS: 5000 });
    const noKeys = buildOtoAppJobsClient({ OTOAPP_DIRECTORY_URL: stub.origin, OTOAPP_JOBS_KEYS: '', OTOAPP_JOBS_TIMEOUT_MS: 5000 });
    expect([noUrl.configured, noUrl.tenantIds]).toEqual([false, []]);
    expect([noKeys.configured, noKeys.tenantIds]).toEqual([false, []]);
  });
});

// =============================================================================
// C. Once per Bangkok date
// =============================================================================

describe('C. once per Bangkok date (H8: two batches for one date, one success)', () => {
  it('the midnight batch: not due at 00:00, run for each park group at the first tick past 00:01, done for every later tick', async () => {
    stub.reset();
    const date = '2026-11-02';
    let clock = at(date, '00:00');
    const job = nightJob('midnight', () => clock);
    const runner = runnerFor(job);

    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, date))[0]!)).toMatchObject({ date, due: false, reason: 'Not due before 00:01 Bangkok time.' });
    expect(stub.calls).toEqual([]);

    clock = at(date, '00:06');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    const first = detailOf((await runsFor(job.name, date))[0]!);
    expect(first).toMatchObject({ configured: true, date, due: true, failed: 0 });
    expect(first.groups.map((g) => [g.tenantId, g.outcome, g.ok])).toEqual([
      [tenantA, 'ran', true],
      [tenantB, 'ran', true],
    ]);
    // The app's steps, kept on the run.
    expect(first.groups[0]!.steps!.map((s) => s.step)).toEqual(['autoCheckout', 'autoClockOut', 'taskGeneration']);
    expect(stub.callsFor('midnight').map((c) => c.tenantId)).toEqual([tenantA, tenantB]);

    // Two more ticks the same day, one at 23:59: nothing runs again.
    clock = at(date, '00:11');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    clock = at(date, '23:59');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('midnight')).toHaveLength(2);
    expect(detailOf((await runsFor(job.name, date))[0]!).groups.map((g) => g.outcome)).toEqual(['done', 'done']);
    expect(await successesFor(job.name, date, tenantA)).toBe(1);
    expect(await successesFor(job.name, date, tenantB)).toBe(1);

    // The next Bangkok date is a new night.
    clock = at('2026-11-03', '00:02');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('midnight')).toHaveLength(4);
  });

  it('the 03:00 batch: not due at 02:59, run at 03:00, done after', async () => {
    stub.reset();
    const date = '2026-11-04';
    let clock = at(date, '02:59');
    const job = nightJob('reconcile', () => clock);
    const runner = runnerFor(job);
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, date))[0]!).reason).toBe('Not due before 03:00 Bangkok time.');
    clock = at(date, '03:00');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    clock = at(date, '03:05');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('reconcile')).toHaveLength(2);
    expect(await successesFor(job.name, date, tenantA)).toBe(1);
  });

  it('the presence check has no date: every run calls every park group', async () => {
    stub.reset();
    const job = nightJob('presence', () => at('2026-11-05', '01:00'));
    const runner = runnerFor(job);
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('presence')).toHaveLength(4);
    expect(detailOf((await runsFor(job.name))[0]!)).toMatchObject({ date: null, due: true });
  });

  it('the schedule itself: a tick inside the interval is not due, so the runner does not even ask', async () => {
    stub.reset();
    const job = nightJob('presence', () => at('2026-11-05', '01:00'));
    const runner = runnerFor(job);
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(await runner.runJob(job.name)).toBe('not_due');
    expect(stub.callsFor('presence')).toHaveLength(2);
  });
});

// =============================================================================
// D. H8: two invocations at once
// =============================================================================

describe('D. H8 — two invocations at once: one runs, one is locked, the app is called once', () => {
  it('two runners (two instances, or Run now beside the schedule), both forced', async () => {
    stub.reset();
    const date = '2026-11-06';
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    stub.reply = (call) => ({ kind: 'hold', until: gate, then: stub.ok(call) });
    const one = runnerFor(nightJob('midnight', () => at(date, '00:30')));
    const two = runnerFor(nightJob('midnight', () => at(date, '00:30')));

    const first = one.runJob(OTOAPP_MIDNIGHT_JOB, { force: true });
    await expect.poll(() => stub.calls.length, { timeout: 10_000 }).toBe(1);
    // The first is inside the app now; the second cannot take the run lock.
    expect(await two.runJob(OTOAPP_MIDNIGHT_JOB, { force: true })).toBe('locked');
    open();
    expect(await first).toBe('ok');
    expect(stub.callsFor('midnight', tenantA)).toHaveLength(1);
    expect(await successesFor(OTOAPP_MIDNIGHT_JOB, date, tenantA)).toBe(1);

    // And once the first has recorded, the second finds the night done.
    expect(await two.runJob(OTOAPP_MIDNIGHT_JOB, { force: true })).toBe('ok');
    expect(stub.callsFor('midnight', tenantA)).toHaveLength(1);
  });

  it('the same runner twice at once answers locked from its own guard', async () => {
    stub.reset();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    stub.reply = (call) => ({ kind: 'hold', until: gate, then: stub.ok(call) });
    const runner = runnerFor(nightJob('presence', () => at('2026-11-06', '09:00')));
    const first = runner.runJob(OTOAPP_PRESENCE_JOB, { force: true });
    await expect.poll(() => stub.calls.length, { timeout: 10_000 }).toBe(1);
    expect(await runner.runJob(OTOAPP_PRESENCE_JOB, { force: true })).toBe('locked');
    open();
    expect(await first).toBe('ok');
  });

  it('a run lock held anywhere (another instance mid-run) stands a forced run down, and nothing is recorded for it', async () => {
    stub.reset();
    const before = (await runsFor(OTOAPP_RECONCILE_JOB)).length;
    const holder = await (db as unknown as { $client: pg.Pool }).$client.connect();
    const [ns, k] = exclusiveRunLockId(OTOAPP_RECONCILE_JOB);
    try {
      await holder.query('select pg_advisory_lock($1::int4, $2::int4)', [ns, k]);
      const runner = runnerFor(nightJob('reconcile', () => at('2026-11-07', '04:00')));
      expect(await runner.runJob(OTOAPP_RECONCILE_JOB, { force: true })).toBe('locked');
    } finally {
      await holder.query('select pg_advisory_unlock($1::int4, $2::int4)', [ns, k]);
      holder.release();
    }
    expect(stub.calls).toEqual([]);
    expect(await runsFor(OTOAPP_RECONCILE_JOB)).toHaveLength(before);
  });
});

// =============================================================================
// E. H9: a night is not lost when the app is down
// =============================================================================

describe('E. H9 — the app down: the first invocation fails, the next tick runs it, the date is done once', () => {
  it('no answer, then an answer, then done', async () => {
    stub.reset();
    const date = '2026-11-08';
    const job = nightJob('midnight', () => at(date, '00:01'), envFor([[tenantA, keyA]]));
    const runner = runnerFor(job, envFor([[tenantA, keyA]]));

    stub.reply = () => ({ kind: 'drop' });
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    const [failed] = await runsFor(job.name, date);
    expect(failed).toMatchObject({ outcome: 'failed', errorCode: DIRECTORY_UNREACHABLE });
    expect(failed!.errorMessage).toContain(`park group ${tenantA}: ${DIRECTORY_UNREACHABLE}: The OTO App did not answer`);
    // The failed run says what it tried, so the next one knows the night is not done.
    expect(detailOf(failed!).groups).toEqual([
      expect.objectContaining({ tenantId: tenantA, outcome: 'failed', ok: false, code: DIRECTORY_UNREACHABLE }),
    ]);

    stub.reply = (call) => stub.ok(call);
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('midnight', tenantA)).toHaveLength(2); // the dropped one, and the one that ran
    expect(await successesFor(job.name, date, tenantA)).toBe(1);
    // ops_last carries the success Health shows, the failure before it kept.
    const [last] = await db.select().from(opsLast).where(eq(opsLast.name, job.name));
    expect(last).toMatchObject({ lastOutcome: 'ok', consecutiveFailures: 0 });
    expect(last!.lastFailedAt).not.toBeNull();
  });

  it('a park group that failed beside one that finished is the only one run again', async () => {
    stub.reset();
    const date = '2026-11-09';
    const job = nightJob('reconcile', () => at(date, '03:10'));
    const runner = runnerFor(job);
    stub.reply = (call) =>
      call.tenantId === tenantB
        ? { kind: 'answer', status: 503, body: { error: 'Service Unavailable', message: 'restarting' } }
        : stub.ok(call);
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    const [failed] = await runsFor(job.name, date);
    expect(detailOf(failed!).groups.map((g) => [g.tenantId, g.outcome])).toEqual([
      [tenantA, 'ran'],
      [tenantB, 'failed'],
    ]);
    stub.reply = (call) => stub.ok(call);
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('reconcile', tenantA)).toHaveLength(1);
    expect(stub.callsFor('reconcile', tenantB)).toHaveLength(2);
    expect(detailOf((await runsFor(job.name, date))[0]!).groups.map((g) => [g.tenantId, g.outcome])).toEqual([
      [tenantA, 'done'],
      [tenantB, 'ran'],
    ]);
    expect(await successesFor(job.name, date, tenantA)).toBe(1);
    expect(await successesFor(job.name, date, tenantB)).toBe(1);
  });
});

// =============================================================================
// F. Every swallowed error is a failed step
// =============================================================================

describe('F. every error the app swallowed is a failed step, and fails the run in words', () => {
  it('a failed step: the run fails naming the park group, the step, what the batch did next and the words; every step kept', async () => {
    stub.reset();
    const date = '2026-11-10';
    const job = nightJob('midnight', () => at(date, '01:00'));
    stub.reply = (call) =>
      call.tenantId === tenantA
        ? { kind: 'answer', status: 200, body: answer('midnight', tenantA, { autoClockOut: 'relation "time_events" is locked, call +66812345678' }) }
        : stub.ok(call);
    expect(await runnerFor(job).runJob(job.name, { force: true })).toBe('failed');
    const [run] = await runsFor(job.name, date);
    expect(run!.errorCode).toBe(NIGHT_STEP_FAILED);
    expect(run!.errorMessage).toContain(`OTO App 00:01 midnight batch for ${date}`);
    expect(run!.errorMessage).toContain(`park group ${tenantA}: autoClockOut failed (the batch carried on): relation "time_events" is locked`);
    // A number in the app's words never reaches the record.
    expect(run!.errorMessage).not.toContain('+66812345678');
    expect(JSON.stringify(run!.detail)).not.toContain('+66812345678');
    const groups = detailOf(run!).groups;
    expect(groups.map((g) => [g.tenantId, g.outcome])).toEqual([
      [tenantA, 'failed'],
      [tenantB, 'ran'],
    ]);
    expect(groups[0]!.steps!.map((s) => [s.step, s.ok, s.onFailure])).toEqual([
      ['autoCheckout', true, 'continue'],
      ['autoClockOut', false, 'continue'],
      ['taskGeneration', true, 'continue'],
    ]);
    // The next tick runs A again, not B.
    stub.reply = (call) => stub.ok(call);
    expect(await runnerFor(job).runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('midnight', tenantA)).toHaveLength(2);
    expect(stub.callsFor('midnight', tenantB)).toHaveLength(1);
  });

  it('the one step whose error escapes the app’s batch (the clean-up) is named as stopping it', async () => {
    stub.reset();
    const date = '2026-11-11';
    const job = nightJob('reconcile', () => at(date, '03:30'), envFor([[tenantB, keyB]]));
    stub.reply = (call) => ({
      kind: 'answer',
      status: 200,
      body: answer('reconcile', call.tenantId, { availabilityCleanup: 'cleanup refused' }),
    });
    expect(await runnerFor(job, envFor([[tenantB, keyB]])).runJob(job.name, { force: true })).toBe('failed');
    const [run] = await runsFor(job.name, date);
    expect(run!.errorMessage).toContain('availabilityCleanup failed (the batch stopped there): cleanup refused');
  });

  it('the app’s refusals fail the run in their own codes; the app already running the batch is locked, not failed', async () => {
    const cases: Array<[number, { error: string; message: string }, string]> = [
      [409, { error: 'jobs_inprocess', message: 'This OTO App runs its own night work (OTOAPP_JOBS=inprocess)' }, 'OTOAPP_JOBS_INPROCESS'],
      [403, { error: 'Scope required', message: 'This directory key does not carry jobs:run' }, 'OTOAPP_SCOPE_REQUIRED'],
      [404, { error: 'park_group_not_found', message: 'Park group not found' }, 'OTOAPP_PARK_GROUP_NOT_FOUND'],
    ];
    let day = 12;
    for (const [status, body, code] of cases) {
      stub.reset();
      const date = `2026-11-${day++}`;
      const env = envFor([[tenantA, keyA]]);
      const job = nightJob('midnight', () => at(date, '02:00'), env);
      stub.reply = () => ({ kind: 'answer', status, body });
      expect(await runnerFor(job, env).runJob(job.name, { force: true }), code).toBe('failed');
      const [run] = await runsFor(job.name, date);
      expect(run!.errorCode).toBe(code);
      expect(run!.errorMessage).toContain(body.message);
    }
    stub.reset();
    const date = `2026-11-${day}`;
    const env = envFor([[tenantA, keyA]]);
    const job = nightJob('midnight', () => at(date, '02:00'), env);
    stub.reply = () => ({ kind: 'answer', status: 409, body: { error: 'job_running', message: 'already running' } });
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(job.name, date))[0]!).groups).toEqual([
      expect.objectContaining({ tenantId: tenantA, outcome: 'locked', ok: false }),
    ]);
    // Not done: the next tick asks again.
    stub.reply = (call) => stub.ok(call);
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    expect(await successesFor(job.name, date, tenantA)).toBe(1);
  });

  it('review F3: "already running" again at a later tick of the same date fails the run (OTOAPP_JOB_RUNNING); once is still green', async () => {
    stub.reset();
    const env = envFor([[tenantA, keyA]]);
    const running = () => ({ kind: 'answer' as const, status: 409, body: { error: 'job_running', message: 'already running' } });
    const tick = (date: string, time: string) => {
      const job = nightJob('midnight', () => at(date, time), env);
      return runnerFor(job, env).runJob(job.name, { force: true });
    };
    const date = '2026-11-16';
    stub.reply = running;
    expect(await tick(date, '00:05')).toBe('ok'); // once: a call still finishing
    expect(await tick(date, '00:10')).toBe('failed'); // again: the batch has not finished since
    const [run] = await runsFor(OTOAPP_MIDNIGHT_JOB, date);
    expect(run).toMatchObject({ outcome: 'failed', errorCode: NIGHT_JOB_RUNNING });
    expect(run!.errorMessage).toContain(`park group ${tenantA}: ${NIGHT_JOB_RUNNING}: the OTO App answered "already running" for this park group at an earlier tick of ${date} too`);
    expect(detailOf(run!).groups).toEqual([
      expect.objectContaining({ tenantId: tenantA, outcome: 'failed', ok: false, code: NIGHT_JOB_RUNNING }),
    ]);
    expect(await tick(date, '00:15')).toBe('failed'); // and every tick after, while it holds
    // It lets go: the next tick runs the night, done once.
    stub.reply = (call) => stub.ok(call);
    expect(await tick(date, '00:20')).toBe('ok');
    expect(await successesFor(OTOAPP_MIDNIGHT_JOB, date, tenantA)).toBe(1);
    // Another date starts afresh: its first "already running" is green again.
    stub.reply = running;
    expect(await tick('2026-11-17', '00:05')).toBe('ok');
    expect(detailOf((await runsFor(OTOAPP_MIDNIGHT_JOB, '2026-11-17'))[0]!).groups[0]).toMatchObject({ outcome: 'locked' });
  });

  it('review F3: the six-hourly check has no date — "already running" at the run after one fails it', async () => {
    stub.reset();
    const env = envFor([[tenantA, keyA]]);
    const job = nightJob('presence', () => at('2026-11-18', '06:00'), env);
    const runner = runnerFor(job, env);
    stub.reply = () => ({ kind: 'answer', status: 409, body: { error: 'job_running', message: 'already running' } });
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    expect((await runsFor(OTOAPP_PRESENCE_JOB))[0]).toMatchObject({ errorCode: NIGHT_JOB_RUNNING });
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    stub.reply = (call) => stub.ok(call);
    expect(await runner.runJob(job.name, { force: true })).toBe('ok');
    expect(detailOf((await runsFor(OTOAPP_PRESENCE_JOB))[0]!).groups[0]).toMatchObject({ tenantId: tenantA, outcome: 'ran' });
  });

  it('an answer that is not the batch it asked for is unreadable, and fails the run', async () => {
    stub.reset();
    const date = '2026-11-20';
    const env = envFor([[tenantA, keyA]]);
    const job = nightJob('midnight', () => at(date, '02:00'), env);
    stub.reply = () => ({ kind: 'answer', status: 200, body: answer('midnight', tenantB) });
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('failed');
    expect((await runsFor(job.name, date))[0]!.errorCode).toBe('OTOAPP_UNREADABLE_ANSWER');
  });
});

// =============================================================================
// G. Q4: a leaver's platform account, listed on Failures
// =============================================================================

describe("G. Q4 — the 03:00 run lists each leaver whose platform account is still active, and nobody else", () => {
  const people = { active: '', inactive: '', foreign: '', stayer: '', activeEmployee: '' };

  beforeAll(async () => {
    people.active = await platformAccount(oto);
    const leaver = await appPerson({ platformUserId: people.active, lastWorkingDay: '2026-10-01', label: 'leaver' });
    people.activeEmployee = leaver.employee;
    people.inactive = await platformAccount(oto, 'inactive');
    await appPerson({ platformUserId: people.inactive, lastWorkingDay: '2026-10-01', label: 'switched-off' });
    people.foreign = await platformAccount(second);
    await appPerson({ platformUserId: people.foreign, lastWorkingDay: '2026-10-01', label: 'foreign' });
    people.stayer = await platformAccount(oto);
    await appPerson({ platformUserId: people.stayer, lastWorkingDay: null, label: 'stayer' });
  });

  /** The cases filed for one night (each carries its date). */
  const cases = async (date: string) =>
    db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, OTOAPP_DEPARTED_ACCOUNT_RUN), sql`${opsRun.detail} ->> 'date' = ${date}`));

  it('after the batch runs, the active leaver is filed once — in their operator, with ids and no name — and the run is ok', async () => {
    stub.reset();
    const date = '2026-11-21';
    const env = envFor([[tenantA, keyA]]);
    const job = nightJob('reconcile', () => at(date, '03:01'), env);
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    const filed = await cases(date);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      kind: 'integration',
      outcome: 'failed',
      operatorId: oto,
      errorCode: DEPARTED_ACCOUNT_CASE,
    });
    expect(filed[0]!.detail).toMatchObject({ accountId: people.active, externalId: people.activeEmployee, tenantId: tenantA, date });
    expect(filed[0]!.errorMessage).toMatch(/platform account is still active/);
    expect(JSON.stringify(filed[0]!.detail)).not.toMatch(/ZZ r3/);
    const group = detailOf((await runsFor(job.name, date))[0]!).groups[0]!;
    expect(group).toMatchObject({ outcome: 'ran', ok: true, departedAccounts: { listed: 1, accountIds: [people.active] } });

    // On Failures, as the employee copy's cases are: grouped, and not retried from there.
    const failures = await ctx.app.inject({ method: 'GET', url: '/ops/failures', headers: { cookie: admin } });
    const row = (failures.json() as { groups: Array<{ name: string; kind: string; retryable: boolean }> }).groups.find(
      (g) => g.name === OTOAPP_DEPARTED_ACCOUNT_RUN,
    );
    expect(row).toMatchObject({ kind: 'integration', retryable: false });

    // Done for the date: a later tick lists nobody again.
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    expect(await cases(date)).toHaveLength(1);
  });

  it('the next night files the same standing case again, until somebody switches the account off', async () => {
    stub.reset();
    const env = envFor([[tenantA, keyA]]);
    const job = nightJob('reconcile', () => at('2026-11-22', '03:01'), env);
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    expect((await cases('2026-11-22')).map((c) => (c.detail as { accountId: string }).accountId)).toEqual([people.active]);
    await db.update(account).set({ status: 'inactive' }).where(eq(account.id, people.active));
    const next = nightJob('reconcile', () => at('2026-11-23', '03:01'), env);
    expect(await runnerFor(next, env).runJob(next.name, { force: true })).toBe('ok');
    expect(await cases('2026-11-23')).toEqual([]);
  });

  it('a batch that failed lists nobody: the listing waits for the batch', async () => {
    stub.reset();
    await db.update(account).set({ status: 'active' }).where(eq(account.id, people.active));
    const env = envFor([[tenantA, keyA]]);
    const job = nightJob('reconcile', () => at('2026-11-24', '03:01'), env);
    stub.reply = () => ({ kind: 'answer', status: 200, body: answer('reconcile', tenantA, { departedLogins: 'boom' }) });
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('failed');
    expect(await cases('2026-11-24')).toEqual([]);
  });
});

// =============================================================================
// H. The Console: Run now, a forced failure, Retry, and a silence (H7)
// =============================================================================

describe('H. the Console — Run now, a forced failure with its Retry, and a missed run alerted (H7)', () => {
  const press = (key: string, cookie = admin) =>
    ctx.app.inject({
      method: 'POST',
      url: `/ops/test-controls/${key}`,
      headers: { cookie, 'idempotency-key': newId() },
    });

  it('the four controls are offered to the platform administrator, and refused to anyone else', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/ops/test-controls', headers: { cookie: admin } });
    const keys = (list.json() as { controls: Array<{ key: string }> }).controls.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining(['otoapp.midnight', 'otoapp.reconcile', 'otoapp.presence', 'otoapp.presence.fail']),
    );
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    for (const k of ['otoapp.midnight', 'otoapp.reconcile', 'otoapp.presence', 'otoapp.presence.fail']) {
      expect((await press(k, reception)).statusCode, k).toBe(403);
    }
  });

  it('Run now runs each job at once and says what it did', async () => {
    stub.reset();
    const res = await press('otoapp.presence');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().message).toMatch(/^job:otoapp\.presence ran \(ok\): ran for 1 park group\.$/);
    expect(stub.callsFor('presence', tenantA)).toHaveLength(1);
    // The daily batches answer for the real hour in Bangkok: run, done, or not yet due.
    for (const k of ['otoapp.midnight', 'otoapp.reconcile']) {
      const daily = await press(k);
      expect(daily.statusCode, daily.body).toBe(200);
      expect(daily.json().message).toMatch(/^job:otoapp\.(midnight|reconcile) ran \(ok\): (ran for 1 park group|1 already done for \d{4}-\d{2}-\d{2}|Not due before \d\d:\d\d Bangkok time\.)/);
    }
  });

  it('a forced failure lands on Failures, and its Retry runs the check for real', async () => {
    stub.reset();
    const res = await press('otoapp.presence.fail');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().message).toMatch(/deliberately failed run of job:otoapp\.presence \(failed\)/);
    expect(stub.calls).toEqual([]); // nothing reached the app
    const failures = await ctx.app.inject({ method: 'GET', url: '/ops/failures', headers: { cookie: admin } });
    const group = (failures.json() as { groups: Array<{ name: string; kind: string; retryable: boolean; lastRunId: string; lastError: string }> }).groups.find(
      (g) => g.name === OTOAPP_PRESENCE_JOB,
    );
    expect(group).toMatchObject({ kind: 'job', retryable: true });
    expect(group!.lastError).toMatch(new RegExp(`^${FORCED_FAILURE_CODE}: Deliberate failure`));

    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/ops/runs/${group!.lastRunId}/retry`,
      headers: { cookie: admin, 'idempotency-key': newId() },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ ok: true, outcome: 'ok' });
    expect(stub.callsFor('presence', tenantA)).toHaveLength(1);
    // The forced failure was one-shot: the next press runs for real too.
    expect((await press('otoapp.presence')).json().message).toMatch(/ran \(ok\)/);
  });

  it('a night job that stops raises the watchdog’s missing-run alert', async () => {
    const env = envFor([]);
    const longAgo = new Date(Date.now() - 3 * 3_600_000);
    await db.update(opsLast).set({ lastOkAt: longAgo }).where(eq(opsLast.name, OTOAPP_MIDNIGHT_JOB));
    await db.update(opsExpectation).set({ createdAt: longAgo }).where(eq(opsExpectation.name, OTOAPP_MIDNIGHT_JOB));
    await runWatchdog({ db, env, log: ctx.app.log, channels: [] });
    const alert = await db.execute<{ key: string }>(
      sql`select key from core.alert where key = ${`ops.missing:${OTOAPP_MIDNIGHT_JOB}`}`,
    );
    expect(alert.rows.map((r) => r.key)).toEqual([`ops.missing:${OTOAPP_MIDNIGHT_JOB}`]);
  });
});

// =============================================================================
// I. OTOAPP_JOBS_KEYS
// =============================================================================

describe('I. OTOAPP_JOBS_KEYS — read, refused when malformed, empty in a test', () => {
  it('reads tenant:key pairs, lower-casing the tenant', () => {
    const k = key();
    expect(parseOtoAppJobKeys(` ${tenantA.toUpperCase()}:${k} , ${tenantB}:${keyB}`)).toEqual([
      { tenantId: tenantA, key: k },
      { tenantId: tenantB, key: keyB },
    ]);
    expect(parseOtoAppJobKeys('')).toEqual([]);
  });

  it('refuses a malformed entry at boot, and never prints a key while saying so', () => {
    const secret = key();
    for (const bad of [secret, `not-a-uuid:${secret}`, `${tenantA}:not-a-key`, `${tenantA}:${secret},${tenantA}:${keyB}`]) {
      let message = '';
      try {
        loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused', OTOAPP_JOBS_KEYS: bad });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, bad).toMatch(/OTOAPP_JOBS_KEYS/);
      expect(message).not.toContain(secret.slice(4));
      expect(message).not.toContain(keyB.slice(4));
    }
  });

  it('a test process ignores a jobs key it was not handed', () => {
    const before = process.env.OTOAPP_JOBS_KEYS;
    process.env.OTOAPP_JOBS_KEYS = `${tenantA}:${keyA}`;
    try {
      expect(loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' }).OTOAPP_JOBS_KEYS).toBe('');
    } finally {
      if (before === undefined) delete process.env.OTOAPP_JOBS_KEYS;
      else process.env.OTOAPP_JOBS_KEYS = before;
    }
  });
});

// =============================================================================
// K. Review F1: a park group the app holds staff in, with no key here
// =============================================================================

describe('K. review F1 — a park group the app holds staff in, with no key here, fails every run naming it', () => {
  const tenantU = newId();
  const keyU = key();

  beforeAll(async () => {
    await q(`insert into tenants (id, name, slug) values ($1, 'ZZ r3 unkeyed', $2)`, [tenantU, `zz-r3-u-${tenantU.slice(-6)}`]);
    const branch = newId();
    await q(`insert into branches (id, tenant_id, name, address) values ($1, $2, 'ZZ r3 unkeyed park', 'ZZ r3')`, [branch, tenantU]);
    await q(`insert into employees (id, tenant_id, branch_id, full_name, nickname, email) values ($1, $2, $3, 'ZZ r3 unkeyed', 'ZZ', $4)`, [
      newId(),
      tenantU,
      branch,
      `zz-r3-unkeyed-${tenantU.slice(-6)}@example.com`,
    ]);
  });

  it('the keyed park group runs and is done; the run fails naming U in its code, its words and its detail; nothing is sent for U', async () => {
    stub.reset();
    const date = '2026-11-26';
    const env = envFor([[tenantA, keyA]]);
    let clock = at(date, '00:05');
    const job = nightJob('midnight', () => clock, env);
    const runner = runnerFor(job, env);
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    const [run] = await runsFor(job.name, date);
    expect(run!.errorCode).toBe(NIGHT_JOB_UNKEYED);
    expect(run!.errorMessage).toBe(
      `OTO App 00:01 midnight batch for ${date}: park group ${tenantU}: ${NIGHT_JOB_UNKEYED}: the OTO App holds staff there, but this deployment holds no jobs:run key for it (OTOAPP_JOBS_KEYS), so nothing runs its night; add the key and redeploy the api, which reads the keys only when it starts`,
    );
    expect(detailOf(run!)).toMatchObject({ configured: true, due: true, failed: 1, parkGroups: { checked: true, held: 2, unkeyed: [tenantU] } });
    expect(detailOf(run!).groups.map((g) => [g.tenantId, g.outcome, g.ok, g.code ?? null])).toEqual([
      [tenantA, 'ran', true, null],
      [tenantU, 'failed', false, NIGHT_JOB_UNKEYED],
    ]);
    expect(detailOf(run!).groups[1]!.error).toMatch(/issue it a jobs:run key in the OTO App and add it to OTOAPP_JOBS_KEYS, then redeploy the api, which reads the keys only when it starts$/);
    expect(stub.callsFor('midnight').map((c) => c.tenantId)).toEqual([tenantA]);
    expect([...(await nightGroupsDone(db, job.name, date))]).toEqual([tenantA]);

    // Every tick fails while U has no key — and A, done, is not run again.
    clock = at(date, '00:10');
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    expect(detailOf((await runsFor(job.name, date))[0]!).groups.map((g) => [g.tenantId, g.outcome])).toEqual([
      [tenantA, 'done'],
      [tenantU, 'failed'],
    ]);
    expect(stub.callsFor('midnight')).toHaveLength(1);
    // On Failures under the new code, retryable as every job is.
    const failures = await ctx.app.inject({ method: 'GET', url: '/ops/failures', headers: { cookie: admin } });
    const row = (failures.json() as { groups: Array<{ name: string; kind: string; retryable: boolean; lastError: string }> }).groups.find(
      (g) => g.name === OTOAPP_MIDNIGHT_JOB,
    );
    expect(row).toMatchObject({ kind: 'job', retryable: true });
    expect(row!.lastError).toMatch(new RegExp(`^${NIGHT_JOB_UNKEYED}: `));
  });

  it('the 03:00 batch and the six-hourly check fail for U the same way', async () => {
    stub.reset();
    const env = envFor([[tenantA, keyA]]);
    for (const [name, clock] of [
      ['reconcile', at('2026-11-26', '03:05')],
      ['presence', at('2026-11-26', '06:00')],
    ] as const) {
      const job = nightJob(name, () => clock, env);
      expect(await runnerFor(job, env).runJob(job.name, { force: true }), name).toBe('failed');
      const [run] = await runsFor(job.name);
      expect(run!.errorCode, name).toBe(NIGHT_JOB_UNKEYED);
      expect(detailOf(run!).groups.map((g) => [g.tenantId, g.outcome]), name).toEqual([
        [tenantA, 'ran'],
        [tenantU, 'failed'],
      ]);
    }
  });

  it("given U's key, the next tick runs U, and the run is ok", async () => {
    stub.reset();
    KEYS[tenantU] = keyU;
    const env = envFor([[tenantA, keyA], [tenantU, keyU]]);
    const date = '2026-11-26';
    const job = nightJob('midnight', () => at(date, '00:15'), env);
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    const [run] = await runsFor(job.name, date);
    expect(detailOf(run!).groups.map((g) => [g.tenantId, g.outcome])).toEqual([
      [tenantA, 'done'],
      [tenantU, 'ran'],
    ]);
    expect(detailOf(run!).parkGroups).toEqual({ checked: true, held: 2, unkeyed: [] });
    expect(await successesFor(job.name, date, tenantU)).toBe(1);
  });

  it('a deployment holding no key at all is still the no-op, whatever park groups the app holds: the app runs its own nights', async () => {
    stub.reset();
    const env = envFor([]);
    const job = nightJob('midnight', () => at('2026-11-27', '00:30'), env);
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
    // A no-op names no date: the newest run of the job is this one.
    const [run] = await runsFor(job.name);
    expect(detailOf(run!)).toMatchObject({ configured: false, due: false, groups: [], failed: 0 });
    expect(detailOf(run!).parkGroups).toBeUndefined();
    expect(stub.calls).toEqual([]);
  });
});

// =============================================================================
// J. The real app
// =============================================================================

const children: ChildProcess[] = [];

/** The boot guard refuses a deployment whose DATABASE_URL names localhost; harmless here, as DEPLOY_ENV is local. */
const HARNESS_ENV = {
  NODE_ENV: 'test',
  APP_ENV: 'dev',
  STORAGE_ENV_PREFIX: 'zz-r3',
  OBJECT_STORAGE: 'local',
  OTOAPP_LEGACY_LOGIN: 'true',
  LOG_LEVEL: 'warn',
  DEPLOY_ENV: 'local',
  // The app keeps naive UTC timestamps and computes Bangkok midnight by hand.
  TZ: 'UTC',
};

async function serve(env: Record<string, string>): Promise<string> {
  const child = spawn(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/harness/serve-routes.ts'], {
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

describe.skipIf(!HAS_APP_RUNTIME)('J. the real app: its endpoint, the platform job against it, the switch', () => {
  const tenantR = newId();
  let branchR = '';
  let keyR = '';
  let eventsOnlyR = '';
  let origin = { platform: '', inprocess: '' };
  const stale: Array<{ employee: string }> = [];

  const directoryKey = async (tenant: string, scopes: string[]) => {
    const k = key();
    await q('insert into directory_clients (tenant_id, name, key_hash, scopes) values ($1, $2, $3, $4)', [
      tenant,
      'ZZ r3 platform jobs',
      createHash('sha256').update(k).digest('hex'),
      scopes,
    ]);
    return k;
  };

  const outsOf = async (employee: string) =>
    Number(
      (await q<{ n: string }>(`select count(*) as n from time_events where employee_id = $1 and event_type = 'OUT'`, [employee]))[0]!
        .n,
    );

  beforeAll(async () => {
    await q(`insert into tenants (id, name, slug) values ($1, 'ZZ r3 real', $2)`, [tenantR, `zz-r3-real-${tenantR.slice(-6)}`]);
    branchR = newId();
    await q(`insert into branches (id, tenant_id, name, address) values ($1, $2, 'ZZ r3 real park', 'ZZ r3')`, [branchR, tenantR]);
    for (let i = 0; i < 2; i += 1) {
      const employee = newId();
      await q(
        `insert into employees (id, tenant_id, branch_id, full_name, nickname, email) values ($1, $2, $3, $4, 'ZZ', $5)`,
        [employee, tenantR, branchR, `ZZ r3 clocked ${i}`, `zz-r3-clocked-${i}-${employee.slice(-6)}@example.com`],
      );
      await q(
        `insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time, auth_method)
         values ($1, $2, $3, 'IN', (now() at time zone 'utc') - interval '30 hours', 'PIN')`,
        [tenantR, employee, branchR],
      );
      stale.push({ employee });
    }
    keyR = await directoryKey(tenantR, ['jobs:run']);
    eventsOnlyR = await directoryKey(tenantR, ['events:write']);
    const dbUrl = (db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
    const [platform, inprocess] = await Promise.all([
      serve({ OTOAPP_JOBS: 'platform', DATABASE_URL: dbUrl }),
      serve({ OTOAPP_JOBS: 'inprocess', DATABASE_URL: dbUrl }),
    ]);
    origin = { platform, inprocess };
  }, 300_000);

  const post = async (base: string, name: string, k: string | null, body: unknown = {}) => {
    const res = await fetch(`${base}/api/directory/jobs/${name}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('the key: none 401, without jobs:run 403, naming another park group 404', async () => {
    expect((await post(origin.platform, 'midnight', null)).status).toBe(401);
    const scope = await post(origin.platform, 'midnight', eventsOnlyR);
    expect(scope.status).toBe(403);
    expect(String(scope.body.message)).toMatch(/jobs:run/);
    const other = await post(origin.platform, 'midnight', keyR, { tenantId: tenantA });
    expect(other).toEqual({ status: 404, body: { error: 'park_group_not_found', message: 'Park group not found' } });
    for (const s of stale) expect(await outsOf(s.employee)).toBe(0);
  });

  it('under OTOAPP_JOBS=inprocess the endpoint refuses in words, and the platform run fails saying so', async () => {
    const refused = await post(origin.inprocess, 'midnight', keyR, { tenantId: tenantR });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('jobs_inprocess');
    expect(String(refused.body.message)).toMatch(/OTOAPP_JOBS=inprocess/);
    const env = envFor([[tenantR, keyR]], { OTOAPP_DIRECTORY_URL: origin.inprocess });
    const job = nightJob('midnight', () => at('2026-11-25', '01:00'), env);
    expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('failed');
    expect((await runsFor(job.name, '2026-11-25'))[0]!.errorCode).toBe('OTOAPP_JOBS_INPROCESS');
    for (const s of stale) expect(await outsOf(s.employee)).toBe(0);
  });

  it('H9 then H8 against the app: down, then run — ONE clock-out per stale clock-in — then done, and a forced repeat writes none', async () => {
    const today = isoDateInTz(new Date(), BANGKOK);
    const clock = () => at(today, '12:00');
    // The app down: a port nothing listens on.
    const deadEnv = envFor([[tenantR, keyR]], { OTOAPP_DIRECTORY_URL: 'http://127.0.0.1:9' });
    const dead = nightJob('midnight', clock, deadEnv);
    expect(await runnerFor(dead, deadEnv).runJob(dead.name, { force: true })).toBe('failed');
    for (const s of stale) expect(await outsOf(s.employee)).toBe(0);

    const env = envFor([[tenantR, keyR]], { OTOAPP_DIRECTORY_URL: origin.platform });
    const job = nightJob('midnight', clock, env);
    const runner = runnerFor(job, env);
    // F1: the app holds staff in A and K's U too, which this key list leaves
    // out, so the run fails for them alone; R's part is what this test reads.
    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    const first = await latestFor(job.name, today, tenantR);
    failedOnlyUnkeyed(first.run);
    expect(first.group).toMatchObject({ tenantId: tenantR, outcome: 'ran', ok: true });
    expect(first.group.steps!.find((s) => s.step === 'autoClockOut')!.counts.autoClockedOut).toBe(2);
    for (const s of stale) expect(await outsOf(s.employee)).toBe(1);

    expect(await runner.runJob(job.name, { force: true })).toBe('failed');
    expect((await latestFor(job.name, today, tenantR)).group.outcome).toBe('done');
    expect(await successesFor(job.name, today, tenantR)).toBe(1);

    // Even the app asked again directly writes no second clock-out.
    const again = await post(origin.platform, 'midnight', keyR, { tenantId: tenantR });
    expect(again.status).toBe(200);
    for (const s of stale) expect(await outsOf(s.employee)).toBe(1);
  });

  it('two calls at once for the same park group: one runs, one is refused as already running', async () => {
    const both = await Promise.all([
      post(origin.platform, 'reconcile', keyR, { tenantId: tenantR }),
      post(origin.platform, 'reconcile', keyR, { tenantId: tenantR }),
      post(origin.platform, 'reconcile', keyR, { tenantId: tenantR }),
    ]);
    const statuses = both.map((b) => b.status).sort();
    // At least one ran; any that overlapped it was refused, never run twice.
    expect(statuses).toContain(200);
    for (const b of both.filter((x) => x.status !== 200)) {
      expect(b).toEqual({ status: 409, body: expect.objectContaining({ error: 'job_running' }) });
    }
  });

  it('under OTOAPP_JOBS=platform the scheduler registers no timer; under inprocess the app’s own three', () => {
    for (const [mode, expected] of [
      ['platform', 'TIMERS=0 STARTED=false'],
      // The three night timers, and from round 4b Attention's four (the engine's
      // start-up run and six-hourly timer, the no-show check's first run and
      // ten-minute timer).
      ['inprocess', 'TIMERS=7 STARTED=true'],
    ] as const) {
      const r = spawnSync(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/harness/start-scheduler.ts'], {
        cwd: APP_DIR,
        env: { ...process.env, ...HARNESS_ENV, OTOAPP_JOBS: mode, DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' },
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(`${r.stdout}${r.stderr}`, mode).toContain(expected);
    }
  });

  it('the two manual triggers: the Console in words under platform; the caller’s park group only under inprocess', async () => {
    const adminEmail = `zz-r3-admin-${tenantR.slice(-6)}@example.com`;
    const adminId = newId();
    await q(
      `insert into users (id, email, password, full_name, role, is_active, must_change_password)
       values ($1, $2, $3, 'ZZ r3 admin', 'admin', true, false)`,
      [adminId, adminEmail, scrypt('zz-r3-pw')],
    );
    await q(
      `insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')`,
      [tenantR, adminId],
    );
    const leaverUser = newId();
    await q(
      `insert into users (id, email, password, full_name, role, is_active, must_change_password)
       values ($1, $2, $3, 'ZZ r3 leaver', 'staff', true, false)`,
      [leaverUser, `zz-r3-leaver-${leaverUser.slice(-6)}@example.com`, scrypt('zz-r3-pw')],
    );
    await q(
      `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, user_id, last_working_day)
       values ($1, $2, $3, 'ZZ r3 leaver', 'ZZ', $4, $5, '2020-01-01')`,
      [newId(), tenantR, branchR, `zz-r3-leaver-e-${leaverUser.slice(-6)}@example.com`, leaverUser],
    );
    // A leaver in another park group, which the caller must not reach.
    const otherUser = newId();
    await q(
      `insert into users (id, email, password, full_name, role, is_active, must_change_password)
       values ($1, $2, $3, 'ZZ r3 other leaver', 'staff', true, false)`,
      [otherUser, `zz-r3-other-${otherUser.slice(-6)}@example.com`, scrypt('zz-r3-pw')],
    );
    await q(
      `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, user_id, last_working_day)
       values ($1, $2, $3, 'ZZ r3 other leaver', 'ZZ', $4, $5, '2020-01-01')`,
      [newId(), tenantA, appCentral, `zz-r3-other-e-${otherUser.slice(-6)}@example.com`, otherUser],
    );
    const active = async (id: string) => (await q<{ a: boolean }>('select is_active as a from users where id = $1', [id]))[0]!.a;

    const signIn = async (base: string) => {
      const res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: adminEmail, password: 'zz-r3-pw' }),
      });
      expect(res.status).toBe(200);
      return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    };
    const trigger = async (base: string, cookie: string, path: string) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    const onPlatform = await signIn(origin.platform);
    for (const path of ['/api/admin/run-departed-deactivation', '/api/scheduler/transition-left']) {
      const res = await trigger(origin.platform, onPlatform, path);
      expect(res.status, path).toBe(409);
      expect(res.body.reason).toBe('jobs_on_platform');
      expect(String(res.body.message)).toMatch(/Retry on the Console's Failures page/);
      expect(String(res.body.message)).not.toMatch(/Run now/);
    }
    expect(await active(leaverUser)).toBe(true);

    const inProcess = await signIn(origin.inprocess);
    const res = await trigger(origin.inprocess, inProcess, '/api/admin/run-departed-deactivation');
    expect(res.status).toBe(200);
    expect(await active(leaverUser)).toBe(false);
    expect(await active(otherUser)).toBe(true);
  });

  it('review F2: a second midnight batch of one date makes no second instance — a task due at 06:30 Bangkok, and one at 18:00', async () => {
    const t = newId();
    await q(`insert into tenants (id, name, slug) values ($1, 'ZZ r3 tasks', $2)`, [t, `zz-r3-tasks-${t.slice(-6)}`]);
    const branch = newId();
    await q(`insert into branches (id, tenant_id, name, address) values ($1, $2, 'ZZ r3 tasks park', 'ZZ r3')`, [branch, t]);
    const k = await directoryKey(t, ['jobs:run']);
    const definition = async (time: string) =>
      (
        await q<{ id: string }>(
          `insert into tasks (tenant_id, branch_id, title, recurrence, is_recurring_definition, preferred_due_time)
           values ($1, $2, $3, 'daily', true, $4) returning id`,
          [t, branch, `ZZ r3 daily at ${time}`, time],
        )
      )[0]!.id;
    // 06:30 Bangkok is the previous UTC day: the window the old lookup missed.
    const early = await definition('06:30');
    const late = await definition('18:00');
    const generated: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const a = await post(origin.platform, 'midnight', k, { tenantId: t });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.ok, JSON.stringify(a.body)).toBe(true);
      const steps = a.body.steps as Array<{ step: string; counts: Record<string, number> }>;
      generated.push(steps.find((s) => s.step === 'taskGeneration')!.counts.generated!);
    }
    expect(generated).toEqual([2, 0]);
    const today = isoDateInTz(new Date(), BANGKOK);
    for (const [def, time] of [
      [early, '06:30'],
      [late, '18:00'],
    ] as const) {
      // The app keeps naive UTC timestamps: read the wall time as stored.
      const rows = await q<{ d: string; due: string }>(
        `select generated_for_date as d, to_char(due_at, 'YYYY-MM-DD"T"HH24:MI') as due from tasks where parent_task_id = $1`,
        [def],
      );
      expect(rows, time).toHaveLength(1);
      expect(rows[0]!.d, time).toBe(today);
      expect(rows[0]!.due, time).toBe(at(today, time).toISOString().slice(0, 16));
    }
  });

  it('review F4: the in-process batch takes the endpoint\'s lock — it stands down for a park group held elsewhere, runs the others, and lets go', async () => {
    const group = async (label: string) => {
      const tenant = newId();
      await q(`insert into tenants (id, name, slug) values ($1, $2, $3)`, [tenant, `ZZ r3 ${label}`, `zz-r3-${label}-${tenant.slice(-6)}`]);
      const branch = newId();
      await q(`insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ r3')`, [branch, tenant, `ZZ r3 ${label} park`]);
      const employee = newId();
      await q(`insert into employees (id, tenant_id, branch_id, full_name, nickname, email) values ($1, $2, $3, $4, 'ZZ', $5)`, [
        employee,
        tenant,
        branch,
        `ZZ r3 ${label}`,
        `zz-r3-${label}-${employee.slice(-6)}@example.com`,
      ]);
      await q(
        `insert into time_events (tenant_id, employee_id, branch_id, event_type, event_time, auth_method)
         values ($1, $2, $3, 'IN', (now() at time zone 'utc') - interval '30 hours', 'PIN')`,
        [tenant, employee, branch],
      );
      return { tenant, employee };
    };
    const held = await group('held');
    const free = await group('free');
    const lockOf = (tenant: string) => [0x0712, `otoapp_night:midnight:${tenant}`];
    const holder = await appPool.connect();
    let output = '';
    try {
      await holder.query('select pg_advisory_lock($1::int4, hashtext($2))', lockOf(held.tenant));
      // The app's own 00:01 timer, fired once, as an instance on OTOAPP_JOBS=inprocess fires it.
      const child = spawnSync(
        process.execPath,
        [
          join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'),
          '--input-type=module',
          '-e',
          `await import('./server/config/env.ts');
           const realTimeout = globalThis.setTimeout;
           const timers = [];
           const capture = (fn) => { timers.push(fn); return realTimeout(() => undefined, 0).unref(); };
           globalThis.setTimeout = capture;
           globalThis.setInterval = capture;
           const { startScheduledJobs } = await import('./server/scheduled-jobs.ts');
           startScheduledJobs('inprocess');
           await timers[0]();
           console.log('ZZ_R3_INPROCESS_MIDNIGHT_FIRED');
           process.exit(0);`,
        ],
        {
          cwd: APP_DIR,
          env: {
            ...process.env,
            ...HARNESS_ENV,
            OTOAPP_JOBS: 'inprocess',
            DATABASE_URL: (db as unknown as { $client: pg.Pool }).$client.options.connectionString!,
          },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );
      output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
      expect(child.status, output).toBe(0);
      expect(output).toContain('ZZ_R3_INPROCESS_MIDNIGHT_FIRED');
      expect(output).toContain(`midnight: park group ${held.tenant}'s batch is already running elsewhere (the platform's job endpoint), so it is not run here`);
      expect(await outsOf(held.employee)).toBe(0);
      expect(await outsOf(free.employee)).toBe(1);
    } finally {
      await holder.query('select pg_advisory_unlock($1::int4, hashtext($2))', lockOf(held.tenant));
      holder.release();
    }
    // It let go of every lock it took: the free park group's can be taken now.
    const probe = await appPool.connect();
    try {
      const { rows } = await probe.query<{ locked: boolean }>('select pg_try_advisory_lock($1::int4, hashtext($2)) as locked', lockOf(free.tenant));
      expect(rows[0]!.locked).toBe(true);
      await probe.query('select pg_advisory_unlock($1::int4, hashtext($2))', lockOf(free.tenant));
    } finally {
      probe.release();
    }
  }, 240_000);

  it("apps/oto-app/tests/night-jobs.check.ts passes against a fresh database", async () => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      const result = spawnSync(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/night-jobs.check.ts'], {
        cwd: APP_DIR,
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 300_000,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      expect(output).toMatch(/night-jobs\.check: \d+ checks passed/);
    } finally {
      await drop();
    }
  }, 360_000);
});
