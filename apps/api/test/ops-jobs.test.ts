import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alert,
  alertDelivery,
  box,
  boxHeartbeat,
  handoffToken,
  idempotencyKey,
  opsExpectation,
  opsLast,
  opsRun,
  session as sessionTable,
} from '@oto/db';
import { newId } from '@oto/shared';
import {
  createJobRunner,
  runWatchdog,
  scheduleLockId,
  WATCHDOG_JOB,
  type JobDefinition,
  type JobRunner,
} from '../src/services/jobs';
import {
  buildAlertChannels,
  errorFingerprint,
  recordRun,
  scrubDetail,
  type AlertChannel,
  type AlertMessage,
} from '../src/services/ops';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-03 — the operational record and the job runner.
 *
 * What these cases are really defending: that a failure cannot happen quietly.
 * A job that throws must leave a row behind and leave the runner standing; two
 * instances must not run one schedule twice; and a job that stops running
 * altogether — the failure no `try/catch` anywhere can see — must raise an
 * alert once, not once a minute, and stand itself down when it recovers.
 */

let ctx: TestContext;
/** Every alert the channels were asked to deliver, in order. */
let delivered: AlertMessage[];
let channels: AlertChannel[];

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs' } });
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
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

beforeEach(() => {
  delivered.length = 0;
});

const runnerWith = (jobs: JobDefinition[]): JobRunner =>
  createJobRunner({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, jobs, channels });

const runsOf = (name: string) =>
  ctx.db.select().from(opsRun).where(eq(opsRun.name, name)).orderBy(desc(opsRun.startedAt));

const lastOf = (name: string) =>
  ctx.db
    .select()
    .from(opsLast)
    .where(eq(opsLast.name, name))
    .limit(1)
    .then((r) => r[0]);

const alertsOf = (key: string) =>
  ctx.db.select().from(alert).where(eq(alert.key, key)).orderBy(desc(alert.lastSeenAt));

describe('S2-03 — a job that works, and a job that does not', () => {
  it('a job that succeeds records a run and brings ops_last up to date', async () => {
    let ran = 0;
    const runner = runnerWith([
      {
        name: 'job:test.ok',
        description: 'Succeeds',
        intervalSeconds: 3600,
        run: async () => {
          ran += 1;
          return { detail: { swept: 7 } };
        },
      },
    ]);

    expect(await runner.runJob('job:test.ok')).toBe('ok');
    expect(ran).toBe(1);

    const runs = await runsOf('job:test.ok');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.kind).toBe('job');
    expect(runs[0]!.detail).toEqual({ swept: 7 });
    expect(runs[0]!.errorCode).toBeNull();
    expect(runs[0]!.durationMs).toBeGreaterThanOrEqual(0);

    const last = await lastOf('job:test.ok');
    expect(last!.lastOutcome).toBe('ok');
    expect(last!.lastOkAt).not.toBeNull();
    expect(last!.consecutiveFailures).toBe(0);
  });

  it('a job that throws records a failure and leaves the runner standing', async () => {
    let good = 0;
    const runner = runnerWith([
      {
        name: 'job:test.fail',
        description: 'Throws every time',
        intervalSeconds: 3600,
        run: async () => {
          throw new Error('forced failure');
        },
      },
      {
        name: 'job:test.after',
        description: 'Runs after the failing one',
        intervalSeconds: 3600,
        run: async () => {
          good += 1;
        },
      },
    ]);

    // runDue must not abandon the pass because the first job threw.
    const outcomes = await runner.runDue();
    expect(outcomes['job:test.fail']).toBe('failed');
    expect(outcomes['job:test.after']).toBe('ok');
    expect(good).toBe(1);

    const runs = await runsOf('job:test.fail');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('failed');
    expect(runs[0]!.errorCode).toBe('Error');
    expect(runs[0]!.errorMessage).toBe('forced failure');
    expect(runs[0]!.fingerprint).toBe(errorFingerprint('job', 'job:test.fail', 'Error'));

    const last = await lastOf('job:test.fail');
    expect(last!.lastOutcome).toBe('failed');
    expect(last!.consecutiveFailures).toBe(1);
    expect(last!.lastFailedAt).not.toBeNull();
    expect(last!.lastOkAt).toBeNull();
  });

  it('a failure count climbs and a success clears it, keeping the last good time', async () => {
    const name = 'job:test.flaky';
    let fail = true;
    const runner = runnerWith([
      {
        name,
        description: 'Fails twice, then succeeds',
        intervalSeconds: 3600,
        run: async () => {
          if (fail) throw new Error('still broken');
        },
      },
    ]);

    await runner.runJob(name, { force: true });
    await runner.runJob(name, { force: true });
    expect((await lastOf(name))!.consecutiveFailures).toBe(2);

    fail = false;
    await runner.runJob(name, { force: true });
    const last = await lastOf(name);
    expect(last!.consecutiveFailures).toBe(0);
    expect(last!.lastOkAt).not.toBeNull();
    // The failure is still on the row: "it broke at 14:02 and last worked at
    // 09:15" is the sentence Health has to be able to say.
    expect(last!.lastFailedAt).not.toBeNull();
  });

  it('a job with no jobs role in this process does nothing at all', async () => {
    const apiOnly = createJobRunner({
      db: ctx.db,
      env: { ...ctx.app.env, PROCESS_ROLES: 'api,edge' },
      log: ctx.app.log,
      channels,
      jobs: [
        {
          name: 'job:test.disabled',
          description: 'Never runs here',
          intervalSeconds: 60,
          run: async () => {
            throw new Error('this must never run');
          },
        },
      ],
    });
    expect(apiOnly.enabled).toBe(false);
    expect(await apiOnly.runJob('job:test.disabled')).toBe('disabled');
    expect(await runsOf('job:test.disabled')).toHaveLength(0);
  });
});

describe('S2-03 — one schedule, however many instances', () => {
  it('two runners racing the same schedule execute it once', async () => {
    let ran = 0;
    const job: JobDefinition = {
      name: 'job:test.race',
      description: 'Counts its own runs',
      intervalSeconds: 3600,
      run: async () => {
        ran += 1;
        // Long enough that the second claim is genuinely concurrent.
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    };
    // Two runners on one database is what two Render instances are.
    const a = runnerWith([job]);
    const b = runnerWith([{ ...job }]);

    const outcomes = await Promise.all([a.runJob(job.name), b.runJob(job.name)]);
    expect(ran).toBe(1);
    expect(await runsOf(job.name)).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    // Two ways to lose, and both are correct: the loser either found the lock
    // held, or found the tick already claimed. The claim is the durable half —
    // it is what makes the answer survive the process that gave it.
    expect(['locked', 'not_due']).toContain(outcomes.find((o) => o !== 'ok'));

    // And the loser does not simply run it a moment later.
    expect(await b.runJob(job.name)).toBe('not_due');
    expect(ran).toBe(1);
  });

  it('an instance that cannot take the schedule lock stands down', async () => {
    let ran = 0;
    const name = 'job:test.locked';
    const runner = runnerWith([
      {
        name,
        description: 'Must not run while another instance holds the lock',
        intervalSeconds: 3600,
        run: async () => {
          ran += 1;
        },
      },
    ]);

    // Stand in for the other instance: hold the job's own advisory lock in an
    // open transaction, so the collision is arranged rather than hoped for.
    const [namespace, key] = scheduleLockId(name);
    let acquired!: () => void;
    let release!: () => void;
    const gotLock = new Promise<void>((resolve) => (acquired = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${namespace}::int4, ${key}::int4)`);
      acquired();
      await held;
    });
    await gotLock;

    expect(await runner.runJob(name)).toBe('locked');
    expect(ran).toBe(0);
    expect(await runsOf(name)).toHaveLength(0);

    release();
    await holder;
    expect(await runner.runJob(name)).toBe('ok');
    expect(ran).toBe(1);
  });

  it('a due job runs again once its interval has passed', async () => {
    let ran = 0;
    const runner = runnerWith([
      {
        name: 'job:test.due',
        description: 'Runs every two seconds',
        intervalSeconds: 2,
        run: async () => {
          ran += 1;
        },
      },
    ]);

    expect(await runner.runJob('job:test.due')).toBe('ok');
    expect(await runner.runJob('job:test.due')).toBe('not_due');
    // Age the claim rather than waiting on the clock.
    await ctx.db
      .update(opsLast)
      .set({ lastStartedAt: new Date(Date.now() - 10_000) })
      .where(eq(opsLast.name, 'job:test.due'));
    expect(await runner.runJob('job:test.due')).toBe('ok');
    expect(ran).toBe(2);
  });

  it('start() registers an expectation for every job without overwriting operator choices', async () => {
    const runner = runnerWith([
      {
        name: 'job:test.registered',
        description: 'Has an expectation',
        intervalSeconds: 600,
        graceSeconds: 120,
        severity: 'critical',
        run: async () => {},
      },
    ]);
    await runner.start();
    await runner.stop();

    const [expectation] = await ctx.db
      .select()
      .from(opsExpectation)
      .where(eq(opsExpectation.name, 'job:test.registered'));
    expect(expectation!.intervalSeconds).toBe(600);
    expect(expectation!.graceSeconds).toBe(120);
    expect(expectation!.severity).toBe('critical');

    // Someone turns it off on the Console; a redeploy must not turn it back on.
    await ctx.db
      .update(opsExpectation)
      .set({ enabled: false })
      .where(eq(opsExpectation.name, 'job:test.registered'));
    await runner.start();
    await runner.stop();
    const [after] = await ctx.db
      .select()
      .from(opsExpectation)
      .where(eq(opsExpectation.name, 'job:test.registered'));
    expect(after!.enabled).toBe(false);
  });
});

describe('S2-03 — the watchdog', () => {
  const name = 'job:test.silent';
  const key = `ops.missing:${name}`;
  const deps = () => ({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });

  beforeEach(async () => {
    await ctx.db.delete(alert).where(eq(alert.key, key));
    await ctx.db.delete(opsExpectation).where(eq(opsExpectation.name, name));
    await ctx.db.delete(opsLast).where(eq(opsLast.name, name));
    await ctx.db.insert(opsExpectation).values({
      name,
      kind: 'job',
      description: 'Expected every minute',
      intervalSeconds: 60,
      graceSeconds: 30,
      severity: 'warning',
      // Registered an hour ago: nothing has run it since, which is the point.
      createdAt: new Date(Date.now() - 3_600_000),
    });
  });

  it('raises for something that should have run and did not, exactly once', async () => {
    const first = await runWatchdog(deps());
    expect(first.missing).toBeGreaterThanOrEqual(1);
    expect(first.opened).toBeGreaterThanOrEqual(1);

    const opened = await alertsOf(key);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.status).toBe('open');
    expect(opened[0]!.occurrences).toBe(1);
    expect(delivered.filter((d) => d.key === key)).toHaveLength(1);

    // A minute later the condition is still true. It must not become a second
    // alert, and it must not be delivered again.
    await runWatchdog(deps());
    const still = await alertsOf(key);
    expect(still).toHaveLength(1);
    expect(still[0]!.occurrences).toBe(2);
    expect(delivered.filter((d) => d.key === key)).toHaveLength(1);
  });

  it('resolves when the thing runs again, and tells whoever was told it broke', async () => {
    await runWatchdog(deps());
    expect((await alertsOf(key))[0]!.status).toBe('open');

    await recordRun(ctx.db, { kind: 'job', name, outcome: 'ok', startedAt: new Date() });
    const summary = await runWatchdog(deps());
    expect(summary.resolved).toBeGreaterThanOrEqual(1);

    const [row] = await alertsOf(key);
    expect(row!.status).toBe('resolved');
    expect(row!.resolvedReason).toBe('recovered');
    expect(delivered.filter((d) => d.key === key && d.event === 'resolved')).toHaveLength(1);
  });

  it('a condition that comes straight back reuses its alert and stays quiet', async () => {
    await runWatchdog(deps());
    await recordRun(ctx.db, { kind: 'job', name, outcome: 'ok', startedAt: new Date() });
    await runWatchdog(deps());
    delivered.length = 0;

    // Broken again a moment later: within ALERT_FLAP_WINDOW_S, so it is the
    // same condition oscillating rather than a new incident.
    await ctx.db
      .update(opsLast)
      .set({ lastOkAt: new Date(Date.now() - 3_600_000) })
      .where(eq(opsLast.name, name));
    await runWatchdog(deps());

    const rows = await alertsOf(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.reopenCount).toBe(1);
    expect(delivered.filter((d) => d.key === key)).toHaveLength(0);
  });

  it('raises for a job that runs faithfully and fails every time', async () => {
    const failing = 'job:test.always-fails';
    const failKey = `ops.failing:${failing}`;
    await ctx.db.delete(alert).where(eq(alert.key, failKey));
    // Declaring the expectation is how something asks to be alerted on; the
    // runner does this itself in start().
    await ctx.db
      .insert(opsExpectation)
      .values({ name: failing, kind: 'job', intervalSeconds: 3600, graceSeconds: 3600 })
      .onConflictDoNothing();
    const runner = runnerWith([
      {
        name: failing,
        description: 'Fails on purpose',
        intervalSeconds: 3600,
        run: async () => {
          throw new Error('demo failure');
        },
      },
    ]);
    for (let i = 0; i < ctx.app.env.ALERT_FAILURE_THRESHOLD; i += 1) {
      await runner.runJob(failing, { force: true });
    }

    await runWatchdog(deps());
    const [row] = await alertsOf(failKey);
    expect(row!.status).toBe('open');
    expect(row!.category).toBe('ops.failing');
    expect(row!.summary).toContain('failed');
    expect(delivered.filter((d) => d.key === failKey)).toHaveLength(1);
  });

  it('records each delivery attempt, including one that fails', async () => {
    const broken: AlertChannel = {
      name: 'console',
      async deliver() {
        throw new Error('channel unreachable');
      },
    };
    await runWatchdog({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels: [broken] });

    const [row] = await alertsOf(key);
    const deliveries = await ctx.db
      .select()
      .from(alertDelivery)
      .where(eq(alertDelivery.alertId, row!.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('failed');
    expect(deliveries[0]!.error).toContain('channel unreachable');
    // Nobody was told, so the row must not claim otherwise.
    expect(row!.lastNotifiedAt).toBeNull();
  });
});

describe('S2-03 — the sweeps that had never run', () => {
  it('the housekeeping jobs delete expired idempotency keys and hand-off tokens', async () => {
    const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect(cookie).toBeTruthy();
    const [account] = await ctx.db
      .select({ id: sessionTable.accountId, sessionId: sessionTable.id })
      .from(sessionTable)
      .limit(1);

    const staleKey = `sweep-${newId()}`;
    await ctx.db.insert(idempotencyKey).values({
      key: staleKey,
      accountId: account!.id,
      requestHash: 'x',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const staleJti = newId();
    await ctx.db.insert(handoffToken).values({
      jti: staleJti,
      sessionId: account!.sessionId,
      accountId: account!.id,
      audience: 'pos',
      audienceOrigin: 'https://example.test',
      keyId: 'k1',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const runner = createJobRunner({
      db: ctx.db,
      env: ctx.app.env,
      log: ctx.app.log,
      channels,
    });
    expect(runner.jobs.map((j) => j.name)).toContain('job:housekeeping.idempotency');
    expect(await runner.runJob('job:housekeeping.idempotency', { force: true })).toBe('ok');
    expect(await runner.runJob('job:housekeeping.handoff', { force: true })).toBe('ok');

    expect(
      await ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, staleKey)),
    ).toHaveLength(0);
    expect(
      await ctx.db.select().from(handoffToken).where(eq(handoffToken.jti, staleJti)),
    ).toHaveLength(0);

    const [swept] = await runsOf('job:housekeeping.idempotency');
    expect(swept!.outcome).toBe('ok');
    expect((swept!.detail as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
  });

  it('retention ages out old runs and resolved alerts, and leaves open ones alone', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    await recordRun(ctx.db, {
      kind: 'job',
      name: 'job:test.ancient',
      outcome: 'ok',
      startedAt: old,
      finishedAt: old,
    });
    const openKey = `ops.missing:job:test.kept-${newId()}`;
    await ctx.db.insert(alert).values({
      id: newId(),
      key: openKey,
      category: 'ops.missing',
      subject: 'kept',
      summary: 'Still open, however old',
      firstSeenAt: old,
      lastSeenAt: old,
    });
    const resolvedKey = `ops.missing:job:test.gone-${newId()}`;
    await ctx.db.insert(alert).values({
      id: newId(),
      key: resolvedKey,
      category: 'ops.missing',
      status: 'resolved',
      subject: 'gone',
      summary: 'Resolved long ago',
      firstSeenAt: old,
      lastSeenAt: old,
      resolvedAt: old,
      resolvedReason: 'recovered',
    });

    /**
     * And the box heartbeats, which are the fastest-growing rows in the
     * database — one a minute per box, forever (S2-04). The sweep that already
     * ages out runs and resolved alerts is where they belong: three deletes on
     * one hourly schedule rather than a fourth job nobody remembers to
     * register.
     */
    const [seededBox] = await ctx.db.select().from(box).limit(1);
    await ctx.db.insert(boxHeartbeat).values([
      { id: newId(), boxId: seededBox!.id, receivedAt: new Date(Date.now() - 30 * 86_400_000) },
      { id: newId(), boxId: seededBox!.id, receivedAt: new Date() },
    ]);

    const runner = createJobRunner({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });
    expect(await runner.runJob('job:housekeeping.retention', { force: true })).toBe('ok');

    expect(await runsOf('job:test.ancient')).toHaveLength(0);
    expect(await alertsOf(resolvedKey)).toHaveLength(0);
    expect(await alertsOf(openKey)).toHaveLength(1);

    const kept = await ctx.db.select().from(boxHeartbeat);
    expect(kept).toHaveLength(1);
    expect(Date.now() - kept[0]!.receivedAt.getTime()).toBeLessThan(60_000);
    const [swept] = await runsOf('job:housekeeping.retention');
    expect((swept!.detail as { heartbeatsDeleted: number }).heartbeatsDeleted).toBe(1);
  });

  it('publishes the watchdog age /ready reports', async () => {
    const runner = createJobRunner({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });
    await ctx.db.delete(opsLast).where(eq(opsLast.name, WATCHDOG_JOB));
    expect(await runner.watchdogAgeSeconds()).toBeNull();

    await recordRun(ctx.db, {
      kind: 'job',
      name: WATCHDOG_JOB,
      outcome: 'ok',
      startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 120_000),
    });
    const age = await runner.watchdogAgeSeconds();
    expect(age).toBeGreaterThanOrEqual(110);
  });
});

describe('S2-03 — nothing personal reaches the operational record', () => {
  it('scrubs the keys the logging contract names, at any depth', () => {
    const scrubbed = scrubDetail({
      phone: '+66811111111',
      member: { name: 'Mali', nickname: 'M', allergies: 'peanuts', medical_notes: 'asthma' },
      counts: { swept: 3 },
      children: [{ name: 'Nong', dateOfBirth: '2019-04-02' }],
    }) as Record<string, Record<string, unknown>>;

    expect(scrubbed.phone).toBe('[redacted]');
    expect(scrubbed.member!.name).toBe('[redacted]');
    expect(scrubbed.member!.nickname).toBe('[redacted]');
    expect(scrubbed.member!.allergies).toBe('[redacted]');
    expect(scrubbed.member!.medical_notes).toBe('[redacted]');
    expect((scrubbed.children as unknown as Array<Record<string, unknown>>)[0]!.name).toBe('[redacted]');
    expect(scrubbed.counts!.swept).toBe(3);
    expect(JSON.stringify(scrubbed)).not.toContain('+66811111111');
  });

  it('keeps a unique violation out of the run it records', async () => {
    // What Postgres puts in `detail` is `Key (phone)=(+66…) already exists`.
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 'member_phone_unique',
      detail: 'Key (phone)=(+66811111111) already exists.',
      table: 'member',
    });
    await recordRun(ctx.db, {
      kind: 'http',
      name: 'http:POST /members',
      outcome: 'failed',
      startedAt: new Date(),
      error: pgError,
      detail: { phone: '+66811111111' },
    });

    const [row] = await runsOf('http:POST /members');
    expect(row!.errorCode).toBe('pg:23505');
    expect(row!.errorMessage).toContain('member_phone_unique');
    expect(JSON.stringify(row)).not.toContain('+66811111111');
  });

  it('refuses an alert channel it has no implementation for', () => {
    expect(() => buildAlertChannels('console', ctx.app.log)).not.toThrow();
    expect(() => buildAlertChannels('console,webhook', ctx.app.log)).toThrow(/webhook/);
  });

  it('an alert is deduped by the database, not by the caller', async () => {
    const key = `ops.failing:job:test.dedupe-${newId()}`;
    const id = newId();
    await ctx.db.insert(alert).values({
      id,
      key,
      category: 'ops.failing',
      subject: 'dedupe',
      summary: 'first',
    });
    // Drizzle wraps the driver error, so the SQLSTATE is on the cause.
    const refused = await ctx.db
      .insert(alert)
      .values({ id: newId(), key, category: 'ops.failing', subject: 'dedupe', summary: 'second' })
      .then(() => null)
      .catch((err: { cause?: { code?: string; constraint?: string } }) => err.cause);
    expect(refused?.code).toBe('23505');
    expect(refused?.constraint).toBe('alert_open_key_unique');

    // Resolved, the key is free again — the index is partial on purpose.
    await ctx.db
      .update(alert)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(alert.id, id));
    await ctx.db.insert(alert).values({
      id: newId(),
      key,
      category: 'ops.failing',
      subject: 'dedupe',
      summary: 'second',
    });
    expect(
      await ctx.db.select().from(alert).where(and(eq(alert.key, key), sql`resolved_at is null`)),
    ).toHaveLength(1);
  });
});
