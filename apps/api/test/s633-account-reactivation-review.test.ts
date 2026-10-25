import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { account, appIdentity, auditLog, otoappUserBranchAccess, otoappUsers, role, roleAssignment, session } from '@oto/db';
import { type OtoAppUserRole } from '@oto/db';
import { newId } from '@oto/shared';
import { audit } from '../src/services/audit';
import { ADMIN, RECEPTION, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let reception: string;
let operatorId: string;
let adminId: string;
let otherOperatorId: string;
let tenantId: string;
let sequence = 0;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [owner] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  const [other] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  operatorId = owner!.operatorId;
  adminId = owner!.id;
  otherOperatorId = other!.operatorId;
  tenantId = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug)
    values (${tenantId}, 'ZZ TEST 633 reactivation', ${`zz-test-633-${tenantId}`})`);
});

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

const phone = () => `+668633${String(++sequence).padStart(5, '0')}`;

async function fixture(opts: { status?: 'active' | 'inactive'; active?: boolean; appRole?: OtoAppUserRole; owner?: string; linked?: boolean } = {}) {
  const id = newId(), userId = newId();
  const owner = opts.owner ?? operatorId;
  await ctx.db.insert(account).values({ id, operatorId: owner, phone: phone(), status: opts.status ?? 'active' });
  if (owner === operatorId) {
    const [receptionRole] = await ctx.db.select().from(role).where(and(isNull(role.operatorId), eq(role.name, 'reception')));
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: id, roleId: receptionRole!.id, scopeType: 'operator', scopeId: owner });
  }
  if (opts.linked !== false) {
    await ctx.db.insert(otoappUsers).values({ id: userId, email: `${userId}@zz-test.invalid`, password: randomBytes(24).toString('hex'),
      fullName: 'ZZ TEST account reactivation', role: opts.appRole ?? 'staff', isActive: opts.active ?? true,
      mustChangePassword: false, platformUserId: id });
    await ctx.db.insert(appIdentity).values({ id: newId(), app: 'oto_app', accountId: id, externalUserId: userId, createdBy: adminId });
    await ctx.db.insert(otoappUserBranchAccess).values({ id: newId(), tenantId, userId, accessScope: 'all_branches', branchId: null });
  }
  return { id, userId };
}

async function facts(id: string, userId: string) {
  const [a] = await ctx.db.select().from(account).where(eq(account.id, id));
  const [u] = await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, userId));
  return { account: a, user: u,
    identities: await ctx.db.select().from(appIdentity).where(eq(appIdentity.accountId, id)),
    grants: await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.accountId, id)),
    branches: await ctx.db.select().from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, userId)) };
}

const patch = (id: string, body: { status?: 'active' | 'inactive'; phone?: string }, key = newId(), cookie = admin) =>
  ctx.app.inject({ method: 'PATCH', url: `/accounts/${id}`, headers: { cookie, 'idempotency-key': key }, payload: body });

function stableUser(user: NonNullable<Awaited<ReturnType<typeof facts>>['user']>) {
  const { isActive: _active, updatedAt: _updated, ...stable } = user;
  return stable;
}

async function seedAppSession(sid: string, userId: string) {
  await ctx.db.execute(sql`insert into otoapp.session (sid, sess, expire) values
    (${sid}, ${JSON.stringify({ passport: { user: userId } })}::jsonb, now() + interval '1 day')`);
}

async function appSessions() {
  return (await ctx.db.execute<{ sid: string }>(sql`select sid from otoapp.session order by sid`)).rows.map(row => row.sid);
}

describe('SCRUM-633 account reactivation — actual identity and transaction review', () => {
  it('P1 restores the same linked advisor login after deactivation, preserving identity, grants, reach and closed sessions', async () => {
    const target = await fixture({ appRole: 'advisor' }), bystander = await fixture();
    const before = await facts(target.id, target.userId), untouched = await facts(bystander.id, bystander.userId);
    const sid = `ZZ TEST 633 ${newId()}`, otherSid = `ZZ TEST 633 ${newId()}`, platformSid = newId();
    await seedAppSession(sid, target.userId); await seedAppSession(otherSid, bystander.userId);
    await ctx.db.insert(session).values({ id: platformSid, accountId: target.id, tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await patch(target.id, { status: 'inactive' })).statusCode).toBe(200);
    expect((await facts(target.id, target.userId)).user!.isActive).toBe(false);
    expect((await patch(target.id, { status: 'active' })).statusCode).toBe(200);
    const after = await facts(target.id, target.userId);
    expect(after.account!.status).toBe('active');
    expect(after.user!.isActive).toBe(true);
    expect(stableUser(after.user!)).toEqual(stableUser(before.user!));
    expect(after.identities).toEqual(before.identities); expect(after.grants).toEqual(before.grants); expect(after.branches).toEqual(before.branches);
    const [oldSession] = await ctx.db.select().from(session).where(eq(session.id, platformSid));
    expect(oldSession!.revokedAt).not.toBeNull(); expect(oldSession!.revokedReason).toBe('deactivated');
    expect(await appSessions()).not.toContain(sid); expect(await appSessions()).toContain(otherSid);
    expect(await facts(bystander.id, bystander.userId)).toEqual(untouched);
  });

  it('P1 an explicit active request also repairs an active platform account whose stamped app login is off', async () => {
    const target = await fixture({ active: false });
    expect((await patch(target.id, { status: 'active' })).statusCode).toBe(200);
    const after = await facts(target.id, target.userId);
    expect(after.account!.status).toBe('active'); expect(after.user!.isActive).toBe(true);
  });

  it('P1 a same-key replay neither repeats the account audit nor changes the enabled app row', async () => {
    const target = await fixture({ status: 'inactive', active: false }), key = newId();
    expect((await patch(target.id, { status: 'active' }, key)).statusCode).toBe(200);
    const first = await facts(target.id, target.userId);
    expect(first.user!.isActive).toBe(true);
    const auditBefore = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, target.id), eq(auditLog.action, 'account.update')));
    expect(auditBefore).toHaveLength(1);
    const replay = await patch(target.id, { status: 'active' }, key);
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual({ ok: true });
    expect(await facts(target.id, target.userId)).toEqual(first);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, target.id), eq(auditLog.action, 'account.update')))).toEqual(auditBefore);
  });

  it('phone-only editing does not enable a switched-off app login', async () => {
    const target = await fixture({ status: 'inactive', active: false }), before = await facts(target.id, target.userId);
    expect((await patch(target.id, { phone: phone() })).statusCode).toBe(200);
    const after = await facts(target.id, target.userId);
    expect(after.account!.status).toBe('inactive'); expect(after.user).toEqual(before.user);
    expect(after.identities).toEqual(before.identities); expect(after.grants).toEqual(before.grants); expect(after.branches).toEqual(before.branches);
  });

  it('an account without an app link activates without creating an app identity or user', async () => {
    const target = await fixture({ status: 'inactive', linked: false });
    const before = await ctx.db.select().from(otoappUsers);
    expect((await patch(target.id, { status: 'active' })).statusCode).toBe(200);
    const after = await facts(target.id, target.userId);
    expect(after.account!.status).toBe('active'); expect(after.user).toBeUndefined(); expect(after.identities).toEqual([]);
    expect(await ctx.db.select().from(otoappUsers)).toEqual(before);
  });

  it('foreign-operator targets and callers without account-update permission remain unable to activate either side', async () => {
    const foreign = await fixture({ owner: otherOperatorId, status: 'inactive', active: false });
    const local = await fixture({ status: 'inactive', active: false });
    const foreignBefore = await facts(foreign.id, foreign.userId), localBefore = await facts(local.id, local.userId);
    expect((await patch(foreign.id, { status: 'active' })).statusCode).toBe(404);
    expect((await patch(local.id, { status: 'active' }, newId(), reception)).statusCode).toBe(403);
    expect(await facts(foreign.id, foreign.userId)).toEqual(foreignBefore); expect(await facts(local.id, local.userId)).toEqual(localBefore);
  });

  it('P1 an account audit failure rolls back account and app activation together', async () => {
    const target = await fixture({ status: 'inactive', active: false }), before = await facts(target.id, target.userId), original = audit.record;
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
      if (entry.action === 'account.update' && (entry.after as { status?: string } | undefined)?.status === 'active') throw new Error('ZZ TEST activation audit failure');
      return original(tx, entry);
    });
    try { expect((await patch(target.id, { status: 'active' })).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect(await facts(target.id, target.userId)).toEqual(before);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, target.id), eq(auditLog.action, 'account.update')))).toEqual([]);
  });
});
