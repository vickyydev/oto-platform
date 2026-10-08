import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appIdentity,
  censusAppBranchIdCase,
  findAppBranchForCore,
  mapCoreBranchIntoApp,
  mappedAppBranches,
  otoappUsers,
} from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-17b round 1 (SCRUM-193 under SCRUM-191) — THE RE-CHECK of the fix round
 * (lane/s217b-r1, head 5fe15ded), beside the round's `s217b-r1.test.ts` and the
 * review's `s217b-r1-review.test.ts`. Each of the review's five findings is
 * driven again from the attacking side, with shapes neither file used:
 *
 *  A. Finding 4, a cross-group collision manufactured by hand — in full upper
 *     case and in mixed case, beside this operator's lower-case rows: never a
 *     mapped branch, never an anchor, never the row a lookup, a provisioning,
 *     a new park or the Console's mapping lands on, never on the unlinked list
 *     for the operator's admin or either park's manager.
 *  E. Finding 5, roles outside the six in every shape (empty, a case variant,
 *     Thai, markup, 512 characters, padded): listed as stored, list 200.
 *  B. Over HTTP, the app booted as production, staging and a laptop:
 *     1. Finding 1 — four more admins the app cannot place (two park groups'
 *        rows, a seat in another park group's branch, an operator admin whose
 *        operator is elsewhere, a global admin with no row) against both
 *        repairs and both triggers; not one row changes, and a placed admin
 *        still changes only their own park group.
 *     2. Finding 2 — a linked, a referenced and a linked-and-referenced user,
 *        and a linked user found through an employee's own email, through all
 *        four doors with every caller; not one row changes and every
 *        `core.app_identity` still names a user. A user nothing points at is
 *        still deleted at every door.
 *     3. Finding 3 — the branch edit with the platform's columns in every
 *        shape (null on a mapped row, upper case, another park's id, snake and
 *        case variants, `__proto__`, a duplicate key, a form body, beside a
 *        real field): the join and the sync record never change.
 *
 * New findings were pinned with `it.fails` (the repo's review convention), none
 * blocking the round. All three were carried by S2-17b round 2 and are FIXED
 * there; each pin is flipped where it stands:
 *
 *  6. (low, pre-existing; the builder's question 2) Link claims an OTO App
 *     user of a park group this operator is not anchored in, by typed id (A).
 *  7. (low; the builder's question 4) a park group whose only claim on this
 *     operator is a case collision is open again to the first-time name match,
 *     which main fenced: a new park named like one of its rows is mapped into
 *     it, and that park group becomes this operator's without a person (A).
 *  8. (low-medium, pre-existing) another park group's admin deletes park group
 *     A's employee — and the user that goes with them — through the employee
 *     and people doors, which check no park group (B2).
 *
 * Section B needs the app's own node_modules (a developer's machine with the
 * junction); like the round's section G it is skipped where they are absent.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);

const DEACTIVATE_INSTEAD = 'Deactivate this account to preserve its HR record';
const PASSWORD = 'zz-recheck-password';

let ctx: TestContext;
let admin: string;
let operatorId: string;
let central: string;
let chalong: string;
let appPool: pg.Pool;
let dbUrl: string;
/** The app's park group this operator is anchored in. */
const tenantA = newId();
/** Another park group, anchored to nobody here. */
const tenantB = newId();
let appCentral: string;
let appChalong: string;
let appBranchB: string;

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> => (await appPool.query<T>(text, params)).rows;

async function appBranch(opts: {
  name: string;
  tenantId?: string;
  coreBranchId?: string | null;
}): Promise<string> {
  const id = newId();
  await q(
    `insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST', $4)`,
    [id, opts.tenantId ?? tenantA, opts.name, opts.coreBranchId ?? null],
  );
  return id;
}

/** The app's own password format: scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

/**
 * An app user. `seats` are its branch-access rows: one per entry, `null`
 * branch meaning all of that park group's branches; an empty list is a user
 * with no row at all.
 */
async function appUser(opts: {
  seats: Array<{ tenantId: string; branchId: string | null }>;
  role?: string;
  email?: string;
  operatorId?: string | null;
}): Promise<{ id: string; email: string }> {
  const id = newId();
  const email = opts.email ?? `zz-recheck-${id}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, operator_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [
      id,
      email,
      hash(PASSWORD),
      `ZZ recheck ${opts.role ?? 'staff'} ${id.slice(-4)}`,
      opts.role ?? 'staff',
      opts.operatorId ?? null,
    ],
  );
  for (const seat of opts.seats) {
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

/** Upper-case every other hex letter: a spelling neither lower nor upper case. */
function mixedCase(id: string): string {
  let letter = 0;
  const out = [...id]
    .map((c) => (/[a-f]/.test(c) ? (letter++ % 2 === 0 ? c.toUpperCase() : c) : c))
    .join('');
  if (out === id.toLowerCase() || out === id.toUpperCase()) {
    throw new Error(`no mixed spelling of ${id}`);
  }
  return out;
}

const unlinked = async (cookie: string) => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/admin/apps/oto_app/unlinked-users',
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { users: Array<{ id: string; role: string }> }).users;
};

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  operatorId = (
    await ctx.db.execute<{ o: string }>(
      sql`select operator_id::text as o from core.branch where id = ${central}`,
    )
  ).rows[0]!.o;

  dbUrl = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
  appPool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=otoapp', max: 6 });

  await q(
    `insert into tenants (id, name, slug) values ($1, 'ZZ recheck park group A', 'zz-recheck-a'), ($2, 'ZZ recheck park group B', 'zz-recheck-b')`,
    [tenantA, tenantB],
  );
  appCentral = await appBranch({ name: 'ZZ recheck app Central', coreBranchId: central });
  appChalong = await appBranch({ name: 'ZZ recheck app Chalong', coreBranchId: chalong });
  appBranchB = await appBranch({ name: 'ZZ recheck park B', tenantId: tenantB });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// A. Finding 4: a cross-group collision, from the attacking side
// =============================================================================

describe('A. a cross-group collision, upper and mixed case: never mapped, never listed, never linkable', () => {
  let upperB: string;
  let mixedB: string;
  let seatedUpper: string;
  let seatedMixed: string;
  let everyB: string;
  let plainB: string;
  let linkTarget: string;

  beforeAll(async () => {
    // Park group B spells this operator's two parks: Chalong in upper case,
    // Central in a mixed case. Both beside the lower-case rows in A.
    upperB = await appBranch({
      name: 'ZZ recheck B claims Chalong',
      tenantId: tenantB,
      coreBranchId: chalong.toUpperCase(),
    });
    mixedB = await appBranch({
      name: 'ZZ recheck B claims Central',
      tenantId: tenantB,
      coreBranchId: mixedCase(central),
    });
    seatedUpper = (await appUser({ seats: [{ tenantId: tenantB, branchId: upperB }] })).id;
    seatedMixed = (await appUser({ seats: [{ tenantId: tenantB, branchId: mixedB }] })).id;
    everyB = (await appUser({ seats: [{ tenantId: tenantB, branchId: null }] })).id;
    plainB = (await appUser({ seats: [{ tenantId: tenantB, branchId: appBranchB }] })).id;
    linkTarget = (await appUser({ seats: [{ tenantId: tenantB, branchId: upperB }] })).id;
  });

  const parkGroupBUsers = () => [seatedUpper, seatedMixed, everyB, plainB, linkTarget];

  it('both are collisions the census names, and two reconciliations lower neither and merge nothing', async () => {
    const census = await censusAppBranchIdCase(ctx.db);
    expect(census.collisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ appBranchId: upperB, canonical: chalong, heldBy: appChalong }),
        expect.objectContaining({ appBranchId: mixedB, canonical: central, heldBy: appCentral }),
      ]),
    );
    const run = async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/branches/oto-app/reconcile',
        headers: { cookie: admin },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as {
        caseLowered: Array<{ appBranchId: string }>;
        caseCollisions: Array<{ appBranchId: string }>;
        matchedByName: Array<{ appBranchId: string }>;
        writes: number;
      };
    };
    const first = await run();
    expect(first.caseCollisions.map((c) => c.appBranchId)).toEqual(
      expect.arrayContaining([upperB, mixedB]),
    );
    for (const row of [upperB, mixedB]) {
      expect(first.caseLowered.map((c) => c.appBranchId)).not.toContain(row);
    }
    expect(first.matchedByName.map((m) => m.appBranchId)).not.toContain(appBranchB);
    const second = await run();
    expect(second.writes).toBe(0);
    const spelled = await q<{ id: string; core_branch_id: string | null; tenant_id: string }>(
      `select id, core_branch_id, tenant_id::text as tenant_id from branches where id = any($1) order by id`,
      [[upperB, mixedB, appBranchB, appCentral, appChalong]],
    );
    expect(Object.fromEntries(spelled.map((r) => [r.id, r.core_branch_id]))).toEqual({
      [upperB]: chalong.toUpperCase(),
      [mixedB]: mixedCase(central),
      [appBranchB]: null,
      [appCentral]: central,
      [appChalong]: chalong,
    });
  });

  it('never mapped: no mapped branch, no anchor, and park group B is not made this operator’s', async () => {
    const mapped = await mappedAppBranches(ctx.db, operatorId);
    expect(mapped.map((m) => m.id).sort()).toEqual([appCentral, appChalong].sort());
    expect(new Set(mapped.map((m) => m.tenantId))).toEqual(new Set([tenantA]));

    // Every spelling of either park finds A's row, never B's.
    for (const [park, row] of [
      [chalong, appChalong],
      [central, appCentral],
    ] as const) {
      for (const spelled of [park, park.toUpperCase(), mixedCase(park)]) {
        const found = await findAppBranchForCore(ctx.db, {
          operatorId,
          coreBranchId: spelled,
          name: 'ZZ recheck B claims Chalong',
        });
        expect(found !== 'ambiguous' && found?.id, spelled).toBe(row);
        const made = await mapCoreBranchIntoApp(ctx.db, {
          operatorId,
          branchId: spelled,
          name: 'ZZ',
          address: null,
          timezone: 'Asia/Bangkok',
        });
        expect(made, spelled).toMatchObject({ appBranchId: row, mappedBy: 'core_branch_id' });
      }
    }

    // The Console's mapping: each park shows A's row; B's rows are nobody's list.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/branches/oto-app',
      headers: { cookie: admin },
    });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as {
      branches: Array<{ branchId: string; appBranchId: string | null }>;
      appOnly: Array<{ appBranchId: string }>;
    };
    expect(view.branches.find((b) => b.branchId === central)?.appBranchId).toBe(appCentral);
    expect(view.branches.find((b) => b.branchId === chalong)?.appBranchId).toBe(appChalong);
    const shown = [
      ...view.branches.map((b) => b.appBranchId),
      ...view.appOnly.map((r) => r.appBranchId),
    ];
    for (const row of [upperB, mixedB, appBranchB]) expect(shown).not.toContain(row);
  });

  it('a new park opened on the platform is made in park group A, and provisioning at Chalong in any spelling seats A’s row', async () => {
    const id = newId();
    const opened = await ctx.app.inject({
      method: 'POST',
      url: '/branches',
      headers: { cookie: admin },
      payload: {
        id,
        name: 'ZZ recheck fresh park',
        code: `zz-recheck-${id.slice(-8)}`,
        timezone: 'Asia/Bangkok',
      },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const { otoApp } = opened.json() as {
      otoApp: { appBranchId: string | null; mappedBy: string | null };
    };
    expect(otoApp.mappedBy).toBe('created');
    expect(
      await q(`select tenant_id::text as t from branches where id = $1`, [otoApp.appBranchId]),
    ).toEqual([{ t: tenantA }]);

    for (const [i, spelled] of [chalong.toUpperCase(), mixedCase(chalong)].entries()) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/admin/apps/oto_app/users',
        headers: { cookie: admin },
        payload: {
          phone: `+6690000791${i}`,
          name: `ZZ recheck seat ${i}`,
          branchId: spelled,
          otoApp: { email: `zz-recheck-seat-${i}@example.com`, role: 'staff' },
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      const { externalUserId } = res.json() as { externalUserId: string };
      expect(
        await q(
          `select branch_id, tenant_id::text as tenant_id from user_branch_access where user_id = $1`,
          [externalUserId],
        ),
        spelled,
      ).toEqual([{ branch_id: appChalong, tenant_id: tenantA }]);
    }
  });

  it('never listed: not for the operator’s admin, nor for either park’s manager', async () => {
    for (const cookie of [
      admin,
      await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password),
      await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password),
    ]) {
      const ids = (await unlinked(cookie)).map((u) => u.id);
      for (const hidden of parkGroupBUsers()) expect(ids).not.toContain(hidden);
    }
  });

  /**
   * FINDING 6 (low, pre-existing; the builder's question 2). The fix keeps park
   * group B's people off the list, so the Console never offers them — but Link
   * itself (`POST /admin/apps/oto_app/users` with `externalUserId`) stamps any
   * unstamped app user by id, whatever park group they are in, and the account
   * then signs into that park group's data from the launcher. The review's
   * finding 4 named Link beside the list; only the list was in the fix. Link
   * should refuse a user the unlinked list would not show this operator.
   */
  it.fails('Link refuses a user of a park group this operator is not anchored in', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: admin },
      payload: { phone: '+66900007919', name: 'ZZ recheck link', externalUserId: linkTarget },
    });
    const [stamped] = await ctx.db
      .select({ p: otoappUsers.platformUserId })
      .from(otoappUsers)
      .where(eq(otoappUsers.id, linkTarget));
    expect(stamped?.p ?? null).toBeNull();
    expect(res.statusCode).not.toBe(200);
  });

  /**
   * FINDING 7 (low; the builder's question 4). `foreignTenantsOf` is the fence
   * around the first-time NAME match. On main a row in park group B carrying
   * this operator's id in another case fenced B off (read as somebody else's);
   * the fix reads a collision as nobody's, so B is open again — and a new park
   * named like one of B's rows is mapped into it by name. From then on B holds
   * a lower-case row of this operator's: B is this operator's, its people are
   * on the list and its rows are the anchor's peers, which is what the census
   * says only a person may settle. A collision should still fence its park
   * group from the name match while counting as nobody's mapping.
   *
   * FIXED IN S2-17b ROUND 2: `foreignTenantsOf` fences a park group whose only
   * tie is a colliding row, while the collision still anchors and maps
   * nothing. Pin flipped.
   */
  it(
    'a park group whose only claim is a collision is not open to the first-time name match',
    async () => {
      const lagoonB = await appBranch({ name: 'ZZ recheck Lagoon', tenantId: tenantB });
      try {
        const id = newId();
        const opened = await ctx.app.inject({
          method: 'POST',
          url: '/branches',
          headers: { cookie: admin },
          payload: {
            id,
            name: 'ZZ recheck Lagoon',
            code: `zz-recheck-${id.slice(-8)}`,
            timezone: 'Asia/Bangkok',
          },
        });
        expect(opened.statusCode, opened.body).toBe(200);
        const { otoApp } = opened.json() as { otoApp: { appBranchId: string | null } };
        expect(otoApp.appBranchId).not.toBe(lagoonB);
        expect(await q(`select core_branch_id from branches where id = $1`, [lagoonB])).toEqual([
          { core_branch_id: null },
        ]);
      } finally {
        // Whatever happened, B goes back to holding no row of this operator's.
        await q(
          `update branches set core_branch_id = null, core_sync_status = null, core_synced_at = null, core_sync_error = null where id = $1`,
          [lagoonB],
        );
      }
    },
  );
});

// =============================================================================
// E. Finding 5: a role outside the six, in every shape
// =============================================================================

describe('E. a role outside the six, in every shape: listed as stored, and the list answers', () => {
  const ROLES = [
    '',
    'ADMIN',
    'hr_officer',
    'ผู้จัดการสาขา',
    '<img src=x onerror=alert(1)>',
    'r'.repeat(512),
    ' staff ',
    'advisor',
  ];
  const made = new Map<string, string>();

  beforeAll(async () => {
    for (const role of ROLES) {
      made.set(
        (await appUser({ seats: [{ tenantId: tenantA, branchId: appCentral }], role })).id,
        role,
      );
    }
  });

  afterAll(async () => {
    for (const id of made.keys()) {
      await q(`delete from user_branch_access where user_id = $1`, [id]);
      await q(`delete from users where id = $1`, [id]);
    }
  });

  it('to the operator’s admin and to Central’s manager, each word exactly as the database holds it', async () => {
    for (const cookie of [
      admin,
      await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password),
    ]) {
      const users = await unlinked(cookie);
      for (const [id, role] of made) {
        expect(users.find((u) => u.id === id)?.role, JSON.stringify(role)).toBe(role);
      }
    }
  });
});

// =============================================================================
// B. Over HTTP: findings 1, 2 and 3
// =============================================================================

interface ParkGroupRows {
  pending: string;
  departedUser: string;
  leaving: string;
  photo: string;
}

const OLD_PHOTO = '/profile-photos/zz-recheck.jpg';

async function employeeRow(fields: Record<string, unknown>): Promise<string> {
  const id = newId();
  const all: Record<string, unknown> = {
    id,
    full_name: `ZZ recheck employee ${id.slice(-4)}`,
    nickname: 'ZZ',
    email: `zz-recheck-emp-${id}@example.com`,
    ...fields,
  };
  const cols = Object.keys(all);
  await q(
    `insert into employees (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(all),
  );
  return id;
}

async function maintenanceRows(
  tenantId: string,
  branchId: string,
  by: string,
): Promise<ParkGroupRows> {
  const at = { tenant_id: tenantId, branch_id: branchId };
  const pending = await employeeRow({ ...at, status: 'pending' });
  const template = newId();
  await q(`insert into templates (id, name, html_body) values ($1, $2, '<p>ZZ</p>')`, [
    template,
    `ZZ recheck ${template.slice(-4)}`,
  ]);
  await q(
    `insert into contract_instances (employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json, created_by, signing_status)
     values ($1, $2, '<p>ZZ</p>', 1, '{}'::jsonb, $3, 'signed')`,
    [pending, template, by],
  );
  const departedUser = (await appUser({ seats: [{ tenantId, branchId: null }] })).id;
  await employeeRow({ ...at, last_working_day: '2020-01-01', user_id: departedUser });
  const leaving = await employeeRow({
    ...at,
    employment_state: 'LEAVING',
    last_working_day: '2020-01-01',
  });
  const photo = await employeeRow({ ...at, profile_photo_path: OLD_PHOTO });
  return { pending, departedUser, leaving, photo };
}

async function stateOf(g: ParkGroupRows) {
  const [emp] = await q<{ status: string }>(`select status from employees where id = $1`, [
    g.pending,
  ]);
  const [dep] = await q<{ is_active: boolean }>(`select is_active from users where id = $1`, [
    g.departedUser,
  ]);
  const [lea] = await q<{ employment_state: string }>(
    `select employment_state from employees where id = $1`,
    [g.leaving],
  );
  const [pho] = await q<{ profile_photo_path: string | null }>(
    `select profile_photo_path from employees where id = $1`,
    [g.photo],
  );
  return {
    pending: emp!.status,
    departedActive: dep!.is_active,
    leaving: lea!.employment_state,
    photo: pho!.profile_photo_path,
  };
}
const UNTOUCHED = {
  pending: 'pending',
  departedActive: true,
  leaving: 'LEAVING',
  photo: OLD_PHOTO,
};

/** Every table of the app, hashed row by row. `session` is left out: signing in writes it. */
async function appTables(): Promise<Record<string, string>> {
  const tables = (
    await q<{ t: string }>(
      `select table_name as t from information_schema.tables
        where table_schema = 'otoapp' and table_type = 'BASE TABLE' and table_name <> 'session' order by 1`,
    )
  ).map((r) => r.t);
  const rows = await q<{ t: string; h: string }>(
    tables
      .map(
        (t) =>
          `select '${t}' as t, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from otoapp."${t}" x`,
      )
      .join(' union all '),
  );
  return Object.fromEntries(rows.map((r) => [r.t, r.h]));
}

const identityRows = async () =>
  (
    await ctx.db.execute<{ h: string }>(
      sql`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from core.app_identity x`,
    )
  ).rows[0]!.h;

/** The boot guard refuses a deployment whose DATABASE_URL names localhost; the same database, with the host as a parameter. */
function hostAsParameter(url: string): string {
  const u = new URL(url);
  const params = new URLSearchParams(u.search);
  params.set('host', u.hostname);
  params.set('port', u.port || '5432');
  return `${u.protocol}//${u.username}:${u.password}@${u.pathname}?${params}`;
}

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
        STORAGE_ENV_PREFIX: 'zz-recheck',
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

const deploymentEnv = (deployEnv: 'staging' | 'production', jobs: 'platform' | 'inprocess') => {
  const url = hostAsParameter(dbUrl);
  return {
    DEPLOY_ENV: deployEnv,
    OTOAPP_JOBS: jobs,
    DATABASE_URL: url,
    SESSION_SECRET: randomBytes(24).toString('hex'),
    SESSION_PEPPER: randomBytes(24).toString('hex'),
    KIOSK_CODE_PEPPER: randomBytes(24).toString('hex'),
    PIN_FINGERPRINT_SECRET: randomBytes(24).toString('hex'),
    OBJECT_STORAGE: 's3',
    S3_BUCKET: 'zz-recheck-bucket',
    S3_ENDPOINT: 'zz-recheck.invalid',
    AWS_ACCESS_KEY_ID: 'zz-recheck',
    AWS_SECRET_ACCESS_KEY: 'zz-recheck',
  };
};

interface Answer {
  status: number;
  text: string;
  body: Record<string, unknown>;
  cookie: string;
}

async function send(
  origin: string,
  method: string,
  path: string,
  opts: { cookie?: string; raw?: string; contentType?: string; body?: unknown } = {},
): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'content-type': opts.contentType ?? 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body:
      method === 'GET'
        ? undefined
        : (opts.raw ?? JSON.stringify(opts.body === undefined ? {} : opts.body)),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON; kept as text.
  }
  return {
    status: res.status,
    text,
    body,
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}

async function appSignIn(origin: string, email: string): Promise<string> {
  const res = await send(origin, 'POST', '/api/login', {
    body: { identifier: email, password: PASSWORD },
  });
  expect(res.status, `sign-in as ${email}: ${res.text}`).toBe(200);
  expect(res.cookie).toBeTruthy();
  return res.cookie;
}

const REPAIRS = [
  '/api/admin/backfill-employee-photos',
  '/api/admin/fix-pending-with-signed-contracts',
] as const;
const TRIGGERS = [
  '/api/admin/run-departed-deactivation',
  '/api/scheduler/transition-left',
] as const;

describe.skipIf(!HAS_APP_RUNTIME)('B. the app over HTTP: production, staging and a laptop', () => {
  type Where = 'production' | 'staging' | 'local';
  const WHERE: Where[] = ['production', 'staging', 'local'];
  const origin: Record<Where, string> = { production: '', staging: '', local: '' };

  /** Who signs in, by name. */
  const people = {
    adminA: { id: '', email: '' },
    staffA: { id: '', email: '' },
    adminB: { id: '', email: '' },
    /** No branch-access row, in a database of two park groups. */
    noRow: { id: '', email: '' },
    /** All branches of A and all branches of B. */
    twoGroups: { id: '', email: '' },
    /** A row in park group A naming a branch of park group B. */
    crossSeat: { id: '', email: '' },
    /** An operator admin seated in A whose operator is B's. */
    foreignOperator: { id: '', email: '' },
    /** A global admin with no row. */
    globalNoRow: { id: '', email: '' },
  };
  type Who = keyof typeof people;
  const UNPLACEABLE: Who[] = ['noRow', 'twoGroups', 'crossSeat', 'foreignOperator', 'globalNoRow'];
  const cookies: Record<Where, Partial<Record<Who, string>>> = {
    production: {},
    staging: {},
    local: {},
  };
  const as = (where: Where, who: Who | 'none') =>
    who === 'none' ? {} : { cookie: cookies[where][who]! };

  let A: ParkGroupRows;
  let B: ParkGroupRows;

  beforeAll(async () => {
    people.adminA = await appUser({
      seats: [{ tenantId: tenantA, branchId: null }],
      role: 'admin',
    });
    people.staffA = await appUser({ seats: [{ tenantId: tenantA, branchId: appCentral }] });
    people.adminB = await appUser({
      seats: [{ tenantId: tenantB, branchId: null }],
      role: 'admin',
    });
    people.noRow = await appUser({ seats: [], role: 'admin' });
    people.twoGroups = await appUser({
      seats: [
        { tenantId: tenantA, branchId: null },
        { tenantId: tenantB, branchId: null },
      ],
      role: 'admin',
    });
    people.crossSeat = await appUser({
      seats: [{ tenantId: tenantA, branchId: appBranchB }],
      role: 'admin',
    });
    const operatorB = newId();
    await q(
      `insert into operators (id, tenant_id, name) values ($1, $2, 'ZZ recheck operator B')`,
      [operatorB, tenantB],
    );
    people.foreignOperator = await appUser({
      seats: [{ tenantId: tenantA, branchId: null }],
      role: 'operator_admin',
      operatorId: operatorB,
    });
    people.globalNoRow = await appUser({ seats: [], role: 'global_admin' });

    A = await maintenanceRows(tenantA, appCentral, people.adminA.id);
    B = await maintenanceRows(tenantB, appBranchB, people.adminB.id);

    const [production, staging, local] = await Promise.all([
      serve(deploymentEnv('production', 'inprocess')),
      serve(deploymentEnv('staging', 'platform')),
      serve({ DEPLOY_ENV: 'local', OTOAPP_JOBS: 'inprocess', DATABASE_URL: dbUrl }),
    ]);
    Object.assign(origin, { production, staging, local });
    for (const where of WHERE) {
      for (const who of Object.keys(people) as Who[]) {
        cookies[where][who] = await appSignIn(origin[where], people[who].email);
      }
    }
  }, 300_000);

  afterAll(() => {
    for (const child of children) child.kill();
  });

  // ── 1. Finding 1: the admin the app cannot place ─────────────────────────────
  describe('1. maintenance routes: every admin the app cannot place is refused, and nothing changes', () => {
    it('the arrangement: each one signs in and is given a park group by the session, and the app’s own User Management refuses each', async () => {
      for (const who of UNPLACEABLE) {
        const me = await send(origin.local, 'GET', '/api/user', as('local', who));
        expect(me.status, `${who}: ${me.text}`).toBe(200);
        expect(me.body.tenantId, who).toBeTruthy();
        const users = await send(origin.local, 'GET', '/api/users', as('local', who));
        expect(users.status, `${who}: ${users.text}`).toBe(403);
      }
    });

    it('production and a laptop: both repairs and both triggers answer 403 "no park group" to all five', async () => {
      const before = await appTables();
      for (const where of ['production', 'local'] as const) {
        for (const who of UNPLACEABLE) {
          for (const path of [...REPAIRS, ...TRIGGERS]) {
            const res = await send(origin[where], 'POST', path, as(where, who));
            expect(res.status, `${where} ${path} as ${who}: ${res.text}`).toBe(403);
            expect(res.body.reason, `${where} ${path} as ${who}`).toBe('no_park_group');
          }
        }
      }
      expect(await appTables()).toEqual(before);
      expect(await stateOf(A)).toEqual(UNTOUCHED);
      expect(await stateOf(B)).toEqual(UNTOUCHED);
    });

    it('staging: the repairs refuse all five as "no park group", the triggers point at the Console, and nothing changes', async () => {
      const before = await appTables();
      for (const who of UNPLACEABLE) {
        for (const path of REPAIRS) {
          const res = await send(origin.staging, 'POST', path, as('staging', who));
          expect(res.status, `${path} as ${who}: ${res.text}`).toBe(403);
          expect(res.body.reason).toBe('no_park_group');
        }
        for (const path of TRIGGERS) {
          const res = await send(origin.staging, 'POST', path, as('staging', who));
          expect(res.status, `${path} as ${who}: ${res.text}`).toBe(409);
          expect(res.body.reason).toBe('jobs_on_platform');
        }
      }
      expect(await appTables()).toEqual(before);
    });
  });

  // ── 2. Finding 2: every door that deletes a user ─────────────────────────────
  describe('2. every door that deletes a user, every caller', () => {
    interface Fixture {
      user: string;
      email: string;
      person: string;
      employee: string;
      reason: 'linked_to_platform' | 'still_referenced';
    }
    const fixtures: Record<'linked' | 'referenced' | 'both' | 'byEmployeeEmail', Fixture> = {
      linked: { user: '', email: '', person: '', employee: '', reason: 'linked_to_platform' },
      referenced: { user: '', email: '', person: '', employee: '', reason: 'still_referenced' },
      both: { user: '', email: '', person: '', employee: '', reason: 'linked_to_platform' },
      byEmployeeEmail: {
        user: '',
        email: '',
        person: '',
        employee: '',
        reason: 'linked_to_platform',
      },
    };
    /** A second person for the linked user, carrying its email in capitals. */
    let shoutedPerson = '';
    let phoneSeq = 0;

    async function provisioned(label: string): Promise<{ user: string; email: string }> {
      const email = `zz-recheck-${label}-${randomUUID().slice(0, 6)}@example.com`;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/admin/apps/oto_app/users',
        headers: { cookie: admin },
        payload: {
          phone: `+669000079${String(20 + phoneSeq++).padStart(2, '0')}`,
          name: `ZZ recheck ${label}`,
          branchId: central,
          otoApp: { email, role: 'staff' },
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { user: (res.json() as { externalUserId: string }).externalUserId, email };
    }

    async function person(email: string): Promise<string> {
      const id = newId();
      await q(
        `insert into people (id, full_name, email, person_type) values ($1, 'ZZ recheck person', $2, 'employee')`,
        [id, email],
      );
      await q(
        `insert into access_policies (tenant_id, person_id, access_level, modules, branch_scope) values ($1, $2, 'staff', '[]'::jsonb, 'ALL')`,
        [tenantA, id],
      );
      return id;
    }

    /** What an employee delete would archive, return and clear — so a refusal that wrote first shows. */
    async function history(employee: string): Promise<void> {
      const template = newId();
      await q(`insert into templates (id, name, html_body) values ($1, $2, '<p>ZZ</p>')`, [
        template,
        `ZZ recheck history ${template.slice(-4)}`,
      ]);
      await q(
        `insert into contract_instances (employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json, created_by, status)
         values ($1, $2, '<p>ZZ</p>', 1, '{}'::jsonb, $3, 'active')`,
        [employee, template, people.adminA.id],
      );
      await q(
        `insert into employee_assets (employee_id, asset_name_snapshot, assigned_by) values ($1, 'ZZ recheck key', $2)`,
        [employee, people.adminA.id],
      );
      await q(
        `insert into activity_log (employee_id, activity_type, summary_text) values ($1, 'ZZ_RECHECK', 'ZZ recheck')`,
        [employee],
      );
    }

    beforeAll(async () => {
      // Linked by the platform, with an employee whose login it is.
      const linked = await provisioned('linked');
      const linkedPerson = await person(linked.email);
      const linkedEmployee = await employeeRow({
        tenant_id: tenantA,
        branch_id: appCentral,
        email: linked.email,
        person_id: linkedPerson,
        user_id: linked.user,
      });
      await history(linkedEmployee);
      fixtures.linked = {
        ...fixtures.linked,
        ...linked,
        person: linkedPerson,
        employee: linkedEmployee,
      };
      shoutedPerson = await person(linked.email.toUpperCase());

      // Referenced by the app, never linked; its employee carries no login.
      const referenced = await appUser({ seats: [{ tenantId: tenantA, branchId: appCentral }] });
      await q(
        `insert into user_module_overrides (tenant_id, user_id, module_key) values ($1, $2, 'ops')`,
        [tenantA, referenced.id],
      );
      const referencedPerson = await person(referenced.email);
      const referencedEmployee = await employeeRow({
        tenant_id: tenantA,
        branch_id: appCentral,
        email: referenced.email,
        person_id: referencedPerson,
      });
      await history(referencedEmployee);
      fixtures.referenced = {
        ...fixtures.referenced,
        user: referenced.id,
        email: referenced.email,
        person: referencedPerson,
        employee: referencedEmployee,
      };

      // Both at once: linked wins the answer.
      const both = await provisioned('both');
      await q(
        `insert into user_module_overrides (tenant_id, user_id, module_key) values ($1, $2, 'ops')`,
        [tenantA, both.user],
      );
      const bothPerson = await person(both.email);
      const bothEmployee = await employeeRow({
        tenant_id: tenantA,
        branch_id: appCentral,
        email: both.email,
        person_id: bothPerson,
      });
      await history(bothEmployee);
      fixtures.both = { ...fixtures.both, ...both, person: bothPerson, employee: bothEmployee };

      // Linked, found by the employee delete through the employee's OWN email
      // (no person record linked to the employee, one carrying that email).
      const byEmail = await provisioned('by-email');
      const byEmailPerson = await person(byEmail.email);
      const byEmailEmployee = await employeeRow({
        tenant_id: tenantA,
        branch_id: appCentral,
        email: byEmail.email,
      });
      await history(byEmailEmployee);
      fixtures.byEmployeeEmail = {
        ...fixtures.byEmployeeEmail,
        ...byEmail,
        person: byEmailPerson,
        employee: byEmailEmployee,
      };
    });

    const exists = async (table: 'users' | 'people' | 'employees', id: string) =>
      (await q(`select 1 from ${table} where id = $1`, [id])).length === 1;
    const seats = async (userId: string) =>
      Number(
        (
          await q<{ n: string }>(
            `select count(*) as n from user_branch_access where user_id = $1`,
            [userId],
          )
        )[0]!.n,
      );

    it('a linked, a referenced and a linked-and-referenced user survive all four doors for every caller, and not one row changes', async () => {
      const appBefore = await appTables();
      const identityBefore = await identityRows();
      const CALLERS = ['none', 'staffA', 'adminB', 'noRow', 'adminA'] as const;
      const all = Object.values(fixtures);

      for (const who of CALLERS) {
        const opts = as('local', who);
        // The users door: its own HR-record check answers first for all of these.
        for (const f of all) {
          const res = await send(origin.local, 'DELETE', `/api/users/${f.user}`, opts);
          const expected = { none: 401, staffA: 403, adminB: 404, noRow: 403, adminA: 409 }[who];
          expect(res.status, `users door, ${f.reason}, as ${who}: ${res.text}`).toBe(expected);
          if (who === 'adminA') expect(res.body.message).toBe(DEACTIVATE_INSTEAD);
        }
        // The people door (no park group of its own) and the employee door.
        const doors: Array<{
          door: 'people' | 'employees';
          target: string;
          reason: Fixture['reason'];
        }> = [
          ...all.map((f) => ({ door: 'people' as const, target: f.person, reason: f.reason })),
          { door: 'people', target: shoutedPerson, reason: 'linked_to_platform' },
          ...all.map((f) => ({ door: 'employees' as const, target: f.employee, reason: f.reason })),
        ];
        for (const { door, target, reason } of doors) {
          const res = await send(origin.local, 'DELETE', `/api/${door}/${target}`, opts);
          const expected = { none: 401, staffA: 403, adminB: 409, noRow: 409, adminA: 409 }[who];
          expect(res.status, `${door} door, ${reason}, as ${who}: ${res.text}`).toBe(expected);
          if (expected === 409) {
            expect(res.body, `${door} door as ${who}`).toEqual({
              message: DEACTIVATE_INSTEAD,
              reason,
            });
          }
        }
        // The bulk door: one refusal per employee, nothing deleted.
        const bulk = await send(origin.local, 'POST', '/api/employees/bulk-delete', {
          ...opts,
          body: { employeeIds: all.map((f) => f.employee) },
        });
        const expected = { none: 401, staffA: 403, adminB: 200, noRow: 200, adminA: 200 }[who];
        expect(bulk.status, `bulk as ${who}: ${bulk.text}`).toBe(expected);
        if (expected === 200) {
          expect(bulk.body).toEqual({
            deletedCount: 0,
            errorCount: all.length,
            results: all.map((f) => ({
              id: f.employee,
              status: 'error',
              message: DEACTIVATE_INSTEAD,
              reason: f.reason,
            })),
          });
        }
      }

      expect(await appTables()).toEqual(appBefore);
      expect(await identityRows()).toBe(identityBefore);
      for (const f of all) {
        expect(await exists('users', f.user)).toBe(true);
        expect(await seats(f.user)).toBe(1);
        expect(await exists('people', f.person)).toBe(true);
        expect(await exists('employees', f.employee)).toBe(true);
      }
      // Every identity still names a user that exists, stamped with its account.
      const identities = await ctx.db
        .select()
        .from(appIdentity)
        .where(eq(appIdentity.app, 'oto_app'));
      for (const identity of identities) {
        const [user] = await ctx.db
          .select({ p: otoappUsers.platformUserId })
          .from(otoappUsers)
          .where(eq(otoappUsers.id, identity.externalUserId));
        expect(user?.p, identity.externalUserId).toBe(identity.accountId);
      }
    });

    it('a user nothing points at is still deleted by park group A’s admin at every door, with its seat, person and employee', async () => {
      const identityBefore = await identityRows();
      const at = { tenant_id: tenantA, branch_id: appCentral };
      const clean = () => appUser({ seats: [{ tenantId: tenantA, branchId: appCentral }] });

      const viaUsers = await clean();
      const r1 = await send(
        origin.local,
        'DELETE',
        `/api/users/${viaUsers.id}`,
        as('local', 'adminA'),
      );
      expect(r1.status, r1.text).toBe(204);

      const viaPeople = await clean();
      const viaPeoplePerson = await person(viaPeople.email);
      const r2 = await send(
        origin.local,
        'DELETE',
        `/api/people/${viaPeoplePerson}`,
        as('local', 'adminA'),
      );
      expect(r2.status, r2.text).toBe(200);

      const viaEmployee = await clean();
      const viaEmployeePerson = await person(viaEmployee.email);
      const viaEmployeeRow = await employeeRow({
        ...at,
        email: viaEmployee.email,
        person_id: viaEmployeePerson,
      });
      const r3 = await send(
        origin.local,
        'DELETE',
        `/api/employees/${viaEmployeeRow}`,
        as('local', 'adminA'),
      );
      expect(r3.status, r3.text).toBe(204);

      const viaEmployeeEmail = await clean();
      const viaEmployeeEmailPerson = await person(viaEmployeeEmail.email);
      const viaEmployeeEmailRow = await employeeRow({ ...at, email: viaEmployeeEmail.email });
      const r4 = await send(
        origin.local,
        'DELETE',
        `/api/employees/${viaEmployeeEmailRow}`,
        as('local', 'adminA'),
      );
      expect(r4.status, r4.text).toBe(204);

      // Bulk, beside a linked one: that one is refused, this one goes.
      const viaBulk = await clean();
      const viaBulkPerson = await person(viaBulk.email);
      const viaBulkRow = await employeeRow({
        ...at,
        email: viaBulk.email,
        person_id: viaBulkPerson,
      });
      const r5 = await send(origin.local, 'POST', '/api/employees/bulk-delete', {
        ...as('local', 'adminA'),
        body: { employeeIds: [fixtures.linked.employee, viaBulkRow] },
      });
      expect(r5.status, r5.text).toBe(200);
      expect(r5.body).toMatchObject({
        deletedCount: 1,
        errorCount: 1,
        results: [
          { id: fixtures.linked.employee, status: 'error', reason: 'linked_to_platform' },
          { id: viaBulkRow, status: 'deleted' },
        ],
      });

      for (const u of [viaUsers, viaPeople, viaEmployee, viaEmployeeEmail, viaBulk]) {
        expect(await exists('users', u.id), u.email).toBe(false);
        expect(await seats(u.id), u.email).toBe(0);
      }
      for (const p of [viaPeoplePerson, viaEmployeePerson, viaEmployeeEmailPerson, viaBulkPerson]) {
        expect(await exists('people', p)).toBe(false);
      }
      for (const e of [viaEmployeeRow, viaEmployeeEmailRow, viaBulkRow]) {
        expect(await exists('employees', e)).toBe(false);
      }
      expect(await exists('users', fixtures.linked.user)).toBe(true);
      expect(await exists('employees', fixtures.linked.employee)).toBe(true);
      expect(await identityRows()).toBe(identityBefore);
    });

    /**
     * FINDING 8 (low-medium, pre-existing; beside the review's finding 2, which
     * noted the people door has no park group). The employee delete reads the
     * employee by id with no park-group check, and an admin's branch check
     * passes everywhere (`hasAllBranchesAccess`), so park group B's admin
     * deletes park group A's employee and the user that leaves with them; the
     * people door does the same through `people`, which has no park group at
     * all. The fix holds the platform-linked user at both doors, so nothing
     * the platform names is lost — this is the app's own cross-park-group
     * delete, and it should answer 404 the way the users door does.
     */
    it.fails(
      'another park group’s admin cannot delete park group A’s employee, or the user with them',
      async () => {
        const victim = await appUser({ seats: [{ tenantId: tenantA, branchId: appCentral }] });
        const victimPerson = await person(victim.email);
        const victimEmployee = await employeeRow({
          tenant_id: tenantA,
          branch_id: appCentral,
          email: victim.email,
          person_id: victimPerson,
        });
        const res = await send(
          origin.local,
          'DELETE',
          `/api/employees/${victimEmployee}`,
          as('local', 'adminB'),
        );
        expect(await exists('users', victim.id)).toBe(true);
        expect(await exists('employees', victimEmployee)).toBe(true);
        expect(res.status).toBe(404);
      },
    );
  });

  // ── 3. Finding 3: the branch edit and the platform's columns ─────────────────
  describe('3. the app’s branch edit: the platform’s columns in every shape, never written', () => {
    let spare: string;
    beforeAll(async () => {
      spare = await appBranch({ name: 'ZZ recheck spare' });
    });

    /** The whole row, as the database holds it. */
    const rowOf = async (id: string) =>
      (
        await q<{ r: string }>(`select row_to_json(b)::text as r from branches b where id = $1`, [
          id,
        ])
      )[0]!.r;
    const coreOf = async (id: string) =>
      (
        await q(
          `select core_branch_id, core_sync_status, core_synced_at, core_sync_error from branches where id = $1`,
          [id],
        )
      )[0];

    it('no session, staff, and the other park group’s admin are refused, and nothing is written', async () => {
      const before = await rowOf(appCentral);
      for (const [who, expected] of [
        ['none', 401],
        ['staffA', 403],
        ['adminB', 404],
      ] as const) {
        const res = await send(origin.local, 'PATCH', `/api/branches/${appCentral}`, {
          ...as('local', who),
          body: { coreBranchId: null, coreSyncStatus: 'FAILED' },
        });
        expect(res.status, `${who}: ${res.text}`).toBe(expected);
      }
      expect(await rowOf(appCentral)).toBe(before);
    });

    it('park group A’s admin, every shape on the mapped row and on a spare one: the join and its record never change', async () => {
      const X = newId();
      /**
       * `stripped`: a key the edit takes out (the four the insert schema omits),
       * so the edit answers the branch unchanged. The rest are keys the table
       * does not know; they reach the database with nothing to set and are
       * refused there with a 500 — the app's own answer to any body of unknown
       * keys only, as before this round. Either way: nothing written.
       */
      const shapes: Array<{ name: string; raw: string; contentType?: string; stripped: boolean }> =
        [
          {
            name: 'null on the mapped join',
            raw: JSON.stringify({ coreBranchId: null }),
            stripped: true,
          },
          {
            name: 'its own id in capitals',
            raw: JSON.stringify({ coreBranchId: central.toUpperCase() }),
            stripped: true,
          },
          {
            name: 'another park’s id',
            raw: JSON.stringify({ coreBranchId: chalong }),
            stripped: true,
          },
          {
            name: 'another park’s id, mixed case',
            raw: JSON.stringify({ coreBranchId: mixedCase(chalong) }),
            stripped: true,
          },
          { name: 'a fresh id', raw: JSON.stringify({ coreBranchId: X }), stripped: true },
          {
            name: 'the sync record',
            raw: JSON.stringify({
              coreSyncStatus: 'APP_ONLY',
              coreSyncedAt: '2020-01-01T00:00:00.000Z',
              coreSyncError: 'zz',
            }),
            stripped: true,
          },
          {
            name: 'snake case',
            raw: JSON.stringify({ core_branch_id: X, core_sync_status: 'FAILED' }),
            stripped: false,
          },
          { name: 'PascalCase', raw: JSON.stringify({ CoreBranchId: X }), stripped: false },
          { name: 'shouted', raw: JSON.stringify({ COREBRANCHID: X }), stripped: false },
          { name: 'lower', raw: JSON.stringify({ corebranchid: X }), stripped: false },
          { name: 'ID in capitals', raw: JSON.stringify({ coreBranchID: X }), stripped: false },
          {
            name: '__proto__',
            raw: `{"__proto__":{"coreBranchId":"${X}","coreSyncStatus":"FAILED"}}`,
            stripped: false,
          },
          {
            name: 'a duplicate key',
            raw: `{"coreBranchId":"${X}","coreBranchId":null}`,
            stripped: true,
          },
          {
            name: 'the same tenant beside it',
            raw: JSON.stringify({ tenantId: tenantA, coreBranchId: X }),
            stripped: true,
          },
          {
            name: 'a form body',
            raw: `coreBranchId=${X}&coreSyncStatus=FAILED`,
            contentType: 'application/x-www-form-urlencoded',
            stripped: true,
          },
          { name: 'nothing', raw: '{}', stripped: true },
        ];
      for (const target of [appCentral, spare]) {
        const before = await rowOf(target);
        const which = target === spare ? 'the spare row' : 'the mapped row';
        for (const shape of shapes) {
          const res = await send(origin.local, 'PATCH', `/api/branches/${target}`, {
            ...as('local', 'adminA'),
            raw: shape.raw,
            contentType: shape.contentType,
          });
          if (shape.stripped) {
            expect(res.status, `${shape.name} on ${which}: ${res.text}`).toBe(200);
            expect(res.body.id).toBe(target);
          } else {
            expect([200, 500], `${shape.name} on ${which}: ${res.text}`).toContain(res.status);
          }
          expect(await rowOf(target), `${shape.name} on ${which}`).toBe(before);
        }
      }
    });

    it('beside a real field, the field saves and the join and its record stay', async () => {
      const coreBefore = await coreOf(appCentral);
      const res = await send(origin.local, 'PATCH', `/api/branches/${appCentral}`, {
        ...as('local', 'adminA'),
        body: {
          address: 'ZZ recheck edited',
          coreBranchId: null,
          coreSyncStatus: null,
          coreSyncedAt: null,
          coreSyncError: 'zz',
        },
      });
      expect(res.status, res.text).toBe(200);
      expect(res.body.address).toBe('ZZ recheck edited');
      expect(await coreOf(appCentral)).toEqual(coreBefore);
      expect((await mappedAppBranches(ctx.db, operatorId)).map((m) => m.id)).toContain(appCentral);
      expect((await censusAppBranchIdCase(ctx.db)).found.map((f) => f.appBranchId)).not.toContain(
        spare,
      );
    });
  });

  // ── 4. A placed admin, last: it writes ───────────────────────────────────────
  describe('4. a placed admin still runs them', () => {
    it('a laptop: A’s admin runs both repairs and both triggers, changing A and not B', async () => {
      for (const path of [...REPAIRS, ...TRIGGERS]) {
        const res = await send(origin.local, 'POST', path, as('local', 'adminA'));
        expect(res.status, `${path}: ${res.text}`).toBe(200);
      }
      expect(await stateOf(A)).toEqual({
        pending: 'active',
        departedActive: false,
        leaving: 'LEFT',
        photo: null,
      });
      expect(await stateOf(B)).toEqual(UNTOUCHED);
    });
  });
});
