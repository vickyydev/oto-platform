import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, box, branch, employee, operator, role, roleAssignment,
  rolePermission, session, staffToken, station } from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken } from '../src/plugins/session';
import { invalidateAllSessions, signOut } from '../src/services/auth';
import { audit } from '../src/services/audit';
import { switchSessionOperator } from '../src/services/operator-switch';
import { createTestContext, teardownAll, type TestContext } from './helpers';

// Q22: clear the working override in the native revocation transaction. The
// existing session review already proves exact-cookie expiry/public recovery.
// No cookie, password, token hash or bearer is passed to an assertion.
let ctx: TestContext;
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { ctx = await createTestContext(); }, 300_000);
beforeEach(async () => { f = await fixture(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function fixture() {
  const ids = { home: newId(), target: newId(), other: newId(), homeBranch: newId(),
    otherBranch: newId(), employee: newId(), actor: newId(), otherActor: newId(),
    role: newId(), grant: newId(), box: newId(), station: newId(), live: newId(),
    sibling: newId(), expired: newId(), history: newId(), otherSession: newId(),
    token: newId(), siblingToken: newId(), expiredToken: newId() };
  await ctx.db.insert(operator).values([
    { id: ids.home, name: 'ZZ TEST 640 lifecycle home' },
    { id: ids.target, name: 'ZZ TEST 640 lifecycle selected' },
    { id: ids.other, name: 'ZZ TEST 640 lifecycle unrelated' },
  ]);
  await ctx.db.insert(branch).values([
    { id: ids.homeBranch, operatorId: ids.home, name: 'ZZ TEST 640 lifecycle park', code: `zz-test-${ids.homeBranch}` },
    { id: ids.otherBranch, operatorId: ids.other, name: 'ZZ TEST 640 other park', code: `zz-test-${ids.otherBranch}` },
  ]);
  await ctx.db.insert(employee).values({ id: ids.employee, operatorId: ids.home,
    branchId: ids.homeBranch, name: 'ZZ TEST 640 unchanged lifecycle employee' });
  await ctx.db.insert(account).values([
    { id: ids.actor, operatorId: ids.home, employeeId: ids.employee, phone: '+66999996440', status: 'active' },
    { id: ids.otherActor, operatorId: ids.other, phone: '+66999996441', status: 'active' },
  ]);
  await ctx.db.insert(role).values({ id: ids.role, operatorId: ids.home, name: 'ZZ TEST 640 lifecycle switch' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: ids.role, permission: 'platform:operator:switch' });
  await ctx.db.insert(roleAssignment).values({ id: ids.grant, accountId: ids.actor,
    roleId: ids.role, scopeType: 'operator', scopeId: null });
  await ctx.db.insert(box).values({ id: ids.box, operatorId: ids.home, branchId: ids.homeBranch,
    name: 'ZZ TEST 640 lifecycle box', slot: `zz-test-${ids.box}` });
  await ctx.db.insert(station).values({ id: ids.station, operatorId: ids.home, branchId: ids.homeBranch,
    boxId: ids.box, name: 'ZZ TEST 640 lifecycle till' });
  const raw = randomBytes(32).toString('hex'), future = new Date(Date.now() + 3_600_000);
  const past = new Date(Date.now() - 60_000), seen = new Date();
  const cookieHash = hashToken(raw);
  await ctx.db.insert(session).values([
    { id: ids.live, accountId: ids.actor, tokenHash: cookieHash, operatorOverride: ids.target, expiresAt: future, lastSeenAt: seen },
    { id: ids.sibling, accountId: ids.actor, tokenHash: hashToken(randomBytes(32).toString('hex')),
      operatorOverride: ids.target, expiresAt: future, lastSeenAt: seen },
    { id: ids.expired, accountId: ids.actor, tokenHash: hashToken(randomBytes(32).toString('hex')),
      operatorOverride: ids.target, expiresAt: past, lastSeenAt: seen },
    { id: ids.history, accountId: ids.actor, tokenHash: hashToken(randomBytes(32).toString('hex')),
      operatorOverride: ids.target, expiresAt: future, lastSeenAt: seen, revokedAt: past, revokedReason: 'ZZ TEST prior revocation' },
    { id: ids.otherSession, accountId: ids.otherActor, tokenHash: hashToken(randomBytes(32).toString('hex')),
      branchId: ids.otherBranch, expiresAt: future, lastSeenAt: seen },
  ]);
  // Native revocation consumes these retained credential metadata rows. No
  // actual bearer or signing key is required or created for this boundary.
  const issuedAt = new Date(Date.now() - 3_600_000);
  await ctx.db.insert(staffToken).values([
    { jti: ids.token, sessionId: ids.live, expiresAt: future },
    { jti: ids.siblingToken, sessionId: ids.sibling, expiresAt: future },
    { jti: ids.expiredToken, sessionId: ids.expired, expiresAt: past },
  ].map(row => ({ ...row, operatorId: ids.home, branchId: ids.homeBranch, accountId: ids.actor,
    boxId: ids.box, stationId: ids.station, kid: 'zz-test-640-lifecycle', issuedAt })));
  return { ...ids, cookie: `oto_session=${raw}`, cookieHash };
}

const sessionIds = () => [f.live, f.sibling, f.expired, f.history, f.otherSession];
const seats = () => ctx.db.select({ id: session.id, accountId: session.accountId,
  operatorOverride: session.operatorOverride, branchId: session.branchId, stationId: session.stationId,
  sessionClass: session.sessionClass, lockedAt: session.lockedAt, revokedAt: session.revokedAt,
  revokedReason: session.revokedReason, expiresAt: session.expiresAt, lastSeenAt: session.lastSeenAt,
  createdAt: session.createdAt }).from(session).where(inArray(session.id, sessionIds())).orderBy(asc(session.id));
const seat = async (id = f.live) => (await seats()).find(row => row.id === id)!;
const tokens = () => ctx.db.select({ jti: staffToken.jti, sessionId: staffToken.sessionId,
  accountId: staffToken.accountId, operatorId: staffToken.operatorId, branchId: staffToken.branchId,
  stationId: staffToken.stationId, boxId: staffToken.boxId, issuedAt: staffToken.issuedAt,
  expiresAt: staffToken.expiresAt, revokedAt: staffToken.revokedAt, revokedReason: staffToken.revokedReason,
  revokedByAccountId: staffToken.revokedByAccountId }).from(staffToken)
  .where(inArray(staffToken.jti, [f.token, f.siblingToken, f.expiredToken])).orderBy(asc(staffToken.jti));
const identities = async () => ({
  accounts: await ctx.db.select({ id: account.id, operatorId: account.operatorId, employeeId: account.employeeId,
    status: account.status, mustChangePassword: account.mustChangePassword }).from(account)
    .where(inArray(account.id, [f.actor, f.otherActor])).orderBy(asc(account.id)),
  employees: await ctx.db.select({ id: employee.id, operatorId: employee.operatorId, branchId: employee.branchId })
    .from(employee).where(eq(employee.id, f.employee)),
  grants: await ctx.db.select({ id: roleAssignment.id, accountId: roleAssignment.accountId,
    roleId: roleAssignment.roleId, scopeType: roleAssignment.scopeType, scopeId: roleAssignment.scopeId,
    archivedAt: roleAssignment.archivedAt }).from(roleAssignment).where(eq(roleAssignment.id, f.grant)),
});
const events = (action: string, entityId = f.live) => ctx.db.select({ id: auditLog.id,
  actorAccountId: auditLog.actorAccountId, operatorId: auditLog.operatorId, branchId: auditLog.branchId,
  action: auditLog.action, entityType: auditLog.entityType, entityId: auditLog.entityId,
  before: auditLog.before, after: auditLog.after, requestId: auditLog.requestId }).from(auditLog)
  .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId))).orderBy(asc(auditLog.id));
const originalCookieStillBound = async () => (await ctx.db.select({ value: session.tokenHash })
  .from(session).where(eq(session.id, f.live)))[0]?.value === f.cookieHash;

async function withAuditFailure(phase: 'insert' | 'commit', action: string, work: () => Promise<void>) {
  // Only fixed test-owned actions are interpolated. A real PostgreSQL trigger
  // tests rollback, including failure at COMMIT; no write path is mocked.
  if (!['auth.sign_out', 'zz_test_640.lifecycle_caller'].includes(action)) throw new Error('ZZ_TEST_640_INVALID_FAILURE_ACTION');
  await ctx.db.execute(sql.raw(`create function core.zz_test_640_lifecycle_fail() returns trigger language plpgsql as $fn$
    begin raise exception 'ZZ_TEST_640_FORCED_LIFECYCLE_ROLLBACK'; end $fn$;`));
  const declaration = phase === 'commit'
    ? 'create constraint trigger zz_test_640_lifecycle_fail after insert on core.audit_log deferrable initially deferred'
    : 'create trigger zz_test_640_lifecycle_fail after insert on core.audit_log';
  await ctx.db.execute(sql.raw(`${declaration} for each row when (new.action = '${action}')
    execute function core.zz_test_640_lifecycle_fail();`));
  try { await work(); }
  finally {
    await ctx.db.execute(sql`drop trigger zz_test_640_lifecycle_fail on core.audit_log`);
    await ctx.db.execute(sql`drop function core.zz_test_640_lifecycle_fail()`);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function reachedWithin(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ZZ_TEST_640_SIGN_OUT_BARRIER_NOT_REACHED')), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe('SCRUM-640 Q22 native lifecycle house review', () => {
  it('R1 [critical] FINDING: native HTTP sign-out revokes and clears exactly its verified session; fix in the same native transaction', async () => {
    const before = await seats(), tokenBefore = await tokens(), identityBefore = await identities();
    const response = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie: f.cookie },
      payload: { sessionId: f.otherSession, accountId: f.otherActor, operatorId: f.other } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true });
    const ended = await seat();
    expect(ended).toEqual({ ...before.find(row => row.id === f.live), operatorOverride: null,
      revokedAt: expect.any(Date), revokedReason: 'sign_out' });
    expect((await seats()).filter(row => row.id !== f.live)).toEqual(before.filter(row => row.id !== f.live));
    const actualTokens = await tokens();
    expect(actualTokens.find(row => row.jti === f.token)).toEqual({ ...tokenBefore.find(row => row.jti === f.token),
      revokedAt: expect.any(Date), revokedReason: 'sign_out', revokedByAccountId: f.actor });
    expect(actualTokens.filter(row => row.jti !== f.token)).toEqual(tokenBefore.filter(row => row.jti !== f.token));
    const success = await events('auth.sign_out'); expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({ actorAccountId: f.actor, operatorId: f.home, branchId: null,
      entityType: 'session', entityId: f.live, before: null, after: null });
    expect(await identities()).toEqual(identityBefore); expect(await originalCookieStillBound()).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: f.cookie } })).statusCode).toBe(401);
    const cleared = response.headers['set-cookie'];
    expect((Array.isArray(cleared) ? cleared : [cleared]).some(value => typeof value === 'string'
      && value.startsWith('oto_session=;') && /expires=Thu, 01 Jan 1970|Max-Age=0/i.test(value))).toBe(true);
  });

  it('R2 [high] ordinary home sign-out retains the native status, event owner, seat and historical row', async () => {
    await ctx.db.update(session).set({ operatorOverride: null, branchId: f.homeBranch, stationId: f.station }).where(eq(session.id, f.live));
    const before = await seat(), identityBefore = await identities();
    const response = await ctx.app.inject({ method: 'POST', url: '/auth/sign-out', headers: { cookie: f.cookie } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true });
    expect(await seat()).toEqual({ ...before, revokedAt: expect.any(Date), revokedReason: 'sign_out' });
    expect((await events('auth.sign_out')).map(({ actorAccountId, operatorId, branchId, before: prior, after }) =>
      ({ actorAccountId, operatorId, branchId, before: prior, after })))
      .toEqual([{ actorAccountId: f.actor, operatorId: f.home, branchId: null, before: null, after: null }]);
    expect(await identities()).toEqual(identityBefore); expect(await originalCookieStillBound()).toBe(true);
  });

  it.each(['insert', 'commit'] as const)('R3 [critical] a real audit %s failure rolls back revocation, override clear and shift-token changes together', async phase => {
    const before = await seats(), tokenBefore = await tokens(), identityBefore = await identities();
    const requestId = `zz-test-640-sign-out-${newId()}`;
    await withAuditFailure(phase, 'auth.sign_out', async () => {
      let rejected = false;
      try { await signOut(ctx.db, f.live, f.actor, requestId); } catch { rejected = true; }
      expect(rejected).toBe(true);
    });
    expect(await seats()).toEqual(before); expect(await tokens()).toEqual(tokenBefore);
    expect(await identities()).toEqual(identityBefore); expect(await originalCookieStillBound()).toBe(true);
    expect(await events('auth.sign_out')).toEqual([]);
    const failures = await events('auth.sign_out.failed', requestId); expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ actorAccountId: f.actor, operatorId: f.home,
      entityType: 'operation', entityId: requestId, requestId });
  });

  it('R4 [critical] FINDING: invalidateAllSessions clears only the revoked account rows in its caller transaction, including an unrevoked expired row', async () => {
    const before = await seats(), tokenBefore = await tokens(), identityBefore = await identities();
    const ended = await ctx.db.transaction(tx => invalidateAllSessions(tx, f.actor, 'ZZ TEST account reset'));
    expect(ended).toBe(3);
    const after = await seats();
    for (const id of [f.live, f.sibling, f.expired]) expect(after.find(row => row.id === id)).toEqual({
      ...before.find(row => row.id === id), operatorOverride: null, revokedAt: expect.any(Date), revokedReason: 'ZZ TEST account reset' });
    for (const id of [f.history, f.otherSession]) expect(after.find(row => row.id === id)).toEqual(before.find(row => row.id === id));
    const tokenAfter = await tokens();
    for (const jti of [f.token, f.siblingToken]) expect(tokenAfter.find(row => row.jti === jti)).toEqual({
      ...tokenBefore.find(row => row.jti === jti), revokedAt: expect.any(Date), revokedReason: 'account_revoked', revokedByAccountId: null });
    expect(tokenAfter.find(row => row.jti === f.expiredToken)).toEqual(tokenBefore.find(row => row.jti === f.expiredToken));
    expect(await identities()).toEqual(identityBefore); expect(await originalCookieStillBound()).toBe(true);
  });

  it('R5 [critical] an actual enclosing audit failure rolls all-session clearing and staff-token revocation back', async () => {
    const before = await seats(), tokenBefore = await tokens();
    await withAuditFailure('commit', 'zz_test_640.lifecycle_caller', async () => {
      let rejected = false;
      let ended: number | undefined;
      try {
        await ctx.db.transaction(async tx => {
          ended = await invalidateAllSessions(tx, f.actor, 'ZZ TEST rolled back reset');
          await audit.record(tx, { actorAccountId: f.actor, operatorId: f.home,
            action: 'zz_test_640.lifecycle_caller', entityType: 'account', entityId: f.actor });
        });
      } catch { rejected = true; }
      expect(rejected).toBe(true);
      expect(ended).toBe(3);
    });
    expect(await seats()).toEqual(before); expect(await tokens()).toEqual(tokenBefore);
    expect(await events('zz_test_640.lifecycle_caller', f.actor)).toEqual([]);
  });

  it('R6 [critical] FINDING: a native switch completed before sign-out transaction entry cannot leave the newer override on the revoked row', async () => {
    const reached = deferred(), resume = deferred(), transact = ctx.db.transaction.bind(ctx.db);
    const paused = vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(async (callback, config) => {
      reached.resolve(); await resume.promise; return transact(callback, config);
    });
    // Observe fulfillment/rejection immediately, so an early failure cannot
    // create an unhandled promise while the deterministic barrier is checked.
    const signingOut = signOut(ctx.db, f.live, f.actor).then(() => true, () => false);
    try {
      await reachedWithin(reached.promise);
      const selected = await switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.live,
        operatorId: f.other, expectedRevision: 0 });
      expect(selected).toMatchObject({ effectiveOperatorId: f.other, operatorOverride: f.other, revision: 1 });
      const rebound = await seat(), otherBefore = (await seats()).filter(row => row.id !== f.live);
      resume.resolve(); expect(await signingOut).toBe(true);
      expect(await seat()).toEqual({ ...rebound, operatorOverride: null, revokedAt: expect.any(Date), revokedReason: 'sign_out' });
      expect((await seats()).filter(row => row.id !== f.live)).toEqual(otherBefore);
      expect(await events('session.operator_switch')).toHaveLength(1);
      expect(await events('auth.sign_out')).toHaveLength(1);
      expect(await originalCookieStillBound()).toBe(true);
    } finally { resume.resolve(); try { await signingOut; } finally { paused.mockRestore(); } }
  });

  it('R7 [high] revocation wins before a later native switch and the refusal cannot restore its session or add a switch success', async () => {
    await signOut(ctx.db, f.live, f.actor);
    const before = await seat(), tokensBefore = await tokens();
    await expect(switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.live,
      operatorId: f.other, expectedRevision: 0 })).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(await seat()).toEqual(before); expect(await tokens()).toEqual(tokensBefore);
    expect(await events('session.operator_switch')).toEqual([]);
    expect(await events('auth.sign_out')).toHaveLength(1);
  });

  it('R8 [high] an account with no sessions ends zero and cannot sweep another account or rewrite retained revocation history', async () => {
    const emptyActor = newId();
    await ctx.db.insert(account).values({ id: emptyActor, operatorId: f.home, phone: '+66999996442', status: 'active' });
    const before = await seats(), tokenBefore = await tokens();
    expect(await ctx.db.transaction(tx => invalidateAllSessions(tx, emptyActor))).toBe(0);
    expect(await seats()).toEqual(before); expect(await tokens()).toEqual(tokenBefore);
  });
});
