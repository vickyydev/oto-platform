import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { alert, alertDelivery, branch, operator, opsExpectation, opsLast, opsRun, paymentAttempt, station } from '@oto/db';
import { newId } from '@oto/shared';
import { loadEnv, type Env } from '../src/env';
import { operatorBranches } from '../src/services/analytics-summary';
import { overviewForScopeOf } from '../src/services/console';
import type { DigestSender } from '../src/services/console-digest';
import { buildDefaultJobs, createJobRunner, runWatchdog, type JobDefinition } from '../src/services/jobs';
import type { AlertMessage } from '../src/services/ops';
import { createTestContext, teardownAll, type TestContext } from './helpers';

const JOB = 'job:console.digest', OTHER = 'job:zz-test-637-unrelated';
const names = [JOB, 'console.digest.intent', 'console.digest.delivery'];
const keys = [`ops.missing:${JOB}`, `ops.failing:${JOB}`, `ops.missing:${OTHER}`];
const destination = 'https://example.invalid/zz-test-digest?synthetic=zz-test-private-destination';
const now = new Date('2026-10-26T02:30:00.000Z');
const owner = newId(), park = newId(), till = newId();
const forbiddenFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('ZZ_TEST_EXTERNAL_FETCH_REFUSED'));
let ctx: TestContext;

// New config names are supplied as data, not imported symbols absent on the RED source.
const envOf = (extra: Record<string, string | undefined> = {}): Env => loadEnv({ NODE_ENV: 'test', DEPLOY_ENV: 'local', ...extra });
const enabledEnv = () => envOf({ CONSOLE_DIGEST_ENABLED: 'true', ALERT_WEBHOOK_URL: destination,
  PROCESS_ROLES: 'api,jobs', ROLLUP_INTERVAL_S: '73', PAYMENT_PENDING_MIN: '60' });
const sender = () => vi.fn<DigestSender>().mockResolvedValue({ state: 'accepted', status: 202 });
const definitions = (env: Env, send?: DigestSender) => {
  const deps = { db: ctx.db, env, log: ctx.app.log, channels: [], ...(send ? { consoleDigestSender: send } : {}) };
  return buildDefaultJobs(deps);
};
function digestJob(env: Env, send: DigestSender): JobDefinition {
  const matches = definitions(env, send).filter(job => job.name === JOB);
  expect(matches).toHaveLength(1);
  if (!matches[0]) throw new Error('ZZ_TEST_DIGEST_REGISTRATION_MISSING');
  return matches[0];
}
const records = () => ctx.db.select().from(opsRun).where(inArray(opsRun.name, names));
function privateConfigRefusal(extra: Record<string, string>) {
  let errorText = '', rejected = false;
  try { envOf(extra); } catch (error) { rejected = true; errorText = error instanceof Error ? error.message : String(error); }
  expect(rejected).toBe(true);
  expect(errorText.includes('zz-test-private-destination')).toBe(false);
  expect(errorText.includes(destination)).toBe(false);
}

beforeAll(async () => {
  // This precedes bootstrap and every possible job/adapter construction, even on the failing source.
  vi.stubGlobal('fetch', forbiddenFetch);
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  await ctx.db.update(operator).set({ archivedAt: now });
  await ctx.db.insert(operator).values({ id: owner, name: 'ZZ TEST 637 registration operator' });
  await ctx.db.insert(branch).values({ id: park, operatorId: owner, name: 'ZZ TEST 637 registration park',
    code: 'zz-test-637-registration', timezone: 'UTC', businessDayStart: '00:00' });
  await ctx.db.insert(station).values({ id: till, operatorId: owner, branchId: park, name: 'ZZ TEST 637 registration till' });
}, 300_000);
beforeEach(async () => {
  forbiddenFetch.mockClear();
  await ctx.db.delete(opsLast).where(inArray(opsLast.name, [...names, OTHER]));
  await ctx.db.delete(opsRun).where(inArray(opsRun.name, names));
  await ctx.db.delete(opsExpectation).where(inArray(opsExpectation.name, [JOB, OTHER]));
  const oldAlerts = await ctx.db.select({ id: alert.id }).from(alert).where(inArray(alert.key, keys));
  if (oldAlerts.length) await ctx.db.delete(alertDelivery).where(inArray(alertDelivery.alertId, oldAlerts.map(row => row.id)));
  await ctx.db.delete(alert).where(inArray(alert.key, keys));
  await ctx.db.delete(paymentAttempt).where(eq(paymentAttempt.branchId, park));
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { try { await ctx?.close(); await teardownAll(); } finally { vi.unstubAllGlobals(); } });

describe('SCRUM-637 registration configuration; private destination never appears in assertions or diagnostics', () => {
  it('R1 high: the typed switch defaults off outside the test override and an absent destination remains absent', () => {
    const env = envOf({ NODE_ENV: 'development', CONSOLE_DIGEST_ENABLED: undefined, ALERT_WEBHOOK_URL: undefined });
    expect(Reflect.get(env, 'CONSOLE_DIGEST_ENABLED')).toBe(false);
    expect(Reflect.get(env, 'ALERT_WEBHOOK_URL')).toBeUndefined();
  });
  it.each(['true', 'false'])('R2 high: parses the explicit strict %s switch without truthy-string coercion', value => {
    const env = envOf({ CONSOLE_DIGEST_ENABLED: value });
    expect(Reflect.get(env, 'CONSOLE_DIGEST_ENABLED')).toBe(value === 'true');
  });
  it.each(['TRUE', '1', 'yes', ''])('R3 high: refuses invalid switch spelling case %#', value => {
    privateConfigRefusal({ CONSOLE_DIGEST_ENABLED: value });
  });
  it('R4 high: accepts a private HTTPS destination and normalizes a blank destination to absence', () => {
    expect(Reflect.get(enabledEnv(), 'ALERT_WEBHOOK_URL') === destination).toBe(true);
    expect(Reflect.get(envOf({ ALERT_WEBHOOK_URL: '  ' }), 'ALERT_WEBHOOK_URL')).toBeUndefined();
  });
  it.each([
    ['plain HTTP', 'http://example.invalid/zz-test-private-destination'],
    ['userinfo', 'https://zz-test-private-destination@example.invalid/zz-test'],
    ['fragment', 'https://example.invalid/zz-test#zz-test-private-destination'],
    ['empty fragment', 'https://example.invalid/zz-test-private-destination#'],
    ['malformed', 'zz-test-private-destination'],
  ])('R5 high: refuses %s without echoing its private destination', (_label, value) => {
    privateConfigRefusal({ ALERT_WEBHOOK_URL: value! });
  });
  it('R6 critical: inherited developer configuration cannot enable or supply a destination to NODE_ENV=test', () => {
    vi.stubEnv('CONSOLE_DIGEST_ENABLED', 'true'); vi.stubEnv('ALERT_WEBHOOK_URL', destination);
    const env = envOf();
    expect(Reflect.get(env, 'CONSOLE_DIGEST_ENABLED')).toBe(false);
    expect(Reflect.get(env, 'ALERT_WEBHOOK_URL')).toBeUndefined();
    expect(definitions(env).some(job => job.name === JOB)).toBe(false);
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });
});

describe('SCRUM-637 native default-job registration and durable delivery; all transport is intercepted', () => {
  it.each(['off', 'unset', 'no-destination'])('R7 high: %s does not register a digest even when a capturing sender is supplied', mode => {
    const env = envOf({ CONSOLE_DIGEST_ENABLED: mode === 'off' ? 'false' : mode === 'unset' ? undefined : 'true',
      ALERT_WEBHOOK_URL: mode === 'no-destination' ? '' : destination });
    const send = sender(); expect(definitions(env, send).some(job => job.name === JOB)).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(forbiddenFetch).not.toHaveBeenCalled();
  });
  it('R8 high: explicit test opt-in with a capturing sender registers one exclusive job at the native rollup interval', () => {
    const env = enabledEnv(), job = digestJob(env, sender());
    expect(job.exclusive).toBe(true); expect(job.intervalSeconds).toBe(env.ROLLUP_INTERVAL_S);
    expect(job.description.includes('zz-test-private-destination')).toBe(false);
  });
  it('R9 critical: test opt-in without an injected sender produces no send, intent or fallback global fetch', async () => {
    const env = enabledEnv(), job = definitions(env).find(entry => entry.name === JOB);
    // Absence is safe. If registered, execute the actual closure; the global trap already prevents any network.
    if (job) try { await job.run({ db: ctx.db, env, log: ctx.app.log, now }); } catch { /* Assert all effects below, including failures. */ }
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect((await records()).filter(row => row.name === 'console.digest.intent' || row.name === 'console.digest.delivery')).toEqual([]);
  });
  it('R10 high: the registered closure uses real decision counts and exact Copy text with runtime PAYMENT_PENDING_MIN', async () => {
    const env = enabledEnv(), send = sender(), job = digestJob(env, send);
    await ctx.db.insert(paymentAttempt).values({ id: newId(), operatorId: owner, branchId: park, stationId: till,
      businessDate: '2026-10-26', method: 'card', provider: 'manual', status: 'unknown',
      createdAt: new Date(now.getTime() - 20 * 60_000), payload: { note: 'ZZ TEST private registration detail' } });
    const available = (await operatorBranches(ctx.db, owner)).filter(row => row.archivedAt === null);
    const scope = { operatorId: owner, available, selected: available, includeOperatorWide: false, now };
    const native = await overviewForScopeOf(ctx.db, { ...scope, pendingMinutes: env.PAYMENT_PENDING_MIN });
    const defaultThreshold = await overviewForScopeOf(ctx.db, { ...scope, pendingMinutes: 10 });
    expect(native.decisions.items.find(item => item.key === 'pendingPayments')?.count).toBe(0);
    expect(defaultThreshold.decisions.items.find(item => item.key === 'pendingPayments')?.count).toBe(1);
    const outcome = await job.run({ db: ctx.db, env, log: ctx.app.log, now });
    expect(send).toHaveBeenCalledExactlyOnceWith(native.statusSummary);
    expect(send.mock.calls[0]![0].includes('ZZ TEST private registration detail')).toBe(false);
    expect(outcome?.detail).toMatchObject({ mode: 'completed', groups: [expect.objectContaining({ branchId: park, state: 'accepted' })] });
    const saved = await records(); expect(saved.filter(row => row.name === 'console.digest.intent')).toHaveLength(1);
    expect(saved.filter(row => row.name === 'console.digest.delivery')).toHaveLength(1);
    expect(JSON.stringify(saved).includes(destination)).toBe(false); expect(forbiddenFetch).not.toHaveBeenCalled();
  });
  it('R11 high: the normal API-only role remains idle with no delivery, intent, run or expectation registration', async () => {
    const env = envOf({ CONSOLE_DIGEST_ENABLED: 'true', ALERT_WEBHOOK_URL: destination, PROCESS_ROLES: undefined });
    expect(env.PROCESS_ROLES).toBe('api');
    const send = sender(), job = digestJob(env, send);
    const runner = createJobRunner({ db: ctx.db, env, log: ctx.app.log, channels: [], jobs: [job] });
    try { await runner.start(); expect(runner.enabled).toBe(false); expect(await runner.runJob(JOB, { force: true })).toBe('disabled'); }
    finally { await runner.stop(); }
    expect(send).not.toHaveBeenCalled(); expect(await records()).toEqual([]);
    expect(await ctx.db.select().from(opsExpectation).where(eq(opsExpectation.name, JOB))).toEqual([]);
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });
  it('R12 critical: two actual registered exclusive runners cannot overlap and a forced Retry does not resend an accepted day', async () => {
    const env = enabledEnv(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn<DigestSender>().mockImplementation(async () => { await held; return { state: 'accepted', status: 202 }; });
    const job = digestJob(env, send), deps = { db: ctx.db, env, log: ctx.app.log, jobs: [job], channels: [] };
    const firstRunner = createJobRunner(deps), secondRunner = createJobRunner(deps);
    const first = firstRunner.runJob(JOB, { force: true });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(await secondRunner.runJob(JOB, { force: true })).toBe('locked');
    } finally { release(); expect(await first).toBe('ok'); }
    expect(await secondRunner.runJob(JOB, { force: true })).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
    const saved = await records(); expect(saved.filter(row => row.name === 'console.digest.intent')).toHaveLength(1);
    expect(saved.filter(row => row.name === 'console.digest.delivery')).toHaveLength(1);
    expect(saved.filter(row => row.name === JOB && row.outcome === 'ok')).toHaveLength(2);
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });
  it.each(['off', 'no-destination'])('R13 high: %s resolves only the old digest missing/failing expectations and still reports unrelated silence', async mode => {
    const old = new Date(Date.now() - 3_600_000), delivered: AlertMessage[] = [];
    await ctx.db.insert(opsExpectation).values([JOB, OTHER].map(name => ({ name, kind: 'job' as const,
      description: 'ZZ TEST 637 retained expectation', intervalSeconds: 60, graceSeconds: 0, createdAt: old,
      mutedUntil: name === JOB ? new Date(Date.now() + 3_600_000) : null })));
    const expectationsBefore = await ctx.db.select().from(opsExpectation)
      .where(inArray(opsExpectation.name, [JOB, OTHER])).orderBy(opsExpectation.name);
    await ctx.db.insert(opsLast).values({ name: JOB, kind: 'job', lastOutcome: 'failed', lastStartedAt: old,
      lastFailedAt: old, consecutiveFailures: ctx.app.env.ALERT_FAILURE_THRESHOLD, errorCode: 'ZZ_TEST_FAILED' });
    await ctx.db.insert(alert).values(keys.slice(0, 2).map(key => ({ id: newId(), key,
      category: key.startsWith('ops.missing:') ? 'ops.missing' : 'ops.failing', subject: JOB,
      summary: 'ZZ TEST retained digest condition', lastNotifiedAt: old })));
    const env = envOf({ CONSOLE_DIGEST_ENABLED: mode === 'off' ? 'false' : 'true', ALERT_WEBHOOK_URL: mode === 'off' ? destination : '' });
    await runWatchdog({ db: ctx.db, env, log: ctx.app.log, channels: [{ name: 'zz-test-capture',
      deliver: async message => { delivered.push(message); return { target: 'ZZ TEST memory' }; } }] });
    const digestAlerts = await ctx.db.select().from(alert).where(inArray(alert.key, keys.slice(0, 2)));
    expect(digestAlerts).toHaveLength(2);
    for (const row of digestAlerts) expect(row).toMatchObject({ status: 'resolved', resolvedReason: 'digest_disabled' });
    expect(delivered.filter(message => keys.slice(0, 2).includes(message.key))).toHaveLength(2);
    expect(delivered.filter(message => keys.slice(0, 2).includes(message.key)).every(message => message.event === 'resolved' && message.category === 'ops.disabled')).toBe(true);
    expect(await ctx.db.select().from(alert).where(eq(alert.key, keys[2]!))).toEqual([expect.objectContaining({ status: 'open', resolvedAt: null })]);
    expect(await ctx.db.select().from(opsExpectation).where(inArray(opsExpectation.name, [JOB, OTHER]))
      .orderBy(opsExpectation.name)).toEqual(expectationsBefore);
    expect(JSON.stringify(delivered).includes(destination)).toBe(false); expect(forbiddenFetch).not.toHaveBeenCalled();
  });
});
