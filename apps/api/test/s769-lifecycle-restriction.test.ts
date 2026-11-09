import { hash } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { account, appIdentity, auditLog, branch, otoappUsers, role, roleAssignment, session } from '@oto/db';
import { newId } from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { appAccessRoleName, ensureAppAccessRole, grantAppAccess } from '../src/services/app-identity';
import { audit } from '../src/services/audit';
import { accountsBeyondMyPay } from '../src/services/otoapp-lifecycle-restriction';
import { resolveEffectivePermissions } from '../src/services/permissions';
import { ADMIN, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-769 — a leaver's suite access outside the OTO App ends the night after
 * their last working day, while the launcher keeps their road to My pay.
 *
 * The OTO App keeps a leaver's login on, limited to My pay, and queues a
 * `restrict` event (its migration 0041: the trigger on `users.access_mode`).
 * The platform consumes it on its own door, beside SCRUM-633's switch-off
 * door: the account stays active, its sessions end, and every role it holds
 * but the OTO App's access role is withdrawn — the till first among them.
 * Fixtures are written here, on a database with the OTO App's migrations.
 */

const key = 'zz-test769-owned-restriction-key';
const otherKey = 'zz-test769-other-restriction-key';
const url = '/admin/apps/oto_app/lifecycle-restrictions';
const deactivationUrl = '/admin/apps/oto_app/lifecycle-deactivations';
const action = 'app_identity.lifecycle_restriction';
const PASSWORD = 'zz-test769-password';
let ctx: TestContext, operatorId: string, otherOperatorId: string, adminId: string, tenantId: string, parkId: string;
let sequence = 0;

type Event = { id: string; kind: string; state: 'pending' | 'delivered' | 'superseded'; settled_at: Date | null };
const consume = (eventId: string, credential: string | null = key, door = url) => ctx.app.inject({ method: 'POST', url: door,
  headers: credential ? { authorization: `Bearer ${credential}` } : {}, payload: { eventId } });
const events = async (userId: string): Promise<Event[]> => (await ctx.db.execute<Event>(sql`
  select id, kind, state, settled_at from otoapp.login_lifecycle_events where user_id = ${userId} order by created_at, id`)).rows;
const audits = (eventId: string) => ctx.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.actionId, eventId)));
const roleId = async (name: string) => (await ctx.db.select({ id: role.id }).from(role).where(eq(role.name, name)).limit(1))[0]!.id;
const grantsOf = async (accountId: string) => (await ctx.db
  .select({ roleName: role.name, scopeType: roleAssignment.scopeType, scopeId: roleAssignment.scopeId })
  .from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId))
  .where(eq(roleAssignment.accountId, accountId)))
  .map((g) => `${g.roleName}@${g.scopeType}`).sort();

/**
 * A leaver as the app leaves one: a platform account with a password, the till
 * role at the operator and (unless `road` is false) the OTO App's access role,
 * stamped on an app user of this operator's park group; then the app puts the
 * login in pay only, which queues the restriction.
 */
async function leaver(opts: { road?: boolean; till?: string; existingAccount?: string } = {}) {
  const accountId = opts.existingAccount ?? newId();
  const userId = newId();
  const phone = `+668769${String(++sequence).padStart(5, '0')}`;
  if (!opts.existingAccount) {
    await ctx.db.insert(account).values({
      id: accountId, operatorId, phone, status: 'active', phoneVerifiedAt: new Date(), passwordHash: await hash(PASSWORD),
    });
    await ctx.db.insert(roleAssignment).values({
      id: newId(), accountId, roleId: await roleId(opts.till ?? 'reception'), scopeType: 'operator', scopeId: operatorId,
    });
    if (opts.road !== false) {
      await grantAppAccess(ctx.db, accountId, await ensureAppAccessRole(ctx.db, operatorId, 'oto_app'), operatorId, null);
    }
  }
  await ctx.db.insert(otoappUsers).values({ id: userId, email: `${userId}@zz-test.invalid`, password: 'ZZ TEST unusable hash',
    fullName: 'ZZ TEST s769 leaver', role: 'staff', isActive: true, mustChangePassword: false, platformUserId: accountId });
  await ctx.db.insert(appIdentity).values({ id: newId(), app: 'oto_app', accountId, externalUserId: userId, createdBy: adminId });
  await ctx.db.execute(sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope)
    values (${newId()}, ${tenantId}, ${userId}, null, 'all_branches')`);
  // The app's 03:00 batch (or Offboard, for a last day already past): pay only, the login left on.
  await ctx.db.execute(sql`update otoapp.users set access_mode = 'pay_only' where id = ${userId}`);
  const [event] = await events(userId);
  return { accountId, userId, phone, event: event! };
}

const accessModeOf = async (userId: string) =>
  (await ctx.db.execute<{ access_mode: string }>(sql`select access_mode from otoapp.users where id = ${userId}`)).rows[0]!.access_mode;

beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ otoapp: true, env });
  const [owner] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  const [other] = await ctx.db.select().from(account).where(eq(account.phone, SECOND_OPERATOR_ADMIN.phone));
  operatorId = owner!.operatorId; adminId = owner!.id; otherOperatorId = other!.operatorId;
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(key)},${otherOperatorId}:${otoAppProvisionKeyDigest(otherKey)}`;
  await ctx.restart();
  const [park] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId));
  parkId = park!.id;
  tenantId = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${tenantId}, 'ZZ TEST s769', ${`zz-769-${tenantId}`})`);
  await ctx.db.execute(sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${newId()}, ${tenantId}, 'ZZ TEST s769 park', '', ${parkId})`);
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-769 — the platform restricts a leaver limited to My pay, and never switches the account off', () => {
  it('the app queues a restriction, not a switch-off, when it puts a login in pay only', async () => {
    const target = await leaver();
    expect((await events(target.userId)).map((e) => `${e.kind}:${e.state}`)).toEqual(['restrict:pending']);
  });

  it('the door takes only the operator credential and an event id', async () => {
    expect((await consume(newId(), null)).statusCode).toBe(401);
    expect((await consume(newId(), 'zz-test-wrong-key')).statusCode).toBe(401);
    const extra = await ctx.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}` },
      payload: { eventId: newId(), accountId: newId() } });
    expect(extra.statusCode).toBe(400);
    expect((await consume('invalid')).statusCode).toBe(400);
    expect((await consume(newId())).statusCode).toBe(404);
  });

  it('the account stays active, its sessions and till role end, the OTO App road stays; the leaver cannot open the till', async () => {
    const target = await leaver();
    const bystander = await leaver();
    const till = await signInAs(ctx.app, target.phone, PASSWORD);
    expect((await ctx.app.inject({ method: 'GET', url: '/me/permissions', headers: { cookie: till } })).statusCode).toBe(200);
    const appSid = `ZZ TEST 769 ${newId()}`;
    await ctx.db.execute(sql`insert into otoapp.session (sid, sess, expire)
      values (${appSid}, ${JSON.stringify({ passport: { user: target.userId } })}::jsonb, now() + interval '1 day')`);
    expect((await resolveEffectivePermissions(ctx.db, target.accountId)).some((p) => p.permission.startsWith('pos:'))).toBe(true);

    const response = await consume(target.event.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, eventId: target.event.id, state: 'delivered', replayed: false });

    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.accountId));
    expect(after!.status).toBe('active');
    expect(await grantsOf(target.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`]);
    const [user] = await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, target.userId));
    expect(user!.isActive).toBe(true);
    expect(await accessModeOf(target.userId)).toBe('pay_only');
    // Its platform sessions end; the app's own session is the app's fence to keep.
    const sessions = await ctx.db.select().from(session).where(eq(session.accountId, target.accountId));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect((await ctx.db.execute(sql`select sid from otoapp.session where sid = ${appSid}`)).rows).toHaveLength(1);
    expect((await events(target.userId)).map((e) => `${e.kind}:${e.state}`)).toEqual(['restrict:delivered']);

    // The till session open before is gone; signed in again, the leaver holds the OTO App and nothing else.
    expect((await ctx.app.inject({ method: 'GET', url: '/me/permissions', headers: { cookie: till } })).statusCode).toBe(401);
    expect((await resolveEffectivePermissions(ctx.db, target.accountId)).map((p) => p.permission)).toEqual(['app:oto_app:access']);
    const again = await signInAs(ctx.app, target.phone, PASSWORD);
    const permissions = (await ctx.app.inject({ method: 'GET', url: '/me/permissions', headers: { cookie: again } }))
      .json() as { permissions: Array<{ permission: string }> };
    expect(permissions.permissions.map((p) => p.permission)).toEqual(['app:oto_app:access']);
    const members = await ctx.app.inject({ method: 'GET', url: `/members/lookup?phone=${encodeURIComponent('+66812345678')}`, headers: { cookie: again } });
    expect(members.statusCode).toBe(403);

    // One audited receipt, naming what was withdrawn so it can be given back.
    const rows = await audits(target.event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorAccountId).toBeNull();
    expect((rows[0]!.before as { roles: Array<{ roleName: string }> }).roles.map((r) => r.roleName)).toEqual(['reception']);
    expect(rows[0]!.after).toMatchObject({ accountId: target.accountId, state: 'delivered', rolesWithdrawn: 1, otoAppRoadGranted: null });

    // Nobody else is touched.
    expect(await grantsOf(bystander.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`, 'reception@operator']);
  });

  it('a replay answers from the receipt and withdraws nothing more', async () => {
    const target = await leaver();
    const first = await Promise.all([consume(target.event.id), consume(target.event.id)]);
    expect(first.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(first.map((r) => r.json().replayed).sort()).toEqual([false, true]);
    // A role given back by an administrator afterwards stays: a delivered event never acts again.
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: target.accountId, roleId: await roleId('reception'), scopeType: 'operator', scopeId: operatorId });
    expect((await consume(target.event.id)).json()).toEqual({ ok: true, eventId: target.event.id, state: 'delivered', replayed: true });
    expect(await grantsOf(target.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`, 'reception@operator']);
    expect(await audits(target.event.id)).toHaveLength(1);
  });

  it('a road that came only through an administrator bundle is kept as the OTO App access role, at the same scope', async () => {
    const target = await leaver({ road: false, till: 'operator_admin' });
    expect(await grantsOf(target.accountId)).toEqual(['operator_admin@operator']);
    expect((await consume(target.event.id)).statusCode).toBe(200);
    expect(await grantsOf(target.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`]);
    expect((await audits(target.event.id))[0]!.after).toMatchObject({ otoAppRoadGranted: { branches: null } });
  });

  it('back to full access before delivery (Onboard Again, a last day moved later): the app withdraws it, and the platform does nothing', async () => {
    const target = await leaver();
    await ctx.db.execute(sql`update otoapp.users set access_mode = 'full' where id = ${target.userId}`);
    expect((await events(target.userId)).map((e) => `${e.kind}:${e.state}`)).toEqual(['restrict:superseded']);
    expect((await consume(target.event.id)).json()).toMatchObject({ state: 'superseded', replayed: true });
    expect(await grantsOf(target.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`, 'reception@operator']);
  });

  it('a login no longer in pay only, or a changed stamp, settles the event as superseded and withdraws nothing', async () => {
    const target = await leaver();
    // The access mode changed behind the queue's back (no trigger ran): the consumer reads it itself.
    await ctx.db.execute(sql`alter table otoapp.users disable trigger users_login_restriction_event`);
    try {
      await ctx.db.execute(sql`update otoapp.users set access_mode = 'full' where id = ${target.userId}`);
    } finally {
      await ctx.db.execute(sql`alter table otoapp.users enable trigger users_login_restriction_event`);
    }
    expect((await consume(target.event.id)).json()).toMatchObject({ state: 'superseded', replayed: false });
    expect(await grantsOf(target.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`, 'reception@operator']);

    const stamped = await leaver();
    const replacement = newId();
    await ctx.db.insert(account).values({ id: replacement, operatorId, phone: `+668769${String(++sequence).padStart(5, '0')}`, status: 'active' });
    await ctx.db.update(otoappUsers).set({ platformUserId: replacement }).where(eq(otoappUsers.id, stamped.userId));
    expect((await consume(stamped.event.id)).json()).toMatchObject({ state: 'superseded', replayed: false });
    expect(await grantsOf(stamped.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`, 'reception@operator']);
  });

  it('each door takes its own kind: a restriction is not a switch-off, and a switch-off is not a restriction', async () => {
    const target = await leaver();
    expect((await consume(target.event.id, key, deactivationUrl)).statusCode).toBe(404);
    const [still] = await ctx.db.select().from(account).where(eq(account.id, target.accountId));
    expect(still!.status).toBe('active');
    expect((await events(target.userId)).map((e) => e.state)).toEqual(['pending']);

    // The administrator's switch-off of the same login goes to the switch-off door alone.
    await ctx.db.update(otoappUsers).set({ isActive: false }).where(eq(otoappUsers.id, target.userId));
    const switchOff = (await events(target.userId)).find((e) => e.kind === 'deactivate')!;
    expect((await consume(switchOff.id)).statusCode).toBe(404);
    expect((await events(target.userId)).map((e) => `${e.kind}:${e.state}`)).toEqual(['restrict:pending', 'deactivate:pending']);
  });

  it('a foreign credential reads and changes nothing', async () => {
    const target = await leaver();
    expect((await consume(target.event.id, otherKey)).statusCode).toBe(404);
    expect(await grantsOf(target.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`, 'reception@operator']);
    expect((await events(target.userId)).map((e) => e.state)).toEqual(['pending']);
  });

  it('an audit failure rolls the withdrawal back, and the same event can be delivered again', async () => {
    const target = await leaver();
    const original = audit.record;
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
      if (entry.action === action) throw Error('ZZ TEST s769 audit failure');
      return original(tx, entry);
    });
    try { expect((await consume(target.event.id)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect(await grantsOf(target.accountId)).toEqual([`${appAccessRoleName('oto_app')}@operator`, 'reception@operator']);
    expect((await events(target.userId)).map((e) => e.state)).toEqual(['pending']);
    expect((await consume(target.event.id)).statusCode).toBe(200);
  });

  it('the last operator administrator is never stripped; the event stays visibly pending', async () => {
    const target = await leaver({ existingAccount: adminId });
    const before = await grantsOf(adminId);
    const response = await consume(target.event.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LAST_OPERATOR_ADMIN');
    expect(await grantsOf(adminId)).toEqual(before);
    expect((await events(target.userId)).map((e) => e.state)).toEqual(['pending']);
    expect(await audits(target.event.id)).toHaveLength(0);
  });

  it("the night's Failures case: a pending restriction or a role given back is listed; a delivered one holding the road alone is not", async () => {
    const pending = await leaver();
    const delivered = await leaver();
    const givenBack = await leaver();
    for (const t of [delivered, givenBack]) expect((await consume(t.event.id)).statusCode).toBe(200);
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: givenBack.accountId, roleId: await roleId('reception'), scopeType: 'operator', scopeId: operatorId });
    const listed = await accountsBeyondMyPay(ctx.db, operatorId, [pending.accountId, delivered.accountId, givenBack.accountId]);
    expect([...listed].sort()).toEqual([pending.accountId, givenBack.accountId].sort());
  });
});
