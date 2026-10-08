import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOtoAppMigrations, createTestDatabase } from '@oto/db/testing';

/**
 * S2-17b round 4a (SCRUM-193 under SCRUM-191) — THE REVIEW, from the attacking
 * side (docs/progress/plans/otoapp-lift/PLAN.md section 4 "Shared tables answer
 * across park groups", section 5 "Tenant-bound Directory HR reads", section 7
 * "Round 4 (expand)" and the root-table census, section 8 round 4's 4a half,
 * hazards H10-H12, Q13 and Q28-Q31).
 *
 *  A. H10 on a harsher fixture than the builder's, a seeded 0005 state upgraded
 *     by the app's own migrator: a row whose branch and employee disagree, an
 *     employee in no branch, a contract whose branch and employee disagree, a
 *     row whose subject outranks its actor, users placed in one, two or no park
 *     groups, a user moved between park groups after acting, and users the
 *     app's strict placement (`managedUserTenant`) would NOT place. Expand-only
 *     read off the catalogue (every column, constraint and index the three
 *     tables had is still there, byte for byte; only the declared additions are
 *     new), the employee view the platform reads survives, and 0006's backfill
 *     run a second time (what 4b must do) places only nulls.
 *  B. THE MIGRATION WINDOW, with real concurrency: a write in flight when 0006
 *     starts is placed by it; a write queued behind 0006's lock lands with no
 *     park group (the previous release's hand-over row), is counted by the
 *     read-back, and is placed by 0006's backfill run again.
 *  C. A database whose ONE park group is not slug `default` (finding 1).
 *  D. Over HTTP against the app's real routes:
 *     - H11 on BOTH constraint shapes: another park group's saves refused in
 *       words; the default park group's updates, new keys, five concurrent
 *       saves of one key and a hand-over row's claim; never a 500;
 *     - Data Admin, a door that writes another park group's settings row in
 *       4a around the 409 (finding 2);
 *     - H12 over all six reads: A's key against B's rows (404, the same words
 *       as a row that does not exist), lists that never name the other park
 *       group, an employee whose own links cross park groups, a scopeless,
 *       events-only, revoked and inactive key on every route, no key, the
 *       shared key unset (403) and set (the default park group only), and no
 *       refusal that names a park group;
 *     - the Activity Logbook's hand-over rows.
 *  E. Read off the code: every branchless Activity write names a park group,
 *     every settings call names one, the dev full seed (finding 5), the seam
 *     greps (booth, POS, console, launcher, api, packages, services), the 4a
 *     fences (Attention paused, `settings_key_unique` kept, no NOT NULL,
 *     nothing of rounds 5-7), and the census with its evidence (finding 3).
 *
 * Findings are pinned with `it.fails` (the repo's review convention): each
 * states the behaviour that should hold, fails today, and turns red the day it
 * is fixed so the fix round flips it. A normal `it` beside each proves the
 * failure is the defect and not the arrangement. Five, none blocking 4a:
 *
 *  1. (low) The default park group is slug `default` and nothing else. On a
 *     database whose only park group carries another slug, 0006 MINTS a
 *     second park group ('OTO Default'), gives it every setting and every
 *     activity row it cannot place, and that database's real park group is
 *     then refused its own settings saves (409 `settings_shared`); with no
 *     settings to place there is no default at all and every save is refused
 *     with words that name a default park group that does not exist. The
 *     app's own `getDefaultTenantId` (routes.ts) takes "any existing tenant"
 *     before it creates one. Staging and production carry the slug, so
 *     nothing deployed is affected today (C).
 *  2. (low) Data Admin (`/api/data-admin/settings`, any park group's admin)
 *     writes a settings row for ANY park group in 4a. Under the old unique it
 *     then holds that key against the default park group, whose save answers
 *     409 `settings_key_held` until 4b — the very outcome Q29 refuses every
 *     other door to prevent. The census names Data Admin's reach in general
 *     (round 7); this is its 4a-specific effect (D).
 *  3. (low) The census row for `i18n_translations` names four routes; a fifth,
 *     `POST /api/dropoff-form/:formId/publish`, also takes another park
 *     group's form id unchecked, reads and writes its translations, and
 *     publishes the form (E).
 *  4. (low) The backfill's and `createActivityLog`'s actor step is described as
 *     "the app's strict placement (managedUserTenant)" but is laxer: it counts
 *     `user_branch_access.tenant_id` only, so a user whose access row names
 *     park group B but a branch of A, or an operator admin whose operator is
 *     A's, is placed in B where managedUserTenant places nobody (A).
 *  5. (low) The dev full seed (`script/full/main.ts`) still writes settings,
 *     Activity and Attention rows with no park group: the read-back fails
 *     after it, and once 4b sets NOT NULL the seed cannot run (E).
 *
 * Sections A, B and E run everywhere; C's and D's HTTP parts need the app's
 * node_modules (present locally and in CI's OTO App job).
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_MODULES = ['pg', 'drizzle-orm'].every((m) => existsSync(join(APP_NODE_MODULES, m, 'package.json')));
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);
const READBACK = join(APP_DIR, 'script', 'tenant-ownership-readback.mjs');
const TABLES = ['settings', 'activity_log', 'attention_items'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}
const journal = (): Journal => JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;

/** A copy of the app's migrations up to and including `idx`. */
function migrationsUpTo(idx: number): string {
  const j = journal();
  const live = j.entries.filter((e) => e.idx <= idx);
  const dir = mkdtempSync(join(tmpdir(), 'otoapp-r4a-review-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...j, entries: live }));
  for (const e of live) copyFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>, name = 'zz-r4a-review'): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: name });
  await c.connect();
  try {
    await c.query('set search_path to otoapp');
    return await work(c);
  } finally {
    await c.end();
  }
}

/** A fresh platform database whose otoapp schema stands at 0005 (round 2's view included). */
async function databaseAt0005(): Promise<{ url: string; drop: () => Promise<void> }> {
  const { url, drop } = await createTestDatabase();
  const dir = migrationsUpTo(5);
  await withClient(url, (c) => migrate(drizzle(c), { migrationsFolder: dir, migrationsSchema: 'otoapp' }));
  return {
    url,
    drop: async () => {
      rmSync(dir, { recursive: true, force: true });
      await drop();
    },
  };
}

/** The app's own migrator where it can run here; else the same SQL through the same Drizzle migrator. */
async function upgrade(url: string): Promise<void> {
  if (HAS_APP_MODULES) {
    const out = spawnSync(process.execPath, [join(APP_DIR, 'script', 'migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(out.status, out.stderr + out.stdout).toBe(0);
    return;
  }
  await applyOtoAppMigrations(url);
}

const insertRow = (c: pg.Client, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return c.query(
    `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
};

/** 0006's backfill statements, as committed: what round 4b must run again over the hand-over's rows. */
function backfillStatements(): string[] {
  const text = readFileSync(join(APP_MIGRATIONS, '0006_tenant_ownership_expand.sql'), 'utf8');
  const start = text.indexOf('-- activity_log: its branch');
  const end = text.indexOf('CREATE INDEX');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return text
    .slice(start, end)
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean);
}

async function runBackfillAgain(url: string): Promise<void> {
  await withClient(url, async (c) => {
    await c.query('begin');
    for (const statement of backfillStatements()) await c.query(statement);
    await c.query('commit');
  });
}

/** Every column, constraint and index of the three tables, as text. */
async function catalogue(c: pg.Client): Promise<{ columns: string[]; constraints: string[]; indexes: string[] }> {
  const cols = await c.query<{ t: string; c: string; ty: string; n: string; d: string | null }>(
    `select table_name as t, column_name as c, data_type as ty, is_nullable as n, column_default as d
       from information_schema.columns where table_schema = 'otoapp' and table_name = any($1) order by 1, 2`,
    [TABLES],
  );
  const cons = await c.query<{ t: string; name: string; def: string }>(
    `select r.relname as t, con.conname as name, pg_get_constraintdef(con.oid) as def
       from pg_constraint con join pg_class r on r.oid = con.conrelid join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'otoapp' and r.relname = any($1) order by 1, 2`,
    [TABLES],
  );
  const idx = await c.query<{ t: string; name: string; def: string }>(
    `select tablename as t, indexname as name, indexdef as def from pg_indexes
      where schemaname = 'otoapp' and tablename = any($1) order by 1, 2`,
    [TABLES],
  );
  return {
    columns: cols.rows.map((r) => `${r.t}.${r.c} ${r.ty} ${r.n} ${r.d ?? ''}`),
    constraints: cons.rows.map((r) => `${r.t}.${r.name} ${r.def}`),
    indexes: idx.rows.map((r) => `${r.t}.${r.name} ${r.def}`),
  };
}

const PASSWORD = 'zz-r4a-review-password';
/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

// =============================================================================
// A. H10 — a harsher backfill fixture
// =============================================================================

describe('A. H10, harsher: the backfill on a seeded 0005 state, upgraded by the app’s migrator', () => {
  let url = '';
  let drop: () => Promise<void> = async () => undefined;
  const D = randomUUID(); // the default park group
  const A = randomUUID();
  const B = randomUUID();
  const id = {
    bD: randomUUID(),
    bA: randomUUID(),
    bB: randomUUID(),
    eA: randomUUID(), // A's, at A's branch
    eB: randomUUID(), // B's, in no branch
    cB: randomUUID(), // a contract of eB whose own branch is A's
    opA: randomUUID(), // an operator of A
    uA: randomUUID(), // all branches of A
    uB: randomUUID(), // B's branch only
    uSplit: randomUUID(), // access rows in A and in B
    uNone: randomUUID(), // no access row
    uMoved: randomUUID(), // acted for D, since moved to B
    uMixed: randomUUID(), // an access row naming B with A's branch in it
    uOpAdmin: randomUUID(), // operator admin of A's operator, access rows in B
  };
  /** Each activity row, and the park group the backfill as built gives it. */
  const activity: Record<string, { row: Record<string, string>; expected: string }> = {
    branchOverEmployee: { row: { branch_id: id.bA, employee_id: id.eB }, expected: A },
    employeeInNoBranch: { row: { employee_id: id.eB }, expected: B },
    // The contract step reads the contract's employee, not the contract's own branch.
    contractEmployeeOverContractBranch: { row: { contract_instance_id: id.cB }, expected: B },
    branchOverActor: { row: { branch_id: id.bD, created_by: id.uB }, expected: D },
    employeeOverActor: { row: { employee_id: id.eA, created_by: id.uB }, expected: A },
    contractOverActor: { row: { contract_instance_id: id.cB, created_by: id.uA }, expected: B },
    actorAllBranches: { row: { created_by: id.uA }, expected: A },
    actorOneBranch: { row: { created_by: id.uB }, expected: B },
    actorInTwo: { row: { created_by: id.uSplit }, expected: D },
    actorWithNoAccess: { row: { created_by: id.uNone }, expected: D },
    nothing: { row: {}, expected: D },
    // A LIMIT, not a finding: a user who acted for D and was later moved to B
    // takes the row to B. No history says where they stood; production holds
    // one park group, where every such row is the default's.
    actorMovedSince: { row: { created_by: id.uMoved }, expected: B },
  };
  /** Rows the app's strict placement would not place: as built B, where managedUserTenant places nobody (finding 4). */
  const strict: Record<string, { row: Record<string, string>; asBuilt: string; strict: string }> = {
    actorAccessRowCrossesParkGroups: { row: { created_by: id.uMixed }, asBuilt: B, strict: D },
    operatorAdminOfAnotherParkGroup: { row: { created_by: id.uOpAdmin }, asBuilt: B, strict: D },
  };
  const attention: Record<string, { row: Record<string, string>; expected: string }> = {
    branchOverEmployee: { row: { branch_id: id.bB, employee_id: id.eA }, expected: B },
    employeeInNoBranch: { row: { employee_id: id.eB }, expected: B },
    contractEmployee: { row: { contract_instance_id: id.cB }, expected: B },
    // Raised by the engine: who resolved it says nothing (Q30).
    resolvedByB: { row: { resolved_by: id.uB }, expected: D },
  };
  const rowIds = new Map<string, string>();
  let before: Awaited<ReturnType<typeof catalogue>> = { columns: [], constraints: [], indexes: [] };
  let after: Awaited<ReturnType<typeof catalogue>> = { columns: [], constraints: [], indexes: [] };
  let viewBefore = '';
  let totalsBefore: Record<string, number> = {};

  beforeAll(async () => {
    ({ url, drop } = await databaseAt0005());
    await withClient(url, async (c) => {
      await c.query(
        `insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default'), ($2, 'ZZ R4A A', 'zz-r4a-a'), ($3, 'ZZ R4A B', 'zz-r4a-b')`,
        [D, A, B],
      );
      for (const [branch, tenant] of [[id.bD, D], [id.bA, A], [id.bB, B]] as const) {
        await insertRow(c, 'branches', { id: branch, tenant_id: tenant, name: `ZZ R4A ${branch.slice(0, 6)}`, address: 'x' });
      }
      await insertRow(c, 'operators', { id: id.opA, tenant_id: A, name: 'ZZ R4A operator A' });
      await insertRow(c, 'employees', { id: id.eA, tenant_id: A, branch_id: id.bA, full_name: 'ZZ A', nickname: 'ZZ', email: `zz-a-${id.eA}@example.com` });
      await insertRow(c, 'employees', { id: id.eB, tenant_id: B, full_name: 'ZZ B', nickname: 'ZZ', email: `zz-b-${id.eB}@example.com` });
      for (const user of [id.uA, id.uB, id.uSplit, id.uNone, id.uMoved, id.uMixed]) {
        await insertRow(c, 'users', { id: user, email: `zz-u-${user}@example.com`, password: 'x', full_name: 'ZZ', role: 'admin' });
      }
      await insertRow(c, 'users', {
        id: id.uOpAdmin,
        email: `zz-u-${id.uOpAdmin}@example.com`,
        password: 'x',
        full_name: 'ZZ',
        role: 'operator_admin',
        operator_id: id.opA,
      });
      const access = (user: string, tenant: string, branch: string | null) =>
        insertRow(c, 'user_branch_access', {
          tenant_id: tenant,
          user_id: user,
          branch_id: branch,
          access_scope: branch ? 'selected_branches' : 'all_branches',
        });
      await access(id.uA, A, null);
      await access(id.uB, B, id.bB);
      await access(id.uSplit, A, null);
      await access(id.uSplit, B, null);
      await access(id.uMoved, B, id.bB);
      await access(id.uMixed, B, id.bA);
      await access(id.uOpAdmin, B, null);
      const template = randomUUID();
      await insertRow(c, 'templates', { id: template, name: 'ZZ R4A template', html_body: '<p>zz</p>' });
      await insertRow(c, 'contract_instances', {
        id: id.cB,
        employee_id: id.eB,
        template_id: template,
        branch_id: id.bA,
        template_snapshot_html: '<p>zz</p>',
        template_snapshot_version: 1,
        merge_data_json: '{}',
        created_by: id.uNone,
      });
      for (const [name, { row }] of [...Object.entries(activity), ...Object.entries(strict)]) {
        const rowId = randomUUID();
        rowIds.set(`activity:${name}`, rowId);
        await insertRow(c, 'activity_log', { id: rowId, activity_type: 'employee_updated', summary_text: `ZZ ${name}`, ...row });
      }
      for (const [name, { row }] of Object.entries(attention)) {
        const rowId = randomUUID();
        rowIds.set(`attention:${name}`, rowId);
        await insertRow(c, 'attention_items', { id: rowId, type: 'CONTRACT_NOT_SENT', title: `ZZ ${name}`, ...row });
      }
      await c.query(
        `insert into settings (key, value) values ('md_signatory_name', 'ZZ MD'), ('md_signature_image', 'zz-image'), ('fix_department_id', '')`,
      );
      before = await catalogue(c);
      viewBefore = (await c.query<{ d: string }>(`select pg_get_viewdef('otoapp_v.employees'::regclass) as d`)).rows[0]!.d;
      totalsBefore = {};
      for (const t of TABLES) totalsBefore[t] = Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
    });
    await upgrade(url);
    after = await withClient(url, (c) => catalogue(c));
  });

  afterAll(async () => {
    await drop();
  });

  const tenantOf = async (table: string) =>
    new Map(
      (await withClient(url, (c) => c.query<{ id: string; tenant_id: string | null }>(`select id, tenant_id from ${table}`))).rows.map(
        (r) => [r.id, r.tenant_id],
      ),
    );

  it('every activity row lands where its own links put it: branch, employee, contract, actor, then the default', async () => {
    const got = await tenantOf('activity_log');
    const wrong = Object.entries(activity)
      .filter(([name, { expected }]) => got.get(rowIds.get(`activity:${name}`)!) !== expected)
      .map(([name]) => name);
    expect(wrong).toEqual([]);
  });

  it('every attention item lands where its links put it, the resolver never counted', async () => {
    const got = await tenantOf('attention_items');
    const wrong = Object.entries(attention)
      .filter(([name, { expected }]) => got.get(rowIds.get(`attention:${name}`)!) !== expected)
      .map(([name]) => name);
    expect(wrong).toEqual([]);
  });

  it('every setting is the default park group’s, and no default park group is made beside the one there', async () => {
    await withClient(url, async (c) => {
      const s = await c.query<{ tenant_id: string }>('select distinct tenant_id from settings');
      expect(s.rows).toEqual([{ tenant_id: D }]);
      const t = await c.query<{ n: number }>('select count(*)::int as n from tenants');
      expect(t.rows[0]!.n).toBe(3);
    });
  });

  it('none null, none orphaned, the totals unchanged, and no activity or attention row disagrees with its own branch', async () => {
    await withClient(url, async (c) => {
      for (const t of TABLES) {
        expect((await c.query(`select 1 from ${t} where tenant_id is null`)).rowCount, t).toBe(0);
        expect(
          (await c.query(`select 1 from ${t} x where not exists (select 1 from tenants y where y.id = x.tenant_id)`)).rowCount,
          t,
        ).toBe(0);
        expect(Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n), t).toBe(totalsBefore[t]);
      }
      for (const t of ['activity_log', 'attention_items']) {
        const disagree = await c.query(`select 1 from ${t} a join branches b on b.id = a.branch_id where a.tenant_id <> b.tenant_id`);
        expect(disagree.rowCount, t).toBe(0);
      }
    });
  });

  it('is expand only, read off the catalogue: everything the three tables had is still there, and only the declared additions are new', () => {
    for (const key of ['columns', 'constraints', 'indexes'] as const) {
      const missing = before[key].filter((x) => !after[key].includes(x));
      expect(missing, key).toEqual([]);
    }
    const added = (key: 'columns' | 'constraints' | 'indexes') =>
      after[key].filter((x) => !before[key].includes(x)).map((x) => x.split(' ')[0]);
    expect(added('columns')).toEqual(['activity_log.tenant_id', 'attention_items.tenant_id', 'settings.tenant_id']);
    expect(after.columns.filter((x) => x.includes('.tenant_id '))).toEqual([
      'activity_log.tenant_id uuid YES ',
      'attention_items.tenant_id uuid YES ',
      'settings.tenant_id uuid YES ',
    ]);
    expect(added('constraints')).toEqual([
      'activity_log.activity_log_tenant_id_tenants_id_fk',
      'attention_items.attention_items_tenant_id_tenants_id_fk',
      'settings.settings_tenant_id_tenants_id_fk',
    ]);
    expect(added('indexes')).toEqual([
      'activity_log.idx_activity_log_tenant',
      'attention_items.idx_attention_items_tenant',
      'settings.settings_tenant_id_key_unique',
    ]);
    expect(after.constraints.some((x) => x.startsWith('settings.settings_key_unique UNIQUE (key)'))).toBe(true);
  });

  it('the employee view the platform reads (0005) is untouched and still answers', async () => {
    await withClient(url, async (c) => {
      const viewAfter = (await c.query<{ d: string }>(`select pg_get_viewdef('otoapp_v.employees'::regclass) as d`)).rows[0]!.d;
      expect(viewAfter).toBe(viewBefore);
      const n = await c.query<{ n: number }>('select count(*)::int as n from otoapp_v.employees');
      const all = await c.query<{ n: number }>('select count(*)::int as n from employees');
      expect(n.rows[0]!.n).toBe(all.rows[0]!.n);
    });
  });

  it('0006’s backfill run again (4b’s step) places only rows left null, and moves nothing else', async () => {
    const snapshot = async () =>
      withClient(url, async (c) => {
        const out: Record<string, string> = {};
        for (const t of TABLES) {
          const r = await c.query<{ h: string }>(
            `select md5(coalesce(string_agg(id || ':' || tenant_id, ',' order by id), '')) as h from ${t} where tenant_id is not null`,
          );
          out[t] = r.rows[0]!.h;
        }
        return out;
      });
    const first = await snapshot();
    const handover = { activity: randomUUID(), attention: randomUUID() };
    await withClient(url, async (c) => {
      await insertRow(c, 'activity_log', { id: handover.activity, activity_type: 'employee_updated', summary_text: 'ZZ hand-over', branch_id: id.bB });
      await insertRow(c, 'attention_items', { id: handover.attention, type: 'CONTRACT_NOT_SENT', title: 'ZZ hand-over', employee_id: id.eA });
      await c.query(`insert into settings (key, value) values ('zz_handover_key', 'x')`);
    });
    expect(await snapshot()).toEqual(first);
    await runBackfillAgain(url);
    await withClient(url, async (c) => {
      expect((await c.query('select tenant_id from activity_log where id = $1', [handover.activity])).rows).toEqual([{ tenant_id: B }]);
      expect((await c.query('select tenant_id from attention_items where id = $1', [handover.attention])).rows).toEqual([{ tenant_id: A }]);
      expect((await c.query(`select tenant_id from settings where key = 'zz_handover_key'`)).rows).toEqual([{ tenant_id: D }]);
      expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(3);
      await c.query('delete from activity_log where id = $1', [handover.activity]);
      await c.query('delete from attention_items where id = $1', [handover.attention]);
      await c.query(`delete from settings where key = 'zz_handover_key'`);
    });
    expect(await snapshot()).toEqual(first);
    // A third run over nothing left null changes nothing.
    await runBackfillAgain(url);
    expect(await snapshot()).toEqual(first);
  });

  it('as built, the actor step places users the app’s strict placement would not (finding 4’s arrangement)', async () => {
    const got = await tenantOf('activity_log');
    for (const [name, { asBuilt }] of Object.entries(strict)) {
      expect(got.get(rowIds.get(`activity:${name}`)!), name).toBe(asBuilt);
    }
  });

  /**
   * FINDING 4 (low). Section 7, Q30 and the migration's header call the actor
   * step "the app's strict placement (`managedUserTenant`)". It is not: it
   * counts `user_branch_access.tenant_id` alone. `managedUserTenant`
   * (routes.ts) also refuses a user whose access rows name a branch of another
   * park group, and an operator admin whose operator belongs to another park
   * group — it places them nowhere, so their rows would fall to the default.
   * The same lax rule is in `createActivityLog`. Only inconsistent rows reach
   * it, so the effect is small; but the claim and the code disagree.
   *
   * Prescribed fix (either): add managedUserTenant's two checks to the actor
   * step (0006 cannot change once applied anywhere, so in createActivityLog
   * and in 4b's re-run of the backfill), or correct section 7, Q30 and the
   * migration's comment to say what the step is ("access rows naming exactly
   * one park group").
   */
  it.fails('FINDING 4: the actor step places only users managedUserTenant places', async () => {
    const got = await tenantOf('activity_log');
    for (const [name, { strict: expected }] of Object.entries(strict)) {
      expect(got.get(rowIds.get(`activity:${name}`)!), name).toBe(expected);
    }
  });
});

// =============================================================================
// B. The migration window, with real concurrency
// =============================================================================

async function waitForLockWait(watch: pg.Client, application: string): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const r = await watch.query(`select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`, [
      application,
    ]);
    if (r.rowCount) return;
    await sleep(25);
  }
  throw new Error(`${application} never waited on a lock`);
}

describe('B. the migration window: in flight is placed, queued behind 0006 lands unplaced and is counted', () => {
  it('a write in flight when 0006 starts is placed; one queued behind its lock lands with no park group; the read-back counts it; 4b’s re-run places it', async () => {
    const { url, drop } = await databaseAt0005();
    const D = randomUUID();
    const A = randomUUID();
    const bA = randomUUID();
    const inFlight = randomUUID();
    const queued = randomUUID();
    try {
      await withClient(url, async (c) => {
        await c.query(`insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default'), ($2, 'ZZ window A', 'zz-window-a')`, [D, A]);
        await insertRow(c, 'branches', { id: bA, tenant_id: A, name: 'ZZ window branch', address: 'x' });
      });
      const clients = ['zz-r4a-w1', 'zz-r4a-w2', 'zz-r4a-migrate', 'zz-r4a-watch'].map(
        (name) => new pg.Client({ connectionString: url, application_name: name }),
      );
      const [w1, w2, mig, watch] = clients as [pg.Client, pg.Client, pg.Client, pg.Client];
      await Promise.all(clients.map((c) => c.connect()));
      try {
        for (const c of [w1, w2, mig]) await c.query('set search_path to otoapp');
        // The previous release, mid-write, as the deploy's migrator starts.
        await w1.query('begin');
        await w1.query(
          `insert into activity_log (id, activity_type, summary_text, branch_id) values ($1, 'employee_updated', 'ZZ in flight', $2)`,
          [inFlight, bA],
        );
        const migrating = migrate(drizzle(mig), { migrationsFolder: APP_MIGRATIONS, migrationsSchema: 'otoapp' });
        await waitForLockWait(watch, 'zz-r4a-migrate');
        // The previous release's next write queues behind 0006's lock.
        const writing = w2.query(
          `insert into activity_log (id, activity_type, summary_text, branch_id) values ($1, 'employee_updated', 'ZZ queued', $2)`,
          [queued, bA],
        );
        await waitForLockWait(watch, 'zz-r4a-w2');
        await w1.query('commit');
        await migrating;
        await writing;
      } finally {
        await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
      }
      await withClient(url, async (c) => {
        const rows = await c.query<{ id: string; tenant_id: string | null }>('select id, tenant_id from activity_log order by summary_text');
        expect(new Map(rows.rows.map((r) => [r.id, r.tenant_id]))).toEqual(
          new Map([
            [inFlight, A],
            [queued, null],
          ]),
        );
        expect(Number((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n)).toBe(journal().entries.length);
      });
      if (HAS_APP_MODULES) {
        const out = spawnSync(process.execPath, [READBACK], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
        expect(out.status, out.stdout + out.stderr).toBe(1);
        expect(out.stdout).toMatch(/activity_log: 2 rows, 1 with no park group/);
      }
      await runBackfillAgain(url);
      await withClient(url, async (c) => {
        expect((await c.query('select tenant_id from activity_log where id = $1', [queued])).rows).toEqual([{ tenant_id: A }]);
      });
      if (HAS_APP_MODULES) {
        const out = spawnSync(process.execPath, [READBACK], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
        expect(out.status, out.stdout + out.stderr).toBe(0);
      }
    } finally {
      await drop();
    }
  }, 120_000);
});

// =============================================================================
// The app over HTTP: the harness the builder's check boots
// =============================================================================

const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill();
});

async function serve(databaseUrl: string, env: Record<string, string> = {}): Promise<string> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    APP_ENV: 'dev',
    STORAGE_ENV_PREFIX: 'zz-r4a-review',
    OBJECT_STORAGE: 'local',
    OTOAPP_LEGACY_LOGIN: 'true',
    LOG_LEVEL: 'warn',
    TZ: 'UTC',
    DEPLOY_ENV: 'local',
    DIRECTORY_API_RATE_LIMIT_MAX_REQUESTS: '100000',
    DATABASE_URL: databaseUrl,
    ...env,
  };
  if (!env.HR_DIRECTORY_API_KEY) delete childEnv.HR_DIRECTORY_API_KEY;
  const child = spawn(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: APP_DIR,
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field
  body: any;
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
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text.
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
  const res = await call(origin, 'POST', '/api/login', { body: { identifier: email, password: PASSWORD } });
  expect(res.status, `sign-in as ${email}: ${res.text}`).toBe(200);
  return res.cookie;
}

type Exec = (text: string, params: unknown[]) => Promise<unknown>;

async function appUser(exec: Exec, tenant: string, email: string, role = 'admin'): Promise<string> {
  const user = randomUUID();
  await exec(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, $3, 'ZZ R4A review', $4, true, false)`,
    [user, email, hashPassword(PASSWORD), role],
  );
  await exec(`insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')`, [
    tenant,
    user,
  ]);
  return user;
}

// =============================================================================
// C. A database whose one park group is not slug "default" (finding 1)
// =============================================================================

describe('C. finding 1: a database whose ONE park group is not slug “default”', () => {
  let url = '';
  let drop: () => Promise<void> = async () => undefined;
  const O = randomUUID();
  const bO = randomUUID();
  const run = randomBytes(3).toString('hex');
  const email = `zz-r4a-only-${run}@example.com`;
  const unlinked = randomUUID();
  const placedByBranch = randomUUID();

  beforeAll(async () => {
    ({ url, drop } = await databaseAt0005());
    await withClient(url, async (c) => {
      await c.query(`insert into tenants (id, name, slug) values ($1, 'ZZ The only park group', 'zz-only')`, [O]);
      await insertRow(c, 'branches', { id: bO, tenant_id: O, name: 'ZZ only branch', address: 'x' });
      await appUser((text, params) => c.query(text, params), O, email);
      await c.query(`insert into settings (key, value) values ('md_signatory_name', 'ZZ Only MD')`);
      await insertRow(c, 'activity_log', { id: placedByBranch, activity_type: 'employee_updated', summary_text: 'ZZ by branch', branch_id: bO });
      // A user created by an old account with no access row: no branch, no employee, no actor to place it.
      await insertRow(c, 'activity_log', { id: unlinked, activity_type: 'USER_CREATED', summary_text: 'ZZ unlinked' });
    });
    await upgrade(url);
  });

  afterAll(async () => {
    await drop();
  });

  it('as built: 0006 mints a second park group, “OTO Default”, and gives it the settings and the row it cannot place', async () => {
    await withClient(url, async (c) => {
      const tenants = await c.query<{ id: string; slug: string }>('select id, slug from tenants order by slug');
      expect(tenants.rows.map((t) => t.slug)).toEqual(['default', 'zz-only']);
      const minted = tenants.rows.find((t) => t.slug === 'default')!.id;
      expect((await c.query(`select tenant_id from settings`)).rows).toEqual([{ tenant_id: minted }]);
      expect((await c.query('select tenant_id from activity_log where id = $1', [unlinked])).rows).toEqual([{ tenant_id: minted }]);
      expect((await c.query('select tenant_id from activity_log where id = $1', [placedByBranch])).rows).toEqual([{ tenant_id: O }]);
    });
  });

  /**
   * FINDING 1 (low). "The default park group" is slug `default` and nothing
   * else — in 0006, in `getDefaultParkGroupId` and in the read-back. On a
   * database whose only park group carries another slug, 0006 makes a second
   * park group, gives it every setting and every activity row it cannot place
   * (mis-tenanted: there is only one park group they can belong to), and
   * from then on the database's real park group is refused its own settings
   * saves (the test below). Where such a database has no settings to place,
   * 0006 makes nothing, `getDefaultParkGroupId` answers null, and
   * `settingsWritableBy(owner, null)` refuses every park group with words
   * that name a default park group that does not exist.
   *
   * The app's own rule for its default tenant (`getDefaultTenantId`,
   * routes.ts:159) is the slug, else ANY existing tenant, and only then a new
   * one. Staging and production carry the slug (the sample seed, extracted
   * from production, and `getDefaultTenantId` both write `default`), so
   * nothing deployed is affected today.
   *
   * Prescribed fix: 0006 is applied nowhere yet, so it can still change —
   * where tenants exist and none is slug `default`, either take the single
   * tenant when there is exactly one (the app's rule), or stop the migration
   * loudly naming the tenants rather than minting one; `getDefaultParkGroupId`
   * follows the same rule.
   */
  it.fails('FINDING 1: a one-park-group database stays one park group, and its rows are that park group’s', async () => {
    await withClient(url, async (c) => {
      expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(1);
      expect((await c.query(`select distinct tenant_id from settings`)).rows).toEqual([{ tenant_id: O }]);
      expect((await c.query('select tenant_id from activity_log where id = $1', [unlinked])).rows).toEqual([{ tenant_id: O }]);
    });
  });

  it.skipIf(!HAS_APP_RUNTIME)('as built, over HTTP: that database’s only real park group is refused its own settings save', async () => {
    const origin = await serve(url);
    const cookie = await appSignIn(origin, email);
    const read = await call(origin, 'GET', '/api/settings', { cookie });
    expect(read.status, read.text).toBe(200);
    expect((read.body as { key: string; value: string }[]).find((s) => s.key === 'md_signatory_name')?.value).toBe('ZZ Only MD');
    const save = await call(origin, 'POST', '/api/settings', { cookie, body: [{ key: 'md_signatory_name', value: 'ZZ new MD' }] });
    expect(save.status, save.text).toBe(409);
    expect(save.body.reason).toBe('settings_shared');
  }, 240_000);
});

// =============================================================================
// D. Over HTTP: H11 on both shapes, Data Admin, H12 over the six reads, the logbook
// =============================================================================

describe.skipIf(!HAS_APP_RUNTIME)('D. over HTTP against the app’s routes: H11, Data Admin, H12 and the logbook', () => {
  let url = '';
  let drop: () => Promise<void> = async () => undefined;
  let pool: pg.Pool;
  let plain = '';
  let shared = '';
  const run = randomBytes(3).toString('hex');
  const SHARED = `zz-r4a-shared-${randomBytes(16).toString('hex')}`;
  const K = (name: string) => `zz_r4a_review_${run}_${name}`;
  const TERM = `ZZR4A${run}`;

  interface ParkGroup {
    tenant: string;
    name: string;
    slug: string;
    branch: string;
    branchName: string;
    department: string;
    role: string;
    employee: string;
    adminEmail: string;
    cookie: string;
  }
  let PD: ParkGroup;
  let PB: ParkGroup;
  /** D's employee whose own branch, department, role and presence are B's. */
  const crossed = randomUUID();
  const keys = { hrD: '', hrB: '', scopeless: '', eventsOnly: '', revoked: '', inactive: '' };
  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await pool.query<T>(text, params)).rows;
  const rowsFor = (key: string) =>
    q<{ tenant_id: string | null; value: string }>('select tenant_id, value from settings where key = $1 order by value', [key]);

  async function parkGroup(label: string, tenant: string, name: string, slug: string): Promise<Omit<ParkGroup, 'cookie'>> {
    const branch = randomUUID();
    const branchName = `ZZ R4A ${label} branch ${run}`;
    await q('insert into branches (id, tenant_id, name, address) values ($1, $2, $3, $4)', [branch, tenant, branchName, 'x']);
    const department = randomUUID();
    await q('insert into departments (id, tenant_id, name) values ($1, $2, $3)', [department, tenant, `ZZ R4A ${label} dept ${run}`]);
    const role = randomUUID();
    await q('insert into roles (id, tenant_id, name) values ($1, $2, $3)', [role, tenant, `ZZ R4A ${label} role ${run}`]);
    const employee = randomUUID();
    await q(
      `insert into employees (id, tenant_id, branch_id, primary_department_id, full_name, nickname, email)
       values ($1, $2, $3, $4, $5, 'ZZ', $6)`,
      [employee, tenant, branch, department, `${TERM} ${label} staff`, `zz-r4a-${label}-${run}@example.com`],
    );
    await q('insert into employee_roles (employee_id, role_id) values ($1, $2)', [employee, role]);
    await q(
      'insert into employee_presence (employee_id, tenant_id, is_clocked_in, current_work_branch_id) values ($1, $2, true, $3)',
      [employee, tenant, branch],
    );
    const adminEmail = `zz-r4a-${label}-admin-${run}@example.com`;
    await appUser(q, tenant, adminEmail);
    return { tenant, name, slug, branch, branchName, department, role, employee, adminEmail };
  }

  async function directoryKey(tenant: string, scopes: string[], extra: { revoked?: boolean; inactive?: boolean } = {}): Promise<string> {
    const key = 'odk_' + randomBytes(32).toString('base64url');
    await q(
      `insert into directory_clients (tenant_id, name, key_hash, scopes, is_active, revoked_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        tenant,
        `ZZ R4A review ${run}`,
        createHash('sha256').update(key).digest('hex'),
        scopes,
        !extra.inactive,
        extra.revoked ? new Date() : null,
      ],
    );
    return key;
  }

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase({ otoapp: true }));
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 4 });
    const dTenant = randomUUID();
    const bTenant = randomUUID();
    await q(`insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default'), ($2, $3, $4)`, [
      dTenant,
      bTenant,
      `ZZ R4A park B ${run}`,
      `zz-r4a-b-${run}`,
    ]);
    const d = await parkGroup('d', dTenant, 'OTO Default', 'default');
    const b = await parkGroup('b', bTenant, `ZZ R4A park B ${run}`, `zz-r4a-b-${run}`);
    // D's own employee, whose every link is B's: the reads must name none of it.
    await q(
      `insert into employees (id, tenant_id, branch_id, primary_department_id, full_name, nickname, email)
       values ($1, $2, $3, $4, $5, 'ZZ', $6)`,
      [crossed, dTenant, b.branch, b.department, `${TERM} crossed staff`, `zz-r4a-crossed-${run}@example.com`],
    );
    await q('insert into employee_roles (employee_id, role_id) values ($1, $2)', [crossed, b.role]);
    await q(
      'insert into employee_presence (employee_id, tenant_id, is_clocked_in, current_work_branch_id) values ($1, $2, true, $3)',
      [crossed, dTenant, b.branch],
    );
    keys.hrD = await directoryKey(dTenant, ['hr:read']);
    keys.hrB = await directoryKey(bTenant, ['hr:read']);
    keys.scopeless = await directoryKey(dTenant, []);
    keys.eventsOnly = await directoryKey(dTenant, ['events:write', 'jobs:run']);
    keys.revoked = await directoryKey(dTenant, ['hr:read'], { revoked: true });
    keys.inactive = await directoryKey(dTenant, ['hr:read'], { inactive: true });
    await q(`insert into settings (key, value, tenant_id) values ('md_signatory_name', 'ZZ D MD', $1)`, [dTenant]);
    [plain, shared] = await Promise.all([serve(url), serve(url, { HR_DIRECTORY_API_KEY: SHARED })]);
    PD = { ...d, cookie: await appSignIn(plain, d.adminEmail) };
    PB = { ...b, cookie: await appSignIn(plain, b.adminEmail) };
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await drop();
  });

  const save = (who: ParkGroup, body: { key: string; value: string }[]) =>
    call(plain, 'POST', '/api/settings', { cookie: who.cookie, body });
  const readAs = async (who: ParkGroup) => {
    const res = await call(plain, 'GET', '/api/settings', { cookie: who.cookie });
    expect(res.status, res.text).toBe(200);
    return new Map((res.body as { key: string; value: string }[]).map((s) => [s.key, s.value]));
  };

  /** Every settings answer on one constraint shape (H11). */
  async function settingsOnThisShape(shape: 'old' | 'new'): Promise<number[]> {
    const statuses: number[] = [];
    const k = (name: string) => K(`${shape}_${name}`);
    // Another park group: refused in words, whatever the key, and nothing written.
    for (const key of ['md_signatory_name', k('nobody')]) {
      const res = await save(PB, [{ key, value: 'B wants it' }]);
      statuses.push(res.status);
      expect(res.status, res.text).toBe(409);
      expect(res.body.reason).toBe('settings_shared');
    }
    expect(await rowsFor(k('nobody'))).toEqual([]);
    expect(await rowsFor('md_signatory_name')).toEqual([{ tenant_id: PD.tenant, value: 'ZZ D MD' }]);
    const fix = await call(plain, 'POST', '/api/settings/fix-department', { cookie: PB.cookie, body: { departmentId: PB.department } });
    statuses.push(fix.status);
    expect(fix.status, fix.text).toBe(409);
    // The default park group: five saves of one new key at once — one row, every answer 200.
    const race = await Promise.all(
      Array.from({ length: 5 }, (_, i) => save(PD, [{ key: k('race'), value: `racer ${i}` }])),
    );
    statuses.push(...race.map((r) => r.status));
    expect(race.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const raced = await rowsFor(k('race'));
    expect(raced).toHaveLength(1);
    expect(raced[0]!.tenant_id).toBe(PD.tenant);
    // A row the previous release left with no park group: read by both, claimed by the default's save.
    await q(`insert into settings (key, value) values ($1, 'hand-over')`, [k('handover')]);
    expect((await readAs(PB)).get(k('handover'))).toBe('hand-over');
    const claim = await save(PD, [{ key: k('handover'), value: 'claimed' }]);
    statuses.push(claim.status);
    expect(claim.status, claim.text).toBe(200);
    expect(await rowsFor(k('handover'))).toEqual([{ tenant_id: PD.tenant, value: 'claimed' }]);
    // A key another park group's row holds (only a hand insert or Data Admin can make one).
    await q('insert into settings (key, value, tenant_id) values ($1, $2, $3)', [k('heldByB'), 'B row', PB.tenant]);
    const held = await save(PD, [{ key: k('heldByB'), value: 'D row' }]);
    statuses.push(held.status);
    if (shape === 'old') {
      expect(held.status, held.text).toBe(409);
      expect(held.body.reason).toBe('settings_key_held');
      expect(await rowsFor(k('heldByB'))).toEqual([{ tenant_id: PB.tenant, value: 'B row' }]);
    } else {
      expect(held.status, held.text).toBe(200);
      expect(await rowsFor(k('heldByB'))).toEqual([
        { tenant_id: PB.tenant, value: 'B row' },
        { tenant_id: PD.tenant, value: 'D row' },
      ]);
      expect((await readAs(PB)).get(k('heldByB'))).toBe('B row');
      expect((await readAs(PD)).get(k('heldByB'))).toBe('D row');
    }
    // The default park group reads its own; B, with no row of its own, reads the default's (Q28).
    expect((await readAs(PD)).get('md_signatory_name')).toBe('ZZ D MD');
    expect((await readAs(PB)).get('md_signatory_name')).toBe('ZZ D MD');
    return statuses;
  }

  it('H11 with the old unique standing (this release’s shape): every answer in words, never a 500', async () => {
    const statuses = await settingsOnThisShape('old');
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });

  it('H11 with the old unique dropped (4b’s shape): the same code, every answer right, never a 500 — then restored', async () => {
    await q('alter table settings drop constraint settings_key_unique');
    try {
      const statuses = await settingsOnThisShape('new');
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
    } finally {
      await q(`delete from settings where key like $1 and tenant_id is distinct from $2`, [`zz_r4a_review_${run}_%`, PD.tenant]);
      await q('alter table settings add constraint settings_key_unique unique (key)');
    }
    const uniques = await q<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'otoapp.settings'::regclass and contype = 'u' order by 1`,
    );
    expect(uniques.map((u) => u.conname)).toContain('settings_key_unique');
  });

  it('as built: Data Admin writes another park group’s settings row in 4a, and the default park group is then shut out of that key', async () => {
    const key = K('dataadmin');
    try {
      const write = await call(plain, 'POST', '/api/data-admin/settings', {
        cookie: PB.cookie,
        body: { key, value: 'B via Data Admin', tenantId: PB.tenant },
      });
      expect(write.status, write.text).toBe(201);
      expect(await rowsFor(key)).toEqual([{ tenant_id: PB.tenant, value: 'B via Data Admin' }]);
      const d = await save(PD, [{ key, value: 'the running park' }]);
      expect(d.status, d.text).toBe(409);
      expect(d.body.reason).toBe('settings_key_held');
    } finally {
      await q('delete from settings where key = $1', [key]);
    }
  });

  /**
   * FINDING 2 (low). Q29's whole point is that in 4a no park group but the
   * default writes a settings row, because under the old unique such a row
   * holds its key against the default park group — the park the app runs —
   * until 4b. `POST /api/data-admin/settings` (any park group's `admin`,
   * `requireGlobalAdmin`) inserts a row for whatever `tenantId` the body names,
   * and `PUT /api/data-admin/settings/:id` re-homes the default park group's
   * own row (its MD signatory, say) to another park group, after which the
   * default park group reads none and cannot save it back. The census names
   * Data Admin's cross-park-group reach in general and leaves it to round 7;
   * this is its effect on 4a's own constraint window.
   *
   * Prescribed fix (small, 4a or the first thing in 4b): hold `settings`
   * writes through Data Admin to the rule `upsertSetting` keeps — refuse a
   * create or update whose `tenantId` is not the default park group (or make
   * the Setting model read-only until 4b) — or record the bypass under Q29
   * and Q31 so the owner decides with it in view.
   */
  it.fails('FINDING 2: no door in 4a writes a settings row for a park group other than the default', async () => {
    const key = K('dataadmin_finding');
    try {
      const write = await call(plain, 'POST', '/api/data-admin/settings', {
        cookie: PB.cookie,
        body: { key, value: 'B via Data Admin', tenantId: PB.tenant },
      });
      expect(write.status).toBeGreaterThanOrEqual(400);
      expect(await rowsFor(key)).toEqual([]);
    } finally {
      await q('delete from settings where key = $1', [key]);
    }
  });

  // ── H12: the six reads ──────────────────────────────────────────────────────

  const dir = (origin: string, path: string, headers: Record<string, string> = {}) => call(origin, 'GET', path, { headers });
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  const six = () => [
    `/api/directory/employee/${PD.employee}`,
    `/api/directory/employees/search?q=${encodeURIComponent(TERM)}`,
    `/api/directory/branches/${PD.branch}/employees`,
    '/api/directory/roles',
    '/api/directory/departments',
    '/api/directory/branches',
  ];
  /** Nothing of B's — its park group's id, name or slug, its branch, department, role or employee. */
  const bWords = () => [PB.tenant, PB.name, PB.slug, PB.branch, PB.branchName, PB.department, PB.role, PB.employee];
  const refusals: Answer[] = [];

  it('H12: D’s key reads D’s rows on all six, and no answer names anything of B’s', async () => {
    for (const path of six()) {
      const res = await dir(plain, path, bearer(keys.hrD));
      expect(res.status, `${path}: ${res.text}`).toBe(200);
      for (const word of bWords()) expect(res.text.includes(word), `${path} names ${word}`).toBe(false);
    }
    const departmentsOfB = await dir(plain, `/api/directory/departments?branchId=${PB.branch}`, bearer(keys.hrD));
    expect(departmentsOfB.status).toBe(200);
    for (const word of bWords()) expect(departmentsOfB.text.includes(word)).toBe(false);
  });

  it('H12: D’s key on B’s employee and B’s branch roster — 404, the very answer a row that does not exist gets', async () => {
    for (const [path, none] of [
      [`/api/directory/employee/${PB.employee}`, `/api/directory/employee/${randomUUID()}`],
      [`/api/directory/branches/${PB.branch}/employees`, `/api/directory/branches/${randomUUID()}/employees`],
    ] as const) {
      const theirs = await dir(plain, path, bearer(keys.hrD));
      const nobody = await dir(plain, none, bearer(keys.hrD));
      expect(theirs.status, theirs.text).toBe(404);
      expect(theirs.text).toBe(nobody.text);
      refusals.push(theirs);
    }
    // And the other way round.
    const back = await dir(plain, `/api/directory/employee/${PD.employee}`, bearer(keys.hrB));
    expect(back.status).toBe(404);
    refusals.push(back);
  });

  it('H12: search finds only the key’s own park group’s staff, though both match the term', async () => {
    const d = await dir(plain, `/api/directory/employees/search?q=${encodeURIComponent(TERM)}`, bearer(keys.hrD));
    const b = await dir(plain, `/api/directory/employees/search?q=${encodeURIComponent(TERM)}`, bearer(keys.hrB));
    const ids = (a: Answer) => (a.body.employees as { employee_id: string }[]).map((e) => e.employee_id).sort();
    expect(ids(d)).toEqual([PD.employee, crossed].sort());
    expect(ids(b)).toEqual([PB.employee]);
  });

  it('H12: an employee of D whose own branch, department, role and presence are B’s is read with none of them', async () => {
    const res = await dir(plain, `/api/directory/employee/${crossed}`, bearer(keys.hrD));
    expect(res.status, res.text).toBe(200);
    expect(res.body.home_branch).toBeNull();
    expect(res.body.department).toBeNull();
    expect(res.body.roles).toEqual([]);
    expect(res.body.presence.current_work_branch).toBeNull();
    for (const word of bWords()) expect(res.text.includes(word), `names ${word}`).toBe(false);
    // Nor does B's roster list D's employee standing in B's branch.
    const roster = await dir(plain, `/api/directory/branches/${PB.branch}/employees`, bearer(keys.hrB));
    expect((roster.body.employees as { employee_id: string }[]).map((e) => e.employee_id)).toEqual([PB.employee]);
  });

  it('H12: on every one of the six — no key 401; scopeless, events-only, revoked, inactive and unknown keys 403', async () => {
    const unknown = 'odk_' + randomBytes(32).toString('base64url');
    for (const path of six()) {
      const none = await dir(plain, path);
      expect(none.status, `${path} no key`).toBe(401);
      refusals.push(none);
      for (const [label, key] of [
        ['scopeless', keys.scopeless],
        ['events-only', keys.eventsOnly],
        ['revoked', keys.revoked],
        ['inactive', keys.inactive],
        ['unknown', unknown],
      ] as const) {
        const res = await dir(plain, path, bearer(key));
        expect(res.status, `${path} ${label}: ${res.text}`).toBe(403);
        refusals.push(res);
      }
    }
  });

  it('H12: the shared key, unset — 403 in words on all six; set — the default park group only, on all six', async () => {
    for (const path of six()) {
      const off = await dir(plain, path, { 'x-hr-api-key': SHARED });
      expect(off.status, `${path}: ${off.text}`).toBe(403);
      refusals.push(off);
      const on = await dir(shared, path, { 'x-hr-api-key': SHARED });
      expect(on.status, `${path}: ${on.text}`).toBe(200);
      for (const word of bWords()) expect(on.text.includes(word), `${path} names ${word}`).toBe(false);
      const wrong = await dir(shared, path, { 'x-hr-api-key': `${SHARED}x` });
      expect(wrong.status).toBe(403);
      refusals.push(wrong);
    }
    const bEmployee = await dir(shared, `/api/directory/employee/${PB.employee}`, { 'x-hr-api-key': SHARED });
    expect(bEmployee.status).toBe(404);
    refusals.push(bEmployee);
  });

  it('H12: no refusal or 404 names a park group — neither B’s nor the default’s', async () => {
    expect(refusals.length).toBeGreaterThan(40);
    for (const r of refusals) {
      for (const word of [...bWords(), PD.tenant, 'OTO Default']) {
        expect(r.text.includes(word), `${r.status} ${r.text} names ${word}`).toBe(false);
      }
    }
  });

  // ── The Activity Logbook's hand-over rows ───────────────────────────────────

  it('a hand-over row with no park group shows by its branch, to that park group only; a branchless one waits for 4b, as before 4a', async () => {
    const byBranch = randomUUID();
    const branchless = randomUUID();
    await q(
      `insert into activity_log (id, branch_id, activity_type, summary_text) values ($1, $2, 'employee_updated', $3), ($4, null, 'employee_updated', $5)`,
      [byBranch, PB.branch, `ZZ R4A ${run} hand-over by branch`, branchless, `ZZ R4A ${run} hand-over branchless`],
    );
    try {
      const seen = async (who: ParkGroup) => {
        const res = await call(plain, 'GET', `/api/activity-logs?search=${encodeURIComponent(`ZZ R4A ${run}`)}&limit=100`, {
          cookie: who.cookie,
        });
        expect(res.status, res.text).toBe(200);
        return (res.body.logs as { id: string }[]).map((l) => l.id);
      };
      expect(await seen(PB)).toEqual([byBranch]);
      expect(await seen(PD)).toEqual([]);
    } finally {
      await q('delete from activity_log where id = any($1)', [[byBranch, branchless]]);
    }
  });
});

// =============================================================================
// E. Read off the code: threading, seams, fences, census
// =============================================================================

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourcesUnder(root: string, exts = /\.(ts|tsx|mjs|js|cjs)$/): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', 'dist', '.turbo', 'build', 'coverage'].includes(e.name)) return [];
    const path = join(root, e.name);
    if (e.isDirectory()) return sourcesUnder(path, exts);
    return exts.test(e.name) ? [path] : [];
  });
}

/** Each call of `name(` with its top-level arguments. */
function callsOf(text: string, name: string): { line: number; args: string[] }[] {
  const out: { line: number; args: string[] }[] = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let cur = '';
    let quote: string | null = null;
    const args: string[] = [];
    while (depth > 0 && i < text.length) {
      const ch = text[i++]!;
      if (quote) {
        cur += ch;
        if (ch === quote && text[i - 2] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        cur += ch;
        continue;
      }
      if ('({['.includes(ch)) depth += 1;
      else if (')}]'.includes(ch)) {
        depth -= 1;
        if (depth === 0) break;
      }
      if (ch === ',' && depth === 1) {
        args.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push({ line: text.slice(0, m.index).split('\n').length, args });
  }
  return out;
}

const APP_SERVER = join(APP_DIR, 'server');
const appFiles = () =>
  sourcesUnder(APP_SERVER).map((path) => ({
    rel: path.slice(APP_DIR.length).split('\\').join('/'),
    text: code(readFileSync(path, 'utf8')),
  }));

describe('E. read off the code: threading, seams, fences and the census', () => {
  it('every Activity write names what it is about (branch, employee, contract) or the caller’s park group', () => {
    const offenders: string[] = [];
    let writes = 0;
    for (const { rel, text } of appFiles()) {
      if (rel === 'server/storage.ts') continue;
      for (const name of ['createActivityLog', 'logActivity']) {
        for (const { line, args } of callsOf(text, name)) {
          const body = args[0] ?? '';
          if (!body.startsWith('{')) continue;
          writes += 1;
          const field = (k: string) => {
            const mm = new RegExp(`\\b${k}\\s*:\\s*([^,\\n]+)`).exec(body);
            if (mm) return mm[1]!.trim();
            return new RegExp(`[{,\\s]${k}\\s*[,\\n}]`).test(body) ? k : undefined;
          };
          const about = ['branchId', 'employeeId', 'contractInstanceId'].some((k) => {
            const v = field(k);
            return v !== undefined && v !== 'null';
          });
          if (!about && field('tenantId') === undefined) offenders.push(`${rel}:${line}`);
        }
      }
    }
    expect(writes).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it('every settings call names a park group: getSetting(key, park group), getSettings(park group), upsertSetting(row, park group)', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const { rel, text } of appFiles()) {
      for (const [name, arity] of [
        ['getSetting', 2],
        ['getSettings', 1],
        ['upsertSetting', 2],
      ] as const) {
        for (const { line, args } of callsOf(text, name)) {
          calls += 1;
          if (args.length !== arity || args.some((a) => a === '' || a === 'undefined')) offenders.push(`${rel}:${line} ${name}(${args.join(', ')})`);
        }
      }
    }
    expect(calls).toBeGreaterThan(15);
    expect(offenders).toEqual([]);
  });

  it('the settings table is touched only by the storage helper, the dev-only production copy, and Data Admin’s Setting model', () => {
    const touching = appFiles()
      .filter(({ text }) => /\b(from|insert|update|delete)\(\s*settings\s*\)|\bFROM\s+settings\b|\bINTO\s+settings\b|\bUPDATE\s+settings\b|table\s*=\s*settings\b/.test(text))
      .map(({ rel }) => rel)
      .sort();
    expect(touching).toEqual(['server/data-admin/models/setting.ts', 'server/prod-sync.ts', 'server/storage.ts']);
  });

  it('as built: the dev full seed writes settings, Activity and Attention rows with no park group (finding 5’s arrangement)', () => {
    const seed = readFileSync(join(APP_DIR, 'script', 'full', 'main.ts'), 'utf8');
    const settingsBlock = seed.slice(seed.indexOf('db.insert(settings).values(['), seed.indexOf('[seed-full] Created settings'));
    const activityBlock = seed.slice(seed.indexOf('activityRows.push({'), seed.indexOf('db.insert(activityLog)'));
    const attentionBlock = seed.slice(seed.indexOf('attentionRows.push({'), seed.indexOf('db.insert(attentionItems)'));
    for (const block of [settingsBlock, activityBlock, attentionBlock]) {
      expect(block.length).toBeGreaterThan(50);
      expect(block).not.toMatch(/tenantId/);
    }
  });

  /**
   * FINDING 5 (low). `script/full/main.ts` (the dev full seed) inserts its
   * settings, its 120 Activity rows and its Attention items without
   * `tenantId`. They read correctly in 4a (a setting with no park group is the
   * default's, an activity row is shown by its branch), but the read-back
   * exits 1 after the seed, and once 4b sets the three columns NOT NULL the
   * seed fails on its first insert. The seed cannot start today (its
   * `fixtures/users.json` is absent), so this is housekeeping.
   *
   * Prescribed fix: give the seed's settings, activity and attention rows
   * `tenantId: tenant.id` (it already holds the tenant it made).
   */
  it.fails('FINDING 5: the dev full seed writes every settings, Activity and Attention row with its park group', () => {
    const seed = readFileSync(join(APP_DIR, 'script', 'full', 'main.ts'), 'utf8');
    const settingsBlock = seed.slice(seed.indexOf('db.insert(settings).values(['), seed.indexOf('[seed-full] Created settings'));
    const activityBlock = seed.slice(seed.indexOf('activityRows.push({'), seed.indexOf('db.insert(activityLog)'));
    const attentionBlock = seed.slice(seed.indexOf('attentionRows.push({'), seed.indexOf('db.insert(attentionItems)'));
    for (const block of [settingsBlock, activityBlock, attentionBlock]) expect(block).toMatch(/tenantId/);
  });

  it('the seams: the booth, POS, console, launcher, api, packages and services name none of 4a’s routes, scope, key, columns or script', () => {
    const roots = ['apps/booth/src', 'apps/pos/src', 'apps/console/src', 'apps/launcher/src', 'apps/api/src', 'packages', 'services'].map((r) =>
      join(REPO, r),
    );
    const patterns = [
      /\/api\/directory\/(employee|employees|branches|roles|departments)\b/,
      /\bhr:read\b/,
      /HR_DIRECTORY_API_KEY/,
      /x-hr-api-key/i,
      /settings_tenant_id_key_unique|idx_activity_log_tenant|idx_attention_items_tenant/,
      /tenant:readback|tenant-ownership-readback/,
      /otoapp\.(settings|activity_log|attention_items)\b/,
      /parkGroupSettings|hrReadAuth/,
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const path of sourcesUnder(root, /\.(ts|tsx|mjs|js|cjs|json|sql|ya?ml)$/)) {
        const text = readFileSync(path, 'utf8');
        for (const p of patterns) if (p.test(text)) hits.push(`${path.slice(REPO.length)} ~ ${p}`);
      }
    }
    expect(hits).toEqual([]);
    const platformView = readFileSync(join(REPO, 'packages', 'db', 'src', 'schema', 'otoapp.ts'), 'utf8');
    expect(platformView).not.toMatch(/otoapp\.table\('(settings|activity_log|attention_items)'/);
  });

  it('the fences: Attention paused, no Attention or no-show job, settings_key_unique kept, no NOT NULL on the new columns', () => {
    expect(readFileSync(join(APP_SERVER, 'attention-availability.ts'), 'utf8')).toMatch(/export const ATTENTION_WRITES_READY = false;/);
    const platform = sourcesUnder(join(REPO, 'apps', 'api', 'src')).map((p) => readFileSync(p, 'utf8')).join('\n');
    expect(platform).not.toMatch(/otoapp\.attention|otoapp\.no_show|otoapp\.noshow/);
    for (const e of journal().entries) {
      const text = readFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), 'utf8').replace(/--.*$/gm, '');
      expect(text, e.tag).not.toMatch(/DROP\s+CONSTRAINT\s+"?settings_key_unique/i);
      expect(text, e.tag).not.toMatch(/DROP\s+INDEX[^;]*settings_key_unique/i);
      expect(text, e.tag).not.toMatch(/ALTER\s+TABLE\s+"?(settings|activity_log|attention_items)"?\s+ALTER\s+COLUMN\s+"?tenant_id"?\s+SET\s+NOT\s+NULL/i);
    }
    const schema = readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8');
    expect(schema).toMatch(/key: text\("key"\)\.notNull\(\)\.unique\(\),/);
  });

  it('nothing of rounds 5 to 7: the Attention 503s, the time-off approval 503s and the legacy-table guard all stand; no finance key migration', () => {
    const routes = readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8');
    expect(routes.match(/Attention rules are unavailable until tenant settings are isolated/g)?.length).toBe(2);
    expect(routes).toMatch(/Attention updates are unavailable until tenant ownership is recorded/);
    expect(routes.match(/Time-off approval is unavailable until approval tracking is enabled/g)?.length).toBe(2);
    expect(routes.match(/legacyHrUser\(/g)?.length).toBe(11);
    for (const e of journal().entries.filter((x) => x.idx > 0)) {
      const text = readFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), 'utf8');
      expect(text, e.tag).not.toMatch(/xero_tracking_categories|xero_tracking_options|cash_txns|cash_daily|pl_facts/);
    }
  });

  // ── The census ──────────────────────────────────────────────────────────────

  const plan = () => readFileSync(join(REPO, 'docs', 'progress', 'plans', 'otoapp-lift', 'PLAN.md'), 'utf8');
  const censusRow = (table: string) => plan().split('\n').find((l) => l.startsWith(`| \`${table}\` |`)) ?? '';

  /** Route handlers in a file: method, path and the handler's text up to the next route. */
  function routesIn(text: string, receiver: 'app' | 'router'): { method: string; path: string; body: string }[] {
    const re = new RegExp(`${receiver}\\.(get|post|put|patch|delete)\\("([^"]+)"`, 'g');
    const marks = [...text.matchAll(re)];
    return marks.map((m, i) => ({
      method: m[1]!.toUpperCase(),
      path: m[2]!,
      body: text.slice(m.index!, marks[i + 1]?.index ?? text.length),
    }));
  }

  it('the census gives each of the six root tables a row with its parent path and a disposition, and every exposure names Q31', () => {
    for (const table of ['coverage_rules', 'invitation_designs', 'package_line_item_templates', 'i18n_translations', 'leave_policies', 'people']) {
      const row = censusRow(table);
      expect(row, table).not.toBe('');
      const cells = row.split(' | ');
      expect(cells.length, table).toBeGreaterThanOrEqual(4);
      if (/EXPOSED/.test(row)) expect(row, table).toMatch(/Q31/);
      else expect(row, table).toMatch(/Nothing to do/);
    }
  });

  it('its evidence holds: coverage rules are called by no route; invitation designs and package line items are reached only through a checked parent', () => {
    const files = appFiles();
    const coverageCallers = files
      .filter(({ rel, text }) => rel !== 'server/storage.ts' && /\b(getCoverageRules|createCoverageRule|deleteCoverageRule)\b/.test(text))
      .map(({ rel }) => rel);
    expect(coverageCallers).toEqual([]);
    const parent = readFileSync(join(APP_SERVER, 'parent-experience-routes.ts'), 'utf8');
    const designRoutes = routesIn(parent, 'router').filter((r) => /invitationDesigns/.test(r.body));
    expect(designRoutes.length).toBeGreaterThan(3);
    for (const r of designRoutes) {
      if (r.path.startsWith('/api/public/')) expect(r.body, r.path).toMatch(/getEventByToken\(/);
      else expect(r.body, r.path).toMatch(/verifyEventAccess\(req, eventId\)/);
    }
    const packages = readFileSync(join(APP_SERVER, 'birthday-package-routes.ts'), 'utf8');
    for (const r of routesIn(packages, 'app').filter((x) => /packageLineItemTemplates/.test(x.body))) {
      if (r.path.includes(':packageId')) expect(r.body, `${r.method} ${r.path}`).toMatch(/hasPackageAccess\(req, packageId\)/);
      else expect(r.body, `${r.method} ${r.path}`).toMatch(/eq\(birthdayPackageTemplates\.tenantId, user\.tenantId!\)/);
    }
  });

  it('as built: POST /api/dropoff-form/:formId/publish takes any park group’s form id, reads and writes its translations and publishes it (finding 3’s arrangement)', () => {
    const dropoff = readFileSync(join(APP_SERVER, 'dropoff-form-routes.ts'), 'utf8');
    const publish = routesIn(dropoff, 'app').find((r) => r.method === 'POST' && r.path === '/api/dropoff-form/:formId/publish');
    expect(publish).toBeDefined();
    expect(publish!.body).toMatch(/getLatestDraftVersion\(formId\)/);
    expect(publish!.body).toMatch(/getI18nTranslations\(/);
    expect(publish!.body).toMatch(/upsertI18nTranslation\(/);
    expect(publish!.body).toMatch(/updateDropoffForm\(formId/);
    expect(publish!.body).not.toMatch(/tenant/i);
    // The four the census names are the same shape.
    for (const [method, path] of [
      ['GET', '/api/dropoff-form/:formId/versions'],
      ['GET', '/api/dropoff-form/version/:versionId'],
      ['PUT', '/api/dropoff-form/:formId/draft'],
      ['PUT', '/api/dropoff-form/translation'],
    ] as const) {
      const r = routesIn(dropoff, 'app').find((x) => x.method === method && x.path === path);
      expect(r, path).toBeDefined();
      expect(r!.body, path).not.toMatch(/tenant/i);
      expect(censusRow('i18n_translations')).toContain(`${method} ${path}`);
    }
  });

  /**
   * FINDING 3 (low). The census row for `i18n_translations` lists four routes
   * that take a form or version id with no park-group check. A fifth does the
   * same and more: `POST /api/dropoff-form/:formId/publish` (admins) reads the
   * draft's English translations of any park group's form, writes the
   * machine translations into it, and publishes that form for its park group.
   * The disposition ("the parent check on those four routes", Q31, round 7)
   * would leave it open.
   *
   * Prescribed fix: add the publish route to the census row and to Q31's
   * round-7 list (the same parent check: the form's `tenant_id` against the
   * caller's park group).
   */
  it.fails('FINDING 3: the census row for i18n_translations names the publish route too', () => {
    expect(censusRow('i18n_translations')).toContain('POST /api/dropoff-form/:formId/publish');
  });

  it('the read-back is read-only and reports a database it cannot reach as 2, never as clean', () => {
    const script = readFileSync(READBACK, 'utf8');
    expect(script).toMatch(/set transaction read only/);
    expect(script).not.toMatch(/\b(insert into|update \w+ set|delete from|alter table|create |drop )/i);
    if (HAS_APP_MODULES) {
      const out = spawnSync(process.execPath, [READBACK], {
        env: { ...process.env, DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none' },
        encoding: 'utf8',
      });
      expect(out.status, out.stdout + out.stderr).toBe(2);
    }
  });
});
