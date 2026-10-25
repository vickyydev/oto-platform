import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, auditLog, branch, employee, operator, role, roleAssignment, rolePermission, session, station } from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken } from '../src/plugins/session';
import { switchSessionOperator } from '../src/services/operator-switch';
import { createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let f: Awaited<ReturnType<typeof fixture>>;
let recoveryPhoneSequence = 0;
const probe = '/zz-test-640/session-context';
beforeAll(async () => {
  ctx = await createTestContext();
  // Observe the real plugin on the native app, not a reimplementation of its
  // loader. These read-only observers exist only in this private test instance.
  ctx.app.get(probe, { config: { auth: 'session' } }, async req => {
    const auth = req.requireAuth(), permissions = await req.effectivePermissions();
    return { auth, permissions };
  });
  ctx.app.get<{ Querystring: { operatorId: string; homePermission?: string } }>(`${probe}/target`,
    { config: { dynamicPermission: true } }, async req => {
      const auth = await req.requirePermission(req.query.homePermission === 'true' ? 'pos:sale:read' : 'admin:branch:read',
        { operatorId: req.query.operatorId, operatorOnly: true });
      return { operatorId: auth.operatorId };
    });
}, 300_000);
beforeEach(async () => { f = await fixture(); });
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function fixture() {
  const ids = { home: newId(), target: newId(), foreign: newId(), homeBranch: newId(), targetBranch: newId(),
    secondTargetBranch: newId(), foreignBranch: newId(), homeStation: newId(), targetStation: newId(),
    secondTargetStation: newId(), employee: newId(), actor: newId(), targetActor: newId(),
    switchRole: newId(), readRole: newId(), homeRole: newId(), switchGrant: newId(), readGrant: newId(),
    homeGrant: newId(), live: newId(), otherSession: newId() };
  await ctx.db.insert(operator).values([
    { id: ids.home, name: 'ZZ TEST 640 session home' }, { id: ids.target, name: 'ZZ TEST 640 session target' },
    { id: ids.foreign, name: 'ZZ TEST 640 session unrelated' },
  ]);
  await ctx.db.insert(branch).values([
    { id: ids.homeBranch, operatorId: ids.home, name: 'ZZ TEST 640 home park', code: 'zz-test-home' },
    { id: ids.targetBranch, operatorId: ids.target, name: 'ZZ TEST 640 target park', code: 'zz-test-target' },
    { id: ids.secondTargetBranch, operatorId: ids.target, name: 'ZZ TEST 640 other target park', code: 'zz-test-target-other' },
    { id: ids.foreignBranch, operatorId: ids.foreign, name: 'ZZ TEST 640 unrelated park', code: 'zz-test-unrelated' },
  ]);
  await ctx.db.insert(station).values([
    { id: ids.homeStation, operatorId: ids.home, branchId: ids.homeBranch, name: 'ZZ TEST 640 home station' },
    { id: ids.targetStation, operatorId: ids.target, branchId: ids.targetBranch, name: 'ZZ TEST 640 target station' },
    { id: ids.secondTargetStation, operatorId: ids.target, branchId: ids.secondTargetBranch, name: 'ZZ TEST 640 other target station' },
  ]);
  await ctx.db.insert(employee).values({ id: ids.employee, operatorId: ids.home, branchId: ids.homeBranch, name: 'ZZ TEST 640 unchanged employee' });
  await ctx.db.insert(account).values([
    { id: ids.actor, operatorId: ids.home, employeeId: ids.employee, phone: '+66999996400', status: 'active' },
    { id: ids.targetActor, operatorId: ids.target, phone: '+66999996401', status: 'active' },
  ]);
  await ctx.db.insert(role).values([
    { id: ids.switchRole, operatorId: ids.home, name: 'ZZ TEST 640 live switch authority' },
    { id: ids.readRole, operatorId: ids.home, name: 'ZZ TEST 640 independent global read' },
    { id: ids.homeRole, operatorId: ids.home, name: 'ZZ TEST 640 home-only permission' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: ids.switchRole, permission: 'platform:operator:switch' },
    { id: newId(), roleId: ids.readRole, permission: 'admin:branch:read' },
    { id: newId(), roleId: ids.homeRole, permission: 'pos:sale:read' },
  ]);
  await ctx.db.insert(roleAssignment).values([
    { id: ids.switchGrant, accountId: ids.actor, roleId: ids.switchRole, scopeType: 'operator', scopeId: null },
    { id: ids.readGrant, accountId: ids.actor, roleId: ids.readRole, scopeType: 'operator', scopeId: null },
    { id: ids.homeGrant, accountId: ids.actor, roleId: ids.homeRole, scopeType: 'operator', scopeId: ids.home },
  ]);
  const token = randomBytes(32).toString('hex'), otherToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 3_600_000), lastSeenAt = new Date();
  await ctx.db.insert(session).values([
    { id: ids.live, accountId: ids.actor, branchId: ids.homeBranch, stationId: ids.homeStation,
      tokenHash: hashToken(token), expiresAt, lastSeenAt },
    { id: ids.otherSession, accountId: ids.actor, branchId: ids.homeBranch, stationId: ids.homeStation,
      tokenHash: hashToken(otherToken), expiresAt, lastSeenAt },
  ]);
  return { ...ids, cookie: `oto_session=${token}`, otherCookie: `oto_session=${otherToken}` };
}
const read = (url = probe, cookie?: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? f.cookie } });
const seat = async (id = f.live) => (await ctx.db.select().from(session).where(eq(session.id, id)))[0]!;
const override = (patch: Partial<typeof session.$inferInsert> = {}) => ctx.db.update(session)
  .set({ operatorOverride: f.target, branchId: null, stationId: null, ...patch }).where(eq(session.id, f.live));
const target = (operatorId: string, homePermission = false) => read(`${probe}/target?${new URLSearchParams({ operatorId, ...(homePermission ? { homePermission: 'true' } : {}) })}`);
const identity = async () => ({
  accounts: await ctx.db.select().from(account).where(inArray(account.id, [f.actor, f.targetActor])),
  employees: await ctx.db.select().from(employee).where(eq(employee.id, f.employee)),
  grants: await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, f.actor)),
  otherSession: await seat(f.otherSession),
});
async function refusal(status: number, url = probe, code?: string) {
  const before = await seat(), unchanged = await identity(), response = await read(url);
  expect(response.statusCode).toBe(status);
  if (code) expect(response.json().error.code).toBe(code);
  expect(await seat()).toEqual(before); expect(await identity()).toEqual(unchanged);
}

describe('SCRUM-640 Q20 native session seam; Q22 attribution and sign-out additions remain held', () => {
  it('R1 [critical] FINDING: resolve the live override and audited revision without replacing the real home account or employee', async () => {
    const before = await identity();
    const selected = await switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.live, operatorId: f.target, expectedRevision: 0 });
    expect(selected.revision).toBe(1);
    const response = await read(); expect(response.statusCode).toBe(200);
    expect(response.json().auth).toMatchObject({ accountId: f.actor, sessionId: f.live, operatorId: f.target,
      homeOperatorId: f.home, operatorOverride: f.target, operatorRevision: 1, branchId: null, stationId: null, isPlatformAdmin: true });
    const me = await read('/me'); expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ account: { id: f.actor, operatorId: f.home }, employee: { id: f.employee }, isPlatformAdmin: true });
    expect(await identity()).toEqual(before);
    await switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.live, operatorId: f.target, expectedRevision: 1 });
    expect((await read()).json().auth.operatorRevision).toBe(2);
  });
  it('R2 [critical] FINDING: native branch reads narrow to the chosen operator and preserve the exact home grants', async () => {
    const permissions = (await read('/me/permissions')).json(); await override();
    const result = await read('/branches'); expect(result.statusCode).toBe(200);
    expect(result.json().branches.map((b: { id: string }) => b.id).sort()).toEqual([f.targetBranch, f.secondTargetBranch].sort());
    expect((await read('/me/permissions')).json()).toEqual(permissions);
    expect((await target(f.target)).statusCode).toBe(200);
    expect((await target(f.target, true)).statusCode).toBe(403);
  });
  it.each(['home', 'foreign'] as const)('R3 [critical] FINDING: explicit %s targets cannot escape an active override through a global grant', async kind => {
    await override(); expect((await target(kind === 'home' ? f.home : f.foreign)).statusCode).toBe(403);
  });
  it('R4 [high] keeps a live target-owned seat and leaves the other cookie at its own home context', async () => {
    await override({ branchId: f.targetBranch, stationId: f.targetStation }); const before = await seat();
    const observed = await read(); expect(observed.statusCode).toBe(200);
    expect(observed.json().auth).toMatchObject({ operatorId: f.target, branchId: f.targetBranch, stationId: f.targetStation });
    const other = await read(probe, f.otherCookie); expect(other.statusCode).toBe(200);
    expect(other.json().auth).toMatchObject({ accountId: f.actor, sessionId: f.otherSession, operatorId: f.home,
      homeOperatorId: f.home, operatorOverride: null, operatorRevision: 0 });
    expect(await seat()).toEqual(before);
  });
  it.each(['archived target', 'archived home'] as const)('R5 [critical] FINDING: a now-%s override refuses without silently returning home', async kind => {
    await override(); await ctx.db.update(operator).set({ archivedAt: new Date() }).where(eq(operator.id, kind === 'archived target' ? f.target : f.home));
    await refusal(401);
  });
  it.each(['foreign branch', 'archived branch', 'foreign station', 'wrong station branch', 'archived station', 'missing station', 'unseated station'] as const)(
    'R6 [critical] FINDING: validate the effective operator and exact live seat for %s', async kind => {
      await override({ branchId: f.targetBranch, stationId: f.targetStation });
      if (kind === 'foreign branch') await ctx.db.update(session).set({ branchId: f.homeBranch, stationId: null }).where(eq(session.id, f.live));
      if (kind === 'archived branch') await ctx.db.update(branch).set({ archivedAt: new Date() }).where(eq(branch.id, f.targetBranch));
      if (kind === 'foreign station') await ctx.db.update(session).set({ stationId: f.homeStation }).where(eq(session.id, f.live));
      if (kind === 'wrong station branch') await ctx.db.update(session).set({ stationId: f.secondTargetStation }).where(eq(session.id, f.live));
      if (kind === 'archived station') await ctx.db.update(station).set({ archivedAt: new Date() }).where(eq(station.id, f.targetStation));
      if (kind === 'missing station') await ctx.db.update(session).set({ stationId: newId() }).where(eq(session.id, f.live));
      if (kind === 'unseated station') await ctx.db.update(session).set({ branchId: null }).where(eq(session.id, f.live));
      await refusal(401);
    });
  it.each(['deleted grant', 'archived grant', 'withdrawn permission', 'own scope', 'split assignments', 'foreign role owner'] as const)(
    'R7 [critical] FINDING: revalidate the same live null-scope switch assignment on each request after %s', async kind => {
      await override(); expect((await read()).statusCode).toBe(200);
      if (kind === 'deleted grant') await ctx.db.delete(roleAssignment).where(eq(roleAssignment.id, f.switchGrant));
      if (kind === 'archived grant') await ctx.db.update(roleAssignment).set({ archivedAt: new Date() }).where(eq(roleAssignment.id, f.switchGrant));
      if (kind === 'withdrawn permission') await ctx.db.delete(rolePermission).where(eq(rolePermission.roleId, f.switchRole));
      if (kind === 'own scope') await ctx.db.update(roleAssignment).set({ scopeId: f.home }).where(eq(roleAssignment.id, f.switchGrant));
      if (kind === 'split assignments') await ctx.db.update(roleAssignment).set({ scopeType: 'branch', scopeId: f.homeBranch }).where(eq(roleAssignment.id, f.switchGrant));
      if (kind === 'foreign role owner') await ctx.db.update(role).set({ operatorId: f.target }).where(eq(role.id, f.switchRole));
      await refusal(403, probe, 'FORBIDDEN');
    });
  it.each(['inactive', 'invited'] as const)('R8 [critical] preserves the native %s-account refusal under an override', async status => {
    await override(); await ctx.db.update(account).set({ status }).where(eq(account.id, f.actor)); await refusal(401);
  });
  it.each(['locked', 'temporary password'] as const)('R9 [high] retains business refusal and native /me exemptions for %s sessions', async kind => {
    await override();
    if (kind === 'locked') await ctx.db.update(session).set({ lockedAt: new Date() }).where(eq(session.id, f.live));
    else await ctx.db.update(account).set({ mustChangePassword: true }).where(eq(account.id, f.actor));
    await refusal(kind === 'locked' ? 423 : 403, probe, kind === 'locked' ? 'SESSION_LOCKED' : 'MUST_CHANGE_PASSWORD');
    const me = await read('/me'); expect(me.statusCode).toBe(200);
    expect(me.json().account.operatorId).toBe(f.home); expect(me.json().sessionLocked).toBe(kind === 'locked');
    expect((await read('/me/permissions')).statusCode).toBe(200);
  });
  it.each(['display', 'box', 'kiosk'] as const)('R10 [critical] FINDING: an override cannot turn a %s-class session into a staff context', async sessionClass => {
    await override({ sessionClass }); await refusal(403, probe, 'FORBIDDEN');
  });
  it.each(['expired', 'revoked'] as const)('R11 [critical] FINDING: lazily clear only the exact %s cookie override while retaining both historical session rows', async kind => {
    const past = new Date(Date.now() - 60_000);
    const dead = kind === 'expired' ? { expiresAt: past } : { revokedAt: past, revokedReason: 'ZZ TEST prior revocation' };
    await override(dead);
    await ctx.db.update(session).set({ operatorOverride: f.target, ...dead }).where(eq(session.id, f.otherSession));
    const before = await seat(), untouched = await seat(f.otherSession), unchanged = await identity();
    expect((await read('/me')).statusCode).toBe(401);
    expect(await seat()).toEqual({ ...before, operatorOverride: null });
    expect(await seat(f.otherSession)).toEqual(untouched); expect(await identity()).toEqual(unchanged);
  });
  it('R12 [high] an unknown cookie performs no broad expiry cleanup', async () => {
    await override({ expiresAt: new Date(Date.now() - 60_000) }); const before = await seat();
    expect((await read('/me', `oto_session=${randomBytes(32).toString('hex')}`)).statusCode).toBe(401);
    expect(await seat()).toEqual(before);
  });
  it('R13 [high] ordinary null-override sessions retain home scope and do not need the switch permission', async () => {
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.id, f.switchGrant));
    const before = await identity(), response = await read('/branches'); expect(response.statusCode).toBe(200);
    expect(response.json().branches.map((b: { id: string }) => b.id)).toEqual([f.homeBranch]);
    expect((await target(f.foreign)).statusCode).toBe(200);
    expect((await read('/me')).json()).toMatchObject({ account: { operatorId: f.home }, isPlatformAdmin: true });
    expect(await identity()).toEqual(before);
  });
  it('R14 [critical] a target account platform assignment never grants the real caller platform authority', async () => {
    await ctx.db.update(roleAssignment).set({ scopeId: f.home }).where(inArray(roleAssignment.id, [f.switchGrant, f.readGrant]));
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: f.targetActor, roleId: f.readRole, scopeType: 'operator', scopeId: null });
    const me = await read('/me'); expect(me.statusCode).toBe(200); expect(me.json().isPlatformAdmin).toBe(false);
    await override(); await refusal(403, probe, 'FORBIDDEN');
  });
  it('R15 [critical] FINDING: query and headers cannot supply an override or replace the verified context fields', async () => {
    await override();
    const response = await ctx.app.inject({ method: 'GET', url: `${probe}?operatorId=${f.foreign}&operatorRevision=99`,
      headers: { cookie: f.cookie, 'x-operator-id': f.foreign, 'x-home-operator-id': f.target } });
    expect(response.statusCode).toBe(200);
    expect(response.json().auth).toMatchObject({ accountId: f.actor, operatorId: f.target, homeOperatorId: f.home,
      operatorOverride: f.target, operatorRevision: 0 });
  });

  for (const invalid of ['withdrawn grant', 'nonstaff override'] as const) {
    const invalidate = async () => {
      await override();
      if (invalid === 'withdrawn grant') await ctx.db.update(roleAssignment).set({ archivedAt: new Date() }).where(eq(roleAssignment.id, f.switchGrant));
      else await ctx.db.update(session).set({ sessionClass: 'display' }).where(eq(session.id, f.live));
      await refusal(403, probe, 'FORBIDDEN');
    };
    it(`R16 [high] FINDING: public sign-out after ${invalid} must revoke the exact session and audit it, not merely clear a cookie`, async () => {
      await invalidate(); const before = await seat(), other = await seat(f.otherSession), smsBefore = ctx.smsLog.length;
      const response = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie: f.cookie } });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true });
      const ended = await seat();
      expect(ended).toMatchObject({ id: f.live, accountId: f.actor, tokenHash: before.tokenHash,
        expiresAt: before.expiresAt, revokedAt: expect.any(Date), revokedReason: 'sign_out' });
      const events = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'auth.sign_out'), eq(auditLog.entityType, 'session'), eq(auditLog.entityId, f.live)));
      expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ actorAccountId: f.actor, operatorId: f.home, entityId: f.live });
      expect((await read('/me')).statusCode).toBe(401); expect((await read()).statusCode).toBe(401);
      expect(await seat(f.otherSession)).toEqual(other); expect(ctx.smsLog.length).toBe(smsBefore);
    });
    it(`R17 [high] FINDING: public native sign-in after ${invalid} can issue a fresh ordinary session without reviving the invalid override`, async () => {
      const phone = '+6698064' + String(recoveryPhoneSequence++).padStart(4, '0'), password = randomBytes(24).toString('hex');
      await ctx.db.update(account).set({ phone, passwordHash: await hash(password) }).where(eq(account.id, f.actor));
      await invalidate(); const before = await seat(), other = await seat(f.otherSession), smsBefore = ctx.smsLog.length;
      const response = await ctx.app.inject({ method: 'POST', url: '/auth/sign-in', headers: { cookie: f.cookie }, payload: { phone, password } });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ accountId: f.actor, mustChangePassword: false });
      const setCookie = response.headers['set-cookie'], nextCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
      expect(Boolean(nextCookie?.startsWith('oto_session='))).toBe(true);
      const nextHash = hashToken(nextCookie!.slice('oto_session='.length));
      const [fresh] = await ctx.db.select().from(session).where(and(eq(session.accountId, f.actor), eq(session.tokenHash, nextHash)));
      expect(fresh).toMatchObject({ accountId: f.actor, operatorOverride: null, sessionClass: 'staff', revokedAt: null });
      expect(fresh!.id === f.live).toBe(false);
      const current = await read('/me', nextCookie); expect(current.statusCode).toBe(200);
      expect(current.json().account).toMatchObject({ id: f.actor, operatorId: f.home });
      expect((await read(probe, nextCookie)).statusCode).toBe(200);
      await refusal(403, probe, 'FORBIDDEN');
      expect(await seat()).toEqual(before); expect(await seat(f.otherSession)).toEqual(other); expect(ctx.smsLog.length).toBe(smsBefore);
    });
    it(`R18 [high] FINDING: public health/readiness ignore ${invalid} while business calls still fail closed`, async () => {
      await invalidate(); const before = await seat(), unchanged = await identity();
      const health = await read('/health'); expect(health.statusCode).toBe(200); expect(health.json()).toEqual({ status: 'ok' });
      const ready = await read('/ready'); expect(ready.statusCode).toBe(200); expect(ready.json().checks.database.ok).toBe(true);
      await refusal(403, probe, 'FORBIDDEN');
      expect(await seat()).toEqual(before); expect(await identity()).toEqual(unchanged);
    });
  }
});
