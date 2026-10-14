import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, appIdentity, auditLog, branch, otoappUsers, role, roleAssignment } from '@oto/db';
import { newId } from '@oto/shared';
import {
  otoAppProvisionKeyDigest,
  parseOtoAppProvisionKeys,
} from '../src/lib/otoapp-provision-keys';
import { resolveEffectivePermissions } from '../src/services/permissions';
import { ADMIN, createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-539 — the OTO App's server gives an advisor or an app-created user a
 * suite sign-in, with a provisioning key of its own. Pinned here: the key is
 * the only way in, the person ends up with a NEW account that opens only the
 * OTO App and must change its one-time password, an advisor is allowed, a
 * retry of the same press never mints a second account or password, and the
 * key cannot reach an existing account or another park group's person.
 */

const KEY = 'zz-test-provision-key-0123456789abcdefghijklmnop';
const URL = '/admin/apps/oto_app/suite-sign-ins';

let ctx: TestContext;
let operatorId: string;
let adminAccountId: string;
let actorAppUserId: string;
let staffUserId: string;
let advisorUserId: string;
let otherTenantUserId: string;
let inactiveUserId: string;

async function seedAppUser(opts: {
  role: 'staff' | 'advisor' | 'admin';
  isActive?: boolean;
  platformUserId?: string | null;
  tenantId?: string;
  branchId?: string;
}): Promise<string> {
  const id = newId();
  await ctx.db.insert(otoappUsers).values({
    id,
    email: `zz-${id}@example.test`,
    password: 'not-a-real-hash',
    fullName: `ZZ TEST ${opts.role}`,
    role: opts.role,
    isActive: opts.isActive ?? true,
    mustChangePassword: true,
    platformUserId: opts.platformUserId ?? null,
  });
  if (opts.tenantId && opts.branchId) {
    await ctx.db.execute(
      sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values (${newId()}, ${opts.tenantId}, ${id}, ${opts.branchId}, 'selected_branches')`,
    );
  }
  return id;
}

const provision = (body: Record<string, unknown>, key: string | null = KEY) =>
  ctx.app.inject({
    method: 'POST',
    url: URL,
    headers: key ? { authorization: `Bearer ${key}` } : {},
    payload: body,
  });

beforeAll(async () => {
  // The operator is minted by the seed, so the key is bound to it after the
  // first boot and the api restarted on the same database to read it.
  const env: Record<string, string> = {};
  ctx = await createTestContext({ otoapp: true, env });
  const [admin] = await ctx.db
    .select()
    .from(account)
    .where(eq(account.phone, ADMIN.phone))
    .limit(1);
  adminAccountId = admin!.id;
  operatorId = admin!.operatorId;
  env.OTOAPP_PROVISION_KEYS = `${operatorId}:${otoAppProvisionKeyDigest(KEY)}`;
  await ctx.restart();

  // Two park groups: ours, anchored to one of this operator's parks, and one
  // nobody on this platform is anchored in.
  const [park] = await ctx.db
    .select({ id: branch.id })
    .from(branch)
    .where(eq(branch.operatorId, operatorId))
    .limit(1);
  const ours = newId();
  const theirs = newId();
  const ourBranch = newId();
  const theirBranch = newId();
  await ctx.db.execute(
    sql`insert into otoapp.tenants (id, name, slug) values (${ours}, 'ZZ TEST ours', 'zz-539-ours'), (${theirs}, 'ZZ TEST theirs', 'zz-539-theirs')`,
  );
  await ctx.db.execute(
    sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id) values (${ourBranch}, ${ours}, 'ZZ 539 park', '', ${park!.id}), (${theirBranch}, ${theirs}, 'ZZ 539 elsewhere', '', null)`,
  );

  actorAppUserId = await seedAppUser({
    role: 'admin',
    platformUserId: adminAccountId,
    tenantId: ours,
    branchId: ourBranch,
  });
  staffUserId = await seedAppUser({ role: 'staff', tenantId: ours, branchId: ourBranch });
  advisorUserId = await seedAppUser({ role: 'advisor', tenantId: ours, branchId: ourBranch });
  inactiveUserId = await seedAppUser({
    role: 'staff',
    isActive: false,
    tenantId: ours,
    branchId: ourBranch,
  });
  otherTenantUserId = await seedAppUser({ role: 'staff', tenantId: theirs, branchId: theirBranch });
});

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-539: the OTO App server provisions a suite sign-in', () => {
  it('parses only digests bound to an operator, never a raw key', () => {
    expect(parseOtoAppProvisionKeys('')).toEqual([]);
    expect(() => parseOtoAppProvisionKeys(`${newId()}:${KEY}`)).toThrow(/SHA-256/);
    expect(() => parseOtoAppProvisionKeys(`not-a-uuid:${'a'.repeat(64)}`)).toThrow(/operator uuid/);
  });

  it('refuses a caller without the key, with a wrong key, or with a staff session', async () => {
    const body = { actionId: newId(), appUserId: staffUserId, phone: '0811110539', actorAppUserId };
    expect((await provision(body, null)).statusCode).toBe(401);
    expect((await provision(body, 'not-the-key')).statusCode).toBe(401);
    const signIn = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: ADMIN.phone, password: ADMIN.password },
    });
    const cookie = String(signIn.headers['set-cookie']).split(';')[0]!;
    const withSession = await ctx.app.inject({
      method: 'POST',
      url: URL,
      headers: { cookie },
      payload: body,
    });
    expect(withSession.statusCode).toBe(401);
    const made = await ctx.db
      .select()
      .from(appIdentity)
      .where(eq(appIdentity.externalUserId, staffUserId));
    expect(made).toEqual([]);
  });

  it('provisions an app-created user: new account, app access only, forced change, audited', async () => {
    const actionId = newId();
    const res = await provision({
      actionId,
      appUserId: staffUserId,
      phone: '081-111-0539',
      actorAppUserId,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: actionId,
      phone: '+66811110539',
      externalUserId: staffUserId,
      replayed: false,
    });
    expect(typeof body.temporaryPassword).toBe('string');
    expect(res.headers['x-oto-replay']).toBeUndefined();

    const [acc] = await ctx.db.select().from(account).where(eq(account.id, body.accountId));
    expect(acc).toMatchObject({ status: 'active', mustChangePassword: true, operatorId });
    const effective = await resolveEffectivePermissions(ctx.db, body.accountId);
    expect([...new Set(effective.map((p) => p.permission))]).toEqual(['app:oto_app:access']);

    const [user] = await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, staffUserId));
    expect(user).toMatchObject({ platformUserId: body.accountId, mustChangePassword: false });

    const [identity] = await ctx.db.select().from(appIdentity).where(eq(appIdentity.id, actionId));
    expect(identity).toMatchObject({
      app: 'oto_app',
      accountId: body.accountId,
      createdBy: adminAccountId,
    });

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'app_identity.provision'), eq(auditLog.entityId, actionId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorAccountId).toBe(adminAccountId);
    expect(rows[0]!.after).toMatchObject({
      targetApp: 'oto_app',
      actorAppUserId,
      externalUserId: staffUserId,
    });
    expect(JSON.stringify(rows[0]!.after)).not.toContain(body.temporaryPassword);

    // The person signs in at the launcher with it, and owes a change.
    const signIn = await ctx.app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { phone: '0811110539', password: body.temporaryPassword },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    expect(signIn.json()).toMatchObject({ accountId: body.accountId, mustChangePassword: true });
  });

  it('a retry of the same press answers the same account and no password, and writes nothing', async () => {
    const actionId = newId();
    const first = await provision({
      actionId,
      appUserId: advisorUserId,
      phone: '0822220539',
      actorAppUserId,
    });
    expect(first.statusCode, first.body).toBe(200);
    const again = await provision({
      actionId,
      appUserId: advisorUserId,
      phone: '0822220539',
      actorAppUserId,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({
      id: actionId,
      accountId: first.json().accountId,
      temporaryPassword: null,
      replayed: true,
    });
    const accounts = await ctx.db.select().from(account).where(eq(account.phone, '+66822220539'));
    expect(accounts).toHaveLength(1);
    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, actionId));
    expect(audits).toHaveLength(1);

    // An advisor: linked, and no branch access was written by the platform.
    const [user] = await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, advisorUserId));
    expect(user!.platformUserId).toBe(first.json().accountId);
    const access = await ctx.db.execute<{ n: string }>(
      sql`select count(*)::text as n from otoapp.user_branch_access where user_id = ${advisorUserId}`,
    );
    expect(access.rows[0]!.n).toBe('1');

    // The same action id for somebody else is refused.
    const reused = await provision({
      actionId,
      appUserId: staffUserId,
      phone: '0833330539',
      actorAppUserId,
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('ACTION_ID_REUSED');
  });

  it('never re-issues: an already linked person is refused', async () => {
    const res = await provision({
      actionId: newId(),
      appUserId: staffUserId,
      phone: '0844440539',
      actorAppUserId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUITE_SIGNIN_EXISTS');
  });

  it('never touches an existing account: a phone already in use is refused', async () => {
    const fresh = await seedAppUser({ role: 'staff' });
    // Placed in our park group through the one-tenant rule? Not here: two
    // tenants exist, so seat them explicitly in ours via the advisor's row.
    const [row] = (
      await ctx.db.execute<{ tenant_id: string; branch_id: string }>(
        sql`select tenant_id::text, branch_id from otoapp.user_branch_access where user_id = ${staffUserId} limit 1`,
      )
    ).rows;
    await ctx.db.execute(
      sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values (${newId()}, ${row!.tenant_id}, ${fresh}, ${row!.branch_id}, 'selected_branches')`,
    );
    const res = await provision({
      actionId: newId(),
      appUserId: fresh,
      phone: ADMIN.phone,
      actorAppUserId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_EXISTS');
    const [admin] = await ctx.db.select().from(account).where(eq(account.id, adminAccountId));
    expect(admin!.mustChangePassword).toBe(false);
  });

  it('cannot reach another park group, a switched-off user, or act for an unlinked administrator', async () => {
    const other = await provision({
      actionId: newId(),
      appUserId: otherTenantUserId,
      phone: '0855550539',
      actorAppUserId,
    });
    expect(other.statusCode).toBe(404);
    const inactive = await provision({
      actionId: newId(),
      appUserId: inactiveUserId,
      phone: '0866660539',
      actorAppUserId,
    });
    expect(inactive.statusCode).toBe(409);
    const notAnActor = await provision({
      actionId: newId(),
      appUserId: inactiveUserId,
      phone: '0866660539',
      actorAppUserId: otherTenantUserId,
    });
    expect(notAnActor.statusCode).toBe(403);
    expect(notAnActor.json().error.code).toBe('OTOAPP_PROVISION_ACTOR');
    const accounts = await ctx.db.select().from(account).where(eq(account.phone, '+66855550539'));
    expect(accounts).toEqual([]);
  });

  it('grants through the operator access role, the same one the POS admin uses', async () => {
    const [roleRow] = await ctx.db
      .select()
      .from(role)
      .where(and(eq(role.operatorId, operatorId), eq(role.name, 'app_access_oto_app')));
    const held = await ctx.db
      .select()
      .from(roleAssignment)
      .where(eq(roleAssignment.roleId, roleRow!.id));
    expect(held.every((h) => h.scopeType === 'operator')).toBe(true);
    expect(held.length).toBeGreaterThanOrEqual(2);
  });
});
