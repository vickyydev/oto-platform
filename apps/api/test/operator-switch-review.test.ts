import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, branch, employee, operator, role, roleAssignment, rolePermission, schema, session, station, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { newId } from '@oto/shared';
import { audit } from '../src/services/audit';
import { operatorSwitchOptionsOf, switchSessionOperator } from '../src/services/operator-switch';

const now = new Date('2026-10-25T12:00:00.000Z'), permission = 'platform:operator:switch';
let database: Awaited<ReturnType<typeof createTestDatabase>>, pool: pg.Pool, db: Db;
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  database = await createTestDatabase();
  pool = new pg.Pool({ connectionString: database.url, max: 6, application_name: 'oto-test-640-service' });
  db = drizzle(pool, { schema }) as Db;
}, 300_000);
beforeEach(async () => { f = await fixture(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { try { await pool?.end(); } finally { try { await database?.drop(); } finally { await stopTestServer(); } } });

async function fixture() {
  const ids = { home: newId(), target: newId(), archived: newId(), branch: newId(), station: newId(), employee: newId(),
    actor: newId(), other: newId(), session: newId(), secondSession: newId(), otherSession: newId(), role: newId(), assignment: newId() };
  await db.insert(operator).values([{ id: ids.home, name: 'ZZ TEST 640 home' }, { id: ids.target, name: 'ZZ TEST 640 target' },
    { id: ids.archived, name: 'ZZ TEST 640 archived', archivedAt: now }]);
  await db.insert(branch).values({ id: ids.branch, operatorId: ids.home, name: 'ZZ TEST 640 branch', code: 'zz-test-640' });
  await db.insert(station).values({ id: ids.station, operatorId: ids.home, branchId: ids.branch, name: 'ZZ TEST 640 station' });
  await db.insert(employee).values({ id: ids.employee, operatorId: ids.home, branchId: ids.branch, name: 'ZZ TEST 640 employee' });
  await db.insert(account).values([{ id: ids.actor, operatorId: ids.home, employeeId: ids.employee, phone: '+66999996401', status: 'active' },
    { id: ids.other, operatorId: ids.home, phone: '+66999996402', status: 'active' }]);
  await db.insert(role).values({ id: ids.role, operatorId: ids.home, name: 'ZZ TEST 640 deliberately granted', isSystem: false });
  await db.insert(rolePermission).values({ id: newId(), roleId: ids.role, permission });
  await db.insert(roleAssignment).values({ id: ids.assignment, accountId: ids.actor, roleId: ids.role, scopeType: 'operator', scopeId: null });
  await db.insert(session).values([ids.session, ids.secondSession, ids.otherSession].map(id => ({ id,
    accountId: id === ids.otherSession ? ids.other : ids.actor, branchId: ids.branch, stationId: ids.station,
    tokenHash: createHash('sha256').update(id).digest('hex'), expiresAt: new Date(now.getTime() + 3_600_000) })));
  return ids;
}
const identity = () => ({ accountId: f.actor, sessionId: f.session });
const options = () => operatorSwitchOptionsOf(db, identity(), now);
const move = (operatorId: string | null = f.target, expectedRevision = 0) => switchSessionOperator(db,
  { ...identity(), operatorId, expectedRevision }, { actorAccountId: f.actor, operatorId: f.home, requestId: `zz-test-640-${newId()}` }, now);
const row = async () => (await db.select().from(session).where(eq(session.id, f.session)))[0]!;
const audits = () => db.select().from(auditLog).where(and(eq(auditLog.entityType, 'session'), eq(auditLog.entityId, f.session), eq(auditLog.action, 'session.operator_switch')));
const snapshot = async () => ({ session: await row(), accounts: await db.select().from(account).where(eq(account.operatorId, f.home)),
  employees: await db.select().from(employee).where(eq(employee.operatorId, f.home)), grants: await db.select().from(roleAssignment).where(eq(roleAssignment.accountId, f.actor)),
  otherSessions: await db.select().from(session).where(inArray(session.id, [f.secondSession, f.otherSession])) });
async function refused(run: () => Promise<unknown>, statusCode: number, code?: string) {
  const before = await snapshot(), successBefore = await audits();
  await expect(run()).rejects.toMatchObject({ statusCode, ...(code ? { code } : {}) });
  expect(await snapshot()).toEqual(before); expect(await audits()).toEqual(successBefore);
}

describe('SCRUM-640 native operator-switch service house review; central routes and cached replay remain held', () => {
  it('R1 [high] options read current context and actual live operators without changing session, home identity or audit', async () => {
    const before = await snapshot(), result = await options();
    expect(result).toMatchObject({ homeOperatorId: f.home, effectiveOperatorId: f.home, operatorOverride: null,
      branchId: f.branch, stationId: f.station, revision: 0, changed: false });
    const live = await db.select({ id: operator.id, name: operator.name }).from(operator).where(isNull(operator.archivedAt));
    expect([...result.operators].sort((a, b) => a.id.localeCompare(b.id))).toEqual(live.sort((a, b) => a.id.localeCompare(b.id)));
    expect(result.operators.some(o => o.id === f.archived)).toBe(false); expect(await snapshot()).toEqual(before); expect(await audits()).toEqual([]);
  });
  it('R2 [critical] switches only this session, clears its seat, and commits one truthful actor/session audit', async () => {
    const before = await snapshot(), result = await move();
    expect(result).toEqual({ homeOperatorId: f.home, effectiveOperatorId: f.target, operatorOverride: f.target,
      branchId: null, stationId: null, revision: 1, changed: true });
    expect(await row()).toEqual({ ...before.session, operatorOverride: f.target, branchId: null, stationId: null });
    const after = await snapshot(); expect({ ...after, session: before.session }).toEqual(before);
    expect(await audits()).toHaveLength(1);
    expect((await audits())[0]).toMatchObject({ actorAccountId: f.actor, entityId: f.session, entityType: 'session',
      before: { effectiveOperatorId: f.home, operatorOverride: null, branchId: f.branch, stationId: f.station, revision: 0 },
      after: { effectiveOperatorId: f.target, operatorOverride: f.target, branchId: null, stationId: null, revision: 1 } });
    expect(await options()).toMatchObject({ ...result, changed: false });
  });
  it.each(['null', 'home'] as const)('R3 [high] returning by %s canonicalizes home to null without inventing a branch or changing the account', async input => {
    await move(); const result = await move(input === 'null' ? null : f.home, 1);
    expect(result).toEqual({ homeOperatorId: f.home, effectiveOperatorId: f.home, operatorOverride: null, branchId: null, stationId: null, revision: 2, changed: true });
    expect((await row()).operatorOverride).toBeNull(); expect((await audits()).map(a => (a.after as { revision: number }).revision).sort()).toEqual([1, 2]);
  });
  it('R4 [high] current-target selections with the latest revision are audited no-ops retaining the seat; no key-cache replay is claimed', async () => {
    const before = await row();
    expect(await move(f.home)).toMatchObject({ operatorOverride: null, branchId: f.branch, stationId: f.station, changed: false, revision: 1 });
    expect(await move(null, 1)).toMatchObject({ operatorOverride: null, branchId: f.branch, stationId: f.station, changed: false, revision: 2 });
    expect(await row()).toEqual(before); expect(await audits()).toHaveLength(2);
  });
  it('R5 [critical] an own-operator switch grant or a role named operator_admin cannot replace genuine null operator scope', async () => {
    await db.update(role).set({ name: 'operator_admin' }).where(eq(role.id, f.role));
    await db.update(roleAssignment).set({ scopeId: f.home }).where(eq(roleAssignment.id, f.assignment));
    await refused(options, 403); await refused(() => move(), 403);
  });
  it('R6 [critical] an unrelated null-scope permission plus branch-only switch permission cannot be unioned into switch authority', async () => {
    await db.update(roleAssignment).set({ scopeType: 'branch', scopeId: f.branch }).where(eq(roleAssignment.id, f.assignment));
    const r = newId(); await db.insert(role).values({ id: r, name: 'ZZ TEST 640 unrelated platform marker', isSystem: true });
    await db.insert(rolePermission).values({ id: newId(), roleId: r, permission: 'admin:health:read' });
    await db.insert(roleAssignment).values({ id: newId(), accountId: f.actor, roleId: r, scopeType: 'operator', scopeId: null });
    await refused(options, 403); await refused(() => move(), 403);
  });
  it.each(['archived assignment', 'deleted assignment', 'withdrawn permission'] as const)('R7 [critical] rechecks %s after a previously successful options read', async kind => {
    await options();
    if (kind === 'archived assignment') await db.update(roleAssignment).set({ archivedAt: now }).where(eq(roleAssignment.id, f.assignment));
    else if (kind === 'deleted assignment') await db.delete(roleAssignment).where(eq(roleAssignment.id, f.assignment));
    else await db.delete(rolePermission).where(eq(rolePermission.roleId, f.role));
    await refused(options, 403); await refused(() => move(), 403);
  });
  it.each(['inactive', 'invited'] as const)('R8 [critical] refuses an %s account without touching another live session', async status => {
    await db.update(account).set({ status }).where(eq(account.id, f.actor)); await refused(options, 401); await refused(() => move(), 401);
  });
  it('R9 [critical] rejects a retired home operator even when the target and grant remain live', async () => {
    await db.update(operator).set({ archivedAt: now }).where(eq(operator.id, f.home)); await refused(options, 401); await refused(() => move(), 401);
  });
  it.each(['unknown', 'archived'] as const)('R10 [high] refuses an %s target without a success audit or partial seat clearing', async kind => {
    await refused(() => move(kind === 'unknown' ? newId() : f.archived), 404);
  });
  it.each(['expired', 'revoked', 'locked', 'display', 'temporary password', 'archived seat'] as const)('R11 [critical] preserves native %s session refusal', async kind => {
    if (kind === 'expired') await db.update(session).set({ expiresAt: now }).where(eq(session.id, f.session));
    if (kind === 'revoked') await db.update(session).set({ revokedAt: now }).where(eq(session.id, f.session));
    if (kind === 'locked') await db.update(session).set({ lockedAt: now }).where(eq(session.id, f.session));
    if (kind === 'display') await db.update(session).set({ sessionClass: 'display' }).where(eq(session.id, f.session));
    if (kind === 'temporary password') await db.update(account).set({ mustChangePassword: true }).where(eq(account.id, f.actor));
    if (kind === 'archived seat') await db.update(branch).set({ archivedAt: now }).where(eq(branch.id, f.branch));
    const status = kind === 'locked' ? 423 : kind === 'display' || kind === 'temporary password' ? 403 : 401;
    const code = kind === 'locked' ? 'SESSION_LOCKED' : kind === 'temporary password' ? 'MUST_CHANGE_PASSWORD' : undefined;
    await refused(options, status, code); await refused(() => move(), status, code);
  });
  it('R12 [critical] never switches or describes a session belonging to another account', async () => {
    await refused(() => operatorSwitchOptionsOf(db, { ...identity(), sessionId: f.otherSession }, now), 401);
    await refused(() => switchSessionOperator(db, { ...identity(), sessionId: f.otherSession, operatorId: f.target, expectedRevision: 0 }, {}, now), 401);
  });
  it('R13 [critical] stale revision refuses both an old target and an apparent home no-op after A-B-A', async () => {
    await move(); await move(null, 1); await refused(() => move(f.target, 0), 409); await refused(() => move(null, 0), 409);
    expect(await options()).toMatchObject({ effectiveOperatorId: f.home, operatorOverride: null, revision: 2 });
  });
  it('R14 [critical] audit failure rolls the override, both seat fields and revision back together', async () => {
    const before = await snapshot();
    const failedAudit = vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('ZZ_TEST_640_AUDIT_FAILURE'));
    await expect(move()).rejects.toThrow('ZZ_TEST_640_AUDIT_FAILURE'); expect(failedAudit).toHaveBeenCalled();
    expect(await snapshot()).toEqual(before); expect(await audits()).toEqual([]); expect(await options()).toMatchObject({ revision: 0 });
  });
  it('R15 [critical] concurrent selections at one revision serialize: exactly one commits, the loser conflicts and adds no second audit', async () => {
    const blocker = await pool.connect(); await blocker.query('begin');
    await blocker.query('select id from core.session where id = $1 for update', [f.session]);
    let settled = false;
    const work = Promise.allSettled([move(f.target), move(null)]).then(results => { settled = true; return results; });
    try {
      const deadline = Date.now() + 5_000;
      while (!settled && Date.now() < deadline) {
        const waiting = await pool.query<{ n: number }>(`select count(*)::int n from pg_stat_activity where datname = current_database()
          and application_name = 'oto-test-640-service' and wait_event_type = 'Lock'`);
        if (waiting.rows[0]!.n >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { await blocker.query('rollback'); blocker.release(); }
    const outcomes = await work, successes = outcomes.filter(r => r.status === 'fulfilled'), failures = outcomes.filter(r => r.status === 'rejected');
    expect(successes).toHaveLength(1); expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expect(await audits()).toHaveLength(1); expect(await options()).toMatchObject({ revision: 1 });
    const winner = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof move>>>).value;
    expect(await row()).toMatchObject({ operatorOverride: winner.operatorOverride, branchId: winner.branchId, stationId: winner.stationId });
  });
  it('R16 [critical] an existing override pointing at an archived operator fails closed instead of silently returning home', async () => {
    await db.update(session).set({ operatorOverride: f.archived, branchId: null, stationId: null }).where(eq(session.id, f.session));
    await refused(options, 401); await refused(() => move(null), 401);
  });
  it('R17 [critical] a foreign branch/station left in a home session fails closed without normalizing the seat or home employee', async () => {
    const b = newId(), s = newId();
    await db.insert(branch).values({ id: b, operatorId: f.target, name: 'ZZ TEST 640 foreign stale branch', code: 'zz-test-640-stale' });
    await db.insert(station).values({ id: s, operatorId: f.target, branchId: b, name: 'ZZ TEST 640 foreign stale station' });
    await db.update(session).set({ branchId: b, stationId: s }).where(eq(session.id, f.session));
    await refused(options, 401); await refused(() => move(), 401);
  });
  it('PIN R18 [high] attribute refusals to verified identity before later checks; ignore spoofed context and keep the session audit branchless', async () => {
    const foreignBranch = newId(), requestId = `zz-test-640-denied-${newId()}`;
    await db.insert(branch).values({ id: foreignBranch, operatorId: f.target, name: 'ZZ TEST 640 spoofed audit branch', code: 'zz-test-640-audit-spoof' });
    await db.update(roleAssignment).set({ archivedAt: now }).where(eq(roleAssignment.id, f.assignment));
    const before = await snapshot(), successBefore = await audits();
    await expect(switchSessionOperator(db, { ...identity(), operatorId: f.target, expectedRevision: 0 },
      { requestId, actorAccountId: f.other, operatorId: f.target, branchId: foreignBranch }, now))
      .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    const failed = await db.select().from(auditLog).where(eq(auditLog.requestId, requestId));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ action: 'session.operator_switch.failed', actorAccountId: f.actor,
      operatorId: f.home, branchId: null, after: { error: 'FORBIDDEN' } });
    expect(await snapshot()).toEqual(before); expect(await audits()).toEqual(successBefore);
  });
  it('PIN R19 [high] anchor session-level success audits to home with no branch; retain foreign seat facts only in before/after', async () => {
    await move(); const b = newId(), s = newId(), requestId = `zz-test-640-foreign-seat-audit-${newId()}`;
    await db.insert(branch).values({ id: b, operatorId: f.target, name: 'ZZ TEST 640 switched branch', code: 'zz-test-640-switch-seat' });
    await db.insert(station).values({ id: s, operatorId: f.target, branchId: b, name: 'ZZ TEST 640 switched station' });
    await db.update(session).set({ branchId: b, stationId: s }).where(eq(session.id, f.session));
    const before = await snapshot();
    const result = await switchSessionOperator(db, { ...identity(), operatorId: f.target, expectedRevision: 1 },
      { requestId, actorAccountId: f.actor, operatorId: f.target, branchId: b }, now);
    expect(result).toMatchObject({ homeOperatorId: f.home, effectiveOperatorId: f.target, operatorOverride: f.target,
      branchId: b, stationId: s, changed: false, revision: 2 });
    expect(await snapshot()).toEqual(before); expect(await audits()).toHaveLength(2);
    const recorded = await db.select().from(auditLog).where(eq(auditLog.requestId, requestId));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'session.operator_switch', actorAccountId: f.actor,
      operatorId: f.home, branchId: null, entityType: 'session', entityId: f.session,
      before: { effectiveOperatorId: f.target, branchId: b, stationId: s, revision: 1 },
      after: { effectiveOperatorId: f.target, branchId: b, stationId: s, revision: 2 } });
  });
});
