import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOtoAppMigrations, createTestDatabase } from '@oto/db/testing';

/**
 * S2-17b round 6 (SCRUM-193 under SCRUM-191) — THE DOCUMENT MODULES, AS THE
 * APP DOES THEM, proved (docs/progress/plans/otoapp-lift/PLAN.md section 8
 * round 6; section 7's round-6 migration; hazard H16; ticket check 2;
 * questions Q31, Q40 and Q47 to Q53).
 *
 *  A. Migration 0008 as committed: journalled after 0007, `"public".`
 *     stripped, EXPAND ONLY (four nullable tenant columns, their keys and
 *     indexes; nothing dropped, renamed, retyped or made NOT NULL), 0006's
 *     placement statements reused as they are, and the offboarding census
 *     deciding its unique index under a write lock.
 *  B. From empty, twice: the four columns nullable, the indexes there, the
 *     offboarding index made (nobody has two), no park group made, and a
 *     second run applies nothing.
 *  C. Onto a 0007 database with document rows in it — the backfill proven
 *     (H10's discipline): every placement path of each table, a split of each
 *     kind going on to the next step, the default park group last; totals
 *     unchanged; no park group made beside the default; the read-back clean
 *     and naming the crossings existing rows already held. Then the census
 *     both ways (a person with two offboardings: no index, the words, the
 *     census naming them; settled: nothing in its way), a one-park-group
 *     database, and several park groups none of them the default.
 *  D. Read off the code: the lift's 503 guard gone; each module's read rule
 *     (server/lib/documentParkGroups.ts); every document read taking the park
 *     group; the offboarding create and update each one transaction with every
 *     write on it (H16); the PDF gate's doors each checking the owner before
 *     a five-minute signed URL; the readable reason shared, display only.
 *     And round 6's review fixes (findings 1 to 4): the census of the 45
 *     `/api/employees/:id*` doors (server/lib/employeeParkGroups.ts) matching
 *     the routes, each looking the employee up in a park group before it
 *     writes; the edit's ids weighed; the wizard's six fields; the
 *     offboarding's login backstop; the branch-wide leave read; the
 *     leave-policy candidate set. And the re-review's fixes (findings 6 to
 *     8): the census at all 54 `/api/employees*` routes, the nine without an
 *     id each held by its rule; every `storage.getEmployee(` call site the
 *     re-review counted (32) with its disposition, the fenced ones no longer
 *     looking up by id alone; every `employee_roles` writer, the role-holder
 *     write and read held to the park group; the create's body weighed as the
 *     edit's.
 *  E. CI, the image and the plan.
 *  F. The real app (when its node_modules and a Chromium are present):
 *     apps/oto-app/tests/documents.check.ts over HTTP against a fresh
 *     database — every module's park-group isolation, H16's injected failures,
 *     the PDF gate's allow and refuse against a private stand-in bucket, the
 *     org chart counted first, FINDINGs Q50 and Q52 — then the read-back and
 *     the census clean.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_SERVER = join(APP_DIR, 'server');
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_MODULES = ['pg', 'drizzle-orm'].every((m) => existsSync(join(APP_NODE_MODULES, m, 'package.json')));
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm', 'puppeteer'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);
const CHROMIUM = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p): p is string => !!p && existsSync(p));
const READBACK = join(APP_DIR, 'script', 'tenant-ownership-readback.mjs');
const CENSUS = join(APP_DIR, 'script', 'offboarding-census.mjs');
const MIGRATION = '0008_document_tenant_ownership_expand';
const DOCUMENT_TABLES = ['asset_catalog', 'leave_policies', 'policy_documents', 'templates'] as const;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** A file as committed (LF), whatever the checkout did to its line ends. */
const committed = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
/** Comments out, so a sentence in a comment never stands in for code. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const routesText = () => code(readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8'));
const storageText = () => code(readFileSync(join(APP_SERVER, 'storage.ts'), 'utf8'));

/** One route's handler, from its registration to the next registration. */
function route(text: string, method: string, path: string): string {
  const start = text.indexOf(`app.${method}("${path}"`);
  expect(start, `${method.toUpperCase()} ${path} is registered`).toBeGreaterThan(-1);
  const next = text.indexOf('\n  app.', start + 10);
  return text.slice(start, next === -1 ? undefined : next);
}

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}
const journal = (): Journal => JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;

/** One migration file's statements, comments and blank lines out, whitespace collapsed. */
function statementsOf(tag: string): string[] {
  return committed(join(APP_MIGRATIONS, `${tag}.sql`))
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** A copy of the app's migrations up to and including `idx`. */
function migrationsUpTo(idx: number): string {
  const j = journal();
  const live = j.entries.filter((e) => e.idx <= idx);
  const dir = mkdtempSync(join(tmpdir(), 'otoapp-r6-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...j, entries: live }));
  for (const e of live) copyFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: 'zz-r6' });
  await c.connect();
  try {
    await c.query('set search_path to otoapp');
    return await work(c);
  } finally {
    await c.end();
  }
}

/** A fresh platform database whose otoapp schema stands at `idx`. */
async function databaseAt(idx: number): Promise<{ url: string; drop: () => Promise<void> }> {
  const { url, drop } = await createTestDatabase();
  const dir = migrationsUpTo(idx);
  try {
    await withClient(url, (c) => migrate(drizzle(c), { migrationsFolder: dir, migrationsSchema: 'otoapp' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { url, drop };
}

/** The deploy's migrator: the app's own where it can run here (its words), else the same SQL in-process. */
async function deploy(url: string): Promise<{ status: number; output: string }> {
  if (HAS_APP_MODULES) {
    const out = spawnSync(process.execPath, [join(APP_DIR, 'script', 'migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    return { status: out.status ?? 1, output: `${out.stdout ?? ''}\n${out.stderr ?? ''}` };
  }
  await applyOtoAppMigrations(url);
  return { status: 0, output: 'applyOtoAppMigrations' };
}

function script(path: string, url: string): { status: number; output: string } {
  const out = spawnSync(process.execPath, [path], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  return { status: out.status ?? 2, output: `${out.stdout ?? ''}\n${out.stderr ?? ''}` };
}

const insertRow = (c: pg.Client, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return c.query(
    `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
};

const plan = () => readFileSync(join(REPO, 'docs', 'progress', 'plans', 'otoapp-lift', 'PLAN.md'), 'utf8');
const question = (n: number) => {
  const text = plan();
  const start = text.indexOf(`- **Q${n}.`);
  expect(start, `Q${n} is in the plan`).toBeGreaterThan(-1);
  const end = text.indexOf('\n- **Q', start + 5);
  return text.slice(start, end === -1 ? text.indexOf('\n## ', start) : end);
};

// =============================================================================
// A. Migration 0008 as committed
// =============================================================================

describe('A. migration 0008 as committed', () => {
  it('is journalled as 0008 after 0007, with its snapshot, "public." stripped, and 0006 and 0007 untouched', () => {
    const entries = journal().entries;
    const e = entries.find((x) => x.tag === MIGRATION);
    expect(e?.idx).toBe(8);
    expect(e!.when).toBeGreaterThan(entries.find((x) => x.idx === 7)!.when);
    expect(entries.at(-1)!.tag).toBe(MIGRATION);
    expect(existsSync(join(APP_MIGRATIONS, 'meta', '0008_snapshot.json'))).toBe(true);
    expect(committed(join(APP_MIGRATIONS, `${MIGRATION}.sql`)).includes('"public".')).toBe(false);
    expect(sha256(committed(join(APP_MIGRATIONS, '0006_tenant_ownership_expand.sql')))).toBe('e2f9c20269d7a508c636e8bc2b84e11ac5f82418df98890fc70b894e5d1e1225');
    expect(sha256(committed(join(APP_MIGRATIONS, '0007_tenant_ownership_contract.sql')))).toBe('7c0408d7329f4d19ff26914f0eeaa0d8e855dc20f98f7eba6412279ba40b1a18');
  });

  it('is expand only: four nullable columns with their keys and indexes, nothing dropped, renamed, retyped or made NOT NULL', () => {
    const text = committed(join(APP_MIGRATIONS, `${MIGRATION}.sql`)).replace(/--.*$/gm, '');
    expect(text).not.toMatch(/\bDROP\b|\bRENAME\b|SET NOT NULL|ALTER COLUMN|\bTYPE\b|TRUNCATE|(?<!ON )\bDELETE\b|GRANT|REVOKE/i);
    const altered = [...new Set([...text.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]))].sort();
    expect(altered).toEqual([...DOCUMENT_TABLES]);
    for (const t of DOCUMENT_TABLES) {
      expect(text).toContain(`ALTER TABLE "${t}" ADD COLUMN "tenant_id" uuid;`);
      expect(text).toContain(`ALTER TABLE "${t}" ADD CONSTRAINT "${t}_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")`);
      expect(text).toContain(`CREATE INDEX "idx_${t}_tenant" ON "${t}" USING btree ("tenant_id");`);
    }
    const updated = [...new Set([...text.matchAll(/UPDATE "([a-z_]+)"/g)].map((m) => m[1]))].sort();
    expect(updated).toEqual([...DOCUMENT_TABLES]);
    expect([...text.matchAll(/INSERT INTO "([a-z_]+)"/g)].map((m) => m[1])).toEqual(['tenants']);
  });

  it('places by 0006’s own statements: the strict actor step and the default park group are 0006’s, word for word but the table', () => {
    const expand = statementsOf('0006_tenant_ownership_expand');
    const strict = (s: string) => s.slice(s.indexOf('FROM ( SELECT x."user_id"'));
    const actor0006 = strict(expand.find((s) => s.startsWith('UPDATE "activity_log" AS a SET "tenant_id" = u."tenant_id"'))!);
    const mine = statementsOf(MIGRATION);
    const actorSteps = mine.filter((s) => s.includes('FROM ( SELECT x."user_id"'));
    expect(actorSteps.map((s) => s.slice(0, s.indexOf(' SET '))).sort()).toEqual(['UPDATE "policy_documents" AS p', 'UPDATE "templates" AS t']);
    for (const s of actorSteps) {
      const alias = /^UPDATE "[a-z_]+" AS (\w+) /.exec(s)![1]!;
      expect(strict(s)).toBe(actor0006.replaceAll('a."tenant_id"', `${alias}."tenant_id"`).replaceAll('a."created_by"', `${alias}."created_by"`));
    }
    const fallback = (table: string) =>
      `UPDATE "${table}" SET "tenant_id" = coalesce( (SELECT "id" FROM "tenants" WHERE "slug" = 'default'), (SELECT min("id"::text)::uuid FROM "tenants" HAVING count(*) = 1)) WHERE "tenant_id" IS NULL;`;
    expect(expand).toContain(fallback('settings'));
    for (const t of DOCUMENT_TABLES) expect(mine).toContain(fallback(t));
    const made = mine.find((s) => s.startsWith('INSERT INTO "tenants"'))!;
    expect(made).toMatch(/^INSERT INTO "tenants" \("name", "slug"\) SELECT 'OTO Default', 'default' WHERE NOT EXISTS \(SELECT 1 FROM "tenants" WHERE "slug" = 'default'\) AND \(SELECT count\(\*\) FROM "tenants"\) <> 1 AND/);
    for (const t of DOCUMENT_TABLES) expect(made).toContain(`EXISTS (SELECT 1 FROM "${t}" WHERE "tenant_id" IS NULL)`);
    // Every step places only rows still null, and every multi-row step only where its links name one park group.
    for (const s of mine.filter((x) => x.startsWith('UPDATE'))) expect(s, s.slice(0, 60)).toMatch(/"tenant_id" IS NULL/);
    const multiRow = mine.filter((s) => s.startsWith('UPDATE') && /GROUP BY/.test(s) && !s.includes('x."user_id"'));
    expect(multiRow).toHaveLength(5);
    for (const s of multiRow) expect(s, s.slice(0, 60)).toContain('HAVING count(DISTINCT');
  });

  it('the census decides the offboarding index under a write lock, and never stops the deploy', () => {
    const mine = statementsOf(MIGRATION);
    const lock = mine.indexOf('LOCK TABLE "employee_offboarding" IN SHARE ROW EXCLUSIVE MODE;');
    expect(lock).toBeGreaterThan(-1);
    const census = mine[lock + 1]!;
    expect(lock + 1).toBe(mine.length - 1);
    expect(census).toMatch(/^DO \$\$/);
    expect(census).toMatch(/FROM "employee_offboarding" GROUP BY "employee_id" HAVING count\(\*\) > 1/);
    expect(census).toMatch(/IF employees_with_two = 0 THEN CREATE UNIQUE INDEX "employee_offboarding_employee_unique" ON "employee_offboarding" USING btree \("employee_id"\); ELSE RAISE NOTICE 'offboarding census \(0008\): % employees have more than one offboarding/);
    expect(census).not.toMatch(/RAISE EXCEPTION/);
    expect(census).toMatch(/npm run offboarding:census/);
  });

  it('the snapshot is the schema the code declares: the four tenant_id nullable with their indexes; the census index is the SQL’s alone', () => {
    const snapshot = JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '0008_snapshot.json'), 'utf8')) as {
      tables: Record<string, { columns: Record<string, { notNull: boolean }>; indexes: Record<string, unknown> }>;
    };
    for (const t of DOCUMENT_TABLES) {
      const table = snapshot.tables[`public.${t}`]!;
      expect(table.columns.tenant_id, t).toMatchObject({ notNull: false });
      expect(Object.keys(table.indexes), t).toContain(`idx_${t}_tenant`);
    }
    expect(Object.keys(snapshot.tables['public.employee_offboarding']!.indexes)).not.toContain('employee_offboarding_employee_unique');
    const schema = readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8');
    expect(schema).toMatch(/employee_offboarding_employee_unique/);
  });
});

// =============================================================================
// B. From empty, twice
// =============================================================================

describe('B. from empty, twice', () => {
  it('applies from empty and a second run applies nothing: the columns nullable, the indexes there, the census index made, no park group made', async () => {
    const { url, drop } = await createTestDatabase();
    try {
      const first = await deploy(url);
      expect(first.status, first.output).toBe(0);
      if (HAS_APP_MODULES) expect(first.output).toMatch(new RegExp(`applied ${MIGRATION}`));
      const second = await deploy(url);
      expect(second.status, second.output).toBe(0);
      if (HAS_APP_MODULES) expect(second.output).toMatch(/is up to date/);
      await withClient(url, async (c) => {
        expect(Number((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n)).toBe(journal().entries.length);
        const cols = await c.query<{ table_name: string; is_nullable: string }>(
          `select table_name, is_nullable from information_schema.columns
            where table_schema = 'otoapp' and column_name = 'tenant_id' and table_name = any($1) order by 1`,
          [DOCUMENT_TABLES],
        );
        expect(cols.rows.map((r) => `${r.table_name} ${r.is_nullable}`)).toEqual(DOCUMENT_TABLES.map((t) => `${t} YES`));
        const indexes = (await c.query<{ indexname: string }>(
          `select indexname from pg_indexes where schemaname = 'otoapp' and (indexname like 'idx\\_%\\_tenant' or indexname = 'employee_offboarding_employee_unique') order by 1`,
        )).rows.map((r) => r.indexname);
        for (const t of DOCUMENT_TABLES) expect(indexes).toContain(`idx_${t}_tenant`);
        expect(indexes).toContain('employee_offboarding_employee_unique');
        expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(0);
      });
    } finally {
      await drop();
    }
  }, 180_000);
});

// =============================================================================
// C. Onto a 0007 database with document rows in it
// =============================================================================

describe('C. onto a 0007 database with document rows: the backfill proven', () => {
  let url = '';
  let drop: () => Promise<void> = async () => undefined;
  const ids: Record<string, string> = {};
  const id = (name: string) => (ids[name] ??= randomUUID());
  let totals: Record<string, number> = {};
  let upgraded: { status: number; output: string } = { status: -1, output: '' };

  beforeAll(async () => {
    ({ url, drop } = await databaseAt(7));
    await withClient(url, async (c) => {
      // Three park groups: the default (slug `default`), A and B.
      for (const [name, slug] of [['D', 'default'], ['A', 'zz-a'], ['B', 'zz-b']] as const) {
        await insertRow(c, 'tenants', { id: id(name), name: `ZZ ${name}`, slug });
      }
      for (const [b, t] of [['bA', 'A'], ['bA2', 'A'], ['bB', 'B']] as const) {
        await insertRow(c, 'branches', { id: id(b), tenant_id: id(t), name: `ZZ ${b}`, address: 'ZZ' });
      }
      // Users: one the strict placement puts in B; one it cannot place (rows in A and B).
      for (const u of ['uB', 'uSplit', 'uNone']) {
        await insertRow(c, 'users', { id: id(u), email: `${u}-${id(u)}@example.com`, password: 'x', full_name: 'ZZ', role: 'admin' });
      }
      await insertRow(c, 'user_branch_access', { tenant_id: id('B'), user_id: id('uB'), branch_id: null, access_scope: 'all_branches' });
      await insertRow(c, 'user_branch_access', { tenant_id: id('A'), user_id: id('uSplit'), branch_id: id('bA'), access_scope: 'selected_branches' });
      await insertRow(c, 'user_branch_access', { tenant_id: id('B'), user_id: id('uSplit'), branch_id: id('bB'), access_scope: 'selected_branches' });
      for (const [e, t, b] of [['eA', 'A', 'bA'], ['eB', 'B', 'bB'], ['eB2', 'B', null]] as const) {
        await insertRow(c, 'employees', { id: id(e), tenant_id: id(t), branch_id: b ? id(b) : null, full_name: 'ZZ', nickname: 'ZZ', email: `${e}-${id(e)}@example.com` });
      }
      const contract = (template: string, employee: string, policy: string | null = null) =>
        insertRow(c, 'contract_instances', {
          employee_id: id(employee), template_id: id(template), template_snapshot_html: '<p>zz</p>', template_snapshot_version: 1,
          merge_data_json: '{}', created_by: id('uNone'), policy_document_id: policy ? id(policy) : null,
        });
      const letter = (template: string, employee: string) =>
        insertRow(c, 'employee_letters', { employee_id: id(employee), template_id: id(template), letter_type: 'warning', created_by: id('uNone') });

      // templates — each name says where it must land and by which step.
      const template = (name: string, createdBy: string | null) =>
        insertRow(c, 'templates', { id: id(name), name: `ZZ ${name}`, html_body: '<p>zz</p>', created_by: createdBy ? id(createdBy) : null });
      await template('tByBranch_A', 'uB'); // its assignment's branch wins over its maker
      await insertRow(c, 'template_assignments', { template_id: id('tByBranch_A'), branch_id: id('bA') });
      await insertRow(c, 'template_assignments', { template_id: id('tByBranch_A'), branch_id: id('bA2') });
      await template('tSplitBranchByContract_B', null); // assignments in A and B; its contract's employee in B
      await insertRow(c, 'template_assignments', { template_id: id('tSplitBranchByContract_B'), branch_id: id('bA') });
      await insertRow(c, 'template_assignments', { template_id: id('tSplitBranchByContract_B'), branch_id: id('bB') });
      await contract('tSplitBranchByContract_B', 'eB');
      await template('tByLetter_B', null); // no assignment; only a letter, for B's employee
      await letter('tByLetter_B', 'eB2');
      await template('tSplitEmployeesByMaker_B', 'uB'); // a contract in A and a letter in B: split; its maker is B's
      await contract('tSplitEmployeesByMaker_B', 'eA');
      await letter('tSplitEmployeesByMaker_B', 'eB');
      await template('tUnplaceableMaker_D', 'uSplit'); // a maker the strict rule cannot place
      await template('tNothing_D', null);

      // policy_documents
      const policy = (name: string, branch: string | null, createdBy: string | null) =>
        insertRow(c, 'policy_documents', { id: id(name), title: `ZZ ${name}`, branch_id: branch ? id(branch) : null, is_company_wide: !branch, created_by: createdBy ? id(createdBy) : null });
      await policy('pByBranch_A', 'bA', 'uB'); // its branch wins over its maker
      await policy('pByContracts_B', null, null);
      await contract('tByBranch_A', 'eB', 'pByContracts_B');
      await contract('tByBranch_A', 'eB2', 'pByContracts_B');
      await policy('pSplitContractsByMaker_B', null, 'uB');
      await contract('tByBranch_A', 'eA', 'pSplitContractsByMaker_B');
      await contract('tByBranch_A', 'eB', 'pSplitContractsByMaker_B');
      await policy('pNothing_D', null, 'uSplit');

      // asset_catalog
      const item = (name: string) => insertRow(c, 'asset_catalog', { id: id(name), name: `ZZ ${name}` });
      const asset = (catalog: string, employee: string, branch: string | null) =>
        insertRow(c, 'employee_assets', { employee_id: id(employee), branch_id: branch ? id(branch) : null, asset_name_snapshot: 'ZZ', catalog_asset_id: id(catalog), assigned_by: id('uNone') });
      await item('iByBranch_A');
      await asset('iByBranch_A', 'eA', 'bA');
      await item('iByEmployee_B'); // assigned with no branch recorded
      await asset('iByEmployee_B', 'eB2', null);
      await item('iSplit_D'); // assigned in A and in B
      await asset('iSplit_D', 'eA', 'bA');
      await asset('iSplit_D', 'eB', 'bB');
      await item('iNever_D');

      // leave_policies
      await insertRow(c, 'leave_policies', { id: id('lByBranch_B'), branch_id: id('bB'), name: 'ZZ lByBranch_B' });
      await insertRow(c, 'leave_policies', { id: id('lCompanyWide_D'), branch_id: null, name: 'ZZ lCompanyWide_D' });

      // One offboarding each: the census is clean.
      for (const e of ['eA', 'eB']) {
        await insertRow(c, 'employee_offboarding', { employee_id: id(e), offboarding_type: 'RESIGNATION', reason_code: 'other', last_working_day: '2026-01-01', created_by: id('uNone') });
      }
      totals = {};
      for (const t of DOCUMENT_TABLES) totals[t] = Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
    });
    upgraded = await deploy(url);
  }, 240_000);

  it('the deploy applies 0008 alone', () => {
    expect(upgraded.status, upgraded.output).toBe(0);
    if (HAS_APP_MODULES) {
      expect(upgraded.output).toMatch(new RegExp(`applied ${MIGRATION}`));
      expect(upgraded.output).not.toMatch(/applied 0007/);
      expect(upgraded.output).not.toMatch(/offboarding census \(0008\)/);
    }
  });

  it('every row lands where its own links put it — branch, employee, contract, maker, then the default — a split going on to the next step', async () => {
    const expected = (name: string) => id(name.slice(name.lastIndexOf('_') + 1));
    const wrong: string[] = [];
    await withClient(url, async (c) => {
      for (const t of DOCUMENT_TABLES) {
        for (const row of (await c.query<{ id: string; tenant_id: string | null }>(`select id, tenant_id from ${t}`)).rows) {
          const name = Object.keys(ids).find((k) => ids[k] === row.id);
          if (!name) continue;
          if (row.tenant_id !== expected(name)) wrong.push(`${t}:${name} -> ${row.tenant_id}`);
        }
      }
    });
    expect(wrong).toEqual([]);
  });

  it('none null, the totals unchanged, and no park group made beside the default', async () => {
    await withClient(url, async (c) => {
      for (const t of DOCUMENT_TABLES) {
        expect(Number((await c.query(`select count(*)::int as n from ${t} where tenant_id is null`)).rows[0].n), t).toBe(0);
        expect(Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n), t).toBe(totals[t]);
      }
      expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(3);
    });
  });

  it('the census was clean, so the backstop stands: a second offboarding for one person is refused', async () => {
    await withClient(url, async (c) => {
      await expect(
        insertRow(c, 'employee_offboarding', { employee_id: id('eA'), offboarding_type: 'RESIGNATION', reason_code: 'other', last_working_day: '2026-02-01', created_by: id('uNone') }),
      ).rejects.toThrow(/employee_offboarding_employee_unique/);
    });
  });

  it('the previous release’s writes still work against the new columns (no tenant named: taken, left for round 7)', async () => {
    await withClient(url, async (c) => {
      await insertRow(c, 'templates', { name: 'ZZ old release', html_body: '<p>zz</p>' });
      await insertRow(c, 'asset_catalog', { name: 'ZZ old release' });
      await insertRow(c, 'policy_documents', { title: 'ZZ old release' });
      await insertRow(c, 'leave_policies', { name: 'ZZ old release' });
      for (const t of DOCUMENT_TABLES) {
        expect(Number((await c.query(`select count(*)::int as n from ${t} where tenant_id is null`)).rows[0].n), t).toBe(1);
        await c.query(`delete from ${t} where tenant_id is null`);
      }
    });
  });

  it.skipIf(!HAS_APP_MODULES)('the read-back answers clean, and names the crossings the existing rows already held', () => {
    const out = script(READBACK, url);
    expect(out.status, out.output).toBe(0);
    expect(out.output).toMatch(/The document tables \(round 6, migration 0008\):/);
    for (const t of DOCUMENT_TABLES) expect(out.output).toMatch(new RegExp(`${t}: \\d+ rows?, 0 with no park group`));
    expect(out.output).toMatch(/tenant_id NOT NULL \(round 7\): asset_catalog no, leave_policies no, policy_documents no, templates no\./);
    // tSplitBranchByContract_B is B's and still assigned to A's branch; tSplitEmployeesByMaker_B has a contract of A's employee;
    // pSplitContractsByMaker_B was acknowledged by A's employee; iSplit_D is the default's, assigned in A and B.
    expect(out.output).toMatch(/template assignments on another park group's branch: 1\./);
    expect(out.output).toMatch(/contracts made from another park group's template: 4\./);
    expect(out.output).toMatch(/contracts acknowledging another park group's policy: 1\./);
    expect(out.output).toMatch(/assigned assets from another park group's catalogue: 2\./);
    expect(out.output).toMatch(/offboarding census \(H16\): 0 employees with more than one offboarding \(0 surplus rows\); employee_offboarding_employee_unique stands\./);
  });

  afterAll(async () => {
    await drop();
  });
});

describe('C, continued: the census both ways, and the default park group made only where needed', () => {
  it('a person with two offboardings: 0008 still deploys, the index is not made, the words name the count, and the census names the person', async () => {
    const { url, drop } = await databaseAt(7);
    try {
      const tenant = randomUUID();
      const employee = randomUUID();
      const user = randomUUID();
      const rows = [randomUUID(), randomUUID()];
      await withClient(url, async (c) => {
        await insertRow(c, 'tenants', { id: tenant, name: 'ZZ only', slug: 'default' });
        await insertRow(c, 'employees', { id: employee, tenant_id: tenant, full_name: 'ZZ', nickname: 'ZZ', email: `zz-${employee}@example.com` });
        await insertRow(c, 'users', { id: user, email: `zz-${user}@example.com`, password: 'x', full_name: 'ZZ', role: 'admin' });
        for (const [i, row] of rows.entries()) {
          await insertRow(c, 'employee_offboarding', { id: row, employee_id: employee, offboarding_type: 'RESIGNATION', reason_code: 'other', last_working_day: `2026-0${i + 1}-01`, created_by: user });
        }
      });
      const out = await deploy(url);
      expect(out.status, out.output).toBe(0);
      if (HAS_APP_MODULES) {
        expect(out.output).toMatch(new RegExp(`applied ${MIGRATION}`));
        expect(out.output).toMatch(/offboarding census \(0008\): 1 employees have more than one offboarding \(1 rows more than one each\), so employee_offboarding_employee_unique is not made\. Run npm run offboarding:census/);
      }
      await withClient(url, async (c) => {
        expect(Number((await c.query(`select count(*)::int as n from pg_indexes where schemaname = 'otoapp' and indexname = 'employee_offboarding_employee_unique'`)).rows[0].n)).toBe(0);
        for (const t of DOCUMENT_TABLES) {
          expect(Number((await c.query(`select count(*)::int as n from information_schema.columns where table_schema = 'otoapp' and table_name = $1 and column_name = 'tenant_id'`, [t])).rows[0].n), t).toBe(1);
        }
      });
      if (HAS_APP_MODULES) {
        const census = script(CENSUS, url);
        expect(census.status, census.output).toBe(1);
        expect(census.output).toMatch(/2 offboarding rows for 1 employee; 1 employee has more than one\./);
        expect(census.output).toContain(`employee ${employee} (ZZ only): 2 offboardings`);
        for (const row of rows) expect(census.output).toContain(row);
        expect(census.output).toMatch(/NOT made — migration 0008 left it for these employees to be settled first \(plan Q48\)/);
        const back = script(READBACK, url);
        expect(back.status, back.output).toBe(0);
        expect(back.output).toMatch(/offboarding census \(H16\): 1 employee with more than one offboarding \(1 surplus row\); employee_offboarding_employee_unique NOT made — npm run offboarding:census names them \(Q48\)\./);
        // Settled by a person (Q48's default: the older row goes), the census is clean and says nothing stands in the way.
        await withClient(url, (c) => c.query('delete from employee_offboarding where id = $1', [rows[0]]));
        const settled = script(CENSUS, url);
        expect(settled.status, settled.output).toBe(0);
        expect(settled.output).toMatch(/NOT made — migration 0008 has not run here, or ran while a duplicate stood; nothing stands in its way now\./);
      }
    } finally {
      await drop();
    }
  }, 180_000);

  it('a database whose ONLY park group is not slug "default": every document row is that park group’s, and no "OTO Default" is minted', async () => {
    const { url, drop } = await databaseAt(7);
    try {
      const only = randomUUID();
      await withClient(url, async (c) => {
        await insertRow(c, 'tenants', { id: only, name: 'ZZ The only park group', slug: 'zz-only' });
        await insertRow(c, 'templates', { name: 'ZZ', html_body: '<p>zz</p>' });
        await insertRow(c, 'policy_documents', { title: 'ZZ' });
        await insertRow(c, 'asset_catalog', { name: 'ZZ' });
        await insertRow(c, 'leave_policies', { name: 'ZZ' });
      });
      const out = await deploy(url);
      expect(out.status, out.output).toBe(0);
      await withClient(url, async (c) => {
        expect((await c.query('select id, slug from tenants')).rows).toEqual([{ id: only, slug: 'zz-only' }]);
        for (const t of DOCUMENT_TABLES) expect((await c.query(`select distinct tenant_id from ${t}`)).rows, t).toEqual([{ tenant_id: only }]);
      });
    } finally {
      await drop();
    }
  }, 180_000);

  it('several park groups, none slug "default", and a row with nowhere to go: "OTO Default" is made for it, as 0006 makes it', async () => {
    const { url, drop } = await databaseAt(7);
    try {
      await withClient(url, async (c) => {
        await insertRow(c, 'tenants', { name: 'ZZ one', slug: 'zz-one' });
        await insertRow(c, 'tenants', { name: 'ZZ two', slug: 'zz-two' });
        await insertRow(c, 'asset_catalog', { name: 'ZZ never assigned' });
      });
      const out = await deploy(url);
      expect(out.status, out.output).toBe(0);
      await withClient(url, async (c) => {
        const made = (await c.query<{ id: string }>(`select id from tenants where slug = 'default' and name = 'OTO Default'`)).rows;
        expect(made).toHaveLength(1);
        expect((await c.query('select tenant_id from asset_catalog')).rows).toEqual([{ tenant_id: made[0]!.id }]);
      });
    } finally {
      await drop();
    }
  }, 180_000);
});

// =============================================================================
// D. Read off the code
// =============================================================================

interface DocumentRules {
  DOCUMENT_READ_RULES: Record<string, string>;
  TEMPLATE_NOT_FOUND: { message: string };
  POLICY_NOT_FOUND: { message: string };
  CATALOG_ITEM_NOT_FOUND: { message: string };
  BRANCH_NOT_FOUND: { message: string };
  PARK_GROUP_REQUIRED: { message: string };
}

/** server/lib/employeeParkGroups.ts, round 6's review (findings 1 and 2) and its re-review (findings 6 to 8). */
interface EmployeeRules {
  EMPLOYEE_DOORS: readonly { method: string; path: string; fence: 'review' | 'lift' | 'app'; foreign: string }[];
  EMPLOYEE_LIST_DOORS: readonly { method: string; path: string; fence: 're-review' | 'lift' | 'none'; rule: string }[];
  EMPLOYEE_LOOKUPS: readonly { route: string; reads: string; disposition: 'fenced' | 'held' | 'record' | 'token' | 'own' | 'app'; note: string }[];
  EMPLOYEE_ROLE_WRITERS: readonly { writer: string; via: string; disposition: string; note: string }[];
  EMPLOYEE_PARK_GROUP_ID_FIELDS: readonly string[];
  NO_PARK_GROUP_IDS: Record<string, null>;
  WIZARD_EMPLOYEE_FIELDS: readonly string[];
  wizardEmployeeEdits: (raw: unknown) => Record<string, unknown> | undefined;
}

describe('D. read off the code', () => {
  let rules: DocumentRules;
  let hr: EmployeeRules;
  beforeAll(async () => {
    rules = (await import(/* @vite-ignore */ pathToFileURL(join(APP_SERVER, 'lib', 'documentParkGroups.ts')).href)) as DocumentRules;
    hr = (await import(/* @vite-ignore */ pathToFileURL(join(APP_SERVER, 'lib', 'employeeParkGroups.ts')).href)) as EmployeeRules;
  });

  it('the lift’s 503 guard is gone: no legacyHrUser, no "unavailable for this tenant"', () => {
    const routes = readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8');
    expect(routes).not.toMatch(/legacyHrUser|This module is unavailable for this tenant/);
    expect(rules.PARK_GROUP_REQUIRED).toEqual({ message: 'Tenant access required' });
  });

  it('each module’s read rule, decided from the app’s code: own only where an id is kept, the default’s fallback only for leave policies', () => {
    expect(rules.DOCUMENT_READ_RULES).toEqual({ templates: 'own', policies: 'own', assetCatalog: 'own', leavePolicies: 'own-then-default' });
    // The app's own words, kept.
    expect(rules.TEMPLATE_NOT_FOUND).toEqual({ message: 'Template not found' });
    expect(rules.POLICY_NOT_FOUND).toEqual({ message: 'Policy not found' });
    expect(rules.CATALOG_ITEM_NOT_FOUND).toEqual({ message: 'Catalog item not found' });
    expect(rules.BRANCH_NOT_FOUND).toEqual({ message: 'Branch not found' });
    // The ids the decision rests on.
    const schema = readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8');
    expect(schema).toMatch(/templateId: varchar\("template_id"\)\.references\(\(\) => templates\.id\)\.notNull\(\),/);
    expect(schema).toMatch(/policyDocumentId: varchar\("policy_document_id"\)\.references\(\(\) => policyDocuments\.id\),/);
    expect(schema).toMatch(/catalogAssetId: varchar\("catalog_asset_id"\)\.references\(\(\) => assetCatalog\.id\),/);
    expect(schema).not.toMatch(/leavePolicyId|leave_policy_id/);
  });

  it('every document read in storage takes the park group, and only the leave policy reads the default park group’s', () => {
    const storage = storageText();
    for (const signature of [
      'async getTemplates(tenantId: string)',
      'async getTemplatesWithAssignments(tenantId: string)',
      'async getTemplatesForBranch(tenantId: string, branchId?: string)',
      'async getTemplateInParkGroup(id: string, tenantId: string)',
      'async countActiveTemplates(tenantId: string)',
      'async getPolicyDocuments(tenantId: string)',
      'async getPolicyDocumentInParkGroup(id: string, tenantId: string)',
      'async getAssetCatalog(tenantId: string)',
      'async getAssetCatalogItemInParkGroup(id: string, tenantId: string)',
      'async getLeavePolicies(tenantId: string, branchId?: string)',
      'async getLeavePolicyInParkGroup(id: string, tenantId: string)',
      'async getUnsignedLettersCount(tenantId: string, branchId?: string)',
    ]) {
      expect(storage, signature).toContain(signature);
    }
    const active = storage.slice(storage.indexOf('async getActiveLeavePolicy('), storage.indexOf('async createLeavePolicy('));
    // The app's candidate set per park group (round 6's review, F4): the branch's own and the company-wide slot,
    // the slot the park group's own company-wide policies or, where it has none, the default park group's.
    expect(active).toMatch(/const defaultParkGroup = ownCompanyWide \? null : await this\.getDefaultParkGroupId\(\);/);
    expect(active).toMatch(/and\(companyWide, documentOwnedBy\(leavePolicies\.tenantId, defaultParkGroup, leavePolicies\.branchId\)\)/);
    expect(active).toMatch(/\.where\(and\(eq\(leavePolicies\.isActive, true\), or\(branchOwn, slot\)\)\)\s*\.orderBy\(desc\(leavePolicies\.effectiveFrom\)\)\s*\.limit\(1\);/);
    for (const own of ['getTemplates', 'getPolicyDocuments', 'getAssetCatalog']) {
      const body = storage.slice(storage.indexOf(`async ${own}(tenantId: string)`), storage.indexOf('}', storage.indexOf(`async ${own}(tenantId: string)`) + 400));
      expect(body, own).not.toMatch(/getDefaultParkGroupId/);
    }
  });

  it('a template, policy or catalogue item is looked up by id alone only where a record already names it (the signing of a contract)', () => {
    const routes = routesText();
    const byIdAlone = [...routes.matchAll(/storage\.(getTemplate|getPolicyDocument|getAssetCatalogItem)\(/g)].map((m) => {
      const before = routes.lastIndexOf('\n  app.', m.index);
      return `${m[1]} in ${routes.slice(before + 3, routes.indexOf('"', routes.indexOf('"', before) + 1) + 1)}`;
    });
    expect(byIdAlone.sort()).toEqual([
      'getPolicyDocument in app.get("/api/signing/:token/policy"',
      'getTemplate in app.post("/api/signing/:token/sign"',
    ]);
  });

  it('H16: the offboarding create is one transaction, with every write of the app’s steps on it', () => {
    const post = route(routesText(), 'post', '/api/employees/:employeeId/offboarding');
    const start = post.indexOf('const offboarding = await db.transaction(async (tx) => {');
    const end = post.indexOf('return created;\n      });', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const inside = post.slice(start, end);
    for (const write of [
      /tx\.insert\(employeeOffboarding\)/,
      /storage\.updateEmployee\(employeeId, \{[\s\S]*?\}, tx\);/,
      /storage\.updateUser\(employee\.userId, \{ isActive: false \} as any, tx\);/,
      /storage\.createAttentionItem\(\{[\s\S]*?\}, tx\);/,
      /storage\.updateAssetsExpectedReturnBy\(employeeId, lastWorkingDayDate, tx\);/,
      /storage\.createEmployeeChange\(\{[\s\S]*?\}, tx\);/,
      /storage\.createOffboardingChecklistItem\(\{[\s\S]*?\}, tx\);/,
    ]) {
      expect(inside, String(write)).toMatch(write);
    }
    expect(inside.match(/storage\.logActivity\(\{[\s\S]*?\}, tx\);/g)).toHaveLength(2);
    // Nothing written outside it: every storage call in the route is a read before it, or on tx.
    const outside = post.slice(0, start) + post.slice(end);
    expect(outside).not.toMatch(/storage\.(update|create|logActivity|delete)/);
    // The app's linked-login rule, with round 6's review backstop (F2): only a login the strict placement puts
    // in the employee's park group, decided before the transaction (a read, so the writes keep the app's order).
    expect(inside).toMatch(/if \(newEmploymentState === 'LEFT' && employee\.userId && loginInParkGroup\) \{\s*await storage\.updateUser/);
    expect(post.slice(0, start)).toMatch(/const loginInParkGroup = !!employee\.userId && \(await managedUserTenant\(employee\.userId\)\) === employee\.tenantId;/);
  });

  it('H16: an update of the last working day is one transaction too', () => {
    const patch = route(routesText(), 'patch', '/api/employees/:employeeId/offboarding');
    const start = patch.indexOf('const updatedOffboarding = await db.transaction(async (tx) => {');
    expect(start).toBeGreaterThan(-1);
    const inside = patch.slice(start, patch.indexOf('return updated;', start));
    for (const write of [
      /storage\.updateEmployeeOffboarding\(offboarding\.id, updates, tx\)/,
      /storage\.updateEmployee\(employeeId, \{[\s\S]*?\}, tx\);/,
      /storage\.updateAssetsExpectedReturnBy\(employeeId, newLastDay, tx\)/,
      /storage\.deleteAssignmentsByEmployeeAndDateRange\(\s*employeeId, startDateStr, farFuture, tx\s*\)/,
    ]) {
      expect(inside, String(write)).toMatch(write);
    }
    expect(inside.match(/storage\.logActivity\(\{[\s\S]*?\}, tx\);/g)).toHaveLength(2);
    expect(patch.slice(0, start)).not.toMatch(/storage\.(update|create|logActivity|delete)/);
  });

  it('the PDF gate: each door checks the owner before a signed URL, and every signed URL lives five minutes at most', () => {
    const routes = routesText();
    const handlers = routes.split('\n  app.').slice(1);
    const issuers = handlers.filter((h) => /presignedPdfUrl\(/.test(h));
    expect(issuers.map((h) => h.slice(0, h.indexOf(',')))).toEqual([
      'get("/api/contracts/:id/pdf"',
      'get("/api/contracts/:id/download-signed-pdf"',
      'get("/api/contracts/:id/download-signed-pdf-auth"',
      'get("/api/contracts/:id/signed-pdf"',
      'get("/api/employees/:employeeId/letters/:letterId/download"',
    ]);
    for (const h of issuers) {
      const signedAt = h.indexOf('presignedPdfUrl(');
      const check = Math.max(h.indexOf('getEmployeeInTenant('), h.indexOf('crypto.timingSafeEqual('));
      expect(check, h.slice(0, 60)).toBeGreaterThan(-1);
      expect(check, h.slice(0, 60)).toBeLessThan(signedAt);
    }
    const pdfStorage = code(readFileSync(join(APP_SERVER, 'pdf-storage.ts'), 'utf8'));
    expect(pdfStorage).toMatch(/\}\), \{ expiresIn: 300 \}\);/);
    const beo = code(readFileSync(join(APP_SERVER, 'beo-routes.ts'), 'utf8'));
    const beoPdf = beo.slice(beo.indexOf('app.get("/api/events/:eventId/beo/pdf"'));
    expect(beoPdf.indexOf('verifyEventAccess(eventId, req.userWithAccess)')).toBeLessThan(beoPdf.indexOf('s3PresignedGet("beo-pdfs", objectName, 300)'));
    expect(routes).toMatch(/const publicFileFolders = \["branch-logos", "dropoff-photos", "invitations"\];/);
  });

  it('the readable reason is the form’s own words, shared, and display only', () => {
    const schema = readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8');
    expect(schema).toMatch(/personal_reasons: "Personal reasons",/);
    const modal = readFileSync(join(APP_DIR, 'client', 'src', 'components', 'offboarding-modal.tsx'), 'utf8');
    expect(modal).toMatch(/offboardingReasons\.map\(\(value\) => \(\{ value, label: offboardingReasonLabels\[value\] \}\)\)/);
    const editor = readFileSync(join(APP_DIR, 'client', 'src', 'pages', 'employee-editor-page.tsx'), 'utf8');
    expect(editor).toMatch(/data-testid="text-end-reason">\{offboardingReasonLabel\(employee\.endReason\)\}/);
    // What the app stores is unchanged.
    expect(route(routesText(), 'post', '/api/employees/:employeeId/offboarding')).toMatch(/endReason: validatedData\.reasonText \|\| validatedData\.reasonCode,/);
  });

  // ── Round 6's review fixes (findings 1 to 4), read off the code ──────────────

  it('F1, the census: every `/api/employees/:id*` door the routes register is in it, in order (45), and each resolves the employee in a park group before it writes anything', () => {
    const routes = routesText();
    const registered = [...routes.matchAll(/\n {2}app\.(get|post|put|patch|delete)\("(\/api\/employees\/:[^"]+)"/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    expect(registered).toHaveLength(45);
    expect(registered).toEqual(hr.EMPLOYEE_DOORS.map((d) => `${d.method} ${d.path}`));
    const counts = { review: 0, lift: 0, app: 0 };
    for (const door of hr.EMPLOYEE_DOORS) {
      counts[door.fence] += 1;
      const handler = route(routes, door.method.toLowerCase(), door.path);
      const fence = handler.search(/employeeOfParkGroup\(req, |getEmployeeInTenant\(|employee\.tenantId !== |employeeDeleteOutsideParkGroup\(|authorizedOffboardingEmployee\(/);
      expect(fence, `${door.method} ${door.path} looks the employee up in a park group`).toBeGreaterThan(-1);
      const write = handler.search(/storage\.(update|create|set|delete|logActivity|archive)\w*\(|db\.(insert|update|delete)\(|db\.transaction\(|uploadToObjectStorage\(/);
      if (write > -1) expect(fence, `${door.method} ${door.path}: the lookup comes before the first write`).toBeLessThan(write);
      if (door.fence === 'review') {
        expect(handler, `${door.method} ${door.path}`).toMatch(/employeeOfParkGroup\(req, /);
        expect(handler, `${door.method} ${door.path}`).not.toMatch(/storage\.getEmployee\(/);
      }
    }
    expect(counts).toEqual({ review: 18, lift: 26, app: 1 });
  });

  it('F1, the edit: PATCH /api/employees/:id drops `tenantId` and weighs every id it changes before it writes; the roles, department, transfer, change and allocation doors weigh theirs', () => {
    const routes = routesText();
    const patch = route(routes, 'patch', '/api/employees/:id');
    const drop = patch.indexOf('delete updateData.tenantId;');
    const weigh = patch.indexOf('const outside = await employeeEditOutsideParkGroup(updateData, oldEmployee);');
    expect(drop).toBeGreaterThan(-1);
    expect(weigh).toBeGreaterThan(drop);
    expect(weigh).toBeLessThan(patch.indexOf('storage.updateEmployee('));
    const weighing = routes.slice(routes.indexOf('const employeeEditOutsideParkGroup = async'), routes.indexOf('const rolesOutsideParkGroup = async'));
    for (const words of ['BRANCH_NOT_FOUND', 'USER_NOT_FOUND', 'PERSON_NOT_FOUND', 'DEPARTMENT_NOT_FOUND']) expect(weighing, words).toContain(`return ${words};`);
    expect(weighing).toMatch(/\(await managedUserTenant\(userId\)\) !== tenantId/);
    expect(route(routes, 'patch', '/api/employees/:id/roles')).toMatch(/if \(await rolesOutsideParkGroup\(roleIds, employee\.tenantId\)\) \{\s*return res\.status\(404\)\.json\(ROLE_NOT_FOUND\);/);
    expect(route(routes, 'patch', '/api/employees/:id/department')).toMatch(/if \(!dept \|\| dept\.tenantId !== employee\.tenantId\) \{/);
    expect(route(routes, 'post', '/api/employees/:employeeId/changes')).toMatch(/!await branchInParkGroup\(newBranchId, employee\.tenantId\)/);
    expect(route(routes, 'patch', '/api/employees/:employeeId/changes/:changeId')).toMatch(/delete updates\.employeeId;/);
    expect(route(routes, 'put', '/api/employees/:id/cost-allocations')).toMatch(/eq\(branches\.tenantId, employee\.tenantId\)/);
  });

  it('F2: the wizard takes the six personal fields its own client sends, and nothing else', () => {
    expect(hr.WIZARD_EMPLOYEE_FIELDS).toEqual(['fullName', 'nickname', 'email', 'phone', 'address', 'nationalId']);
    const wizard = readFileSync(join(APP_DIR, 'client', 'src', 'pages', 'contract-wizard-page.tsx'), 'utf8');
    const sent = wizard.slice(wizard.indexOf('const employeeUpdates = checkEmployeeEdits() ? {'), wizard.indexOf('} : undefined;', wizard.indexOf('const employeeUpdates = checkEmployeeEdits()')));
    expect([...sent.matchAll(/^\s+(\w+): data\./gm)].map((m) => m[1])).toEqual([...hr.WIZARD_EMPLOYEE_FIELDS]);
    expect(hr.wizardEmployeeEdits({ fullName: 'ZZ', nationalId: null, userId: 'x', tenantId: 'y', branchId: 'z', status: 'terminated' })).toEqual({ fullName: 'ZZ', nationalId: null });
    expect(hr.wizardEmployeeEdits(undefined)).toBeUndefined();
    const generate = route(routesText(), 'post', '/api/contracts/generate');
    expect(generate).toMatch(/const employeeUpdates = wizardEmployeeEdits\(req\.body\.employeeUpdates\);/);
    expect(generate).not.toMatch(/\n\s+employeeUpdates,\n/);
  });

  it('F3: `/api/all-leave-balances` takes the caller’s park group’s branch first, as `/api/leave-balances` does', () => {
    const all = route(routesText(), 'get', '/api/all-leave-balances');
    const check = all.indexOf('!await branchInParkGroup(branchId, parkGroup)');
    expect(check).toBeGreaterThan(-1);
    expect(all.slice(check)).toMatch(/^!await branchInParkGroup\(branchId, parkGroup\)\) \{\s*return res\.status\(404\)\.json\(BRANCH_NOT_FOUND\);/);
    expect(check).toBeLessThan(all.indexOf('storage.getEmployees(branchId)'));
    // `getEmployees` takes no branch (the app lists every employee whatever branch is named, kept); the list keeps to the park group.
    expect(all).toMatch(/const employees = \(await storage\.getEmployees\(branchId\)\)\.filter\(\(e\) => e\.tenantId === parkGroup\);/);
    expect(storageText()).toMatch(/async getEmployees\(\): Promise<Employee\[\]> \{/);
  });

  // ── The re-review's fixes (findings 6 to 8), read off the code ──────────────

  it('F6, the census at all 54 routes: every `/api/employees*` route the app registers is one of the 45 doors with an id or the nine without, each list in the order the routes register them', () => {
    const routes = routesText();
    const all = [...routes.matchAll(/\n {2}app\.(get|post|put|patch|delete)\("(\/api\/employees(?:\/[^"]*)?)"/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    expect(all).toHaveLength(54);
    const withoutId = all.filter((r) => !r.includes('/:'));
    expect(withoutId).toEqual(hr.EMPLOYEE_LIST_DOORS.map((d) => `${d.method} ${d.path}`));
    expect(all.filter((r) => r.includes('/:'))).toEqual(hr.EMPLOYEE_DOORS.map((d) => `${d.method} ${d.path}`));
    const fences = hr.EMPLOYEE_LIST_DOORS.reduce<Record<string, number>>((n, d) => ({ ...n, [d.fence]: (n[d.fence] ?? 0) + 1 }), {});
    expect(fences).toEqual({ 're-review': 6, lift: 2, none: 1 });
    // The dead one is dead because `GET /api/employees/:id` is registered first and answers it.
    expect(routes.indexOf('app.get("/api/employees/:id"')).toBeLessThan(routes.indexOf('app.get("/api/employees/upcoming-reviews"'));
  });

  it('F6, each door without an id keeps to its rule, read off its handler: the park group taken before the app’s filters, matches and writes', () => {
    const routes = routesText();
    const handler = (key: string) => {
      const [method, path] = key.split(' ') as [string, string];
      return route(routes, method.toLowerCase(), path);
    };
    const rules = Object.fromEntries(hr.EMPLOYEE_LIST_DOORS.map((d) => [d.rule, `${d.method} ${d.path}`]));
    const list = handler(rules.list!);
    const held = list.indexOf('let filteredEmployees = employees.filter(e => !!parkGroup && e.tenantId === parkGroup);');
    expect(held).toBeGreaterThan(-1);
    expect(held).toBeLessThan(list.indexOf('if (userWithAccess && !userWithAccess.hasAllBranchesAccess) {'));
    expect(held).toBeLessThan(list.indexOf('if (branchIdFilter) {'));
    expect(list).toMatch(/const parkGroup = userWithAccess\?\.tenantId;/);
    expect(handler(rules.sample!)).toMatch(/const branches = \(await storage\.getBranches\(\)\)\.filter\(b => !!parkGroup && b\.tenantId === parkGroup\);/);
    expect(handler(rules.delete!)).toMatch(/employeeDeleteOutsideParkGroup\(employee, tenantId\)/);
    expect(handler(rules.reorder!)).toMatch(/if \(parkGroup\) await storage\.reorderEmployees\(orderedIds, parkGroup\);/);
    const reorder = storageText().slice(storageText().indexOf('async reorderEmployees('));
    expect(reorder.slice(0, 400)).toMatch(/\.where\(and\(eq\(employees\.id, orderedIds\[i\]\), eq\(employees\.tenantId, tenantId\)\)\);/);
    expect(handler(rules.recalculate!)).toMatch(/parkGroupOnly\(userManagementTenant\)/);
    const preview = handler(rules['import-preview']!);
    expect(preview).toMatch(/const allBranches = \(await storage\.getBranches\(\)\)\.filter\(b => ofParkGroup\(b\.tenantId\)\);/);
    expect(preview).toMatch(/const allEmployees = \(await storage\.getEmployees\(\)\)\.filter\(e => ofParkGroup\(e\.tenantId\)\);/);
    expect(preview).toMatch(/branchError = `Branch "\$\{rowData\.branchName\}" not found`;/);
    const apply = handler(rules['import-apply']!);
    const branchCheck = apply.indexOf('!await branchInParkGroup(branchId, tenantId)');
    expect(branchCheck).toBeGreaterThan(-1);
    expect(branchCheck).toBeLessThan(apply.indexOf('if (isNew) {'));
    expect(apply).toMatch(/const employee = await storage\.getEmployeeInTenant\(matchedEmployeeId, tenantId\);/);
    expect(apply).not.toMatch(/storage\.getEmployee\(/);
  });

  it('F7, the call-site census: the 32 `storage.getEmployee(` sites the re-review counted, each with its disposition — the eight fenced now look up in the park group, the 24 others still by id, per handler exactly as the census says', () => {
    const routes = routesText();
    expect(hr.EMPLOYEE_LOOKUPS).toHaveLength(32);
    const fenced = hr.EMPLOYEE_LOOKUPS.filter((l) => l.disposition === 'fenced');
    expect(fenced.map((l) => l.route)).toEqual([
      'POST /api/employees/bulk-update',
      'POST /api/timekeeping/issues/:issueId/resolve',
      'GET /api/timekeeping/employee/:employeeId',
      'POST /api/time-events/override',
      'POST /api/timekeeping/live/ping',
      'POST /api/shifts',
      'PATCH /api/shifts/:id',
      'PATCH /api/schedule/assignments/:id/reassign',
    ]);
    // Every remaining by-id lookup is one the census keeps, handler by handler.
    const sites = (h: string) => (h.match(/storage\.getEmployee\(/g) ?? []).length;
    expect(sites(routes)).toBe(24);
    const kept = new Map<string, number>();
    for (const l of hr.EMPLOYEE_LOOKUPS) if (l.disposition !== 'fenced') kept.set(l.route, (kept.get(l.route) ?? 0) + 1);
    for (const r of new Set(hr.EMPLOYEE_LOOKUPS.map((l) => l.route))) {
      const [method, path] = r.split(' ') as [string, string];
      const h = route(routes, method.toLowerCase(), path);
      expect(sites(h), r).toBe(kept.get(r) ?? 0);
      if (fenced.some((l) => l.route === r)) expect(h, r).toMatch(/employeeOfParkGroup\(req, |getEmployeeInTenant\(/);
    }
    // The doors driven: each holds its record to the park group before it writes.
    const resolve = route(routes, 'post', '/api/timekeeping/issues/:issueId/resolve');
    expect(resolve).toMatch(/if \(!issue \|\| !req\.userWithAccess\?\.tenantId \|\| issue\.tenantId !== req\.userWithAccess\.tenantId\) \{\s*return res\.status\(404\)\.json\(\{ message: "Issue not found" \}\);/);
    expect(resolve.indexOf('issue.tenantId !== req.userWithAccess.tenantId')).toBeLessThan(resolve.indexOf('storage.updateTimeEntry('));
    const override = route(routes, 'post', '/api/time-events/override');
    const employeeAt = override.indexOf('const employee = await employeeOfParkGroup(req, employeeId);');
    expect(employeeAt).toBeGreaterThan(-1);
    expect(override.slice(employeeAt)).toMatch(/if \(!await branchInParkGroup\(branchId, employee\.tenantId\)\) \{\s*return res\.status\(404\)\.json\(BRANCH_NOT_FOUND\);/);
    expect(employeeAt).toBeLessThan(override.indexOf('storage.createTimeEvent('));
    const reassign = route(routes, 'patch', '/api/schedule/assignments/:id/reassign');
    expect(reassign).toMatch(/if \(!assignment \|\| !req\.userWithAccess\?\.tenantId \|\| assignment\.tenantId !== req\.userWithAccess\.tenantId\) \{\s*return res\.status\(404\)\.json\(\{ message: "Assignment not found" \}\);/);
    expect(reassign).toMatch(/const newEmployee = await employeeOfParkGroup\(req, newEmployeeId\);\s*if \(!newEmployee\) \{\s*return res\.status\(400\)\.json\(\{ message: "New employee not found" \}\);/);
  });

  it('F7, the `employee_roles` writers: each in the census; the role-holder write deletes and inserts only the caller’s park group’s holders after weighing the role and the employees, and its read lists only theirs', () => {
    expect(hr.EMPLOYEE_ROLE_WRITERS.map((w) => `${w.writer} -> ${w.disposition}`)).toEqual([
      'storage.setEmployeeRoles -> held',
      'storage.setRoleEmployees -> fenced',
      'storage.deleteEmployee -> held',
      "Data Admin's Employee Role and Role models -> later",
      'server/prod-sync.ts -> dev-only',
    ]);
    // Every storage writer of the table is one of them.
    const storage = storageText();
    const writers = [...storage.matchAll(/db\s*\.(insert|delete)\(employeeRoles\)/g)].map((m) => {
      const fn = storage.lastIndexOf('\n        async ', m.index);
      return storage.slice(fn + 15, storage.indexOf('(', fn + 15));
    });
    expect([...new Set(writers)].sort()).toEqual(['deleteEmployee', 'setEmployeeRoles', 'setRoleEmployees']);
    const set = storage.slice(storage.indexOf('async setRoleEmployees('), storage.indexOf('async getRoleWithBranches('));
    expect(set).toMatch(/await db\.delete\(employeeRoles\)\.where\(and\(\s*eq\(employeeRoles\.roleId, roleId\),\s*inArray\(\s*employeeRoles\.employeeId,\s*db\.select\(\{ id: employees\.id \}\)\.from\(employees\)\.where\(eq\(employees\.tenantId, tenantId\)\),/);
    const byRole = storage.slice(storage.indexOf('async getEmployeesByRole('), storage.indexOf('async setRoleEmployees('));
    expect(byRole).toMatch(/\.where\(and\(eq\(employeeRoles\.roleId, roleId\), eq\(employees\.tenantId, tenantId\)\)\);/);
    const routes = routesText();
    const patch = route(routes, 'patch', '/api/roles/:id/employees');
    const weighRole = patch.indexOf('await rolesOutsideParkGroup([req.params.id], tenantId)');
    const weighEmployees = patch.indexOf('await employeesOutsideParkGroup(employeeIds, tenantId)');
    const write = patch.indexOf('await storage.setRoleEmployees(req.params.id, employeeIds, tenantId);');
    expect(weighRole).toBeGreaterThan(-1);
    expect(weighEmployees).toBeGreaterThan(weighRole);
    expect(write).toBeGreaterThan(weighEmployees);
    expect(patch).toMatch(/return res\.status\(404\)\.json\(EMPLOYEE_NOT_FOUND\);/);
    expect(route(routes, 'get', '/api/roles/:id/employees')).toMatch(/const roleEmployees = tenantId \? await storage\.getEmployeesByRole\(req\.params\.id, tenantId\) : \[\];/);
  });

  it('F8: the create weighs the ids its body names with the edit’s check, in its words, before it writes anything', () => {
    expect([...hr.EMPLOYEE_PARK_GROUP_ID_FIELDS]).toEqual(['branchId', 'userId', 'updatedBy', 'profilePhotoUpdatedBy', 'personId', 'primaryDepartmentId']);
    expect(hr.NO_PARK_GROUP_IDS).toEqual(Object.fromEntries(hr.EMPLOYEE_PARK_GROUP_ID_FIELDS.map((f) => [f, null])));
    const create = route(routesText(), 'post', '/api/employees');
    const weigh = create.indexOf('const outside = await employeeEditOutsideParkGroup(parsed.data, { ...NO_PARK_GROUP_IDS, tenantId: actorTenantId });');
    expect(weigh).toBeGreaterThan(-1);
    expect(create.slice(weigh)).toMatch(/^const outside = [^\n]*\n\s*if \(outside\) return res\.status\(404\)\.json\(outside\);/);
    for (const write of ['storage.createPerson(', 'storage.createUser(', 'storage.createEmployee(']) expect(weigh, write).toBeLessThan(create.indexOf(write));
  });
});

// =============================================================================
// E. CI, the image and the plan
// =============================================================================

describe('E. CI, the image and the plan', () => {
  it("CI's OTO App job runs the document check after the attendance check, then the census, then the read-back; the new lib counts as the seam", () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('\n  oto-app:'));
    const at = (s: string) => job.indexOf(s);
    expect(at('run: npx tsx tests/documents.check.ts')).toBeGreaterThan(at('run: npx tsx tests/attendance.check.ts'));
    expect(at('run: npm run offboarding:census')).toBeGreaterThan(at('run: npx tsx tests/documents.check.ts'));
    expect(at('run: npm run tenant:readback')).toBeGreaterThan(at('run: npm run offboarding:census'));
    expect(job).toMatch(/PUPPETEER_EXECUTABLE_PATH: \/usr\/bin\/google-chrome\n\s+run: npx tsx tests\/documents\.check\.ts/);
    const seams = [...ci.matchAll(/APP_SEAM='([^']+)'/g)].map((m) => m[1]);
    expect(seams).toHaveLength(3);
    expect(new Set(seams).size).toBe(1);
    expect(new RegExp(seams[0]!).test('apps/oto-app/server/lib/documentParkGroups.ts')).toBe(true);
    // Round 6's review: the employee doors' census is read by section D here, so it counts as the seam too.
    expect(new RegExp(seams[0]!).test('apps/oto-app/server/lib/employeeParkGroups.ts')).toBe(true);
  });

  it('the image carries the census beside the read-back, and the app names it', () => {
    expect(readFileSync(join(APP_DIR, 'Dockerfile'), 'utf8')).toMatch(/COPY script\/offboarding-census\.mjs \.\/script\/offboarding-census\.mjs/);
    expect(JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).scripts['offboarding:census']).toBe('node script/offboarding-census.mjs');
    expect(readFileSync(join(APP_DIR, 'script', 'migrate.mjs'), 'utf8')).toMatch(/PL\\\/pgSQL function inline_code_block/);
  });

  it('the plan carries round 6 as built and its questions, Q47 to Q53, each with its default', () => {
    for (let n = 47; n <= 53; n += 1) expect(question(n), `Q${n}`).toMatch(/Default: /);
    const text = plan();
    expect(text).toMatch(/\*\*As built in round 6, the document tables\*\*/);
    expect(text).toMatch(/\*\*As built in round 6: `0008_document_tenant_ownership_expand`\*\*/);
    expect(text).toMatch(/\*\*As built in round 6, for contracts, letters and BEOs\*\*/);
    expect(text).toMatch(/7 offboardings for 7\s+employees, none with two/);
  });
});

// =============================================================================
// F. The real app
// =============================================================================

describe.skipIf(!HAS_APP_RUNTIME || !CHROMIUM)('F. the real app: the document check over HTTP', () => {
  it('apps/oto-app/tests/documents.check.ts passes against a fresh database (H16, the PDF gate, FINDINGs Q50 and Q52, and round 6’s review: the 45-door census, the six wizard fields, the login backstop, the branch-wide leave read and the leave-policy candidates; and its re-review: the 54-route census, the lookups by id and the role holders), and the read-back and the census answer clean', async () => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      const result = spawnSync(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/documents.check.ts'], {
        cwd: APP_DIR,
        env: { ...process.env, DATABASE_URL: url, PUPPETEER_EXECUTABLE_PATH: CHROMIUM },
        encoding: 'utf8',
        timeout: 400_000,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      expect(output).toMatch(/documents\.check: 43 checks passed/);
      for (const named of [
        '(H16)',
        'ticket check 2',
        'FINDING Q50',
        'FINDING Q52',
        "round 6's review, F3",
        "round 6's review, F4",
        "F2's backstop",
        'six personal fields',
        "round 6's re-review, F6",
        "round 6's re-review, F7",
        "round 6's re-review, F8",
      ]) {
        expect(output, named).toContain(named);
      }
      expect(output).toMatch(/the census: 45 doors — 18 fenced by round 6's review, 26 before it, 1 by the app itself/);
      expect(output).toMatch(/the census: 54 routes — the 45 with an id and 9 without: 6 fenced by round 6's re-review, 2 before it, 1 dead/);
      expect(output).toMatch(/the lookups: 32 call sites — 8 fenced by round 6's re-review, 9 held after the lookup, 6 read off a held record, 6 behind a token, 2 the caller's own, 1 by the app itself/);
      expect(output).toMatch(/FINDING Q52: two GETs at once wrote 6 node\(s\) for 3 missing employee\(s\); 3 of them are now on the chart twice/);
      const back = script(READBACK, url);
      expect(back.status, back.output).toBe(0);
      expect(back.output).toMatch(/employee_offboarding_employee_unique stands\./);
      const census = script(CENSUS, url);
      expect(census.status, census.output).toBe(0);
    } finally {
      await drop();
    }
  }, 420_000);
});
