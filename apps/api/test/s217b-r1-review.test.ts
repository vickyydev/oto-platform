import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  appIdentity,
  CASE_COLLISION_ERROR,
  censusAppBranchIdCase,
  findAppBranchForCore,
  mapCoreBranchIntoApp,
  otoappBranches,
  otoappUsers,
} from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * Review of S2-17b round 1 (lane/s217b-r1; SCRUM-193 under SCRUM-191), beside
 * the round's own `s217b-r1.test.ts`. Plan: `docs/progress/plans/otoapp-lift/PLAN.md`,
 * the round 1 row of section 8, sections 4 and 5, hazards H1, H19, H26, H28.
 *
 *  A. The seam: an upper-case platform id through the doors the round did not
 *     drive (provisioning, the Console's mapping read, the lookups beside a
 *     collision), and a collision manufactured by hand — listed by the census
 *     and the reconciliation, never lowered, never merged, and never the row a
 *     lookup or a mapping lands on.
 *  B. The app over HTTP, booted three times on one database — shaped like
 *     staging (`OTOAPP_JOBS=platform`), like production (`inprocess`) and as
 *     a developer's machine — with every caller that can be shaped: no
 *     session, a staff session, another park group's admin and the right
 *     admin. The development routes are refused on both deployments before
 *     anything runs, with prod-sync ARMED (a production URL set, `NODE_ENV` and
 *     `APP_ENV` that would let it through) so the DEPLOY_ENV fence is the only
 *     thing in front of it, and every table of the app hashed before and after.
 *     The maintenance routes stay in the caller's park group. The delete
 *     refusals hold for every caller with a real `core.app_identity` behind
 *     them. A user made in the app's own Users screen is listed, linked, and
 *     then opens the app through a real launcher hand-off against the
 *     platform api listening on a port. The live modules still answer.
 *  C. CI: the "What changed" scripts of both jobs, cut out of ci.yml and run by
 *     bash against simulated diffs — an app-only migration or directory change
 *     runs the workspace suite (where the view tests live); an app-only change
 *     elsewhere still runs the OTO App job.
 *
 * Findings are pinned with `it.fails` (the repo's review convention): each
 * states the behaviour that should hold, fails today, and turns red the day it
 * is fixed so the fix round flips it. A normal `it` beside each proves the
 * failure is the defect and not the arrangement. Five, none blocking the round:
 *
 *  1. (medium-low) `parkGroupOnly` trusts `userWithAccess.tenantId`, whose
 *     fallback places an admin with no branch access in the first branch's
 *     park group: the "no park group" refusal cannot fire (B7).
 *  2. (medium, the builder's question 1) `DELETE /api/people/:id` and the
 *     employee deletes still delete a platform-linked user (B3).
 *  3. (medium, pre-existing) the app's own branch edit writes `core_branch_id`,
 *     in any case (B5).
 *  4. (low) a case-colliding row in another park group makes that park group
 *     this operator's, on the unlinked list and for Link (A).
 *  5. (low) one app user with a role outside the six answers the whole
 *     unlinked list with a 500 (A).
 *
 * Section B needs the app's own node_modules (a developer's machine with the
 * junction); like the round's section G it is skipped where they are absent.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);

/** The launcher's signing key and the app's public origin, as the platform is configured with them. */
const HANDOFF_KEY = 'k1:s217b-review-handoff-secret-0123456789';
const APP_ORIGIN = 'http://zz-oto-app.review.test';

let ctx: TestContext;
let admin: string;
let operatorId: string;
let central: string;
let chalong: string;
let appPool: pg.Pool;
let dbUrl: string;
let platformUrl: string;
/** The app's park group this operator is anchored in ("A"). */
const appTenant = newId();
/** Another park group ("B"), anchored to nobody here. */
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
    [id, opts.tenantId ?? appTenant, opts.name, opts.coreBranchId ?? null],
  );
  return id;
}

const coreIdOf = async (appBranchId: string) =>
  (
    await ctx.db
      .select({ c: otoappBranches.coreBranchId, s: otoappBranches.coreSyncStatus })
      .from(otoappBranches)
      .where(eq(otoappBranches.id, appBranchId))
  )[0] ?? null;

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: {
      HANDOFF_SIGNING_KEY: HANDOFF_KEY,
      HANDOFF_APP_ORIGINS: `oto_app=${APP_ORIGIN}`,
      ALLOWED_ORIGINS: APP_ORIGIN,
    },
  });
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
    `insert into tenants (id, name, slug) values ($1, 'ZZ TEST park group A', 'zz-review-a'), ($2, 'ZZ TEST park group B', 'zz-review-b')`,
    [appTenant, tenantB],
  );
  // The anchor: this operator's two parks, already joined to park group A's rows.
  appCentral = await appBranch({ name: 'ZZ review app Central', coreBranchId: central });
  appChalong = await appBranch({ name: 'ZZ review app Chalong', coreBranchId: chalong });
  appBranchB = await appBranch({ name: 'ZZ review park B', tenantId: tenantB });

  // The platform api on a real port, for the app's server-to-server hand-off exchange.
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  platformUrl = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await ctx?.close();
  await teardownAll();
});

const unlinked = async (cookie: string) => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/admin/apps/oto_app/unlinked-users',
    headers: { cookie },
  });
  return {
    status: res.statusCode,
    body: res.body,
    ids: () => (res.json() as { users: Array<{ id: string }> }).users.map((u) => u.id),
  };
};

async function appUser(opts: {
  tenantId: string;
  branchId: string | null;
  role?: string;
  email?: string;
  password?: string;
  platformUserId?: string | null;
}): Promise<string> {
  const id = newId();
  const salt = randomBytes(16).toString('hex');
  const password = opts.password
    ? `${scryptSync(opts.password, salt, 64).toString('hex')}.${salt}`
    : 'x.y';
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [
      id,
      opts.email ?? `zz-review-${id}@example.com`,
      password,
      `ZZ review ${opts.role ?? 'staff'} ${id.slice(-4)}`,
      opts.role ?? 'staff',
      opts.platformUserId ?? null,
    ],
  );
  await q(
    `insert into user_branch_access (id, tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4, $5)`,
    [
      newId(),
      opts.tenantId,
      id,
      opts.branchId,
      opts.branchId ? 'selected_branches' : 'all_branches',
    ],
  );
  return id;
}

// =============================================================================
// A. The seam
// =============================================================================

describe('A. the seam: an upper-case id through the other doors, and a manufactured collision', () => {
  it('provisioning at a branch named in upper case seats the person in that park’s app branch', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: admin },
      payload: {
        phone: '+66900007801',
        name: 'ZZ review upper seat',
        branchId: chalong.toUpperCase(),
        otoApp: { email: 'zz-review-upper-seat@example.com', role: 'staff' },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { externalUserId } = res.json() as { externalUserId: string };
    const seats = await q<{ branch_id: string; tenant_id: string }>(
      `select branch_id, tenant_id::text as tenant_id from user_branch_access where user_id = $1`,
      [externalUserId],
    );
    expect(seats).toEqual([{ branch_id: appChalong, tenant_id: appTenant }]);
  });

  it('a park opened with an upper-case id reads as joined on the Console’s mapping', async () => {
    const sent = newId().toUpperCase();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/branches',
      headers: { cookie: admin },
      payload: {
        id: sent,
        name: 'ZZ review Upper Mapping',
        code: 'zz-review-upper-map',
        timezone: 'Asia/Bangkok',
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const mapping = await ctx.app.inject({
      method: 'GET',
      url: '/branches/oto-app',
      headers: { cookie: admin },
    });
    expect(mapping.statusCode, mapping.body).toBe(200);
    const row = (
      mapping.json() as {
        branches: Array<{ branchId: string; appBranchId: string | null; status: string | null }>;
      }
    ).branches.find((b) => b.branchId === sent.toLowerCase());
    expect(row?.appBranchId).toBeTruthy();
    expect(row?.status).toBe('SUCCESS');
  });

  describe('a collision manufactured inside park group A: listed, never lowered, never merged, never chosen', () => {
    let upper: string;
    let seated: string;
    let appCentralBefore: Awaited<ReturnType<typeof coreIdOf>>;

    beforeAll(async () => {
      appCentralBefore = await coreIdOf(appCentral);
      upper = await appBranch({
        name: 'ZZ review Central (upper)',
        coreBranchId: central.toUpperCase(),
      });
      // Someone seated on the colliding row: a merge would have to move them.
      seated = await appUser({ tenantId: appTenant, branchId: upper });
    });

    afterAll(async () => {
      await q(`delete from user_branch_access where user_id = $1`, [seated]);
      await q(`delete from users where id = $1`, [seated]);
      await q(`delete from branches where id = $1`, [upper]);
    });

    it('the read-only census names it and who holds the lower-case id, inside a read-only transaction', async () => {
      const census = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`set transaction read only`);
        return censusAppBranchIdCase(tx);
      });
      const finding = census.collisions.find((c) => c.appBranchId === upper);
      expect(finding).toMatchObject({ canonical: central, heldBy: appCentral });
      expect(census.writes).toBe(0);
    });

    it('the reconciliation lists it twice running, lowers nothing, merges nothing, and the second run writes nothing', async () => {
      const run = async () =>
        (
          await ctx.app.inject({
            method: 'POST',
            url: '/branches/oto-app/reconcile',
            headers: { cookie: admin },
          })
        ).json() as {
          caseLowered: Array<{ appBranchId: string }>;
          caseCollisions: Array<{ appBranchId: string; heldBy: string | null }>;
          writes: number;
        };
      const first = await run();
      expect(first.caseCollisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ appBranchId: upper, heldBy: appCentral }),
        ]),
      );
      expect(first.caseLowered.map((r) => r.appBranchId)).not.toContain(upper);
      const second = await run();
      expect(second.writes).toBe(0);
      expect(second.caseCollisions.map((c) => c.appBranchId)).toContain(upper);

      // Both rows exactly as they were spelled; the mapped one untouched.
      expect(await coreIdOf(appCentral)).toEqual(appCentralBefore);
      expect(await coreIdOf(upper)).toEqual({ c: central.toUpperCase(), s: 'FAILED' });
      const [why] = await ctx.db
        .select({ e: otoappBranches.coreSyncError })
        .from(otoappBranches)
        .where(eq(otoappBranches.id, upper));
      expect(why?.e).toBe(CASE_COLLISION_ERROR);
      // Nobody moved: the person on the colliding row is still seated there.
      expect(
        await q(`select branch_id from user_branch_access where user_id = $1`, [seated]),
      ).toEqual([{ branch_id: upper }]);
    });

    it('the lookups and the create path land on the lower-case row, never the colliding one', async () => {
      for (const spelled of [central, central.toUpperCase()]) {
        const found = await findAppBranchForCore(ctx.db, {
          operatorId,
          coreBranchId: spelled,
          name: 'ZZ',
        });
        expect(found !== 'ambiguous' && found?.id, spelled).toBe(appCentral);
      }
      const mapped = await mapCoreBranchIntoApp(ctx.db, {
        operatorId,
        branchId: central.toUpperCase(),
        name: 'ZZ',
        address: null,
        timezone: 'Asia/Bangkok',
      });
      expect(mapped).toMatchObject({ appBranchId: appCentral, mappedBy: 'core_branch_id' });
      expect(await coreIdOf(upper)).toEqual({ c: central.toUpperCase(), s: 'FAILED' });
    });
  });

  /**
   * FINDING (low). The census marks a colliding row FAILED as "a question for
   * a person (whose events, whose staff)", but everything else in the seam now
   * folds case before asking whose a row is (`mappedAppBranches`, `anchorOf`,
   * `foreignTenantsOf`). A row in ANOTHER park group carrying this operator's
   * id in upper case — which before round 1 read as somebody else's — now makes
   * that park group this operator's: its users, with their emails and phones,
   * appear on this operator's unlinked list, and Link (which does not check
   * the park group) will claim them. The app's own branch edit can write such a
   * row (section B, finding 4), so it does not need legacy data to exist. A
   * colliding row should count as nobody's until a person settles it.
   *
   * FIXED IN THE FIX ROUND: `mappedAppBranches`, `anchorOf` and
   * `foreignTenantsOf` read a case collision (`caseCollisions` in
   * `packages/db/src/schema/otoapp.ts`) as carrying no platform id, so it
   * makes no park group this operator's. Pin flipped.
   */
  describe('a colliding row in ANOTHER park group', () => {
    let foreignRow: string;
    let foreignUser: string;

    beforeAll(async () => {
      foreignRow = await appBranch({
        name: 'ZZ review park B (claims Chalong)',
        tenantId: tenantB,
        coreBranchId: chalong.toUpperCase(),
      });
      foreignUser = await appUser({ tenantId: tenantB, branchId: foreignRow });
    });

    afterAll(async () => {
      await q(`delete from user_branch_access where user_id = $1`, [foreignUser]);
      await q(`delete from users where id = $1`, [foreignUser]);
      await q(`delete from branches where id = $1`, [foreignRow]);
    });

    it('is a collision the census lists, and the list still answers', async () => {
      const census = await censusAppBranchIdCase(ctx.db);
      expect(census.collisions.map((c) => c.appBranchId)).toContain(foreignRow);
      expect((await unlinked(admin)).status).toBe(200);
    });

    it('does not put that park group’s users on this operator’s list', async () => {
      expect((await unlinked(admin)).ids()).not.toContain(foreignUser);
    });
  });

  /**
   * FINDING (low). `otoapp.users.role` is plain text with no check in the
   * database (the six-value list is the app's TypeScript enum), and the list's
   * response schema is `z.enum(OTO_APP_USER_ROLES)`. One row carrying any other
   * word — restored production data, a hand edit — fails the response
   * serialiser and the whole list answers 500 for everybody.
   */
  describe('one app user with a role outside the six', () => {
    let odd: string;
    beforeAll(async () => {
      odd = await appUser({ tenantId: appTenant, branchId: appCentral, role: 'hr_officer' });
    });
    afterAll(async () => {
      await q(`delete from user_branch_access where user_id = $1`, [odd]);
      await q(`delete from users where id = $1`, [odd]);
    });

    it('is a row the database accepted', async () => {
      expect(await q(`select role from users where id = $1`, [odd])).toEqual([
        { role: 'hr_officer' },
      ]);
    });

    it.fails('does not take the whole list down', async () => {
      expect((await unlinked(admin)).status).toBe(200);
    });
  });
});

// =============================================================================
// B. The app over HTTP
// =============================================================================

interface ParkGroupRows {
  pending: string;
  departedUser: string;
  leaving: string;
  photo: string;
}

const OLD_PHOTO = '/profile-photos/zz-review.jpg';
const PASSWORD = 'zz-review-password';

async function maintenanceRows(
  tenantId: string,
  branchId: string,
  label: string,
  by: string,
): Promise<ParkGroupRows> {
  const employee = async (fields: Record<string, unknown>) => {
    const id = newId();
    const cols = [
      'id',
      'tenant_id',
      'branch_id',
      'full_name',
      'nickname',
      'email',
      ...Object.keys(fields),
    ];
    const vals = [
      id,
      tenantId,
      branchId,
      `ZZ review ${label} ${id.slice(-4)}`,
      'ZZ',
      `zz-review-${id}@example.com`,
      ...Object.values(fields),
    ];
    await q(
      `insert into employees (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      vals,
    );
    return id;
  };
  const pending = await employee({ status: 'pending' });
  const template = newId();
  await q(`insert into templates (id, name, html_body) values ($1, $2, '<p>ZZ</p>')`, [
    template,
    `ZZ review ${label} ${template.slice(-4)}`,
  ]);
  await q(
    `insert into contract_instances (employee_id, template_id, template_snapshot_html, template_snapshot_version, merge_data_json, created_by, signing_status)
     values ($1, $2, '<p>ZZ</p>', 1, '{}'::jsonb, $3, 'signed')`,
    [pending, template, by],
  );
  const departedUser = await appUser({ tenantId, branchId: null });
  await employee({ last_working_day: '2020-01-01', user_id: departedUser });
  const leaving = await employee({ employment_state: 'LEAVING', last_working_day: '2020-01-01' });
  const photo = await employee({ profile_photo_path: OLD_PHOTO });
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

/**
 * Every table of the app, hashed row by row — what "wrote nothing" means.
 * `session` is left out: signing in writes it, and that is the point of it.
 */
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
        // Everything the inner, older checks read set to let the tools through,
        // so DEPLOY_ENV is the only fence left standing in front of them.
        NODE_ENV: 'test',
        APP_ENV: 'dev',
        STORAGE_ENV_PREFIX: 'zz-review',
        OBJECT_STORAGE: 'local',
        OTOAPP_LEGACY_LOGIN: 'true',
        DEV_IMPORT_KEY: 'zz-review-import-key',
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
    // Armed: were the fence to open, prod-sync would empty and reload this database.
    PRODUCTION_DATABASE_URL: url,
    SESSION_SECRET: randomBytes(24).toString('hex'),
    SESSION_PEPPER: randomBytes(24).toString('hex'),
    KIOSK_CODE_PEPPER: randomBytes(24).toString('hex'),
    PIN_FINGERPRINT_SECRET: randomBytes(24).toString('hex'),
    OBJECT_STORAGE: 's3',
    S3_BUCKET: 'zz-review-bucket',
    S3_ENDPOINT: 'zz-review.invalid',
    AWS_ACCESS_KEY_ID: 'zz-review',
    AWS_SECRET_ACCESS_KEY: 'zz-review',
  };
};

interface Answer {
  status: number;
  text: string;
  body: Record<string, unknown>;
  cookie: string;
}

async function call(
  origin: string,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(opts.body ?? {}),
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
  const res = await call(origin, 'POST', '/api/login', {
    body: { identifier: email, password: PASSWORD },
  });
  expect(res.status, `sign-in as ${email}: ${res.text}`).toBe(200);
  expect(res.cookie).toBeTruthy();
  return res.cookie;
}

const DEV_ROUTES = [
  ['POST', '/api/seed'],
  ['GET', '/api/test-sentry'],
  ['POST', '/api/dev/import-core-legacy-uploads'],
  ['GET', '/api/test-object-storage'],
  ['POST', '/api/admin/prod-sync'],
  ['GET', '/api/admin/prod-sync/status'],
] as const;
const JOB_TRIGGERS = [
  '/api/admin/run-departed-deactivation',
  '/api/scheduler/transition-left',
] as const;
const MAINTENANCE = [
  '/api/admin/backfill-employee-photos',
  '/api/admin/fix-pending-with-signed-contracts',
] as const;

const DEACTIVATE_INSTEAD = 'Deactivate this account to preserve its HR record';

describe.skipIf(!HAS_APP_RUNTIME)(
  'B. the app over HTTP: staging, production and a laptop, every caller',
  () => {
    const emails = {
      adminA: `zz-review-admin-a-${randomUUID().slice(0, 6)}@example.com`,
      staffA: `zz-review-staff-a-${randomUUID().slice(0, 6)}@example.com`,
      adminB: `zz-review-admin-b-${randomUUID().slice(0, 6)}@example.com`,
      lost: `zz-review-lost-${randomUUID().slice(0, 6)}@example.com`,
    };
    const ids = { adminA: '', staffA: '', adminB: '', lost: '' };
    let A: ParkGroupRows;
    let B: ParkGroupRows;
    const origin = { staging: '', production: '', local: '' };
    type Caller = 'none' | 'staffA' | 'adminB' | 'adminA';
    const cookies: Record<'staging' | 'production' | 'local', Record<Caller, string>> = {
      staging: { none: '', staffA: '', adminB: '', adminA: '' },
      production: { none: '', staffA: '', adminB: '', adminA: '' },
      local: { none: '', staffA: '', adminB: '', adminA: '' },
    };
    const CALLERS: Caller[] = ['none', 'staffA', 'adminB', 'adminA'];

    beforeAll(async () => {
      ids.adminA = await appUser({
        tenantId: appTenant,
        branchId: null,
        role: 'admin',
        email: emails.adminA,
        password: PASSWORD,
      });
      ids.staffA = await appUser({
        tenantId: appTenant,
        branchId: appCentral,
        role: 'staff',
        email: emails.staffA,
        password: PASSWORD,
      });
      ids.adminB = await appUser({
        tenantId: tenantB,
        branchId: null,
        role: 'admin',
        email: emails.adminB,
        password: PASSWORD,
      });
      A = await maintenanceRows(appTenant, appCentral, 'A', ids.adminA);
      B = await maintenanceRows(tenantB, appBranchB, 'B', ids.adminB);

      const [staging, production, local] = await Promise.all([
        serve(deploymentEnv('staging', 'platform')),
        serve(deploymentEnv('production', 'inprocess')),
        serve({
          DEPLOY_ENV: 'local',
          OTOAPP_JOBS: 'inprocess',
          DATABASE_URL: dbUrl,
          PLATFORM_API_URL: platformUrl,
          OTOAPP_PUBLIC_ORIGIN: APP_ORIGIN,
        }),
      ]);
      Object.assign(origin, { staging, production, local });
      for (const where of ['staging', 'production', 'local'] as const) {
        cookies[where].adminA = await appSignIn(origin[where], emails.adminA);
        cookies[where].staffA = await appSignIn(origin[where], emails.staffA);
        cookies[where].adminB = await appSignIn(origin[where], emails.adminB);
      }
    }, 300_000);

    afterAll(() => {
      for (const child of children) child.kill();
    });

    const as = (where: 'staging' | 'production' | 'local', who: Caller) =>
      who === 'none' ? {} : { cookie: cookies[where][who] };

    // ── 1. The development tools, on both deployments, for every caller ────────
    describe('1. the development tools: refused on staging and production to everybody, and nothing written', () => {
      for (const where of ['staging', 'production'] as const) {
        it(`${where}: all six refuse every caller in words, before the route's own checks`, async () => {
          const before = await appTables();
          for (const [method, path] of DEV_ROUTES) {
            for (const who of CALLERS) {
              const res = await call(origin[where], method, path, {
                ...as(where, who),
                // The importer's own key, so its older check would let it through.
                headers: { 'x-dev-import-key': 'zz-review-import-key' },
              });
              expect(res.status, `${where} ${method} ${path} as ${who}: ${res.text}`).toBe(403);
              expect(res.body.reason, `${where} ${path} as ${who}`).toBe('dev_route_off');
              expect(res.text).not.toContain('zz-review-bucket');
            }
          }
          // A sync started in the background would be emptying tables by now.
          await new Promise((r) => setTimeout(r, 1500));
          expect(await appTables()).toEqual(before);
        }, 120_000);

        it(`${where}: prod-sync cannot be reached around its fence — case, slashes, query, HEAD, override, a forged host`, async () => {
          const before = await appTables();
          const tries: Array<[string, string, Record<string, string>?]> = [
            ['POST', '/api/admin/prod-sync/'],
            ['POST', '/API/ADMIN/PROD-SYNC'],
            ['POST', '/api/admin/Prod-Sync?force=1'],
            ['POST', '/api/admin//prod-sync'],
            ['POST', '/api/admin/prod-sync%2F'],
            [
              'POST',
              '/api/admin/prod-sync',
              { 'x-forwarded-host': 'localhost', 'x-forwarded-for': '127.0.0.1' },
            ],
            ['GET', '/api/admin/prod-sync', { 'x-http-method-override': 'POST' }],
            ['HEAD', '/api/admin/prod-sync/status'],
            ['GET', '/API/Admin/Prod-Sync/Status/'],
          ];
          for (const [method, path, headers] of tries) {
            const res = await call(origin[where], method, path, {
              cookie: cookies[where].adminA,
              headers,
            });
            expect(res.status, `${method} ${path}: ${res.text}`).not.toBe(200);
            expect(res.text).not.toMatch(/Sync started|progress|tables/i);
            if (res.status !== 404) expect(res.status, `${method} ${path}`).toBe(403);
          }
          await new Promise((r) => setTimeout(r, 1500));
          expect(await appTables()).toEqual(before);
        }, 60_000);
      }

      it('on a laptop they are what they were: the status answers and the Sentry test throws', async () => {
        expect(
          (await call(origin.local, 'GET', '/api/admin/prod-sync/status', as('local', 'adminA')))
            .status,
        ).toBe(200);
        expect((await call(origin.local, 'GET', '/api/test-sentry')).status).toBe(500);
      });
    });

    // ── 2. The job triggers and the maintenance routes ──────────────────────────
    describe('2. the maintenance routes: the job switch, the role checks, and one park group', () => {
      it('staging (OTOAPP_JOBS=platform): the job triggers answer 401, 403, then the Console for both admins, and write nothing', async () => {
        const before = await appTables();
        for (const path of JOB_TRIGGERS) {
          const expected: Record<Caller, number> = {
            none: 401,
            staffA: 403,
            adminB: 409,
            adminA: 409,
          };
          for (const who of CALLERS) {
            const res = await call(origin.staging, 'POST', path, as('staging', who));
            expect(res.status, `${path} as ${who}: ${res.text}`).toBe(expected[who]);
            if (expected[who] === 409) {
              expect(res.body.reason).toBe('jobs_on_platform');
              expect(String(res.body.message)).toMatch(/Run now on the Console's Health page/);
            }
          }
        }
        expect(await appTables()).toEqual(before);
      });

      it('staging: the two repairs refuse no session and a staff session, and park group B’s admin changes only B', async () => {
        for (const path of MAINTENANCE) {
          expect((await call(origin.staging, 'POST', path)).status, path).toBe(401);
          expect(
            (await call(origin.staging, 'POST', path, as('staging', 'staffA'))).status,
            path,
          ).toBe(403);
        }
        expect(await stateOf(A)).toEqual(UNTOUCHED);
        expect(await stateOf(B)).toEqual(UNTOUCHED);
        for (const path of MAINTENANCE) {
          const res = await call(origin.staging, 'POST', path, as('staging', 'adminB'));
          expect(res.status, `${path}: ${res.text}`).toBe(200);
        }
        expect(await stateOf(A)).toEqual(UNTOUCHED);
        expect(await stateOf(B)).toMatchObject({ pending: 'active', photo: null });
      });

      it('production (OTOAPP_JOBS=inprocess): the job triggers refuse no session and staff, and B’s admin moves only B', async () => {
        for (const path of JOB_TRIGGERS) {
          expect((await call(origin.production, 'POST', path)).status, path).toBe(401);
          expect(
            (await call(origin.production, 'POST', path, as('production', 'staffA'))).status,
            path,
          ).toBe(403);
          const res = await call(origin.production, 'POST', path, as('production', 'adminB'));
          expect(res.status, `${path}: ${res.text}`).toBe(200);
        }
        expect(await stateOf(A)).toEqual(UNTOUCHED);
        expect(await stateOf(B)).toEqual({
          pending: 'active',
          departedActive: false,
          leaving: 'LEFT',
          photo: null,
        });
      });

      it('a laptop: A’s admin runs all four and changes A, and not a fresh set of B’s rows', async () => {
        const B2 = await maintenanceRows(tenantB, appBranchB, 'B2', ids.adminB);
        for (const path of [...MAINTENANCE, ...JOB_TRIGGERS]) {
          const res = await call(origin.local, 'POST', path, as('local', 'adminA'));
          expect(res.status, `${path}: ${res.text}`).toBe(200);
        }
        expect(await stateOf(A)).toEqual({
          pending: 'active',
          departedActive: false,
          leaving: 'LEFT',
          photo: null,
        });
        expect(await stateOf(B2)).toEqual(UNTOUCHED);
      });
    });

    // ── 3. Deleting users ───────────────────────────────────────────────────────
    describe('3. DELETE /api/users/:id: every caller, a real platform link behind it, nothing orphaned', () => {
      let linked: { user: string; identity: string };
      let referenced: string;

      beforeAll(async () => {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/admin/apps/oto_app/users',
          headers: { cookie: admin },
          payload: {
            phone: '+66900007802',
            name: 'ZZ review linked',
            branchId: central,
            otoApp: { email: 'zz-review-linked@example.com', role: 'staff' },
          },
        });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as { externalUserId: string; id: string };
        linked = { user: body.externalUserId, identity: body.id };
        referenced = await appUser({ tenantId: appTenant, branchId: appCentral });
        await q(
          `insert into user_module_overrides (tenant_id, user_id, module_key) values ($1, $2, 'ops')`,
          [appTenant, referenced],
        );
      });

      it('no session 401, staff 403, park group B’s admin 404, A’s admin 409 in the app’s words — and nothing changes', async () => {
        const appBefore = await appTables();
        const identityBefore = await identityRows();
        for (const [target, reason] of [
          [linked.user, 'linked_to_platform'],
          [referenced, 'still_referenced'],
        ] as const) {
          const expected: Record<Caller, number> = {
            none: 401,
            staffA: 403,
            adminB: 404,
            adminA: 409,
          };
          for (const who of CALLERS) {
            const res = await call(
              origin.local,
              'DELETE',
              `/api/users/${target}`,
              as('local', who),
            );
            expect(res.status, `${reason} as ${who}: ${res.text}`).toBe(expected[who]);
            if (who === 'adminA') expect(res.body).toEqual({ message: DEACTIVATE_INSTEAD, reason });
          }
        }
        expect(await appTables()).toEqual(appBefore);
        expect(await identityRows()).toBe(identityBefore);
        // The identity still names a user that exists, stamped with its account.
        const [identity] = await ctx.db
          .select()
          .from(appIdentity)
          .where(eq(appIdentity.id, linked.identity));
        const [user] = await ctx.db
          .select()
          .from(otoappUsers)
          .where(eq(otoappUsers.id, identity!.externalUserId));
        expect(user?.platformUserId).toBe(identity!.accountId);
      });

      it('the same admin still deletes a user nothing points at (the refusals are specific)', async () => {
        const plain = await appUser({ tenantId: appTenant, branchId: appCentral });
        expect(
          (await call(origin.local, 'DELETE', `/api/users/${plain}`, as('local', 'adminA'))).status,
        ).toBe(204);
        expect(await q(`select 1 from users where id = $1`, [plain])).toEqual([]);
      });

      /**
       * FINDING (medium; the builder's question 1). H28's hazard — a linked app
       * user deleted under the platform — is closed on DELETE /api/users/:id
       * only. `DELETE /api/people/:id` (and the employee deletes at
       * routes.ts:4072/4085/4151/4161) still call `storage.deleteUser` on the
       * user matched by email, with no `platform_user_id` check, leaving
       * `core.app_identity` pointing at nothing and the launcher tile opening onto
       * "not provisioned". `people` has no tenant column either, so any park
       * group's admin can do it.
       *
       * FIXED IN THE FIX ROUND: the people delete, the employee delete and
       * the bulk employee delete take the user through `deleteManagedUser`
       * first, before writing anything of their own, and answer its 409; the
       * storage layer's unguarded user delete is gone. Pin flipped.
       */
      describe('the other doors that delete a user', () => {
        let victim: { user: string; identity: string; person: string };
        beforeAll(async () => {
          const res = await ctx.app.inject({
            method: 'POST',
            url: '/admin/apps/oto_app/users',
            headers: { cookie: admin },
            payload: {
              phone: '+66900007803',
              name: 'ZZ review person door',
              branchId: central,
              otoApp: { email: 'zz-review-person-door@example.com', role: 'staff' },
            },
          });
          expect(res.statusCode, res.body).toBe(200);
          const body = res.json() as { externalUserId: string; id: string };
          const person = newId();
          await q(
            `insert into people (id, full_name, email, person_type) values ($1, 'ZZ review person door', 'zz-review-person-door@example.com', 'employee')`,
            [person],
          );
          victim = { user: body.externalUserId, identity: body.id, person };
        });

        it('the arrangement: a linked user with a person record, refused by the user delete', async () => {
          const res = await call(
            origin.local,
            'DELETE',
            `/api/users/${victim.user}`,
            as('local', 'adminA'),
          );
          expect(res.status).toBe(409);
          expect(await q(`select 1 from users where id = $1`, [victim.user])).toHaveLength(1);
        });

        it(
          'DELETE /api/people/:id leaves a platform-linked user (and so its core.app_identity) whole',
          async () => {
            await call(
              origin.local,
              'DELETE',
              `/api/people/${victim.person}`,
              as('local', 'adminA'),
            );
            expect(await q(`select 1 from users where id = $1`, [victim.user])).toHaveLength(1);
          },
        );
      });
    });

    // ── 4. A user made in the app's Users screen, linked, opening from the launcher ─
    describe('4. Link makes a launcher sign-in real', () => {
      it('made in the app’s Users screen → on the list → Link → a hand-off signs them into the app as that user', async () => {
        // The app's own Users screen, as park group A's admin.
        const made = await call(origin.local, 'POST', '/api/users', {
          cookie: cookies.local.adminA,
          body: {
            email: `zz-review-made-in-app-${randomUUID().slice(0, 6)}@example.com`,
            password: 'made-in-app-1',
            fullName: 'ZZ review made in the app',
            role: 'staff',
            accessScope: 'selected_branches',
            branchIds: [appCentral],
          },
        });
        expect(made.status, made.text).toBe(201);
        const appUserId = String(made.body.id);

        expect((await unlinked(admin)).ids()).toContain(appUserId);

        // Before the link the launcher will not even mint a hand-off for them.
        const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
        const mint = () =>
          ctx.app.inject({
            method: 'POST',
            url: '/auth/handoff',
            headers: { cookie: reception },
            payload: { app: 'oto_app' },
          });
        expect((await mint()).statusCode).toBe(403);

        const [receptionAccount] = await ctx.db
          .select({ id: account.id })
          .from(account)
          .where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
        const link = await ctx.app.inject({
          method: 'POST',
          url: '/admin/apps/oto_app/users',
          headers: { cookie: admin },
          payload: { accountId: receptionAccount!.id, externalUserId: appUserId },
        });
        expect(link.statusCode, link.body).toBe(200);
        expect((await unlinked(admin)).ids()).not.toContain(appUserId);

        const minted = await mint();
        expect(minted.statusCode, minted.body).toBe(200);
        const { token } = minted.json() as { token: string };

        const signedOn = await call(origin.local, 'POST', '/api/auth/handoff', { body: { token } });
        expect(signedOn.status, signedOn.text).toBe(200);
        expect(signedOn.body).toEqual({ ok: true });
        const me = await call(origin.local, 'GET', '/api/user', { cookie: signedOn.cookie });
        expect(me.status, me.text).toBe(200);
        expect(me.body.id).toBe(appUserId);
        expect(me.body.tenantId).toBe(appTenant);

        // And the identity is the platform's own record of it.
        const [identity] = await ctx.db
          .select()
          .from(appIdentity)
          .where(
            and(eq(appIdentity.app, 'oto_app'), eq(appIdentity.accountId, receptionAccount!.id)),
          );
        expect(identity?.externalUserId).toBe(appUserId);
      }, 60_000);
    });

    // ── 5. The app's own branch edit as a door into the seam ────────────────────
    /**
     * FINDING (medium, pre-existing; a door the round's "every door lower-cases"
     * does not cover). The app's `PATCH /api/branches/:id` hands the request body
     * to `storage.updateBranch` unfiltered, and that signature takes
     * `coreBranchId` and the `core_sync_*` columns. Any park group's admin can
     * write the platform's join column on their own branch — in any case, so the
     * raw-text unique index does not stop them planting the upper-case form of a
     * park that is already mapped. The seam then folds case and reads the row as
     * this operator's (section A's finding). The app's insert schema already
     * omits these columns; the edit should too.
     *
     * FIXED IN THE FIX ROUND: the edit strips `coreBranchId` and the three
     * `core_sync_*` columns the way the insert schema omits them, and an edit
     * left with nothing to write answers the branch unchanged. Pin flipped.
     */
    describe('5. the app’s own branch edit', () => {
      it('answers a branch edit for an admin of that park group', async () => {
        const res = await call(origin.local, 'PATCH', `/api/branches/${appBranchB}`, {
          cookie: cookies.local.adminB,
          body: { address: 'ZZ review address' },
        });
        expect(res.status, res.text).toBe(200);
      });

      it('cannot write the platform’s join column', async () => {
        try {
          await call(origin.local, 'PATCH', `/api/branches/${appBranchB}`, {
            cookie: cookies.local.adminB,
            body: { coreBranchId: central.toUpperCase() },
          });
          expect((await coreIdOf(appBranchB))?.c ?? null).toBeNull();
        } finally {
          await q(`update branches set core_branch_id = null where id = $1`, [appBranchB]);
        }
      });
    });

    // ── 6. The live modules still answer ────────────────────────────────────────
    describe('6. the app still serves its live modules', () => {
      for (const where of ['staging', 'local'] as const) {
        it(`${where}: user, branches, employees, users, departments, tasks, time off and shift groups answer park group A’s admin`, async () => {
          for (const path of [
            '/api/user',
            '/api/branches',
            '/api/employees',
            '/api/users',
            '/api/departments',
            '/api/core/tasks',
            '/api/time-off',
            `/api/schedule/shift-groups?branchId=${appCentral}`,
          ]) {
            const res = await call(origin[where], 'GET', path, as(where, 'adminA'));
            expect(res.status, `${where} ${path}: ${res.text.slice(0, 200)}`).toBe(200);
          }
        });
      }
    });

    // ── 7. An admin the app cannot place (LAST: it writes when it fails) ────────
    /**
     * FINDING (medium-low). `parkGroupOnly` takes `req.userWithAccess.tenantId`,
     * and `getUserWithBranchAccess` never leaves that empty while any branch
     * exists: with no branch-access row it falls back to the tenant of
     * `select … from branches limit 1` — whichever park group's branch the heap
     * returns first. So "a caller with none is refused" cannot happen, and an
     * admin the app itself cannot place (a launcher-provisioned admin whose seat
     * failed, in a database holding two park groups) repairs somebody else's
     * park group. The app's own User Management already uses the strict rule
     * (`userManagementTenant`: `managedUserTenant` must agree) and refuses the
     * same caller.
     *
     * FIXED IN THE FIX ROUND: `parkGroupOnly` takes the app's strict rule as
     * its resolver (`parkGroupOnly(userManagementTenant)` on all four routes),
     * so the caller User Management refuses is refused here too. Pin flipped.
     */
    describe('7. an admin with no branch access, in a database of two park groups', () => {
      let lost: string;
      let fallback: string;
      let target: ParkGroupRows;

      beforeAll(async () => {
        ids.lost = newId();
        const salt = randomBytes(16).toString('hex');
        await q(
          `insert into users (id, email, password, full_name, role, is_active, must_change_password)
         values ($1, $2, $3, 'ZZ review unplaceable admin', 'admin', true, false)`,
          [ids.lost, emails.lost, `${scryptSync(PASSWORD, salt, 64).toString('hex')}.${salt}`],
        );
        lost = await appSignIn(origin.local, emails.lost);
        fallback = (await q<{ t: string }>(`select tenant_id::text as t from branches limit 1`))[0]!
          .t;
        const fallbackBranch = (
          await q<{ id: string }>(`select id from branches where tenant_id = $1 limit 1`, [
            fallback,
          ])
        )[0]!.id;
        target = await maintenanceRows(fallback, fallbackBranch, 'fallback', ids.adminA);
      });

      it('the arrangement: the app places them in the first branch’s park group, and its own User Management refuses them', async () => {
        const me = await call(origin.local, 'GET', '/api/user', { cookie: lost });
        expect(me.status, me.text).toBe(200);
        expect(me.body.tenantId).toBe(fallback);
        const users = await call(origin.local, 'GET', '/api/users', { cookie: lost });
        expect(users.status, users.text).toBe(403);
      });

      it(
        'a repair called by them is refused as "no park group" and changes nobody’s rows',
        async () => {
          const res = await call(
            origin.local,
            'POST',
            '/api/admin/fix-pending-with-signed-contracts',
            { cookie: lost },
          );
          expect((await stateOf(target)).pending).toBe('pending');
          expect(res.status).toBe(403);
        },
      );
    });
  },
);

// =============================================================================
// C. CI, read off ci.yml and run
// =============================================================================

const CI_PATH = join(REPO, '.github', 'workflows', 'ci.yml');
const BASH =
  process.platform === 'win32'
    ? (['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(
        (p) => existsSync(p),
      ) ?? null)
    : 'bash';

/** The `run: |` block of one step in one job, as bash will see it. */
function stepScript(ci: string, job: string, step: string): string {
  const lines = ci.split(/\r?\n/);
  const start = lines.indexOf(`  ${job}:`);
  expect(start, `job ${job}`).toBeGreaterThan(-1);
  let end = lines.findIndex((l, i) => i > start && /^ {2}[a-z][\w-]*:\s*$/.test(l));
  if (end === -1) end = lines.length;
  const at = lines.findIndex((l, i) => i > start && i < end && l.trim() === `- name: ${step}`);
  expect(at, `${job} > ${step}`).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = lines[run]!.search(/\S/);
  const body: string[] = [];
  for (let i = run + 1; i < end; i++) {
    const l = lines[i]!;
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if (l.search(/\S/) <= indent) break;
    body.push(l.slice(indent + 2));
  }
  return body.join('\n');
}

function runGate(script: string, files: string[]): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 's217b-ci-'));
  try {
    const list = join(dir, 'files.txt').split('\\').join('/');
    const out = join(dir, 'out.txt').split('\\').join('/');
    writeFileSync(list, files.join('\n') + '\n');
    writeFileSync(out, '');
    // `git fetch` succeeds and `git diff --name-only` answers the simulated diff.
    const prelude = `git() { if [ "$1" = diff ]; then cat "$FAKE_FILES"; fi; return 0; }\n`;
    const result = spawnSync(
      BASH!,
      ['-c', prelude + script.replace(/\$\{\{[^}]*\}\}/g, 'base0000feed')],
      {
        env: { ...process.env, FAKE_FILES: list, GITHUB_OUTPUT: out, GITHUB_SHA: 'head0000feed' },
        encoding: 'utf8',
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return Object.fromEntries(
      readFileSync(out, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.split('=') as [string, string]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!BASH)('C. CI: the path gates run by bash against simulated diffs', () => {
  const ci = readFileSync(CI_PATH, 'utf8');
  const gate = stepScript(ci, 'ci', 'What changed');
  const appGate = stepScript(ci, 'oto-app', 'What changed');

  const cases: Array<{
    name: string;
    files: string[];
    workspace: string;
    db: string;
    app: string;
  }> = [
    {
      name: 'a new app migration only',
      files: [
        'apps/oto-app/migrations/0005_next.sql',
        'apps/oto-app/migrations/meta/_journal.json',
      ],
      workspace: 'true',
      db: 'false',
      app: 'true',
    },
    {
      name: 'an app directory route only',
      files: ['apps/oto-app/server/directory/eventRoutes.ts'],
      workspace: 'true',
      db: 'false',
      app: 'true',
    },
    {
      name: 'the delete module only',
      files: ['apps/oto-app/server/lib/userDeletion.ts'],
      workspace: 'true',
      db: 'false',
      app: 'true',
    },
    {
      name: 'the fences module only',
      files: ['apps/oto-app/server/lib/routeFences.ts'],
      workspace: 'true',
      db: 'false',
      app: 'true',
    },
    {
      name: 'the app routes only (not read by the platform suite)',
      files: ['apps/oto-app/server/routes.ts'],
      workspace: 'false',
      db: 'false',
      app: 'true',
    },
    {
      name: 'an app screen only',
      files: ['apps/oto-app/client/src/App.tsx'],
      workspace: 'false',
      db: 'false',
      app: 'true',
    },
    {
      name: 'a near-miss name beside the fences module',
      files: ['apps/oto-app/server/lib/routeFencesOld.ts'],
      workspace: 'false',
      db: 'false',
      app: 'true',
    },
    {
      name: 'a platform migration',
      files: ['packages/db/migrations/0076_next.sql'],
      workspace: 'true',
      db: 'true',
      app: 'true',
    },
    {
      name: 'the api only',
      files: ['apps/api/src/app.ts'],
      workspace: 'true',
      db: 'false',
      app: 'false',
    },
    {
      name: 'the workflow itself',
      files: ['.github/workflows/ci.yml'],
      workspace: 'true',
      db: 'false',
      app: 'true',
    },
    {
      name: 'an app screen and the api',
      files: ['apps/oto-app/client/src/App.tsx', 'apps/api/src/app.ts'],
      workspace: 'true',
      db: 'false',
      app: 'true',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: workspace=${c.workspace}, db=${c.db}; the OTO App job ${c.app === 'true' ? 'runs' : 'skips'}`, () => {
      const flags = runGate(gate, c.files);
      expect(flags).toMatchObject({ workspace: c.workspace, db: c.db });
      expect(runGate(appGate, c.files)).toEqual({ app: c.app });
    });
  }

  it('a workspace run is the one that runs the view tests: Test is gated on it and runs the api suite that holds them', () => {
    const lines = ci.split(/\r?\n/);
    const at = lines.findIndex((l) => l.trim() === '- name: Test');
    expect(lines[at + 1]!.trim()).toBe("if: steps.changes.outputs.workspace == 'true'");
    expect(lines[at + 2]!.trim()).toBe('run: pnpm test --continue');
    for (const f of [
      'otoapp-events-seam.test.ts',
      'g17-round0-review.test.ts',
      's217b-r1.test.ts',
    ]) {
      expect(existsSync(join(REPO, 'apps', 'api', 'test', f)), f).toBe(true);
    }
    expect(readFileSync(join(REPO, 'apps', 'api', 'vitest.config.ts'), 'utf8')).toMatch(
      /include: \['test\/\*\*\/\*\.test\.ts'\]/,
    );
  });

  it('an unreadable base runs everything in both jobs', () => {
    const blank = (s: string) => s.replace(/\$\{\{[^}]*\}\}/g, '');
    const dir = mkdtempSync(join(tmpdir(), 's217b-ci-'));
    try {
      const out = join(dir, 'out.txt').split('\\').join('/');
      for (const script of [gate, appGate]) {
        writeFileSync(out, '');
        const r = spawnSync(BASH!, ['-c', blank(script)], {
          env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_SHA: 'x' },
          encoding: 'utf8',
        });
        expect(r.status, r.stderr).toBe(0);
        const flags = readFileSync(out, 'utf8');
        expect(flags).not.toMatch(/=false/);
        expect(flags).toMatch(/=true/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
