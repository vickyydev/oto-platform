import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, appIdentity, auditLog, branch, otoappUsers, role, roleAssignment } from '@oto/db';
import { newId } from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { AppError } from '../src/lib/errors';
import { withTx } from '../src/services/tx';
import { ADMIN, SECOND_OPERATOR_ADMIN, createTestContext, teardownAll, type TestContext } from './helpers';

const action = 'app_identity.lifecycle_deactivation';
const key = randomBytes(32).toString('hex'), foreignKey = randomBytes(32).toString('hex');
let ctx: TestContext, operatorId: string, foreignOperatorId: string, adminId: string, tenantId: string;
let sequence = 0;
type Event = { id: string; state: string; settled_at: Date | null };
const consume = (id: string, credential = key) => ctx.app.inject({ method: 'POST',
  url: '/admin/apps/oto_app/lifecycle-deactivations', headers: { authorization: `Bearer ${credential}` }, payload: { eventId: id } });
const readEvent = async (id: string) => (await ctx.db.execute<Event>(sql`
  select id,state,settled_at from otoapp.login_lifecycle_events where id=${id}`)).rows[0]!;
const audits = (id: string, failed = false) => ctx.db.select().from(auditLog)
  .where(and(eq(auditLog.operatorId, operatorId), eq(auditLog.action, action + (failed ? '.failed' : '')), eq(auditLog.entityId, id)));

async function fixture(existingAccount?: string) {
  const accountId = existingAccount ?? newId(), userId = newId();
  if (!existingAccount) {
    await ctx.db.insert(account).values({ id: accountId, operatorId, phone: `+668778${String(++sequence).padStart(5, '0')}`, status: 'active' });
    const [reception] = await ctx.db.select().from(role).where(eq(role.name, 'reception'));
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId, roleId: reception!.id, scopeType: 'operator', scopeId: operatorId });
  }
  await ctx.db.insert(otoappUsers).values({ id: userId, email: `${userId}@zz-test.invalid`, password: '!',
    fullName: 'ZZ TEST lifecycle retry review', role: 'advisor', isActive: true, mustChangePassword: false, platformUserId: accountId });
  await ctx.db.insert(appIdentity).values({ id: newId(), app: 'oto_app', accountId, externalUserId: userId, createdBy: adminId });
  await ctx.db.execute(sql`insert into otoapp.user_branch_access(id,tenant_id,user_id,branch_id,access_scope)
    values (${newId()},${tenantId},${userId},null,'all_branches')`);
  await ctx.db.update(otoappUsers).set({ isActive: false }).where(eq(otoappUsers.id, userId));
  const [event] = (await ctx.db.execute<{ id: string }>(sql`select id from otoapp.login_lifecycle_events where user_id=${userId}`)).rows;
  return { accountId, userId, eventId: event!.id };
}

beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ otoapp: true, env });
  const [owner] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  const [foreign] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  operatorId = owner!.operatorId; adminId = owner!.id; foreignOperatorId = foreign!.operatorId;
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(key)},${foreignOperatorId}:${otoAppProvisionKeyDigest(foreignKey)}`;
  await ctx.restart();
  const [park] = await ctx.db.select().from(branch).where(eq(branch.operatorId, operatorId));
  tenantId = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants(id,name,slug) values (${tenantId},'ZZ TEST retry tenant',${`zz-778-${tenantId}`})`);
  await ctx.db.execute(sql`insert into otoapp.branches(id,tenant_id,name,address,core_branch_id)
    values (${newId()},${tenantId},'ZZ TEST retry park','',${park!.id})`);
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-778/781/810 adversarial lifecycle review', () => {
  it('HIGH pin: another park group cannot settle a pending event', async () => {
    const target = await fixture();
    expect((await consume(target.eventId, foreignKey)).statusCode).toBe(404);
    expect((await readEvent(target.eventId)).state).toBe('pending');
    expect((await consume(target.eventId)).statusCode).toBe(200);
  });

  it('MEDIUM FINDING fixed: settle a deleted app login as superseded, audit once, and preserve its account', async () => {
    const target = await fixture();
    await ctx.db.execute(sql`delete from otoapp.user_branch_access where user_id=${target.userId}`);
    await ctx.db.delete(otoappUsers).where(eq(otoappUsers.id, target.userId));
    // Emulate an old orphan left before the forward cleanup migration.
    await ctx.db.execute(sql`update otoapp.login_lifecycle_events set state='pending',settled_at=null,last_error_code=null where id=${target.eventId}`);
    expect((await consume(target.eventId, foreignKey)).statusCode).toBe(404);
    expect((await consume(target.eventId)).json()).toMatchObject({ ok: true, state: 'superseded', replayed: false });
    expect((await consume(target.eventId)).json()).toMatchObject({ state: 'superseded', replayed: true });
    expect((await readEvent(target.eventId)).settled_at).not.toBeNull();
    expect((await ctx.db.select().from(account).where(eq(account.id, target.accountId)))[0]!.status).toBe('active');
    expect(await audits(target.eventId)).toHaveLength(1);
    expect(await audits(target.eventId, true)).toHaveLength(0);
  });

  it('MEDIUM FINDING fixed: settle a missing platform login only after proving the app tenant belongs to the caller', async () => {
    const target = await fixture();
    await ctx.db.delete(appIdentity).where(eq(appIdentity.accountId, target.accountId));
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, target.accountId));
    await ctx.db.delete(account).where(eq(account.id, target.accountId));
    expect((await consume(target.eventId, foreignKey)).statusCode).toBe(404);
    expect((await consume(target.eventId)).json()).toMatchObject({ ok: true, state: 'superseded', replayed: false });
    expect(await audits(target.eventId)).toHaveLength(1);
    expect((await consume(target.eventId)).json()).toMatchObject({ state: 'superseded', replayed: true });
  });

  it('MEDIUM FINDING fixed: concurrent retries keep one failure audit per event and cause, without disabling the last admin', async () => {
    const target = await fixture(adminId);
    const replies = await Promise.all([consume(target.eventId), consume(target.eventId), consume(target.eventId)]);
    expect(replies.map(r => r.statusCode)).toEqual([409, 409, 409]);
    expect(replies.map(r => r.json().error.code)).toEqual(['LAST_OPERATOR_ADMIN', 'LAST_OPERATOR_ADMIN', 'LAST_OPERATOR_ADMIN']);
    expect((await readEvent(target.eventId)).state).toBe('pending');
    expect(await audits(target.eventId, true)).toHaveLength(1);
  });

  it('HIGH pin: unrelated operations retain their ordinary failure audit per request', async () => {
    const op = `zz_test.failure.${newId()}`;
    for (let i = 0; i < 2; i++) await expect(withTx(ctx.db, { operatorId, requestId: newId() }, op,
      async () => { throw new AppError(409, 'ZZ_TEST_REFUSAL', 'ZZ TEST refusal'); })).rejects.toThrow();
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.action, `${op}.failed`))).toHaveLength(2);
  });

  it('HIGH pin: when both login records are gone, only the stamped park can settle the old event', async () => {
    const target = await fixture();
    await ctx.db.execute(sql`delete from otoapp.user_branch_access where user_id=${target.userId}`);
    await ctx.db.delete(otoappUsers).where(eq(otoappUsers.id, target.userId));
    await ctx.db.delete(appIdentity).where(eq(appIdentity.accountId, target.accountId));
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, target.accountId));
    await ctx.db.delete(account).where(eq(account.id, target.accountId));
    await ctx.db.execute(sql`update otoapp.login_lifecycle_events set state='pending',settled_at=null where id=${target.eventId}`);
    expect((await consume(target.eventId, foreignKey)).statusCode).toBe(404);
    expect((await consume(target.eventId)).json()).toMatchObject({ state: 'superseded', replayed: false });
    expect(await audits(target.eventId)).toHaveLength(1);
  });

  it('HIGH pin: deleting a pay-only login leaves no restriction to retry or role to withdraw', async () => {
    const target = await fixture();
    await ctx.db.execute(sql`update otoapp.users set access_mode='pay_only' where id=${target.userId}`);
    const event = (await ctx.db.execute<{ id: string }>(sql`select id from otoapp.login_lifecycle_events
      where user_id=${target.userId} and kind='restrict'`)).rows[0]!;
    const before = await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, target.accountId));
    await ctx.db.execute(sql`delete from otoapp.user_branch_access where user_id=${target.userId}`);
    await ctx.db.delete(otoappUsers).where(eq(otoappUsers.id, target.userId));
    await ctx.db.execute(sql`update otoapp.login_lifecycle_events set state='pending',settled_at=null where id=${event.id}`);
    const send = (credential: string) => ctx.app.inject({ method: 'POST', url: '/admin/apps/oto_app/lifecycle-restrictions',
      headers: { authorization: `Bearer ${credential}` }, payload: { eventId: event.id } });
    expect((await send(foreignKey)).statusCode).toBe(404);
    expect((await send(key)).json()).toMatchObject({ state: 'superseded', replayed: false });
    expect((await send(key)).json()).toMatchObject({ state: 'superseded', replayed: true });
    expect(await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, target.accountId))).toEqual(before);
  });

  it('MEDIUM pin: deduplication retains a new cause and a different event instead of hiding them', async () => {
    const op = `zz_test.failure.${newId()}`, first = newId(), second = newId();
    for (const [eventId, cause] of [[first, 'ZZ_TEST_FIRST'], [first, 'ZZ_TEST_FIRST'], [first, 'ZZ_TEST_SECOND'], [second, 'ZZ_TEST_FIRST']]) {
      await expect(withTx(ctx.db, { operatorId, requestId: newId(), failureEventId: eventId }, op,
        async () => { throw new AppError(409, cause!, 'ZZ TEST refusal'); })).rejects.toThrow();
    }
    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.action, `${op}.failed`));
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.entityId === first)).toHaveLength(2);
    expect(rows.filter(row => row.entityId === second)).toHaveLength(1);
  });
});
