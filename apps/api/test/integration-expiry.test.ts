import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { account, alert, alertDelivery, integrationCredentialExpiry, opsRun } from '@oto/db';
import { normalizePhone } from '@oto/shared';
import {
  INTEGRATION_EXPIRY_JOB,
  daysUntil,
  expiryAlertKey,
  expiryWindow,
  runIntegrationExpiryWatch,
  setCredentialExpiry,
} from '../src/services/integration-expiry';
import { buildDefaultJobs, createJobRunner } from '../src/services/jobs';
import type { AlertChannel, AlertMessage } from '../src/services/ops';
import { ADMIN, createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-645 / planner ruling Q26 — the credential expiry watch: owner-supplied
 * dates only, an alert at 30 days and another at 7, through the existing
 * raise-and-deliver path, through the existing scheduler. No provider is ever
 * asked: every fetch in this file is captured and must stay at zero.
 */

describe('expiry windows (pure)', () => {
  const now = new Date('2026-10-28T23:30:00Z');
  it.each([
    [null, 'not_set', null],
    ['2026-11-28', 'ok', 31],
    ['2026-11-27', '30_days', 30],
    ['2026-11-05', '30_days', 8],
    ['2026-11-04', '7_days', 7],
    ['2026-10-28', '7_days', 0],
    ['2026-10-27', 'expired', -1],
  ] as const)('%s reads as %s (%s days)', (expiresOn, window, daysLeft) => {
    expect(expiryWindow(expiresOn, now)).toEqual({ window, daysLeft });
  });

  it('counts calendar days in UTC, so the time of day never moves a boundary', () => {
    expect(daysUntil('2026-11-27', new Date('2026-10-28T00:00:00Z'))).toBe(30);
    expect(daysUntil('2026-11-27', new Date('2026-10-28T23:59:59Z'))).toBe(30);
  });
});

describe('the expiry watch (Q26)', () => {
  let ctx: TestContext;
  let operatorId: string;
  let accountId: string;
  const delivered: AlertMessage[] = [];
  const channels: AlertChannel[] = [{ name: 'test', deliver: async (m) => { delivered.push(m); return { target: 'test' }; } }];
  let fetchCalls = 0;
  let restoreFetch: () => void;

  const isoDay = (offsetDays: number, from = new Date()) =>
    new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()) + offsetDays * 86_400_000)
      .toISOString().slice(0, 10);

  const setDate = (key: 'meta_channel_token' | 'pgw_maintenance_key' | 'otoapp_directory_key', expiresOn: string | null) =>
    ctx.db.transaction((tx) => setCredentialExpiry(tx, { operatorId, accountId, key, expiresOn, now: new Date() }));

  const watch = (now: Date) =>
    runIntegrationExpiryWatch({ db: ctx.db, channels, flapWindowSeconds: 0, now });

  const openAlert = async (key: string) =>
    (await ctx.db.select().from(alert).where(and(eq(alert.key, key), isNull(alert.resolvedAt))))[0];

  beforeAll(async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      throw new Error('ZZ TEST: the expiry watch must never call a provider');
    });
    restoreFetch = () => spy.mockRestore();
    ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs' } });
    const [admin] = await ctx.db.select().from(account).where(eq(account.phone, normalizePhone(ADMIN.phone)!));
    operatorId = admin!.operatorId;
    accountId = admin!.id;
  }, 180_000);

  afterEach(async () => {
    delivered.length = 0;
    await ctx.db.delete(integrationCredentialExpiry).where(eq(integrationCredentialExpiry.operatorId, operatorId));
    await ctx.db.delete(alert).where(like(alert.key, 'integration.expiry:%'));
  });

  afterAll(async () => {
    try { await ctx?.close(); } finally { restoreFetch?.(); await teardownAll(); }
    expect(fetchCalls).toBe(0);
  });

  it('a date 20 days ahead opens the 30-day alert, and not the 7-day one; a second pass repeats without a second message', async () => {
    const now = new Date();
    await setDate('meta_channel_token', isoDay(20, now));
    expect(await watch(now)).toMatchObject({ examined: 1, opened: 1, repeated: 0, resolved: 0 });
    const thirty = await openAlert(expiryAlertKey(operatorId, 'meta_channel_token', 30));
    expect(thirty).toMatchObject({ category: 'integration.expiry', severity: 'warning', operatorId, branchId: null });
    expect(thirty!.summary).toContain('in 20 days');
    expect(await openAlert(expiryAlertKey(operatorId, 'meta_channel_token', 7))).toBeUndefined();
    expect(delivered.map((m) => [m.key, m.event])).toEqual([[expiryAlertKey(operatorId, 'meta_channel_token', 30), 'opened']]);
    expect(await ctx.db.select().from(alertDelivery).where(eq(alertDelivery.alertId, thirty!.id))).toHaveLength(1);

    expect(await watch(now)).toMatchObject({ opened: 0, repeated: 1 });
    expect(delivered).toHaveLength(1);
  });

  it('inside 7 days both windows are open, as two alerts — the 7-day one critical', async () => {
    const now = new Date();
    await setDate('pgw_maintenance_key', isoDay(5, now));
    expect(await watch(now)).toMatchObject({ opened: 2 });
    expect((await openAlert(expiryAlertKey(operatorId, 'pgw_maintenance_key', 30)))?.severity).toBe('warning');
    expect((await openAlert(expiryAlertKey(operatorId, 'pgw_maintenance_key', 7)))?.severity).toBe('critical');
  });

  it('an expired credential keeps both alerts open and says it expired', async () => {
    const now = new Date();
    await setDate('otoapp_directory_key', isoDay(-2, now));
    await watch(now);
    expect((await openAlert(expiryAlertKey(operatorId, 'otoapp_directory_key', 7)))?.summary).toContain('expired');
  });

  it('a later edit (renewal) resolves the open windows, and a cleared date resolves them too', async () => {
    const now = new Date();
    await setDate('meta_channel_token', isoDay(5, now));
    await watch(now);
    await setDate('meta_channel_token', isoDay(90, now));
    expect(await watch(now)).toMatchObject({ resolved: 2, opened: 0 });
    expect(await openAlert(expiryAlertKey(operatorId, 'meta_channel_token', 30))).toBeUndefined();
    const [resolved] = await ctx.db.select().from(alert)
      .where(eq(alert.key, expiryAlertKey(operatorId, 'meta_channel_token', 30))).orderBy(desc(alert.resolvedAt));
    expect(resolved!.resolvedReason).toBe('renewed');

    await setDate('meta_channel_token', isoDay(3, now));
    await watch(now);
    await setDate('meta_channel_token', null);
    expect(await watch(now)).toMatchObject({ resolved: 2 });
  });

  it('an undated integration opens nothing — not set is not a warning', async () => {
    await setDate('meta_channel_token', null);
    expect(await watch(new Date())).toMatchObject({ examined: 1, opened: 0, repeated: 0, resolved: 0 });
    expect(delivered).toEqual([]);
  });

  it('runs through the existing scheduler: registered with the default jobs, and its run is recorded', async () => {
    const jobs = buildDefaultJobs({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });
    const job = jobs.find((j) => j.name === INTEGRATION_EXPIRY_JOB);
    expect(job, 'job:integration.expiry is registered in buildDefaultJobs').toBeDefined();
    expect(job!.intervalSeconds).toBe(3_600);

    await setDate('meta_channel_token', isoDay(20));
    const runner = createJobRunner({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, jobs: [job!], channels });
    expect(await runner.runJob(INTEGRATION_EXPIRY_JOB, { force: true })).toBe('ok');
    const [run] = await ctx.db.select().from(opsRun).where(eq(opsRun.name, INTEGRATION_EXPIRY_JOB)).orderBy(desc(opsRun.startedAt));
    expect(run).toMatchObject({ kind: 'job', outcome: 'ok' });
    expect(run!.detail).toMatchObject({ examined: 1, opened: 1 });
    expect(await openAlert(expiryAlertKey(operatorId, 'meta_channel_token', 30))).toBeDefined();
  });
});
