import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  employee,
  mapCoreBranchIntoApp,
  otoappBranches,
  otoappUserBranchAccess,
  role,
  rolePermission,
  roleAssignment,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-268 — the platform's branch list and the OTO App's, joined.
 *
 * The seam test beside this one asserts what happens to a PERSON being
 * provisioned. This one asserts the mapping itself, against the shape the park
 * actually has: three rows in the app — Central Floresta, Robinson Chalong and
 * Head Office — two trading branches on the platform, and nothing joining them.
 *
 * Everything here drives the real routes. The app's rows are inserted with SQL
 * because the platform's declaration of that table is narrow on purpose and the
 * app's own `branches` requires an address the platform has no business
 * inventing.
 *
 * Two details of the fixture are the whole point of it:
 *
 *  - **Central Floresta's name carries a trailing space.** That is not a typo
 *    in this file: it is the string in the park's export
 *    (`apps/oto-app/script/sample/data.generated.ts`), and the app's own
 *    importer find-or-creates on it exactly. A mapping that matches on the raw
 *    name never matches that row, which is why the rule is trimmed and folded.
 *  - **Head Office is in the list.** It trades nowhere and is deliberately not
 *    a `core.branch`. A mapping that treats "no platform branch" as a failure
 *    would mark the park's head office broken on every run, for ever.
 */

let ctx: TestContext;
let adminCookie: string;
let managerCookie: string;
let operatorId: string;
let florestaId: string;
let chalongId: string;
/** The app's own tenant. Every one of its branch rows belongs to one. */
let appTenantId: string;

/** The park's three rows, as its export holds them. */
const FLORESTA_APP_NAME = 'Oto Play Park, Central Floresta '; // trailing space: real
const CHALONG_APP_NAME = 'Oto Play Park, Robinson Chalong';
const HEAD_OFFICE_NAME = 'Head Office';

let florestaAppId: string;
let chalongAppId: string;
let headOfficeAppId: string;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  operatorId = await operatorIdByName(ctx.db, 'OTO');
  florestaId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);

  appTenantId = newId();
  await ctx.db.execute(
    sql`insert into otoapp.tenants (id, name, slug) values (${appTenantId}, 'OTO', 'oto')`,
  );
  florestaAppId = await appBranch(FLORESTA_APP_NAME);
  chalongAppId = await appBranch(CHALONG_APP_NAME);
  headOfficeAppId = await appBranch(HEAD_OFFICE_NAME);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** A branch of the OTO App, written as that app's own importer leaves it. */
async function appBranch(name: string, tenantId = appTenantId): Promise<string> {
  const id = newId();
  await ctx.db.execute(
    sql`insert into otoapp.branches (id, tenant_id, name, address)
        values (${id}, ${tenantId}, ${name}, 'A mall in Phuket')`,
  );
  return id;
}

const appRow = async (id: string) =>
  (await ctx.db.select().from(otoappBranches).where(eq(otoappBranches.id, id)))[0]!;

const appRowCount = async (): Promise<number> => (await ctx.db.select().from(otoappBranches)).length;

interface ReconcileReport {
  installed: boolean;
  alreadyMapped: number;
  matchedByName: Array<{ branchId: string; appBranchId: string; appBranchName: string }>;
  created: Array<{ branchId: string; branchName: string; appBranchId: string }>;
  appOnly: Array<{ appBranchId: string; appBranchName: string; marked: boolean }>;
  ambiguous: Array<{ appBranchId: string; why: string }>;
  unmapped: Array<{ branchId: string; reason: string }>;
  writes: number;
}

async function reconcile(cookie: string): Promise<ReconcileReport> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/branches/oto-app/reconcile',
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ReconcileReport;
}

describe('reconciling the two branch lists (SCRUM-268)', () => {
  it('matches the park’s exported rows by trimmed, folded name — and leaves Head Office alone', async () => {
    const report = await reconcile(adminCookie);

    expect(report.installed).toBe(true);
    // Two parks matched; the third row is the office and is not a park.
    expect(report.matchedByName.map((m) => m.appBranchId).sort()).toEqual(
      [florestaAppId, chalongAppId].sort(),
    );
    expect(report.created).toEqual([]);
    expect(report.ambiguous).toEqual([]);
    expect(report.unmapped).toEqual([]);

    const floresta = await appRow(florestaAppId);
    expect(floresta.coreBranchId).toBe(florestaId);
    expect(floresta.coreSyncStatus).toBe('SUCCESS');
    expect(floresta.coreSyncError).toBeNull();
    // The name is NOT rewritten by a sweep: it is what the app's own importer
    // find-or-creates on, and a rename is a deliberate act on one park.
    expect(floresta.name).toBe(FLORESTA_APP_NAME);
    expect((await appRow(chalongAppId)).coreBranchId).toBe(chalongId);

    const office = await appRow(headOfficeAppId);
    expect(office.coreBranchId).toBeNull();
    expect(office.coreSyncStatus).toBe('APP_ONLY');
    expect(office.coreSyncError).toBeNull();
    expect(report.appOnly).toEqual([
      { appBranchId: headOfficeAppId, appBranchName: HEAD_OFFICE_NAME, marked: true },
    ]);
  });

  it('records what it joined in the audit log', async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'branch.oto_app_map'));
    expect(rows.map((r) => r.entityId).sort()).toEqual([florestaAppId, chalongAppId].sort());
    expect(rows.every((r) => r.entityType === 'otoapp_branch')).toBe(true);
    expect(rows.every((r) => r.actorAccountId !== null)).toBe(true);
    const summary = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'branch.oto_app_reconcile'));
    expect(summary).toHaveLength(1);
  });

  it('a second run writes nothing and says so', async () => {
    const before = await appRow(headOfficeAppId);
    const report = await reconcile(adminCookie);

    expect(report.writes).toBe(0);
    expect(report.alreadyMapped).toBe(2);
    expect(report.matchedByName).toEqual([]);
    expect(report.created).toEqual([]);
    // Listed as app-only, but not written again — the stamp still says when the
    // two lists were last compared, not when somebody last pressed the button.
    expect(report.appOnly).toEqual([
      { appBranchId: headOfficeAppId, appBranchName: HEAD_OFFICE_NAME, marked: false },
    ]);
    const after = await appRow(headOfficeAppId);
    expect(after.coreSyncedAt).toEqual(before.coreSyncedAt);
  });

  it('shows the mapping per branch, cut to what the caller holds', async () => {
    const asAdmin = await ctx.app.inject({
      method: 'GET',
      url: '/branches/oto-app',
      headers: { cookie: adminCookie },
    });
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
    const view = asAdmin.json() as {
      installed: boolean;
      branches: Array<{ branchId: string; appBranchId: string | null; status: string | null }>;
      appOnly: Array<{ appBranchName: string }>;
    };
    expect(view.installed).toBe(true);
    expect(view.branches.map((b) => b.branchId).sort()).toEqual([florestaId, chalongId].sort());
    expect(view.branches.every((b) => b.appBranchId && b.status === 'SUCCESS')).toBe(true);
    expect(view.appOnly.map((r) => r.appBranchName)).toEqual([HEAD_OFFICE_NAME]);

    // The manager of one park holds `admin:branch:read` at that park only, and
    // the other park's name is exactly what `GET /branches` keeps off her
    // screen. The office belongs to no branch, so it is not hers to see either.
    const asManager = await ctx.app.inject({
      method: 'GET',
      url: '/branches/oto-app',
      headers: { cookie: managerCookie },
    });
    expect(asManager.statusCode, asManager.body).toBe(200);
    const mine = asManager.json() as {
      branches: Array<{ branchId: string }>;
      appOnly: unknown[];
    };
    expect(mine.branches.map((b) => b.branchId)).toEqual([florestaId]);
    expect(mine.appOnly).toEqual([]);
  });

  it('refuses a branch manager, who administers one park and not the estate', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/branches/oto-app/reconcile',
      headers: { cookie: managerCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('a branch created or renamed on the platform reaches the app (SCRUM-268)', () => {
  let kataId: string;
  let kataAppId: string;

  it('creates the app row in the same request', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/branches',
      headers: { cookie: adminCookie },
      payload: { name: 'Oto Play Park, Kata', code: 'kata', timezone: 'Asia/Bangkok' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      id: string;
      otoApp: { appBranchId: string; mappedBy: string; reason: string | null };
    };
    kataId = body.id;
    expect(body.otoApp.mappedBy).toBe('created');
    expect(body.otoApp.reason).toBeNull();
    kataAppId = body.otoApp.appBranchId;

    const row = await appRow(kataAppId);
    expect(row.coreBranchId).toBe(kataId);
    expect(row.name).toBe('Oto Play Park, Kata');
    expect(row.coreSyncStatus).toBe('SUCCESS');
    // The tenant and the operator come off the rows already there, because the
    // app's operator table is not the platform's and nothing maps the two.
    expect(row.tenantId).toBe(appTenantId);
  });

  it('follows a rename, by id', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${kataId}`,
      headers: { cookie: adminCookie },
      payload: { name: 'Oto Play Park, Kata Beach' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().otoApp).toMatchObject({ appBranchId: kataAppId });
    expect((await appRow(kataAppId)).name).toBe('Oto Play Park, Kata Beach');
  });

  it('leaves the app row alone when the rename is not a rename', async () => {
    const before = await appRow(kataAppId);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${kataId}`,
      headers: { cookie: adminCookie },
      payload: { timezone: 'Asia/Bangkok', name: 'Oto Play Park, Kata Beach' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().otoApp).toBeNull();
    expect((await appRow(kataAppId)).coreSyncedAt).toEqual(before.coreSyncedAt);
  });

  it('archives nothing and touches nothing else', async () => {
    const report = await reconcile(adminCookie);
    expect(report.writes).toBe(0);
    expect(report.alreadyMapped).toBe(3);
    expect((await appRow(headOfficeAppId)).coreBranchId).toBeNull();
  });
});

describe('another operator’s branches are never touched (SCRUM-268)', () => {
  it('reconciles nothing for an operator with no row in this app', async () => {
    const before = await appRowCount();
    const cookie = await signInAs(
      ctx.app,
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    const report = await reconcile(cookie);

    // Their administrator holds `admin:branch:update` operator-wide, so the
    // route runs — and finds nothing of theirs in the app and no anchor to
    // create one against. The alternative, creating their park inside the OTO
    // tenant because it is the only one there, is the leak this refuses.
    expect(report.matchedByName).toEqual([]);
    expect(report.created).toEqual([]);
    expect(report.appOnly).toEqual([]);
    expect(report.unmapped.map((u) => u.reason)).toEqual(['no_app_anchor']);
    expect(report.writes).toBe(0);
    expect(await appRowCount()).toBe(before);

    const secondOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
    const theirs = await ctx.db
      .select()
      .from(otoappBranches)
      .where(eq(otoappBranches.coreBranchId, secondOperatorId));
    expect(theirs).toEqual([]);
  });
});

describe('provisioning seats a person at the park they work at (SCRUM-268)', () => {
  /** Somebody with an employee record at one park, the way the console makes one. */
  async function staffAt(opts: {
    phone: string;
    name: string;
    branchId: string | null;
    /**
     * The SYSTEM role of that name, granted operator-wide. Resolved on a null
     * `operator_id` because an operator may mint a role of its own carrying the
     * same name (SCRUM-318) — and one test below does exactly that, so "the
     * role called operator_admin" stopped being a single row.
     */
    roleName?: 'operator_admin';
    /** A specific role row, granted operator-wide — an operator's own, say. */
    roleId?: string;
  }): Promise<string> {
    const employeeId = newId();
    await ctx.db
      .insert(employee)
      .values({ id: employeeId, operatorId, name: opts.name, branchId: opts.branchId });
    const accountId = newId();
    await ctx.db.insert(account).values({
      id: accountId,
      operatorId,
      employeeId,
      phone: normalizePhone(opts.phone)!,
      status: 'invited',
    });
    let roleId = opts.roleId ?? null;
    if (!roleId && opts.roleName) {
      const [row] = await ctx.db
        .select({ id: role.id })
        .from(role)
        .where(and(eq(role.name, opts.roleName), isNull(role.operatorId)))
        .limit(1);
      roleId = row!.id;
    }
    if (roleId) {
      await ctx.db.insert(roleAssignment).values({
        id: newId(),
        accountId,
        roleId,
        scopeType: 'operator',
        scopeId: operatorId,
      });
    }
    return accountId;
  }

  async function provision(
    accountId: string,
    email: string,
    body: Record<string, unknown> = {},
  ): Promise<{ externalUserId: string; appBranch: { branchIds: string[]; seatedFrom: string } }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: { accountId, otoApp: { email, role: 'staff' }, ...body },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  const accessOf = (userId: string) =>
    ctx.db.select().from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, userId));

  it('puts reception at Robinson Chalong in Chalong’s app branch and no other', async () => {
    const accountId = await staffAt({
      phone: '+66900000421',
      name: 'Reception, Chalong',
      branchId: chalongId,
    });
    const result = await provision(accountId, 'reception.chalong@otopark.test');

    expect(result.appBranch.seatedFrom).toBe('employee');
    const rows = await accessOf(result.externalUserId);
    expect(rows.map((r) => r.branchId)).toEqual([chalongAppId]);
    expect(rows[0]!.accessScope).toBe('selected_branches');
    expect(rows.some((r) => r.branchId === florestaAppId)).toBe(false);
  });

  it('gives somebody who administers the whole operator every mapped branch', async () => {
    const accountId = await staffAt({
      phone: '+66900000422',
      name: 'Operator administrator',
      branchId: florestaId,
      roleName: 'operator_admin',
    });
    const result = await provision(accountId, 'operator.admin@otopark.test');

    expect(result.appBranch.seatedFrom).toBe('operator_wide');
    const rows = await accessOf(result.externalUserId);
    expect(rows.map((r) => r.branchId).sort()).toEqual(
      result.appBranch.branchIds.slice().sort(),
    );
    expect(rows.map((r) => r.branchId)).toContain(florestaAppId);
    expect(rows.map((r) => r.branchId)).toContain(chalongAppId);
    // Head Office is not a park and is nobody's branch access.
    expect(rows.map((r) => r.branchId)).not.toContain(headOfficeAppId);
  });

  it('takes the branch the request names over the one on their record', async () => {
    const accountId = await staffAt({
      phone: '+66900000423',
      name: 'Moving To Chalong',
      branchId: florestaId,
    });
    const result = await provision(accountId, 'moving.to.chalong@otopark.test', {
      branchId: chalongId,
    });

    expect(result.appBranch.seatedFrom).toBe('request');
    expect((await accessOf(result.externalUserId)).map((r) => r.branchId)).toEqual([chalongAppId]);
  });

  it('never seats anyone in another operator’s park, whatever the request says', async () => {
    const secondOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
    const [theirBranch] = await ctx.db
      .select()
      .from(otoappBranches)
      .where(and(eq(otoappBranches.tenantId, appTenantId), eq(otoappBranches.name, 'nothing')));
    expect(theirBranch).toBeUndefined();

    const accountId = await staffAt({
      phone: '+66900000424',
      name: 'Aimed Elsewhere',
      branchId: florestaId,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: {
        accountId,
        branchId: secondOperatorId, // not a branch at all, and not theirs either
        otoApp: { email: 'aimed.elsewhere@otopark.test', role: 'staff' },
      },
    });
    // The branch named is loaded inside the account's own operator, so an id
    // from anywhere else resolves to nothing rather than to somebody else's
    // park — and provisioning still succeeds, saying they landed nowhere.
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().appBranch.unplacedReason).toBe('no_platform_branch');
    expect(await accessOf(res.json().externalUserId)).toHaveLength(0);
  });

  /**
   * SCRUM-318 — "administers the whole operator" is a PERMISSION held at
   * operator scope, and was a role NAME.
   *
   * Role names are unique per operator and nothing reserves the system ones,
   * so `operator_admin` is a name any operator may mint for a role of its own —
   * "handles our admin paperwork" is a plausible reason to. While the question
   * was asked by name, everybody holding that role was seated in every park of
   * the OTO App, which is every park's member data, on a role the park meant as
   * a clerical one.
   */
  describe('operator-wide is a permission, not a role name (SCRUM-318)', () => {
    /** The operator's own role, carrying the system role's name and none of its authority. */
    let lookalikeRoleId: string;

    it('an operator’s own role called operator_admin seats a person in one park', async () => {
      lookalikeRoleId = newId();
      await ctx.db.insert(role).values({
        id: lookalikeRoleId,
        operatorId,
        name: 'operator_admin',
        description: 'The park’s own paperwork role, which happens to be called this',
      });
      await ctx.db
        .insert(rolePermission)
        .values({ id: newId(), roleId: lookalikeRoleId, permission: 'pos:member:read' });

      const accountId = await staffAt({
        phone: '+66900000425',
        name: 'Named Like An Administrator',
        branchId: chalongId,
        roleId: lookalikeRoleId,
      });
      const result = await provision(accountId, 'named.like.an.administrator@otopark.test');

      // Their own park, from their employee record — not every park.
      expect(result.appBranch.seatedFrom).toBe('employee');
      const rows = await accessOf(result.externalUserId);
      expect(rows.map((r) => r.branchId)).toEqual([chalongAppId]);
      expect(rows.map((r) => r.branchId)).not.toContain(florestaAppId);
    });

    it('and the real operator_admin still reaches every mapped park', async () => {
      // The lookalike is in the database by now, so "the role called
      // operator_admin" is two rows and only one of them is the estate's.
      expect(
        await ctx.db.select().from(role).where(eq(role.name, 'operator_admin')),
      ).toHaveLength(2);

      const accountId = await staffAt({
        phone: '+66900000426',
        name: 'Actually An Administrator',
        branchId: chalongId,
        roleName: 'operator_admin',
      });
      const result = await provision(accountId, 'actually.an.administrator@otopark.test');

      expect(result.appBranch.seatedFrom).toBe('operator_wide');
      const seated = (await accessOf(result.externalUserId)).map((r) => r.branchId);
      expect(seated).toContain(florestaAppId);
      expect(seated).toContain(chalongAppId);
      expect(seated).not.toContain(headOfficeAppId);
    });
  });
});

/**
 * SCRUM-319 — one platform branch, at most one row in the app.
 *
 * Every "is it mapped already" question the mapping asks is a read, and a read
 * cannot see a row another transaction has not committed. Two creates of one
 * branch therefore both found nothing and both wrote, and which of the two rows
 * a person was afterwards seated in came down to which the next reader happened
 * to find first. The database is what settles it now.
 */
describe('one platform branch maps to one app row (SCRUM-319)', () => {
  it('two mappings of one branch racing each other leave one row', async () => {
    const branchId = newId();
    const input = {
      operatorId,
      branchId,
      name: 'Oto Play Park, Bang Tao',
      address: 'A mall in Phuket',
      timezone: 'Asia/Bangkok',
    };

    const racers = await Promise.allSettled([
      ctx.db.transaction((tx) => mapCoreBranchIntoApp(tx, input)),
      ctx.db.transaction((tx) => mapCoreBranchIntoApp(tx, input)),
    ]);

    const rows = await ctx.db
      .select()
      .from(otoappBranches)
      .where(eq(otoappBranches.coreBranchId, branchId));
    expect(rows).toHaveLength(1);

    // At most one of the two may claim it made the row. The loser either found
    // the committed row and said `core_branch_id`, or was refused by the index
    // and rolled back — both are correct, and which one happens depends on how
    // the two transactions interleave, so neither is asserted.
    const created = racers.filter(
      (r) => r.status === 'fulfilled' && r.value.mappedBy === 'created',
    );
    expect(created).toHaveLength(1);
  });

  it('refuses a second app row carrying a platform branch another row already has', async () => {
    const refusal = await ctx.db
      .execute(
        sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
            values (${newId()}, ${appTenantId}, 'A second row for Floresta', 'A mall in Phuket', ${florestaId})`,
      )
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(refusal, 'a second row for one platform branch was accepted').not.toBeNull();
    // Drizzle wraps the driver's error, so the constraint is named on the cause.
    const cause = (refusal as { cause?: unknown }).cause ?? refusal;
    expect(cause).toMatchObject({
      code: '23505',
      constraint: 'branches_core_branch_id_unique',
    });
  });
});
