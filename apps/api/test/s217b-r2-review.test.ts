import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash as argonHash } from '@node-rs/argon2';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  employee,
  opsExpectation,
  opsLast,
  opsRun,
  role,
  roleAssignment,
  type Db,
} from '@oto/db';
import { benefitQrKeyOf } from '@oto/db/seed';
import { encodeBenefitCredential } from '@oto/box-agent';
import { newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
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
import { benefitsCacheItem, publishBenefitQrKey } from '../src/services/benefit-credentials';
import { buildDefaultJobs, createJobRunner, runWatchdog } from '../src/services/jobs';
import {
  EMPLOYEE_SYNC_CASES,
  OTOAPP_EMPLOYEE_SYNC_JOB,
  OTOAPP_EMPLOYEE_SYNC_RUN,
  runOtoAppEmployeeSync,
  type EmployeeSyncSummary,
} from '../src/services/otoapp-employee-sync';
import { listAppEmployeesByIds } from '../src/services/otoapp-employees';

/**
 * S2-17b round 2 — THE REVIEW, from the attacking side (SCRUM-193 under
 * SCRUM-191; docs/progress/plans/otoapp-lift/PLAN.md section 8 round 2, section
 * 5 "the copy" and "the swap", hazards H2-H7 and H23-H25).
 *
 *  1. ONE PERSON — app user, platform account and employee — through every
 *     turn: hire, edit, LEFT, a replay, rehire, gone, and back under a new app
 *     id with the same login. The mirror never re-points an account: the new
 *     id is raised as a clash, once per run, and a replay writes nothing.
 *  2. TWO PEOPLE, ONE EMAIL, in different cases — in one park group (the
 *     user's phone picks; a moved phone is a clash, never a re-point; an
 *     unresolved tie links nobody) and across two park groups (the email match
 *     lands on the other operator's person: raised, never linked).
 *  3. Every case a run raises is raised ONCE in that run, and the run's own
 *     `raised` count is exactly what Failures received.
 *  4. THE BENEFITS SWAP on a mirrored row — the seeded Nok adopted, renamed in
 *     the app, LEFT and rehired: her 4-coffee override survives every turn,
 *     the archive-revoked card is refused at the counter and listed for every
 *     box, and a rehire's new card resolves with the override.
 *  5. THE JOB RACED — two copies at once make one row per person; two runner
 *     instances on the schedule make one claim; a stale copy is alerted and a
 *     success closes it.
 *  6. THE THREE FLIPPED PINS from the attacking side — typed-id Link across
 *     park groups, by either operator, and the half-made account rolled back;
 *     the collision fence against the OTHER operator too, without fencing a
 *     park group's own collision.
 *  7. H5 and the seams — every raw-SQL shape of an employee write, the
 *     repository grep across every client app, the grant read-back script in
 *     all three grant states, and PATCH /me raced against an adoption (a new
 *     finding, pinned `it.fails`).
 *  8. Over HTTP, the app itself (where its node_modules are present): the
 *     delete doors' two other 404s — an employee of the caller's park group
 *     whose leaving user, or email-matched person, is another park group's —
 *     and the case-variant email the app and the view resolve alike.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);
const DB_DIR = fileURLToPath(new URL('../../../packages/db/', import.meta.url));

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APP_PASSWORD = 'zz-rev-password';

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

/** Park group A: OTO's, through Central. */
const tenantA = newId();
/** Park group B: the second operator's. */
const tenantB = newId();
let appCentral: string;
let appSecond: string;

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> => (await appPool.query<T>(text, params)).rows;

const scrypt = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

const tag = () => newId().replace(/-/g, '').slice(-8);
const appEmail = (label: string) => `zz-rev-${label}-${tag()}@example.com`;

let appPhoneSeq = 0;
const appPhone = () => `+668100083${String(10 + appPhoneSeq++).padStart(2, '0')}`;

async function appTenant(id: string, label: string): Promise<void> {
  await q(`insert into tenants (id, name, slug) values ($1, $2, $3)`, [
    id,
    `ZZ rev ${label}`,
    `zz-rev-${label}-${id.slice(-6)}`,
  ]);
}

async function appBranch(opts: { tenantId: string; name: string; coreBranchId?: string | null }) {
  const id = newId();
  await q(
    `insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ rev', $4)`,
    [id, opts.tenantId, opts.name, opts.coreBranchId ?? null],
  );
  return id;
}

/** An app user; `seats` are branch-access rows (`branchId` null = all of that park group). */
async function appUser(opts: {
  email?: string;
  platformUserId?: string | null;
  phone?: string | null;
  fullName?: string;
  role?: string;
  operatorId?: string | null;
  seats?: Array<{ tenantId: string; branchId: string | null }>;
}): Promise<{ id: string; email: string }> {
  const id = newId();
  const email = opts.email ?? appEmail('user');
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_e164, platform_user_id, operator_id)
     values ($1, $2, $3, $4, $5, true, false, $6, $7, $8)`,
    [
      id,
      email,
      scrypt(APP_PASSWORD),
      opts.fullName ?? `ZZ rev user ${id.slice(-4)}`,
      opts.role ?? 'staff',
      opts.phone ?? null,
      opts.platformUserId ?? null,
      opts.operatorId ?? null,
    ],
  );
  for (const seat of opts.seats ?? []) {
    await q(
      `insert into user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4, $5)`,
      [
        newId(),
        seat.tenantId,
        id,
        seat.branchId,
        seat.branchId ? 'selected_branches' : 'all_branches',
      ],
    );
  }
  return { id, email };
}

async function appEmployee(opts: {
  tenantId: string;
  branchId?: string | null;
  fullName?: string;
  nickname?: string;
  email: string;
  userId?: string | null;
  phone?: string | null;
  personId?: string | null;
  employmentState?: string;
}): Promise<string> {
  const id = newId();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, user_id, phone_e164, person_id, employment_state)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      opts.tenantId,
      opts.branchId ?? null,
      opts.fullName ?? `ZZ rev employee ${id.slice(-4)}`,
      opts.nickname ?? 'ZZ',
      opts.email,
      opts.userId ?? null,
      opts.phone ?? null,
      opts.personId ?? null,
      opts.employmentState ?? 'ACTIVE',
    ],
  );
  return id;
}

/** A person record with its access policy in one park group. */
async function appPerson(email: string, tenantId: string): Promise<string> {
  const id = newId();
  await q(
    `insert into people (id, full_name, email, person_type) values ($1, 'ZZ rev person', $2, 'employee')`,
    [id, email],
  );
  await q(
    `insert into access_policies (tenant_id, person_id, access_level, modules, branch_scope) values ($1, $2, 'staff', '[]'::jsonb, 'ALL')`,
    [tenantId, id],
  );
  return id;
}

let platformPhoneSeq = 0;
async function platformAccount(opts: {
  operatorId: string;
  employeeId?: string | null;
  password?: string;
  phone?: string;
}): Promise<{ id: string; phone: string }> {
  const id = newId();
  const phone = opts.phone ?? `+669000084${String(10 + platformPhoneSeq++).padStart(2, '0')}`;
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

const sync = (): Promise<EmployeeSyncSummary> => runOtoAppEmployeeSync(db);

const copiesOf = (appId: string) =>
  db.select().from(employee).where(eq(employee.externalId, appId));

const accountOf = async (id: string) =>
  (await db.select().from(account).where(eq(account.id, id)))[0]!;

const auditsFor = (action: string, entityId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

type RaisedRow = typeof opsRun.$inferSelect;

/** One run, and exactly what it filed on Failures. */
async function syncCounted(): Promise<{ summary: EmployeeSyncSummary; raised: RaisedRow[] }> {
  const at = new Date();
  const summary = await sync();
  const raised = await db
    .select()
    .from(opsRun)
    .where(
      and(
        eq(opsRun.kind, 'integration'),
        eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_RUN),
        gte(opsRun.startedAt, at),
      ),
    );
  return { summary, raised };
}

/** The cases a run filed for one app employee. */
const casesFor = (raised: RaisedRow[], externalId: string) =>
  raised
    .filter((r) => (r.detail as { externalId?: string } | null)?.externalId === externalId)
    .map((r) => r.errorCode);

/** Everything the copy may write, in one comparable value (cases on Failures excluded). */
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
    profiles: await one('promo.benefit_profile'),
    audits,
  };
}

async function issueCard(employeeId: string): Promise<{ id: string; code: string }> {
  const issued = await ctx.app.inject({
    method: 'POST',
    url: '/benefits/credentials',
    headers: { cookie: admin, 'idempotency-key': newId() },
    payload: { employeeId },
  });
  expect(issued.statusCode, issued.body).toBe(200);
  const id = (issued.json() as { credential: { id: string } }).credential.id;
  const qr = await ctx.app.inject({
    method: 'GET',
    url: `/benefits/credentials/${id}/qr`,
    headers: { cookie: admin },
  });
  expect(qr.statusCode, qr.body).toBe(200);
  return { id, code: (qr.json() as { code: string }).code };
}

async function scan(code: string) {
  const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  return ctx.app.inject({
    method: 'POST',
    url: '/benefits/resolve',
    headers: { cookie: reception, 'idempotency-key': newId() },
    payload: { code },
  });
}

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
  appCentral = await appBranch({
    tenantId: tenantA,
    name: 'ZZ rev Central',
    coreBranchId: central,
  });
  appSecond = await appBranch({
    tenantId: tenantB,
    name: 'ZZ rev second',
    coreBranchId: secondBranch,
  });
}, 300_000);

afterAll(async () => {
  for (const child of children) child.kill();
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// 1. One person through every turn
// =============================================================================

describe('1. one person — app user, platform account, employee — through every turn', () => {
  const p = { user: '', email: '', account: '', appId: '', copy: '', card: { id: '', code: '' } };

  beforeAll(async () => {
    // Somebody else in the app throughout: an app answering nobody at all is
    // the empty-source guard's case (the builder's section G), not "gone".
    await appEmployee({ tenantId: tenantA, email: appEmail('bystander') });
    p.email = appEmail('person');
    p.account = (await platformAccount({ operatorId: oto })).id;
    p.user = (await appUser({ email: p.email, platformUserId: p.account })).id;
  });

  it('hire: one copy, the account given it, nothing raised for them', async () => {
    p.appId = await appEmployee({
      tenantId: tenantA,
      branchId: appCentral,
      fullName: 'ZZ rev Person Hired',
      nickname: 'Hired',
      email: p.email,
      userId: p.user,
    });
    const { raised } = await syncCounted();
    const copies = await copiesOf(p.appId);
    expect(copies).toHaveLength(1);
    p.copy = copies[0]!.id;
    expect(copies[0]).toMatchObject({
      operatorId: oto,
      source: 'otoapp',
      branchId: central,
      archivedAt: null,
    });
    expect((await accountOf(p.account)).employeeId).toBe(p.copy);
    expect(await auditsFor('account.employee_link', p.account)).toHaveLength(1);
    expect(casesFor(raised, p.appId)).toEqual([]);
    const role = await ctx.app.inject({
      method: 'PUT',
      url: `/benefits/profiles/${p.copy}`,
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { benefitRole: 'staff', override: null },
    });
    expect(role.statusCode, role.body).toBe(200);
    p.card = await issueCard(p.copy);
    expect((await scan(p.card.code)).statusCode).toBe(200);
  });

  it('edit in the app (name, nickname, email): followed on the same row, the account untouched, nothing raised', async () => {
    const newEmail = appEmail('person-new');
    await q(
      `update employees set full_name = 'ZZ rev Person Edited', nickname = 'Edited', email = $2 where id = $1`,
      [p.appId, newEmail],
    );
    const { summary, raised } = await syncCounted();
    expect(summary.updated).toBeGreaterThanOrEqual(1);
    const [copy] = await copiesOf(p.appId);
    expect(copy).toMatchObject({
      id: p.copy,
      name: 'ZZ rev Person Edited',
      nickname: 'Edited',
      email: newEmail,
    });
    // The login, not the email, is the link: still the same account, never a second link.
    expect((await accountOf(p.account)).employeeId).toBe(p.copy);
    expect(await auditsFor('account.employee_link', p.account)).toHaveLength(1);
    expect(casesFor(raised, p.appId)).toEqual([]);
  });

  it('LEFT: archived, card revoked and refused, listed for every box; a replay writes nothing and raises nothing for them', async () => {
    await q(
      `update employees set employment_state = 'LEFT', last_working_day = now() where id = $1`,
      [p.appId],
    );
    await sync();
    const [copy] = await copiesOf(p.appId);
    expect(copy!.archivedAt).not.toBeNull();
    const res = await scan(p.card.code);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BENEFIT_REVOKED');
    const cache = await benefitsCacheItem(db, oto, central);
    expect(cache.revokedCredentialIds).toContain(p.card.id);
    expect(cache.revokedEmployeeIds).toContain(p.copy);
    expect(cache.employees.map((e) => e.employeeId)).not.toContain(p.copy);
    // The account still names the archived row: a leaver's account is not re-pointed.
    expect((await accountOf(p.account)).employeeId).toBe(p.copy);

    const before = await mirrorState();
    const { summary, raised } = await syncCounted();
    expect(summary).toMatchObject({
      created: 0,
      adopted: 0,
      updated: 0,
      archived: 0,
      restored: 0,
      accountsLinked: 0,
      cardsRevoked: 0,
    });
    expect(await mirrorState()).toEqual(before);
    expect(casesFor(raised, p.appId)).toEqual([]);
  });

  it('rehire: the same row back, the account still on it, no clash, the old card still refused and a new one resolving', async () => {
    await q(
      `update employees set employment_state = 'ACTIVE', last_working_day = null where id = $1`,
      [p.appId],
    );
    const { summary, raised } = await syncCounted();
    expect(summary.restored).toBeGreaterThanOrEqual(1);
    const copies = await copiesOf(p.appId);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ id: p.copy, archivedAt: null });
    expect((await accountOf(p.account)).employeeId).toBe(p.copy);
    expect(casesFor(raised, p.appId)).toEqual([]);
    expect((await scan(p.card.code)).json().error.code).toBe('BENEFIT_REVOKED');
    const fresh = await issueCard(p.copy);
    expect((await scan(fresh.code)).statusCode).toBe(200);
    const cache = await benefitsCacheItem(db, oto, central);
    expect(cache.revokedEmployeeIds).not.toContain(p.copy);
    expect(cache.revokedCredentialIds).toContain(p.card.id);
    p.card = fresh;
  });

  it('gone from the app, then back under a NEW app id with the same login: a second row, the account NOT re-pointed, a clash raised once per run', async () => {
    await q(`delete from employees where id = $1`, [p.appId]);
    await sync();
    const [gone] = await copiesOf(p.appId);
    expect(gone!.archivedAt).not.toBeNull();
    expect((await scan(p.card.code)).json().error.code).toBe('BENEFIT_REVOKED');

    const again = await appEmployee({
      tenantId: tenantA,
      branchId: appCentral,
      fullName: 'ZZ rev Person Again',
      email: appEmail('person-again'),
      userId: p.user,
    });
    const first = await syncCounted();
    const [newCopy] = await copiesOf(again);
    expect(newCopy).toMatchObject({ operatorId: oto, archivedAt: null });
    expect(newCopy!.id).not.toBe(p.copy);
    // Never guessed: the account keeps the row it had.
    expect((await accountOf(p.account)).employeeId).toBe(p.copy);
    expect(casesFor(first.raised, again)).toEqual([EMPLOYEE_SYNC_CASES.ACCOUNT_CLASH]);
    expect(
      first.raised.find((r) => (r.detail as { externalId?: string }).externalId === again)!.detail,
    ).toMatchObject({ employeeId: newCopy!.id, accountId: p.account, accountEmployeeId: p.copy });

    // A replay: the standing case once more, nothing written.
    const before = await mirrorState();
    const replay = await syncCounted();
    expect(await mirrorState()).toEqual(before);
    expect(casesFor(replay.raised, again)).toEqual([EMPLOYEE_SYNC_CASES.ACCOUNT_CLASH]);
  });

  it('the same login carried by another park group’s employee: the other operator copies them with no link, and raises it', async () => {
    const elsewhere = await appUser({
      email: appEmail('elsewhere'),
      platformUserId: (await platformAccount({ operatorId: oto })).id,
    });
    const bPerson = await appEmployee({
      tenantId: tenantB,
      branchId: appSecond,
      email: appEmail('b-person'),
      userId: elsewhere.id,
    });
    const { raised } = await syncCounted();
    const [copy] = await copiesOf(bPerson);
    expect(copy).toMatchObject({ operatorId: second, archivedAt: null });
    expect(casesFor(raised, bPerson)).toEqual([EMPLOYEE_SYNC_CASES.FOREIGN_ACCOUNT]);
    const row = raised.find((r) => (r.detail as { externalId?: string }).externalId === bPerson)!;
    expect(row.operatorId).toBe(second);
    const [stillNone] = await db
      .select({ employeeId: account.employeeId })
      .from(account)
      .innerJoin(employee, eq(employee.id, account.employeeId))
      .where(eq(employee.externalId, bPerson));
    expect(stillNone).toBeUndefined();
  });
});

// =============================================================================
// 2. Two people, one email
// =============================================================================

describe('2. two people sharing an email in different cases: the mirror never guesses', () => {
  it('in one park group: the phone picks; a moved phone is a clash, not a re-point; an unresolved tie links nobody', async () => {
    const base = `zz-rev-shared-${tag()}`;
    const phone1 = appPhone();
    const phone2 = appPhone();
    const acc = (await platformAccount({ operatorId: oto })).id;
    const user = await appUser({
      email: `${base.slice(0, 1).toUpperCase()}${base.slice(1)}@Example.com`,
      phone: phone1,
      fullName: 'ZZ rev Shared User',
      platformUserId: acc,
    });
    const one = await appEmployee({
      tenantId: tenantA,
      email: `${base.toUpperCase()}@example.com`,
      phone: phone1,
      fullName: 'ZZ rev Shared One',
    });
    const two = await appEmployee({
      tenantId: tenantA,
      email: `${base}@EXAMPLE.COM`,
      phone: phone2,
      fullName: 'ZZ rev Shared Two',
    });

    const view = new Map(
      (await listAppEmployeesByIds(db, [one, two])).map((e) => [e.id, e.platformUserId]),
    );
    expect(view.get(one)).toBe(acc);
    expect(view.get(two)).toBeNull();
    const first = await syncCounted();
    const [c1] = await copiesOf(one);
    const [c2] = await copiesOf(two);
    expect((await accountOf(acc)).employeeId).toBe(c1!.id);
    expect(casesFor(first.raised, one)).toEqual([]);
    expect(casesFor(first.raised, two)).toEqual([]);

    // The user's phone moves to the other: the app now links the other.
    await q(`update users set phone_e164 = $2 where id = $1`, [user.id, phone2]);
    const moved = await syncCounted();
    expect((await accountOf(acc)).employeeId).toBe(c1!.id);
    expect(casesFor(moved.raised, two)).toEqual([EMPLOYEE_SYNC_CASES.ACCOUNT_CLASH]);
    expect(casesFor(moved.raised, one)).toEqual([]);
    expect(await auditsFor('account.employee_link', acc)).toHaveLength(1);
    for (const c of [c1!, c2!]) {
      const [row] = await db.select().from(employee).where(eq(employee.id, c.id));
      expect(row!.archivedAt).toBeNull();
    }

    // No phone, and neither full name: the app answers nobody, and so does the mirror.
    await q(`update users set phone_e164 = null where id = $1`, [user.id]);
    const tie = new Map(
      (await listAppEmployeesByIds(db, [one, two])).map((e) => [e.id, e.platformUserId]),
    );
    expect(tie.get(one)).toBeNull();
    expect(tie.get(two)).toBeNull();
    const before = await mirrorState();
    const unresolved = await syncCounted();
    expect(await mirrorState()).toEqual(before);
    expect(casesFor(unresolved.raised, one)).toEqual([]);
    expect(casesFor(unresolved.raised, two)).toEqual([]);
  });

  it('across two park groups: the email match lands on the other operator’s person — raised there, linked nowhere', async () => {
    const base = `zz-rev-cross-${tag()}`;
    const phone = appPhone();
    const acc = (await platformAccount({ operatorId: oto })).id;
    await appUser({ email: `${base}@example.com`, phone, platformUserId: acc });
    const inA = await appEmployee({
      tenantId: tenantA,
      email: `${base.toUpperCase()}@EXAMPLE.COM`,
      phone: appPhone(),
    });
    const inB = await appEmployee({ tenantId: tenantB, email: `${base}@Example.Com`, phone });
    const { raised } = await syncCounted();
    expect((await copiesOf(inA))[0]).toMatchObject({ operatorId: oto });
    expect((await copiesOf(inB))[0]).toMatchObject({ operatorId: second });
    expect((await accountOf(acc)).employeeId).toBeNull();
    expect(casesFor(raised, inB)).toEqual([EMPLOYEE_SYNC_CASES.FOREIGN_ACCOUNT]);
    expect(casesFor(raised, inA)).toEqual([]);
  });

  it('two users reaching one employee by email alone: the view names neither, the copy links neither, nothing raised', async () => {
    const base = `zz-rev-twousers-${tag()}`;
    const a = (await platformAccount({ operatorId: oto })).id;
    const b = (await platformAccount({ operatorId: oto })).id;
    await appUser({ email: `${base}@example.com`, platformUserId: a });
    await appUser({ email: `${base.toUpperCase()}@example.com`, platformUserId: b });
    const shared = await appEmployee({ tenantId: tenantA, email: `${base}@EXAMPLE.com` });
    const { raised } = await syncCounted();
    expect((await listAppEmployeesByIds(db, [shared]))[0]!.platformUserId).toBeNull();
    expect((await accountOf(a)).employeeId).toBeNull();
    expect((await accountOf(b)).employeeId).toBeNull();
    expect(casesFor(raised, shared)).toEqual([]);
  });
});

describe('2b. the ordinary order of work — HR adds the person in the app first, the suite account comes later', () => {
  /**
   * NOT A DEFECT OF THIS ROUND: the plan's H2 rule ("an adoption that would
   * collide with an existing copied row is refused and raised, not merged"),
   * driven through the order a park actually works in. Pinned so the lander
   * and the owner see what it means: a standing ADOPTION_CONFLICT every
   * quarter-hour, the same person twice on Staff Benefits, and no screen that
   * settles it (no route re-points `account.employee_id`). The Console's
   * "Login users" create sends `employeeName`, which is what makes the
   * platform row (`routes/accounts.ts`), simulated here row for row.
   */
  it('a standing conflict, the person twice on the panel, and nothing merged', async () => {
    const email = appEmail('hr-first');
    const appId = await appEmployee({
      tenantId: tenantA,
      branchId: appCentral,
      email,
      fullName: 'ZZ rev HR First',
    });
    await sync();
    const [copy] = await copiesOf(appId);
    expect(copy).toMatchObject({ source: 'otoapp', archivedAt: null });

    // Later: the account is made on the Console with a name, then linked.
    const platformRow = newId();
    await db.insert(employee).values({ id: platformRow, operatorId: oto, name: 'ZZ rev HR First' });
    const acc = (await platformAccount({ operatorId: oto, employeeId: platformRow })).id;
    await appUser({ email, platformUserId: acc });

    for (let round = 0; round < 2; round += 1) {
      const { raised } = await syncCounted();
      expect(casesFor(raised, appId)).toEqual([EMPLOYEE_SYNC_CASES.ADOPTION_CONFLICT]);
    }
    expect((await accountOf(acc)).employeeId).toBe(platformRow);
    const panel = await ctx.app.inject({
      method: 'GET',
      url: '/benefits/profiles',
      headers: { cookie: admin },
    });
    const staff = (panel.json() as { staff: Array<{ employeeId: string; source: string }> }).staff;
    expect(
      staff
        .filter((s) => s.employeeId === copy!.id || s.employeeId === platformRow)
        .map((s) => s.source)
        .sort(),
    ).toEqual(['otoapp', 'platform']);
  });
});

// =============================================================================
// 3. Raised once per run
// =============================================================================

describe('3. every case a run raises is raised once in that run, and counted', () => {
  it('no case twice in one run, and the run’s `raised` is exactly what Failures received, with no name, email or phone', async () => {
    // A park group anchored to nobody, with two people: one case for the group, not two.
    const tenantN = newId();
    await appTenant(tenantN, 'n');
    await appBranch({ tenantId: tenantN, name: 'ZZ rev N unmapped' });
    await appEmployee({ tenantId: tenantN, email: appEmail('n1') });
    await appEmployee({ tenantId: tenantN, email: appEmail('n2') });
    for (let round = 0; round < 2; round += 1) {
      const { summary, raised } = await syncCounted();
      expect(raised).toHaveLength(summary.raised);
      const keyOf = (r: RaisedRow) => {
        const d = (r.detail ?? {}) as {
          externalId?: string;
          tenantId?: string;
          employeeId?: string;
        };
        return `${r.errorCode}:${d.externalId ?? d.tenantId ?? d.employeeId ?? ''}`;
      };
      const keys = raised.map(keyOf);
      expect(new Set(keys).size, keys.join('\n')).toBe(keys.length);
      expect(keys).toContain(`${EMPLOYEE_SYNC_CASES.NO_ANCHOR}:${tenantN}`);
      for (const r of raised) {
        expect(r).toMatchObject({ outcome: 'failed', kind: 'integration' });
        expect(JSON.stringify(r.detail)).not.toMatch(/@|\+66|ZZ rev/);
      }
    }
  });
});

// =============================================================================
// 4. The benefits swap, on a mirrored row
// =============================================================================

describe('4. the benefits swap on a mirrored row: Nok through adoption, an app rename, LEFT and a rehire', () => {
  let nok = '';
  let nokApp = '';
  let card = { id: '', code: '' };

  const nokOnPanel = async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/benefits/profiles',
      headers: { cookie: admin },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (
      res.json() as {
        staff: Array<{
          employeeId: string;
          name: string;
          source: string;
          current: {
            benefitRole: string | null;
            override: { freeItems?: Array<{ quotaPerPeriod: number }> } | null;
          } | null;
        }>;
      }
    ).staff.find((s) => s.employeeId === nok);
  };

  beforeAll(async () => {
    nok = (
      await db
        .select({ id: employee.id })
        .from(employee)
        .where(and(eq(employee.operatorId, oto), eq(employee.name, 'Nok (Reception)')))
    )[0]!.id;
    const acc = await platformAccount({ operatorId: oto, employeeId: nok, phone: '+66900000003' });
    const email = appEmail('nok');
    await appUser({ email, fullName: 'Nok', platformUserId: acc.id });
    // Linked by the app's email fallback alone, as on staging.
    nokApp = await appEmployee({
      tenantId: tenantA,
      branchId: appCentral,
      fullName: 'Nok',
      nickname: 'Nok',
      email,
    });
  });

  it('adopted: same id, source otoapp, her 4-coffee override intact', async () => {
    const before = await nokOnPanel();
    expect(before).toMatchObject({ source: 'platform' });
    expect(before!.current!.override!.freeItems![0]!.quotaPerPeriod).toBe(4);
    const { summary } = await syncCounted();
    expect(summary.adopted).toBeGreaterThanOrEqual(1);
    const copies = await copiesOf(nokApp);
    expect(copies.map((c) => c.id)).toEqual([nok]);
    const after = await nokOnPanel();
    expect(after).toMatchObject({
      name: 'Nok',
      source: 'otoapp',
      current: { benefitRole: 'staff' },
    });
    expect(after!.current!.override!.freeItems![0]!.quotaPerPeriod).toBe(4);
    card = await issueCard(nok);
    const res = await scan(card.code);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ employeeId: nok, hasOverride: true });
    expect(res.json().profile.freeItems[0].quotaPerPeriod).toBe(4);
  });

  it('renamed in the app: the copy follows, the override does not move', async () => {
    await q(`update employees set full_name = 'Nok R.', nickname = 'Nokky' where id = $1`, [
      nokApp,
    ]);
    await sync();
    const after = await nokOnPanel();
    expect(after).toMatchObject({ name: 'Nok R.', source: 'otoapp' });
    expect(after!.current!.override!.freeItems![0]!.quotaPerPeriod).toBe(4);
    expect((await scan(card.code)).statusCode).toBe(200);
  });

  it('LEFT: off the panel, the card refused at the counter and listed for every box', async () => {
    await q(
      `update employees set employment_state = 'LEFT', last_working_day = now() where id = $1`,
      [nokApp],
    );
    await sync();
    expect(await nokOnPanel()).toBeUndefined();
    const res = await scan(card.code);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BENEFIT_REVOKED');
    const cache = await benefitsCacheItem(db, oto, central);
    expect(cache.revokedCredentialIds).toContain(card.id);
    expect(cache.revokedEmployeeIds).toContain(nok);
    const [revoke] = await auditsFor('benefit.credential_revoke', card.id);
    expect(revoke).toMatchObject({ actorAccountId: null, after: { reason: 'employee_left' } });
  });

  it('rehired: the same id back on the panel with the 4-coffee override; the old card stays refused, a new one resolves with it', async () => {
    await q(
      `update employees set employment_state = 'ACTIVE', last_working_day = null where id = $1`,
      [nokApp],
    );
    await sync();
    const back = await nokOnPanel();
    expect(back).toMatchObject({ name: 'Nok R.', source: 'otoapp' });
    expect(back!.current!.override!.freeItems![0]!.quotaPerPeriod).toBe(4);
    expect((await scan(card.code)).json().error.code).toBe('BENEFIT_REVOKED');
    const fresh = await issueCard(nok);
    const res = await scan(fresh.code);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().profile.freeItems[0].quotaPerPeriod).toBe(4);
    expect((await copiesOf(nokApp)).map((c) => c.id)).toEqual([nok]);
  });

  /**
   * NEW FINDING (low): `POST /benefits/resolve` keeps every answer out of the
   * replay store (`secretResponse: true`, routes/benefits.ts), on the stated
   * ground that "the route writes nothing, so a retry is the same lookup
   * asked again". This round made it write — the unknown-employee case on
   * Failures — so the premise no longer holds: a till retrying a scan with
   * the same Idempotency-Key files the case a second time. Only an
   * operational record is duplicated (no benefit, quota or card), but it is
   * the idempotency rule broken on a route this round moved off the no-write
   * list. A fix keys the filing itself (e.g. one open case per credential id,
   * or the idempotency key in the run's detail) rather than the answer.
   */
  it.fails(
    'H17’s other half replayed: the same scan resent with the same Idempotency-Key files the case once',
    async () => {
      await publishBenefitQrKey(db, ctx.app.env);
      const key = benefitQrKeyOf(PRIVATE_KEY);
      const nobody = newId();
      const code = encodeBenefitCredential(
        { employeeId: nobody, credentialId: newId(), exp: Math.floor(Date.now() / 1000) + 3_600 },
        { kid: key.kid, privateKeyPem: key.privateKeyPem },
      );
      const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
      const idem = newId();
      const send = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/benefits/resolve',
          headers: { cookie: reception, 'idempotency-key': idem },
          payload: { code },
        });
      const first = await send();
      const again = await send();
      expect(first.statusCode).toBe(404);
      expect(again.statusCode).toBe(404);
      const filed = (
        await db
          .select()
          .from(opsRun)
          .where(
            and(
              eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_RUN),
              eq(opsRun.errorCode, EMPLOYEE_SYNC_CASES.UNKNOWN_EMPLOYEE),
            ),
          )
      ).filter((r) => (r.detail as { employeeId?: string }).employeeId === nobody);
      expect(filed).toHaveLength(1);
    },
  );

  it('the flipped todos are honest: none left in the closing audit, and its two new names are real tests', () => {
    const audit = readFileSync(
      fileURLToPath(new URL('./s221-r4-closing-audit.test.ts', import.meta.url)),
      'utf8',
    );
    expect(audit).not.toMatch(/it\.todo\([^)]*(mirror|S2-17b|otoapp:employee\.sync)/);
    for (const name of [
      'check 1 on the OTO App mirror: the four employees read from otoapp_v.employees through otoapp:employee.sync',
      'H17’s other half: a scan for an employee not yet copied raises ops_run kind integration under otoapp:employee.sync',
    ]) {
      expect(audit).toContain(`it('${name}'`);
    }
  });
});

// =============================================================================
// 5. The job raced
// =============================================================================

describe('5. the job raced, replayed and watched', () => {
  const env = () =>
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
      PROCESS_ROLES: 'api,jobs',
    });
  const runner = () => {
    const job = buildDefaultJobs({ db, env: env(), log: ctx.app.log, channels: [] }).find(
      (j) => j.name === OTOAPP_EMPLOYEE_SYNC_JOB,
    )!;
    return createJobRunner({ db, env: env(), log: ctx.app.log, channels: [], jobs: [job] });
  };

  async function newcomers(n: number) {
    const out: Array<{ appId: string; account: string }> = [];
    for (let i = 0; i < n; i += 1) {
      const acc = (await platformAccount({ operatorId: oto })).id;
      const user = await appUser({ email: appEmail(`race-${i}`), platformUserId: acc });
      out.push({
        appId: await appEmployee({
          tenantId: tenantA,
          email: appEmail(`race-e-${i}`),
          userId: user.id,
        }),
        account: acc,
      });
    }
    return out;
  }

  async function oneEach(people: Array<{ appId: string; account: string }>) {
    for (const person of people) {
      const copies = await copiesOf(person.appId);
      expect(copies, person.appId).toHaveLength(1);
      expect(await auditsFor('employee.mirror_create', copies[0]!.id)).toHaveLength(1);
      expect(await auditsFor('account.employee_link', person.account)).toHaveLength(1);
      expect((await accountOf(person.account)).employeeId).toBe(copies[0]!.id);
    }
  }

  it('two copies at once: one row, one create line and one link line per person', async () => {
    const people = await newcomers(4);
    const [a, b] = await Promise.all([sync(), sync()]);
    expect(a.created + b.created).toBe(4);
    await oneEach(people);
  });

  it('two runner instances on the schedule: one claim, one run', async () => {
    const people = await newcomers(2);
    await db
      .update(opsLast)
      .set({ lastStartedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(opsLast.name, OTOAPP_EMPLOYEE_SYNC_JOB));
    const okBefore = (
      await db
        .select()
        .from(opsRun)
        .where(and(eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_JOB), eq(opsRun.outcome, 'ok')))
    ).length;
    const outcomes = await Promise.all([
      runner().runJob(OTOAPP_EMPLOYEE_SYNC_JOB),
      runner().runJob(OTOAPP_EMPLOYEE_SYNC_JOB),
    ]);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'locked' || o === 'not_due')).toHaveLength(1);
    const okAfter = (
      await db
        .select()
        .from(opsRun)
        .where(and(eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_JOB), eq(opsRun.outcome, 'ok')))
    ).length;
    expect(okAfter - okBefore).toBe(1);
    await oneEach(people);
  });

  it('Run now pressed on two instances at once (forced): whatever both claim, nobody is copied twice', async () => {
    const people = await newcomers(3);
    const outcomes = await Promise.all([
      runner().runJob(OTOAPP_EMPLOYEE_SYNC_JOB, { force: true }),
      runner().runJob(OTOAPP_EMPLOYEE_SYNC_JOB, { force: true }),
    ]);
    expect(outcomes).toContain('ok');
    await oneEach(people);
  });

  it('a stale copy is alerted by the watchdog, and the next success closes the alert', async () => {
    // Registering the job is what writes its expectation.
    const registering = runner();
    await registering.start();
    await registering.stop();
    const longAgo = new Date(Date.now() - 3 * 3_600_000);
    await db
      .update(opsLast)
      .set({ lastOkAt: longAgo })
      .where(eq(opsLast.name, OTOAPP_EMPLOYEE_SYNC_JOB));
    await db
      .update(opsExpectation)
      .set({ createdAt: longAgo })
      .where(eq(opsExpectation.name, OTOAPP_EMPLOYEE_SYNC_JOB));
    const key = `ops.missing:${OTOAPP_EMPLOYEE_SYNC_JOB}`;
    const status = async () =>
      (
        await db.execute<{ status: string }>(
          sql`select status from core.alert where key = ${key} order by created_at desc limit 1`,
        )
      ).rows[0]?.status;
    await runWatchdog({ db, env: env(), log: ctx.app.log, channels: [] });
    expect(await status()).toBe('open');
    expect(await runner().runJob(OTOAPP_EMPLOYEE_SYNC_JOB, { force: true })).toBe('ok');
    await runWatchdog({ db, env: env(), log: ctx.app.log, channels: [] });
    expect(await status()).not.toBe('open');
  });
});

// =============================================================================
// 6. The three flipped pins, from the attacking side (1 and 2 here; 3 in 8)
// =============================================================================

describe('6. pin 1 — Link by typed id across park groups, by either operator', () => {
  const link = async (cookie: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie, 'idempotency-key': newId() },
      payload,
    });
  const stampOf = async (userId: string) =>
    (
      await q<{ p: string | null }>(`select platform_user_id::text as p from users where id = $1`, [
        userId,
      ])
    )[0]!.p;
  const identitiesFor = async (userId: string) =>
    (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from core.app_identity where external_user_id = ${userId}`,
      )
    ).rows[0]!.n;

  it('OTO cannot claim park group B’s user, a two-group user, or one with no seat — and a new account made beside the claim is rolled back', async () => {
    const appOperatorB = newId();
    await q(
      `insert into operators (id, tenant_id, name) values ($1, $2, 'ZZ rev app operator B')`,
      [appOperatorB, tenantB],
    );
    const targets = {
      parkB: (await appUser({ seats: [{ tenantId: tenantB, branchId: appSecond }] })).id,
      allOfB: (await appUser({ seats: [{ tenantId: tenantB, branchId: null }] })).id,
      twoGroups: (
        await appUser({
          seats: [
            { tenantId: tenantA, branchId: appCentral },
            { tenantId: tenantB, branchId: appSecond },
          ],
        })
      ).id,
      noSeat: (await appUser({ seats: [] })).id,
      crossSeat: (await appUser({ seats: [{ tenantId: tenantA, branchId: appSecond }] })).id,
      foreignOperatorAdmin: (
        await appUser({
          seats: [{ tenantId: tenantA, branchId: null }],
          role: 'operator_admin',
          operatorId: appOperatorB,
        })
      ).id,
    };
    for (const [why, userId] of Object.entries(targets)) {
      const existing = (await platformAccount({ operatorId: oto })).id;
      const byAccount = await link(admin, { accountId: existing, externalUserId: userId });
      expect(byAccount.statusCode, `${why}: ${byAccount.body}`).toBe(404);
      const phone = `+669000085${String(10 + platformPhoneSeq++).padStart(2, '0')}`;
      const name = `ZZ rev half-made ${why}`;
      const byPhone = await link(admin, { phone, name, externalUserId: userId });
      expect(byPhone.statusCode, `${why}: ${byPhone.body}`).toBe(404);
      expect(await stampOf(userId), why).toBeNull();
      expect(await identitiesFor(userId), why).toBe(0);
      expect(await db.select().from(account).where(eq(account.phone, phone)), why).toEqual([]);
      expect(await db.select().from(employee).where(eq(employee.name, name)), why).toEqual([]);
    }
  });

  it('the second operator cannot claim park group A’s user either; OTO still can', async () => {
    const userA = (await appUser({ seats: [{ tenantId: tenantA, branchId: appCentral }] })).id;
    const secondAdmin = await signInAs(
      ctx.app,
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    const refused = await link(secondAdmin, {
      phone: `+669000086${String(10 + platformPhoneSeq++).padStart(2, '0')}`,
      name: 'ZZ rev second claims A',
      externalUserId: userA,
    });
    expect(refused.statusCode, refused.body).toBe(404);
    expect(await stampOf(userA)).toBeNull();
    const existing = (await platformAccount({ operatorId: oto })).id;
    const ok = await link(admin, { accountId: existing, externalUserId: userA });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await stampOf(userA)).toBe(existing);
  });
});

describe('6. pin 2 — the collision fence holds against the other operator too, and fences nobody’s own collision', () => {
  const open = async (cookie: string, name: string) => {
    const id = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/branches',
      headers: { cookie, 'idempotency-key': newId() },
      payload: { id, name, code: `zz-rev-${id.slice(-8)}`, timezone: 'Asia/Bangkok' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { otoApp: { appBranchId: string | null; mappedBy?: string | null } };
  };
  const coreIdOf = async (appBranchId: string) =>
    (
      await q<{ c: string | null }>(`select core_branch_id as c from branches where id = $1`, [
        appBranchId,
      ])
    )[0]!.c;

  it('a park group whose only tie is a collision with OTO’s Chalong: neither operator takes its rows by name', async () => {
    // Chalong's lower-case row lives in park group A.
    await appBranch({ tenantId: tenantA, name: 'ZZ rev Chalong', coreBranchId: chalong });
    const tenantX = newId();
    await appTenant(tenantX, 'x');
    await appBranch({
      tenantId: tenantX,
      name: 'ZZ rev X claims Chalong',
      coreBranchId: chalong.toUpperCase(),
    });
    const lagoonX = await appBranch({ tenantId: tenantX, name: 'ZZ rev Lagoon X' });
    const kataX = await appBranch({ tenantId: tenantX, name: 'ZZ rev Kata X' });

    const secondAdmin = await signInAs(
      ctx.app,
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    const bySecond = await open(secondAdmin, 'ZZ rev Lagoon X');
    expect(bySecond.otoApp.appBranchId).not.toBe(lagoonX);
    expect(await coreIdOf(lagoonX)).toBeNull();
    const byOto = await open(admin, 'ZZ rev Kata X');
    expect(byOto.otoApp.appBranchId).not.toBe(kataX);
    expect(await coreIdOf(kataX)).toBeNull();
  });

  it('a collision inside OTO’s own park group fences nothing: a new park there is still taken by name', async () => {
    await appBranch({
      tenantId: tenantA,
      name: 'ZZ rev A mis-spells Central',
      coreBranchId: central.toUpperCase(),
    });
    const kataA = await appBranch({ tenantId: tenantA, name: 'ZZ rev Kata A' });
    const opened = await open(admin, 'ZZ rev Kata A');
    expect(opened.otoApp.appBranchId).toBe(kataA);
    expect(await coreIdOf(kataA)).not.toBeNull();
  });
});

// =============================================================================
// 7. H5 and the seams
// =============================================================================

describe('7. H5 and the seams', () => {
  const src = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          if (name === 'node_modules' || name === 'dist') return [];
          return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
        })
      : [];

  it('no employee write in any other shape: no raw update, delete or insert-on-conflict of core.employee, no archive outside the copy', () => {
    const root = src('../src');
    const shapes = [
      /update\s+"?core"?\s*\.\s*"?employee"?\s+set/i,
      /delete\s+from\s+"?core"?\s*\.\s*"?employee"?\b/i,
      /\.delete\(\s*employee\s*\)/,
      /insert\(\s*employee\s*\)[\s\S]{0,400}onConflictDo/,
    ];
    const hits = walk(root).flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return shapes.some((re) => re.test(text)) ? [relative(root, path).split('\\').join('/')] : [];
    });
    expect(hits).toEqual([]);
  });

  it('only the two repositories name otoapp_v in the api, and no client app names it at all', () => {
    const apiSrc = src('../src');
    const api = walk(apiSrc)
      .filter((path) => readFileSync(path, 'utf8').includes('otoapp_v'))
      .map((path) => relative(apiSrc, path).split('\\').join('/'))
      .sort();
    expect(api).toEqual(['services/otoapp-employees.ts', 'services/otoapp-events.ts']);
    for (const app of ['pos', 'console', 'booth', 'launcher']) {
      const dir = src(`../../${app}/src`);
      const named = walk(dir).filter((path) =>
        /otoapp_v|"otoapp"\.|otoapp\.employees/.test(readFileSync(path, 'utf8')),
      );
      expect(named, app).toEqual([]);
    }
  });

  it('the view grants nothing, and the read-back script answers each of the three grant states as the staging note says', async () => {
    const migration = readFileSync(
      src('../../oto-app/migrations/0005_otoapp_v_employees.sql'),
      'utf8',
    );
    expect(migration).not.toMatch(/\bGRANT\b/i);
    const script = 'scripts/otoapp-employee-seam-readback.ts';
    const text = readFileSync(join(DB_DIR, script), 'utf8');
    expect(text).toMatch(/grant usage on schema otoapp_v to <api role>;/);
    expect(text).toMatch(/grant select on otoapp_v\.employees to <api role>;/);

    const roleName = `zz_rev_api_${tag()}`;
    await db.execute(sql.raw(`create role ${roleName} login password 'zz-rev'`));
    const u = new URL(dbUrl);
    u.username = roleName;
    u.password = 'zz-rev';
    const run = () =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [join(DB_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), script],
          {
            cwd: DB_DIR,
            env: { ...process.env, DATABASE_URL: u.toString() },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
        child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
        child.on('exit', (code) => resolve({ code, out }));
      });
    try {
      const none = await run();
      expect(none.code, none.out).toBe(1);
      expect(none.out).toMatch(/lacks USAGE on schema otoapp_v/);
      await db.execute(sql.raw(`grant usage on schema otoapp_v to ${roleName}`));
      const usage = await run();
      expect(usage.code, usage.out).toBe(1);
      expect(usage.out).toMatch(/lacks SELECT on otoapp_v\.employees/);
      await db.execute(sql.raw(`grant select on otoapp_v.employees to ${roleName}`));
      const both = await run();
      expect(both.code, both.out).toBe(0);
      expect(both.out).toMatch(new RegExp(`role ${roleName} reads otoapp_v\\.employees`));
      expect(both.out).not.toMatch(/@/);
    } finally {
      await db.execute(sql.raw(`drop owned by ${roleName}`));
      await db.execute(sql.raw(`drop role ${roleName}`));
    }
  }, 120_000);

  it('PATCH /me with the same values it already holds is still refused on a copy, and an unknown field is refused before it', async () => {
    const acc = await platformAccount({ operatorId: oto, password: 'zz-rev-me-pw-1' });
    const [staffRole] = await db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.name, 'staff'), isNull(role.operatorId)))
      .limit(1);
    await db
      .insert(roleAssignment)
      .values({
        id: newId(),
        accountId: acc.id,
        roleId: staffRole!.id,
        scopeType: 'branch',
        scopeId: central,
      });
    const email = appEmail('me-same');
    const user = await appUser({ email, platformUserId: acc.id });
    const appId = await appEmployee({
      tenantId: tenantA,
      email,
      userId: user.id,
      fullName: 'ZZ rev Me Same',
      nickname: 'Same',
    });
    await sync();
    const [copy] = await copiesOf(appId);
    expect((await accountOf(acc.id)).employeeId).toBe(copy!.id);
    const cookie = await signInAs(ctx.app, acc.phone, 'zz-rev-me-pw-1');
    const same = await ctx.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { cookie, 'idempotency-key': newId() },
      payload: { name: 'ZZ rev Me Same', nickname: 'Same' },
    });
    expect(same.statusCode, same.body).toBe(409);
    expect(same.json().error.code).toBe('EMPLOYEE_KEPT_IN_OTO_APP');
    const branchy = await ctx.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { cookie, 'idempotency-key': newId() },
      payload: { branchId: chalong },
    });
    expect(branchy.statusCode).toBe(400);
    const [after] = await db.select().from(employee).where(eq(employee.id, copy!.id));
    expect(after).toEqual(copy);
  });

  /**
   * NEW FINDING (low): PATCH /me reads `source` on the pool, BEFORE its
   * transaction, and the update inside it does not ask again. An adoption by
   * the copy committing between the two lands the person's own edit on a row
   * that is now the OTO App's — the edit H5 refuses, written anyway, and
   * silently undone by the next copy. Here the adoption is held at exactly
   * that moment with a row lock. The fix is one condition: re-read the row
   * `for update` inside the transaction (or update `where source <> 'otoapp'`)
   * and refuse there.
   */
  it.fails(
    'PATCH /me raced against an adoption never writes a mirrored field onto the adopted row',
    async () => {
      const platformRow = newId();
      await db
        .insert(employee)
        .values({ id: platformRow, operatorId: oto, name: 'ZZ rev Raced', nickname: 'Raced' });
      const acc = await platformAccount({
        operatorId: oto,
        employeeId: platformRow,
        password: 'zz-rev-race-pw-1',
      });
      const [staffRole] = await db
        .select({ id: role.id })
        .from(role)
        .where(and(eq(role.name, 'staff'), isNull(role.operatorId)))
        .limit(1);
      await db
        .insert(roleAssignment)
        .values({
          id: newId(),
          accountId: acc.id,
          roleId: staffRole!.id,
          scopeType: 'branch',
          scopeId: central,
        });
      const cookie = await signInAs(ctx.app, acc.phone, 'zz-rev-race-pw-1');

      const pool = (db as unknown as { $client: pg.Pool }).$client;
      const locker = await pool.connect();
      let res: Awaited<ReturnType<typeof ctx.app.inject>>;
      try {
        await locker.query('begin');
        await locker.query('select 1 from core.employee where id = $1 for update', [platformRow]);
        const pending = ctx.app.inject({
          method: 'PATCH',
          url: '/me',
          headers: { cookie, 'idempotency-key': newId() },
          payload: { nickname: 'Edited on the platform' },
        });
        // Wait until the route has passed its check and is blocked on the row.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const waiting = await db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%update "core"."employee"%'`,
          );
          if (waiting.rows[0]!.n > 0) break;
          if (Date.now() > deadline) throw new Error('PATCH never reached its update');
          await new Promise((r) => setTimeout(r, 25));
        }
        // The copy adopts the row and commits.
        await locker.query(
          `update core.employee set source = 'otoapp', external_id = $2 where id = $1`,
          [platformRow, newId()],
        );
        await locker.query('commit');
        res = await pending;
      } finally {
        locker.release();
      }
      const [row] = await db.select().from(employee).where(eq(employee.id, platformRow));
      expect(row!.source).toBe('otoapp');
      expect(row!.nickname).toBe('Raced');
      expect(res.statusCode).toBe(409);
    },
  );
});

// =============================================================================
// 8. Over HTTP: the app itself
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
        STORAGE_ENV_PREFIX: 'zz-rev',
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

async function send(origin: string, method: string, path: string, cookie?: string, body?: unknown) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON.
  }
  return {
    status: res.status,
    text,
    body: json,
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}

async function appSignIn(origin: string, email: string): Promise<string> {
  const res = await send(origin, 'POST', '/api/login', undefined, {
    identifier: email,
    password: APP_PASSWORD,
  });
  expect(res.status, `sign-in as ${email}: ${res.text}`).toBe(200);
  return res.cookie;
}

describe.skipIf(!HAS_APP_RUNTIME)(
  '8. the app over HTTP: the other two 404s, and a case-variant email',
  () => {
    let origin = '';
    let adminA = '';
    const exists = async (table: string, id: string) =>
      (await q(`select 1 from ${table} where id = $1`, [id])).length === 1;

    beforeAll(async () => {
      origin = await serve({ DEPLOY_ENV: 'local', OTOAPP_JOBS: 'inprocess', DATABASE_URL: dbUrl });
      const a = await appUser({
        seats: [{ tenantId: tenantA, branchId: null }],
        role: 'admin',
        email: appEmail('admin-a'),
      });
      adminA = await appSignIn(origin, a.email);
    }, 240_000);

    it('an employee of the caller’s park group whose leaving user is another park group’s: 404 "User not found" at every door, nothing written', async () => {
      const email = appEmail('leaving-b');
      const person = await appPerson(email, tenantA);
      const userB = await appUser({ email, seats: [{ tenantId: tenantB, branchId: appSecond }] });
      const emp = await appEmployee({
        tenantId: tenantA,
        branchId: appCentral,
        email,
        personId: person,
      });
      const plain = await appEmployee({
        tenantId: tenantA,
        branchId: appCentral,
        email: appEmail('plain'),
      });

      const one = await send(origin, 'DELETE', `/api/employees/${emp}`, adminA);
      expect(one.status, one.text).toBe(404);
      expect(one.body).toEqual({ message: 'User not found' });
      const bulk = await send(origin, 'POST', '/api/employees/bulk-delete', adminA, {
        employeeIds: [emp, plain],
      });
      expect(bulk.status, bulk.text).toBe(200);
      expect(bulk.body).toMatchObject({ deletedCount: 1, errorCount: 1 });
      expect(
        (bulk.body.results as Array<Record<string, string>>).find((r) => r.id === emp),
      ).toEqual({
        id: emp,
        status: 'error',
        message: 'User not found',
      });
      const viaPeople = await send(origin, 'DELETE', `/api/people/${person}`, adminA);
      expect(viaPeople.status, viaPeople.text).toBe(404);
      expect(viaPeople.body).toEqual({ message: 'Person not found' });

      expect(await exists('employees', emp)).toBe(true);
      expect(await exists('people', person)).toBe(true);
      expect(await exists('users', userB.id)).toBe(true);
      expect(
        (await q(`select 1 from user_branch_access where user_id = $1`, [userB.id])).length,
      ).toBe(1);
      expect((await q(`select 1 from access_policies where person_id = $1`, [person])).length).toBe(
        1,
      );
      // The bulk door still did its own park group's plain employee.
      expect(await exists('employees', plain)).toBe(false);
    });

    it('an employee with no person record whose email-matched person is another park group’s: 404 "Person not found", nothing written', async () => {
      const email = appEmail('person-b');
      const personB = await appPerson(email, tenantB);
      const emp = await appEmployee({ tenantId: tenantA, branchId: appCentral, email });
      const one = await send(origin, 'DELETE', `/api/employees/${emp}`, adminA);
      expect(one.status, one.text).toBe(404);
      expect(one.body).toEqual({ message: 'Person not found' });
      const bulk = await send(origin, 'POST', '/api/employees/bulk-delete', adminA, {
        employeeIds: [emp],
      });
      expect(bulk.body).toEqual({
        deletedCount: 0,
        errorCount: 1,
        results: [{ id: emp, status: 'error', message: 'Person not found' }],
      });
      expect(await exists('employees', emp)).toBe(true);
      expect(await exists('people', personB)).toBe(true);
      expect(
        (await q(`select 1 from access_policies where person_id = $1`, [personB])).length,
      ).toBe(1);
    });

    it('a case-variant email on two employees: the app and the view pick the same one, by the user’s phone', async () => {
      const base = `zz-rev-casehttp-${tag()}`;
      const phone = appPhone();
      const acc = newId();
      const user = await appUser({ email: `${base}@Example.com`, phone, platformUserId: acc });
      const pick = await appEmployee({
        tenantId: tenantA,
        email: `${base.toUpperCase()}@EXAMPLE.COM`,
        phone,
      });
      const other = await appEmployee({
        tenantId: tenantA,
        email: `${base}@example.COM`,
        phone: appPhone(),
      });
      const me = await send(origin, 'GET', '/api/user', await appSignIn(origin, user.email));
      expect(me.status, me.text).toBe(200);
      expect(me.body.linkedEmployeeId).toBe(pick);
      const view = new Map(
        (await listAppEmployeesByIds(db, [pick, other])).map((e) => [e.id, e.platformUserId]),
      );
      expect(view.get(pick)).toBe(acc);
      expect(view.get(other)).toBeNull();
    });
  },
);
