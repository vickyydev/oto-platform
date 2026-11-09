import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { newId } from '@oto/shared';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import { otoappUsers } from '../src/schema/otoapp';
import {
  OTO_APP_ROLE_TO_PLATFORM,
  provisionOtoAppStaffAccounts,
  STAFF_ACCOUNTS_REQUEST_ID,
  StaffAccountsRefused,
  type StaffAccountsReport,
} from '../src/otoapp-staff-accounts';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-795 — a platform account for every OTO App user who has none, against
 * a real database with the app's schema on it. Pinned: the role mapping is the
 * one table the owner reviews; a dry run writes nothing and says, per person,
 * one outcome; applying needs an administrator as the actor; each person gets
 * an active account with no password, the identity link, the stamp, the tile
 * and the mapped role at the right scope, audited without a phone; the app's
 * forced change is carried to the account and left on the app user; the
 * phone counts as verified only where the app proves the user's own
 * phone_e164; and a second run finds nothing to do.
 */

let db: Db;
let close: () => Promise<void>;
let operatorId: string;
let central: string;
let chalong: string;
let actorId: string;
let staffAccountId: string;
const roleIds: Record<string, string> = {};

/** App ids, by what each user is in this test. */
const u: Record<string, string> = {};
const appEmployees: Record<string, string> = {};
const mirrors: Record<string, string> = {};

/** Every phone number written into the test data — none may reach a report. */
const PHONES = {
  staffA: '+66811111001',
  staffBLocal: '081-111-1002',
  staffB: '+66811111002',
  staffCEmployee: '+66811111003',
  manager: '+66811111004',
  admin: '+66811111005',
  opAdmin: '+66811111006',
  advisor: '+66811111007',
  global: '+66811111008',
  inactive: '+66811111009',
  actor: '+66811111010',
  identityOnly: '+66811111011',
  shared: '+66811111020',
  sharedLocal: '0811111020',
  foreign: '+66811111021',
  odd: '+66811111022',
  ambiguous: '+66811111023',
  held: '+66811111024',
  noCopy: '+66811111025',
  heldAccount: '+66811111026',
  managerAll: '+66811111027',
  managerHeadOffice: '+66811111028',
};

/** The provisioned people the app still owes a password change: all but `admin`, who changed it. */
const MUST_CHANGE = (key: string) => key !== 'admin';
/** The provisioned people whose phone the app proves: their own phone_e164 with phone_verified. */
const VERIFIED = new Set(['staffA', 'admin']);

async function count(table: 'account' | 'app_identity' | 'audit_log' | 'role_assignment'): Promise<number> {
  const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from core.${table}`));
  return r.rows[0]!.n;
}

async function appUser(
  key: string,
  opts: {
    role: string;
    phoneE164?: string | null;
    phoneNumber?: string | null;
    isActive?: boolean;
    operatorId?: string | null;
    platformUserId?: string | null;
    /** The app's own defaults: a forced change owed, the phone not verified. */
    mustChangePassword?: boolean;
    phoneVerified?: boolean;
  },
): Promise<string> {
  const id = newId();
  u[key] = id;
  await db.execute(sql`
    insert into otoapp.users (id, email, password, full_name, role, operator_id, is_active, must_change_password,
      phone_number, phone_e164, phone_verified, platform_user_id)
    values (${id}, ${`zz-${key}@example.test`}, 'not-a-real-hash', ${`ZZ Person ${key}`}, ${opts.role},
      ${opts.operatorId ?? null}, ${opts.isActive ?? true}, ${opts.mustChangePassword ?? true}, ${opts.phoneNumber ?? null},
      ${opts.phoneE164 ?? null}, ${opts.phoneVerified ?? false}, ${opts.platformUserId ?? null})`);
  return id;
}

async function access(userId: string, tenantId: string, branchId: string | null): Promise<void> {
  await db.execute(sql`
    insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope)
    values (${newId()}, ${tenantId}, ${userId}, ${branchId}, ${branchId ? 'selected_branches' : 'all_branches'})`);
}

async function appEmployee(key: string, tenantId: string, userId: string): Promise<string> {
  const id = newId();
  appEmployees[key] = id;
  await db.execute(sql`
    insert into otoapp.employees (id, tenant_id, full_name, nickname, email, user_id)
    values (${id}, ${tenantId}, ${`ZZ Employee ${key}`}, 'zz', ${`zz-emp-${key}@example.test`}, ${userId})`);
  return id;
}

async function mirror(key: string, externalId: string, phone: string | null): Promise<string> {
  const id = newId();
  mirrors[key] = id;
  await db.insert(s.employee).values({
    id,
    operatorId,
    name: `ZZ Copy ${key}`,
    phone,
    source: 'otoapp',
    externalId,
    branchId: central,
  });
  return id;
}

async function platformAccount(phone: string, roleName?: string, employeeId?: string | null): Promise<string> {
  const id = newId();
  await db.insert(s.account).values({
    id,
    operatorId,
    phone,
    passwordHash: 'not-a-real-hash',
    status: 'active',
    employeeId: employeeId ?? null,
  });
  if (roleName) {
    await db.insert(s.roleAssignment).values({
      id: newId(),
      accountId: id,
      roleId: roleIds[roleName]!,
      scopeType: roleName === 'staff' ? 'branch' : 'operator',
      scopeId: roleName === 'staff' ? central : operatorId,
    });
  }
  return id;
}

beforeAll(async () => {
  const { url, drop } = await createTestDatabase({ otoapp: true });
  const pool = new pg.Pool({ connectionString: url });
  db = drizzle(pool, { schema }) as Db;
  close = async () => {
    await pool.end();
    await drop();
  };

  operatorId = newId();
  await db.insert(s.operator).values({ id: operatorId, name: 'OTO' });
  central = newId();
  chalong = newId();
  await db.insert(s.branch).values([
    { id: central, operatorId, name: 'Central', code: 'hkt-central' },
    { id: chalong, operatorId, name: 'Chalong', code: 'robinson-chalong' },
  ]);
  for (const name of ['platform_admin', 'operator_admin', 'branch_manager', 'staff']) {
    roleIds[name] = newId();
    await db.insert(s.role).values({ id: roleIds[name]!, name, isSystem: true, operatorId: null });
  }
  actorId = await platformAccount(PHONES.actor, 'operator_admin');
  staffAccountId = await platformAccount('+66811111099', 'staff');

  // Two park groups: ours (both parks and an app-only Head Office) and one
  // nobody on this platform is anchored in.
  const ours = newId();
  const theirs = newId();
  await db.execute(
    sql`insert into otoapp.tenants (id, name, slug) values (${ours}, 'ZZ ours', 'zz-795-ours'), (${theirs}, 'ZZ theirs', 'zz-795-theirs')`,
  );
  const appOperator = newId();
  await db.execute(sql`insert into otoapp.operators (id, tenant_id, name) values (${appOperator}, ${ours}, 'ZZ app operator')`);
  const [appCentral, appChalong, headOffice, elsewhere] = [newId(), newId(), newId(), newId()];
  await db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id) values
      (${appCentral}, ${ours}, 'Central', '', ${central}),
      (${appChalong}, ${ours}, 'Chalong', '', ${chalong}),
      (${headOffice}, ${ours}, 'Head Office', '', null),
      (${elsewhere}, ${theirs}, 'Elsewhere', '', null)`);

  await access(await appUser('staffA', { role: 'staff', phoneE164: PHONES.staffA, phoneVerified: true }), ours, appCentral);
  await appEmployee('staffA', ours, u.staffA!);
  await mirror('staffA', appEmployees.staffA!, PHONES.staffA);

  // The app's flag says verified, but of a phone_e164 this user does not have:
  // the free-text number given to the account is not what it proves.
  await access(
    await appUser('staffB', { role: 'staff', phoneNumber: PHONES.staffBLocal, phoneVerified: true }),
    ours,
    null,
  );

  await access(await appUser('staffC', { role: 'staff' }), ours, appChalong);
  await appEmployee('staffC', ours, u.staffC!);
  await mirror('staffC', appEmployees.staffC!, PHONES.staffCEmployee);

  await access(await appUser('manager', { role: 'manager', phoneE164: PHONES.manager }), ours, appChalong);
  await access(await appUser('managerAll', { role: 'manager', phoneE164: PHONES.managerAll }), ours, null);
  await access(
    await appUser('managerHeadOffice', { role: 'manager', phoneE164: PHONES.managerHeadOffice }),
    ours,
    headOffice,
  );
  await access(
    await appUser('admin', { role: 'admin', phoneE164: PHONES.admin, mustChangePassword: false, phoneVerified: true }),
    ours,
    appCentral,
  );
  await access(
    await appUser('opAdmin', { role: 'operator_admin', phoneE164: PHONES.opAdmin, operatorId: appOperator }),
    ours,
    appCentral,
  );
  await access(await appUser('advisor', { role: 'advisor', phoneE164: PHONES.advisor }), ours, headOffice);
  await access(await appUser('global', { role: 'global_admin', phoneE164: PHONES.global }), ours, appCentral);
  await access(await appUser('inactive', { role: 'staff', phoneE164: PHONES.inactive, isActive: false }), ours, appCentral);
  await access(await appUser('linked', { role: 'staff', platformUserId: actorId }), ours, appCentral);
  await access(await appUser('identityOnly', { role: 'staff', phoneE164: PHONES.identityOnly }), ours, appCentral);
  await db.insert(s.appIdentity).values({
    id: newId(),
    app: 'oto_app',
    accountId: staffAccountId,
    externalUserId: u.identityOnly!,
    createdBy: actorId,
  });
  await access(await appUser('noPhone', { role: 'staff' }), ours, appCentral);
  await access(await appUser('taken', { role: 'staff', phoneNumber: PHONES.actor }), ours, appCentral);
  await access(await appUser('shared1', { role: 'staff', phoneE164: PHONES.shared }), ours, appCentral);
  await access(await appUser('shared2', { role: 'manager', phoneNumber: PHONES.sharedLocal }), ours, appCentral);
  await access(await appUser('foreign', { role: 'staff', phoneE164: PHONES.foreign }), theirs, elsewhere);
  await access(await appUser('odd', { role: 'supervisor', phoneE164: PHONES.odd }), ours, appCentral);

  await access(await appUser('ambiguous', { role: 'staff', phoneE164: PHONES.ambiguous }), ours, appCentral);
  await appEmployee('ambiguous1', ours, u.ambiguous!);
  await appEmployee('ambiguous2', ours, u.ambiguous!);

  await access(await appUser('held', { role: 'staff', phoneE164: PHONES.held }), ours, appCentral);
  await appEmployee('held', ours, u.held!);
  await platformAccount(PHONES.heldAccount, undefined, await mirror('held', appEmployees.held!, null));

  await access(await appUser('noCopy', { role: 'staff', phoneE164: PHONES.noCopy }), ours, appCentral);
  await appEmployee('noCopy', ours, u.noCopy!);
}, 240_000);

afterAll(async () => {
  await close?.();
  await stopTestServer();
});

const EXPECTED: Record<string, StaffAccountsReport['people'][number]['outcome']> = {
  staffA: 'provision',
  staffB: 'provision',
  staffC: 'provision',
  manager: 'provision',
  managerAll: 'provision',
  managerHeadOffice: 'provision',
  admin: 'provision',
  opAdmin: 'provision',
  advisor: 'provision',
  ambiguous: 'provision',
  noCopy: 'provision',
  global: 'global_admin',
  inactive: 'inactive',
  linked: 'already_linked',
  identityOnly: 'already_linked',
  noPhone: 'no_phone',
  taken: 'phone_taken',
  shared1: 'phone_shared',
  shared2: 'phone_shared',
  foreign: 'other_park_group',
  odd: 'unknown_role',
  held: 'employee_held',
};

const outcomeOf = (r: StaffAccountsReport) =>
  Object.fromEntries(Object.entries(u).map(([key, id]) => [key, r.people.find((p) => p.userId === id)!.outcome]));

const person = (r: StaffAccountsReport, key: string) => r.people.find((p) => p.userId === u[key])!;

describe('SCRUM-795: the role mapping', () => {
  it('is the one reviewed table: staff and advisor the tile alone, manager to branch_manager, the admins operator-wide, global_admin skipped', () => {
    expect(OTO_APP_ROLE_TO_PLATFORM).toEqual({
      staff: { role: null },
      advisor: { role: null },
      manager: { role: 'branch_manager', scope: 'app_branches' },
      admin: { role: 'operator_admin', scope: 'operator' },
      operator_admin: { role: 'operator_admin', scope: 'operator' },
      global_admin: null,
    });
  });
});

describe('SCRUM-795: provisioning the OTO App users', () => {
  let dryRun: StaffAccountsReport;

  it('a dry run writes nothing and gives each person one outcome', async () => {
    const before = await Promise.all([count('account'), count('app_identity'), count('audit_log'), count('role_assignment')]);
    dryRun = await provisionOtoAppStaffAccounts(db, { operatorId, apply: false });
    expect(await Promise.all([count('account'), count('app_identity'), count('audit_log'), count('role_assignment')])).toEqual(before);
    expect(dryRun).toMatchObject({ installed: true, applied: false, read: Object.keys(u).length });
    expect(outcomeOf(dryRun)).toEqual(EXPECTED);
    expect(dryRun.outcomes).toMatchObject({
      provision: 11,
      global_admin: 1,
      inactive: 1,
      already_linked: 2,
      no_phone: 1,
      phone_taken: 1,
      phone_shared: 2,
      other_park_group: 1,
      unknown_role: 1,
      employee_held: 1,
      failed: 0,
    });
    expect(dryRun.globalAdminUserIds).toEqual([u.global]);
    expect(dryRun.eligibleActorIds).toEqual([actorId]);
    expect(dryRun.byAppRole.staff).toMatchObject({ provision: 5, inactive: 1, already_linked: 2, no_phone: 1 });
  });

  it('takes the phone from the user, then the employee copy, and links the copy the app names alone', () => {
    expect(person(dryRun, 'staffA')).toMatchObject({ phoneSource: 'user_phone_e164', employeeLink: 'linked', employeeId: mirrors.staffA });
    expect(person(dryRun, 'staffB')).toMatchObject({ phoneSource: 'user_phone_number', employeeLink: 'none', employeeId: null });
    expect(person(dryRun, 'staffC')).toMatchObject({ phoneSource: 'employee', employeeLink: 'linked', employeeId: mirrors.staffC });
    expect(person(dryRun, 'ambiguous')).toMatchObject({ employeeLink: 'ambiguous', employeeId: null });
    expect(person(dryRun, 'noCopy')).toMatchObject({ employeeLink: 'no_copy', employeeId: null });
    expect(dryRun.phoneSources).toEqual({ user_phone_e164: 9, user_phone_number: 1, employee: 1 });
    expect(dryRun.employeeLinks).toMatchObject({ linked: 2, none: 7, ambiguous: 1, no_copy: 1 });
  });

  it('maps each role to its platform role at the app branches, or operator-wide, and staff and advisor to the tile alone', () => {
    expect(person(dryRun, 'staffA')).toMatchObject({ platformRole: null, branchIds: [] });
    expect(person(dryRun, 'staffB')).toMatchObject({ platformRole: null, branchIds: [] });
    expect(person(dryRun, 'manager')).toMatchObject({ platformRole: 'branch_manager', branchIds: [chalong] });
    // Access to every branch of the park group: each park joined to one of them.
    expect(person(dryRun, 'managerAll')).toMatchObject({ platformRole: 'branch_manager', branchIds: [central, chalong].sort() });
    // Head Office is an app-only branch: the manager's role lands nowhere and they get the tile alone.
    expect(person(dryRun, 'managerHeadOffice')).toMatchObject({ platformRole: 'branch_manager', branchIds: [] });
    expect(person(dryRun, 'admin')).toMatchObject({ platformRole: 'operator_admin', branchIds: [] });
    expect(person(dryRun, 'opAdmin')).toMatchObject({ platformRole: 'operator_admin', branchIds: [] });
    expect(person(dryRun, 'advisor')).toMatchObject({ platformRole: null, branchIds: [] });
    expect(dryRun.tileOnly).toBe(6);
    expect(dryRun.withoutPlatformRole).toBe(1);
    expect(dryRun.roleAssignments).toEqual({ staff: 0, branch_manager: 3, operator_admin: 2 });
  });

  it('carries the forced change the app still owes, and counts a phone verified only where the app proves the user’s own phone_e164', () => {
    const provisioned = Object.keys(EXPECTED).filter((key) => EXPECTED[key] === 'provision');
    for (const key of provisioned) {
      expect(person(dryRun, key), key).toMatchObject({
        mustChangePassword: MUST_CHANGE(key),
        phoneVerified: VERIFIED.has(key),
      });
    }
    expect(dryRun.appForcedChange).toBe(10);
    expect(dryRun.phoneVerification).toEqual({ verified: 2, unverified: 9 });
  });

  it('never carries a phone number or a name in the report', () => {
    const text = JSON.stringify(dryRun);
    for (const phone of Object.values(PHONES)) expect(text).not.toContain(phone);
    expect(text).not.toContain('ZZ Person');
    expect(text).not.toContain('ZZ Employee');
    expect(text).not.toContain('ZZ Copy');
  });

  it('refuses to apply without an administrator to name as the actor', async () => {
    const before = await count('account');
    await expect(provisionOtoAppStaffAccounts(db, { operatorId, apply: true })).rejects.toBeInstanceOf(StaffAccountsRefused);
    await expect(
      provisionOtoAppStaffAccounts(db, { operatorId, apply: true, actorAccountId: staffAccountId }),
    ).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
    expect(await count('account')).toBe(before);
  });

  it('applies: an active account with no password, the link, the stamp, the tile and the mapped role, the forced change carried', async () => {
    const applied = await provisionOtoAppStaffAccounts(db, { operatorId, apply: true, actorAccountId: actorId });
    expect(applied.applied).toBe(true);
    expect(outcomeOf(applied)).toEqual(EXPECTED);

    const [accessRole] = await db
      .select()
      .from(s.role)
      .where(and(eq(s.role.operatorId, operatorId), eq(s.role.name, 'app_access_oto_app')));
    expect(accessRole).toBeTruthy();
    const perms = await db.select().from(s.rolePermission).where(eq(s.rolePermission.roleId, accessRole!.id));
    expect(perms.map((p) => p.permission)).toEqual(['app:oto_app:access']);

    const phoneOf: Record<string, string> = {
      staffA: PHONES.staffA,
      staffB: PHONES.staffB,
      staffC: PHONES.staffCEmployee,
      manager: PHONES.manager,
      managerAll: PHONES.managerAll,
      managerHeadOffice: PHONES.managerHeadOffice,
      admin: PHONES.admin,
      opAdmin: PHONES.opAdmin,
      advisor: PHONES.advisor,
      ambiguous: PHONES.ambiguous,
      noCopy: PHONES.noCopy,
    };
    expect(Object.keys(phoneOf).sort()).toEqual(
      Object.keys(EXPECTED)
        .filter((key) => EXPECTED[key] === 'provision')
        .sort(),
    );
    for (const [key, phone] of Object.entries(phoneOf)) {
      const p = person(applied, key);
      expect(p.accountId, key).toBeTruthy();
      const [acc] = await db.select().from(s.account).where(eq(s.account.id, p.accountId!));
      // FORCED CHANGE: the account owes what the app user owed.
      expect(acc, key).toMatchObject({
        operatorId,
        phone,
        passwordHash: null,
        status: 'active',
        mustChangePassword: MUST_CHANGE(key),
        employeeId: p.employeeId,
      });
      // PHONE VERIFIED: only where the app proves the user's own phone_e164.
      if (VERIFIED.has(key)) expect(acc!.phoneVerifiedAt, key).toBeInstanceOf(Date);
      else expect(acc!.phoneVerifiedAt, key).toBeNull();

      const [identity] = await db.select().from(s.appIdentity).where(eq(s.appIdentity.accountId, p.accountId!));
      expect(identity, key).toMatchObject({ app: 'oto_app', externalUserId: u[key], createdBy: actorId });
      // The stamp, and the app's own forced change left as the app has it.
      const [user] = await db.select().from(otoappUsers).where(eq(otoappUsers.id, u[key]!));
      expect(user, key).toMatchObject({ platformUserId: p.accountId, mustChangePassword: MUST_CHANGE(key) });

      const grants = await db
        .select({ roleId: s.roleAssignment.roleId, scopeType: s.roleAssignment.scopeType, scopeId: s.roleAssignment.scopeId })
        .from(s.roleAssignment)
        .where(eq(s.roleAssignment.accountId, p.accountId!));
      const expected = [
        { roleId: accessRole!.id, scopeType: 'operator', scopeId: operatorId },
        ...(p.platformRole === 'operator_admin'
          ? [{ roleId: roleIds.operator_admin, scopeType: 'operator', scopeId: operatorId }]
          : p.platformRole
            ? p.branchIds.map((b) => ({ roleId: roleIds[p.platformRole!], scopeType: 'branch', scopeId: b }))
            : []),
      ];
      expect(grants, key).toEqual(expect.arrayContaining(expected));
      expect(grants, key).toHaveLength(expected.length);
      if (['staffA', 'staffB', 'staffC', 'advisor', 'ambiguous', 'noCopy', 'managerHeadOffice'].includes(key)) {
        expect(grants, `${key}: the tile alone`).toHaveLength(1);
      }

      const rows = await db
        .select()
        .from(s.auditLog)
        .where(and(eq(s.auditLog.action, 'app_identity.provision'), eq(s.auditLog.entityId, identity!.id)));
      expect(rows, key).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorAccountId: actorId, operatorId, requestId: STAFF_ACCOUNTS_REQUEST_ID });
      expect(rows[0]!.after).toMatchObject({
        accountId: p.accountId,
        externalUserId: u[key],
        passwordSet: false,
        mustChangePassword: MUST_CHANGE(key),
        phoneVerified: VERIFIED.has(key),
      });
      expect(JSON.stringify(rows[0]!.after)).not.toContain(phone);
    }
    expect(applied.appForcedChange).toBe(10);
    expect(applied.phoneVerification).toEqual({ verified: 2, unverified: 9 });

    const assignmentRows = await db
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'role_assignment.create'), eq(s.auditLog.requestId, STAFF_ACCOUNTS_REQUEST_ID)));
    expect(assignmentRows).toHaveLength(5);

    // Nobody skipped was touched.
    for (const key of ['global', 'inactive', 'noPhone', 'taken', 'shared1', 'shared2', 'foreign', 'odd', 'held']) {
      const [user] = await db.select().from(otoappUsers).where(eq(otoappUsers.id, u[key]!));
      expect(user!.platformUserId, key).toBeNull();
    }
  });

  it('a second run finds nothing to do and writes nothing', async () => {
    const before = await Promise.all([count('account'), count('app_identity'), count('audit_log'), count('role_assignment')]);
    const again = await provisionOtoAppStaffAccounts(db, { operatorId, apply: true, actorAccountId: actorId });
    expect(again.outcomes.provision).toBe(0);
    expect(again.outcomes.already_linked).toBe(13);
    expect(await Promise.all([count('account'), count('app_identity'), count('audit_log'), count('role_assignment')])).toEqual(before);
  });
});
