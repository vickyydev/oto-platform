import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, like, ne, notLike, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account, appIdentity, auditLog, branch, otoappUserBranchAccess, otoappUsers,
  role, roleAssignment, session,
} from '@oto/db';
import { newId } from '@oto/shared';
import { hashToken, SESSION_COOKIE } from '../src/plugins/session';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-632 house review of the platform boundary: native app administration
 * becoming read-only must leave the authorized identity seam usable. These
 * pins use the real Fastify routes and database, without the app's npm tree.
 */
let ctx: TestContext;
let actorId: string;
let cookie: string;
let operatorId: string;
let foreignOperatorId: string;
let parks: [string, string];
let foreignPark: string;
const tenantId = newId(), foreignTenantId = newId();
const legalEntity = newId(), foreignEntity = newId();
const appParks = [newId(), newId()] as const;
const foreignAppPark = newId();

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  const [administrator] = await ctx.db.select({ id: account.id, operatorId: account.operatorId }).from(account)
    .innerJoin(roleAssignment, eq(roleAssignment.accountId, account.id)).innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(and(eq(role.name, 'platform_admin'), isNull(role.operatorId), eq(account.status, 'active'))).limit(1);
  actorId = administrator!.id; operatorId = administrator!.operatorId;
  const openParks = await ctx.db.select({ id: branch.id, operatorId: branch.operatorId }).from(branch)
    .where(isNull(branch.archivedAt)).orderBy(branch.id);
  const ownParks = openParks.filter(park => park.operatorId === operatorId);
  expect(ownParks.length).toBeGreaterThanOrEqual(2);
  parks = [ownParks[0]!.id, ownParks[1]!.id];
  const foreign = openParks.find(park => park.operatorId !== operatorId)!;
  foreignPark = foreign.id; foreignOperatorId = foreign.operatorId;
  await ctx.db.execute(sql`alter table otoapp.operators add column if not exists platform_roles_enabled boolean not null default false`);
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values
    (${tenantId}, 'ZZ TEST 632 own group', ${`zz-test-632-${tenantId}`}),
    (${foreignTenantId}, 'ZZ TEST 632 foreign group', ${`zz-test-632-${foreignTenantId}`})`);
  await ctx.db.execute(sql`insert into otoapp.operators (id, tenant_id, name, platform_roles_enabled) values
    (${legalEntity}, ${tenantId}, 'ZZ TEST 632 managed entity', true),
    (${foreignEntity}, ${foreignTenantId}, 'ZZ TEST 632 foreign managed entity', true)`);
  for (const [appPark, owner, entity, corePark] of [
    [appParks[0], tenantId, legalEntity, parks[0]],
    [appParks[1], tenantId, legalEntity, parks[1]],
    [foreignAppPark, foreignTenantId, foreignEntity, foreignPark],
  ]) {
    await ctx.db.execute(sql`insert into otoapp.branches (id, tenant_id, operator_id, name, address, core_branch_id)
      values (${appPark}, ${owner}, ${entity}, 'ZZ TEST 632 mapped park', '', ${corePark})`);
  }
  const token = randomBytes(32).toString('hex');
  await ctx.db.insert(session).values({ id: newId(), accountId: actorId, branchId: parks[0],
    tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) });
  cookie = `${SESSION_COOKIE}=${token}`;
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

interface Person { accountId: string; userId: string }
async function person(foreign = false): Promise<Person> {
  const accountId = newId(), userId = newId();
  await ctx.db.insert(account).values({ id: accountId, operatorId: foreign ? foreignOperatorId : operatorId,
    phone: `ZZ TEST 632 ${accountId}`, status: 'active' });
  await ctx.db.insert(otoappUsers).values({ id: userId, email: `zz-test-632-${userId}@example.invalid`,
    password: 'ZZ TEST unusable local credential', fullName: 'ZZ TEST 632 managed person',
    role: 'staff', operatorId: foreign ? foreignEntity : legalEntity, isActive: true, mustChangePassword: true });
  await ctx.db.insert(otoappUserBranchAccess).values({ id: newId(), userId,
    tenantId: foreign ? foreignTenantId : tenantId, branchId: foreign ? foreignAppPark : appParks[0],
    accessScope: 'selected_branches' });
  return { accountId, userId };
}

const headers = () => ({ cookie, 'idempotency-key': newId() });
const link = (p: Person) => ctx.app.inject({ method: 'POST', url: '/admin/apps/oto_app/users',
  headers: headers(), payload: { accountId: p.accountId, externalUserId: p.userId, branchIds: [parks[0]] } });
const accessRows = (p: Person) => ctx.db.select({ tenantId: otoappUserBranchAccess.tenantId,
  branchId: otoappUserBranchAccess.branchId, accessScope: otoappUserBranchAccess.accessScope })
  .from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, p.userId)).orderBy(otoappUserBranchAccess.id);

/** Public business fields only: no password, session token or delivery content. */
async function snapshot(people: readonly Person[]) {
  const accountIds = people.map(p => p.accountId), userIds = people.map(p => p.userId);
  return {
    accounts: await ctx.db.select({ id: account.id, operatorId: account.operatorId, status: account.status })
      .from(account).where(inArray(account.id, accountIds)).orderBy(account.id),
    users: await ctx.db.select({ id: otoappUsers.id, operatorId: otoappUsers.operatorId, role: otoappUsers.role,
      platformUserId: otoappUsers.platformUserId, mustChangePassword: otoappUsers.mustChangePassword })
      .from(otoappUsers).where(inArray(otoappUsers.id, userIds)).orderBy(otoappUsers.id),
    access: await ctx.db.select().from(otoappUserBranchAccess)
      .where(inArray(otoappUserBranchAccess.userId, userIds)).orderBy(otoappUserBranchAccess.id),
    identities: await ctx.db.select().from(appIdentity)
      .where(inArray(appIdentity.accountId, accountIds)).orderBy(appIdentity.id),
    assignments: await ctx.db.select().from(roleAssignment)
      .where(inArray(roleAssignment.accountId, accountIds)).orderBy(roleAssignment.id),
    audit: await ctx.db.select().from(auditLog)
      .where(and(notLike(auditLog.action, '%.failed'), ne(auditLog.action, 'access.denied'))).orderBy(auditLog.id),
    smsCount: ctx.smsLog.length,
  };
}

const denialAudits = () => ctx.db.select().from(auditLog)
  .where(like(auditLog.action, '%.failed')).orderBy(auditLog.id);
const requestDenialAudits = () => ctx.db.select().from(auditLog)
  .where(eq(auditLog.action, 'access.denied')).orderBy(auditLog.id);

/** A rollback retains its one operation-level denial, without a success audit. */
async function expectOneDenial(
  before: Awaited<ReturnType<typeof denialAudits>>,
  expected: { action: 'app_identity.link.failed' | 'app_identity.branches.failed'; requestId: string; error: string },
) {
  const after = await denialAudits();
  const priorIds = new Set(before.map(row => row.id));
  expect(after.filter(row => priorIds.has(row.id))).toEqual(before);
  const added = after.filter(row => !priorIds.has(row.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    actorAccountId: actorId, operatorId, branchId: parks[0],
    action: expected.action, entityType: 'operation', entityId: expected.requestId,
    requestId: expected.requestId, before: null, after: { error: expected.error },
    actionId: null, sourceEventId: null,
  });
  expect(added[0]!.after).toEqual({ error: expected.error });
}

/** The existing request-level ownership refusal is separate from a rollback. */
async function expectOneRequestDenial(before: Awaited<ReturnType<typeof requestDenialAudits>>, requestId: string) {
  const after = await requestDenialAudits();
  const priorIds = new Set(before.map(row => row.id));
  expect(after.filter(row => priorIds.has(row.id))).toEqual(before);
  const added = after.filter(row => !priorIds.has(row.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    actorAccountId: actorId, operatorId, branchId: parks[0],
    action: 'access.denied', entityType: 'request', entityId: requestId, requestId,
    before: null, actionId: null, sourceEventId: null,
  });
  expect(added[0]!.after).toEqual({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found',
    method: 'POST', url: '/admin/apps/oto_app/users' });
}

describe('SCRUM-632 authorized administration boundary review', () => {
  it('R1 [high] managed own-tenant users remain linkable and reseatable through Admin; fix: restrict the read-only fence to native app writers', async () => {
    const p = await person();
    const smsBefore = ctx.smsLog.length;
    const request = { method: 'POST' as const, url: '/admin/apps/oto_app/users', headers: headers(),
      payload: { accountId: p.accountId, externalUserId: p.userId, branchIds: [parks[0]] } };
    const linked = await ctx.app.inject(request);
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ app: 'oto_app', accountId: p.accountId, externalUserId: p.userId,
      accountCreated: false, appUserCreated: false });
    const replay = await ctx.app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(linked.json());
    const [identity] = await ctx.db.select().from(appIdentity)
      .where(and(eq(appIdentity.accountId, p.accountId), eq(appIdentity.app, 'oto_app')));
    expect(identity).toMatchObject({ externalUserId: p.userId, createdBy: actorId });
    const [user] = await ctx.db.select({ platformUserId: otoappUsers.platformUserId,
      operatorId: otoappUsers.operatorId, mustChangePassword: otoappUsers.mustChangePassword }).from(otoappUsers)
      .where(eq(otoappUsers.id, p.userId));
    expect(user).toEqual({ platformUserId: p.accountId, operatorId: legalEntity, mustChangePassword: false });
    expect(await accessRows(p)).toEqual([{ tenantId, branchId: appParks[0], accessScope: 'selected_branches' }]);
    const changed = await ctx.app.inject({ method: 'PUT', url: `/admin/apps/oto_app/users/${p.accountId}/branches`,
      headers: headers(), payload: { branchIds: [parks[1]] } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ ok: true, accessBranches: [parks[1]], accessChanged: true });
    expect(await accessRows(p)).toEqual([{ tenantId, branchId: appParks[1], accessScope: 'selected_branches' }]);
    const grants = await ctx.db.select({ scopeType: roleAssignment.scopeType, scopeId: roleAssignment.scopeId })
      .from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId))
      .where(and(eq(roleAssignment.accountId, p.accountId), eq(role.name, 'app_access_oto_app')));
    expect(grants).toEqual([{ scopeType: 'branch', scopeId: parks[1] }]);
    const audits = await ctx.db.select({ action: auditLog.action, actorAccountId: auditLog.actorAccountId,
      operatorId: auditLog.operatorId }).from(auditLog).where(eq(auditLog.entityId, identity!.id));
    expect(audits.filter(row => row.action === 'app_identity.link')).toEqual([
      { action: 'app_identity.link', actorAccountId: actorId, operatorId },
    ]);
    expect(audits.filter(row => row.action === 'app_identity.branches')).toEqual([
      { action: 'app_identity.branches', actorAccountId: actorId, operatorId },
    ]);
    expect(ctx.smsLog.length).toBe(smsBefore);
  });

  it('R2 [critical] managed status never permits a foreign account or app-tenant claim; fix: retain both ownership fences before stamping', async () => {
    const own = await person(), foreign = await person(true);
    const before = await snapshot([own, foreign]);
    const failuresBefore = await denialAudits();
    const requestsBefore = await requestDenialAudits();
    const attempts = [
      { requestId: newId(), code: 'NOT_FOUND', payload: { accountId: own.accountId, externalUserId: foreign.userId } },
      { requestId: newId(), code: 'ACCOUNT_NOT_FOUND', payload: { accountId: foreign.accountId, externalUserId: own.userId } },
    ];
    for (const { requestId, code, payload } of attempts) {
      const response = await ctx.app.inject({ method: 'POST', url: '/admin/apps/oto_app/users',
        headers: { ...headers(), 'x-request-id': requestId }, payload });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(code);
      expect(response.headers['x-request-id']).toBe(requestId);
      expect(await snapshot([own, foreign])).toEqual(before);
      if (code === 'NOT_FOUND') expect(await requestDenialAudits()).toEqual(requestsBefore);
    }
    // The foreign app user fails inside the transaction; the foreign platform
    // account is rejected before it. Each has its distinct existing audit.
    await expectOneDenial(failuresBefore, { action: 'app_identity.link.failed',
      requestId: attempts[0]!.requestId, error: 'NOT_FOUND' });
    await expectOneRequestDenial(requestsBefore, attempts[1]!.requestId);
  });

  it('R3 [critical] mixed own/foreign branch replacement leaves the linked user and grants unchanged; fix: validate ownership inside the seam transaction', async () => {
    const p = await person();
    expect((await link(p)).statusCode).toBe(200);
    const before = await snapshot([p]);
    const failuresBefore = await denialAudits(), requestId = newId();
    const requestsBefore = await requestDenialAudits();
    const response = await ctx.app.inject({ method: 'PUT', url: `/admin/apps/oto_app/users/${p.accountId}/branches`,
      headers: { ...headers(), 'x-request-id': requestId }, payload: { branchIds: [parks[1], foreignPark] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BRANCH_NOT_FOUND');
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(await snapshot([p])).toEqual(before);
    await expectOneDenial(failuresBefore, { action: 'app_identity.branches.failed', requestId, error: 'BRANCH_NOT_FOUND' });
    expect(await requestDenialAudits()).toEqual(requestsBefore);
    expect(await accessRows(p)).toEqual([{ tenantId, branchId: appParks[0], accessScope: 'selected_branches' }]);
  });
});
