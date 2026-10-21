import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  account, appIdentity, auditLog, branch, employee, otoappUserBranchAccess, otoappUsers,
  role, roleAssignment, rolePermission, verificationCode,
} from '@oto/db';
import { newId } from '@oto/shared';
import { hasPermission, resolveEffectivePermissions } from '../src/services/permissions';
import {
  ADMIN, BRANCH_MANAGER, SECOND_OPERATOR_ADMIN, CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE,
  branchIdByCode, createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

const failure = vi.hoisted(() => ({ grant: false }));
vi.mock('../src/services/app-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/app-identity')>();
  return {
    ...actual,
    grantAppAccess: async (...args: Parameters<typeof actual.grantAppAccess>) => {
      if (failure.grant) throw new Error('ZZ TEST grant fault after app-user insertion');
      return actual.grantAppAccess(...args);
    },
  };
});

let ctx: TestContext;
let admin: string;
let manager: string;
let foreignAdmin: string;
let operatorId: string;
let foreignOperatorId: string;
let central: string;
let chalong: string;
let foreignPark: string;
let appCentral: string;
let appChalong: string;
let appPermissionRole: string;
let serial = 0;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const [caller] = await ctx.db.select({ id: account.id, operatorId: account.operatorId })
    .from(account).where(eq(account.phone, ADMIN.phone));
  operatorId = caller!.operatorId;
  const [outside] = await ctx.db.select({ operatorId: account.operatorId })
    .from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  foreignOperatorId = outside!.operatorId;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [away] = await ctx.db.select({ id: branch.id }).from(branch)
    .where(eq(branch.operatorId, foreignOperatorId));
  foreignPark = away!.id;
  const tenant = newId();
  const foreignTenant = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values
    (${tenant}, 'ZZ TEST App access review', ${`zz-test-review-${tenant}`}),
    (${foreignTenant}, 'ZZ TEST Foreign app access review', ${`zz-test-review-${foreignTenant}`})`);
  appCentral = newId();
  appChalong = newId();
  await ctx.db.execute(sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id) values
    (${appCentral}, ${tenant}, 'ZZ TEST Review Central', '', ${central}),
    (${appChalong}, ${tenant}, 'ZZ TEST Review Chalong', '', ${chalong}),
    (${newId()}, ${foreignTenant}, 'ZZ TEST Review Foreign', '', ${foreignPark})`);
  appPermissionRole = newId();
  await ctx.db.insert(role).values({ id: appPermissionRole, operatorId, name: 'ZZ TEST independent app entry' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: appPermissionRole, permission: 'app:oto_app:access' });
  const [reader] = await ctx.db.select({ id: account.id }).from(account)
    .where(eq(account.phone, BRANCH_MANAGER.phone));
  // Isolate account reach: the app-entry prerequisite must not mask the branch fence.
  await independentGrant(reader!.id);
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function person(park = central, owner = operatorId): Promise<string> {
  const id = newId();
  const employeeId = newId();
  const next = ++serial;
  await ctx.db.insert(employee).values({ id: employeeId, operatorId: owner, branchId: park,
    name: `ZZ TEST App access reviewer ${next}` });
  await ctx.db.insert(account).values({ id, operatorId: owner, employeeId, status: 'active',
    phone: `+669990061${String(next).padStart(2, '0')}` });
  return id;
}

async function independentGrant(accountId: string): Promise<string> {
  const id = newId();
  await ctx.db.insert(roleAssignment).values({ id, accountId, roleId: appPermissionRole,
    scopeType: 'operator', scopeId: operatorId });
  return id;
}

function newUser(accountId: string, branchId = central) {
  return { accountId, branchIds: [branchId], otoApp: {
    email: `zz-test-review-${newId()}@otopark.test`, fullName: 'ZZ TEST App access review', role: 'staff' as const,
  } };
}

const identities = (accountId: string) => ctx.db.select().from(appIdentity).where(eq(appIdentity.accountId, accountId));
const grants = (accountId: string) => ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, accountId));
const codes = (accountId: string) => ctx.db.select({ id: verificationCode.id }).from(verificationCode)
  .where(eq(verificationCode.accountId, accountId));
const user = async (userId: string) => (await ctx.db.select({ id: otoappUsers.id, name: otoappUsers.fullName,
  role: otoappUsers.role, active: otoappUsers.isActive, stamp: otoappUsers.platformUserId })
  .from(otoappUsers).where(eq(otoappUsers.id, userId)))[0];
const audits = (identityId: string, action: string) => ctx.db.select({ id: auditLog.id, after: auditLog.after })
  .from(auditLog).where(and(eq(auditLog.entityId, identityId), eq(auditLog.action, action)));
const post = (payload: object, cookie = admin, key = newId()) => ctx.app.inject({ method: 'POST',
  url: '/admin/apps/oto_app/users', headers: { cookie, 'idempotency-key': key }, payload });
const unlink = (accountId: string, cookie = admin, key = newId()) => ctx.app.inject({ method: 'DELETE',
  url: `/admin/apps/oto_app/users/${accountId}`, headers: { cookie, 'idempotency-key': key } });
const listed = (accountId: string) => ctx.app.inject({ method: 'GET',
  url: `/admin/apps/users/${accountId}`, headers: { cookie: admin } });

/** SCRUM-613 house review: preserve the owned seam and attack partial grants. */
describe('SCRUM-613 App access adversarial review', () => {
  it('FINDING R1 critical: an existing account must gain one complete link without SMS; transact user, identity and grant and replay once', async () => {
    const target = await person();
    const payload = newUser(target);
    const key = newId();
    const smsBefore = ctx.smsLog.length;
    const first = await post(payload, admin, key);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toMatchObject({ accountId: target, app: 'oto_app', accountCreated: false, appUserCreated: true,
      appBranch: { branchIds: [appCentral], seatedFrom: 'chosen', unplacedReason: null } });
    expect(body).not.toHaveProperty('codeSent');
    const replay = await post(payload, admin, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(body);
    expect(await identities(target)).toHaveLength(1);
    expect(await grants(target)).toHaveLength(1);
    expect(await user(body.externalUserId)).toMatchObject({ stamp: target, active: true, role: 'staff' });
    expect(await ctx.db.select({ id: otoappUsers.id }).from(otoappUsers).where(eq(otoappUsers.email, payload.otoApp.email))).toHaveLength(1);
    expect(await codes(target)).toEqual([]);
    expect(ctx.smsLog.length).toBe(smsBefore);
    const log = await audits(body.id, 'app_identity.link');
    expect(log).toHaveLength(1);
    expect(log[0]!.after).toMatchObject({ accountCreated: false, appUserCreated: true, accessBranches: [central] });
    const duplicate = await post(payload);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('APP_IDENTITY_EXISTS');
    expect(await audits(body.id, 'app_identity.link')).toHaveLength(1);
  });

  it('FINDING R2 critical: failure after app-user creation must not leave half access; roll the entire provisioning transaction back', async () => {
    const target = await person();
    const payload = newUser(target);
    const before = await grants(target);
    const smsBefore = ctx.smsLog.length;
    failure.grant = true;
    try { expect((await post(payload)).statusCode).toBe(500); }
    finally { failure.grant = false; }
    expect(await identities(target)).toEqual([]);
    expect(await grants(target)).toEqual(before);
    expect(await ctx.db.select({ id: otoappUsers.id }).from(otoappUsers).where(eq(otoappUsers.email, payload.otoApp.email))).toEqual([]);
    expect(await codes(target)).toEqual([]);
    expect(ctx.smsLog.length).toBe(smsBefore);
    const retry = await post(payload);
    expect(retry.statusCode).toBe(200);
    expect(await user(retry.json().externalUserId)).toMatchObject({ stamp: target });
  });

  it('FINDING R3 high: app access must not bypass account reach; return403 for another park and404 for another operator without writing', async () => {
    const away = await person(chalong);
    const foreign = await person(foreignPark, foreignOperatorId);
    const smsBefore = ctx.smsLog.length;
    for (const [target, expected, code] of [[away, 403, 'OUT_OF_BRANCH_SCOPE'], [foreign, 404, 'ACCOUNT_NOT_FOUND']] as const) {
      const requests = [
        () => ctx.app.inject({ method: 'GET', url: `/admin/apps/users/${target}`, headers: { cookie: manager } }),
        () => post(newUser(target), manager),
        () => ctx.app.inject({ method: 'PUT', url: `/admin/apps/oto_app/users/${target}/branches`,
          headers: { cookie: manager, 'idempotency-key': newId() }, payload: { branchIds: [central] } }),
        () => unlink(target, manager),
      ];
      for (const request of requests) {
        const answer = await request();
        expect(answer.statusCode).toBe(expected);
        expect(answer.json().error.code).toBe(code);
      }
      expect(await identities(target)).toEqual([]);
      expect(await grants(target)).toEqual([]);
      expect(await codes(target)).toEqual([]);
    }
    expect(ctx.smsLog.length).toBe(smsBefore);
  });

  it('FINDING R4 critical: a typed app-user ID cannot cross park groups or move another person’s identity; refuse claims before any partial grant', async () => {
    const foreign = await person(foreignPark, foreignOperatorId);
    const made = await post(newUser(foreign, foreignPark), foreignAdmin);
    expect(made.statusCode).toBe(200);
    const external = made.json().externalUserId as string;
    expect((await unlink(foreign, foreignAdmin)).statusCode).toBe(200);
    const local = await person();
    const refused = await post({ accountId: local, externalUserId: external });
    expect(refused.statusCode).toBe(404);
    expect(await identities(local)).toEqual([]);
    expect(await grants(local)).toEqual([]);
    expect((await user(external))!.stamp).toBeNull();
    const owner = await person();
    const owned = await post(newUser(owner));
    expect(owned.statusCode).toBe(200);
    const taken = await post({ accountId: local, externalUserId: owned.json().externalUserId });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('APP_USER_TAKEN');
    expect((await user(owned.json().externalUserId))!.stamp).toBe(owner);
    expect(await identities(local)).toEqual([]);
    expect(await grants(local)).toEqual([]);
  });

  it('FINDING R5 high: branch editing must change both sides and preserve independent grants; validate the full branch set before replacing coverage', async () => {
    const target = await person();
    const independent = await independentGrant(target);
    const made = await post(newUser(target));
    expect(made.statusCode).toBe(200);
    const key = newId();
    const request = { method: 'PUT' as const, url: `/admin/apps/oto_app/users/${target}/branches`,
      headers: { cookie: admin, 'idempotency-key': key }, payload: { branchIds: [chalong] } };
    const changed = await ctx.app.inject(request);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ ok: true, accessBranches: [chalong],
      appBranch: { branchIds: [appChalong], seatedFrom: 'chosen', unplacedReason: null } });
    const replay = await ctx.app.inject(request);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(changed.json());
    const read = await listed(target);
    expect(read.statusCode).toBe(200);
    expect(read.json().identities[0].branches).toMatchObject({ accessBranches: [chalong],
      appBranches: { allBranches: false, branches: [expect.objectContaining({ platformBranchId: chalong })] } });
    expect(await ctx.db.select({ id: roleAssignment.id }).from(roleAssignment).where(eq(roleAssignment.id, independent))).toEqual([{ id: independent }]);
    const effective = await resolveEffectivePermissions(ctx.db, target);
    for (const branchId of [central, chalong]) {
      expect(hasPermission(effective, 'app:oto_app:access', { operatorId, branchId })).toBe(true);
    }
    const before = await grants(target);
    const invalid = await ctx.app.inject({ ...request, headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { branchIds: [central, foreignPark] } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('BRANCH_NOT_FOUND');
    expect(await grants(target)).toEqual(before);
    expect((await listed(target)).json().identities[0].branches).toEqual(read.json().identities[0].branches);
    expect(await audits(made.json().id, 'app_identity.branches')).toHaveLength(1);
  });

  it('FINDING R6 critical: unlink must end app identity and sessions without offboarding; remove only its own grants and replay without duplicate audit', async () => {
    const target = await person();
    await independentGrant(target);
    const original = await grants(target);
    const made = await post(newUser(target));
    expect(made.statusCode).toBe(200);
    const external = made.json().externalUserId as string;
    const before = await user(external);
    const branchAccess = await ctx.db.select().from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, external));
    const ownSid = `zz-test-own-${newId()}`;
    const otherSid = `zz-test-other-${newId()}`;
    for (const [sid, userId] of [[ownSid, external], [otherSid, 'ZZ TEST unrelated app user']]) {
      const session = JSON.stringify({ cookie: { httpOnly: true, path: '/' }, passport: { user: userId } });
      await ctx.db.execute(sql`insert into otoapp.session (sid, sess, expire) values (${sid}, ${session}::jsonb, now() + interval '1 day')`);
    }
    const key = newId();
    const removed = await unlink(target, admin, key);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, accessRevoked: true });
    const replay = await unlink(target, admin, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(removed.json());
    expect(await identities(target)).toEqual([]);
    expect(await grants(target)).toEqual(original);
    expect(await user(external)).toEqual({ ...before, stamp: null });
    expect(await ctx.db.select().from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, external))).toEqual(branchAccess);
    const sessions = (await ctx.db.execute<{ sid: string }>(sql`select sid from otoapp.session`)).rows.map((row) => row.sid);
    expect(sessions).not.toContain(ownSid);
    expect(sessions).toContain(otherSid);
    expect(hasPermission(await resolveEffectivePermissions(ctx.db, target), 'app:oto_app:access', { operatorId })).toBe(true);
    expect(await audits(made.json().id, 'app_identity.unlink')).toHaveLength(1);
    const unlinked = await ctx.app.inject({ method: 'GET', url: '/admin/apps/oto_app/unlinked-users', headers: { cookie: admin } });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json().users.some((entry: { id: string }) => entry.id === external)).toBe(true);
  });
});
