import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash as argonHash } from '@node-rs/argon2';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  benefitCredential,
  boothDutyAssignment,
  branch,
  employee,
  opsExpectation,
  opsLast,
  opsRun,
  role,
  roleAssignment,
  station,
  type Db,
} from '@oto/db';
import { createTestDatabase } from '@oto/db/testing';
import { newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { loadEnv } from '../src/env';
import { loadBoothStation } from '../src/services/booth';
import { boothBusinessDate, syncBoothDuty } from '../src/services/booth-duty';
import { buildDefaultJobs, createJobRunner, runWatchdog } from '../src/services/jobs';
import {
  EMPLOYEE_SYNC_CASES,
  OTOAPP_EMPLOYEE_SYNC_JOB,
  OTOAPP_EMPLOYEE_SYNC_RUN,
  runOtoAppEmployeeSync,
  type EmployeeSyncSummary,
} from '../src/services/otoapp-employee-sync';
import {
  listAppEmployees,
  listAppEmployeesByIds,
  otoAppEmployeesInstalled,
} from '../src/services/otoapp-employees';
import { OtoAppSeamNotGrantedError } from '../src/services/otoapp-events';
import type { Tx } from '../src/services/tx';

/**
 * S2-17b round 2 (SCRUM-193 under SCRUM-191) — THE EMPLOYEE MIRROR, proved
 * (docs/progress/plans/otoapp-lift/PLAN.md section 8 round 2; section 5 "the
 * copy" and "the swap"; hazards H2-H7 and H23-H25).
 *
 *  A. H3 — `otoapp_v.employees` carries exactly its allow-list: no pay, tax,
 *     social security, visa, address, birth date, face or PIN column.
 *  B. H24 — the view's `platform_user_id` is the app's own user-to-employee
 *     rule read from the employee's side, over a user_id link, a single email
 *     match, two employees on one email with the phone and the name
 *     tie-breaks, an unresolved tie, and the cases where the app's own answer
 *     is row order (named nobody). Where the app's node_modules are present,
 *     the app itself is asked: for every user, the employee its
 *     `getUserWithBranchAccess` picks is exactly the one whose view row names
 *     that user's account.
 *  C. The copy (`job:otoapp.employee_sync`): the tenant-to-operator anchor
 *     (H4), create with the account link (H23), a foreign link and a clash
 *     raised, adoption (H2) and a conflicting adoption raised, update, a
 *     second run that writes nothing, LEFT archived with the cards revoked and
 *     the scan refused (H6), a rehire restored onto the same row (H25), gone
 *     archived, an unread park group left alone, and an empty app archiving
 *     nobody.
 *  D. H5 — `PATCH /me` refuses the four mirrored fields on a copied row, and
 *     no other route writes them.
 *  E. H24's other reader — the booth roster takes the person's account from
 *     the employee repository: an email-fallback employee is the same account
 *     in both, and somebody linked to nobody is unmatched in both.
 *  F. H7 — the job on Health with its expectation, Health's Run now, a forced
 *     failure on Failures whose Retry succeeds, a missed run raising the
 *     watchdog alert; a role without the grant told what is missing.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APP_PASSWORD = 'zz-r2-password';

let ctx: TestContext;
let db: Db;
let appPool: pg.Pool;
let dbUrl: string;
let admin: string;
let oto: string;
let second: string;
let central: string;
let chalong: string;
let secondBranch: string;

/** Park group A: OTO's, through Central and Chalong. */
const tenantA = newId();
/** Park group B: the second operator's. */
const tenantB = newId();
/** Park group C: mapped to nobody. */
const tenantC = newId();
/** Park group D: mapped into two operators' branches. */
const tenantD = newId();
let appCentral: string;
let appChalong: string;
let appSecond: string;

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> => (await appPool.query<T>(text, params)).rows;

/** The app's own password format: scrypt, 64 bytes, then the salt. */
const scrypt = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

async function appTenant(id: string, label: string): Promise<void> {
  await q(`insert into tenants (id, name, slug) values ($1, $2, $3)`, [
    id,
    `ZZ r2 ${label}`,
    `zz-r2-${label}-${id.slice(-6)}`,
  ]);
}

async function appBranch(opts: {
  tenantId: string;
  name: string;
  coreBranchId?: string | null;
}): Promise<string> {
  const id = newId();
  await q(
    `insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ r2', $4)`,
    [id, opts.tenantId, opts.name, opts.coreBranchId ?? null],
  );
  return id;
}

async function appUser(opts: {
  email: string;
  platformUserId?: string | null;
  phone?: string | null;
  fullName?: string;
}): Promise<string> {
  const id = newId();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_e164, platform_user_id)
     values ($1, $2, $3, $4, 'staff', true, false, $5, $6)`,
    [
      id,
      opts.email,
      scrypt(APP_PASSWORD),
      opts.fullName ?? `ZZ r2 user ${id.slice(-4)}`,
      opts.phone ?? null,
      opts.platformUserId ?? null,
    ],
  );
  return id;
}

async function appEmployee(opts: {
  tenantId: string;
  branchId?: string | null;
  fullName?: string;
  nickname?: string;
  email: string;
  userId?: string | null;
  phone?: string | null;
  employmentState?: string;
}): Promise<string> {
  const id = newId();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, user_id, phone_e164, employment_state)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      opts.tenantId,
      opts.branchId ?? null,
      opts.fullName ?? `ZZ r2 employee ${id.slice(-4)}`,
      opts.nickname ?? 'ZZ',
      opts.email,
      opts.userId ?? null,
      opts.phone ?? null,
      opts.employmentState ?? 'ACTIVE',
    ],
  );
  return id;
}

async function platformBranch(operatorId: string, label: string): Promise<string> {
  const id = newId();
  await db.insert(branch).values({
    id,
    operatorId,
    name: `ZZ r2 ${label}`,
    code: `zz-r2-${label}-${id.slice(-8)}`,
    timezone: 'Asia/Bangkok',
  });
  return id;
}

let phoneSeq = 0;
/** A platform account, optionally with a password to sign in with and an employee row. */
async function platformAccount(opts: {
  operatorId: string;
  employeeId?: string | null;
  password?: string;
}): Promise<{ id: string; phone: string }> {
  const id = newId();
  const phone = `+669000082${String(10 + phoneSeq++).padStart(2, '0')}`;
  await db.insert(account).values({
    id,
    operatorId: opts.operatorId,
    employeeId: opts.employeeId ?? null,
    phone,
    passwordHash: opts.password ? await argonHash(opts.password) : null,
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  return { id, phone };
}

async function platformEmployee(operatorId: string, name: string): Promise<string> {
  const id = newId();
  await db.insert(employee).values({ id, operatorId, name, branchId: null });
  return id;
}

const sync = (): Promise<EmployeeSyncSummary> => runOtoAppEmployeeSync(db);

/** Every copy of one app employee, live or archived. */
const copiesOf = (appId: string) =>
  db.select().from(employee).where(eq(employee.externalId, appId));

const auditsFor = (action: string, entityId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)))
    .orderBy(auditLog.createdAt);

/** The cases raised under `otoapp:employee.sync` since a moment, of one kind. */
const raisedSince = async (since: Date, errorCode: string) =>
  db
    .select()
    .from(opsRun)
    .where(
      and(
        eq(opsRun.kind, 'integration'),
        eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_RUN),
        eq(opsRun.errorCode, errorCode),
        gte(opsRun.startedAt, since),
      ),
    );

/** Everything the copy may write, in one comparable value. */
async function mirrorState(): Promise<Record<string, string | number>> {
  const one = async (table: string) =>
    (
      await db.execute<{ h: string }>(
        sql.raw(
          `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${table} x`,
        ),
      )
    ).rows[0]!.h;
  const audits = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from core.audit_log`)
  ).rows[0]!.n;
  return {
    employees: await one('core.employee'),
    accounts: await one('core.account'),
    cards: await one('promo.benefit_credential'),
    audits,
  };
}

const appEmail = (label: string) => `zz-r2-${label}-${newId().slice(-6)}@example.com`;

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY, OPS_TEST_CONTROLS: 'true' },
  });
  db = ctx.db;
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  oto = await operatorIdByName(db, OTO_OPERATOR_NAME);
  second = await operatorIdByName(db, SECOND_OPERATOR_NAME);
  central = await branchIdByCode(db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(db, CHALONG_BRANCH_CODE);
  secondBranch = await branchIdByCode(db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);

  dbUrl = (db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=otoapp', max: 4 });

  await appTenant(tenantA, 'a');
  await appTenant(tenantB, 'b');
  await appTenant(tenantC, 'c');
  await appTenant(tenantD, 'd');
  appCentral = await appBranch({ tenantId: tenantA, name: 'ZZ r2 Central', coreBranchId: central });
  appChalong = await appBranch({ tenantId: tenantA, name: 'ZZ r2 Chalong', coreBranchId: chalong });
  appSecond = await appBranch({
    tenantId: tenantB,
    name: 'ZZ r2 second',
    coreBranchId: secondBranch,
  });
  await appBranch({ tenantId: tenantC, name: 'ZZ r2 head office C' });
  await appBranch({
    tenantId: tenantD,
    name: 'ZZ r2 D at OTO',
    coreBranchId: await platformBranch(oto, 'd-oto'),
  });
  await appBranch({
    tenantId: tenantD,
    name: 'ZZ r2 D at second',
    coreBranchId: await platformBranch(second, 'd-second'),
  });
}, 300_000);

afterAll(async () => {
  for (const child of children) child.kill();
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// A. H3: the allow-list
// =============================================================================

describe('A. H3 — otoapp_v.employees carries exactly its allow-list', () => {
  it('the exact columns, in order, with the platform branch and the account as uuids and the times zoned', async () => {
    const columns = (
      await db.execute<{ name: string; type: string }>(sql`
        select column_name as name, data_type as type
          from information_schema.columns
         where table_schema = 'otoapp_v' and table_name = 'employees'
         order by ordinal_position`)
    ).rows;
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'tenant_id',
      'otoapp_branch_id',
      'branch_id',
      'full_name',
      'nickname',
      'phone',
      'email',
      'status',
      'employment_state',
      'last_working_day',
      'updated_at',
      'platform_user_id',
    ]);
    const typeOf = Object.fromEntries(columns.map((c) => [c.name, c.type]));
    expect(typeOf).toMatchObject({
      branch_id: 'uuid',
      platform_user_id: 'uuid',
      tenant_id: 'uuid',
      last_working_day: 'timestamp with time zone',
      updated_at: 'timestamp with time zone',
    });
  });

  it('nothing about pay, tax, social security, visa, address, birth, face or PIN', async () => {
    const columns = (
      await db.execute<{ name: string }>(sql`
        select column_name as name from information_schema.columns
         where table_schema = 'otoapp_v' and table_name = 'employees'`)
    ).rows.map((c) => c.name);
    for (const name of columns) {
      expect(name).not.toMatch(
        /pay|salary|wage|rate|allowance|tax|sso|visa|permit|address|birth|dob|face|pin|passport|bank|nationality|thai_name|photo|incentive|probation|merge/,
      );
    }
  });

  it('is a view the app’s migrator made, journalled as 0005 with its snapshot', () => {
    const migrations = fileURLToPath(new URL('../../oto-app/migrations/', import.meta.url));
    const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0005_otoapp_v_employees');
    expect(entry?.idx).toBe(5);
    const before = journal.entries.find((e) => e.idx === 4)!;
    expect(entry!.when).toBeGreaterThan(before.when);
    const text = readFileSync(join(migrations, '0005_otoapp_v_employees.sql'), 'utf8');
    expect(text).toMatch(/CREATE VIEW otoapp_v\.employees AS/);
    expect(text).not.toMatch(/"public"\./);
    expect(text).not.toMatch(/\b(GRANT|DROP|ALTER|INSERT|UPDATE|DELETE)\b/);
    expect(existsSync(join(migrations, 'meta', '0005_snapshot.json'))).toBe(true);
  });
});

// =============================================================================
// B. H24: the app's rule, read from the employee's side
// =============================================================================

describe('B. H24 — the view names the account the app’s own rule links to each employee', () => {
  /** The fixture, by case: the users (with their platform ids) and the employees. */
  const f = {
    userIdLink: { user: '', platform: newId(), employee: '' },
    singleEmail: { user: '', platform: newId(), employee: '' },
    phoneTie: { user: '', platform: newId(), match: '', other: '' },
    nameTie: { user: '', platform: newId(), match: '', other: '' },
    unresolved: { user: '', platform: newId(), a: '', b: '' },
    /** Row order decides in the app: two employees carry one login. */
    twoCarriers: { user: '', platform: newId(), a: '', b: '' },
    /** Row order decides in the app: two employees on the user's phone. */
    phoneBoth: { user: '', platform: newId(), a: '', b: '' },
    nobody: { employee: '' },
    /** The explicit link beats an email match by another user. */
    explicitWins: { linked: '', linkedPlatform: newId(), emailUser: '', emailPlatform: newId(), employee: '' },
    /** Two users reach one employee by email alone. */
    twoByEmail: { a: '', aPlatform: newId(), b: '', bPlatform: newId(), employee: '' },
  };
  const H24_TENANT = newId();

  beforeAll(async () => {
    await appTenant(H24_TENANT, 'h24');
    const at = { tenantId: H24_TENANT };

    // 1. user_id.
    f.userIdLink.user = await appUser({
      email: appEmail('uid-user'),
      platformUserId: f.userIdLink.platform,
    });
    f.userIdLink.employee = await appEmployee({
      ...at,
      email: appEmail('uid-employee'),
      userId: f.userIdLink.user,
    });

    // 2. The only employee on the user's email, in another case.
    const single = appEmail('single');
    f.singleEmail.user = await appUser({ email: single, platformUserId: f.singleEmail.platform });
    f.singleEmail.employee = await appEmployee({ ...at, email: single.toUpperCase() });

    // 3. Two on one email: the user's phone picks one.
    const phoneTie = appEmail('phone-tie');
    f.phoneTie.user = await appUser({
      email: phoneTie,
      phone: '+66810008201',
      platformUserId: f.phoneTie.platform,
    });
    f.phoneTie.match = await appEmployee({ ...at, email: phoneTie, phone: '+66810008201' });
    f.phoneTie.other = await appEmployee({ ...at, email: phoneTie, phone: '+66810008202' });

    // 4. Two on one email, the user with no phone: the full name picks one.
    const nameTie = appEmail('name-tie');
    f.nameTie.user = await appUser({
      email: nameTie,
      fullName: 'ZZ r2 Name Four',
      platformUserId: f.nameTie.platform,
    });
    f.nameTie.other = await appEmployee({ ...at, email: nameTie, fullName: 'ZZ r2 Somebody Else' });
    f.nameTie.match = await appEmployee({ ...at, email: nameTie, fullName: 'ZZ r2 Name Four' });

    // 5. Two on one email, and the user's phone matches neither: unresolved.
    const unresolved = appEmail('unresolved');
    f.unresolved.user = await appUser({
      email: unresolved,
      phone: '+66810008203',
      platformUserId: f.unresolved.platform,
    });
    f.unresolved.a = await appEmployee({ ...at, email: unresolved, phone: '+66810008204' });
    f.unresolved.b = await appEmployee({ ...at, email: unresolved, phone: null });

    // 6. Two employees carry one login: the app takes whichever row comes first.
    f.twoCarriers.user = await appUser({
      email: appEmail('two-carriers'),
      platformUserId: f.twoCarriers.platform,
    });
    f.twoCarriers.a = await appEmployee({ ...at, email: appEmail('carrier-a'), userId: f.twoCarriers.user });
    f.twoCarriers.b = await appEmployee({ ...at, email: appEmail('carrier-b'), userId: f.twoCarriers.user });

    // 7. Two on one email, both on the user's phone: row order again.
    const phoneBoth = appEmail('phone-both');
    f.phoneBoth.user = await appUser({
      email: phoneBoth,
      phone: '+66810008205',
      platformUserId: f.phoneBoth.platform,
    });
    f.phoneBoth.a = await appEmployee({ ...at, email: phoneBoth, phone: '+66810008205' });
    f.phoneBoth.b = await appEmployee({ ...at, email: phoneBoth, phone: '+66810008205' });

    // 8. Linked to nobody.
    f.nobody.employee = await appEmployee({ ...at, email: appEmail('nobody') });

    // 9. The employee's own login, and another user on its email.
    const explicit = appEmail('explicit');
    f.explicitWins.linked = await appUser({
      email: appEmail('explicit-login'),
      platformUserId: f.explicitWins.linkedPlatform,
    });
    f.explicitWins.emailUser = await appUser({
      email: explicit,
      platformUserId: f.explicitWins.emailPlatform,
    });
    f.explicitWins.employee = await appEmployee({
      ...at,
      email: explicit,
      userId: f.explicitWins.linked,
    });

    // 10. Two users, one email in two cases, one employee: neither is named.
    const shared = appEmail('two-by-email');
    f.twoByEmail.a = await appUser({ email: shared, platformUserId: f.twoByEmail.aPlatform });
    f.twoByEmail.b = await appUser({
      email: shared.toUpperCase(),
      platformUserId: f.twoByEmail.bPlatform,
    });
    f.twoByEmail.employee = await appEmployee({ ...at, email: shared });
  });

  const linkOf = async (employeeId: string) =>
    (await listAppEmployeesByIds(db, [employeeId]))[0]?.platformUserId ?? null;

  it('a user_id link, the only employee on an email, and the phone and name tie-breaks', async () => {
    expect(await linkOf(f.userIdLink.employee)).toBe(f.userIdLink.platform);
    expect(await linkOf(f.singleEmail.employee)).toBe(f.singleEmail.platform);
    expect(await linkOf(f.phoneTie.match)).toBe(f.phoneTie.platform);
    expect(await linkOf(f.phoneTie.other)).toBeNull();
    expect(await linkOf(f.nameTie.match)).toBe(f.nameTie.platform);
    expect(await linkOf(f.nameTie.other)).toBeNull();
  });

  it('an unresolved tie and an employee linked to nobody name nobody', async () => {
    expect(await linkOf(f.unresolved.a)).toBeNull();
    expect(await linkOf(f.unresolved.b)).toBeNull();
    expect(await linkOf(f.nobody.employee)).toBeNull();
  });

  it('where the app’s answer is row order, the view guesses nobody', async () => {
    expect(await linkOf(f.twoCarriers.a)).toBeNull();
    expect(await linkOf(f.twoCarriers.b)).toBeNull();
    expect(await linkOf(f.phoneBoth.a)).toBeNull();
    expect(await linkOf(f.phoneBoth.b)).toBeNull();
    expect(await linkOf(f.twoByEmail.employee)).toBeNull();
  });

  it('the explicit link is the person, whoever else reaches the employee by email', async () => {
    expect(await linkOf(f.explicitWins.employee)).toBe(f.explicitWins.linkedPlatform);
  });

  it('one account is named by at most one employee', async () => {
    const all = await listAppEmployees(db);
    const named = all.flatMap((e) => (e.platformUserId ? [e.platformUserId] : []));
    expect(new Set(named).size).toBe(named.length);
  });

  describe.skipIf(!HAS_APP_RUNTIME)('the app itself, asked over HTTP', () => {
    let origin = '';
    beforeAll(async () => {
      origin = await serve({ DEPLOY_ENV: 'local', OTOAPP_JOBS: 'inprocess', DATABASE_URL: dbUrl });
    }, 240_000);

    it('for every user, the employee getUserWithBranchAccess picks is exactly the one whose view row names their account', async () => {
      const users: Array<{ user: string; platform: string }> = [
        { user: f.userIdLink.user, platform: f.userIdLink.platform },
        { user: f.singleEmail.user, platform: f.singleEmail.platform },
        { user: f.phoneTie.user, platform: f.phoneTie.platform },
        { user: f.nameTie.user, platform: f.nameTie.platform },
        { user: f.unresolved.user, platform: f.unresolved.platform },
        { user: f.explicitWins.linked, platform: f.explicitWins.linkedPlatform },
      ];
      const view = await listAppEmployees(db);
      for (const u of users) {
        const [{ email }] = await q<{ email: string }>(`select email from users where id = $1`, [u.user]);
        const picked = await linkedEmployeeOf(origin, email);
        const named = view.filter((e) => e.platformUserId === u.platform).map((e) => e.id);
        expect(named, email).toEqual(picked ? [picked] : []);
      }
    });

    it('where the app answers by row order, it does pick one of the two — and the view names neither', async () => {
      for (const [user, pair] of [
        [f.twoCarriers.user, [f.twoCarriers.a, f.twoCarriers.b]],
        [f.phoneBoth.user, [f.phoneBoth.a, f.phoneBoth.b]],
      ] as const) {
        const [{ email }] = await q<{ email: string }>(`select email from users where id = $1`, [user]);
        expect(pair).toContain(await linkedEmployeeOf(origin, email));
      }
    });
  });
});

// =============================================================================
// C. The copy
// =============================================================================

describe('C. the copy into core.employee', () => {
  /** A person in park group A with their own OTO login and account (no employee record yet). */
  const newcomer = { appId: '', userId: '', accountId: '', phone: '', email: '' };
  /** In park group A, matched by email to a user carrying the second operator's account. */
  const foreign = { appId: '', accountId: '' };
  /** In park group A, whose account already points at an archived platform row. */
  const clash = { appId: '', accountId: '', heldEmployee: '' };
  /** A platform person (with a benefit and a card) whom the app now holds: adopted. */
  const adoptee = { appId: '', userId: '', accountId: '', platformRow: '', credentialId: '', code: '' };
  /** Park group B's person: the second operator's. */
  const bPerson = { appId: '' };
  /** Park group C's and D's: nobody's. */
  const cPerson = { appId: '' };
  const dPerson = { appId: '' };
  let first: EmployeeSyncSummary;
  let firstAt: Date;

  beforeAll(async () => {
    newcomer.email = appEmail('newcomer');
    const acc = await platformAccount({ operatorId: oto, password: 'newcomer-pw-1' });
    newcomer.accountId = acc.id;
    newcomer.phone = acc.phone;
    newcomer.userId = await appUser({ email: newcomer.email, platformUserId: acc.id });
    newcomer.appId = await appEmployee({
      tenantId: tenantA,
      branchId: appCentral,
      fullName: 'ZZ r2 Newcomer Full',
      nickname: 'Newcomer',
      email: newcomer.email,
      userId: newcomer.userId,
      phone: '+66810008210',
    });

    // The app's email match, across park groups, onto another operator's account.
    const foreignEmail = appEmail('foreign');
    foreign.accountId = (await platformAccount({ operatorId: second })).id;
    await appUser({ email: foreignEmail, platformUserId: foreign.accountId });
    foreign.appId = await appEmployee({ tenantId: tenantA, email: foreignEmail });

    clash.heldEmployee = await platformEmployee(oto, 'ZZ r2 held row');
    await db.update(employee).set({ archivedAt: new Date() }).where(eq(employee.id, clash.heldEmployee));
    clash.accountId = (await platformAccount({ operatorId: oto, employeeId: clash.heldEmployee })).id;
    const clashUser = await appUser({ email: appEmail('clash'), platformUserId: clash.accountId });
    clash.appId = await appEmployee({ tenantId: tenantA, email: appEmail('clash-e'), userId: clashUser });

    // A platform person with a benefit and a live card, before the app holds them.
    adoptee.platformRow = await platformEmployee(oto, 'ZZ r2 Adoptee (platform)');
    adoptee.accountId = (await platformAccount({ operatorId: oto, employeeId: adoptee.platformRow })).id;
    const role = await ctx.app.inject({
      method: 'PUT',
      url: `/benefits/profiles/${adoptee.platformRow}`,
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { benefitRole: 'staff', override: null },
    });
    expect(role.statusCode, role.body).toBe(200);
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/benefits/credentials',
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { employeeId: adoptee.platformRow },
    });
    expect(issued.statusCode, issued.body).toBe(200);
    adoptee.credentialId = (issued.json() as { credential: { id: string } }).credential.id;
    const qr = await ctx.app.inject({
      method: 'GET',
      url: `/benefits/credentials/${adoptee.credentialId}/qr`,
      headers: { cookie: admin },
    });
    expect(qr.statusCode, qr.body).toBe(200);
    adoptee.code = (qr.json() as { code: string }).code;
    adoptee.userId = await appUser({ email: appEmail('adoptee'), platformUserId: adoptee.accountId });
    adoptee.appId = await appEmployee({
      tenantId: tenantA,
      branchId: appChalong,
      fullName: 'ZZ r2 Adoptee',
      nickname: 'Adoptee',
      email: appEmail('adoptee-e'),
      userId: adoptee.userId,
    });

    bPerson.appId = await appEmployee({ tenantId: tenantB, branchId: appSecond, email: appEmail('b') });
    cPerson.appId = await appEmployee({ tenantId: tenantC, email: appEmail('c') });
    dPerson.appId = await appEmployee({ tenantId: tenantD, email: appEmail('d') });

    firstAt = new Date(Date.now() - 1_000);
    first = await sync();
  });

  it('H4 — each park group reaches its own operator; unanchored and doubly anchored ones are skipped and named', async () => {
    expect(first.installed).toBe(true);
    const [b] = await copiesOf(bPerson.appId);
    expect(b).toMatchObject({ operatorId: second, source: 'otoapp', branchId: secondBranch });
    for (const nobody of [cPerson.appId, dPerson.appId]) expect(await copiesOf(nobody)).toEqual([]);
    expect(first.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: tenantC, reason: 'no_anchor' }),
        expect.objectContaining({ tenantId: tenantD, reason: 'two_operators' }),
      ]),
    );
    const noAnchor = await raisedSince(firstAt, EMPLOYEE_SYNC_CASES.NO_ANCHOR);
    expect(noAnchor.map((r) => (r.detail as { tenantId: string }).tenantId)).toContain(tenantC);
    const twoOps = await raisedSince(firstAt, EMPLOYEE_SYNC_CASES.TWO_OPERATORS);
    const d = twoOps.find((r) => (r.detail as { tenantId: string }).tenantId === tenantD)!;
    expect((d.detail as { operatorIds: string[] }).operatorIds.sort()).toEqual([oto, second].sort());
    // Park group A's people never reach the second operator.
    const aIds = [newcomer.appId, foreign.appId, clash.appId, adoptee.appId];
    const inSecond = await db
      .select()
      .from(employee)
      .where(and(eq(employee.operatorId, second), inArray(employee.externalId, aIds)));
    expect(inSecond).toEqual([]);
  });

  it('creates a copy, sets the account’s employee in the same pass, and audits both with a system actor', async () => {
    const [copy] = await copiesOf(newcomer.appId);
    expect(copy).toMatchObject({
      operatorId: oto,
      source: 'otoapp',
      name: 'ZZ r2 Newcomer Full',
      nickname: 'Newcomer',
      phone: '+66810008210',
      email: newcomer.email,
      branchId: central,
      archivedAt: null,
    });
    const [created] = await auditsFor('employee.mirror_create', copy!.id);
    expect(created).toMatchObject({ actorAccountId: null, operatorId: oto });
    expect(created!.after).toMatchObject({ externalId: newcomer.appId, source: 'otoapp' });
    const [acc] = await db.select().from(account).where(eq(account.id, newcomer.accountId));
    expect(acc!.employeeId).toBe(copy!.id);
    const [linked] = await auditsFor('account.employee_link', newcomer.accountId);
    expect(linked).toMatchObject({
      actorAccountId: null,
      before: { employeeId: null },
      after: { employeeId: copy!.id, externalId: newcomer.appId },
    });
  });

  it('H23 — an email match outside the anchored operator is no link, and is raised', async () => {
    const [copy] = await copiesOf(foreign.appId);
    expect(copy).toMatchObject({ operatorId: oto, source: 'otoapp' });
    const [acc] = await db.select().from(account).where(eq(account.id, foreign.accountId));
    expect(acc!.employeeId).toBeNull();
    const raised = await raisedSince(firstAt, EMPLOYEE_SYNC_CASES.FOREIGN_ACCOUNT);
    const mine = raised.filter((r) => (r.detail as { externalId: string }).externalId === foreign.appId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ outcome: 'failed', operatorId: oto });
    expect(JSON.stringify(mine[0]!.detail)).not.toContain('@');
  });

  it('H23 — an account already pointing at another employee row keeps it, and the case is raised', async () => {
    const [copy] = await copiesOf(clash.appId);
    expect(copy).toMatchObject({ operatorId: oto, archivedAt: null });
    const [acc] = await db.select().from(account).where(eq(account.id, clash.accountId));
    expect(acc!.employeeId).toBe(clash.heldEmployee);
    const raised = await raisedSince(firstAt, EMPLOYEE_SYNC_CASES.ACCOUNT_CLASH);
    expect(
      raised.find((r) => (r.detail as { externalId: string }).externalId === clash.appId)?.detail,
    ).toMatchObject({ employeeId: copy!.id, accountId: clash.accountId, accountEmployeeId: clash.heldEmployee });
  });

  it('H2 — the person’s own platform row is adopted: same id, benefit and card kept, never duplicated', async () => {
    const copies = await copiesOf(adoptee.appId);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      id: adoptee.platformRow,
      source: 'otoapp',
      name: 'ZZ r2 Adoptee',
      branchId: chalong,
    });
    const [adopted] = await auditsFor('employee.mirror_adopt', adoptee.platformRow);
    expect(adopted).toMatchObject({ actorAccountId: null });
    expect(adopted!.before).toMatchObject({ source: 'platform', externalId: null });
    expect(adopted!.after).toMatchObject({ source: 'otoapp', externalId: adoptee.appId });
    const [card] = await db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.id, adoptee.credentialId));
    expect(card!.revokedAt).toBeNull();
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const scan = await ctx.app.inject({
      method: 'POST',
      url: '/benefits/resolve',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { code: adoptee.code },
    });
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.json()).toMatchObject({ employeeId: adoptee.platformRow, benefitRole: 'staff' });
  });

  it('H2 — a person who already has a copy is not merged with their account’s platform row: raised with both ids', async () => {
    // A copy made while the app linked them to nobody…
    const late = { appId: '', userId: '' };
    late.userId = await appUser({ email: appEmail('late') });
    late.appId = await appEmployee({ tenantId: tenantA, email: appEmail('late-e'), userId: late.userId });
    await sync();
    const [copy] = await copiesOf(late.appId);
    expect(copy).toBeTruthy();
    // …then their login is linked to an account that has a platform row of its own.
    const platformRow = await platformEmployee(oto, 'ZZ r2 Late (platform)');
    const acc = await platformAccount({ operatorId: oto, employeeId: platformRow });
    await q(`update users set platform_user_id = $1 where id = $2`, [acc.id, late.userId]);
    const at = new Date(Date.now() - 1_000);
    await sync();
    expect(await copiesOf(late.appId)).toHaveLength(1);
    const [row] = await db.select().from(employee).where(eq(employee.id, platformRow));
    expect(row).toMatchObject({ source: 'platform', externalId: null, archivedAt: null });
    const [still] = await db.select().from(account).where(eq(account.id, acc.id));
    expect(still!.employeeId).toBe(platformRow);
    const raised = await raisedSince(at, EMPLOYEE_SYNC_CASES.ADOPTION_CONFLICT);
    expect(
      raised.find((r) => (r.detail as { externalId: string }).externalId === late.appId)?.detail,
    ).toMatchObject({ employeeId: copy!.id, accountEmployeeId: platformRow, accountId: acc.id });
  });

  it('follows a change made in the app, and audits it with what it was', async () => {
    await q(
      `update employees set nickname = 'Newbie', phone_e164 = '+66810008211', branch_id = $2 where id = $1`,
      [newcomer.appId, appChalong],
    );
    const res = await sync();
    expect(res.updated).toBeGreaterThanOrEqual(1);
    const [copy] = await copiesOf(newcomer.appId);
    expect(copy).toMatchObject({ nickname: 'Newbie', phone: '+66810008211', branchId: chalong });
    const updates = await auditsFor('employee.mirror_update', copy!.id);
    expect(updates.at(-1)).toMatchObject({
      actorAccountId: null,
      before: { nickname: 'Newcomer', phone: '+66810008210', branchId: central },
      after: { nickname: 'Newbie', phone: '+66810008211', branchId: chalong, externalId: newcomer.appId },
    });
  });

  it('a second run with nothing changed in the app changes nothing', async () => {
    await sync();
    const before = await mirrorState();
    const again = await sync();
    expect(again).toMatchObject({
      created: 0,
      adopted: 0,
      updated: 0,
      archived: 0,
      restored: 0,
      accountsLinked: 0,
      cardsRevoked: 0,
    });
    expect(await mirrorState()).toEqual(before);
  });

  it('H6 — LEFT in the app: archived, the live card revoked by the system, the scan refused, gone from the panel', async () => {
    await q(`update employees set employment_state = 'LEFT', last_working_day = now() where id = $1`, [
      adoptee.appId,
    ]);
    const res = await sync();
    expect(res.archived).toBeGreaterThanOrEqual(1);
    const [copy] = await copiesOf(adoptee.appId);
    expect(copy!.archivedAt).not.toBeNull();
    const [archived] = await auditsFor('employee.mirror_archive', adoptee.platformRow);
    expect(archived).toMatchObject({ actorAccountId: null, after: { reason: 'left', externalId: adoptee.appId } });
    const [card] = await db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.id, adoptee.credentialId));
    expect(card!.revokedAt).not.toBeNull();
    expect(card!.revokedByAccountId).toBeNull();
    const [revoke] = await auditsFor('benefit.credential_revoke', adoptee.credentialId);
    expect(revoke).toMatchObject({ actorAccountId: null, after: { reason: 'employee_left' } });
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const scan = await ctx.app.inject({
      method: 'POST',
      url: '/benefits/resolve',
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { code: adoptee.code },
    });
    expect(scan.statusCode).toBe(409);
    expect(scan.json().error.code).toBe('BENEFIT_REVOKED');
    const panel = await ctx.app.inject({ method: 'GET', url: '/benefits/profiles', headers: { cookie: admin } });
    const ids = (panel.json() as { staff: Array<{ employeeId: string }> }).staff.map((s) => s.employeeId);
    expect(ids).not.toContain(adoptee.platformRow);
  });

  it('H25 — a rehire takes back the same row, the old card stays revoked, and a new card can be issued', async () => {
    await q(`update employees set employment_state = 'ACTIVE', last_working_day = null where id = $1`, [
      adoptee.appId,
    ]);
    const res = await sync();
    expect(res.restored).toBeGreaterThanOrEqual(1);
    const copies = await copiesOf(adoptee.appId);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ id: adoptee.platformRow, archivedAt: null });
    const [restored] = await auditsFor('employee.mirror_restore', adoptee.platformRow);
    expect(restored).toMatchObject({ actorAccountId: null, after: { archivedAt: null, externalId: adoptee.appId } });
    const [old] = await db
      .select()
      .from(benefitCredential)
      .where(eq(benefitCredential.id, adoptee.credentialId));
    expect(old!.revokedAt).not.toBeNull();
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/benefits/credentials',
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { employeeId: adoptee.platformRow },
    });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((issued.json() as { credential: { id: string } }).credential.id).not.toBe(adoptee.credentialId);
    // And a second run: still one row, nothing written.
    const before = await mirrorState();
    await sync();
    expect(await mirrorState()).toEqual(before);
  });

  it('gone from the app: archived as gone', async () => {
    const goner = await appEmployee({ tenantId: tenantA, email: appEmail('goner') });
    await sync();
    const [copy] = await copiesOf(goner);
    expect(copy!.archivedAt).toBeNull();
    await q(`delete from employees where id = $1`, [goner]);
    await sync();
    const [after] = await copiesOf(goner);
    expect(after!.archivedAt).not.toBeNull();
    const [archived] = await auditsFor('employee.mirror_archive', after!.id);
    expect(archived!.after).toMatchObject({ reason: 'gone', externalId: goner });
  });

  it('a park group that could not be read this run keeps its copies exactly as they are', async () => {
    const tenantE = newId();
    await appTenant(tenantE, 'e');
    const parkE = await platformBranch(oto, 'e');
    const appE = await appBranch({ tenantId: tenantE, name: 'ZZ r2 E', coreBranchId: parkE });
    const ePerson = await appEmployee({ tenantId: tenantE, branchId: appE, email: appEmail('e') });
    await sync();
    const [copy] = await copiesOf(ePerson);
    expect(copy).toMatchObject({ operatorId: oto, archivedAt: null });
    // Its only mapping is taken away: park group E is anchored to nobody now.
    await q(`update branches set core_branch_id = null where id = $1`, [appE]);
    const res = await sync();
    expect(res.skipped.map((s) => s.tenantId)).toContain(tenantE);
    const [still] = await copiesOf(ePerson);
    expect(still!.archivedAt).toBeNull();
  });
});

// =============================================================================
// D. H5: the mirrored fields are the app's
// =============================================================================

describe('D. H5 — PATCH /me refuses the mirrored fields on a copied row', () => {
  it('name, nickname, email and phone are refused in words, and nothing is written', async () => {
    const email = appEmail('me');
    const acc = await platformAccount({ operatorId: oto, password: 'me-copied-pw-1' });
    // Somebody may sign in only with a role at a branch.
    const [staffRole] = await db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.name, 'staff'), isNull(role.operatorId)))
      .limit(1);
    await db.insert(roleAssignment).values({
      id: newId(),
      accountId: acc.id,
      roleId: staffRole!.id,
      scopeType: 'branch',
      scopeId: central,
    });
    const user = await appUser({ email, platformUserId: acc.id });
    const appId = await appEmployee({ tenantId: tenantA, email, userId: user, nickname: 'Mirror' });
    await sync();
    const [copy] = await copiesOf(appId);
    const cookie = await signInAs(ctx.app, acc.phone, 'me-copied-pw-1');
    for (const body of [
      { name: 'Edited' },
      { nickname: 'Edited' },
      { email: 'edited@example.com' },
      { phone: '0810008299' },
      { name: 'Edited', nickname: 'Edited' },
    ]) {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: '/me',
        headers: { cookie, 'idempotency-key': newId() },
        payload: body,
      });
      expect(res.statusCode, JSON.stringify(body)).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'EMPLOYEE_KEPT_IN_OTO_APP',
        details: { fields: Object.keys(body) },
      });
      expect(res.json().error.message).toMatch(/kept in the OTO App/);
    }
    const [after] = await db.select().from(employee).where(eq(employee.id, copy!.id));
    expect(after).toEqual(copy);
    expect(await auditsFor('me.update', copy!.id)).toEqual([]);
  });

  it('a platform row is still the owner’s to edit', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { nickname: 'Anan' },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('no other route writes an employee row: only PATCH /me (which refuses a copy) and the copy itself', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : /\.ts$/.test(name) ? [path] : [];
      });
    const writers = walk(src)
      .filter((path) => /\.update\(\s*employee\s*\)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(src, path).split('\\').join('/'))
      .sort();
    expect(writers).toEqual(['routes/me.ts', 'services/otoapp-employee-sync.ts']);
  });
});

// =============================================================================
// E. H24's other reader: the booth roster
// =============================================================================

describe('E. H24 — the booth roster and the copy name one account for one person', () => {
  it('an email-fallback employee is the same account in both; one linked to nobody is unmatched in both', async () => {
    const [booth] = await db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
    const row = await loadBoothStation(db, booth!.operatorId, booth!.id);
    const appBooth = row.branchId === central ? appCentral : row.branchId === chalong ? appChalong : null;
    expect(appBooth, 'the booth is at one of park group A’s parks').not.toBeNull();
    const today = await boothBusinessDate(db, row.branchId);
    const weekPlan = newId();
    await q(`insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)`, [
      weekPlan,
      tenantA,
      appBooth,
      today,
    ]);
    const group = newId();
    await q(`insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, 'Sale Booth')`, [
      group,
      tenantA,
      appBooth,
    ]);
    const shiftRow = newId();
    await q(
      `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time)
       values ($1, $2, $3, $4, $5, '10:00', '19:00')`,
      [shiftRow, tenantA, appBooth, group, weekPlan],
    );
    const onShift = async (employeeId: string) =>
      q(
        `insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, employee_id)
         values ($1, $2, $3, $4, $5, 'employee', $6)`,
        [newId(), tenantA, weekPlan, shiftRow, today, employeeId],
      );

    // Linked by the app's email match alone: no user_id.
    const email = appEmail('booth-fallback');
    const acc = await platformAccount({ operatorId: oto });
    await appUser({ email, platformUserId: acc.id });
    const fallback = await appEmployee({
      tenantId: tenantA,
      branchId: appBooth,
      email,
      fullName: 'ZZ r2 Fallback Full',
      nickname: 'Fallback',
    });
    // Linked to nobody.
    const loner = await appEmployee({
      tenantId: tenantA,
      branchId: appBooth,
      email: appEmail('booth-loner'),
      fullName: 'ZZ r2 Loner Full',
      nickname: 'Loner',
    });
    await onShift(fallback);
    await onShift(loner);

    const roster = await syncBoothDuty(db, {}, { row, date: today, actorAccountId: null });
    const view = await listAppEmployeesByIds(db, [fallback, loner]);
    const byId = new Map(view.map((v) => [v.id, v.platformUserId]));
    expect(byId.get(fallback)).toBe(acc.id);
    expect(byId.get(loner)).toBeNull();
    expect(roster.roster.map((r) => r.accountId)).toContain(acc.id);
    expect(roster.unmatched).toContainEqual({ name: 'Loner', reason: 'no_app_user' });
    const onRoster = await db
      .select()
      .from(boothDutyAssignment)
      .where(and(eq(boothDutyAssignment.stationId, row.stationId), eq(boothDutyAssignment.businessDate, today)));
    expect(onRoster.filter((r) => r.displayName === 'Fallback').map((r) => r.accountId)).toEqual([acc.id]);

    // And the copy links the same account to the same person.
    await sync();
    const [copy] = await copiesOf(fallback);
    const [linked] = await db.select().from(account).where(eq(account.id, acc.id));
    expect(linked!.employeeId).toBe(copy!.id);
  });
});

// =============================================================================
// F. H7: the copy is watched
// =============================================================================

describe('F. H7 — the job on Health, Run now, a failure on Failures with Retry, a silence alerted', () => {
  const env = () =>
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
      PROCESS_ROLES: 'api,jobs',
    });

  it('is registered every fifteen minutes, and registering it wrote its expectation; the job is on Health', async () => {
    const job = buildDefaultJobs({ db, env: env(), log: ctx.app.log, channels: [] }).find(
      (j) => j.name === OTOAPP_EMPLOYEE_SYNC_JOB,
    );
    expect(job, 'not registered').toBeTruthy();
    expect(job!.intervalSeconds).toBe(900);
    const runner = createJobRunner({ db, env: env(), log: ctx.app.log, channels: [], jobs: [job!] });
    await runner.start();
    await runner.stop();
    const [expectation] = await db
      .select()
      .from(opsExpectation)
      .where(eq(opsExpectation.name, OTOAPP_EMPLOYEE_SYNC_JOB));
    expect(expectation).toMatchObject({ kind: 'job', intervalSeconds: 900, enabled: true });
    const health = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: admin } });
    expect(health.statusCode, health.body).toBe(200);
    const jobs = (health.json() as { jobs: Array<{ name: string }> }).jobs.map((j) => j.name);
    expect(jobs).toContain(OTOAPP_EMPLOYEE_SYNC_JOB);
  });

  it('Health’s Run now: the control runs the copy at once, for the platform administrator only', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/ops/test-controls', headers: { cookie: admin } });
    expect((list.json() as { controls: Array<{ key: string }> }).controls.map((c) => c.key)).toContain(
      'otoapp.employee_sync',
    );
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/ops/test-controls/otoapp.employee_sync',
      headers: { cookie: reception, 'idempotency-key': newId() },
    });
    expect(refused.statusCode).toBe(403);
    // A person added in the app reaches the platform on the press.
    const pressed = await appEmployee({ tenantId: tenantA, email: appEmail('pressed') });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ops/test-controls/otoapp.employee_sync',
      headers: { cookie: admin, 'idempotency-key': newId() },
    });
    // The api under test carries no jobs role unless asked; either answer is honest.
    if (res.statusCode === 409) {
      expect(res.json().error.code).toBe('JOBS_ROLE_ABSENT');
    } else {
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().message).toMatch(/OTO App staff copy ran \(ok\)/);
      expect(await copiesOf(pressed)).toHaveLength(1);
    }
  });

  it('a forced failure lands on Failures, and its Retry runs the copy again once the cause is gone', async () => {
    // A guard on the platform's employee table, made for this test: the next
    // new copy fails, and with it the run.
    await db.execute(sql`
      create or replace function core.zz_r2_refuse_copy() returns trigger language plpgsql as $$
      begin raise exception 'zz r2 forced failure'; end $$`);
    await db.execute(sql`
      create trigger zz_r2_refuse_copy before insert on core.employee
      for each row when (new.name = 'ZZ r2 Forced') execute function core.zz_r2_refuse_copy()`);
    const forced = await appEmployee({ tenantId: tenantA, email: appEmail('forced'), fullName: 'ZZ r2 Forced' });
    const job = buildDefaultJobs({ db, env: env(), log: ctx.app.log, channels: [] }).find(
      (j) => j.name === OTOAPP_EMPLOYEE_SYNC_JOB,
    )!;
    const runner = createJobRunner({ db, env: env(), log: ctx.app.log, channels: [], jobs: [job] });
    try {
      expect(await runner.runJob(OTOAPP_EMPLOYEE_SYNC_JOB, { force: true })).toBe('failed');
      expect(await copiesOf(forced)).toEqual([]);
      const failures = await ctx.app.inject({ method: 'GET', url: '/ops/failures', headers: { cookie: admin } });
      expect(failures.statusCode, failures.body).toBe(200);
      const groups = (failures.json() as { groups: Array<{ name: string; kind: string }> }).groups;
      expect(groups.some((g) => g.name === OTOAPP_EMPLOYEE_SYNC_JOB && g.kind === 'job')).toBe(true);
    } finally {
      await db.execute(sql`drop trigger zz_r2_refuse_copy on core.employee`);
      await db.execute(sql`drop function core.zz_r2_refuse_copy()`);
    }
    const [failed] = await db
      .select()
      .from(opsRun)
      .where(and(eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_JOB), eq(opsRun.outcome, 'failed')))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/ops/runs/${failed!.id}/retry`,
      headers: { cookie: admin, 'idempotency-key': newId() },
    });
    if (retry.statusCode === 409) {
      // An api without the jobs role says so; the runner itself retries.
      expect(retry.json().error.code).toBe('JOBS_ROLE_ABSENT');
      expect(await runner.runJob(OTOAPP_EMPLOYEE_SYNC_JOB, { force: true })).toBe('ok');
    } else {
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ ok: true, outcome: 'ok' });
    }
    expect(await copiesOf(forced)).toHaveLength(1);
  });

  it('a copy that stops raises the watchdog’s missing-run alert', async () => {
    const longAgo = new Date(Date.now() - 3 * 3_600_000);
    await db.update(opsLast).set({ lastOkAt: longAgo }).where(eq(opsLast.name, OTOAPP_EMPLOYEE_SYNC_JOB));
    await db
      .update(opsExpectation)
      .set({ createdAt: longAgo })
      .where(eq(opsExpectation.name, OTOAPP_EMPLOYEE_SYNC_JOB));
    await runWatchdog({ db, env: env(), log: ctx.app.log, channels: [] });
    const alert = await db.execute<{ key: string; status: string }>(
      sql`select key, status from core.alert where key = ${`ops.missing:${OTOAPP_EMPLOYEE_SYNC_JOB}`}`,
    );
    expect(alert.rows.map((r) => r.key)).toEqual([`ops.missing:${OTOAPP_EMPLOYEE_SYNC_JOB}`]);
  });

  it('a role without the post-import grant is told which grant is missing, never answered empty', async () => {
    const role = `r2_reader_${newId().replace(/-/g, '').slice(-12)}`;
    await db.execute(sql.raw(`create role ${role} nologin`));
    const asRole = <T>(work: (tx: Tx) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local role ${role}`));
        return work(tx);
      });
    try {
      const noUsage = await asRole((tx) => otoAppEmployeesInstalled(tx)).catch((e: unknown) => e);
      expect(noUsage).toBeInstanceOf(OtoAppSeamNotGrantedError);
      expect((noUsage as OtoAppSeamNotGrantedError).missing).toEqual(['USAGE on schema otoapp_v']);
      await db.execute(sql.raw(`grant usage on schema otoapp_v to ${role}`));
      const noSelect = await asRole((tx) => listAppEmployees(tx)).catch((e: unknown) => e);
      expect((noSelect as OtoAppSeamNotGrantedError).missing).toEqual(['SELECT on otoapp_v.employees']);
      await db.execute(sql.raw(`grant select on otoapp_v.employees to ${role}`));
      expect((await asRole((tx) => listAppEmployees(tx))).length).toBeGreaterThan(0);
    } finally {
      await db.execute(sql.raw(`drop owned by ${role}`));
      await db.execute(sql.raw(`drop role ${role}`));
    }
  });
});

// =============================================================================
// G. An app that answers nobody: nothing archived (its own database)
// =============================================================================

describe('G. an OTO App that answers no employee at all archives nobody, and says so', () => {
  it('raises the empty answer and keeps every copy live', async () => {
    const own = await createTestContext({ otoapp: true });
    const pool = new pg.Pool({
      connectionString: (own.db as unknown as { $client: pg.Pool }).$client.options.connectionString!,
      options: '-c search_path=otoapp',
    });
    try {
      const op = await operatorIdByName(own.db, OTO_OPERATOR_NAME);
      const park = await branchIdByCode(own.db, CENTRAL_BRANCH_CODE);
      const tenant = newId();
      const appPark = newId();
      const person = newId();
      await pool.query(`insert into tenants (id, name, slug) values ($1, 'ZZ r2 G', 'zz-r2-g')`, [tenant]);
      await pool.query(
        `insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, 'ZZ r2 G', '', $3)`,
        [appPark, tenant, park],
      );
      await pool.query(
        `insert into employees (id, tenant_id, branch_id, full_name, nickname, email) values ($1, $2, $3, 'ZZ r2 G', 'G', 'zz-r2-g@example.com')`,
        [person, tenant, appPark],
      );
      expect(await runOtoAppEmployeeSync(own.db)).toMatchObject({ created: 1 });
      await pool.query(`delete from employees where id = $1`, [person]);
      const at = new Date(Date.now() - 1_000);
      const res = await runOtoAppEmployeeSync(own.db);
      expect(res).toMatchObject({ employees: 0, archived: 0 });
      const [copy] = await own.db.select().from(employee).where(eq(employee.externalId, person));
      expect(copy).toMatchObject({ operatorId: op, archivedAt: null });
      const raised = await own.db
        .select()
        .from(opsRun)
        .where(
          and(
            eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_RUN),
            eq(opsRun.errorCode, EMPLOYEE_SYNC_CASES.EMPTY_SOURCE),
            gte(opsRun.startedAt, at),
          ),
        );
      expect(raised).toHaveLength(1);
    } finally {
      await pool.end();
      await own.close();
    }
  }, 240_000);

  it('a database without the OTO App runs the copy as a no-op that says so', async () => {
    const { url, drop } = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: url });
    try {
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const bare = drizzle(pool) as unknown as Db;
      expect(await otoAppEmployeesInstalled(bare)).toBe(false);
      expect(await runOtoAppEmployeeSync(bare)).toMatchObject({ installed: false, employees: 0 });
    } finally {
      await pool.end();
      await drop();
    }
  }, 240_000);
});

// =============================================================================
// The app's harness, for B
// =============================================================================

const children: ChildProcess[] = [];

async function serve(env: Record<string, string>): Promise<string> {
  const child = spawn(
    process.execPath,
    [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/harness/serve-routes.ts'],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        APP_ENV: 'dev',
        STORAGE_ENV_PREFIX: 'zz-r2',
        OBJECT_STORAGE: 'local',
        OTOAPP_LEGACY_LOGIN: 'true',
        LOG_LEVEL: 'warn',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}:\n${output}`));
    });
  });
}

/** Sign in to the app as this user and read who the app says their employee is. */
async function linkedEmployeeOf(origin: string, email: string): Promise<string | null> {
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, password: APP_PASSWORD }),
  });
  const text = await login.text();
  expect(login.status, `sign-in as ${email}: ${text}`).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const me = await fetch(`${origin}/api/user`, { headers: { cookie } });
  expect(me.status).toBe(200);
  const body = (await me.json()) as { linkedEmployeeId?: string | null };
  return body.linkedEmployeeId ?? null;
}
