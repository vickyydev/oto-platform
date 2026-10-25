import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, appIdentity, auditLog, branch, otoappUsers, role, roleAssignment } from '@oto/db';
import { newId } from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { ADMIN, SECOND_OPERATOR_ADMIN, createTestContext, teardownAll, type TestContext } from './helpers';

const key = 'zz-test-private-provisioning-review-key-633';
const otherKey = 'zz-test-other-operator-provisioning-key-633';
const url = '/admin/apps/oto_app/suite-sign-ins';
let ctx: TestContext;
let operatorId: string;
let otherOperatorId: string;
let actorId: string;
let actorAccountId: string;
let tenantId: string;
let appBranchId: string;
let sequence = 0;

async function user(linkedAccountId?: string) {
  const id = newId();
  await ctx.db.insert(otoappUsers).values({ id, email: `${id}@zz-test.invalid`, password: 'ZZ TEST unusable hash',
    fullName: 'ZZ TEST employee provisioning', role: 'staff', isActive: true, mustChangePassword: false,
    platformUserId: linkedAccountId ?? null });
  await ctx.db.execute(sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope)
    values (${newId()}, ${tenantId}, ${id}, ${appBranchId}, 'selected_branches')`);
  return id;
}
const request = (body: Record<string, unknown>, credential = key) => ctx.app.inject({ method: 'POST', url,
  headers: { authorization: `Bearer ${credential}` }, payload: body });
const input = async () => ({ actionId: newId(), appUserId: await user(), phone: `+6686339${String(++sequence).padStart(4, '0')}`, actorAppUserId: actorId });

beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ otoapp: true, env });
  const [owner] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  const [other] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  operatorId = owner!.operatorId; actorAccountId = owner!.id; otherOperatorId = other!.operatorId;
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(key)},${otherOperatorId}:${otoAppProvisionKeyDigest(otherKey)}`;
  await ctx.restart();
  const [park] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId));
  tenantId = newId(); appBranchId = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id,name,slug) values (${tenantId},'ZZ TEST 633 provisioning',${`zz-633-${tenantId}`})`);
  await ctx.db.execute(sql`insert into otoapp.branches (id,tenant_id,name,address,core_branch_id)
    values (${appBranchId},${tenantId},'ZZ TEST 633 branch','',${park!.id})`);
  actorId = await user(actorAccountId);
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-633 provisioning replay boundaries', () => {
  it('P1 FINDING: another operator key cannot read a completed action; prescribed fix: authorize before replay', async () => {
    const body = await input();
    expect((await request(body)).statusCode).toBe(200);
    const before = await ctx.db.select().from(appIdentity).where(eq(appIdentity.id, body.actionId));
    const replay = await request(body, otherKey);
    expect(replay.statusCode).toBe(403);
    expect(await ctx.db.select().from(appIdentity).where(eq(appIdentity.id, body.actionId))).toEqual(before);
  });
  it('P1 FINDING: an actor whose platform account is off cannot replay; prescribed fix: reauthorize live actor first', async () => {
    const body = await input();
    expect((await request(body)).statusCode).toBe(200);
    await ctx.db.update(account).set({ status: 'inactive' }).where(eq(account.id, actorAccountId));
    try { expect((await request(body)).statusCode).toBe(403); }
    finally { await ctx.db.update(account).set({ status: 'active' }).where(eq(account.id, actorAccountId)); }
  });
  it('P1 FINDING: a completed action refuses a different phone; prescribed fix: bind immutable normalized phone', async () => {
    const body = await input();
    expect((await request(body)).statusCode).toBe(200);
    const replay = await request({ ...body, phone: '+66863399999' });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('ACTION_ID_REUSED');
  });
  it('an unchanged replay returns no password and creates no second identity or provisioning audit', async () => {
    const body = await input(); const first = await request(body);
    expect(first.statusCode).toBe(200); expect(typeof first.json().temporaryPassword).toBe('string');
    const before = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'app_identity.provision'), eq(auditLog.entityId, body.actionId)));
    const replay = await request(body);
    expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({ id: body.actionId,
      accountId: first.json().accountId, phone: first.json().phone, temporaryPassword: null, replayed: true });
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'app_identity.provision'), eq(auditLog.entityId, body.actionId)))).toEqual(before);
    expect(await ctx.db.select().from(appIdentity).where(eq(appIdentity.id, body.actionId))).toHaveLength(1);
  });
  it.each([true, false])('new login uses platform role authority only when its exact entity flag is %s', async enabled => {
    const body = await input(), entityId = newId();
    await ctx.db.execute(sql`insert into otoapp.operators (id,tenant_id,name,platform_roles_enabled)
      values (${entityId},${tenantId},'ZZ TEST provisioning legal entity',${enabled})`);
    await ctx.db.update(otoappUsers).set({ role: 'manager', operatorId: entityId }).where(eq(otoappUsers.id, body.appUserId));
    const response = await request(body); expect(response.statusCode).toBe(200);
    expect(response.json().platformManaged).toBe(enabled);
    const [raw] = await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, body.appUserId));
    expect(raw!.role).toBe(enabled ? 'staff' : 'manager'); expect(raw!.operatorId).toBe(entityId);
    const grants = await ctx.db.select({ name: role.name }).from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId))
      .where(eq(roleAssignment.accountId, response.json().accountId));
    expect(grants.map(row => row.name)).toEqual(['app_access_oto_app']);
    const roleAudits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'app_identity.role_sync'), eq(auditLog.entityId, body.appUserId)));
    expect(roleAudits).toHaveLength(enabled ? 1 : 0);
  });
});
