import { and, desc, eq, like, or } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alert, auditLog, box, branch, device, opsExpectation, opsLast, opsRun } from '@oto/db';
import { newId } from '@oto/shared';
import { runWatchdog } from '../src/services/jobs';
import { recordRun, type AlertChannel, type AlertMessage } from '../src/services/ops';
import {
  ADMIN,
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-03 — the routes the Console actually calls.
 *
 * The pages were built beside the API by an agent that never met it, so
 * `apps/console/src/api/observability.ts` is the contract and these cases are
 * written from it: the shapes are asserted field by field, because a response
 * that is merely plausible renders an empty state and the screenshots taken
 * off it evidence nothing.
 *
 * What is really being defended here:
 *   - the job register is read from the DATABASE, so an instance that does not
 *     carry the jobs role still answers correctly;
 *   - sixty instances of one break are one row with a count of sixty;
 *   - nothing personal and no credential — not a masked one, not a length —
 *     reaches a page read by whoever is on call.
 */

let ctx: TestContext;
let adminCookie: string;
let receptionCookie: string;

/**
 * Real-looking credentials in the process environment, so "no credential is
 * returned" is a claim about the response rather than about a value that was
 * never there to leak.
 */
const TWILIO_SECRET = 'test-twilio-auth-token-must-never-be-returned';
const TWILIO_SID = `AC${'1'.repeat(32)}`;

beforeAll(async () => {
  process.env.TWILIO_ACCOUNT_SID = TWILIO_SID;
  process.env.TWILIO_AUTH_TOKEN = TWILIO_SECRET;
  process.env.TWILIO_FROM = '+66900000000';
  ctx = await createTestContext({
    env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true', SMS_ADAPTER: 'twilio' },
  });
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
});

afterAll(async () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM;
  await ctx.close();
  await teardownAll();
});

const get = (url: string, cookie = adminCookie) =>
  ctx.app.inject({ method: 'GET', url, headers: { cookie } });

const post = (url: string, cookie = adminCookie) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie } });

interface HealthBody {
  status: string;
  checks: Array<{ key: string; label: string; status: string; value?: unknown; detail?: unknown }>;
  jobs: Array<{
    name: string;
    status: string;
    lastRunAt: string | null;
    lastOutcome: string | null;
    expectedEverySeconds: number | null;
    ageSeconds: number | null;
    lastError: string | null;
  }>;
  boxes: Array<{
    id: string;
    name: string;
    slot: string;
    status: string;
    state: string;
    openingHours: string;
    agentVersion: string | null;
    agentBelowMinimum: boolean;
    heartbeatAgeSeconds: number | null;
    uptimeSeconds: number | null;
    outboxDepth: number | null;
    clockOffsetMs: number | null;
    conditions: string[];
    detail: string | null;
    devices: Array<{ id: string; kind: string; label: string; reachability: string; paperStatus: string }>;
  }>;
  alerts: Array<{ id: string; key: string; severity: string; title: string; count: number }>;
  watchdogAgeSeconds: number | null;
  generatedAt: string;
}

interface FailureBody {
  groups: Array<{
    fingerprint: string;
    kind: string;
    name: string;
    count: number;
    firstSeenAt: string;
    lastSeenAt: string;
    lastError: string | null;
    lastRunId: string | null;
    retryable: boolean;
  }>;
  nextCursor: string | null;
  ungrouped?: number;
}

/** A job the in-process runner knows nothing about — the point of the case. */
const LATE_JOB = 'job:test.register-late';

describe('S2-03 — GET /ops/health', () => {
  it('answers the shape the Console reads', async () => {
    const res = await get('/ops/health');
    expect(res.statusCode).toBe(200);
    const body = res.json<HealthBody>();

    expect(['ok', 'warn', 'down', 'unknown']).toContain(body.status);
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);

    const keys = body.checks.map((c) => c.key);
    expect(keys).toContain('database');
    expect(keys).toContain('pool');
    expect(keys).toContain('watchdog');
    /**
     * And deliberately NOT an `api` tile: the Console mints that one itself
     * from its own round trip to /ready and prepends it, so a second tile
     * under the same key would be a duplicate row and a duplicate React key.
     */
    expect(keys).not.toContain('api');

    const database = body.checks.find((c) => c.key === 'database')!;
    expect(database.status).toBe('ok');
    expect(database.label).toBe('Database');
    expect(typeof database.value).toBe('number');

    const pool = body.checks.find((c) => c.key === 'pool')!;
    expect(['ok', 'warn']).toContain(pool.status);
    expect(String(pool.detail)).toContain('idle');
  });

  it('reads the job register from the database, not from this process', async () => {
    // Declared an hour ago, expected every minute, last succeeded an hour ago.
    // Nothing in this process has ever heard of it.
    const hourAgo = new Date(Date.now() - 3_600_000);
    await ctx.db.insert(opsExpectation).values({
      name: LATE_JOB,
      kind: 'job',
      description: 'Expected every minute, and has not run',
      intervalSeconds: 60,
      graceSeconds: 30,
      severity: 'warning',
      createdAt: hourAgo,
    });
    await ctx.db.insert(opsLast).values({
      name: LATE_JOB,
      kind: 'job',
      lastOutcome: 'ok',
      lastStartedAt: hourAgo,
      lastFinishedAt: hourAgo,
      lastOkAt: hourAgo,
    });

    const body = (await get('/ops/health')).json<HealthBody>();
    const job = body.jobs.find((j) => j.name === LATE_JOB);
    expect(job, 'the register must list a job this process does not run').toBeTruthy();
    expect(job!.expectedEverySeconds).toBe(60);
    expect(job!.lastOutcome).toBe('ok');
    expect(job!.lastRunAt).toBe(hourAgo.toISOString());
    // An hour late on a one-minute schedule.
    expect(job!.ageSeconds).toBeGreaterThan(3_500);
    expect(job!.status).toBe('warn');
    // And the page's verdict follows the job.
    expect(['warn', 'down']).toContain(body.status);
  });

  it('a job inside its interval reads as healthy', async () => {
    const name = 'job:test.register-fresh';
    await ctx.db.insert(opsExpectation).values({
      name,
      kind: 'job',
      intervalSeconds: 3_600,
      graceSeconds: 3_600,
      severity: 'warning',
    });
    await ctx.db.insert(opsLast).values({
      name,
      kind: 'job',
      lastOutcome: 'ok',
      lastStartedAt: new Date(),
      lastFinishedAt: new Date(),
      lastOkAt: new Date(),
    });

    const body = (await get('/ops/health')).json<HealthBody>();
    const job = body.jobs.find((j) => j.name === name)!;
    expect(job.status).toBe('ok');
    expect(job.ageSeconds).toBeLessThan(60);
  });

  it('shows an open alert, and takes it when someone acknowledges', async () => {
    const key = `ops.missing:${LATE_JOB}`;
    const id = newId();
    await ctx.db.insert(alert).values({
      id,
      key,
      category: 'ops.missing',
      severity: 'warning',
      subject: LATE_JOB,
      summary: `${LATE_JOB} has not succeeded for an hour`,
      occurrences: 4,
    });

    const before = (await get('/ops/health')).json<HealthBody>();
    const row = before.alerts.find((a) => a.id === id)!;
    expect(row.key).toBe(key);
    expect(row.title).toContain(LATE_JOB);
    expect(row.count).toBe(4);

    const res = await post(`/ops/alerts/${id}/acknowledge`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);

    const [taken] = await ctx.db.select().from(alert).where(eq(alert.id, id));
    expect(taken!.status).toBe('acknowledged');
    expect(taken!.acknowledgedAt).not.toBeNull();
    expect(taken!.acknowledgedByAccountId).not.toBeNull();

    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ops.alert_acknowledge'), eq(auditLog.entityId, id)))
      .limit(1);
    expect(audited, 'acknowledging an alert is a mutation, so it leaves a row').toBeTruthy();

    // Taking it twice is not an error the page can act on, so it is a 404
    // rather than a silent second acknowledgement.
    expect((await post(`/ops/alerts/${id}/acknowledge`)).statusCode).toBe(404);
  });
});

describe('S2-03 — GET /ops/failures', () => {
  const broken = 'job:test.printer-unreachable';

  it('groups one broken thing into one row with a count', async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordRun(ctx.db, {
        kind: 'job',
        name: broken,
        outcome: 'failed',
        startedAt: new Date(Date.now() - i * 1_000),
        error: new Error('printer did not answer'),
      });
    }
    // A different break of the same job: a different code, so a different row.
    await recordRun(ctx.db, {
      kind: 'job',
      name: broken,
      outcome: 'failed',
      startedAt: new Date(),
      error: Object.assign(new Error('out of paper'), { name: 'PaperError' }),
    });
    // And one that worked, which must not appear at all.
    await recordRun(ctx.db, { kind: 'job', name: broken, outcome: 'ok', startedAt: new Date() });

    const body = (await get('/ops/failures?windowHours=24&limit=50')).json<FailureBody>();
    const groups = body.groups.filter((g) => g.name === broken);
    expect(groups).toHaveLength(2);

    const main = groups.find((g) => g.lastError?.includes('printer did not answer'))!;
    expect(main.count).toBe(5);
    expect(main.kind).toBe('job');
    expect(main.lastError).toBe('Error: printer did not answer');
    expect(main.lastRunId).toBeTruthy();
    // A sweep is the one thing safe to start again from a console.
    expect(main.retryable).toBe(true);
    expect(new Date(main.firstSeenAt).getTime()).toBeLessThanOrEqual(
      new Date(main.lastSeenAt).getTime(),
    );
    expect(typeof body.ungrouped).toBe('number');
  });

  it('filters by kind and by the window the page offers', async () => {
    const old = 'http:GET /test/ancient';
    await recordRun(ctx.db, {
      kind: 'http',
      name: old,
      outcome: 'failed',
      // Eight days ago: inside the seven-day preset, outside the day one.
      startedAt: new Date(Date.now() - 8 * 86_400_000),
      finishedAt: new Date(Date.now() - 8 * 86_400_000),
      error: new Error('long gone'),
    });

    const day = (await get('/ops/failures?windowHours=24')).json<FailureBody>();
    expect(day.groups.some((g) => g.name === old)).toBe(false);

    const week = (await get('/ops/failures?windowHours=336')).json<FailureBody>();
    expect(week.groups.some((g) => g.name === old)).toBe(true);

    const jobs = (await get('/ops/failures?windowHours=336&kind=job')).json<FailureBody>();
    expect(jobs.groups.every((g) => g.kind === 'job')).toBe(true);
    expect(jobs.groups.some((g) => g.name === old)).toBe(false);

    // An unknown kind is refused by the schema rather than silently ignored.
    expect((await get('/ops/failures?kind=nonsense')).statusCode).toBe(400);
  });

  it('pages with a cursor rather than an offset', async () => {
    const first = (await get('/ops/failures?windowHours=336&limit=1')).json<FailureBody>();
    expect(first.groups).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = (
      await get(`/ops/failures?windowHours=336&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)
    ).json<FailureBody>();
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]!.fingerprint).not.toBe(first.groups[0]!.fingerprint);
    // The count belongs to the window, not to the page.
    expect(second.ungrouped).toBeUndefined();
  });

  it('hands back the individual runs behind one group', async () => {
    const body = (await get('/ops/failures?windowHours=24')).json<FailureBody>();
    const group = body.groups.find((g) => g.name === broken && g.count === 5)!;

    const res = await get(`/ops/runs?fingerprint=${group.fingerprint}&limit=10`);
    expect(res.statusCode).toBe(200);
    const { runs } = res.json<{ runs: Array<{ id: string; outcome: string; error: string | null; durationMs: number | null }> }>();
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => r.outcome === 'failed')).toBe(true);
    expect(runs[0]!.error).toContain('printer did not answer');
    expect(typeof runs[0]!.durationMs).toBe('number');
  });

  it('never hands back a phone number, however the failure carried one', async () => {
    const phone = '+66811111111';
    // What Postgres puts in `detail` on a unique violation, and what a route
    // would have passed as its own detail.
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 'member_phone_unique',
      detail: `Key (phone)=(${phone}) already exists.`,
      table: 'member',
    });
    await recordRun(ctx.db, {
      kind: 'http',
      name: 'http:POST /members',
      outcome: 'failed',
      startedAt: new Date(),
      error: pgError,
      detail: { phone },
    });

    const failures = await get('/ops/failures?windowHours=24&limit=200');
    expect(failures.body).not.toContain(phone);
    const group = failures
      .json<FailureBody>()
      .groups.find((g) => g.name === 'http:POST /members')!;
    expect(group.lastError).toContain('member_phone_unique');
    // A request is not a sweep: it already half-happened.
    expect(group.retryable).toBe(false);

    const runs = await get(`/ops/runs?fingerprint=${group.fingerprint}`);
    expect(runs.body).not.toContain(phone);
  });
});

describe('S2-03 — POST /ops/runs/:id/retry', () => {
  it('re-runs a failed job, and refuses anything that already half-happened', async () => {
    const [httpRun] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'http:POST /members'))
      .limit(1);
    const refused = await post(`/ops/runs/${httpRun!.id}/retry`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { message: string } }>().error.message).toContain('not safe');

    // A job this build does not register — which is also what a job renamed
    // in a later deploy looks like. A sentence, not an unhandled throw.
    const [orphan] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'job:test.printer-unreachable'))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    const gone = await post(`/ops/runs/${orphan!.id}/retry`);
    expect(gone.statusCode).toBe(409);
    expect(gone.json<{ error: { code: string } }>().error.code).toBe('JOB_NOT_REGISTERED');

    expect((await post(`/ops/runs/${newId()}/retry`)).statusCode).toBe(404);
  });

  it('runs a real sweep again and audits who asked', async () => {
    await recordRun(ctx.db, {
      kind: 'job',
      name: 'job:housekeeping.handoff',
      outcome: 'failed',
      startedAt: new Date(),
      error: new Error('the sweep fell over'),
    });
    const [failed] = await ctx.db
      .select()
      .from(opsRun)
      .where(
        and(eq(opsRun.name, 'job:housekeeping.handoff'), eq(opsRun.outcome, 'failed')),
      )
      .limit(1);

    const res = await post(`/ops/runs/${failed!.id}/retry`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean; outcome: string }>()).toEqual({ ok: true, outcome: 'ok' });

    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ops.run_retry'), eq(auditLog.entityId, failed!.id)))
      .limit(1);
    expect(audited).toBeTruthy();
    // The sweep really ran: ops_last now says it succeeded.
    const [last] = await ctx.db
      .select()
      .from(opsLast)
      .where(eq(opsLast.name, 'job:housekeeping.handoff'));
    expect(last!.lastOutcome).toBe('ok');
  });
});

describe('S2-03 — GET /ops/integrations', () => {
  it('names every outside service and what is unset, and no credential at all', async () => {
    const res = await get('/ops/integrations');
    expect(res.statusCode).toBe(200);

    /**
     * The whole point of the page, asserted on the raw body rather than on
     * the parsed one: not the value, not a fragment of it, not a masked
     * version. A masked secret on a screen is still a secret on a screen.
     */
    expect(res.body).not.toContain(TWILIO_SECRET);
    expect(res.body).not.toContain(TWILIO_SID);
    expect(res.body).not.toContain(ctx.app.env.MINIO_SECRET_KEY);

    const body = res.json<{
      providers: Array<{
        key: string;
        name: string;
        state: string;
        missingVars?: string[];
        detail?: string | null;
      }>;
      variables: Array<{ name: string; present: boolean; required: boolean; purpose: string }>;
    }>();

    const keys = body.providers.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['sms', 'storage', 'jobs', 'alerts', 'sentry']));

    // Derived from something real: a complete Twilio credential in the
    // environment, this process carrying the jobs role, no storage built.
    expect(body.providers.find((p) => p.key === 'sms')!.state).toBe('configured');
    expect(body.providers.find((p) => p.key === 'jobs')!.state).toBe('configured');
    expect(body.providers.find((p) => p.key === 'storage')!.state).toBe('disabled');

    const sentry = body.providers.find((p) => p.key === 'sentry')!;
    expect(sentry.state).toBe('disabled');
    // Names only — the variable that is unset, never a value.
    expect(sentry.missingVars).toEqual(['SENTRY_DSN']);

    const token = body.variables.find((v) => v.name === 'TWILIO_AUTH_TOKEN')!;
    expect(token.present).toBe(true);
    expect(Object.values(token).join(' ')).not.toContain(TWILIO_SECRET);

    const database = body.variables.find((v) => v.name === 'DATABASE_URL')!;
    expect(database.required).toBe(true);
  });

  /**
   * S2-17a. A lifted app is a dependency like any outside one: the launcher
   * shows a tile, somebody presses it, and when it is down the only honest
   * answer here is that it is down.
   *
   * The list comes from `HANDOFF_APP_ORIGINS` — the origins a hand-off token
   * may be spent at — so an app that can be signed into is an app that gets
   * reported, and nothing separate has to be kept in step. The test drives it
   * through the real environment value and a stubbed `fetch`, because what is
   * being defended is that a refusal reads as a refusal rather than silently
   * as health.
   */
  it('asks the other suite apps whether they are up, and says so when they are not', async () => {
    const origins = ctx.app.env.HANDOFF_APP_ORIGINS;
    const realFetch = globalThis.fetch;
    ctx.app.env.HANDOFF_APP_ORIGINS = 'oto_app=https://oto-app.example';

    try {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 503 })) as typeof globalThis.fetch;
      const down = (await get('/ops/integrations')).json<{
        providers: Array<{ key: string; state: string; endpoint?: string | null; detail?: string | null }>;
      }>();
      const app = down.providers.find((p) => p.key === 'oto_app')!;
      expect(app.state).toBe('degraded');
      expect(app.endpoint).toBe('https://oto-app.example');
      expect(app.detail).toContain('503');

      globalThis.fetch = (async () =>
        new Response('{"status":"ok"}', { status: 200 })) as typeof globalThis.fetch;
      const up = (await get('/ops/integrations')).json<{
        providers: Array<{ key: string; state: string }>;
      }>();
      expect(up.providers.find((p) => p.key === 'oto_app')!.state).toBe('configured');
    } finally {
      globalThis.fetch = realFetch;
      ctx.app.env.HANDOFF_APP_ORIGINS = origins;
    }
  });
});

describe('S2-03 — the staging-only controls', () => {
  it('tells the Console what exists rather than refusing the page', async () => {
    const platform = (await get('/ops/test-controls')).json<{
      available: boolean;
      controls: Array<{ key: string; label: string; sticky: boolean }>;
    }>();
    expect(platform.available).toBe(true);
    expect(platform.controls.map((c) => c.key)).toEqual(
      expect.arrayContaining(['watchdog.run', 'alert.test', 'job.fail', 'demo.day']),
    );

    // Reception is not platform-wide. The answer is "nothing for you", with a
    // 200 — so a page load by the staff who will never see this section does
    // not record a denial every thirty seconds.
    const staff = await get('/ops/test-controls', receptionCookie);
    expect(staff.statusCode).toBe(200);
    expect(staff.json<{ available: boolean; controls: unknown[] }>()).toEqual({
      available: false,
      controls: [],
    });
    expect((await post('/ops/test-controls/watchdog.run', receptionCookie)).statusCode).toBe(403);
    expect((await post('/ops/test-controls/nonsense')).statusCode).toBe(404);
  });

  it('adds the demo day once and refuses it without both staging and platform access', async () => {
    expect((await post('/ops/test-controls/demo.day', receptionCookie)).statusCode).toBe(403);
    const enabled = ctx.app.env.OPS_TEST_CONTROLS;
    try {
      ctx.app.env.OPS_TEST_CONTROLS = false;
      expect((await post('/ops/test-controls/demo.day')).statusCode).toBe(403);
    } finally { ctx.app.env.OPS_TEST_CONTROLS = enabled; }
    const first = await post('/ops/test-controls/demo.day');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ message: string }>().message).toContain('sales added');
    const again = await post('/ops/test-controls/demo.day');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<{ message: string }>().message).toContain('0 sales added');
    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'ops.test_control'));
    expect(rows.filter((r) => (r.after as { control?: string } | null)?.control === 'demo.day')).toHaveLength(2);
  });

  it('records a failed run that reaches the Failures page', async () => {
    const res = await post('/ops/test-controls/job.fail');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean; message: string }>().message).toContain('job:demo.fail');

    const failures = (await get('/ops/failures?windowHours=24&limit=200')).json<FailureBody>();
    const group = failures.groups.find((g) => g.name === 'job:demo.fail')!;
    expect(group, 'the control must produce a real failure record').toBeTruthy();
    expect(group.count).toBeGreaterThanOrEqual(1);

    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'ops.test_control'))
      .limit(1);
    expect(audited).toBeTruthy();
  });

  it('runs the watchdog, which then raises for the job that stopped', async () => {
    const res = await post('/ops/test-controls/watchdog.run');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ message: string }>().message).toContain('watchdog');

    const body = (await get('/ops/health')).json<HealthBody>();
    // The watchdog itself now has a success behind it, so the tile is real.
    expect(body.checks.find((c) => c.key === 'watchdog')!.status).toBe('ok');
    expect(body.watchdogAgeSeconds).not.toBeNull();
    // And the job declared late above is now an open alert rather than just a
    // stale row — the check that catches a silence.
    expect(body.alerts.some((a) => a.key === `ops.missing:${LATE_JOB}`)).toBe(true);
  });
});

describe('S2-03 — who may read any of this', () => {
  it('refuses a caller without admin:health:read, and one with no session', async () => {
    for (const url of ['/ops/health', '/ops/failures', '/ops/integrations', '/ops/runs?fingerprint=abcd']) {
      expect((await get(url, receptionCookie)).statusCode, url).toBe(403);
      const anonymous = await ctx.app.inject({ method: 'GET', url });
      expect(anonymous.statusCode, url).toBe(401);
    }
    /**
     * Managing is a second permission, not the same one — asked about a REAL
     * alert (SCRUM-281). The route now loads the row before it asks anything,
     * the way the quarantine pair does, so an id nobody owns answers 404
     * whoever sends it; a case built on `newId()` would pass on the absence of
     * a row rather than on the absence of a permission.
     */
    const [open] = await ctx.db
      .insert(alert)
      .values({
        id: newId(),
        key: 'ops.missing:job:permission-case',
        category: 'ops.missing',
        severity: 'warning',
        subject: 'job:permission-case',
        summary: 'a condition reception may read about and not act on',
      })
      .returning();
    expect((await post(`/ops/alerts/${open!.id}/acknowledge`, receptionCookie)).statusCode).toBe(403);
    const [still] = await ctx.db.select().from(alert).where(eq(alert.id, open!.id));
    expect(still!.status).toBe('open');
  });
});

/**
 * S2-04 — the boxes on Health, and the rules the watchdog raises about them.
 *
 * The page and the alert are asserted TOGETHER in most of these cases, on
 * purpose: they come out of one evaluation (`fleetHealth`), and the thing worth
 * defending is that they cannot tell two different stories about one box. A
 * case that only read the page would pass just as happily against two copies of
 * the rule quietly disagreeing.
 *
 * The subtle one, and the reason half of this block exists: a box that has gone
 * quiet is only raised DURING OPENING HOURS. Nobody is paged at three in the
 * morning about a park that is shut, and where nobody has said when the park
 * opens the rule does not fire at all.
 */
describe('S2-04 — boxes on Health and the fleet watchdog', () => {
  // Central Floresta's first box. A slot is unique per BRANCH, and since
  // SCRUM-289 there is a second operator whose only box sits in `virtual-1`
  // too — so the slot alone no longer names one box anywhere on the platform,
  // and every lookup below goes through the park-scoped helper.
  const BOX_SLOT = 'virtual-1';

  /**
   * Midnight to midnight. `withinOpeningHours` reads a close that is not after
   * the open as a day running past midnight, so this is the whole 24 hours and
   * the cases below do not depend on what time of day the suite runs.
   */
  const ALWAYS_OPEN = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [
      day,
      { open: '00:00', close: '00:00' },
    ]),
  );
  /** Hours that have been ANSWERED, with no day open — shut whenever this runs. */
  const ALWAYS_SHUT = {};

  let delivered: AlertMessage[];
  let channels: AlertChannel[];

  const watchdog = () =>
    runWatchdog({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });

  const theBox = async () => boxBySlot(ctx.db, BOX_SLOT);

  /**
   * By id, never by slot. Keyed on the slot this wrote to BOTH `virtual-1`
   * boxes, and the case below that sets a claim-code hash then collided with
   * itself on `box_claim_code_unique` — a fixture writing across a tenant
   * boundary, reported as a database error three assertions later.
   */
  const setBox = async (values: Partial<typeof box.$inferInsert>) =>
    ctx.db.update(box).set(values).where(eq(box.id, (await theBox()).id));

  /**
   * Every branch, not just the one under test.
   *
   * The watchdog sweeps every box on the platform, and the seed now has two
   * parks and a second operator's branch besides. If this only answered for
   * Central Floresta, the others would keep their real 10:00-20:00 and whether
   * their boxes were examined at all would depend on the wall clock at the
   * moment the suite ran — green in the morning, red in the evening. Setting
   * the hours everywhere is what makes the counts below mean one thing.
   */
  const setHours = (openingHours: unknown) =>
    ctx.db.update(branch).set({ openingHours: openingHours as never });

  /** The shape `recordHeartbeat` leaves on `box.last_status`. */
  const reported = (patch: Record<string, unknown> = {}) => ({
    reportedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    clockOffsetMs: 40,
    agentVersion: '0.1.0',
    uptimeS: 3_600,
    tempC: null,
    outboxDepth: 0,
    configVersion: 'ab12cd34ef567890',
    ...patch,
  });

  /** A box that registered and is calling home right now. */
  const callingHome = (patch: Record<string, unknown> = {}) =>
    setBox({
      status: 'online',
      registeredAt: new Date(Date.now() - 86_400_000),
      lastHeartbeatAt: new Date(),
      agentVersion: '0.1.0',
      lastStatus: reported(patch) as never,
    });

  /** The same box, which stopped saying anything half an hour ago. */
  const wentQuiet = () =>
    setBox({ status: 'online', lastHeartbeatAt: new Date(Date.now() - 1_800_000) });

  const boxesOn = async (): Promise<HealthBody['boxes']> =>
    (await get('/ops/health')).json<HealthBody>().boxes;

  const alertsOf = (key: string) => ctx.db.select().from(alert).where(eq(alert.key, key));

  beforeEach(async () => {
    delivered = [];
    channels = [
      {
        name: 'console',
        async deliver(message) {
          delivered.push(message);
          return { target: 'test' };
        },
      },
    ];
    // Every fleet alert is deleted rather than resolved: a resolved row inside
    // the flap window would be REOPENED silently, and a case that expects a
    // delivery would then be asserting the flap rule instead of its own rule.
    await ctx.db
      .delete(alert)
      .where(or(like(alert.key, 'box.%'), like(alert.key, 'device.%')));
    await setHours(ALWAYS_OPEN);
    await ctx.db
      .update(device)
      .set({ reachability: 'reachable', paperStatus: 'ok', lastError: null });
    await callingHome();
  });

  it('lists every box with its devices and vitals, and not one credential', async () => {
    // Real-looking credential columns, so "no credential is returned" is a
    // claim about the response rather than about a value that was never there.
    const secretHash = 'box-secret-hash-must-never-be-returned';
    const claimCodeHash = 'box-claim-code-hash-must-never-be-returned';
    await setBox({ secretHash, claimCodeHash });

    const res = await get('/ops/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(secretHash);
    expect(res.body).not.toContain(claimCodeHash);
    expect(res.body).not.toContain('secretHash');
    expect(res.body).not.toContain('claimCode');

    const [reception] = res.json<HealthBody>().boxes;
    expect(reception, 'Health must carry the fleet, not only the jobs').toBeTruthy();
    expect(reception!.name).toBe('Virtual box 1');
    expect(reception!.slot).toBe(BOX_SLOT);
    expect(reception!.state).toBe('ok');
    expect(reception!.openingHours).toBe('open');
    expect(reception!.agentVersion).toBe('0.1.0');
    expect(reception!.uptimeSeconds).toBe(3_600);
    expect(reception!.outboxDepth).toBe(0);
    expect(reception!.clockOffsetMs).toBe(40);
    expect(reception!.heartbeatAgeSeconds).toBeLessThan(60);
    expect(reception!.conditions).toEqual([]);

    // The park's devices, with the two indicators the Health page paints.
    const printer = reception!.devices.find((d) => d.label === 'Receipt Printer 1')!;
    expect(printer.kind).toBe('receipt_printer');
    expect(printer.reachability).toBe('reachable');
    expect(printer.paperStatus).toBe('ok');
    expect(reception!.devices.length).toBeGreaterThan(1);
  });

  it('a box that has gone quiet while the park is open is down, and raises box.offline', async () => {
    await wentQuiet();

    const key = `box.offline:${(await theBox()).id}`;
    const [quiet] = await boxesOn();
    // The page knows before the watchdog has run: same evaluation, same answer.
    expect(quiet!.state).toBe('down');
    expect(quiet!.conditions).toContain(key);
    expect(quiet!.detail).toContain('has not called home');

    const summary = await watchdog();
    /**
     * Every seeded box is examined — Central Floresta's two, Robinson
     * Chalong's, and the second operator's — because the watchdog is a
     * PLATFORM sweep: `fleetHealth` narrows to an operator only when it is
     * given one, and the scheduled job gives it none. That is deliberate;
     * nobody is on call for one tenant. It is stated as a number here so that
     * narrowing it later has to be a decision rather than a drift.
     */
    expect(summary.boxes).toBe((await ctx.db.select({ id: box.id }).from(box)).length);
    // But only ONE is moved to offline by this pass, and it stays one however
    // many parks exist: `boxesSilenced` counts boxes that WERE online and have
    // now gone quiet, which is the box this block drives. Virtual box 2 and
    // Virtual box 3 have never registered, so there is no online status to move
    // and nothing is expected of a box no agent has claimed.
    // The status column moves whatever the hour: that is a fact, not a judgement.
    expect(summary.boxesSilenced).toBe(1);
    expect((await theBox()).status).toBe('offline');

    const [raised] = await alertsOf(key);
    expect(raised!.status).toBe('open');
    expect(raised!.category).toBe('box.offline');
    expect(raised!.severity).toBe('critical');
    expect(raised!.summary).toContain('Virtual box 1');
    // Scoped, so it reaches the operator whose park it is and nobody else.
    expect(raised!.branchId).not.toBeNull();
    expect(raised!.operatorId).not.toBeNull();
    expect(delivered.filter((d) => d.key === key && d.event === 'opened')).toHaveLength(1);

    // Still quiet a minute later is the same condition, not a second alert.
    await watchdog();
    expect(await alertsOf(key)).toHaveLength(1);
    expect(delivered.filter((d) => d.key === key)).toHaveLength(1);

    // And the page's own verdict follows the box.
    expect((await get('/ops/health')).json<HealthBody>().status).toBe('down');
  });

  it('the box calling home again closes it, delivered as box.online', async () => {
    await wentQuiet();
    await watchdog();
    const key = `box.offline:${(await theBox()).id}`;
    expect((await alertsOf(key))[0]!.status).toBe('open');

    // What a heartbeat does to the row.
    await callingHome();
    const summary = await watchdog();
    expect(summary.resolved).toBeGreaterThanOrEqual(1);

    const [row] = await alertsOf(key);
    expect(row!.status).toBe('resolved');
    expect(row!.resolvedReason).toBe('recovered');
    const closing = delivered.filter((d) => d.key === key && d.event === 'resolved');
    expect(closing).toHaveLength(1);
    expect(closing[0]!.category).toBe('box.online');
    expect(closing[0]!.summary).toContain('calling home again');

    expect((await boxesOn())[0]!.state).toBe('ok');
  });

  it('the same silence outside opening hours raises nothing at all', async () => {
    await setHours(ALWAYS_SHUT);
    await wentQuiet();

    const key = `box.offline:${(await theBox()).id}`;
    await watchdog();
    expect(
      await alertsOf(key),
      'a park that is shut is not a park with a broken till',
    ).toHaveLength(0);
    expect(delivered).toHaveLength(0);

    const [shut] = await boxesOn();
    expect(shut!.openingHours).toBe('closed');
    // Shown, because the page is where somebody looks; not alerted, because an
    // alert at three in the morning teaches everyone to ignore alerts.
    expect(shut!.state).toBe('unknown');
    expect(shut!.detail).toContain('closed');
    expect(shut!.conditions).toEqual([]);
  });

  it('with no opening hours set the rule never fires, and the tile says why', async () => {
    await setHours(null);
    await wentQuiet();

    await watchdog();
    expect(await alertsOf(`box.offline:${(await theBox()).id}`)).toHaveLength(0);

    const [unanswered] = await boxesOn();
    expect(unanswered!.openingHours).toBe('not_set');
    // Not `unknown`: nobody has answered the question, and that is a gap
    // somebody has to close rather than a park that is simply shut.
    expect(unanswered!.state).toBe('warn');
    expect(unanswered!.detail).toContain('opening hours are not set');
  });

  it('a box still silent when the park closes is not recorded as having recovered', async () => {
    await wentQuiet();
    await watchdog();
    const key = `box.offline:${(await theBox()).id}`;
    expect((await alertsOf(key))[0]!.status).toBe('open');

    // 21:00. The box has not come back; the park has closed.
    await setHours(ALWAYS_SHUT);
    await watchdog();

    const [row] = await alertsOf(key);
    expect(row!.status).toBe('resolved');
    expect(row!.resolvedReason).toContain('closed');
    expect(row!.resolvedReason).not.toBe('recovered');
  });

  /**
   * The box corrects its clock (SCRUM-402), so the alert says what is true
   * now: how far out the machine's clock is, that the box has measured it and
   * corrects for it, and that the measurement is what to weigh (SCRUM-439).
   */
  it('a clock more than a minute out raises, says the box corrects for it, and clears when it comes back', async () => {
    await callingHome({
      clockOffsetMs: 121_000,
      clockMeasuredBy: 'box',
      clockMeasuredAt: new Date(Date.now() - 40_000).toISOString(),
    });
    const key = `box.clock:${(await theBox()).id}`;

    await watchdog();
    const [drifted] = await alertsOf(key);
    expect(drifted!.status).toBe('open');
    expect(drifted!.severity).toBe('warning');
    expect(drifted!.summary).toContain('121s ahead');
    expect(drifted!.summary).toMatch(/the box measured that 4\ds ago and corrects what it stamps/);
    expect(drifted!.summary).toContain('measurement going stale');
    expect(drifted!.summary).not.toContain('wrong business date');
    const detail = drifted!.detail as { clockMeasuredBy: string; clockMeasuredAgeSeconds: number };
    expect(detail.clockMeasuredBy).toBe('box');
    expect(detail.clockMeasuredAgeSeconds).toBeGreaterThanOrEqual(40);
    expect(detail.clockMeasuredAgeSeconds).toBeLessThan(50);
    expect((await boxesOn())[0]!.state).toBe('warn');

    await callingHome({ clockOffsetMs: -30_000 });
    await watchdog();
    expect((await alertsOf(key))[0]!.status).toBe('resolved');
  });

  it('a box that has not measured its clock is said to be stamping on its own clock until it does', async () => {
    // This side's computation from `reportedAt`, not a measurement the box declared.
    await callingHome({ clockOffsetMs: -7_200_000, clockMeasuredBy: 'platform' });
    const key = `box.clock:${(await theBox()).id}`;

    await watchdog();
    const [unmeasured] = await alertsOf(key);
    expect(unmeasured!.status).toBe('open');
    expect(unmeasured!.summary).toContain('7200s behind');
    expect(unmeasured!.summary).toContain('has not measured that yet');
    expect(unmeasured!.summary).toContain('dated by its own clock');
    expect(unmeasured!.summary).not.toContain('corrects what it stamps');
    expect((unmeasured!.detail as { clockMeasuredBy: string }).clockMeasuredBy).toBe('platform');
  });

  it('paper out and a device that did not answer raise per device, and stop when the box does', async () => {
    const [printer] = await ctx.db
      .select()
      .from(device)
      .where(eq(device.label, 'Receipt Printer 1'))
      .limit(1);
    const [scanner] = await ctx.db
      .select()
      .from(device)
      .where(eq(device.label, 'Scanner 1'))
      .limit(1);
    await ctx.db.update(device).set({ paperStatus: 'out' }).where(eq(device.id, printer!.id));
    await ctx.db
      .update(device)
      .set({ reachability: 'unreachable' })
      .where(eq(device.id, scanner!.id));

    await watchdog();
    const paperKey = `device.paper:${printer!.id}`;
    const unreachableKey = `device.unreachable:${scanner!.id}`;
    expect((await alertsOf(paperKey))[0]!.summary).toContain('out of paper');
    expect((await alertsOf(unreachableKey))[0]!.summary).toContain('did not answer');

    const [warned] = await boxesOn();
    expect(warned!.state).toBe('warn');
    expect(warned!.conditions).toEqual(expect.arrayContaining([paperKey, unreachableKey]));

    /**
     * And then the box itself goes quiet. Paper and reachability are only as
     * fresh as the last heartbeat, so calling a printer broken on the evidence
     * of a box we cannot hear from would be inventing a second fault out of the
     * first one.
     */
    await wentQuiet();
    await watchdog();
    expect((await alertsOf(paperKey))[0]!.status).toBe('resolved');
    expect((await alertsOf(unreachableKey))[0]!.status).toBe('resolved');
    expect((await alertsOf(`box.offline:${(await theBox()).id}`))[0]!.status).toBe('open');
  });

  /**
   * Paper does not wait for the doors to open, and a device that did not
   * answer does.
   *
   * A printer switched off for the night cannot be asked about its paper, so
   * `out` is only ever a printer that answered and said it has none — a fact
   * that is still true at ten in the morning, and one the morning shift can
   * act on before the first sale. Nobody can do anything about a printer that
   * is off, which is why the other half of this test is the opposite
   * assertion: the two rules disagree on purpose.
   */
  it('paper out is raised with the park shut; a device that did not answer is not', async () => {
    const [printer] = await ctx.db
      .select()
      .from(device)
      .where(eq(device.label, 'Receipt Printer 1'))
      .limit(1);
    const [scanner] = await ctx.db
      .select()
      .from(device)
      .where(eq(device.label, 'Scanner 1'))
      .limit(1);
    await setHours(ALWAYS_SHUT);
    await callingHome();
    await ctx.db.update(device).set({ paperStatus: 'out' }).where(eq(device.id, printer!.id));
    await ctx.db
      .update(device)
      .set({ reachability: 'unreachable' })
      .where(eq(device.id, scanner!.id));

    await watchdog();
    const paperKey = `device.paper:${printer!.id}`;
    const unreachableKey = `device.unreachable:${scanner!.id}`;
    expect(
      (await alertsOf(paperKey))[0]?.status,
      'a printer with no paper at 08:00 is a printer with no paper at 10:00',
    ).toBe('open');
    expect(await alertsOf(unreachableKey)).toHaveLength(0);

    const [shut] = await boxesOn();
    expect(shut!.openingHours).toBe('closed');
    expect(shut!.conditions).toEqual([paperKey]);
  });

  it('an agent below the minimum this build supports raises box.agent', async () => {
    const previous = process.env.BOX_MIN_AGENT_VERSION;
    process.env.BOX_MIN_AGENT_VERSION = '0.2.0';
    const key = `box.agent:${(await theBox()).id}`;
    try {
      await watchdog();
      const [old] = await alertsOf(key);
      expect(old!.status).toBe('open');
      expect(old!.summary).toContain('0.1.0');
      expect(old!.summary).toContain('0.2.0');
      expect((await boxesOn())[0]!.agentBelowMinimum).toBe(true);

      // The box is updated — or the floor is lowered again, which is the same
      // fact from the cloud's side.
      process.env.BOX_MIN_AGENT_VERSION = '0.1.0';
      await watchdog();
      expect((await alertsOf(key))[0]!.status).toBe('resolved');
      expect((await boxesOn())[0]!.agentBelowMinimum).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BOX_MIN_AGENT_VERSION;
      else process.env.BOX_MIN_AGENT_VERSION = previous;
    }
  });

  /**
   * SCRUM-445 — what a box reports in its heartbeat's `errors` is not one
   * kind of thing. A booth whose memory card failed used to be filed under
   * "could not apply part of its offline copy", with a sentence about its
   * till refusing to unlock offline, because the offline-copy rule read the
   * whole list. The three cases below pin the split: the store fault and the
   * wait for Reset the store each under their own heading, raised and cleared
   * by the heartbeat like every other box rule, and the offline-copy heading
   * left exactly as it was for the fault it was written for.
   */
  it('a store the box cannot use files it as needing service at the booth, and a healthy heartbeat clears it', async () => {
    // What `reportingStoreFault` (runner/runtime.ts) puts first in the list,
    // with the unsent records it copied out of the damaged file.
    await callingHome({
      errors: [{ fingerprint: 'store:damaged', code: 'box.store_damaged', count: 3 }],
      outboxDepth: 1,
    });
    const id = (await theBox()).id;
    const key = `box.needs_service:${id}`;

    // The page knows before the watchdog has run, under the new heading and
    // not the old one.
    const ailing = (await boxesOn()).find((b) => b.id === id)!;
    expect(ailing.state).toBe('warn');
    expect(ailing.conditions).toContain(key);
    expect(ailing.conditions).not.toContain(`box.cache_incomplete:${id}`);
    expect(ailing.detail).toBe(
      'Virtual box 1 (virtual-1) needs service at the booth: its store is damaged — it stays up and records nothing, and tries its memory card again every minute',
    );

    await watchdog();
    const [raised] = await alertsOf(key);
    expect(raised!.status).toBe('open');
    expect(raised!.category).toBe('box.needs_service');
    expect(raised!.severity).toBe('warning');
    expect(raised!.summary).toContain('needs service at the booth: its store is damaged');
    expect(raised!.detail).toMatchObject({ store: 'damaged', code: 'box.store_damaged', checks: 3 });
    expect(raised!.branchId).not.toBeNull();
    expect(await alertsOf(`box.cache_incomplete:${id}`)).toHaveLength(0);
    expect(delivered.filter((d) => d.key === key && d.event === 'opened')).toHaveLength(1);

    // And the Health page's alert list carries the same heading, with nothing
    // about an offline copy anywhere on it.
    const page = (await get('/ops/health')).json<HealthBody>();
    expect(page.alerts.find((a) => a.key === key)!.title).toContain('needs service at the booth');
    expect(page.alerts.map((a) => a.title).join('\n')).not.toContain('could not apply');

    // A store that could not be read is the same condition in the box's other
    // words — the row is bumped, not doubled.
    await callingHome({
      errors: [{ fingerprint: 'store:unreadable', code: 'box.store_unreadable', count: 7 }],
    });
    await watchdog();
    expect(await alertsOf(key)).toHaveLength(1);
    const [reread] = await alertsOf(key);
    expect(reread!.summary).toContain('needs service at the booth: its store could not be read');
    expect(reread!.detail).toMatchObject({ store: 'unreadable', checks: 7 });

    // The card recovered, or the Pi was claimed as a new box: the next
    // heartbeat carries no store fault, and the alert closes as recovered.
    await callingHome();
    await watchdog();
    const [closed] = await alertsOf(key);
    expect(closed!.status).toBe('resolved');
    expect(closed!.resolvedReason).toBe('recovered');
    const closing = delivered.filter((d) => d.key === key && d.event === 'resolved');
    expect(closing).toHaveLength(1);
    expect(closing[0]!.summary).toContain('is running on its store again');
    expect((await boxesOn()).find((b) => b.id === id)!.state).toBe('ok');
  });

  it('a box waiting for Reset the store says so under its own heading, and the reset clears it', async () => {
    // What `journalFaultReports` (agent.ts) sends for a box claimed again onto a new store.
    await callingHome({
      errors: [{ fingerprint: 'journal:awaiting_epoch', code: 'box.journal_awaiting_epoch', count: 5 }],
    });
    const id = (await theBox()).id;
    const key = `box.awaiting_reset:${id}`;

    const waiting = (await boxesOn()).find((b) => b.id === id)!;
    expect(waiting.state).toBe('warn');
    expect(waiting.conditions).toContain(key);
    expect(waiting.conditions).not.toContain(`box.cache_incomplete:${id}`);
    expect(waiting.conditions).not.toContain(`box.needs_service:${id}`);
    expect(waiting.detail).toBe(
      'Virtual box 1 (virtual-1) is waiting for Reset the store — it was claimed again onto a new store and records nothing until the reset gives it a new journal epoch',
    );

    await watchdog();
    const [raised] = await alertsOf(key);
    expect(raised!.status).toBe('open');
    expect(raised!.category).toBe('box.awaiting_reset');
    expect(raised!.severity).toBe('warning');
    expect(raised!.summary).toContain('is waiting for Reset the store');
    expect(raised!.detail).toMatchObject({ refused: 5 });
    expect(await alertsOf(`box.cache_incomplete:${id}`)).toHaveLength(0);

    // The reset landed: the box has its epoch and stops reporting the wait.
    await callingHome();
    await watchdog();
    const [closed] = await alertsOf(key);
    expect(closed!.status).toBe('resolved');
    expect(closed!.resolvedReason).toBe('reset');
    expect(
      delivered.filter((d) => d.key === key && d.event === 'resolved')[0]!.summary,
    ).toContain('has its new journal epoch and is recording again');
  });

  it('a scope of the offline copy that did not land still reads as an incomplete offline copy, even beside a store fault', async () => {
    // What `recordCacheFault` (agent.ts) sends: `<reason>:<scope>`, coded `box.cache_<reason>`.
    const staffScope = { fingerprint: 'unreadable:staff', code: 'box.cache_unreadable', count: 2 };
    await callingHome({ errors: [staffScope] });
    const id = (await theBox()).id;
    const cacheKey = `box.cache_incomplete:${id}`;

    const incomplete = (await boxesOn()).find((b) => b.id === id)!;
    expect(incomplete.conditions).toContain(cacheKey);
    expect(incomplete.conditions).not.toContain(`box.needs_service:${id}`);
    expect(incomplete.conditions).not.toContain(`box.awaiting_reset:${id}`);
    expect(incomplete.detail).toBe(
      'Virtual box 1 (virtual-1) could not apply part of its offline copy (box.cache_unreadable) — until it pulls a complete one, its till refuses to unlock offline',
    );

    await watchdog();
    const [raised] = await alertsOf(cacheKey);
    expect(raised!.status).toBe('open');
    expect(raised!.category).toBe('box.cache_incomplete');
    expect(raised!.detail).toMatchObject({ faults: [staffScope], occurrences: 2 });
    expect(await alertsOf(`box.needs_service:${id}`)).toHaveLength(0);

    // Both at once — a damaged store on a box that had also missed a scope:
    // two headings, and the offline-copy line names only its own code.
    await callingHome({
      errors: [{ fingerprint: 'store:damaged', code: 'box.store_damaged', count: 1 }, staffScope],
    });
    const both = (await boxesOn()).find((b) => b.id === id)!;
    expect(both.conditions).toContain(`box.needs_service:${id}`);
    expect(both.conditions).toContain(cacheKey);
    await watchdog();
    const [bumped] = await alertsOf(cacheKey);
    expect(bumped!.summary).toContain('(box.cache_unreadable)');
    expect(bumped!.summary).not.toContain('box.store_damaged');
    expect((await alertsOf(`box.needs_service:${id}`))[0]!.status).toBe('open');
  });

  it('a box nobody has registered, and one taken out of service, raise nothing', async () => {
    // What the seed leaves behind: a row with a slot, waiting for its Pi.
    await setBox({ registeredAt: null, status: 'unclaimed', lastHeartbeatAt: null, lastStatus: null });
    await watchdog();
    expect(delivered).toHaveLength(0);
    const [unclaimed] = await boxesOn();
    expect(unclaimed!.state).toBe('unknown');
    expect(unclaimed!.detail).toContain('claim code');

    await setBox({
      registeredAt: new Date(Date.now() - 86_400_000),
      status: 'disabled',
      lastHeartbeatAt: new Date(Date.now() - 86_400_000),
    });
    await watchdog();
    expect(delivered).toHaveLength(0);
    const [disabled] = await boxesOn();
    expect(disabled!.state).toBe('unknown');
    expect(disabled!.detail).toContain('out of service');
    // And the status a person set is never moved by the sweep.
    expect((await theBox()).status).toBe('disabled');
  });

  it('offers the fleet test controls, and says so when there is no box here to stop', async () => {
    const { controls } = (await get('/ops/test-controls')).json<{
      controls: Array<{ key: string; label: string; sticky: boolean }>;
    }>();
    expect(controls.map((c) => c.key)).toEqual(
      expect.arrayContaining([
        'box.heartbeats.stop',
        'box.heartbeats.start',
        'box.clock.advance',
        'box.clock.reset',
      ]),
    );
    expect(controls.find((c) => c.key === 'box.heartbeats.stop')!.label).toBe('Stop heartbeats');

    /**
     * This process does not carry the `edge` role, so there is no virtual box
     * inside it. A control that quietly reported success would be the exact
     * failure the whole ticket is about.
     */
    const res = await post('/ops/test-controls/box.heartbeats.stop');
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VIRTUAL_BOX_ABSENT');
    expect((await post('/ops/test-controls/box.clock.advance', receptionCookie)).statusCode).toBe(403);
  });
});
