import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import {
  account,
  alert,
  alertDelivery,
  alertMute,
  alertRecipient,
  auditLog,
  opsExpectation,
  opsLast,
  opsRun,
  role,
  roleAssignment,
  rolePermission,
} from '@oto/db';
import { newId, normalizePhone, type Permission } from '@oto/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertChannel, AlertMessage } from '../src/services/ops';
import { runWatchdog } from '../src/services/jobs';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-644, planner ruling Q25 — fingerprint mutes and alert recipients, and
 * the watchdog consuming both.
 *
 *  - a mute is per fingerprint, needs a reason, defaults to one hour and is
 *    refused past 24 hours; it is audited, and a muted alert is RECORDED as
 *    muted (an `alert_delivery` row pointing at the mute), never dropped;
 *  - a recipient maps a category to a channel and an address REFERENCE (an
 *    environment variable name); the read says whether that name is set and
 *    never what it holds, and delivery stays console-only;
 *  - `console:alert:manage` guards every write; `admin:health:read` still
 *    reads; named-job `muted_until` is untouched.
 */

const TAG = 'ZZ TEST 644 alerts';
const FP_OPERATOR = 'zz644operatorfp01';
const FP_PLATFORM = 'zz644platformfp01';
const FP_FOREIGN = 'zz644foreignfp001';
const JOB = 'job:zz.test644.always-fails';
let ctx: TestContext;
let operatorId: string, foreignOperatorId: string, central: string;
let admin: string, manager: string, healthReader: string, branchManager: string;
let accounts = 0;

/** Every message the console channel was asked to deliver. */
const delivered: AlertMessage[] = [];
const channels: AlertChannel[] = [{ name: 'console', async deliver(m) { delivered.push(m); return { target: 'console' }; } }];

async function accountWith(name: string, permissions: Permission[]): Promise<string> {
  const id = newId(), roleId = newId(), phone = normalizePhone(`+66900644${String(200 + accounts++)}`)!;
  const password = randomBytes(18).toString('hex');
  await ctx.db.insert(account).values({ id, operatorId, phone, passwordHash: await hash(password),
    phoneVerifiedAt: new Date(), status: 'active', mustChangePassword: false });
  await ctx.db.insert(role).values({ id: roleId, operatorId, name: `${TAG} ${name}` });
  for (const permission of permissions) await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission });
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: id, roleId, scopeType: 'operator', scopeId: operatorId });
  return signInAs(ctx.app, phone, password);
}

function failedRun(fingerprint: string, opId: string | null, branchId: string | null = null) {
  return { id: newId(), kind: 'job' as const, name: `${TAG} ${fingerprint}`, outcome: 'failed' as const,
    errorCode: 'ZZ_TEST', errorMessage: 'ZZ TEST failure', fingerprint, startedAt: new Date(), finishedAt: new Date(),
    durationMs: 1, operatorId: opId, branchId };
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  foreignOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  branchManager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  manager = await accountWith('alert manager', ['console:alert:manage', 'admin:health:read']);
  healthReader = await accountWith('health reader', ['admin:health:read']);
  await ctx.db.insert(opsRun).values([
    failedRun(FP_OPERATOR, operatorId, central),
    failedRun(FP_PLATFORM, null),
    failedRun(FP_FOREIGN, foreignOperatorId),
  ]);
}, 240_000);

afterAll(async () => {
  try { await ctx?.close(); } finally { await teardownAll(); }
});

let keyCount = 0;
const post = (cookie: string, url: string, payload: unknown = {}) => ctx.app.inject({ method: 'POST', url, payload: payload as never,
  headers: { cookie, 'idempotency-key': `zz-test-644-${++keyCount}` } });
const patch = (cookie: string, url: string, payload: unknown) => ctx.app.inject({ method: 'PATCH', url, payload: payload as never,
  headers: { cookie, 'idempotency-key': `zz-test-644-${++keyCount}` } });
const get = (cookie: string, url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

type Mute = { id: string; fingerprint: string; scope: string; reason: string; startsAt: string; mutedUntil: string; heldBack: number };

async function muteRows(fingerprint: string) {
  return ctx.db.select().from(alertMute).where(eq(alertMute.fingerprint, fingerprint));
}

describe('fingerprint mutes (SCRUM-644)', () => {
  it('M1 defaults to one hour, records who and why, and is audited', async () => {
    const res = await post(manager, '/ops/alert-mutes', { fingerprint: FP_OPERATOR, reason: 'ZZ TEST printer swap' });
    expect(res.statusCode, res.body).toBe(200);
    const { mute } = res.json() as { mute: Mute };
    expect(mute).toMatchObject({ fingerprint: FP_OPERATOR, scope: 'operator', reason: 'ZZ TEST printer swap' });
    expect(Date.parse(mute.mutedUntil) - Date.parse(mute.startsAt)).toBe(60 * 60_000);
    const [row] = await muteRows(FP_OPERATOR);
    expect(row).toMatchObject({ operatorId, liftedAt: null });
    const [trail] = await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.action, 'ops.alert_mute'), eq(auditLog.entityId, mute.id)));
    expect(trail).toMatchObject({ operatorId, entityType: 'alert_mute', sourceApp: 'console' });
    expect(trail!.after).toMatchObject({ fingerprint: FP_OPERATOR, reason: 'ZZ TEST printer swap', minutes: 60 });
  });

  it('M2 refuses a mute without a reason, or with a blank one, and writes nothing', async () => {
    const before = (await muteRows(FP_PLATFORM)).length;
    expect((await post(admin, '/ops/alert-mutes', { fingerprint: FP_PLATFORM })).statusCode).toBe(400);
    expect((await post(admin, '/ops/alert-mutes', { fingerprint: FP_PLATFORM, reason: '   ' })).statusCode).toBe(400);
    expect((await muteRows(FP_PLATFORM)).length).toBe(before);
  });

  it('M3 refuses more than 24 hours with a clear message, and accepts exactly 24', async () => {
    const tooLong = await post(admin, '/ops/alert-mutes', { fingerprint: FP_PLATFORM, reason: 'ZZ TEST long', minutes: 24 * 60 + 1 });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.body).toMatch(/24 hours/);
    const day = await post(admin, '/ops/alert-mutes', { fingerprint: FP_PLATFORM, reason: 'ZZ TEST a day', minutes: 24 * 60 });
    expect(day.statusCode, day.body).toBe(200);
    const { mute } = day.json() as { mute: Mute };
    expect(mute.scope).toBe('platform');
    expect(Date.parse(mute.mutedUntil) - Date.parse(mute.startsAt)).toBe(24 * 60 * 60_000);
  });

  it('M4 a fingerprint outside the caller reach is not found, and a platform one needs a platform administrator', async () => {
    expect((await post(manager, '/ops/alert-mutes', { fingerprint: FP_FOREIGN, reason: 'ZZ TEST foreign' })).statusCode).toBe(404);
    expect((await post(manager, '/ops/alert-mutes', { fingerprint: 'zz644nothing0001', reason: 'ZZ TEST none' })).statusCode).toBe(404);
    expect((await post(manager, '/ops/alert-mutes', { fingerprint: FP_PLATFORM, reason: 'ZZ TEST platform' })).statusCode).toBe(403);
  });

  it('M5 console:alert:manage guards every mute write; the health read door still reads the muted state', async () => {
    expect((await post(healthReader, '/ops/alert-mutes', { fingerprint: FP_OPERATOR, reason: 'ZZ TEST reader' })).statusCode).toBe(403);
    expect((await post(branchManager, '/ops/alert-mutes', { fingerprint: FP_OPERATOR, reason: 'ZZ TEST bm' })).statusCode).toBe(403);
    const read = await get(healthReader, '/ops/alert-mutes');
    expect(read.statusCode, read.body).toBe(200);
    const body = read.json() as { mutes: Mute[]; maxMinutes: number; defaultMinutes: number };
    expect(body).toMatchObject({ maxMinutes: 1440, defaultMinutes: 60 });
    expect(body.mutes.map((m) => m.fingerprint)).toContain(FP_OPERATOR);
  });

  it('M6 a fresh decision supersedes the active mute; lifting ends it early, audited, and the row stays', async () => {
    const again = await post(manager, '/ops/alert-mutes', { fingerprint: FP_OPERATOR, reason: 'ZZ TEST re-decided', minutes: 30 });
    expect(again.statusCode, again.body).toBe(200);
    const rows = await muteRows(FP_OPERATOR);
    expect(rows.filter((r) => r.liftedAt === null)).toHaveLength(1);
    const { mute } = again.json() as { mute: Mute };
    const lifted = await post(manager, `/ops/alert-mutes/${mute.id}/lift`);
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect((await muteRows(FP_OPERATOR)).every((r) => r.liftedAt !== null)).toBe(true);
    const list = (await get(manager, '/ops/alert-mutes')).json() as { mutes: Mute[] };
    expect(list.mutes.some((m) => m.fingerprint === FP_OPERATOR)).toBe(false);
    const trail = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'ops.alert_unmute'), eq(auditLog.entityId, mute.id)));
    expect(trail).toHaveLength(1);
  });
});

describe('the watchdog consumes mutes: recorded as muted, never dropped (SCRUM-644)', () => {
  const failKey = `ops.failing:${JOB}`;
  const deps = () => ({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });

  it('C1 an alert whose fingerprint is muted is raised and listed, its delivery recorded as muted and not sent', async () => {
    await ctx.db.insert(opsExpectation).values({ name: JOB, kind: 'job', intervalSeconds: 3600, graceSeconds: 3600 })
      .onConflictDoNothing();
    await ctx.db.insert(opsLast).values({ name: JOB, kind: 'job', lastOutcome: 'failed', lastStartedAt: new Date(),
      lastFinishedAt: new Date(), lastOkAt: new Date(), lastFailedAt: new Date(),
      consecutiveFailures: ctx.app.env.ALERT_FAILURE_THRESHOLD + 1, errorCode: 'ZZ_TEST', fingerprint: FP_PLATFORM })
      .onConflictDoNothing();
    delivered.length = 0;
    await runWatchdog(deps());
    const [row] = await ctx.db.select().from(alert).where(eq(alert.key, failKey));
    expect(row, 'the muted condition is still an alert row').toBeDefined();
    expect(row!.status).toBe('open');
    expect(row!.lastNotifiedAt).toBeNull();
    expect(delivered.filter((d) => d.key === failKey)).toHaveLength(0);
    const deliveries = await ctx.db.select().from(alertDelivery).where(eq(alertDelivery.alertId, row!.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'muted', channel: 'console', event: 'opened' });
    const [platformMute] = (await muteRows(FP_PLATFORM)).filter((m) => m.liftedAt === null);
    expect(deliveries[0]!.muteId).toBe(platformMute!.id);
    const list = (await get(admin, '/ops/alert-mutes')).json() as { mutes: Mute[] };
    expect(list.mutes.find((m) => m.fingerprint === FP_PLATFORM)?.heldBack).toBe(1);
  });

  it('C2 once the mute is lifted the same condition delivers again on its next opening', async () => {
    const [active] = (await muteRows(FP_PLATFORM)).filter((m) => m.liftedAt === null);
    expect((await post(admin, `/ops/alert-mutes/${active!.id}/lift`)).statusCode).toBe(200);
    await ctx.db.delete(alert).where(eq(alert.key, failKey));
    delivered.length = 0;
    await runWatchdog(deps());
    expect(delivered.filter((d) => d.key === failKey)).toHaveLength(1);
    const [row] = await ctx.db.select().from(alert).where(eq(alert.key, failKey));
    const deliveries = await ctx.db.select().from(alertDelivery).where(eq(alertDelivery.alertId, row!.id));
    expect(deliveries.map((d) => d.status)).toEqual(['sent']);
  });

  it('C3 named-job muted_until is unchanged by a fingerprint mute and keeps its own meaning', async () => {
    const [expectation] = await ctx.db.select().from(opsExpectation).where(eq(opsExpectation.name, JOB));
    expect(expectation!.mutedUntil).toBeNull();
  });
});

describe('alert recipients (SCRUM-644)', () => {
  type Recipient = { id: string; category: string; channel: string; addressRef: string | null; addressConfigured: boolean | null; delivered: boolean };

  it('R1 stores an environment variable name, answers whether it is set and never its value', async () => {
    process.env.ALERT_ZZ_TEST_644_SET = 'oncall-zz-test@example.test';
    try {
      const made = await post(manager, '/ops/alert-recipients', { category: 'ops.failing', channel: 'email', addressRef: 'ALERT_ZZ_TEST_644_SET', label: 'ZZ TEST on call' });
      expect(made.statusCode, made.body).toBe(200);
      const unset = await post(manager, '/ops/alert-recipients', { category: '*', channel: 'webhook', addressRef: 'ALERT_ZZ_TEST_644_UNSET' });
      expect(unset.statusCode, unset.body).toBe(200);
      const read = await get(manager, '/ops/alert-recipients');
      expect(read.statusCode, read.body).toBe(200);
      expect(read.body).not.toContain('oncall-zz-test@example.test');
      const body = read.json() as { recipients: Recipient[]; deliveryNote: string };
      expect(body.deliveryNote).toMatch(/console only/i);
      expect(body.recipients.find((r) => r.addressRef === 'ALERT_ZZ_TEST_644_SET')).toMatchObject({ channel: 'email', addressConfigured: true, delivered: false });
      expect(body.recipients.find((r) => r.addressRef === 'ALERT_ZZ_TEST_644_UNSET')).toMatchObject({ addressConfigured: false, delivered: false });
    } finally {
      delete process.env.ALERT_ZZ_TEST_644_SET;
    }
  });

  it('R2 refuses an address value in place of a reference, a console address and a missing reference', async () => {
    const before = (await ctx.db.select().from(alertRecipient)).length;
    for (const body of [
      { category: 'ops.failing', channel: 'email', addressRef: 'oncall@example.test' },
      { category: 'ops.failing', channel: 'webhook', addressRef: 'https://hooks.example.test/zz' },
      { category: 'ops.failing', channel: 'webhook', addressRef: 'DATABASE_URL' },
      { category: 'ops.failing', channel: 'console', addressRef: 'ALERT_ZZ_CONSOLE' },
      { category: 'ops.failing', channel: 'email' },
    ]) {
      expect((await post(manager, '/ops/alert-recipients', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await ctx.db.select().from(alertRecipient)).length).toBe(before);
  });

  it('R3 console:alert:manage guards recipient reads and writes; each write is audited', async () => {
    expect((await get(healthReader, '/ops/alert-recipients')).statusCode).toBe(403);
    expect((await post(healthReader, '/ops/alert-recipients', { category: '*', channel: 'console' })).statusCode).toBe(403);
    const made = await post(manager, '/ops/alert-recipients', { category: 'box.offline', channel: 'console' });
    expect(made.statusCode, made.body).toBe(200);
    const { recipient } = made.json() as { recipient: Recipient };
    expect(recipient).toMatchObject({ channel: 'console', addressRef: null, addressConfigured: null, delivered: true });
    const changed = await patch(manager, `/ops/alert-recipients/${recipient.id}`, { label: 'ZZ TEST renamed' });
    expect(changed.statusCode, changed.body).toBe(200);
    const archived = await post(manager, `/ops/alert-recipients/${recipient.id}/archive`);
    expect(archived.statusCode, archived.body).toBe(200);
    const actions = (await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, recipient.id))).map((r) => r.action).sort();
    expect(actions).toEqual(['ops.alert_recipient_archive', 'ops.alert_recipient_create', 'ops.alert_recipient_update']);
  });

  it('R4 the watchdog records an unsupported delivery for an email recipient and sends only to the console', async () => {
    const key = `ops.failing:${JOB}`;
    await ctx.db.delete(alert).where(eq(alert.key, key));
    delivered.length = 0;
    await runWatchdog({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });
    const [row] = await ctx.db.select().from(alert).where(eq(alert.key, key));
    const deliveries = await ctx.db.select().from(alertDelivery).where(eq(alertDelivery.alertId, row!.id));
    // The platform job's alert has no operator: only a platform recipient would match it,
    // and the operator rows above do not. Delivery is the console's alone.
    expect(deliveries.map((d) => d.status)).toEqual(['sent']);
    expect(delivered.filter((d) => d.key === key)).toHaveLength(1);
  });

  it('R5 a platform recipient row is a platform administrator write, and matching email rows are recorded unsupported', async () => {
    expect((await post(manager, '/ops/alert-recipients', { category: 'ops.failing', channel: 'email', addressRef: 'ALERT_ZZ_PLATFORM', scope: 'platform' })).statusCode).toBe(403);
    const made = await post(admin, '/ops/alert-recipients', { category: 'ops.failing', channel: 'email', addressRef: 'ALERT_ZZ_PLATFORM', scope: 'platform' });
    expect(made.statusCode, made.body).toBe(200);
    const key = `ops.failing:${JOB}`;
    await ctx.db.delete(alert).where(eq(alert.key, key));
    delivered.length = 0;
    await runWatchdog({ db: ctx.db, env: ctx.app.env, log: ctx.app.log, channels });
    const [row] = await ctx.db.select().from(alert).where(eq(alert.key, key));
    const deliveries = await ctx.db.select().from(alertDelivery).where(eq(alertDelivery.alertId, row!.id));
    expect(deliveries.map((d) => `${d.channel}:${d.status}:${d.target}`).sort())
      .toEqual(['console:sent:console', 'email:unsupported:email:ALERT_ZZ_PLATFORM']);
    expect(ctx.smsLog).toHaveLength(0);
  });
});
