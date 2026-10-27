import { createHash, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, appIdentity, branch, employee, operator, role, roleAssignment, rolePermission, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-646 — the read-only drift comparison on the Analytics page.
 *
 * Pinned to the pause contract: the platform masters branch names
 * (`branchAppMappingForReach`, APP_ONLY intentional); the OTO App masters the
 * employee copy fields and its LEFT archival rule (`otoapp_v.employees` and the
 * anchor rule); accounts are read through the provisioning seam and its
 * ownership checks. Only changed field NAMES leave the server, and an absent,
 * denied or ambiguous source is its own state, never an empty clean report.
 */

const seam = vi.hoisted(() => ({ deny: false }));
vi.mock('../src/services/otoapp-employees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/otoapp-employees')>();
  const { OtoAppSeamNotGrantedError } = await import('../src/services/otoapp-events');
  return {
    ...actual,
    otoAppEmployeesInstalled: async (exec: Parameters<typeof actual.otoAppEmployeesInstalled>[0]) => {
      if (seam.deny) throw new OtoAppSeamNotGrantedError(['SELECT on otoapp_v.employees']);
      return actual.otoAppEmployeesInstalled(exec);
    },
  };
});

const path = '/console/analytics/drift';
type Status = 'clean' | 'drift' | 'absent' | 'denied' | 'ambiguous';
interface Item {
  entity: 'branch' | 'employee' | 'account';
  platformId: string | null;
  externalId: string | null;
  branchId: string | null;
  kind: 'changed' | 'missing' | 'orphan';
  fields: string[];
}
interface Comparison {
  key: 'branch_names' | 'employees' | 'app_accounts';
  master: 'platform' | 'oto_app';
  status: Status;
  reason: string | null;
  requiredPermission: string | null;
  compared: number;
  ambiguous: number;
  withheld: number;
  items: Item[];
}
interface Drift {
  generatedAt: string;
  basis: 'read-only-comparison';
  branchIds: string[];
  omitted: string[];
  comparisons: Comparison[];
}

let ctx: TestContext;
let db: Db;
let appPool: pg.Pool;
let cookie: string;
let actorId: string, own: string, foreign: string;
let parkClean: string, parkDrift: string, parkMissing: string, parkAmb: string, foreignPark: string;
let fullRole: string, analyticsOnly: string;
const tenantOurs = newId();
const tenantShared = newId();
let appClean: string, appDrift: string, headOffice: string;
const ids = {} as Record<'eClean' | 'eNick' | 'eLeft' | 'eMissing' | 'eAmb', string>;
const copies = {} as Record<'cClean' | 'cNick' | 'cLeft' | 'cOrphan' | 'cAmb', string>;
const accounts = {} as Record<'aClean' | 'aUnstamped' | 'aInactive', string>;
const users = {} as Record<'uClean' | 'uUnstamped' | 'uInactive', string>;
const SECRET_NICK = 'ZZ646 app nickname value';
const SECRET_PHONE = '+66912340646';
const DRIFT_APP_NAME = 'ZZ TEST 646D drift, app spelling';

const q = async (text: string, params: unknown[] = []) => (await appPool.query(text, params)).rows;
let phoneSeq = 0;
const nextPhone = () => `+669006460${String(10 + phoneSeq++).padStart(2, '0')}`;

async function appBranch(tenantId: string, name: string, coreBranchId: string | null, status: string | null = null) {
  const id = newId();
  await q(`insert into branches (id, tenant_id, name, address, core_branch_id, core_sync_status) values ($1, $2, $3, 'ZZ 646', $4, $5)`,
    [id, tenantId, name, coreBranchId, status]);
  return id;
}
async function appEmployee(o: { tenantId: string; branchId: string; fullName: string; nickname: string; email: string; phone: string | null; state?: string }) {
  const id = newId();
  await q(`insert into employees (id, tenant_id, branch_id, full_name, nickname, email, phone_e164, employment_state)
    values ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, o.tenantId, o.branchId, o.fullName, o.nickname, o.email, o.phone, o.state ?? 'ACTIVE']);
  return id;
}
async function copy(o: { branchId: string | null; externalId: string; name: string; nickname: string; phone: string | null; email: string }) {
  const id = newId();
  await db.insert(employee).values({ id, operatorId: own, source: 'otoapp', ...o });
  return id;
}
async function appUser(o: { email: string; platformUserId: string | null; isActive?: boolean; appBranchId: string }) {
  const id = newId();
  const password = `${randomBytes(64).toString('hex')}.${randomBytes(16).toString('hex')}`;
  await q(`insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
    values ($1, $2, $3, 'ZZ 646 user', 'staff', $4, false, $5)`, [id, o.email, password, o.isActive ?? true, o.platformUserId]);
  await q(`insert into user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4, 'selected_branches')`,
    [newId(), tenantOurs, id, o.appBranchId]);
  return id;
}
async function linkedAccount(o: { employeeId: string | null; status: 'active' | 'inactive' }) {
  const id = newId();
  await db.insert(account).values({ id, operatorId: own, employeeId: o.employeeId, phone: nextPhone(), status: o.status, phoneVerifiedAt: new Date() });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true, env: { PROCESS_ROLES: 'api' } });
  db = ctx.db;
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [actor] = await db.select({ id: account.id, operatorId: account.operatorId }).from(account).where(eq(account.phone, ADMIN.phone));
  actorId = actor!.id; own = actor!.operatorId;
  const url = (db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 2 });

  foreign = newId(); parkClean = newId(); parkDrift = newId(); parkMissing = newId(); parkAmb = newId(); foreignPark = newId();
  await db.insert(operator).values({ id: foreign, name: 'ZZ TEST 646D foreign operator' });
  await db.insert(branch).values([
    { id: parkClean, operatorId: own, name: 'ZZ TEST 646D clean', code: parkClean },
    { id: parkDrift, operatorId: own, name: 'ZZ TEST 646D drift', code: parkDrift },
    { id: parkMissing, operatorId: own, name: 'ZZ TEST 646D missing', code: parkMissing },
    { id: parkAmb, operatorId: own, name: 'ZZ TEST 646D shared', code: parkAmb },
    { id: foreignPark, operatorId: foreign, name: 'ZZ TEST 646D foreign', code: foreignPark },
  ]);

  await q(`insert into tenants (id, name, slug) values ($1, 'ZZ 646 ours', $2), ($3, 'ZZ 646 shared', $4)`,
    [tenantOurs, `zz-646-ours-${tenantOurs.slice(-6)}`, tenantShared, `zz-646-shared-${tenantShared.slice(-6)}`]);
  appClean = await appBranch(tenantOurs, 'ZZ TEST 646D clean', parkClean, 'SUCCESS');
  appDrift = await appBranch(tenantOurs, DRIFT_APP_NAME, parkDrift, 'SUCCESS');
  headOffice = await appBranch(tenantOurs, 'ZZ TEST 646D Head Office', null, 'APP_ONLY');
  // One park group mapped into two operators: whose people these are has no single answer.
  await appBranch(tenantShared, 'ZZ TEST 646D shared', parkAmb, 'SUCCESS');
  await appBranch(tenantShared, 'ZZ TEST 646D foreign', foreignPark, 'SUCCESS');

  const mail = (label: string) => `zz-646-${label}-${newId().slice(-6)}@example.com`;
  ids.eClean = await appEmployee({ tenantId: tenantOurs, branchId: appClean, fullName: 'ZZ 646 Clean', nickname: 'Clean', email: mail('clean'), phone: null });
  ids.eNick = await appEmployee({ tenantId: tenantOurs, branchId: appDrift, fullName: 'ZZ 646 Nick', nickname: SECRET_NICK, email: mail('nick'), phone: SECRET_PHONE });
  ids.eLeft = await appEmployee({ tenantId: tenantOurs, branchId: appDrift, fullName: 'ZZ 646 Left', nickname: 'Left', email: mail('left'), phone: null, state: 'LEFT' });
  ids.eMissing = await appEmployee({ tenantId: tenantOurs, branchId: appDrift, fullName: 'ZZ 646 Missing', nickname: 'Missing', email: mail('missing'), phone: null });
  const [shared] = await q(`select id from branches where core_branch_id = $1`, [parkAmb]);
  ids.eAmb = await appEmployee({ tenantId: tenantShared, branchId: shared.id as string, fullName: 'ZZ 646 Amb', nickname: 'Amb', email: mail('amb'), phone: null });

  const view = async (id: string) => (await q(`select email from otoapp_v.employees where id = $1`, [id]))[0]!.email as string;
  copies.cClean = await copy({ branchId: parkClean, externalId: ids.eClean, name: 'ZZ 646 Clean', nickname: 'Clean', phone: null, email: await view(ids.eClean) });
  copies.cNick = await copy({ branchId: parkDrift, externalId: ids.eNick, name: 'ZZ 646 Nick', nickname: 'Old nick', phone: '+66912349999', email: await view(ids.eNick) });
  copies.cLeft = await copy({ branchId: parkDrift, externalId: ids.eLeft, name: 'ZZ 646 Left', nickname: 'Left', phone: null, email: await view(ids.eLeft) });
  copies.cOrphan = await copy({ branchId: parkDrift, externalId: `zz-646-gone-${newId()}`, name: 'ZZ 646 Gone', nickname: 'Gone', phone: null, email: mail('gone') });
  copies.cAmb = await copy({ branchId: parkAmb, externalId: ids.eAmb, name: 'ZZ 646 Amb', nickname: 'Amb', phone: null, email: await view(ids.eAmb) });

  accounts.aClean = await linkedAccount({ employeeId: copies.cClean, status: 'active' });
  accounts.aUnstamped = await linkedAccount({ employeeId: copies.cNick, status: 'active' });
  accounts.aInactive = await linkedAccount({ employeeId: copies.cLeft, status: 'inactive' });
  users.uClean = await appUser({ email: mail('u-clean'), platformUserId: accounts.aClean, appBranchId: appClean });
  users.uUnstamped = await appUser({ email: mail('u-unstamped'), platformUserId: null, appBranchId: appDrift });
  users.uInactive = await appUser({ email: mail('u-inactive'), platformUserId: accounts.aInactive, appBranchId: appDrift });
  await db.insert(appIdentity).values([
    { id: newId(), app: 'oto_app', accountId: accounts.aClean, externalUserId: users.uClean, createdBy: actorId },
    { id: newId(), app: 'oto_app', accountId: accounts.aUnstamped, externalUserId: users.uUnstamped, createdBy: actorId },
    { id: newId(), app: 'oto_app', accountId: accounts.aInactive, externalUserId: users.uInactive, createdBy: actorId },
  ]);

  fullRole = newId(); analyticsOnly = newId();
  await db.insert(role).values([
    { id: fullRole, operatorId: own, name: 'ZZ TEST 646D drift reader' },
    { id: analyticsOnly, operatorId: own, name: 'ZZ TEST 646D analytics only' },
  ]);
  await db.insert(rolePermission).values([
    ...(['console:analytics:read', 'analytics:read', 'admin:branch:read', 'admin:account:read', 'admin:role:read'] as const)
      .map(permission => ({ id: newId(), roleId: fullRole, permission })),
    ...(['console:analytics:read', 'analytics:read'] as const).map(permission => ({ id: newId(), roleId: analyticsOnly, permission })),
  ]);
}, 300_000);

afterAll(async () => { try { await appPool?.end(); await ctx?.close(); } finally { await teardownAll(); } });

type Grant = { roleId: string; scopeType: 'operator' | 'branch'; scopeId: string | null };
async function grants(rows: Grant[]) {
  await db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
  if (rows.length) await db.insert(roleAssignment).values(rows.map(row => ({ id: newId(), accountId: actorId, ...row })));
}
const operatorWide = (roleId = fullRole): Grant[] => [{ roleId, scopeType: 'operator', scopeId: own }];
beforeEach(async () => { seam.deny = false; await grants(operatorWide()); });

const get = (query = '', authenticated = true) => ctx.app.inject({ method: 'GET', url: path + query, headers: authenticated ? { cookie } : {} });
async function read(query = ''): Promise<{ body: Drift; text: string }> {
  const response = await get(query);
  expect(response.statusCode, response.body).toBe(200);
  return { body: response.json() as Drift, text: response.body };
}
const comparison = (body: Drift, key: Comparison['key']) => {
  const found = body.comparisons.find(row => row.key === key);
  expect(found, key).toBeDefined();
  return found!;
};

describe('SCRUM-646 read-only drift comparison', () => {
  it('D1 high: the envelope names three comparisons with their master, in a fixed order, and is never cached', async () => {
    const response = await get(`?branches=${parkClean}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json() as Drift;
    expect(Object.keys(body).sort()).toEqual(['basis', 'branchIds', 'comparisons', 'generatedAt', 'omitted']);
    expect(body.basis).toBe('read-only-comparison');
    expect(body.branchIds).toEqual([parkClean]);
    expect(body.comparisons.map(row => [row.key, row.master])).toEqual([
      ['branch_names', 'platform'], ['employees', 'oto_app'], ['app_accounts', 'platform'],
    ]);
  });

  it('D2 high: a clean scope reads clean only after comparing owned copies', async () => {
    const { body } = await read(`?branches=${parkClean}`);
    for (const key of ['branch_names', 'employees', 'app_accounts'] as const) {
      const row = comparison(body, key);
      expect(row, key).toMatchObject({ status: 'clean', reason: null, items: [], ambiguous: 0, withheld: 0 });
      expect(row.compared, key).toBe(1);
    }
  });

  it('D3 high: drift is found per field, and only the changed field names leave the server', async () => {
    const { body, text } = await read(`?branches=${parkDrift},${parkMissing}`);
    const branches = comparison(body, 'branch_names');
    expect(branches.status).toBe('drift');
    expect(branches.items).toEqual(expect.arrayContaining([
      { entity: 'branch', platformId: parkDrift, externalId: appDrift, branchId: parkDrift, kind: 'changed', fields: ['name'] },
      { entity: 'branch', platformId: parkMissing, externalId: null, branchId: parkMissing, kind: 'missing', fields: [] },
    ]));
    expect(branches.items).toHaveLength(2);

    const staff = comparison(body, 'employees');
    expect(staff.status).toBe('drift');
    const byExternal = new Map(staff.items.map(item => [item.externalId, item]));
    expect(byExternal.get(ids.eNick)).toMatchObject({ platformId: copies.cNick, kind: 'changed', fields: ['nickname', 'phone'] });
    expect(byExternal.get(ids.eLeft)).toMatchObject({ platformId: copies.cLeft, kind: 'changed', fields: ['archivedAt'] });
    expect(byExternal.get(ids.eMissing)).toMatchObject({ platformId: null, kind: 'missing', fields: [] });
    const orphan = staff.items.find(item => item.platformId === copies.cOrphan);
    expect(orphan).toMatchObject({ kind: 'orphan', fields: ['archivedAt'] });

    const logins = comparison(body, 'app_accounts');
    expect(logins.status).toBe('drift');
    expect(logins.items).toEqual([{ entity: 'account', platformId: accounts.aUnstamped, externalId: users.uUnstamped,
      branchId: null, kind: 'changed', fields: ['platformUserId'] }]);

    for (const secret of [SECRET_NICK, SECRET_PHONE, '+66912349999', DRIFT_APP_NAME, 'Old nick']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('D4 high: the platform account lifecycle is compared where the native filter shows the account', async () => {
    const { body } = await read();
    const logins = comparison(body, 'app_accounts');
    expect(logins.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ platformId: accounts.aInactive, externalId: users.uInactive, kind: 'changed', fields: ['isActive'] }),
    ]));
  });

  it('D5 high: an app-only Head Office row is intentional and never reported as drift', async () => {
    const { body } = await read();
    const all = body.comparisons.flatMap(row => row.items);
    expect(all.some(item => item.externalId === headOffice)).toBe(false);
  });

  it('D6 high: a park group anchored to two operators is ambiguous, never clean', async () => {
    const { body } = await read(`?branches=${parkAmb}`);
    const staff = comparison(body, 'employees');
    expect(staff).toMatchObject({ status: 'ambiguous', items: [], compared: 0 });
    expect(staff.ambiguous).toBe(1);
    expect(comparison(body, 'branch_names').status).toBe('clean');
  });

  it('D7 high: a denied employee seam is its own state, not an empty clean result', async () => {
    seam.deny = true;
    const { body } = await read(`?branches=${parkClean}`);
    expect(comparison(body, 'employees')).toMatchObject({
      status: 'denied', reason: 'seam_not_granted', compared: 0, items: [],
    });
    expect(comparison(body, 'branch_names').status).toBe('clean');
  });

  it('D8 high: lacking a comparison\'s native read door is denied for that comparison, never clean', async () => {
    await grants(operatorWide(analyticsOnly));
    const { body } = await read(`?branches=${parkDrift}`);
    expect(body.comparisons.map(row => [row.key, row.status, row.reason, row.requiredPermission, row.items.length])).toEqual([
      ['branch_names', 'denied', 'permission', 'admin:branch:read', 0],
      ['employees', 'denied', 'permission', 'admin:account:read', 0],
      ['app_accounts', 'denied', 'permission', 'admin:role:read', 0],
    ]);
  });

  it('D9 high: an absent employee view is absent, not zero drift', async () => {
    await db.execute(sql`alter view otoapp_v.employees rename to employees_zz646`);
    try {
      const { body } = await read(`?branches=${parkDrift}`);
      expect(comparison(body, 'employees')).toMatchObject({ status: 'absent', reason: 'seam_absent', items: [], compared: 0 });
    } finally {
      await db.execute(sql`alter view otoapp_v.employees_zz646 rename to employees`);
    }
  });

  it('D10 high: an absent app branch table makes the branch and account comparisons absent', async () => {
    await db.execute(sql`alter table otoapp.branches rename to branches_zz646`);
    try {
      const { body } = await read(`?branches=${parkDrift}`);
      expect(comparison(body, 'branch_names')).toMatchObject({ status: 'absent', reason: 'seam_absent', items: [] });
      expect(comparison(body, 'app_accounts')).toMatchObject({ status: 'absent', reason: 'seam_absent', items: [] });
    } finally {
      await db.execute(sql`alter table otoapp.branches_zz646 rename to branches`);
    }
  });

  it('D11 high: a branch-scoped reader sees only its park, with other parks fenced out', async () => {
    await grants([{ roleId: fullRole, scopeType: 'branch', scopeId: parkClean }]);
    const { body } = await read();
    expect(body.branchIds).toEqual([parkClean]);
    const all = body.comparisons.flatMap(row => row.items);
    expect(all).toEqual([]);
    expect(comparison(body, 'employees').status).toBe('clean');
    const omitted = await read(`?branches=${parkClean},${parkDrift}`);
    expect(omitted.body.omitted).toEqual([parkDrift]);
  });

  it('D12 high: guards — anonymous 401, no analytics door 403, foreign or unknown park 404, bad query 400', async () => {
    expect((await get('', false)).statusCode).toBe(401);
    await grants([]);
    expect((await get()).statusCode).toBe(403);
    await grants(operatorWide());
    for (const id of [foreignPark, newId()]) expect((await get(`?branches=${id}`)).statusCode).toBe(404);
    for (const query of ['?branches=bad', '?fix=true']) expect((await get(query)).statusCode).toBe(400);
  });

  it('D13 high: reading drift writes nothing on either side', async () => {
    const fingerprint = async () => {
      const tables = ['core.employee', 'core.account', 'core.app_identity', 'core.audit_log', 'otoapp.users', 'otoapp.branches', 'otoapp.employees'];
      const rows = [];
      for (const table of tables) {
        rows.push((await db.execute<{ h: string }>(sql.raw(
          `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${table} x`))).rows[0]!.h);
      }
      return createHash('sha256').update(rows.join(':')).digest('hex');
    };
    const before = await fingerprint();
    await read();
    await read(`?branches=${parkDrift}`);
    expect(await fingerprint()).toBe(before);
  });
});
