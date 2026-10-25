import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, auditLog, branch, employee, operator, role, roleAssignment, rolePermission, session, station } from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken } from '../src/plugins/session';
import { switchSessionOperator } from '../src/services/operator-switch';
import { createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { ctx = await createTestContext(); }, 300_000);
beforeEach(async () => { f = await fixture(); });
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

async function fixture() {
  const ids = { home: newId(), target: newId(), homeBranch: newId(), targetBranch: newId(),
    homeStation: newId(), employee: newId(), actor: newId(), switchRole: newId(), readRole: newId(),
    switchGrant: newId(), readGrant: newId(), live: newId(), other: newId() };
  await ctx.db.insert(operator).values([
    { id: ids.home, name: 'ZZ TEST 640 route home' }, { id: ids.target, name: 'ZZ TEST 640 route target' },
  ]);
  await ctx.db.insert(branch).values([
    { id: ids.homeBranch, operatorId: ids.home, name: 'ZZ TEST 640 home park', code: 'zz-test-home' },
    { id: ids.targetBranch, operatorId: ids.target, name: 'ZZ TEST 640 target park', code: 'zz-test-target' },
  ]);
  await ctx.db.insert(station).values({ id: ids.homeStation, operatorId: ids.home,
    branchId: ids.homeBranch, name: 'ZZ TEST 640 home station' });
  await ctx.db.insert(employee).values({ id: ids.employee, operatorId: ids.home,
    branchId: ids.homeBranch, name: 'ZZ TEST 640 home identity', nickname: 'ZZ TEST unchanged' });
  await ctx.db.insert(account).values({ id: ids.actor, operatorId: ids.home, employeeId: ids.employee,
    phone: '+66999996420', status: 'active' });
  await ctx.db.insert(role).values([
    { id: ids.switchRole, operatorId: ids.home, name: 'ZZ TEST 640 route switch' },
    { id: ids.readRole, operatorId: ids.home, name: 'ZZ TEST 640 route read' },
  ]);
  await ctx.db.insert(rolePermission).values([
    { id: newId(), roleId: ids.switchRole, permission: 'platform:operator:switch' },
    { id: newId(), roleId: ids.readRole, permission: 'admin:branch:read' },
  ]);
  await ctx.db.insert(roleAssignment).values([
    { id: ids.switchGrant, accountId: ids.actor, roleId: ids.switchRole, scopeType: 'operator', scopeId: null },
    { id: ids.readGrant, accountId: ids.actor, roleId: ids.readRole, scopeType: 'operator', scopeId: null },
  ]);
  const token = randomBytes(32).toString('hex'), otherToken = randomBytes(32).toString('hex');
  await ctx.db.insert(session).values([
    { id: ids.live, accountId: ids.actor, branchId: ids.homeBranch, stationId: ids.homeStation,
      tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() },
    { id: ids.other, accountId: ids.actor, branchId: ids.homeBranch, stationId: ids.homeStation,
      tokenHash: hashToken(otherToken), expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() },
  ]);
  return { ...ids, cookie: `oto_session=${token}` };
}
const me = () => ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: f.cookie } });
const put = (payload: Record<string, unknown>, key: string | null = newId()) => ctx.app.inject({ method: 'PUT',
  url: '/me/session/operator', headers: { cookie: f.cookie, ...(key ? { 'idempotency-key': key } : {}) }, payload });
const select = (operatorId: string | null, expectedRevision: number, key?: string) => put({ operatorId, expectedRevision }, key);
const seat = async () => (await ctx.db.select().from(session).where(eq(session.id, f.live)))[0]!;
const records = () => ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'session.operator_switch'), eq(auditLog.entityId, f.live)));
const identity = async () => ({
  account: await ctx.db.select().from(account).where(eq(account.id, f.actor)),
  employee: await ctx.db.select().from(employee).where(eq(employee.id, f.employee)),
  assignments: await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, f.actor)),
  other: await ctx.db.select().from(session).where(eq(session.id, f.other)),
});

describe('SCRUM-640 Q20 native operator-selection route and truthful home metadata', () => {
  it('R1 exposes the canonical home context without replacing account or employee identity', async () => {
    const before = await identity(), response = await me();
    expect(response.statusCode).toBe(200);
    expect(response.json().operatorContext).toEqual({ sessionId: f.live, homeOperatorId: f.home, effectiveOperatorId: f.home,
      operatorOverride: null, branchId: f.homeBranch, stationId: f.homeStation, revision: 0 });
    expect(response.json().account).toMatchObject({ id: f.actor, operatorId: f.home });
    expect(response.json().employee).toEqual({ id: f.employee, name: 'ZZ TEST 640 home identity', nickname: 'ZZ TEST unchanged' });
    expect(await identity()).toEqual(before); expect(await records()).toHaveLength(0);
  });
  it('R2 reports an actual switched context beside the same home identity', async () => {
    await switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.live, operatorId: f.target, expectedRevision: 0 });
    const before = await identity(), response = await me();
    expect(response.statusCode).toBe(200);
    expect(response.json().operatorContext).toEqual({ sessionId: f.live, homeOperatorId: f.home, effectiveOperatorId: f.target,
      operatorOverride: f.target, branchId: null, stationId: null, revision: 1 });
    expect(response.json().account.operatorId).toBe(f.home); expect(response.json().employee.id).toBe(f.employee);
    expect(await identity()).toEqual(before);
  });
  it('R3 selects through the registered native route, records one transaction and narrows subsequent reads', async () => {
    const before = await identity(), response = await select(f.target, 0);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ homeOperatorId: f.home, effectiveOperatorId: f.target,
      operatorOverride: f.target, branchId: null, stationId: null, revision: 1, changed: true });
    expect(await seat()).toMatchObject({ operatorOverride: f.target, branchId: null, stationId: null });
    const rows = await records(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorAccountId: f.actor, operatorId: f.home, branchId: null,
      entityType: 'session', entityId: f.live, after: response.json() });
    const branches = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie: f.cookie } });
    expect(branches.statusCode).toBe(200); expect(branches.json().branches.map((row: { id: string }) => row.id)).toEqual([f.targetBranch]);
    expect(await identity()).toEqual(before);
  });
  it.each([null, 'explicit-home'] as const)('R4 returns home with %s and preserves the real actor', async home => {
    await switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.live, operatorId: f.target, expectedRevision: 0 });
    const before = await identity(), response = await select(home === null ? null : f.home, 1);
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ homeOperatorId: f.home,
      effectiveOperatorId: f.home, operatorOverride: null, branchId: null, stationId: null, revision: 2, changed: true });
    expect(await identity()).toEqual(before); expect(await records()).toHaveLength(2);
  });
  it('R5 a same-context selection preserves both seats and still advances the confirmed revision', async () => {
    const response = await select(null, 0);
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ homeOperatorId: f.home,
      effectiveOperatorId: f.home, operatorOverride: null, branchId: f.homeBranch, stationId: f.homeStation, revision: 1, changed: false });
    expect(await records()).toHaveLength(1);
  });
  it.each([
    { expectedRevision: 0 }, { operatorId: null }, { operatorId: 'bad', expectedRevision: 0 },
    { operatorId: null, expectedRevision: -1 }, { operatorId: null, expectedRevision: 0.1 },
    { operatorId: null, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { operatorId: null, expectedRevision: '0' }, { operatorId: null, expectedRevision: 0, accountId: 'spoof' },
    { operatorId: null, expectedRevision: 0, sessionId: 'spoof' },
    { operatorId: null, expectedRevision: 0, homeOperatorId: 'spoof' },
  ])('R6 refuses an invalid or identity-bearing body %# before a selection', async payload => {
    const before = await seat(), response = await put(payload);
    expect(response.statusCode).toBe(400); expect(await seat()).toEqual(before); expect(await records()).toHaveLength(0);
  });
  it('R7 requires a native idempotency key before changing context', async () => {
    const before = await seat(), response = await put({ operatorId: f.target, expectedRevision: 0 }, null);
    expect(response.statusCode).toBe(400); expect(await seat()).toEqual(before); expect(await records()).toHaveLength(0);
  });
  it.each(['absent', 'own-operator'] as const)('R8 refuses %s switch authority despite unrelated global reads', async mode => {
    if (mode === 'absent') await ctx.db.delete(rolePermission).where(eq(rolePermission.roleId, f.switchRole));
    else await ctx.db.update(roleAssignment).set({ scopeId: f.home }).where(eq(roleAssignment.id, f.switchGrant));
    const before = await seat(), response = await select(f.target, 0);
    expect(response.statusCode).toBe(403); expect(await seat()).toEqual(before);
    expect(await records()).toHaveLength(0);
  });
  it.each(['locked', 'temporary', 'nonstaff'] as const)('R9 retains native %s refusal', async mode => {
    if (mode === 'locked') await ctx.db.update(session).set({ lockedAt: new Date() }).where(eq(session.id, f.live));
    if (mode === 'temporary') await ctx.db.update(account).set({ mustChangePassword: true }).where(eq(account.id, f.actor));
    if (mode === 'nonstaff') await ctx.db.update(session).set({ sessionClass: 'display' }).where(eq(session.id, f.live));
    const before = await seat(), response = await select(f.target, 0);
    expect(response.statusCode).toBe(mode === 'locked' ? 423 : 403); expect(await seat()).toEqual(before);
  });
  it('R10 refuses a stale displayed revision without applying a later choice', async () => {
    await switchSessionOperator(ctx.db, { accountId: f.actor, sessionId: f.live, operatorId: f.target, expectedRevision: 0 });
    const before = await seat(), response = await select(null, 0);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('OPERATOR_SWITCH_STALE');
    expect(await seat()).toEqual(before); expect(await records()).toHaveLength(1);
  });
  it('R11 a same-key lost acknowledgement replays only its current committed confirmation', async () => {
    const key = newId(), first = await select(f.target, 0, key), replay = await select(f.target, 0, key);
    expect(first.statusCode).toBe(200); expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(first.json());
    expect(await records()).toHaveLength(1);
  });
  it('R12 offers the declared operator-wide permission and typed request/response contract', () => {
    const route = ctx.app.routeRegistry.find(row => row.method === 'PUT' && row.url === '/me/session/operator');
    expect(route).toBeDefined(); expect(route!.config.permission).toBe('platform:operator:switch');
    expect(route!.config.target).toEqual({ operator: true });
    const schema = ctx.app.swagger().paths?.['/me/session/operator']?.put;
    expect(schema).toHaveProperty('requestBody'); expect(schema?.responses).toHaveProperty('200');
  });
  it('R13 never takes session identity from a second session of the same account', async () => {
    const unchanged = await ctx.db.select().from(session).where(inArray(session.id, [f.live, f.other]));
    const response = await put({ operatorId: f.target, expectedRevision: 0, sessionId: f.other });
    expect(response.statusCode).toBe(400);
    expect(await ctx.db.select().from(session).where(inArray(session.id, [f.live, f.other]))).toEqual(unchanged);
  });
});
