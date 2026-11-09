import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  authThrottle,
  otoappUsers,
  provisionOtoAppStaffAccounts,
  type StaffAccountsReport,
} from '@oto/db';
import { newId } from '@oto/shared';
import { appAccessBranches } from '../src/services/app-identity';
import { _resetThrottle } from '../src/services/auth';
import { findOtoAppUser } from '../src/services/oto-app-users';
import { resolveEffectivePermissions } from '../src/services/permissions';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-795 — the OTO App's staff sign in on the launcher with their phone
 * and the app password they already have.
 *
 * `provisionOtoAppStaffAccounts` (packages/db) gives each app user an account
 * with no platform password; the first sign-in checks the typed password
 * against the app's own scrypt hash once, keeps an argon2 hash of it, and from
 * then on the account is like any other. Pinned here, through the real route:
 * the script's rows are what the api's own readers call a Console link (the
 * tile, operator-wide, the stamped user) and the launcher mints the OTO App
 * hand-off for them; the first sign-in adopts and is audited with ids only;
 * the second is argon2 alone (the app hash is broken in between to prove it);
 * a wrong password is refused byte for byte as on any account and counted in
 * the same bucket; an account with a platform password never consults the
 * app hash; and a user switched off inside the app brings nothing.
 */

// --- `hashPassword` from apps/oto-app/server/auth.ts, verbatim ---------------
const scryptAsync = promisify(scrypt);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString('hex')}.${salt}`;
}
// -----------------------------------------------------------------------------

const KID = 'k1';
const SECRET = 'handoff-test-secret-0123456789abcdef';
const OTO_APP_ORIGIN = 'https://otoapp.test';

const PEOPLE = {
  first: { phone: '+66811795001', appPassword: 'zz-app-first-795' },
  wrong: { phone: '+66811795002', appPassword: 'zz-app-wrong-795' },
  platform: { phone: '+66811795003', appPassword: 'zz-app-platform-795' },
  off: { phone: '+66811795004', appPassword: 'zz-app-off-795' },
} as const;
type Key = keyof typeof PEOPLE;
const PLATFORM_OWN_PASSWORD = 'zz-platform-own-795';

let ctx: TestContext;
let operatorId: string;
let central: string;
let report: StaffAccountsReport;
const userIds = {} as Record<Key, string>;
const accountIds = {} as Record<Key, string>;
const appHashes = {} as Record<Key, string>;

const signIn = (phone: string, password: string) =>
  ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { phone, password } });

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const set = res.headers['set-cookie'];
  return String(Array.isArray(set) ? set[0] : set).split(';')[0]!;
};

const storedHash = async (key: Key) =>
  (await ctx.db.select({ h: account.passwordHash }).from(account).where(eq(account.id, accountIds[key])))[0]!.h;

const appHash = async (key: Key) =>
  (await ctx.db.select({ p: otoappUsers.password }).from(otoappUsers).where(eq(otoappUsers.id, userIds[key])))[0]!.p;

const adoptions = (key: Key) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'account.password_adopted'), eq(auditLog.entityId, accountIds[key])));

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: { HANDOFF_SIGNING_KEY: `${KID}:${SECRET}`, HANDOFF_APP_ORIGINS: `oto_app=${OTO_APP_ORIGIN}` },
  });
  operatorId = await operatorIdByName(ctx.db, 'OTO');
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [admin] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, ADMIN.phone));

  const tenant = newId();
  const appBranch = newId();
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${tenant}, 'ZZ 795', 'zz-795')`);
  await ctx.db.execute(
    sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id) values (${appBranch}, ${tenant}, 'ZZ 795 park', '', ${central})`,
  );
  for (const key of Object.keys(PEOPLE) as Key[]) {
    const id = newId();
    userIds[key] = id;
    appHashes[key] = await hashPassword(PEOPLE[key].appPassword);
    await ctx.db.insert(otoappUsers).values({
      id,
      email: `zz-795-${key}@example.test`,
      password: appHashes[key],
      fullName: `ZZ TEST 795 ${key}`,
      role: 'staff',
      isActive: true,
      mustChangePassword: true,
      phoneE164: PEOPLE[key].phone,
    });
    await ctx.db.execute(
      sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values (${newId()}, ${tenant}, ${id}, ${appBranch}, 'selected_branches')`,
    );
  }

  report = await provisionOtoAppStaffAccounts(ctx.db, { operatorId, apply: true, actorAccountId: admin!.id });
  for (const key of Object.keys(PEOPLE) as Key[]) {
    accountIds[key] = report.people.find((p) => p.userId === userIds[key])!.accountId!;
  }
  // One that already holds a platform password, and one the app has switched off.
  await ctx.db
    .update(account)
    .set({ passwordHash: await hash(PLATFORM_OWN_PASSWORD) })
    .where(eq(account.id, accountIds.platform));
  await ctx.db.update(otoappUsers).set({ isActive: false }).where(eq(otoappUsers.id, userIds.off));
}, 240_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-795: the provisioned accounts', () => {
  it('are, to the api, what a Console link makes: the tile operator-wide, the role at the branch, the stamped user', async () => {
    expect(report.outcomes.provision).toBe(4);
    expect(report.outcomes.failed).toBe(0);
    for (const key of Object.keys(PEOPLE) as Key[]) expect(accountIds[key], key).toBeTruthy();

    const effective = await resolveEffectivePermissions(ctx.db, accountIds.first);
    expect(effective).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permission: 'app:oto_app:access', scopeType: 'operator', scopeId: operatorId }),
        expect.objectContaining({ permission: 'app:pos:access', scopeType: 'branch', scopeId: central, roleName: 'staff' }),
      ]),
    );
    expect(await appAccessBranches(ctx.db, accountIds.first, operatorId, 'oto_app')).toBeNull();
    expect((await findOtoAppUser(ctx.db, { platformUserId: accountIds.first }))?.id).toBe(userIds.first);
    expect(await storedHash('first')).toBeNull();
  });
});

describe('SCRUM-795: the first sign-in adopts the OTO App password', () => {
  it('signs in with the app password once, keeps an argon2 hash of it, and audits ids only', async () => {
    const res = await signIn(PEOPLE.first.phone, PEOPLE.first.appPassword);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ accountId: accountIds.first, mustChangePassword: false });

    const kept = (await storedHash('first'))!;
    expect(kept).toMatch(/^\$argon2id\$/);
    expect(await verify(kept, PEOPLE.first.appPassword)).toBe(true);
    // The app's hash stays where it was, and was not copied.
    expect(await appHash('first')).toBe(appHashes.first);
    expect(kept).not.toContain(appHashes.first.split('.')[0]!);

    const rows = await adoptions('first');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorAccountId: accountIds.first, operatorId, entityType: 'account' });
    expect(rows[0]!.after).toEqual({ app: 'oto_app', externalUserId: userIds.first });
    const text = JSON.stringify(rows[0]);
    for (const secret of [PEOPLE.first.appPassword, PEOPLE.first.phone, kept, appHashes.first]) {
      expect(text).not.toContain(secret);
    }

    // And the launcher opens the OTO App for them.
    const handoff = await ctx.app.inject({
      method: 'POST',
      url: '/auth/handoff',
      headers: { cookie: cookieOf(res) },
      payload: { app: 'oto_app' },
    });
    expect(handoff.statusCode, handoff.body).toBe(200);
  });

  it('verifies the second sign-in against argon2 alone: breaking the app hash changes nothing', async () => {
    await ctx.db.update(otoappUsers).set({ password: 'broken' }).where(eq(otoappUsers.id, userIds.first));
    const res = await signIn(PEOPLE.first.phone, PEOPLE.first.appPassword);
    expect(res.statusCode, res.body).toBe(200);
    expect(await adoptions('first')).toHaveLength(1);
    expect((await signIn(PEOPLE.first.phone, 'zz-not-it-795')).statusCode).toBe(401);
    await _resetThrottle(ctx.db);
  });

  it('refuses a wrong password exactly as on any account, and counts it in the same bucket', async () => {
    await _resetThrottle(ctx.db);
    const ordinary = await signIn(ADMIN.phone, 'zz-not-the-admin-password');
    const refused = await signIn(PEOPLE.wrong.phone, 'zz-not-the-app-password');
    expect(refused.statusCode).toBe(401);
    expect(refused.body).toBe(ordinary.body);
    expect(refused.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });

    const [bucket] = await ctx.db
      .select()
      .from(authThrottle)
      .where(eq(authThrottle.key, `phone:${PEOPLE.wrong.phone}`));
    expect(bucket?.failures).toBe(1);
    const [failed] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.sign_in_failed'), eq(auditLog.entityId, accountIds.wrong)));
    expect(failed?.after).toMatchObject({ reason: 'bad_password' });
    expect(await storedHash('wrong')).toBeNull();
    expect(await adoptions('wrong')).toHaveLength(0);

    // The right one still works afterwards, and clears the bucket.
    const ok = await signIn(PEOPLE.wrong.phone, PEOPLE.wrong.appPassword);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await adoptions('wrong')).toHaveLength(1);
    expect(
      await ctx.db.select().from(authThrottle).where(eq(authThrottle.key, `phone:${PEOPLE.wrong.phone}`)),
    ).toEqual([]);
    await _resetThrottle(ctx.db);
  });

  it('never consults the app hash for an account that holds a platform password', async () => {
    const before = await storedHash('platform');
    const withApp = await signIn(PEOPLE.platform.phone, PEOPLE.platform.appPassword);
    expect(withApp.statusCode).toBe(401);
    expect(await storedHash('platform')).toBe(before);
    expect(await adoptions('platform')).toHaveLength(0);
    const withOwn = await signIn(PEOPLE.platform.phone, PLATFORM_OWN_PASSWORD);
    expect(withOwn.statusCode, withOwn.body).toBe(200);
    expect(await appHash('platform')).toBe(appHashes.platform);
    await _resetThrottle(ctx.db);
  });

  it('takes nothing from a user the app has switched off', async () => {
    const res = await signIn(PEOPLE.off.phone, PEOPLE.off.appPassword);
    expect(res.statusCode).toBe(401);
    expect(await storedHash('off')).toBeNull();
    expect(await adoptions('off')).toHaveLength(0);
    await _resetThrottle(ctx.db);
  });
});
