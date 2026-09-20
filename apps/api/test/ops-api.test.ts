import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alert, auditLog, opsExpectation, opsLast, opsRun } from '@oto/db';
import { newId } from '@oto/shared';
import { recordRun } from '../src/services/ops';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

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
});

describe('S2-03 — the staging-only controls', () => {
  it('tells the Console what exists rather than refusing the page', async () => {
    const platform = (await get('/ops/test-controls')).json<{
      available: boolean;
      controls: Array<{ key: string; label: string; sticky: boolean }>;
    }>();
    expect(platform.available).toBe(true);
    expect(platform.controls.map((c) => c.key)).toEqual(
      expect.arrayContaining(['watchdog.run', 'alert.test', 'job.fail']),
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
    // Managing is a second permission, not the same one.
    expect((await post(`/ops/alerts/${newId()}/acknowledge`, receptionCookie)).statusCode).toBe(403);
  });
});
