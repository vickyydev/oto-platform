import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  appIdentity,
  auditLog,
  branch,
  CASE_COLLISION_ERROR,
  censusAppBranchIdCase,
  findAppBranchForCore,
  mapCoreBranchIntoApp,
  otoappBranches,
  otoappUsers,
} from '@oto/db';
import { createTestDatabase } from '@oto/db/testing';
import { newId, normalizePhone } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-17b round 1 — sign-on and identity (SCRUM-193; plan
 * `docs/progress/plans/otoapp-lift/PLAN.md`, the round 1 row of section 8).
 *
 *  A. H1, the branch seam in lower case: a park opened with an upper-case id
 *     is stored, mapped and published in lower case, and its events reach
 *     `otoapp_v.events`.
 *  B. The case census: a read-only listing of every non-lower-case
 *     `core_branch_id`, and the reconciliation's phase 0 that lowers this
 *     operator's rows in place — and lists, never merges, a collision.
 *  C. The OTO App users with no suite sign-in, and the existing Link.
 *  D. H28 and the referenced-user refusal: the app's own delete, run against
 *     the real schema with a real platform link behind it.
 *  E. The route fences' own logic (`server/lib/routeFences.ts`).
 *  F. H19: the platform names the app's tables only through the declared
 *     seams, and an app-only change to a migration or the directory runs this
 *     suite (the CI path gate), with an OTO App job behind it.
 *  G. H26 and H28 over HTTP: the app's real routes, booted twice
 *     (`apps/oto-app/tests/route-fences.check.ts`). Needs the app's own
 *     node_modules, which only the OTO App CI job and a developer's machine
 *     have; skipped where they are absent, and run by that job directly.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);

const loadApp = async <T>(rel: string): Promise<T> =>
  (await import(/* @vite-ignore */ pathToFileURL(join(APP_DIR, rel)).href)) as T;

let ctx: TestContext;
let admin: string;
let operatorId: string;
let central: string;
let chalong: string;
let appPool: pg.Pool;
/** The app's park group this operator is anchored in. */
const appTenant = newId();
/** Another park group, anchored to nobody here. */
const foreignTenant = newId();
let appCentral: string;
let appChalong: string;

/** An app branch row, written as the app's migrator left the table. */
async function appBranch(opts: {
  name: string;
  tenantId?: string;
  coreBranchId?: string | null;
}): Promise<string> {
  const id = newId();
  await ctx.db.execute(
    sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
        values (${id}, ${opts.tenantId ?? appTenant}, ${opts.name}, 'ZZ TEST', ${opts.coreBranchId ?? null})`,
  );
  return id;
}

const coreIdOf = async (appBranchId: string) =>
  (
    await ctx.db
      .select({ c: otoappBranches.coreBranchId })
      .from(otoappBranches)
      .where(eq(otoappBranches.id, appBranchId))
  )[0]?.c ?? null;

/** A platform branch with no app row behind it, for arranging the app side by hand. */
async function bareBranch(name: string): Promise<string> {
  const id = newId();
  await ctx.db
    .insert(branch)
    .values({ id, operatorId, name, code: `zz-${id.slice(-8)}`, timezone: 'Asia/Bangkok' });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;

  await ctx.db.execute(
    sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'ZZ TEST OTO', 'zz-oto'),
          (${foreignTenant}, 'ZZ TEST elsewhere', 'zz-elsewhere')`,
  );
  // The anchor: this operator's two parks, already joined to the app's rows.
  appCentral = await appBranch({ name: 'ZZ app Central', coreBranchId: central });
  appChalong = await appBranch({ name: 'ZZ app Chalong', coreBranchId: chalong });

  const url = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// A. H1 — a park opened with an upper-case id stays inside the seam
// =============================================================================

describe('A. H1: the seam stores and matches the platform id in lower case', () => {
  const sent = newId().toUpperCase();
  const lower = sent.toLowerCase();

  it('a branch created with an upper-case id is answered, stored and mapped in lower case', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/branches',
      headers: { cookie: admin },
      payload: { id: sent, name: 'ZZ Upper Park', code: 'zz-upper-park', timezone: 'Asia/Bangkok' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { id: string; otoApp: { appBranchId: string; mappedBy: string } };
    expect(body.id).toBe(lower);
    expect(body.otoApp.mappedBy).toBe('created');
    expect(await coreIdOf(body.otoApp.appBranchId)).toBe(lower);
    const [row] = await ctx.db.select({ id: branch.id }).from(branch).where(eq(branch.id, lower));
    expect(row?.id).toBe(lower);
  });

  it('an app event at that park appears in otoapp_v.events under the platform id', async () => {
    const [mapped] = await ctx.db
      .select({ id: otoappBranches.id })
      .from(otoappBranches)
      .where(eq(otoappBranches.coreBranchId, lower));
    await ctx.db.execute(
      sql`insert into otoapp.core_events (tenant_id, branch_id, event_type, title, event_date, start_time)
          values (${appTenant}, ${mapped!.id}, 'workshop', 'ZZ upper-case park workshop', '2026-11-10', '10:00')`,
    );
    const rows = (
      await ctx.db.execute<{ title: string }>(
        sql`select title from otoapp_v.events where branch_id = ${lower}::uuid`,
      )
    ).rows;
    expect(rows.map((r) => r.title)).toEqual(['ZZ upper-case park workshop']);
  });

  it('the same create again, upper case, is a replay and makes no second row', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/branches',
      headers: { cookie: admin },
      payload: { id: sent, name: 'ZZ Upper Park', code: 'zz-upper-park', timezone: 'Asia/Bangkok' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-oto-replay']).toBe('true');
    const rows = await ctx.db
      .select({ id: otoappBranches.id })
      .from(otoappBranches)
      .where(sql`lower(${otoappBranches.coreBranchId}) = ${lower}`);
    expect(rows).toHaveLength(1);
  });

  it('a rename through an upper-case URL follows into the app row', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${sent}`,
      headers: { cookie: admin },
      payload: { name: 'ZZ Upper Park Renamed' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { otoApp: { appBranchName: string } | null }).otoApp?.appBranchName).toBe(
      'ZZ Upper Park Renamed',
    );
  });

  it('the seam engine lower-cases on its own too: mapping, lookups and a row left in upper case', async () => {
    // A caller that skipped the route (the seed, the booth roster) still lands lower case.
    const id = await bareBranch('ZZ Engine Park');
    const mapped = await mapCoreBranchIntoApp(ctx.db, {
      operatorId,
      branchId: id.toUpperCase(),
      name: 'ZZ Engine Park',
      address: null,
      timezone: 'Asia/Bangkok',
    });
    expect(mapped.mappedBy).toBe('created');
    expect(await coreIdOf(mapped.appBranchId!)).toBe(id);
    const found = await findAppBranchForCore(ctx.db, {
      operatorId,
      coreBranchId: id.toUpperCase(),
      name: 'ZZ Engine Park',
    });
    expect(found !== 'ambiguous' && found?.id).toBe(mapped.appBranchId);

    // A row written in upper case before the fix: mapping that branch again
    // lowers it in place — the same row, not a second one.
    const old = await bareBranch('ZZ Old Park');
    const oldRow = await appBranch({ name: 'ZZ Old Park', coreBranchId: old.toUpperCase() });
    const again = await mapCoreBranchIntoApp(ctx.db, {
      operatorId,
      branchId: old,
      name: 'ZZ Old Park',
      address: null,
      timezone: 'Asia/Bangkok',
    });
    expect(again).toMatchObject({
      appBranchId: oldRow,
      mappedBy: 'core_branch_id',
      status: 'SUCCESS',
    });
    expect(await coreIdOf(oldRow)).toBe(old);
  });
});

// =============================================================================
// B. The case census
// =============================================================================

describe('B. the case census: listed read-only, lowered in place, a collision never merged', () => {
  let lowerable: { branchId: string; appRow: string };
  let collision: { branchId: string; held: string; upper: string };
  let foreign: { appRow: string; coreId: string };

  beforeAll(async () => {
    const a = await bareBranch('ZZ Census Lowerable');
    lowerable = {
      branchId: a,
      appRow: await appBranch({ name: 'ZZ Census Lowerable', coreBranchId: a.toUpperCase() }),
    };
    const b = await bareBranch('ZZ Census Collision');
    collision = {
      branchId: b,
      held: await appBranch({ name: 'ZZ Census Collision (mapped)', coreBranchId: b }),
      upper: await appBranch({
        name: 'ZZ Census Collision (upper)',
        coreBranchId: b.toUpperCase(),
      }),
    };
    // Somebody else's: a platform id that is no branch of this operator.
    const coreId = newId();
    foreign = {
      coreId,
      appRow: await appBranch({
        name: 'ZZ Census Foreign',
        tenantId: foreignTenant,
        coreBranchId: coreId.toUpperCase(),
      }),
    };
  });

  it('the read-only census lists every non-lower-case id, names the collision, and writes nothing', async () => {
    const census = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return censusAppBranchIdCase(tx);
    });
    expect(census.installed).toBe(true);
    expect(census.writes).toBe(0);
    expect(census.lowered).toEqual([]);
    const byRow = new Map(census.found.map((f) => [f.appBranchId, f]));
    expect(byRow.get(lowerable.appRow)).toMatchObject({
      canonical: lowerable.branchId,
      heldBy: null,
    });
    expect(byRow.get(collision.upper)).toMatchObject({
      canonical: collision.branchId,
      heldBy: collision.held,
    });
    expect(byRow.get(foreign.appRow)).toMatchObject({ canonical: foreign.coreId, heldBy: null });
    expect(census.collisions.map((c) => c.appBranchId)).toEqual([collision.upper]);
  });

  it('fixing is only ever done for one operator', async () => {
    await expect(censusAppBranchIdCase(ctx.db, { fix: true })).rejects.toThrow(/one operator/);
  });

  it("the reconciliation lowers this operator's row in place and lists the collision, merging nothing", async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/branches/oto-app/reconcile',
      headers: { cookie: admin },
    });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json() as {
      caseLowered: Array<{ appBranchId: string }>;
      caseCollisions: Array<{ appBranchId: string; heldBy: string }>;
      writes: number;
    };
    expect(report.caseLowered.map((r) => r.appBranchId)).toContain(lowerable.appRow);
    expect(report.caseCollisions).toEqual([
      expect.objectContaining({ appBranchId: collision.upper, heldBy: collision.held }),
    ]);
    expect(await coreIdOf(lowerable.appRow)).toBe(lowerable.branchId);
    // Both collision rows exist exactly as they were spelled; the upper one says why.
    expect(await coreIdOf(collision.held)).toBe(collision.branchId);
    expect(await coreIdOf(collision.upper)).toBe(collision.branchId.toUpperCase());
    const [upper] = await ctx.db
      .select({ status: otoappBranches.coreSyncStatus, error: otoappBranches.coreSyncError })
      .from(otoappBranches)
      .where(eq(otoappBranches.id, collision.upper));
    expect(upper).toEqual({ status: 'FAILED', error: CASE_COLLISION_ERROR });
    // Another operator's row is not this operator's to lower.
    expect(await coreIdOf(foreign.appRow)).toBe(foreign.coreId.toUpperCase());

    const audited = await ctx.db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'branch.oto_app_map'), eq(auditLog.entityId, lowerable.appRow)),
      );
    expect(audited).toEqual([
      {
        before: { coreBranchId: lowerable.branchId.toUpperCase() },
        after: expect.objectContaining({
          coreBranchId: lowerable.branchId,
          mappedBy: 'case_census',
        }),
      },
    ]);
  });

  it('a second run writes nothing and still lists the collision for a person to settle', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/branches/oto-app/reconcile',
      headers: { cookie: admin },
    });
    const report = res.json() as {
      writes: number;
      caseLowered: unknown[];
      caseCollisions: Array<{ appBranchId: string }>;
    };
    expect(report.writes).toBe(0);
    expect(report.caseLowered).toEqual([]);
    expect(report.caseCollisions.map((c) => c.appBranchId)).toEqual([collision.upper]);
  });

  it("the read-back after the reconciliation: only the collision and the other operator's row remain", async () => {
    const census = await censusAppBranchIdCase(ctx.db);
    expect(census.found.map((f) => f.appBranchId).sort()).toEqual(
      [collision.upper, foreign.appRow].sort(),
    );
  });
});

// =============================================================================
// C. The OTO App users with no suite sign-in, and the existing Link
// =============================================================================

interface UnlinkedAnswer {
  installed: boolean;
  anchored: boolean;
  users: Array<{
    id: string;
    fullName: string;
    allBranches: boolean;
    branches: Array<{ id: string; name: string; platformBranchId: string | null }>;
  }>;
}

describe('C. the app users with no suite sign-in, beside the existing Link', () => {
  const ids = {
    seatedCentral: newId(),
    seatedChalong: newId(),
    everyBranch: newId(),
    linked: newId(),
    elsewhere: newId(),
    mixed: newId(),
  };

  beforeAll(async () => {
    const appBranchElsewhere = await appBranch({
      name: 'ZZ elsewhere park',
      tenantId: foreignTenant,
    });
    const user = async (id: string, name: string, platformUserId: string | null = null) =>
      ctx.db.execute(
        sql`insert into otoapp.users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
            values (${id}, ${`zz-${id}@example.com`}, 'x.y', ${name}, 'staff', true, false, ${platformUserId})`,
      );
    const seat = async (userId: string, tenantId: string, branchId: string | null) =>
      ctx.db.execute(
        sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope)
            values (${newId()}, ${tenantId}, ${userId}, ${branchId}, ${branchId ? 'selected_branches' : 'all_branches'})`,
      );
    await user(ids.seatedCentral, 'ZZ Made In App Central');
    await seat(ids.seatedCentral, appTenant, appCentral);
    await user(ids.seatedChalong, 'ZZ Made In App Chalong');
    await seat(ids.seatedChalong, appTenant, appChalong);
    await user(ids.everyBranch, 'ZZ Made In App Everywhere');
    await seat(ids.everyBranch, appTenant, null);
    await user(ids.linked, 'ZZ Already Linked', newId());
    await seat(ids.linked, appTenant, appCentral);
    await user(ids.elsewhere, 'ZZ Another Park Group');
    await seat(ids.elsewhere, foreignTenant, appBranchElsewhere);
    // Access rows in two park groups: the app itself cannot say whose they are.
    await user(ids.mixed, 'ZZ Two Park Groups');
    await seat(ids.mixed, appTenant, appCentral);
    await seat(ids.mixed, foreignTenant, appBranchElsewhere);
  });

  const list = async (cookie: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/admin/apps/oto_app/unlinked-users',
      headers: { cookie },
    });

  it("lists this operator's park group's users that no platform account is stamped on", async () => {
    const res = await list(admin);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as UnlinkedAnswer;
    expect(body).toMatchObject({ installed: true, anchored: true });
    const listed = body.users.map((u) => u.id);
    expect(listed).toEqual(
      expect.arrayContaining([ids.seatedCentral, ids.seatedChalong, ids.everyBranch]),
    );
    for (const hidden of [ids.linked, ids.elsewhere, ids.mixed])
      expect(listed).not.toContain(hidden);
    const seated = body.users.find((u) => u.id === ids.seatedCentral)!;
    expect(seated.branches).toEqual([
      { id: appCentral, name: 'ZZ app Central', platformBranchId: central },
    ]);
    expect(body.users.find((u) => u.id === ids.everyBranch)!.allBranches).toBe(true);
  });

  it("a branch-scoped reader sees only the people seated at their own park's branch", async () => {
    const manager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const res = await list(manager);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as UnlinkedAnswer).users.map((u) => u.id)).toEqual([ids.seatedChalong]);
  });

  it('is refused to an account that cannot read accounts', async () => {
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await list(reception)).statusCode).toBe(403);
  });

  it('the existing Link claims one, and it leaves the list', async () => {
    const [target] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: admin },
      payload: { accountId: target!.id, externalUserId: ids.seatedCentral },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [stamped] = await ctx.db
      .select({ p: otoappUsers.platformUserId })
      .from(otoappUsers)
      .where(eq(otoappUsers.id, ids.seatedCentral));
    expect(stamped?.p).toBe(target!.id);
    const after = (await list(admin)).json() as UnlinkedAnswer;
    expect(after.users.map((u) => u.id)).not.toContain(ids.seatedCentral);
  });

  it('says so, and lists nobody, for an operator with no branch joined to the app', async () => {
    const second = await signInAs(
      ctx.app,
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    const res = await list(second);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ installed: true, anchored: false, users: [] });
  });
});

// =============================================================================
// D. H28 and the referenced user: the app's own delete, on the real schema
// =============================================================================

interface UserDeletionModule {
  DEACTIVATE_INSTEAD: string;
  deleteManagedUser(
    pool: pg.Pool,
    userId: string,
  ): Promise<
    | { deleted: true }
    | { deleted: false; status: 404; message: string }
    | {
        deleted: false;
        status: 409;
        message: string;
        reason: 'linked_to_platform' | 'still_referenced';
      }
  >;
}

describe('D. H28: deleting a user the platform links, or the app references, changes nothing', () => {
  let mod: UserDeletionModule;
  beforeAll(async () => {
    mod = await loadApp<UserDeletionModule>('server/lib/userDeletion.ts');
  });

  const accessRows = async (userId: string) =>
    (
      await ctx.db.execute<{ n: number }>(
        sql`select count(*)::int as n from otoapp.user_branch_access where user_id = ${userId}`,
      )
    ).rows[0]!.n;

  it('a provisioned user is refused in the app’s own words; the user and its core.app_identity are unchanged', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: admin },
      payload: {
        phone: '+66900007711',
        name: 'ZZ Provisioned Person',
        branchId: central,
        otoApp: { email: 'zz-provisioned@example.com', role: 'staff' },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { externalUserId, id: identityId } = res.json() as { externalUserId: string; id: string };
    const userBefore = (
      await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, externalUserId))
    )[0];
    const identityBefore = (
      await ctx.db.select().from(appIdentity).where(eq(appIdentity.id, identityId))
    )[0];

    const outcome = await mod.deleteManagedUser(appPool, externalUserId);
    expect(outcome).toEqual({
      deleted: false,
      status: 409,
      message: 'Deactivate this account to preserve its HR record',
      reason: 'linked_to_platform',
    });
    expect(mod.DEACTIVATE_INSTEAD).toBe('Deactivate this account to preserve its HR record');
    expect(
      (await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, externalUserId)))[0],
    ).toEqual(userBefore);
    expect(
      (await ctx.db.select().from(appIdentity).where(eq(appIdentity.id, identityId)))[0],
    ).toEqual(identityBefore);
    expect(await accessRows(externalUserId)).toBe(1);
  });

  it('a user the app still references is refused in the same words — no 500 — and keeps its branch access', async () => {
    const id = newId();
    await ctx.db.execute(
      sql`insert into otoapp.users (id, email, password, full_name, role, is_active, must_change_password)
          values (${id}, ${`zz-ref-${id}@example.com`}, 'x.y', 'ZZ Referenced', 'staff', true, false)`,
    );
    await ctx.db.execute(
      sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope)
          values (${newId()}, ${appTenant}, ${id}, ${appCentral}, 'selected_branches')`,
    );
    await ctx.db.execute(
      sql`insert into otoapp.user_module_overrides (tenant_id, user_id, module_key) values (${appTenant}, ${id}, 'ops')`,
    );
    const outcome = await mod.deleteManagedUser(appPool, id);
    expect(outcome).toMatchObject({ deleted: false, status: 409, reason: 'still_referenced' });
    expect(await accessRows(id)).toBe(1);
    expect(await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, id))).toHaveLength(1);
  });

  it('a user nothing points at is deleted with its branch access, and an unknown id is 404', async () => {
    const id = newId();
    await ctx.db.execute(
      sql`insert into otoapp.users (id, email, password, full_name, role, is_active, must_change_password)
          values (${id}, ${`zz-plain-${id}@example.com`}, 'x.y', 'ZZ Plain', 'staff', true, false)`,
    );
    await ctx.db.execute(
      sql`insert into otoapp.user_branch_access (id, tenant_id, user_id, branch_id, access_scope)
          values (${newId()}, ${appTenant}, ${id}, ${appCentral}, 'selected_branches')`,
    );
    expect(await mod.deleteManagedUser(appPool, id)).toEqual({ deleted: true });
    expect(await accessRows(id)).toBe(0);
    expect(await mod.deleteManagedUser(appPool, id)).toMatchObject({ deleted: false, status: 404 });
  });
});

// =============================================================================
// E. The fences' own logic
// =============================================================================

interface FakeRes {
  statusCode: number;
  body: unknown;
  locals: Record<string, unknown>;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}
type Mw = (req: unknown, res: FakeRes, next: () => void) => void;
interface FencesModule {
  readJobsMode(raw: string | undefined): 'inprocess' | 'platform' | null;
  devOnly(env: 'local' | 'staging' | 'production'): Mw;
  followsJobsSwitch(mode: 'inprocess' | 'platform'): Mw;
  parkGroupOnly(callerParkGroup: (req: unknown) => Promise<string | undefined>): Mw;
  DEV_ROUTE_REFUSAL: { reason: string; message: string };
  JOBS_ON_PLATFORM_REFUSAL: { reason: string; message: string };
  NO_PARK_GROUP_REFUSAL: { reason: string; message: string };
}

const fakeRes = (): FakeRes => {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    locals: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
};

describe("E. the route fences' logic", () => {
  let f: FencesModule;
  beforeAll(async () => {
    f = await loadApp<FencesModule>('server/lib/routeFences.ts');
  });

  const through = (mw: Mw, req: unknown = {}) => {
    const res = fakeRes();
    let passed = false;
    mw(req, res, () => {
      passed = true;
    });
    return { res, passed };
  };

  it('a dev route is refused on staging and production, by DEPLOY_ENV, and passes on a laptop', () => {
    for (const env of ['staging', 'production'] as const) {
      const { res, passed } = through(f.devOnly(env));
      expect(passed).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual(f.DEV_ROUTE_REFUSAL);
    }
    expect(through(f.devOnly('local')).passed).toBe(true);
  });

  it('OTOAPP_JOBS: unset is inprocess, the two words are read, anything else is refused at boot', () => {
    expect(f.readJobsMode(undefined)).toBe('inprocess');
    expect(f.readJobsMode('')).toBe('inprocess');
    expect(f.readJobsMode('platform')).toBe('platform');
    expect(f.readJobsMode('inprocess')).toBe('inprocess');
    expect(f.readJobsMode('Platform')).toBeNull();
    expect(f.readJobsMode('both')).toBeNull();
  });

  it('a manual job trigger points at the Console under platform and runs under inprocess', () => {
    const { res, passed } = through(f.followsJobsSwitch('platform'));
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(f.JOBS_ON_PLATFORM_REFUSAL);
    expect(through(f.followsJobsSwitch('inprocess')).passed).toBe(true);
  });

  /** A middleware that may answer later: settled when it calls next or answers. */
  const settle = (mw: Mw, req: unknown = {}) =>
    new Promise<{ res: FakeRes; passed: boolean }>((resolve, reject) => {
      const res = fakeRes();
      const json = res.json;
      res.json = (body) => {
        json(body);
        resolve({ res, passed: false });
        return res;
      };
      mw(req, res, ((err?: unknown) =>
        err ? reject(err) : resolve({ res, passed: true })) as () => void);
    });

  it("a maintenance route takes the park group the app places the caller in, and refuses a caller it cannot place", async () => {
    // The resolver is the app's strict rule (`userManagementTenant`): what it
    // answers is the park group, whatever the session's fallback says.
    const seen: unknown[] = [];
    const placedIn =
      (tenantId: string | undefined) =>
      async (req: unknown): Promise<string | undefined> => {
        seen.push(req);
        return tenantId;
      };
    const req = { user: { id: 'zz' }, userWithAccess: { tenantId: appTenant } };
    const ok = await settle(f.parkGroupOnly(placedIn(appTenant)), req);
    expect(ok.passed).toBe(true);
    expect(ok.res.locals.parkGroupId).toBe(appTenant);
    expect(seen).toEqual([req]);

    // The session names a park group by its fallback, the app cannot place them.
    const refused = await settle(f.parkGroupOnly(placedIn(undefined)), req);
    expect(refused.passed).toBe(false);
    expect(refused.res.statusCode).toBe(403);
    expect(refused.res.body).toEqual(f.NO_PARK_GROUP_REFUSAL);
    expect(refused.res.locals.parkGroupId).toBeUndefined();
  });

  it('a maintenance route whose park group cannot be read passes the error on, and runs nothing', async () => {
    const boom = new Error('zz: the read failed');
    await expect(
      settle(
        f.parkGroupOnly(async () => {
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);
  });
});

// =============================================================================
// F. H19 — the declared seams, and an app-only change that is still tested
// =============================================================================

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const DB_SRC = fileURLToPath(new URL('../../../packages/db/src', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every table the app's migrations create — the HR, rota and everything else, not a hand-kept list. */
function appTables(): Set<string> {
  const sqlText = readdirSync(APP_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(APP_MIGRATIONS, f), 'utf8'))
    .join('\n');
  return new Set([...sqlText.matchAll(/CREATE TABLE "([a-z_0-9]+)"/g)].map((m) => m[1]!));
}

/**
 * THE DECLARED SEAMS (plan sections 6 and 7, Q11): which app tables each
 * platform file may name, and nothing else may name any.
 *
 *  - provisioning — `oto-app-users.ts`: the users it creates, links and lists,
 *    the one branch-access row it writes, and the app's tenants and operators
 *    it reads to place a user in a park group;
 *  - the branch seam — the engine in `packages/db/src/schema/otoapp.ts`;
 *  - the booth roster — `booth-duty.ts`, which reads the rota directly (Q11).
 *
 * The events module reads through `otoapp_v` only (round 0, section D).
 */
const SEAMS: Record<string, string[]> = {
  'apps/api/src/services/oto-app-users.ts': [
    'users',
    'user_branch_access',
    'branches',
    'tenants',
    'operators',
  ],
  'apps/api/src/services/booth-duty.ts': [
    'schedule_assignments',
    'schedule_shift_rows',
    'shift_groups',
    'departments',
    'roles',
    'schedule_shift_row_roles',
    'duty_blocks',
    'duty_types',
    'employees',
    'casual_workers',
    'users',
  ],
  'packages/db/src/schema/otoapp.ts': [
    'users',
    'branches',
    'user_branch_access',
    'schedule_assignments',
    'schedule_shift_rows',
    'shift_groups',
    'departments',
    'roles',
    'schedule_shift_row_roles',
    'duty_blocks',
    'duty_types',
    'employees',
    'casual_workers',
  ],
  // The demo seed (S2-20 E5): it joins a park through the same engine, then
  // writes the app's demo events the way the app's own forms would. A seed,
  // never the api: section D of g17-round0-review holds apps/api/src to the views.
  'packages/db/src/seed/demo-events.ts': [
    'branches',
    'core_events',
    'event_attendees',
    'camp_registrations',
  ],
};

describe('F. H19: app tables only through the declared seams; an app-only change still runs this suite', () => {
  const tables = appTables();
  const declaration = readFileSync(join(DB_SRC, 'schema', 'otoapp.ts'), 'utf8');
  /** `otoappUsers` → `users`, read off the narrow re-declaration itself. */
  const declared = new Map(
    [...declaration.matchAll(/export const (\w+) = otoapp\.table\(\s*'([a-z_0-9]+)'/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );

  const named = (path: string): Set<string> => {
    const text = code(readFileSync(path, 'utf8'));
    const raw = [...text.matchAll(/\botoapp\.([a-z_0-9]+)\b/g)]
      .map((m) => m[1]!)
      .filter((t) => tables.has(t));
    const viaDeclaration = [...declared]
      .filter(([ident]) => new RegExp(`\\b${ident}\\b`).test(text))
      .map(([, t]) => t);
    return new Set([...raw, ...viaDeclaration]);
  };

  it('reads the app’s HR and rota tables out of its own migrations', () => {
    for (const t of [
      'employees',
      'employee_documents',
      'payslips',
      'schedule_assignments',
      'shift_groups',
      'duty_blocks',
      'employee_time_off',
    ]) {
      expect(tables.has(t), t).toBe(true);
    }
    expect(tables.size).toBeGreaterThan(150);
  });

  it('the re-declaration in packages/db names exactly the seam tables', () => {
    expect(new Set(declared.values())).toEqual(new Set(SEAMS['packages/db/src/schema/otoapp.ts']));
  });

  it('no platform file names an app table outside its declared seam', () => {
    const files = [...sourceFiles(SRC), ...sourceFiles(DB_SRC)];
    const outside = files.flatMap((path) => {
      const rel = relative(REPO, path).split('\\').join('/');
      const allowed = new Set(SEAMS[rel] ?? []);
      return [...named(path)].filter((t) => !allowed.has(t)).map((t) => `${rel}: ${t}`);
    });
    expect(outside).toEqual([]);
  });

  it('CI: a change to the app’s migrations, its directory or the modules this suite loads counts as a workspace change', () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const seam = /APP_SEAM='([^']+)'/.exec(ci)?.[1];
    expect(seam, 'ci.yml declares APP_SEAM').toBeTruthy();
    const re = new RegExp(seam!);
    for (const path of [
      'apps/oto-app/migrations/0005_next.sql',
      'apps/oto-app/migrations/meta/_journal.json',
      'apps/oto-app/server/directory/eventWrites.ts',
      'apps/oto-app/server/lib/userDeletion.ts',
      'apps/oto-app/server/lib/routeFences.ts',
    ]) {
      expect(re.test(path), path).toBe(true);
    }
    for (const path of [
      'apps/oto-app/client/src/pages/scheduling-page.tsx',
      'apps/oto-app/server/storage.ts',
    ]) {
      expect(re.test(path), path).toBe(false);
    }
    // And the flag reads it: workspace is true for an app file the seam names.
    expect(ci).toMatch(/grep -q -E "\$APP_SEAM"/);
  });

  it('CI: an OTO App job builds the app, runs its migrator twice from empty, and drives the route checks', () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('\n  oto-app:'));
    expect(job.length).toBeGreaterThan(100);
    expect(job).toMatch(/npm ci/);
    expect(job).toMatch(/npm run build/);
    expect(job.match(/npm run db:migrate/g)).toHaveLength(2);
    expect(job).toMatch(/tests\/route-fences\.check\.ts/);
  });
});

// =============================================================================
// G. H26 and H28 over HTTP, on the routes as registered
// =============================================================================

describe.skipIf(!HAS_APP_RUNTIME)(
  "G. H26 and H28 over HTTP: the app's routes, booted twice",
  () => {
    it('apps/oto-app/tests/route-fences.check.ts passes against a fresh database', async () => {
      const { url, drop } = await createTestDatabase({ otoapp: true });
      try {
        const result = spawnSync(
          process.execPath,
          [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/route-fences.check.ts'],
          {
            cwd: APP_DIR,
            env: { ...process.env, DATABASE_URL: url },
            encoding: 'utf8',
            timeout: 240_000,
          },
        );
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        expect(result.status, output).toBe(0);
        expect(output).toMatch(/route-fences\.check: \d+ checks passed/);
      } finally {
        await drop();
      }
    }, 300_000);
  },
);
