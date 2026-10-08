import { hash } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  account,
  appIdentity,
  auditLog,
  branch,
  operator,
  otoappUsers,
  role,
  roleAssignment,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { resolveEffectivePermissions } from '../src/services/permissions';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-17a — the platform side of an app identity: who in the OTO App is which
 * account here, the grant that opens the tile, the app's own user row, and the
 * tenancy fence around all of it.
 *
 * The database here carries the OTO App's schema as well as the platform's,
 * because provisioning writes `otoapp.users` in the same transaction as the
 * account — which is the only way a half-finished request cannot leave a
 * person in one place and not the other.
 */

/**
 * Fault injection for the transaction test. The grant is the step immediately
 * after the app's user row is written, so failing it is the cheapest way to
 * ask "what survives a failure in the middle" and get an honest answer.
 */
const failures = vi.hoisted(() => ({ grant: false }));
vi.mock('../src/services/app-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/app-identity')>();
  return {
    ...actual,
    grantAppAccess: async (...args: Parameters<typeof actual.grantAppAccess>) => {
      if (failures.grant) throw new Error('the grant failed');
      return actual.grantAppAccess(...args);
    },
  };
});

let ctx: TestContext;
let adminCookie: string;
let operatorId: string;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [op] = await ctx.db.select().from(operator).limit(1);
  operatorId = op!.id;
  /**
   * S2-17b round 2 — Link claims only a user the unlinked list could show this
   * operator: one the app places in a park group this operator is anchored in
   * (round 1's standing pin 1). One park group here, holding one of this
   * operator's parks; the users these tests link carry no branch-access row,
   * and in a one-park-group database the app places them in it.
   */
  const [park] = await ctx.db
    .select({ id: branch.id })
    .from(branch)
    .where(eq(branch.operatorId, operatorId))
    .limit(1);
  const tenantId = newId();
  await ctx.db.execute(
    sql`insert into otoapp.tenants (id, name, slug) values (${tenantId}, 'ZZ app identities', 'zz-app-identities')`,
  );
  await ctx.db.execute(
    sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id) values (${newId()}, ${tenantId}, 'ZZ app identities park', '', ${park!.id})`,
  );
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/**
 * A user that already exists in the OTO App — someone who worked there before
 * the platform did. Written straight into the app's table, the way the app
 * itself would have: this is what the link path is given.
 */
async function seedOtoAppUser(opts: {
  id: string;
  email: string;
  platformUserId?: string;
}): Promise<string> {
  await ctx.db.insert(otoappUsers).values({
    id: opts.id,
    email: opts.email,
    password: 'not-a-real-hash',
    fullName: 'Already In The OTO App',
    role: 'manager',
    isActive: true,
    mustChangePassword: true,
    platformUserId: opts.platformUserId ?? null,
  });
  return opts.id;
}

const otoAppUserById = async (id: string) =>
  (await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, id)))[0] ?? null;

/** An extra account with one role at one scope, password set directly. */
async function makeAccount(opts: {
  phone: string;
  password: string;
  roleName: string;
  scopeType: 'operator' | 'branch';
  scopeId: string | null;
}): Promise<string> {
  const [roleRow] = await ctx.db.select().from(role).where(eq(role.name, opts.roleName)).limit(1);
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId,
    phone: normalizePhone(opts.phone)!,
    passwordHash: await hash(opts.password),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  await ctx.db.insert(roleAssignment).values({
    id: newId(),
    accountId: id,
    roleId: roleRow!.id,
    scopeType: opts.scopeType,
    scopeId: opts.scopeId,
  });
  return id;
}

const canOpenOtoApp = async (accountId: string): Promise<boolean> =>
  (await resolveEffectivePermissions(ctx.db, accountId)).some(
    (p) => p.permission === 'app:oto_app:access',
  );

describe('POST /admin/apps/:app/users', () => {
  let accountId: string;
  let identityId: string;

  beforeAll(async () => {
    await seedOtoAppUser({ id: 'otoapp-user-1', email: 'user1@otopark.test' });
  });

  it('creates the account, records the link and opens the tile', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: {
        phone: '0811234567',
        name: 'Provisioned Manager',
        externalUserId: 'otoapp-user-1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().app).toBe('oto_app');
    expect(res.json().accountCreated).toBe(true);
    // The account is invited, so the setup code has to reach the phone or
    // nobody can ever sign in as the person who was just provisioned.
    expect(res.json().codeSent).toBe(true);
    accountId = res.json().accountId as string;
    identityId = res.json().id as string;

    const [created] = await ctx.db.select().from(account).where(eq(account.id, accountId));
    expect(created!.status).toBe('invited');
    expect(created!.phone).toBe('+66811234567');

    const [identity] = await ctx.db
      .select()
      .from(appIdentity)
      .where(eq(appIdentity.id, identityId));
    expect(identity!.app).toBe('oto_app');
    expect(identity!.externalUserId).toBe('otoapp-user-1');
    expect(identity!.accountId).toBe(accountId);

    expect(await canOpenOtoApp(accountId)).toBe(true);
    // The other half of the link, and the half the OTO App actually reads:
    // its own user row now names this account.
    expect((await otoAppUserById('otoapp-user-1'))!.platformUserId).toBe(accountId);
  });

  it('writes the audit row', async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'app_identity.link'));
    const row = rows.find((r) => r.entityId === identityId)!;
    expect(row.entityType).toBe('app_identity');
    expect(row.after).toMatchObject({
      app: 'oto_app',
      externalUserId: 'otoapp-user-1',
      accountCreated: true,
      accessGranted: true,
    });
  });

  it('lists the identity on the account, with the tile open', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/admin/apps/users/${accountId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().identities).toHaveLength(1);
    expect(res.json().identities[0]).toMatchObject({
      app: 'oto_app',
      externalUserId: 'otoapp-user-1',
      hasAccess: true,
    });
  });

  it('refuses a second link for the same account with 409, not 500', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: { accountId, externalUserId: 'otoapp-user-2' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('APP_IDENTITY_EXISTS');
  });

  it('refuses to hand another account the same app user, also with 409', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: {
        phone: '0817654321',
        name: 'Second Manager',
        externalUserId: 'otoapp-user-1',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('APP_USER_TAKEN');
    // The clash is caught before anything is written: no account was left
    // behind by the attempt.
    expect(
      await ctx.db.select().from(account).where(eq(account.phone, '+66817654321')),
    ).toHaveLength(0);
  });

  it('refuses a caller who could not open the app themselves', async () => {
    const [br] = await ctx.db.select().from(branch).where(eq(branch.operatorId, operatorId)).limit(1);
    await makeAccount({
      phone: '+66900000020',
      password: 'manager1234',
      roleName: 'branch_manager',
      scopeType: 'branch',
      scopeId: br!.id,
    });
    const cookie = await signInAs(ctx.app, '+66900000020', 'manager1234');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie },
      payload: { phone: '0819999999', name: 'Not Allowed', externalUserId: 'otoapp-user-9' },
    });
    // A branch manager's bundle carries app:pos:access but not the OTO App's,
    // so the grant is outside what they hold.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ROLE_NOT_DOMINATED');
  });
});

describe('DELETE /admin/apps/:app/users/:accountId', () => {
  let accountId: string;
  let identityId: string;

  beforeAll(async () => {
    await seedOtoAppUser({ id: 'otoapp-user-3', email: 'user3@otopark.test' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: { phone: '0812223333', name: 'Unlinked Soon', externalUserId: 'otoapp-user-3' },
    });
    accountId = res.json().accountId as string;
    identityId = res.json().id as string;
  });

  it('removes the link and withdraws the access the link granted', async () => {
    expect(await canOpenOtoApp(accountId)).toBe(true);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/admin/apps/oto_app/users/${accountId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, accessRevoked: true });

    expect(
      await ctx.db.select().from(appIdentity).where(eq(appIdentity.id, identityId)),
    ).toHaveLength(0);
    // The point of revoking with the unlink: a tile that still opened would
    // land the person in an app that no longer knows who they are. The stamp
    // goes too, so access arriving from some other role cannot sign them in
    // as that user anyway.
    expect(await canOpenOtoApp(accountId)).toBe(false);
    expect((await otoAppUserById('otoapp-user-3'))!.platformUserId).toBeNull();

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'app_identity.unlink'));
    expect(rows.some((r) => r.entityId === identityId)).toBe(true);
  });

  it('answers 404 when the account is not linked to that app', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/admin/apps/oto_app/users/${accountId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lets the same account be linked again afterwards', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: { accountId, externalUserId: 'otoapp-user-3' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accountCreated).toBe(false);
    expect(res.json().appUserCreated).toBe(false);
    expect(await canOpenOtoApp(accountId)).toBe(true);
    expect((await otoAppUserById('otoapp-user-3'))!.platformUserId).toBe(accountId);
  });
});

describe("the OTO App's own user row", () => {
  /** The flow the ticket exists for: nobody has to exist in the app first. */
  it('creates the app user and the account together', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: {
        phone: '0813334444',
        name: 'Made From The Console',
        otoApp: { email: 'Made.From.Console@otopark.test', role: 'manager' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().appUserCreated).toBe(true);
    const accountId = res.json().accountId as string;
    const externalUserId = res.json().externalUserId as string;

    const user = await otoAppUserById(externalUserId);
    expect(user).not.toBeNull();
    // What `platformSignOn.ts` resolves the person by. Without this the tile
    // opens and the app finds nobody.
    expect(user!.platformUserId).toBe(accountId);
    expect(user!.role).toBe('manager');
    expect(user!.fullName).toBe('Made From The Console');
    expect(user!.isActive).toBe(true);
    // Lower-cased on the way in, because every lookup in that app lower-cases
    // the address it is given.
    expect(user!.email).toBe('made.from.console@otopark.test');
    // The phone the platform account was created with, carried across so the
    // app's own screens show a person and not a blank.
    expect(user!.phoneE164).toBe('+66813334444');
    // The app's default is true and its client would send them to
    // /change-password, which asks for a password they were never given.
    expect(user!.mustChangePassword).toBe(false);
    // Not a hash anyone can produce, and not a placeholder either.
    expect(user!.password).not.toBe('');
    expect(user!.password).toMatch(/^[0-9a-f]{128}\.[0-9a-f]{32}$/);

    // And the link is recorded the same way as for a user that already existed.
    const [identity] = await ctx.db
      .select()
      .from(appIdentity)
      .where(eq(appIdentity.externalUserId, externalUserId));
    expect(identity!.accountId).toBe(accountId);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, identity!.id));
    expect(audits[0]!.after).toMatchObject({ appUserCreated: true, accountCreated: true });
  });

  it('stamps a user who was already in the app rather than making a second one', async () => {
    await seedOtoAppUser({ id: 'otoapp-user-existing', email: 'existing@otopark.test' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: {
        phone: '0814445555',
        name: 'Already There',
        externalUserId: 'otoapp-user-existing',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().appUserCreated).toBe(false);
    const user = await otoAppUserById('otoapp-user-existing');
    expect(user!.platformUserId).toBe(res.json().accountId);
    // Their own details are theirs: the link writes the stamp and nothing else.
    expect(user!.fullName).toBe('Already In The OTO App');
    expect(user!.email).toBe('existing@otopark.test');
    expect(
      await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.email, 'existing@otopark.test')),
    ).toHaveLength(1);
  });

  it('answers the same request twice with one app user, not two', async () => {
    const payload = {
      phone: '0815556666',
      name: 'Sent Twice',
      otoApp: { email: 'sent.twice@otopark.test', role: 'staff' },
    };
    const headers = { cookie: adminCookie, 'idempotency-key': 'provision-twice' };

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers,
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().externalUserId).toBe(first.json().externalUserId);
    expect(
      await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.email, 'sent.twice@otopark.test')),
    ).toHaveLength(1);
  });

  it('refuses an app user that is already another account, with 409', async () => {
    // Stamped with an account that is not the one being provisioned, and no
    // link row — the state an administrator reaches by pasting the wrong id.
    await seedOtoAppUser({
      id: 'otoapp-user-taken',
      email: 'taken@otopark.test',
      platformUserId: newId(),
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: { phone: '0816667777', name: 'Wrong Id', externalUserId: 'otoapp-user-taken' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('APP_USER_CLAIMED');
    // Nothing was written on the way to the refusal.
    expect(
      await ctx.db.select().from(account).where(eq(account.phone, '+66816667777')),
    ).toHaveLength(0);
  });

  it('answers 404 for an app user that is not there', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: { phone: '0817778888', name: 'No Such User', externalUserId: 'otoapp-user-absent' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a second user on an email the app already has', async () => {
    await seedOtoAppUser({ id: 'otoapp-user-email', email: 'shared@otopark.test' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: {
        phone: '0818889999',
        name: 'Duplicate Email',
        otoApp: { email: 'shared@otopark.test', role: 'staff' },
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('OTO_APP_USER_EXISTS');
    // The answer names the user to link instead, so the refusal is actionable.
    expect(res.json().error.details.externalUserId).toBe('otoapp-user-email');
  });

  /**
   * The reason all of this is one transaction. Asserted rather than claimed in
   * a comment: the grant is made to fail after the app's user row is written,
   * and nothing of that row may survive.
   */
  it('leaves no app user behind when a later step fails', async () => {
    failures.grant = true;
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/admin/apps/oto_app/users',
        headers: { cookie: adminCookie },
        payload: {
          phone: '0819990000',
          name: 'Rolled Back',
          otoApp: { email: 'rolled.back@otopark.test', role: 'manager' },
        },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      failures.grant = false;
    }

    expect(
      await ctx.db
        .select()
        .from(otoappUsers)
        .where(eq(otoappUsers.email, 'rolled.back@otopark.test')),
    ).toHaveLength(0);
    // The platform half went back with it: no orphaned account either.
    expect(
      await ctx.db.select().from(account).where(eq(account.phone, '+66819990000')),
    ).toHaveLength(0);

    // And the same request afterwards succeeds — the rollback left nothing to
    // collide with.
    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: {
        phone: '0819990000',
        name: 'Rolled Back',
        otoApp: { email: 'rolled.back@otopark.test', role: 'manager' },
      },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().appUserCreated).toBe(true);
  });

  it('still needs an id for an app whose users are not on this database', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/radar/users',
      headers: { cookie: adminCookie },
      payload: { phone: '0810001111', name: 'No Id Given' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('tenancy', () => {
  it("an operator administrator cannot link another operator's account", async () => {
    // A second operator with an administrator of its own, both made by the
    // platform admin.
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/operators',
      headers: { cookie: adminCookie },
      payload: { name: 'Second Park Co' },
    });
    const otherOperatorId = other.json().id as string;
    const admin = await ctx.app.inject({
      method: 'POST',
      url: `/operators/${otherOperatorId}/administrators`,
      headers: { cookie: adminCookie },
      payload: { phone: '+66900000030', name: 'Other Operator Admin' },
    });
    const foreignAccountId = admin.json().accountId as string;

    await makeAccount({
      phone: '+66900000031',
      password: 'opadmin1234',
      roleName: 'operator_admin',
      scopeType: 'operator',
      scopeId: operatorId,
    });
    const cookie = await signInAs(ctx.app, '+66900000031', 'opadmin1234');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie },
      payload: { accountId: foreignAccountId, externalUserId: 'otoapp-user-foreign' },
    });
    // 404, not 403: the existence of another operator's account is not ours
    // to confirm (S2-01a).
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(
      await ctx.db
        .select()
        .from(appIdentity)
        .where(
          and(eq(appIdentity.app, 'oto_app'), eq(appIdentity.accountId, foreignAccountId)),
        ),
    ).toHaveLength(0);
  });
});
