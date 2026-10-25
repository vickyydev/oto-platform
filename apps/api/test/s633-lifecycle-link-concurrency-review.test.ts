import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, appIdentity, auditLog, branch, otoappUsers, role, roleAssignment, session } from '@oto/db';
import { newId } from '@oto/shared';
import { otoAppProvisionKeyDigest } from '../src/lib/otoapp-provision-keys';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext, operatorId: string, adminCookie: string, tenantId: string;
const credential = randomBytes(32).toString('hex');
const lifecycleAction = 'app_identity.lifecycle_deactivation';
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
};

beforeAll(async () => {
  const env: Record<string, string> = {};
  ctx = await createTestContext({ otoapp: true, env });
  const [owner] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  operatorId = owner!.operatorId;
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(credential)}`;
  await ctx.restart();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [park] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId));
  tenantId = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants(id,name,slug)
    values (${tenantId},'ZZ TEST 633 link concurrency',${`zz-633-link-${tenantId}`})`);
  await ctx.db.execute(sql`insert into otoapp.branches(id,tenant_id,name,address,core_branch_id)
    values (${newId()},${tenantId},'ZZ TEST 633 link park','',${park!.id})`);
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

const link = (accountId: string, userId: string) => ctx.app.inject({
  method: 'POST', url: '/admin/apps/oto_app/users',
  headers: { cookie: adminCookie, 'idempotency-key': newId() },
  payload: { accountId, externalUserId: userId },
});

describe('SCRUM-633 lifecycle delivery racing an existing-account identity link', () => {
  it('P1 relinking and consuming the old switch-off both finish, then enforce fresh exact ownership without a lock inversion', async () => {
    const accountId = newId(), userId = newId(), membershipId = newId();
    await ctx.db.insert(account).values({ id: accountId, operatorId, phone: '+66863399001', status: 'active' });
    const [reception] = await ctx.db.select().from(role).where(and(isNull(role.operatorId), eq(role.name, 'reception')));
    expect(reception).toBeDefined();
    const ordinaryAssignmentId = newId();
    await ctx.db.insert(roleAssignment).values({ id: ordinaryAssignmentId, accountId, roleId: reception!.id,
      scopeType: 'operator', scopeId: operatorId });
    await ctx.db.insert(otoappUsers).values({ id: userId, email: `${userId}@zz-test.invalid`, password: 'ZZ TEST unusable hash',
      fullName: 'ZZ TEST link concurrency', role: 'staff', isActive: true, mustChangePassword: false });
    await ctx.db.execute(sql`insert into otoapp.user_branch_access(id,tenant_id,user_id,branch_id,access_scope)
      values (${membershipId},${tenantId},${userId},null,'all_branches')`);

    // Reach this state through the supported link/unlink paths. The queued
    // switch-off remains pending while unlink clears only the current stamp.
    const initialLink = await link(accountId, userId);
    expect(initialLink.statusCode).toBe(200);
    const initialIdentityId = initialLink.json<{ id: string }>().id;
    await ctx.db.update(otoappUsers).set({ isActive: false }).where(eq(otoappUsers.id, userId));
    const [event] = (await ctx.db.execute<{ id: string; state: string }>(sql`
      select id,state from otoapp.login_lifecycle_events where user_id=${userId}`)).rows;
    expect(event).toMatchObject({ state: 'pending' });
    const unlinked = await ctx.app.inject({ method: 'DELETE', url: `/admin/apps/oto_app/users/${accountId}`,
      headers: { cookie: adminCookie, 'idempotency-key': newId() } });
    expect(unlinked.statusCode).toBe(200);
    expect(await ctx.db.select().from(appIdentity).where(eq(appIdentity.accountId, accountId))).toEqual([]);
    expect((await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, userId)))[0]).toMatchObject({
      isActive: false, platformUserId: null,
    });

    const platformSessionId = newId(), appSid = `ZZ TEST 633 link ${newId()}`;
    await ctx.db.insert(session).values({ id: platformSessionId, accountId,
      tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 86_400_000) });
    await ctx.db.execute(sql`insert into otoapp.session(sid,sess,expire)
      values (${appSid},${JSON.stringify({ passport: { user: userId } })}::jsonb,now()+interval '1 day')`);
    const beforeAccess = (await ctx.db.execute(sql`select id,tenant_id,user_id,branch_id,access_scope
      from otoapp.user_branch_access where user_id=${userId} order by id`)).rows;
    const beforeOrdinaryGrant = await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.id, ordinaryAssignmentId));

    const held = gate(), release = gate();
    let holderPid = 0;
    const holder = ctx.db.transaction(async tx => {
      holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      await tx.execute(sql`select id from core.account where id=${accountId} for update`);
      held.release();
      await release.ready;
    });
    await held.ready;
    const delivery = Promise.resolve().then(() => ctx.app.inject({
      method: 'POST', url: '/admin/apps/oto_app/lifecycle-deactivations',
      headers: { authorization: `Bearer ${credential}` }, payload: { eventId: event!.id },
    }));
    let relink: Promise<Awaited<ReturnType<typeof link>>> | undefined;
    let consumerPid = 0;
    let relinkFinished: { status: number; code: string } | undefined;
    try {
      // Queue the consumer first. Match its actual account-lock SELECT, not
      // unrelated activity, and retain this predicate after the lock-mode fix.
      await expect.poll(async () => {
        const waiting = (await ctx.db.execute<{ pid: number }>(sql`
        select pid from pg_stat_activity
        where datname=current_database() and application_name='oto-test-api'
          and wait_event_type='Lock' and ${holderPid}=any(pg_blocking_pids(pid))
          and position('from "core"."account"' in query)>0
          and (position('for update' in lower(query))>0 or position('for no key update' in lower(query))>0)
        `)).rows;
        if (waiting.length === 1) consumerPid = waiting[0]!.pid;
        return waiting.length;
      }, { timeout: 10_000, interval: 20 }).toBe(1);
      // Existing accountId deliberately avoids the new-account insert path.
      // The link stamps/locks the app user before its first target-account FK:
      // this identity insert. Its idempotency owner is the distinct admin actor.
      relink = Promise.resolve().then(() => link(accountId, userId)).then(response => {
        const code = response.json<{ error?: { code?: string } }>().error?.code;
        const knownCodes = ['NOT_FOUND', 'APP_IDENTITY_EXISTS', 'APP_USER_TAKEN', 'APP_USER_CLAIMED', 'INTERNAL_ERROR', 'FORBIDDEN', 'UNAUTHENTICATED'];
        relinkFinished = { status: response.statusCode, code: code && knownCodes.includes(code) ? code : 'UNCLASSIFIED' };
        return response;
      });
      // PostgreSQL may report the earlier queued tuple-lock waiter rather
      // than the original holder as this INSERT's immediate blocker. Require
      // the proven consumer-to-holder chain in the same database observation.
      await expect.poll(async () => {
        if (relinkFinished) throw new Error(`Link completed before the account-FK wait: status=${relinkFinished.status}, code=${relinkFinished.code}`);
        return (await ctx.db.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity linked
          join pg_stat_activity consumer on consumer.pid=${consumerPid}
          where linked.datname=current_database() and linked.application_name='oto-test-api'
            and linked.wait_event_type='Lock'
            and (${holderPid}=any(pg_blocking_pids(linked.pid)) or ${consumerPid}=any(pg_blocking_pids(linked.pid)))
            and position('insert into "core"."app_identity"' in linked.query)>0
            and consumer.datname=current_database() and consumer.wait_event_type='Lock'
            and ${holderPid}=any(pg_blocking_pids(consumer.pid))
        `)).rows[0]!.n;
      }, { timeout: 10_000, interval: 20 }).toBe(1);
    } finally {
      release.release();
      await holder;
      // Drain both genuine requests even when a scheduling assertion fails.
      await Promise.all([delivery, ...(relink ? [relink] : [])]);
    }
    const [delivered, linked] = await Promise.all([delivery, relink!]);
    expect([delivered.statusCode, linked.statusCode]).toEqual([200, 200]);
    expect(delivered.json()).toEqual({ ok: true, eventId: event!.id, state: 'delivered', replayed: false });
    const identities = await ctx.db.select().from(appIdentity).where(eq(appIdentity.accountId, accountId));
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ id: linked.json<{ id: string }>().id, app: 'oto_app', accountId, externalUserId: userId });
    expect(identities[0]!.id).not.toBe(initialIdentityId);
    expect((await ctx.db.select().from(account).where(eq(account.id, accountId)))[0]!.status).toBe('inactive');
    expect((await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, userId)))[0]).toMatchObject({
      isActive: false, platformUserId: accountId, role: 'staff',
    });
    const events = (await ctx.db.execute<{ id: string; state: string; settled_at: string | null }>(sql`
      select id,state,settled_at from otoapp.login_lifecycle_events where user_id=${userId}`)).rows;
    expect(events).toEqual([expect.objectContaining({ id: event!.id, state: 'delivered', settled_at: expect.any(String) })]);
    expect(Number.isFinite(Date.parse(events[0]!.settled_at!))).toBe(true);
    expect((await ctx.db.select().from(session).where(eq(session.id, platformSessionId)))[0]!.revokedAt).not.toBeNull();
    expect((await ctx.db.execute(sql`select sid from otoapp.session where sid=${appSid}`)).rows).toEqual([]);
    expect((await ctx.db.execute(sql`select id,tenant_id,user_id,branch_id,access_scope
      from otoapp.user_branch_access where user_id=${userId} order by id`)).rows).toEqual(beforeAccess);
    expect(await ctx.db.select().from(roleAssignment).where(eq(roleAssignment.id, ordinaryAssignmentId))).toEqual(beforeOrdinaryGrant);
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, lifecycleAction), eq(auditLog.actionId, event!.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorAccountId: null, operatorId, entityId: event!.id,
      after: expect.objectContaining({ accountId, externalUserId: userId, state: 'delivered' }) });
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'app_identity.link'), eq(auditLog.entityId, identities[0]!.id))))
      .toHaveLength(1);
    expect(ctx.smsLog).toEqual([]);
  });
});
