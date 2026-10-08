import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOtoAppMigrations, createTestDatabase } from '@oto/db/testing';
import { newId } from '@oto/shared';

/**
 * S2-17b round 4a (SCRUM-193 under SCRUM-191) — TENANT OWNERSHIP, THE EXPAND
 * HALF, proved (docs/progress/plans/otoapp-lift/PLAN.md section 7 "Round 4
 * (expand)", section 8 round 4's 4a half; hazards H10 to H12, question Q13).
 *
 *  A. H10, the backfill, on a database in the state before it (the app's
 *     0000-0005 applied, rows in it) upgraded by the app's own migrator (the
 *     same committed SQL through the same Drizzle migrator where its
 *     node_modules are absent): two park groups and the default one; activity
 *     rows linked by branch, by employee, by contract, by the user who did them
 *     and by nothing; attention rows the same but for the user; settings. Each
 *     row lands in its park group, none is left null, the counts per park
 *     group are the ones the rows' own links give, the total is unchanged, and
 *     the previous release's writes still work against the new columns.
 *  B. The default park group is made only where a row needs it: never on an
 *     empty database, and as the app's own backfill makes it where a setting
 *     has nowhere else to go.
 *  C. The migration as committed: generated, `"public".` stripped, expand
 *     only, the baseline's settings_key_unique kept beside the new
 *     (tenant_id, key) unique, applied from empty twice.
 *  D. The fences of 4a: Attention still paused, no Attention or no-show job on
 *     the platform, and no migration drops settings_key_unique; every settings
 *     read and save in the app names a park group and goes through its one
 *     helper; the six HR reads take the new caller and never the old shared-key
 *     check; hr:read is a scope the app and its key script know; CI's OTO App
 *     job runs the app-side check and the read-back.
 *  E. The settings rules themselves (server/lib/parkGroupSettings.ts): who
 *     saves in this release, and the order a park group reads candidate rows.
 *  F. Over HTTP, the app's real routes (when its node_modules are present):
 *     apps/oto-app/tests/tenant-ownership.check.ts against a fresh database —
 *     H11 on both constraint shapes and the worded refusals, the settings reads
 *     per park group, the Activity Logbook's isolation, and H12's three
 *     answers.
 */

const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_MODULES =
  existsSync(join(APP_NODE_MODULES, 'pg', 'package.json')) &&
  existsSync(join(APP_NODE_MODULES, 'drizzle-orm', 'package.json'));
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATION = '0006_tenant_ownership_expand';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

const journal = () =>
  JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };

/** A copy of the app's migrations holding only what was live before this round: 0000 to 0005. */
function beforeThisRound(): string {
  const j = journal();
  const live = j.entries.filter((e) => e.idx <= 5);
  expect(live.map((e) => e.tag).at(-1)).toBe('0005_otoapp_v_employees');
  const dir = mkdtempSync(join(tmpdir(), 'otoapp-r4a-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...j, entries: live }));
  for (const e of live) copyFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

/** A fresh platform database whose otoapp schema stands at 0005. */
async function databaseAt0005(): Promise<{ url: string; drop: () => Promise<void>; dir: string }> {
  const { url, drop } = await createTestDatabase();
  const dir = beforeThisRound();
  await withClient(url, async (c) => {
    await c.query('set search_path to otoapp');
    await migrate(drizzle(c), { migrationsFolder: dir, migrationsSchema: 'otoapp' });
  });
  return { url, drop, dir };
}

/** The app's own migrator where it can run here; else the same SQL through the same Drizzle migrator. */
function upgrade(url: string): Promise<string> {
  if (HAS_APP_MODULES) {
    const out = spawnSync(process.execPath, [join(APP_DIR, 'script', 'migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(out.status, out.stderr).toBe(0);
    return Promise.resolve(out.stdout.trim());
  }
  return applyOtoAppMigrations(url).then(() => 'applyOtoAppMigrations');
}

// =============================================================================
// A. H10 — the backfill
// =============================================================================

describe('A. H10: the backfill places every row in its own park group', () => {
  let url = '';
  let drop: () => Promise<void> = async () => undefined;
  let dir = '';
  const D = newId(); // the default park group
  const A = newId();
  const B = newId();
  const ids = {
    branchA: newId(),
    branchB: newId(),
    employeeA: newId(),
    employeeB: newId(),
    contractA: newId(),
    contractB: newId(),
    userA: newId(),
    userB: newId(),
    userBoth: newId(),
    userNone: newId(),
  };
  /** Each fixture row and the park group it must land in. */
  const activity: Record<string, { row: Record<string, string | null>; expected: string }> = {
    byBranchA: { row: { branch_id: ids.branchA }, expected: A },
    byBranchB: { row: { branch_id: ids.branchB }, expected: B },
    byEmployeeA: { row: { employee_id: ids.employeeA }, expected: A },
    byEmployeeB: { row: { employee_id: ids.employeeB }, expected: B },
    byContractA: { row: { contract_instance_id: ids.contractA }, expected: A },
    byContractB: { row: { contract_instance_id: ids.contractB }, expected: B },
    byActorA: { row: { created_by: ids.userA }, expected: A },
    byActorB: { row: { created_by: ids.userB }, expected: B },
    // A user whose branch access names two park groups places nobody.
    byActorInTwo: { row: { created_by: ids.userBoth }, expected: D },
    byActorWithNoAccess: { row: { created_by: ids.userNone }, expected: D },
    byNothing: { row: {}, expected: D },
    // What the row is about wins over who did it, and its branch over its employee.
    branchOverEmployee: { row: { branch_id: ids.branchA, employee_id: ids.employeeB }, expected: A },
    employeeOverActor: { row: { employee_id: ids.employeeB, created_by: ids.userA }, expected: B },
  };
  const attention: Record<string, { row: Record<string, string | null>; expected: string }> = {
    byBranchA: { row: { branch_id: ids.branchA }, expected: A },
    byBranchB: { row: { branch_id: ids.branchB }, expected: B },
    byEmployeeA: { row: { employee_id: ids.employeeA }, expected: A },
    byEmployeeB: { row: { employee_id: ids.employeeB }, expected: B },
    byContractB: { row: { contract_instance_id: ids.contractB }, expected: B },
    // An item is raised by the engine: who resolved it says nothing.
    resolvedByB: { row: { resolved_by: ids.userB }, expected: D },
    byNothing: { row: {}, expected: D },
  };
  const rowIds = new Map<string, string>();
  let runs: string[] = [];
  let beforeCounts = { activity: 0, attention: 0, settings: 0 };
  /** What each park group's branch-linked rows were before: the app showed these by branch. */
  let byBranchBefore = new Map<string, Set<string>>();

  beforeAll(async () => {
    ({ url, drop, dir } = await databaseAt0005());
    await withClient(url, async (c) => {
      await c.query('set search_path to otoapp');
      await c.query(
        `insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default'), ($2, 'Park A', 'park-a'), ($3, 'Park B', 'park-b')`,
        [D, A, B],
      );
      for (const [id, tenant] of [[ids.branchA, A], [ids.branchB, B]] as const) {
        await c.query(`insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'x')`, [id, tenant, `Branch ${id.slice(-4)}`]);
      }
      // Employees with no branch, so only the employee step can place them.
      for (const [id, tenant] of [[ids.employeeA, A], [ids.employeeB, B]] as const) {
        await c.query(
          `insert into employees (id, tenant_id, full_name, nickname, email) values ($1, $2, 'ZZ', 'ZZ', $3)`,
          [id, tenant, `zz-${id}@example.com`],
        );
      }
      for (const id of [ids.userA, ids.userB, ids.userBoth, ids.userNone]) {
        await c.query(`insert into users (id, email, password, full_name, role) values ($1, $2, 'x', 'ZZ', 'admin')`, [
          id,
          `u-${id}@example.com`,
        ]);
      }
      const template = newId();
      await c.query(`insert into templates (id, name, html_body) values ($1, 'ZZ template', '<p>zz</p>')`, [template]);
      for (const [id, employee] of [[ids.contractA, ids.employeeA], [ids.contractB, ids.employeeB]] as const) {
        await c.query(
          `insert into contract_instances (id, employee_id, template_id, template_snapshot_html, template_snapshot_version,
             merge_data_json, created_by)
           values ($1, $2, $3, '<p>zz</p>', 1, '{}'::jsonb, $4)`,
          [id, employee, template, ids.userNone],
        );
      }
      const access = (user: string, tenant: string) =>
        c.query(`insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')`, [
          tenant,
          user,
        ]);
      await access(ids.userA, A);
      await access(ids.userB, B);
      await access(ids.userBoth, A);
      await access(ids.userBoth, B);

      // The previous release's writes: no tenant column exists yet.
      for (const [name, { row }] of Object.entries(activity)) {
        const id = newId();
        rowIds.set(`activity:${name}`, id);
        const cols = ['id', 'activity_type', 'summary_text', ...Object.keys(row)];
        const vals = [id, 'employee_updated', `ZZ ${name}`, ...Object.values(row)];
        await c.query(`insert into activity_log (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
      }
      for (const [name, { row }] of Object.entries(attention)) {
        const id = newId();
        rowIds.set(`attention:${name}`, id);
        const cols = ['id', 'type', 'title', ...Object.keys(row)];
        const vals = [id, 'CONTRACT_NOT_SENT', `ZZ ${name}`, ...Object.values(row)];
        await c.query(`insert into attention_items (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
      }
      await c.query(`insert into settings (key, value) values ('md_signatory_name', 'ZZ MD'), ('probation_days_default', '90')`);

      const count = async (t: string) => Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
      beforeCounts = { activity: await count('activity_log'), attention: await count('attention_items'), settings: await count('settings') };
      const branchRows = await c.query<{ id: string; tenant_id: string }>(
        `select a.id, b.tenant_id from activity_log a join branches b on b.id = a.branch_id`,
      );
      byBranchBefore = new Map();
      for (const r of branchRows.rows) {
        if (!byBranchBefore.has(r.tenant_id)) byBranchBefore.set(r.tenant_id, new Set());
        byBranchBefore.get(r.tenant_id)!.add(r.id);
      }
    });
    runs = [await upgrade(url), await upgrade(url)];
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await drop();
  });

  it('applies 0006 once, then nothing', () => {
    if (HAS_APP_MODULES) {
      expect(runs[0]).toContain(`applied ${MIGRATION}`);
      expect(runs[1]).toMatch(/up to date .* 7 migration/);
    }
  });

  it('every activity row lands in the park group its own links give, none null', async () => {
    const got = await withClient(url, (c) =>
      c.query<{ id: string; tenant_id: string | null }>('select id, tenant_id from otoapp.activity_log'),
    );
    const byId = new Map(got.rows.map((r) => [r.id, r.tenant_id]));
    for (const [name, { expected }] of Object.entries(activity)) {
      expect(byId.get(rowIds.get(`activity:${name}`)!), name).toBe(expected);
    }
    expect(got.rows.filter((r) => r.tenant_id === null)).toEqual([]);
  });

  it('every attention item lands in its park group (branch, employee, contract, else the default), none null', async () => {
    const got = await withClient(url, (c) =>
      c.query<{ id: string; tenant_id: string | null }>('select id, tenant_id from otoapp.attention_items'),
    );
    const byId = new Map(got.rows.map((r) => [r.id, r.tenant_id]));
    for (const [name, { expected }] of Object.entries(attention)) {
      expect(byId.get(rowIds.get(`attention:${name}`)!), name).toBe(expected);
    }
    expect(got.rows.filter((r) => r.tenant_id === null)).toEqual([]);
  });

  it('every setting is the default park group’s: there was one set, and it was the default’s', async () => {
    const got = await withClient(url, (c) => c.query<{ key: string; tenant_id: string }>('select key, tenant_id from otoapp.settings order by key'));
    expect(got.rows).toEqual([
      { key: 'md_signatory_name', tenant_id: D },
      { key: 'probation_days_default', tenant_id: D },
    ]);
  });

  it('the counts per park group are the ones the links give; no row is lost or added; nothing the app showed by branch moves', async () => {
    await withClient(url, async (c) => {
      const per = async (t: string) =>
        new Map(
          (await c.query<{ tenant_id: string; n: number }>(`select tenant_id, count(*)::int as n from otoapp.${t} group by 1`)).rows.map(
            (r) => [r.tenant_id, r.n],
          ),
        );
      const expectedPer = (rows: Record<string, { expected: string }>) => {
        const m = new Map<string, number>();
        for (const { expected } of Object.values(rows)) m.set(expected, (m.get(expected) ?? 0) + 1);
        return m;
      };
      expect(await per('activity_log')).toEqual(expectedPer(activity));
      expect(await per('attention_items')).toEqual(expectedPer(attention));
      const total = async (t: string) => Number((await c.query(`select count(*)::int as n from otoapp.${t}`)).rows[0].n);
      expect({ activity: await total('activity_log'), attention: await total('attention_items'), settings: await total('settings') }).toEqual(
        beforeCounts,
      );
      for (const [tenant, rows] of byBranchBefore) {
        const now = await c.query<{ id: string }>(`select id from otoapp.activity_log where tenant_id = $1`, [tenant]);
        const after = new Set(now.rows.map((r) => r.id));
        for (const id of rows) expect(after.has(id), `${id} stays in ${tenant}`).toBe(true);
      }
    });
  });

  it('no row is given a park group that is not a tenant, and no activity row disagrees with its branch', async () => {
    await withClient(url, async (c) => {
      for (const t of ['activity_log', 'attention_items', 'settings']) {
        const orphans = await c.query(
          `select 1 from otoapp.${t} x where not exists (select 1 from otoapp.tenants y where y.id = x.tenant_id)`,
        );
        expect(orphans.rowCount, t).toBe(0);
      }
      const disagree = await c.query(
        `select 1 from otoapp.activity_log a join otoapp.branches b on b.id = a.branch_id where a.tenant_id <> b.tenant_id`,
      );
      expect(disagree.rowCount).toBe(0);
    });
  });

  it('the default park group is the one that was there: no second one is made', async () => {
    const t = await withClient(url, (c) => c.query(`select id from otoapp.tenants where slug = 'default'`));
    expect(t.rows).toEqual([{ id: D }]);
  });

  it("still takes the previous release's writes: no tenant named, the rows taken, the uniques as they were", async () => {
    await withClient(url, async (c) => {
      await c.query('set search_path to otoapp');
      await c.query(`insert into settings (key, value) values ('zz_old_release', 'x')`);
      await c.query(`update settings set value = 'ZZ MD 2' where key = 'md_signatory_name'`);
      await c.query(`insert into activity_log (activity_type, summary_text, branch_id) values ('employee_updated', 'ZZ old', $1)`, [ids.branchA]);
      await c.query(`insert into attention_items (type, title) values ('CONTRACT_NOT_SENT', 'ZZ old')`);
      // The old unique still refuses a second row for a key, as the old release relies on.
      await expect(c.query(`insert into settings (key, value) values ('md_signatory_name', 'twice')`)).rejects.toThrow(/settings_key_unique/);
    });
  });

  it.skipIf(!HAS_APP_MODULES)('the read-back counts it: a row the previous release wrote after 0006 is the one 4b must place', () => {
    const out = spawnSync(process.execPath, [join(APP_DIR, 'script', 'tenant-ownership-readback.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    // The three writes just above left one settings, one activity and one attention row unplaced.
    expect(out.status, out.stdout + out.stderr).toBe(1);
    expect(out.stdout).toMatch(/settings: \d+ rows?, 1 with no park group/);
    expect(out.stdout).toMatch(/activity_log: \d+ rows?, 1 with no park group/);
    expect(out.stdout).toMatch(/attention_items: \d+ rows?, 1 with no park group/);
    expect(out.stdout).toMatch(/settings uniques: both uniques/);
    expect(out.stdout).toMatch(/The root-table census/);
  });
});

// =============================================================================
// B. The default park group, made only where a row needs it
// =============================================================================

describe('B. the default park group is made only where a row is left for it', () => {
  it('an empty database gets no new tenant', async () => {
    const { url, drop, dir } = await databaseAt0005();
    try {
      await upgrade(url);
      const t = await withClient(url, (c) => c.query(`select count(*)::int as n from otoapp.tenants`));
      expect(t.rows[0].n).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await drop();
    }
  });

  it('a database whose settings have no default park group gets one, as the app’s own backfill makes it', async () => {
    const { url, drop, dir } = await databaseAt0005();
    try {
      await withClient(url, async (c) => {
        await c.query(`insert into otoapp.tenants (id, name, slug) values ($1, 'OTO', 'oto')`, [newId()]);
        await c.query(`insert into otoapp.settings (key, value) values ('email_subject', 'x')`);
      });
      await upgrade(url);
      await withClient(url, async (c) => {
        const d = await c.query<{ id: string; name: string }>(`select id, name from otoapp.tenants where slug = 'default'`);
        expect(d.rows).toHaveLength(1);
        expect(d.rows[0]!.name).toBe('OTO Default');
        const s = await c.query(`select tenant_id from otoapp.settings`);
        expect(s.rows).toEqual([{ tenant_id: d.rows[0]!.id }]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await drop();
    }
  });
});

// =============================================================================
// C. The migration as committed
// =============================================================================

describe('C. the migration as committed: expand only, both uniques, from empty twice', () => {
  const sqlText = readFileSync(join(APP_MIGRATIONS, `${MIGRATION}.sql`), 'utf8');
  const statements = sqlText.replace(/--.*$/gm, '');

  it('is journalled as 0006, with its snapshot, after 0005', () => {
    const entries = journal().entries;
    expect(entries.map((e) => e.tag)).toContain(MIGRATION);
    const e = entries.find((x) => x.tag === MIGRATION)!;
    expect(e.idx).toBe(6);
    expect(e.when).toBeGreaterThan(entries.find((x) => x.idx === 5)!.when);
    expect(existsSync(join(APP_MIGRATIONS, 'meta', '0006_snapshot.json'))).toBe(true);
  });

  it('has "public". stripped, as the migrator demands', () => {
    expect(sqlText.includes('"public".')).toBe(false);
  });

  it('is expand only: nothing dropped, renamed, retyped or made NOT NULL', () => {
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/ALTER\s+COLUMN/i);
    expect(statements).not.toMatch(/SET\s+NOT\s+NULL/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    for (const t of ['activity_log', 'attention_items', 'settings']) {
      expect(statements).toMatch(new RegExp(`ALTER TABLE "${t}" ADD COLUMN "tenant_id" uuid;`));
    }
  });

  it('adds the (tenant_id, key) unique and an index on each new column', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX "settings_tenant_id_key_unique" ON "settings" USING btree \("tenant_id","key"\)/);
    expect(statements).toMatch(/CREATE INDEX "idx_activity_log_tenant" ON "activity_log"/);
    expect(statements).toMatch(/CREATE INDEX "idx_attention_items_tenant" ON "attention_items"/);
  });

  it('no app migration drops settings_key_unique: that is round 4b, a release later', () => {
    for (const f of readdirSync(APP_MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
      const text = readFileSync(join(APP_MIGRATIONS, f), 'utf8').replace(/--.*$/gm, '');
      expect(text, f).not.toMatch(/DROP\s+CONSTRAINT\s+"?settings_key_unique/i);
      expect(text, f).not.toMatch(/DROP\s+INDEX[^;]*settings_key_unique/i);
    }
    const snapshot = readFileSync(join(APP_MIGRATIONS, 'meta', '0006_snapshot.json'), 'utf8');
    expect(snapshot).toContain('"settings_key_unique"');
    expect(snapshot).toContain('"settings_tenant_id_key_unique"');
  });

  it('applies from empty, and a second run applies nothing and fails on nothing', async () => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      await applyOtoAppMigrations(url);
      await withClient(url, async (c) => {
        const ledger = await c.query<{ n: number }>('select count(*)::int as n from otoapp.__drizzle_migrations');
        expect(ledger.rows[0]!.n).toBe(journal().entries.length);
        const cols = await c.query<{ table_name: string; is_nullable: string }>(
          `select table_name, is_nullable from information_schema.columns
            where table_schema = 'otoapp' and column_name = 'tenant_id'
              and table_name in ('settings', 'activity_log', 'attention_items') order by 1`,
        );
        expect(cols.rows).toEqual([
          { table_name: 'activity_log', is_nullable: 'YES' },
          { table_name: 'attention_items', is_nullable: 'YES' },
          { table_name: 'settings', is_nullable: 'YES' },
        ]);
        const uniques = await c.query<{ indexname: string }>(
          `select indexname from pg_indexes where schemaname = 'otoapp' and tablename = 'settings' and indexdef like 'CREATE UNIQUE%' order by 1`,
        );
        expect(uniques.rows.map((r) => r.indexname)).toEqual(['settings_key_unique', 'settings_pkey', 'settings_tenant_id_key_unique']);
        const tenants = await c.query<{ n: number }>('select count(*)::int as n from otoapp.tenants');
        expect(tenants.rows[0]!.n).toBe(0);
      });
    } finally {
      await drop();
    }
  });
});

// =============================================================================
// D. The fences of 4a, read off the code
// =============================================================================

const APP_SERVER = join(APP_DIR, 'server');

function appSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return appSources(path);
    return /\.(ts|mjs)$/.test(e.name) ? [path] : [];
  });
}

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('D. the fences of 4a', () => {
  const files = appSources(APP_SERVER).map((path) => ({
    rel: path.slice(APP_DIR.length).split('\\').join('/'),
    text: code(readFileSync(path, 'utf8')),
  }));

  it('Attention stays paused: ATTENTION_WRITES_READY is false, and the platform registers no Attention or no-show job', () => {
    const flag = readFileSync(join(APP_SERVER, 'attention-availability.ts'), 'utf8');
    expect(flag).toMatch(/export const ATTENTION_WRITES_READY = false;/);
    const platform = appSources(join(REPO, 'apps', 'api', 'src')).map((p) => readFileSync(p, 'utf8')).join('\n');
    expect(platform).not.toMatch(/otoapp\.attention|otoapp\.no_show/);
  });

  it('every settings read names a park group: no one-argument getSetting, no bare getSettings', () => {
    const offenders = files.flatMap(({ rel, text }) => [
      ...[...text.matchAll(/\bgetSetting\(\s*("[^"]*"|'[^']*'|`[^`]*`|[A-Za-z_.]+)\s*\)/g)].map((m) => `${rel}: ${m[0]}`),
      ...[...text.matchAll(/\bgetSettings\(\s*\)/g)].map((m) => `${rel}: ${m[0]}`),
    ]);
    expect(offenders).toEqual([]);
  });

  it('every settings save names a park group: upsertSetting always takes two arguments', () => {
    const offenders = files.flatMap(({ rel, text }) =>
      [...text.matchAll(/\bupsertSetting\(\s*\{[^}]*\}\s*\)/g)].map((m) => `${rel}: ${m[0].slice(0, 60)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('only the storage helper touches the settings table (and the dev-only production copy, by park group)', () => {
    const outside = files
      .filter(({ text }) => /\b(from|insert|update|delete)\(\s*settings\s*\)|db\.query\.settings\b/.test(text))
      .map(({ rel }) => rel);
    expect(outside).toEqual(['server/storage.ts']);
    const raw = files.filter(({ text }) => /\b(FROM|INTO|UPDATE)\s+settings\b/.test(text)).map(({ rel }) => rel);
    expect(raw).toEqual(['server/prod-sync.ts']);
    expect(files.find((f) => f.rel === 'server/prod-sync.ts')!.text).toMatch(/tenant_id/);
  });

  it('the six HR reads take the park-group caller, and the shared-key check that answered 500 is gone', () => {
    const routes = files.find((f) => f.rel === 'server/routes.ts')!.text;
    const hrRoutes = [...routes.matchAll(/app\.get\("(\/api\/directory\/[^"]+)",\s*([A-Za-z]+)/g)].map((m) => [m[1], m[2]]);
    expect(hrRoutes).toEqual([
      ['/api/directory/employee/:id', 'requireHrDirectory'],
      ['/api/directory/employees/search', 'requireHrDirectory'],
      ['/api/directory/branches/:branchId/employees', 'requireHrDirectory'],
      ['/api/directory/roles', 'requireHrDirectory'],
      ['/api/directory/departments', 'requireHrDirectory'],
      ['/api/directory/branches', 'requireHrDirectory'],
    ]);
    expect(files.some(({ text }) => /requireDirectoryApiKey/.test(text))).toBe(false);
  });

  it('hr:read is a scope the app and its key script know', () => {
    expect(readFileSync(join(APP_SERVER, 'db', 'coreSchema.ts'), 'utf8')).toMatch(
      /DIRECTORY_CLIENT_SCOPES = \["events:write", "jobs:run", "hr:read"\]/,
    );
    expect(readFileSync(join(APP_DIR, 'script', 'directory-client.mjs'), 'utf8')).toMatch(
      /const SCOPES = \["events:write", "jobs:run", "hr:read"\];/,
    );
  });

  it("CI's OTO App job runs the app-side check and, last, the read-back; the settings rules count as the seam", () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('\n  oto-app:'));
    expect(job).toMatch(/npx tsx tests\/tenant-ownership\.check\.ts/);
    expect(job).toMatch(/npm run tenant:readback/);
    expect(job.indexOf('tenant:readback')).toBeGreaterThan(job.indexOf('tests/night-jobs.check.ts'));
    expect(job.indexOf('tenant:readback')).toBeGreaterThan(job.indexOf('tests/tenant-ownership.check.ts'));
    const seams = [...ci.matchAll(/APP_SEAM='([^']+)'/g)].map((m) => m[1]!);
    expect(seams.length).toBe(3);
    for (const seam of seams) expect(new RegExp(seam).test('apps/oto-app/server/lib/parkGroupSettings.ts')).toBe(true);
  });
});

// =============================================================================
// E. The settings rules
// =============================================================================

interface SettingsRules {
  settingsWritableBy(owner: string | null, defaultParkGroup: string | null): boolean;
  settingsReadRank(rowTenant: string | null, reader: string | null, defaultParkGroup: string | null): number | null;
  SETTINGS_SHARED_REFUSAL: { reason: string; message: string };
  SETTINGS_KEY_HELD_REFUSAL: { reason: string; message: string };
  SETTINGS_NO_PARK_GROUP_REFUSAL: { reason: string; message: string };
}

describe('E. the settings rules (server/lib/parkGroupSettings.ts)', () => {
  let rules: SettingsRules;
  const D = newId();
  const B = newId();
  beforeAll(async () => {
    rules = (await import(/* @vite-ignore */ pathToFileURL(join(APP_SERVER, 'lib', 'parkGroupSettings.ts')).href)) as SettingsRules;
  });

  it('only the default park group saves in this release; a database with none keeps its one old set', () => {
    expect(rules.settingsWritableBy(D, D)).toBe(true);
    expect(rules.settingsWritableBy(B, D)).toBe(false);
    expect(rules.settingsWritableBy(null, null)).toBe(true);
    expect(rules.settingsWritableBy(B, null)).toBe(false);
  });

  it('a park group reads its own row, then the default’s, then a row with none; never another’s', () => {
    expect(rules.settingsReadRank(B, B, D)).toBe(0);
    expect(rules.settingsReadRank(D, B, D)).toBe(1);
    expect(rules.settingsReadRank(null, B, D)).toBe(2);
    expect(rules.settingsReadRank(newId(), B, D)).toBeNull();
    // The default park group reading: its own first, then a hand-over row.
    expect(rules.settingsReadRank(D, D, D)).toBe(0);
    expect(rules.settingsReadRank(null, D, D)).toBe(2);
    expect(rules.settingsReadRank(B, D, D)).toBeNull();
  });

  it('each refusal is words a person can act on, with a reason a program can read', () => {
    for (const r of [rules.SETTINGS_SHARED_REFUSAL, rules.SETTINGS_KEY_HELD_REFUSAL, rules.SETTINGS_NO_PARK_GROUP_REFUSAL]) {
      expect(r.reason).toMatch(/^settings_/);
      expect(r.message.length).toBeGreaterThan(40);
    }
    expect(rules.SETTINGS_SHARED_REFUSAL.message).toMatch(/default park group/);
    expect(rules.SETTINGS_SHARED_REFUSAL.message).toMatch(/next release/);
  });
});

// =============================================================================
// F. Over HTTP, the app's real routes
// =============================================================================

describe.skipIf(!HAS_APP_RUNTIME)('F. H11, the reads, the Activity Logbook and H12 over HTTP: the app’s routes, booted twice', () => {
  it('apps/oto-app/tests/tenant-ownership.check.ts passes against a fresh database', async () => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      const result = spawnSync(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/tenant-ownership.check.ts'], {
        cwd: APP_DIR,
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 280_000,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      expect(output).toMatch(/tenant-ownership\.check: \d+ checks passed/);
      // And every row it wrote through the routes carries its park group.
      const readback = spawnSync(process.execPath, [join(APP_DIR, 'script', 'tenant-ownership-readback.mjs')], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
      });
      expect(readback.status, readback.stdout + readback.stderr).toBe(0);
    } finally {
      await drop();
    }
  }, 300_000);
});
