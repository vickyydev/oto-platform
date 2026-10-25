import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { account, appIdentity, auditLog, branch, otoappUsers, role, roleAssignment, session } from '@oto/db';
import { newId } from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { audit } from '../src/services/audit';
import { ADMIN, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

const key = 'zz-test633-owned-lifecycle-key';
const otherKey = 'zz-test633-other-lifecycle-key';
const url = '/admin/apps/oto_app/lifecycle-deactivations';
const action = 'app_identity.lifecycle_deactivation';
let ctx: TestContext, operatorId: string, otherOperatorId: string, adminId: string, tenantId: string, adminCookie: string;
let sequence = 0;
type Event = { id: string; user_id: string; platform_account_id: string; state: 'pending' | 'delivered' | 'superseded'; settled_at: Date | null };
const consume = (eventId: string, credential: string | null = key, extra = {}) => ctx.app.inject({ method: 'POST', url,
  headers: credential ? { authorization: `Bearer ${credential}` } : {}, payload: { eventId, ...extra } });
const event = async (userId: string): Promise<Event> => (await ctx.db.execute<Event>(sql`
  select id,user_id,platform_account_id,state,settled_at from otoapp.login_lifecycle_events
  where user_id=${userId} order by created_at desc,id desc limit 1`)).rows[0]!;
const audits = (eventId: string) => ctx.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.actionId, eventId)));

async function fixture(existingAccount?: string) {
  const accountId = existingAccount ?? newId(), userId = newId();
  if (!existingAccount) {
    await ctx.db.insert(account).values({ id: accountId, operatorId, phone: `+668635${String(++sequence).padStart(5, '0')}`, status: 'active' });
    const [r] = await ctx.db.select().from(role).where(eq(role.name, 'reception'));
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId, roleId: r!.id, scopeType: 'operator', scopeId: operatorId });
  }
  await ctx.db.insert(otoappUsers).values({ id: userId, email: `${userId}@zz-test.invalid`, password: 'ZZ TEST unusable hash',
    fullName: 'ZZ TEST lifecycle identity', role: 'advisor', isActive: true, mustChangePassword: false, platformUserId: accountId });
  await ctx.db.insert(appIdentity).values({ id: newId(), app: 'oto_app', accountId, externalUserId: userId, createdBy: adminId });
  await ctx.db.execute(sql`insert into otoapp.user_branch_access (id,tenant_id,user_id,branch_id,access_scope)
    values (${newId()},${tenantId},${userId},null,'all_branches')`);
  await ctx.db.update(otoappUsers).set({ isActive: false }).where(eq(otoappUsers.id, userId));
  return { accountId, userId, event: await event(userId) };
}
async function facts(target: Awaited<ReturnType<typeof fixture>>) {
  return { account: (await ctx.db.select().from(account).where(eq(account.id, target.accountId)))[0],
    user: (await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, target.userId)))[0],
    event: await event(target.userId),
    identities: await ctx.db.select().from(appIdentity).where(eq(appIdentity.accountId, target.accountId)),
    grants: await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, target.accountId)) };
}
beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ otoapp: true, env });
  const [owner] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  const [other] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  operatorId = owner!.operatorId; adminId = owner!.id; otherOperatorId = other!.operatorId;
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(key)},${otherOperatorId}:${otoAppProvisionKeyDigest(otherKey)}`;
  await ctx.restart(); adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [park] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId));
  tenantId = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id,name,slug) values (${tenantId},'ZZ TEST lifecycle',${`zz-633-life-${tenantId}`})`);
  await ctx.db.execute(sql`insert into otoapp.branches (id,tenant_id,name,address,core_branch_id)
    values (${newId()},${tenantId},'ZZ TEST lifecycle park','',${park!.id})`);
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-633 lifecycle identity seam adversarial review', () => {
  it('P1 requires the operator credential before validating any body or revealing an event', async () => {
    expect((await consume(newId(), null)).statusCode).toBe(401);
    expect((await consume(newId(), 'zz-test-wrong-key')).statusCode).toBe(401);
    expect((await consume(newId(), key, { accountId: newId() })).statusCode).toBe(400);
    expect((await consume('invalid')).statusCode).toBe(400);
  });
  it('P1 disables the exact account, ends both session origins and atomically settles one audited event', async () => {
    const target = await fixture(), bystander = await fixture();
    const before = await facts(target), untouched = await facts(bystander), platformSessionId = newId(), appSid = `ZZ TEST 633 ${newId()}`;
    await ctx.db.insert(session).values({ id: platformSessionId, accountId: target.accountId, tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 86_400_000) });
    await ctx.db.execute(sql`insert into otoapp.session(sid,sess,expire) values (${appSid},${JSON.stringify({ passport: { user: target.userId } })}::jsonb,now()+interval '1 day')`);
    const response = await consume(target.event.id);
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true, eventId: target.event.id, state: 'delivered', replayed: false });
    const after = await facts(target);
    expect(after.account!.status).toBe('inactive'); expect(after.user!.isActive).toBe(false); expect(after.user!.role).toBe('advisor');
    expect(after.user!.platformUserId).toBe(target.accountId); expect(after.identities).toEqual(before.identities); expect(after.grants).toEqual(before.grants);
    expect(after.event.state).toBe('delivered'); expect(after.event.settled_at).not.toBeNull();
    expect((await ctx.db.select().from(session).where(eq(session.id, platformSessionId)))[0]!.revokedAt).not.toBeNull();
    expect((await ctx.db.execute(sql`select sid from otoapp.session where sid=${appSid}`)).rows).toEqual([]);
    expect(await facts(bystander)).toEqual(untouched);
    const rows = await audits(target.event.id); expect(rows).toHaveLength(1); expect(rows[0]!.actorAccountId).toBeNull(); expect(rows[0]!.operatorId).toBe(operatorId);
  });
  it('P1 concurrent delivery has one effect and a durable no-secret replay receipt', async () => {
    const target = await fixture(); const responses = await Promise.all([consume(target.event.id), consume(target.event.id)]);
    expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
    expect(responses.map(r => r.json().replayed).sort()).toEqual([false, true]);
    expect(await audits(target.event.id)).toHaveLength(1);
  });
  it('P1 a delivered event retried after platform reactivation never switches either side off again', async () => {
    const target = await fixture(); expect((await consume(target.event.id)).statusCode).toBe(200);
    const reactivated = await ctx.app.inject({ method: 'PATCH', url: `/accounts/${target.accountId}`,
      headers: { cookie: adminCookie, 'idempotency-key': newId() }, payload: { status: 'active' } });
    expect(reactivated.statusCode).toBe(200); const before = await facts(target);
    expect(before.account!.status).toBe('active'); expect(before.user!.isActive).toBe(true);
    expect((await consume(target.event.id)).json()).toEqual({ ok: true, eventId: target.event.id, state: 'delivered', replayed: true });
    expect(await facts(target)).toEqual(before); expect(await audits(target.event.id)).toHaveLength(1);
  });
  it('P1 reactivation supersedes an undelivered ID without disabling the active platform account', async () => {
    const target = await fixture();
    await ctx.db.update(otoappUsers).set({ isActive: true }).where(eq(otoappUsers.id, target.userId));
    const before = await facts(target); expect(before.event.state).toBe('superseded');
    const replay = await consume(target.event.id); expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({ state: 'superseded', replayed: true });
    expect(await facts(target)).toEqual(before);
  });
  it('P1 foreign credentials cannot consume or read a pending or delivered receipt', async () => {
    const target = await fixture(), before = await facts(target);
    expect((await consume(target.event.id, otherKey)).statusCode).toBe(404); expect(await facts(target)).toEqual(before);
    expect((await consume(target.event.id)).statusCode).toBe(200);
    expect((await consume(target.event.id, otherKey)).statusCode).toBe(404);
  });
  it('P1 a changed stamp supersedes the old pending target and never disables either account', async () => {
    const target = await fixture(), replacement = newId();
    await ctx.db.insert(account).values({ id: replacement, operatorId, phone: `+668635${String(++sequence).padStart(5, '0')}`, status: 'active' });
    await ctx.db.update(otoappUsers).set({ platformUserId: replacement }).where(eq(otoappUsers.id, target.userId));
    const response = await consume(target.event.id); expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ state: 'superseded', replayed: false });
    expect((await facts(target)).account!.status).toBe('active');
    expect((await ctx.db.select().from(account).where(eq(account.id, replacement)))[0]!.status).toBe('active');
  });
  it('P1 an ambiguous tenant-to-operator anchor is refused before any event or account mutation', async () => {
    const target = await fixture(), [foreignPark] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, otherOperatorId)), extraBranch = newId();
    await ctx.db.execute(sql`insert into otoapp.branches (id,tenant_id,name,address,core_branch_id)
      values (${extraBranch},${tenantId},'ZZ TEST ambiguous anchor','',${foreignPark!.id})`);
    try { const before = await facts(target); expect((await consume(target.event.id)).statusCode).toBe(404); expect(await facts(target)).toEqual(before); }
    finally { await ctx.db.execute(sql`delete from otoapp.branches where id=${extraBranch}`); }
  });
  it('P1 audit failure rolls back account eviction and receipt; the identical ID remains retryable', async () => {
    const target = await fixture(), before = await facts(target), original = audit.record;
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => { if (entry.action === action) throw Error('ZZ TEST lifecycle audit failure'); return original(tx, entry); });
    try { expect((await consume(target.event.id)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect(await facts(target)).toEqual(before); expect(await audits(target.event.id)).toHaveLength(0);
    expect((await consume(target.event.id)).statusCode).toBe(200);
  });
  it('P1 the last operator administrator remains protected and its event remains visibly pending', async () => {
    const target = await fixture(adminId), before = await facts(target), response = await consume(target.event.id);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('LAST_OPERATOR_ADMIN');
    expect(await facts(target)).toEqual(before); expect(await audits(target.event.id)).toHaveLength(0);
  });
});
