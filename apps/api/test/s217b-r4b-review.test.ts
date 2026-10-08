import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opsRun, type Db } from '@oto/db';
import { applyOtoAppMigrations, createTestDatabase } from '@oto/db/testing';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { loadEnv, type Env } from '../src/env';
import { buildOtoAppNightJobs, createJobRunner, type JobDefinition } from '../src/services/jobs';
import type { NightJobAnswer, OtoAppNightJob } from '../src/services/otoapp-directory';
import { OTOAPP_ATTENTION_JOB, OTOAPP_NO_SHOW_JOB, type NightJobSummary } from '../src/services/otoapp-jobs';

/**
 * S2-17b round 4b (SCRUM-193 under SCRUM-191) — THE REVIEW, from the attacking
 * side (docs/progress/plans/otoapp-lift/PLAN.md section 5's tenant-ownership
 * and Attention material, section 7's round 4 entries, section 8 round 4's 4b
 * half, hazards H10-H12 and H20, Q28-Q37), on top of the builder's
 * s217b-r4b.test.ts, which this does not repeat.
 *
 *  A. THE CONTRACTION, migration 0007, attacked where the builder did not:
 *     0006 and every migration before it byte for byte what staging applied
 *     (0006 is applied there and may never change); ONE migrator run from a
 *     seeded 0005 state straight to 0007 (the production restore's path,
 *     S2-22: 0006's backfill and 0007's again in one transaction) on a
 *     three-park-group fixture with every kind of link, the strict-placement
 *     edges (an access row naming another park group's branch, an operator
 *     admin across park groups, a user in two) and disagreeing links; the
 *     same jump for a database whose only park group is not slug `default`
 *     (no "OTO Default" minted); the gate on two tables at once with a second
 *     unforeseen obstacle — refused loudly with both counts, nothing changed,
 *     the read-back naming them — and the next deploy applying it once the
 *     obstacle is gone; and the one hazard its two-step lock adds (SHARE ROW
 *     EXCLUSIVE, then ACCESS EXCLUSIVE for NOT NULL): a transaction that read
 *     a table and then writes it, open across the upgrade, deadlocks with the
 *     migration — whichever Postgres aborts, nothing is half done and the next
 *     run completes.
 *  B. THE OPENED SETTINGS WRITES over HTTP against the app's real routes: a
 *     second park group's own row beside the default's on every settings door
 *     (no 4a-era 409 left anywhere), a third park group still reading the
 *     default's (Q28); a multi-key save that UPDATES an existing key and adds
 *     one before a key that fails, rolled back whole; eight racing multi-key
 *     saves in opposite key orders from one park group beside the default
 *     park group's own — no deadlock, never a 500, one row per key per park
 *     group; Data Admin as 4b leaves it.
 *  C. ATTENTION over HTTP and off the code: every writer in the whole app
 *     tree names the park group of the row it is about (seventeen calls);
 *     the job endpoint's counts held against the database rule by rule, the
 *     stale items it resolved, and the park group it was not asked for
 *     untouched (the first run's burst is honest); D's reads, counts,
 *     resolve, snooze, check-condition and diagnostics never reach B's; each
 *     park group's Refresh leaves the other's open items open; Refresh beside
 *     a held run refused while another park group's runs; and the no-show
 *     check's 07:00-22:00 Bangkok hours on the app's OWN clock at the edges
 *     and across midnight (three servers whose clocks cross 07:00, 22:00 and
 *     00:00 during the test).
 *  D. THE PLATFORM'S TWO JOBS: the no-show fence at the millisecond either
 *     side of 07:00 and 22:00 and across midnight; Run now pressed while a
 *     scheduled Attention run holds the job — refused, the app asked once.
 *  E. Seams, fences and the plan: booth, POS, console, launcher, packages
 *     and services name nothing of 4b; nothing of rounds 5 to 7; 0007 touches
 *     its three tables only.
 *
 * Findings are pinned with `it.fails` (the repo's review convention): each
 * states the behaviour that should hold and fails until it is fixed; the `it`
 * beside it proves the failure is the defect, not the arrangement. Three, all
 * low, none blocking 4b:
 *
 *  1. (low) The duplicate-face alert names another park group's employee.
 *     `POST /api/kiosk/enroll-face`'s DUPLICATE_FACE_ENROLLMENT alert is
 *     raised in the enrolling employee's park group (correct), but its words
 *     carry the full name and id of the employee the face matched, looked up
 *     with `storage.getEmployee(matchedEmployeeId)` in EVERY park group — and
 *     the Rekognition collection is one for all park groups
 *     (`AWS_REKOGNITION_COLLECTION_ID`, default "oto-hr-faces"). Until 4b the
 *     alert was never written (ATTENTION_WRITES_READY false); 4b resumes it.
 *     Reachable only with USE_AWS_REKOGNITION=true (face is off on staging,
 *     round 5's H13). Prescribed fix: look the matched employee up within the
 *     enrolling employee's park group only, and where the match is another
 *     park group's (or not found there) say "an employee of another park
 *     group" with no name or id; or record it as a question beside round 5's
 *     face decisions.
 *  2. (low) Q35's words never reach the manager. A Refresh pressed while the
 *     park group's engine runs is answered 409 with "Attention is already
 *     being checked for this park group. Try Refresh again in a minute." (the
 *     plan's section 10 quotes it as what is said), but the Attention page's
 *     `refreshMutation.onError` ignores the answer and shows "Refresh failed —
 *     Could not refresh attention items" in red. Prescribed fix: show the
 *     answer's `message` when the server gives one (the app's own page, one
 *     toast), or correct section 10 and Q35 to say what the page shows.
 *  3. (low) Lifting Data Admin's hold opened a move nobody names. As built,
 *     any park group's admin moves a settings row from one park group to
 *     another through `PUT /api/data-admin/settings/:id` with 200 (proved
 *     below: B's admin takes the default park group's MD signatory row, after
 *     which the default park group reads none and its contracts print no
 *     signatory). 4a's fix refused that move; 4b dropped the refusal with the
 *     hold, and Q36 says only that "a row cannot be moved to no park group".
 *     DELETE through Data Admin has the same reach, so this is Data Admin's
 *     round 7 walkthrough (Q31), not a new class of door. Prescribed fix:
 *     refuse a Data Admin settings update that changes a row's park group, in
 *     the words the other settings doors use (a one-line check in
 *     `SettingAdmin.update`), or name the move in Q36 so the owner decides
 *     with it in view.
 *
 * Sections A, C's code part, D and E run everywhere; B's and C's HTTP parts
 * need the app's node_modules (present locally and in CI's OTO App job).
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_SERVER = join(APP_DIR, 'server');
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_MODULES = ['pg', 'drizzle-orm'].every((m) => existsSync(join(APP_NODE_MODULES, m, 'package.json')));
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);
const READBACK = join(APP_DIR, 'script', 'tenant-ownership-readback.mjs');
const TABLES = ['settings', 'activity_log', 'attention_items'] as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** A file as committed (LF), whatever the checkout did to its line ends. */
const committed = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}
const journal = (): Journal => JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;

/** A copy of the app's migrations up to and including `idx`. */
function migrationsUpTo(idx: number): string {
  const j = journal();
  const live = j.entries.filter((e) => e.idx <= idx);
  const dir = mkdtempSync(join(tmpdir(), 'otoapp-r4b-review-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...j, entries: live }));
  for (const e of live) copyFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>, name = 'zz-r4b-review'): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: name });
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

/** The deploy's migrator (the app's own where it can run here), its exit and its words. */
async function deploy(url: string): Promise<{ status: number; output: string }> {
  if (HAS_APP_MODULES) {
    const out = spawnSync(process.execPath, [join(APP_DIR, 'script', 'migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    return { status: out.status ?? 1, output: `${out.stdout ?? ''}\n${out.stderr ?? ''}` };
  }
  try {
    await applyOtoAppMigrations(url);
    return { status: 0, output: 'applyOtoAppMigrations' };
  } catch (err) {
    return { status: 1, output: String((err as Error)?.message ?? err) };
  }
}

function readback(url: string): { status: number; output: string } {
  const out = spawnSync(process.execPath, [READBACK], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  return { status: out.status ?? 2, output: `${out.stdout ?? ''}\n${out.stderr ?? ''}` };
}

const insertRow = (c: pg.Client, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return c.query(
    `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
};

/** The shape the contraction promises: NOT NULL on the three, the (tenant_id, key) unique alone, 0007 recorded. */
async function contracted(c: pg.Client): Promise<{ nullable: string[]; uniques: string[]; ledger: number }> {
  const cols = await c.query<{ table_name: string; is_nullable: string }>(
    `select table_name, is_nullable from information_schema.columns
      where table_schema = 'otoapp' and column_name = 'tenant_id' and table_name = any($1) order by 1`,
    [TABLES],
  );
  const uniques = await c.query<{ name: string }>(
    `select conname as name from pg_constraint where conrelid = 'otoapp.settings'::regclass and contype = 'u'
     union all
     select indexname from pg_indexes where schemaname = 'otoapp' and tablename = 'settings' and indexdef like 'CREATE UNIQUE%'
     order by 1`,
  );
  const ledger = Number((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n);
  return { nullable: cols.rows.map((r) => `${r.table_name} ${r.is_nullable}`), uniques: uniques.rows.map((r) => r.name), ledger };
}

const NOT_NULL = ['activity_log NO', 'attention_items NO', 'settings NO'];
const NULLABLE = ['activity_log YES', 'attention_items YES', 'settings YES'];

const PASSWORD = 'zz-r4b-review-password';
/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

const plan = () => readFileSync(join(REPO, 'docs', 'progress', 'plans', 'otoapp-lift', 'PLAN.md'), 'utf8');
/** One numbered question's paragraph in the plan. */
const question = (n: number) => {
  const text = plan();
  const start = text.indexOf(`- **Q${n}.`);
  expect(start, `Q${n}`).toBeGreaterThan(0);
  const next = text.indexOf('\n- **Q', start + 5);
  const end = text.indexOf('\n## ', start);
  return text.slice(start, Math.min(next > 0 ? next : Infinity, end > 0 ? end : Infinity)).replace(/\s+/g, ' ');
};

afterAll(async () => {
  await teardownAll();
});

// =============================================================================
// A. The contraction, attacked
// =============================================================================

describe('A. the contraction (0007), attacked', () => {
  /**
   * What staging applied (0900a4de; the 4a landing). Drizzle's migrator does
   * not re-check an applied migration, so an edit to one would never fail a
   * deploy: it would only make every fresh database differ from staging.
   */
  const APPLIED = {
    '0006_tenant_ownership_expand.sql': 'e2f9c20269d7a508c636e8bc2b84e11ac5f82418df98890fc70b894e5d1e1225',
    'meta/0006_snapshot.json': 'd79e8db0c4396c818de10afeeef20ea8824ab06848d339cfed9c1ec14ea3f369',
    '0005_otoapp_v_employees.sql': 'c3015cea6babf2f1f8f3f11d9350d932e93f1f98aba9556863db5d93d7975945',
  };
  const JOURNAL_AS_APPLIED: Array<[number, number, string]> = [
    [0, 1789888010378, '0000_otoapp_baseline'],
    [1, 1789888049933, '0001_platform_user_id'],
    [2, 1790138278147, '0002_core_branch_id_unique'],
    [3, 1791349497533, '0003_events_seam'],
    [4, 1791349499488, '0004_otoapp_v_views'],
    [5, 1791440485239, '0005_otoapp_v_employees'],
    [6, 1791474702189, '0006_tenant_ownership_expand'],
  ];

  it('0006 and the migrations before it are byte for byte what staging applied; 0007 is the one addition', () => {
    for (const [file, hash] of Object.entries(APPLIED)) expect(sha256(committed(join(APP_MIGRATIONS, file))), file).toBe(hash);
    const entries = journal().entries;
    expect(entries.slice(0, 7).map((e) => [e.idx, e.when, e.tag])).toEqual(JOURNAL_AS_APPLIED);
    expect(entries.slice(7).map((e) => e.tag)).toEqual(['0007_tenant_ownership_contract']);
    const sql = readdirSync(APP_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    expect(sql).toEqual([...JOURNAL_AS_APPLIED.map(([, , tag]) => `${tag}.sql`), '0007_tenant_ownership_contract.sql']);
    const snapshots = readdirSync(join(APP_MIGRATIONS, 'meta')).filter((f) => f.endsWith('_snapshot.json')).sort();
    expect(snapshots.at(-1)).toBe('0007_snapshot.json');
  });

  describe('one migrator run from a seeded 0005 state to 0007 (the production restore’s path): 0006’s backfill and 0007’s in one transaction', () => {
    let url = '';
    let drop: () => Promise<void> = async () => undefined;
    let run = { status: 0, output: '' };
    const D = randomUUID();
    const A = randomUUID();
    const B = randomUUID();
    const id = {
      bA: randomUUID(),
      bB: randomUUID(),
      eA: randomUUID(),
      eB: randomUUID(),
      cB: randomUUID(),
      opA: randomUUID(),
      uA: randomUUID(),
      uB: randomUUID(),
      uSplit: randomUUID(),
      uCross: randomUUID(), // access row names park group B, but a branch of A's (review 4a F4)
      uOp: randomUUID(), // an operator admin of A's operator whose access row is B's (F4)
    };
    /** Every row and where 0006's order, run inside the same transaction as 0007, must put it. */
    const activity: Record<string, { row: Record<string, string>; expected: string }> = {
      byBranch: { row: { branch_id: id.bB }, expected: B },
      byEmployee: { row: { employee_id: id.eA }, expected: A },
      byContract: { row: { contract_instance_id: id.cB }, expected: B },
      branchBeatsEmployee: { row: { branch_id: id.bA, employee_id: id.eB }, expected: A },
      byActor: { row: { created_by: id.uA }, expected: A },
      byActorInTwo: { row: { created_by: id.uSplit }, expected: D },
      byActorCrossBranch: { row: { created_by: id.uCross }, expected: D },
      byOperatorAdminAcross: { row: { created_by: id.uOp }, expected: D },
      byNothing: { row: {}, expected: D },
    };
    const attention: Record<string, { row: Record<string, string>; expected: string }> = {
      byBranch: { row: { branch_id: id.bA }, expected: A },
      byEmployee: { row: { employee_id: id.eB }, expected: B },
      byContract: { row: { contract_instance_id: id.cB }, expected: B },
      branchBeatsEmployee: { row: { branch_id: id.bB, employee_id: id.eA }, expected: B },
      byNothing: { row: {}, expected: D },
    };
    const rowIds = new Map<string, string>();
    const totals: Record<string, number> = {};

    beforeAll(async () => {
      ({ url, drop } = await databaseAt(5));
      await withClient(url, async (c) => {
        await c.query(`insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default'), ($2, 'ZZ RV A', 'zz-rv-a'), ($3, 'ZZ RV B', 'zz-rv-b')`, [D, A, B]);
        await insertRow(c, 'operators', { id: id.opA, tenant_id: A, name: 'ZZ RV operator A' });
        await insertRow(c, 'branches', { id: id.bA, tenant_id: A, name: 'ZZ RV A', address: 'x' });
        await insertRow(c, 'branches', { id: id.bB, tenant_id: B, name: 'ZZ RV B', address: 'x' });
        await insertRow(c, 'employees', { id: id.eA, tenant_id: A, branch_id: id.bA, full_name: 'ZZ RV A', nickname: 'ZZ', email: `zz-rv-a-${id.eA}@example.com` });
        await insertRow(c, 'employees', { id: id.eB, tenant_id: B, full_name: 'ZZ RV B', nickname: 'ZZ', email: `zz-rv-b-${id.eB}@example.com` });
        for (const user of [id.uA, id.uB, id.uSplit, id.uCross]) {
          await insertRow(c, 'users', { id: user, email: `zz-rv-${user}@example.com`, password: 'x', full_name: 'ZZ', role: 'admin' });
        }
        await insertRow(c, 'users', {
          id: id.uOp,
          email: `zz-rv-${id.uOp}@example.com`,
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
        await access(id.uB, B, null);
        await access(id.uSplit, A, null);
        await access(id.uSplit, B, null);
        await access(id.uCross, B, id.bA);
        await access(id.uOp, B, null);
        const template = randomUUID();
        await insertRow(c, 'templates', { id: template, name: 'ZZ RV template', html_body: '<p>zz</p>' });
        await insertRow(c, 'contract_instances', {
          id: id.cB,
          employee_id: id.eB,
          template_id: template,
          template_snapshot_html: '<p>zz</p>',
          template_snapshot_version: 1,
          merge_data_json: '{}',
          created_by: id.uB,
        });
        for (const [name, { row }] of Object.entries(activity)) {
          const rowId = randomUUID();
          rowIds.set(`activity:${name}`, rowId);
          await insertRow(c, 'activity_log', { id: rowId, activity_type: 'employee_updated', summary_text: `ZZ RV ${name}`, ...row });
        }
        for (const [name, { row }] of Object.entries(attention)) {
          const rowId = randomUUID();
          rowIds.set(`attention:${name}`, rowId);
          await insertRow(c, 'attention_items', { id: rowId, type: 'CONTRACT_NOT_SENT', title: `ZZ RV ${name}`, ...row });
        }
        await c.query(`insert into settings (key, value) values ('md_signatory_name', 'ZZ the one set'), ('zz_rv_key', 'x')`);
        for (const t of TABLES) totals[t] = Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
      });
      run = await deploy(url);
    }, 180_000);

    afterAll(async () => {
      await drop();
    });

    it('applies 0006 and 0007 in the one run', () => {
      expect(run.status, run.output).toBe(0);
      if (HAS_APP_MODULES) {
        expect(run.output).toContain('applied 0006_tenant_ownership_expand');
        expect(run.output).toContain('applied 0007_tenant_ownership_contract');
      }
    });

    it('every row lands where 0006’s order puts it — the branch before the employee, the strict placement’s edges to the default — none left, none mis-tenanted', async () => {
      const wrong: string[] = [];
      await withClient(url, async (c) => {
        for (const [table, set, prefix] of [
          ['activity_log', activity, 'activity'],
          ['attention_items', attention, 'attention'],
        ] as const) {
          const rows = new Map((await c.query<{ id: string; tenant_id: string }>(`select id, tenant_id from ${table}`)).rows.map((r) => [r.id, r.tenant_id]));
          for (const [name, { expected }] of Object.entries(set)) {
            if (rows.get(rowIds.get(`${prefix}:${name}`)!) !== expected) wrong.push(`${prefix}:${name} -> ${rows.get(rowIds.get(`${prefix}:${name}`)!)}`);
          }
        }
        expect((await c.query('select key, tenant_id from settings order by key')).rows).toEqual([
          { key: 'md_signatory_name', tenant_id: D },
          { key: 'zz_rv_key', tenant_id: D },
        ]);
        for (const t of TABLES) expect(Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n), t).toBe(totals[t]);
        expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(3);
      });
      expect(wrong).toEqual([]);
    });

    it('and the shape is 0007’s: NOT NULL on the three, the (tenant_id, key) unique alone, eight migrations recorded', async () => {
      const shape = await withClient(url, contracted);
      expect(shape).toEqual({ nullable: NOT_NULL, uniques: ['settings_pkey', 'settings_tenant_id_key_unique'], ledger: 8 });
    });

    it.skipIf(!HAS_APP_MODULES)('the read-back answers clean', () => {
      const out = readback(url);
      expect(out.status, out.output).toBe(0);
      expect(out.output).toMatch(/tenant_id NOT NULL \(round 4b, 0007\): activity_log yes, attention_items yes, settings yes/);
    });
  });

  it('a database whose ONLY park group is not slug “default”, 0005 to 0007 in one run: no “OTO Default” is minted, every row is that park group’s', async () => {
    const { url, drop } = await databaseAt(5);
    try {
      const O = randomUUID();
      await withClient(url, async (c) => {
        await c.query(`insert into tenants (id, name, slug) values ($1, 'ZZ The only park group', 'zz-only')`, [O]);
        await c.query(`insert into settings (key, value) values ('md_signatory_name', 'ZZ only MD')`);
        await insertRow(c, 'activity_log', { id: randomUUID(), activity_type: 'USER_CREATED', summary_text: 'ZZ about nothing' });
        await insertRow(c, 'attention_items', { id: randomUUID(), type: 'CONTRACT_NOT_SENT', title: 'ZZ about nothing' });
      });
      const out = await deploy(url);
      expect(out.status, out.output).toBe(0);
      await withClient(url, async (c) => {
        expect((await c.query('select id, slug from tenants')).rows).toEqual([{ id: O, slug: 'zz-only' }]);
        for (const t of TABLES) {
          expect((await c.query(`select distinct tenant_id from ${t}`)).rows, t).toEqual([{ tenant_id: O }]);
        }
        expect((await contracted(c)).nullable).toEqual(NOT_NULL);
      });
    } finally {
      await drop();
    }
  }, 180_000);

  it('the gate on two tables at once: refused loudly with both counts, nothing changed, the read-back naming them — and once the obstacle is gone the next deploy applies 0007 and places them', async () => {
    const { url, drop } = await databaseAt(6);
    try {
      const D = randomUUID();
      const stuckItem = randomUUID();
      await withClient(url, async (c) => {
        await c.query(`insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default')`, [D]);
        await insertRow(c, 'attention_items', { id: stuckItem, type: 'CONTRACT_NOT_SENT', title: 'ZZ RV stuck' });
        await insertRow(c, 'attention_items', { id: randomUUID(), type: 'CONTRACT_NOT_SENT', title: 'ZZ RV placed', tenant_id: D });
        await c.query(`insert into settings (key, value) values ('zz_rv_stuck_1', 'x'), ('zz_rv_stuck_2', 'y')`);
        // A second unforeseen obstacle (the builder's was a trigger on activity_log):
        // two tables whose rows will not take a park group.
        await c.query(`create function zz_rv_keep_null() returns trigger language plpgsql as $$
                         begin new.tenant_id := null; return new; end $$`);
        await c.query(`create trigger zz_rv_keep_null before update on attention_items
                         for each row when (new.title = 'ZZ RV stuck') execute function zz_rv_keep_null()`);
        await c.query(`create trigger zz_rv_keep_null before update on settings
                         for each row when (new.key like 'zz_rv_stuck_%') execute function zz_rv_keep_null()`);
      });
      const refused = await deploy(url);
      expect(refused.status, refused.output).not.toBe(0);
      expect(refused.output).toMatch(
        /tenant ownership \(0007\): 2 settings, 0 activity_log and 1 attention_items rows still have no park group after the backfill ran again, so tenant_id is not made NOT NULL and nothing was changed/,
      );
      expect(refused.output).toMatch(/npm run tenant:readback/);
      await withClient(url, async (c) => {
        expect(await contracted(c)).toEqual({ nullable: NULLABLE, uniques: ['settings_key_unique', 'settings_key_unique', 'settings_pkey', 'settings_tenant_id_key_unique'], ledger: 7 });
        expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(1);
        expect((await c.query('select count(*)::int as n from attention_items where tenant_id is null')).rows[0].n).toBe(1);
      });
      if (HAS_APP_MODULES) {
        const back = readback(url);
        expect(back.status, back.output).toBe(1);
        expect(back.output).toMatch(/3 rows have no park group/);
      }
      // The operator does what the words say, and deploys again.
      await withClient(url, async (c) => {
        await c.query('drop trigger zz_rv_keep_null on attention_items');
        await c.query('drop trigger zz_rv_keep_null on settings');
      });
      const again = await deploy(url);
      expect(again.status, again.output).toBe(0);
      await withClient(url, async (c) => {
        expect(await contracted(c)).toEqual({ nullable: NOT_NULL, uniques: ['settings_pkey', 'settings_tenant_id_key_unique'], ledger: 8 });
        expect((await c.query('select tenant_id from attention_items where id = $1', [stuckItem])).rows).toEqual([{ tenant_id: D }]);
        expect((await c.query(`select distinct tenant_id from settings`)).rows).toEqual([{ tenant_id: D }]);
      });
    } finally {
      await drop();
    }
  }, 180_000);

  /**
   * 0007 takes SHARE ROW EXCLUSIVE (writes wait, reads go on) and then, for
   * NOT NULL, ACCESS EXCLUSIVE. A transaction that has READ one of the three
   * tables and then writes it while the migration waits for the upgrade is a
   * deadlock: each waits for the other. Postgres aborts one. No code of the
   * release 0007 runs beside (round 4a) reads then writes these tables in one
   * transaction (its settings save, its activity insert and its Attention
   * pause are single statements), so on staging this is a person's psql
   * session at most. Either way: nothing half done, and the next run finishes.
   */
  it('a reader that then writes, open across 0007’s lock upgrade: Postgres breaks the deadlock, nothing is half done, and the next deploy completes', async () => {
    const { url, drop } = await databaseAt(6);
    const D = randomUUID();
    try {
      await withClient(url, (c) => c.query(`insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default')`, [D]));
      const reader = new pg.Client({ connectionString: url, application_name: 'zz-rv-reader' });
      const mig = new pg.Client({ connectionString: url, application_name: 'zz-rv-migrate' });
      const watch = new pg.Client({ connectionString: url, application_name: 'zz-rv-watch' });
      await Promise.all([reader.connect(), mig.connect(), watch.connect()]);
      // Set in callbacks, so held in an object the compiler does not narrow to null.
      const lost: { migration: { code?: string } | null; reader: { code?: string } | null } = { migration: null, reader: null };
      try {
        for (const c of [reader, mig]) await c.query('set search_path to otoapp');
        await reader.query('begin');
        await reader.query('select count(*) from settings');
        const migrating = migrate(drizzle(mig), { migrationsFolder: APP_MIGRATIONS, migrationsSchema: 'otoapp' }).catch((err: unknown) => {
          lost.migration = err as { code?: string };
        });
        const until = Date.now() + 60_000;
        while (Date.now() < until) {
          const r = await watch.query(`select 1 from pg_stat_activity where application_name = 'zz-rv-migrate' and wait_event_type = 'Lock'`);
          if (r.rowCount) break;
          await sleep(20);
        }
        await reader
          .query(`insert into settings (key, value, tenant_id) values ('zz_rv_reader', 'x', $1)`, [D])
          .catch((err: unknown) => {
            lost.reader = err as { code?: string };
          });
        if (lost.reader) await reader.query('rollback');
        else await reader.query('commit');
        await migrating;
      } finally {
        await Promise.all([reader, mig, watch].map((c) => c.end().catch(() => undefined)));
      }
      const victims = [lost.migration, lost.reader].filter((v): v is { code?: string } => v !== null);
      expect(victims.map((v) => v.code)).toEqual(['40P01']);
      if (lost.migration) {
        // The deploy failed, and left the database exactly as 0006 did.
        expect(await withClient(url, contracted)).toMatchObject({ nullable: NULLABLE, ledger: 7 });
      }
      const again = await deploy(url);
      expect(again.status, again.output).toBe(0);
      await withClient(url, async (c) => {
        expect(await contracted(c)).toEqual({ nullable: NOT_NULL, uniques: ['settings_pkey', 'settings_tenant_id_key_unique'], ledger: 8 });
        expect((await c.query(`select tenant_id from settings where key = 'zz_rv_reader'`)).rows).toEqual(lost.reader ? [] : [{ tenant_id: D }]);
      });
    } finally {
      await drop();
    }
  }, 180_000);
});

// =============================================================================
// The app over HTTP — the shared harness for B and C
// =============================================================================

const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill();
});

interface Harness {
  origin: string;
  /** The real instant at which the app's fake clock read HARNESS_FAKE_NOW (only when one was given). */
  fakeSeenAt: number | null;
}

async function serve(databaseUrl: string, env: Record<string, string> = {}): Promise<Harness> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    APP_ENV: 'dev',
    STORAGE_ENV_PREFIX: 'zz-r4b-review',
    OBJECT_STORAGE: 'local',
    OTOAPP_LEGACY_LOGIN: 'true',
    LOG_LEVEL: 'warn',
    TZ: 'UTC',
    DEPLOY_ENV: 'local',
    OTOAPP_JOBS: 'platform',
    DIRECTORY_API_RATE_LIMIT_MAX_REQUESTS: '100000',
    DATABASE_URL: databaseUrl,
    ...env,
  };
  delete childEnv.HR_DIRECTORY_API_KEY;
  if (!env.HARNESS_FAKE_NOW) delete childEnv.HARNESS_FAKE_NOW;
  const child = spawn(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: APP_DIR,
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  let fakeSeenAt: number | null = null;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (fakeSeenAt === null && /HARNESS_FAKE_NOW=/.test(output)) fakeSeenAt = Date.now();
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve({ origin: `http://127.0.0.1:${m[1]}`, fakeSeenAt });
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

type Q = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

interface ParkGroup {
  label: string;
  tenant: string;
  branch: string;
  otherBranch: string;
  department: string;
  /** Active, ten days on the books, no contract, department, role or login: several rules fire. */
  employee: string;
  /** The same, seated on no branch: its items are about no branch. */
  branchless: string;
  adminEmail: string;
  limitedEmail: string;
  key: string;
  cookie: string;
  limitedCookie: string;
}

async function makeParkGroup(q: Q, label: string, run: string, slug?: string, tenantId?: string): Promise<Omit<ParkGroup, 'cookie' | 'limitedCookie'>> {
  const tenant = tenantId ?? randomUUID();
  await q('insert into tenants (id, name, slug) values ($1, $2, $3)', [tenant, `ZZ RV ${label} ${run}`, slug ?? `zz-rv-${label}-${run}`]);
  const branch = randomUUID();
  const otherBranch = randomUUID();
  for (const [b, suffix] of [
    [branch, 'one'],
    [otherBranch, 'two'],
  ] as const) {
    await q('insert into branches (id, tenant_id, name, address) values ($1, $2, $3, $4)', [b, tenant, `ZZ RV ${label} ${suffix} ${run}`, 'x']);
  }
  const department = randomUUID();
  await q('insert into departments (id, tenant_id, name) values ($1, $2, $3)', [department, tenant, `ZZ RV ${label} dept ${run}`]);
  const employee = async (b: string | null, what: string) => {
    const e = randomUUID();
    await q(
      `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, created_at)
       values ($1, $2, $3, $4, 'ZZ', $5, 'active', now() - interval '10 days')`,
      [e, tenant, b, `ZZ RV ${run} ${label} ${what}`, `zz-rv-${label}-${what}-${e.slice(0, 8)}@example.com`],
    );
    return e;
  };
  const user = async (role: string, email: string, b: string | null) => {
    const u = randomUUID();
    await q(
      `insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, $3, 'ZZ RV', $4, true, false)`,
      [u, email, hashPassword(PASSWORD), role],
    );
    await q('insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)', [
      tenant,
      u,
      b,
      b ? 'selected_branches' : 'all_branches',
    ]);
  };
  const adminEmail = `zz-rv-${label}-admin-${run}@example.com`;
  const limitedEmail = `zz-rv-${label}-limited-${run}@example.com`;
  await user('admin', adminEmail, null);
  await user('manager', limitedEmail, branch);
  const key = 'odk_' + randomBytes(32).toString('base64url');
  await q('insert into directory_clients (tenant_id, name, key_hash, scopes) values ($1, $2, $3, $4)', [
    tenant,
    `ZZ RV ${run}`,
    createHash('sha256').update(key).digest('hex'),
    ['jobs:run'],
  ]);
  return {
    label,
    tenant,
    branch,
    otherBranch,
    department,
    employee: await employee(branch, 'staff'),
    branchless: await employee(null, 'unseated'),
    adminEmail,
    limitedEmail,
    key,
  };
}

const runJob = (origin: string, name: string, g: { key: string; tenant: string }) =>
  call(origin, 'POST', `/api/directory/jobs/${name}/run`, { body: { tenantId: g.tenant }, headers: { authorization: `Bearer ${g.key}` } }) as Promise<
    Answer & { body: NightJobAnswer & Record<string, unknown> }
  >;

/** A shift today (Bangkok) from 00:00 for one employee: past its 30-minute grace from 00:30. */
async function scheduled(q: Q, g: { tenant: string; branch: string }, employee: string, date: string, run: string): Promise<void> {
  const plan = randomUUID();
  await q('insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)', [plan, g.tenant, g.branch, date]);
  const group = randomUUID();
  await q('insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)', [group, g.tenant, g.branch, `ZZ RV ${run}`]);
  const row = randomUUID();
  await q(
    `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time)
     values ($1, $2, $3, $4, $5, '00:00', '08:00')`,
    [row, g.tenant, g.branch, group, plan],
  );
  await q(
    `insert into schedule_assignments (tenant_id, week_plan_id, shift_row_id, shift_date, employee_id) values ($1, $2, $3, $4, $5)`,
    [g.tenant, plan, row, date, employee],
  );
}

describe.skipIf(!HAS_APP_RUNTIME)('B and C. over HTTP against the app’s routes', () => {
  let url = '';
  let drop: () => Promise<void> = async () => undefined;
  let pool: pg.Pool;
  let origin = '';
  const run = randomBytes(3).toString('hex');
  const K = (name: string) => `zz_rv_${run}_${name}`;
  let PD: ParkGroup; // the default park group (slug `default`)
  let PB: ParkGroup;
  let PC: ParkGroup; // a third, which never saves and is never run
  const q: Q = async (text, params = []) => (await pool.query(text, params)).rows;
  const rowsFor = (key: string) =>
    q<{ tenant_id: string; value: string }>('select tenant_id, value from settings where key = $1 order by tenant_id', [key]);
  const save = (who: ParkGroup, body: Array<{ key: string; value: string | null }>) =>
    call(origin, 'POST', '/api/settings', { cookie: who.cookie, body });
  const readAs = async (who: ParkGroup) => {
    const res = await call(origin, 'GET', '/api/settings', { cookie: who.cookie });
    expect(res.status, res.text).toBe(200);
    return new Map((res.body as Array<{ key: string; value: string }>).map((s) => [s.key, s.value]));
  };

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase({ otoapp: true }));
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 6 });
    const d = await makeParkGroup(q, 'd', run, 'default');
    const b = await makeParkGroup(q, 'b', run);
    const c = await makeParkGroup(q, 'c', run);
    await q(`insert into settings (key, value, tenant_id) values ('md_signatory_name', 'ZZ D MD', $1)`, [d.tenant]);
    ({ origin } = await serve(url));
    PD = { ...d, cookie: await appSignIn(origin, d.adminEmail), limitedCookie: await appSignIn(origin, d.limitedEmail) };
    PB = { ...b, cookie: await appSignIn(origin, b.adminEmail), limitedCookie: await appSignIn(origin, b.limitedEmail) };
    PC = { ...c, cookie: await appSignIn(origin, c.adminEmail), limitedCookie: await appSignIn(origin, c.limitedEmail) };
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await drop();
  });

  // ── B. The opened settings writes ───────────────────────────────────────────

  it('B1. every settings door saves B’s OWN row beside the default’s — no 4a-era 409 anywhere — and C, with none of its own, still reads the default’s (Q28)', async () => {
    const statuses: Record<string, number> = {};
    const s1 = await save(PB, [{ key: 'md_signatory_name', value: 'ZZ B MD' }]);
    statuses['POST /api/settings (a key the default holds)'] = s1.status;
    const s2 = await save(PB, [{ key: K('b_new'), value: 'B new' }]);
    statuses['POST /api/settings (a new key)'] = s2.status;
    const fix = await call(origin, 'POST', '/api/settings/fix-department', { cookie: PB.cookie, body: { departmentId: PB.department } });
    statuses['POST /api/settings/fix-department'] = fix.status;
    const rules = await call(origin, 'PUT', '/api/attention-rules/config', { cookie: PB.cookie, body: { openShiftHoursThreshold: 24 } });
    statuses['PUT /api/attention-rules/config'] = rules.status;
    const da = await call(origin, 'POST', '/api/data-admin/settings', { cookie: PB.cookie, body: { key: K('b_da'), value: 'B via Data Admin', tenantId: PB.tenant } });
    statuses['POST /api/data-admin/settings'] = da.status;
    const daEdit = await call(origin, 'PUT', `/api/data-admin/settings/${da.body.id}`, { cookie: PB.cookie, body: { value: 'B edited' } });
    statuses['PUT /api/data-admin/settings/:id'] = daEdit.status;
    expect(statuses).toEqual({
      'POST /api/settings (a key the default holds)': 200,
      'POST /api/settings (a new key)': 200,
      'POST /api/settings/fix-department': 200,
      'PUT /api/attention-rules/config': 200,
      'POST /api/data-admin/settings': 201,
      'PUT /api/data-admin/settings/:id': 200,
    });
    expect(await rowsFor('md_signatory_name')).toEqual(
      [
        { tenant_id: PB.tenant, value: 'ZZ B MD' },
        { tenant_id: PD.tenant, value: 'ZZ D MD' },
      ].sort((x, y) => x.tenant_id.localeCompare(y.tenant_id)),
    );
    const [d, b, c] = [await readAs(PD), await readAs(PB), await readAs(PC)];
    expect([d.get('md_signatory_name'), b.get('md_signatory_name'), c.get('md_signatory_name')]).toEqual(['ZZ D MD', 'ZZ B MD', 'ZZ D MD']);
    expect([d.has(K('b_new')), c.has(K('b_new')), b.get(K('b_new'))]).toEqual([false, false, 'B new']);
    // The rules screen: B its own, D and C the default's (the built-in where the default has none).
    const rulesOf = async (who: ParkGroup) => (await call(origin, 'GET', '/api/attention-rules/config', { cookie: who.cookie })).body.openShiftHoursThreshold;
    expect([await rulesOf(PB), await rulesOf(PD), await rulesOf(PC)]).toEqual([24, 72, 72]);
    // 4a's refusal is named nowhere the app answers from.
    const shared = readdirSync(APP_SERVER, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /settings_shared/.test(readFileSync(join(APP_SERVER, f), 'utf8')));
    expect(shared).toEqual([]);
    await q('delete from settings where tenant_id = $1', [PB.tenant]);
  });

  it('B2. a save of several keys that UPDATES an existing key and adds one before a key that fails is rolled back whole: the old value stands, nothing new is written', async () => {
    const first = await save(PB, [{ key: K('kept'), value: 'before' }]);
    expect(first.status, first.text).toBe(200);
    const res = await save(PB, [
      { key: K('kept'), value: 'after' },
      { key: K('fresh'), value: 'fresh' },
      { key: K('zz_breaks'), value: null }, // value is NOT NULL: this key fails
    ]);
    expect(res.status, res.text).toBeGreaterThanOrEqual(400);
    expect(await rowsFor(K('kept'))).toEqual([{ tenant_id: PB.tenant, value: 'before' }]);
    expect(await rowsFor(K('fresh'))).toEqual([]);
    // The same order the other way round (the failing key sorted first): the same.
    const res2 = await save(PB, [
      { key: K('aa_breaks'), value: null },
      { key: K('kept'), value: 'after' },
    ]);
    expect(res2.status, res2.text).toBeGreaterThanOrEqual(400);
    expect(await rowsFor(K('kept'))).toEqual([{ tenant_id: PB.tenant, value: 'before' }]);
    await q('delete from settings where tenant_id = $1', [PB.tenant]);
  });

  it('B3. eight racing multi-key saves from one park group in opposite key orders, beside the default park group’s own: every answer 200, one row per key per park group, no deadlock', async () => {
    const keys = ['w', 'x', 'y', 'z'].map((k) => K(`race_${k}`));
    const forwards = keys.map((key, i) => ({ key, value: `fwd ${i}` }));
    const backwards = [...keys].reverse().map((key, i) => ({ key, value: `bwd ${i}` }));
    const answers = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => save(PB, i % 2 ? backwards : forwards)),
      ...Array.from({ length: 3 }, () => save(PD, forwards)),
    ]);
    expect(answers.map((a) => a.status)).toEqual(Array(11).fill(200));
    for (const key of keys) {
      const rows = await rowsFor(key);
      expect(rows.map((r) => r.tenant_id).sort(), key).toEqual([PB.tenant, PD.tenant].sort());
    }
    // Answered in the order asked, whatever order they were written in.
    expect((answers[1]!.body as Array<{ key: string }>).map((s) => s.key)).toEqual([...keys].reverse());
    await q('delete from settings where key = any($1)', [keys]);
  });

  it('B4. as built (Q36): any park group’s admin moves the DEFAULT park group’s MD signatory row to its own park group with a 200, and the default then reads none — as Data Admin’s DELETE could already remove it', async () => {
    const [row] = await q<{ id: string }>(`select id from settings where key = 'md_signatory_name' and tenant_id = $1`, [PD.tenant]);
    const moved = await call(origin, 'PUT', `/api/data-admin/settings/${row!.id}`, { cookie: PB.cookie, body: { tenantId: PB.tenant } });
    try {
      expect(moved.status, moved.text).toBe(200);
      expect(await rowsFor('md_signatory_name')).toEqual([{ tenant_id: PB.tenant, value: 'ZZ D MD' }]);
      expect((await readAs(PD)).has('md_signatory_name')).toBe(false);
      expect((await readAs(PC)).has('md_signatory_name')).toBe(false);
    } finally {
      await q(`update settings set tenant_id = $1 where id = $2`, [PD.tenant, row!.id]);
    }
  });

  /**
   * FINDING 3 (low). Lifting Data Admin's 4a hold also lifted its refusal of a
   * move between park groups (B4). Prescribed fix: refuse a Data Admin
   * settings update that changes the row's park group, in words, or name the
   * move in Q36. This pin passes on either.
   */
  it.fails('FINDING 3: Data Admin does not move a settings row between park groups unnamed — refused, or named in Q36', async () => {
    const [row] = await q<{ id: string }>(`select id from settings where key = 'md_signatory_name' and tenant_id = $1`, [PD.tenant]);
    const moved = await call(origin, 'PUT', `/api/data-admin/settings/${row!.id}`, { cookie: PB.cookie, body: { tenantId: PB.tenant } });
    await q(`update settings set tenant_id = $1 where id = $2`, [PD.tenant, row!.id]);
    const refused = moved.status >= 400 && moved.status < 500;
    const named = /mov(e|ed|es|ing)[^.]*(another|other|one park group to)|re-?home/i.test(question(36).replace(/moved to no park group/gi, ''));
    expect(refused || named).toBe(true);
  });

  // ── C. Attention ────────────────────────────────────────────────────────────

  const itemsOf = (tenant: string) =>
    q<{ id: string; tenant_id: string; branch_id: string | null; employee_id: string | null; rule_key: string; status: string; created_at: Date }>(
      `select id, tenant_id, branch_id, employee_id, rule_key, status, created_at from attention_items where tenant_id = $1 order by rule_key, id`,
      [tenant],
    );
  const stale = new Map<string, string[]>();

  it('C1. the engine through the job endpoint: its counts are the database’s, rule by rule; it resolves exactly the stale items of its own park group; the park group it was not asked for is untouched; a second run raises nothing (the first run’s burst is honest)', async () => {
    // Saved alerts no rule raises any more: three of D's, one of B's.
    for (const [g, n] of [
      [PD, 3],
      [PB, 1],
    ] as const) {
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const itemId = randomUUID();
        await q(
          `insert into attention_items (id, tenant_id, branch_id, type, severity, title, rule_key, entity_key)
           values ($1, $2, $3, 'CONTRACT_NOT_SENT', 'medium', 'ZZ RV stale', 'CONTRACT_NOT_SENT', $4)`,
          [itemId, g.tenant, g.branch, `contract:${randomUUID()}`],
        );
        ids.push(itemId);
      }
      stale.set(g.tenant, ids);
    }
    const before = new Date((await q<{ now: Date }>('select now()::timestamp as now'))[0]!.now);
    const d = await runJob(origin, 'attention', PD);
    expect(d.status, d.text).toBe(200);
    expect(d.body.steps.map((s: { step: string; ok: boolean }) => [s.step, s.ok])).toEqual([['attentionReconciliation', true]]);
    const counts = d.body.steps[0]!.counts as Record<string, number>;
    const dItems = await itemsOf(PD.tenant);
    const made = dItems.filter((i) => new Date(i.created_at) >= before && !stale.get(PD.tenant)!.includes(i.id));
    const byRule: Record<string, number> = {};
    for (const i of made) byRule[i.rule_key] = (byRule[i.rule_key] ?? 0) + 1;
    expect(counts.created).toBe(made.length);
    expect(made.length).toBeGreaterThanOrEqual(6);
    expect(Object.fromEntries(Object.entries(counts).filter(([k]) => k.startsWith('created.')).map(([k, n]) => [k.slice(8), n]))).toEqual(byRule);
    expect(counts.resolved).toBe(3);
    expect(dItems.filter((i) => stale.get(PD.tenant)!.includes(i.id)).map((i) => i.status)).toEqual(['resolved', 'resolved', 'resolved']);
    // Every item it made is about one of D's own employees, in D.
    expect(new Set(made.map((i) => i.employee_id))).toEqual(new Set([PD.employee, PD.branchless]));
    // B's stale item, and B and C, untouched by D's run.
    expect((await itemsOf(PB.tenant)).map((i) => [i.id, i.status])).toEqual([[stale.get(PB.tenant)![0], 'open']]);
    expect(await itemsOf(PC.tenant)).toEqual([]);
    const b = await runJob(origin, 'attention', PB);
    expect(b.status, b.text).toBe(200);
    expect(b.body.steps[0]!.counts.resolved).toBe(1);
    expect(b.body.steps[0]!.counts.created).toBe((await itemsOf(PB.tenant)).length - 1);
    expect(await itemsOf(PC.tenant)).toEqual([]);
    // H20: a second run raises nothing, resolves nothing.
    const again = await runJob(origin, 'attention', PD);
    expect(again.body.steps[0]!.counts).toMatchObject({ created: 0, resolved: 0 });
    expect((await itemsOf(PD.tenant)).length).toBe(dItems.length);
  }, 120_000);

  it('C2. isolation: D’s readers never reach B’s items — list, counts, resolve, snooze, check-condition, diagnostics — and B’s item is unchanged after every attempt', async () => {
    const bItems = (await itemsOf(PB.tenant)).filter((i) => i.status === 'open');
    expect(bItems.length).toBeGreaterThan(0);
    const target = bItems[0]!;
    const listed = await call(origin, 'GET', '/api/attention-items?limit=1000', { cookie: PD.cookie });
    expect(listed.status, listed.text).toBe(200);
    const listedIds = new Set((listed.body.items as Array<{ id: string; tenantId: string }>).map((i) => i.id));
    for (const i of bItems) expect(listedIds.has(i.id), i.id).toBe(false);
    expect(new Set((listed.body.items as Array<{ tenantId: string }>).map((i) => i.tenantId))).toEqual(new Set([PD.tenant]));
    const dOpen = (await itemsOf(PD.tenant)).filter((i) => i.status === 'open');
    const counts = await call(origin, 'GET', '/api/attention-items/counts', { cookie: PD.cookie });
    expect(counts.body.total).toBe(dOpen.length);
    for (const [method, path, body] of [
      ['POST', `/api/attention-items/${target.id}/resolve`, { permanent: true }],
      ['POST', `/api/attention-items/${target.id}/resolve`, { permanent: false }],
      ['GET', `/api/attention-items/${target.id}/check-condition`, undefined],
      ['GET', `/api/attention-items/diagnostics/${PB.employee}`, undefined],
      ['GET', `/api/attention-items?branchId=${PB.branch}`, undefined],
    ] as const) {
      const res = await call(origin, method, path, { cookie: PD.cookie, body });
      expect(res.status, `${method} ${path}: ${res.text}`).toBe(404);
    }
    expect((await q<{ status: string; suppress_until: Date | null }>('select status, suppress_until from attention_items where id = $1', [target.id]))[0]).toEqual({
      status: 'open',
      suppress_until: null,
    });
    // D's branch-limited manager: its branch only, nothing about no branch, none of B's.
    const limited = await call(origin, 'GET', '/api/attention-items?limit=1000', { cookie: PD.limitedCookie });
    expect(limited.status, limited.text).toBe(200);
    expect(new Set((limited.body.items as Array<{ branchId: string | null }>).map((i) => i.branchId))).toEqual(new Set([PD.branch]));
  });

  it('C3. each park group’s Refresh is its own: D’s leaves B’s open items open, B’s leaves D’s; snooze then holds D’s item through D’s next Refresh', async () => {
    const openOf = async (tenant: string) => (await itemsOf(tenant)).filter((i) => i.status === 'open').map((i) => i.id);
    const bOpen = await openOf(PB.tenant);
    const dOpen = await openOf(PD.tenant);
    // The employees' park groups change nothing that would raise or resolve.
    const d = await call(origin, 'POST', '/api/attention-items/refresh', { cookie: PD.cookie });
    expect(d.status, d.text).toBe(200);
    expect(await openOf(PB.tenant)).toEqual(bOpen);
    const b = await call(origin, 'POST', '/api/attention-items/refresh', { cookie: PB.cookie });
    expect(b.status, b.text).toBe(200);
    expect(await openOf(PD.tenant)).toEqual(dOpen);
    const snoozed = dOpen[0]!;
    const snooze = await call(origin, 'POST', `/api/attention-items/${snoozed}/resolve`, { cookie: PD.cookie, body: { permanent: false } });
    expect(snooze.status, snooze.text).toBe(200);
    expect((await call(origin, 'POST', '/api/attention-items/refresh', { cookie: PD.cookie })).status).toBe(200);
    expect((await q<{ status: string }>('select status from attention_items where id = $1', [snoozed]))[0]!.status).toBe('resolved');
  });

  it('C4. Refresh beside a held run: D refused in words (409) while B’s Refresh runs at the same moment; D runs once the hold is let go', async () => {
    const holder = new pg.Client({ connectionString: url, application_name: 'zz-rv-holder' });
    await holder.connect();
    try {
      const { rows } = await holder.query<{ locked: boolean }>('select pg_try_advisory_lock($1::int4, hashtext($2)) as locked', [
        0x0712,
        `otoapp_night:attention:${PD.tenant}`,
      ]);
      expect(rows[0]!.locked).toBe(true);
      const [d, b] = await Promise.all([
        call(origin, 'POST', '/api/attention-items/refresh', { cookie: PD.cookie }),
        call(origin, 'POST', '/api/attention-items/refresh', { cookie: PB.cookie }),
      ]);
      expect(d.status, d.text).toBe(409);
      expect(d.body).toEqual({
        reason: 'attention_running',
        message: 'Attention is already being checked for this park group. Try Refresh again in a minute.',
      });
      expect(b.status, b.text).toBe(200);
      // The platform's run for D is held off the same way.
      const job = await runJob(origin, 'attention', PD);
      expect(job.status, job.text).toBe(409);
    } finally {
      await holder.end();
    }
    expect((await call(origin, 'POST', '/api/attention-items/refresh', { cookie: PD.cookie })).status).toBe(200);
  });

  /**
   * The no-show check's hours on the APP's own clock, at the edges. Three
   * servers whose clocks start 75 seconds before 07:00, 22:00 and 00:00
   * Bangkok and run on; each is asked once before the edge and once after it.
   */
  it('C5. the no-show check at its edges on the app’s own clock: out at 06:59, in from 07:00; in at 21:59, out from 22:00; out on both sides of midnight', async () => {
    interface Edge {
      name: string;
      date: string;
      edge: string; // the Bangkok instant the clock crosses
      before: 0 | 1; // outsideHours before the edge
      after: 0 | 1; // and after it
    }
    const edges: Edge[] = [
      { name: 'morning', date: '2026-11-02', edge: '2026-11-02T07:00:00+07:00', before: 1, after: 0 },
      { name: 'evening', date: '2026-11-03', edge: '2026-11-03T22:00:00+07:00', before: 0, after: 1 },
      { name: 'midnight', date: '2026-11-04', edge: '2026-11-05T00:00:00+07:00', before: 1, after: 1 },
    ];
    const LEAD_MS = 75_000;
    const results = await Promise.all(
      edges.map(async (e) => {
        const g = await makeParkGroup(q, `ns-${e.name}`, run);
        await scheduled(q, g, g.employee, e.date, run);
        const edgeAt = new Date(e.edge).getTime();
        const h = await serve(url, { HARNESS_FAKE_NOW: new Date(edgeAt - LEAD_MS).toISOString() });
        expect(h.fakeSeenAt, e.name).not.toBeNull();
        const appNow = () => edgeAt - LEAD_MS + (Date.now() - h.fakeSeenAt!);
        expect(appNow(), `${e.name}: the harness booted too slowly to ask before the edge`).toBeLessThan(edgeAt - 3_000);
        const first = await runJob(h.origin, 'no_show', g);
        const firstAt = appNow();
        await sleep(Math.max(0, edgeAt + 2_000 - appNow()));
        const second = await runJob(h.origin, 'no_show', g);
        const items = await q<{ tenant_id: string; status: string }>(
          `select tenant_id, status from attention_items where rule_key = 'SCHEDULED_NO_SHOW_ALERT' and employee_id = $1`,
          [g.employee],
        );
        return { e, g, first, second, firstAt, items };
      }),
    );
    for (const { e, g, first, second, firstAt, items } of results) {
      expect(first.status, `${e.name}: ${first.text}`).toBe(200);
      expect(second.status, `${e.name}: ${second.text}`).toBe(200);
      expect(firstAt, e.name).toBeLessThan(new Date(e.edge).getTime());
      expect(first.body.steps[0]!.counts.outsideHours, `${e.name} before`).toBe(e.before);
      expect(second.body.steps[0]!.counts.outsideHours, `${e.name} after`).toBe(e.after);
      // An alert only from a check inside the hours, in the park group of the assignment.
      const raisedBy = [e.before, e.after].filter((o) => o === 0).length;
      expect(items.map((i) => [i.tenant_id, i.status]), e.name).toEqual(raisedBy ? [[g.tenant, 'open']] : []);
    }
  }, 300_000);
});

// =============================================================================
// C. Attention, read off the code
// =============================================================================

const appSources = (): Array<{ rel: string; text: string }> => {
  const out: Array<{ rel: string; text: string }> = [];
  for (const root of ['server', 'script', 'shared']) {
    for (const f of readdirSync(join(APP_DIR, root), { recursive: true }).map(String)) {
      const path = join(APP_DIR, root, f);
      if (!/\.(ts|mts|mjs|js)$/.test(f) || f.includes('node_modules') || !statSync(path).isFile()) continue;
      out.push({ rel: `${root}/${f.replace(/\\/g, '/')}`, text: readFileSync(path, 'utf8') });
    }
  }
  return out;
};

/** A call's argument text, from its opening parenthesis to the matching close. */
function argumentsAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced call');
}

describe('C. Attention, read off the code', () => {
  it('every Attention writer in the app’s whole tree names the park group of the row it is about: nine creates, eight upserts, seventeen in all', () => {
    const found: string[] = [];
    for (const { rel, text } of appSources()) {
      for (const m of text.matchAll(/\bstorage\.(createAttentionItem|upsertAttentionItem)\(/g)) {
        const args = argumentsAt(text, m.index! + m[0].length - 1);
        // `tenantId: <expression>`, or the shorthand `tenantId` (a local of that name).
        const named = /\btenantId:\s*([A-Za-z_][\w.]*)/.exec(args)?.[1] ?? (/[{,]\s*tenantId\s*[,}]/.test(args) ? 'tenantId' : 'NONE');
        found.push(`${rel} ${m[1]} ${named}`);
      }
    }
    expect(found.sort()).toEqual(
      [
        // The routes: the employee, or the checklist run, the alert is about.
        'server/routes.ts createAttentionItem employee.tenantId',
        'server/routes.ts createAttentionItem employee.tenantId',
        'server/routes.ts createAttentionItem employee.tenantId',
        'server/routes.ts createAttentionItem employee.tenantId',
        'server/routes.ts createAttentionItem employee.tenantId',
        'server/routes.ts createAttentionItem currentRun.tenantId',
        'server/routes.ts createAttentionItem currentRun2.tenantId',
        // The night batches: the presence row, the time event, the assignment.
        'server/scheduled-jobs.ts createAttentionItem presence.tenantId',
        'server/scheduled-jobs.ts createAttentionItem row.tenant_id',
        'server/scheduled-jobs.ts upsertAttentionItem assignment.tenantId',
        // The engine: the employee evaluated, or the park group the scheduling run is for.
        'server/attention-engine.ts upsertAttentionItem tenantId',
        'server/attention-engine.ts upsertAttentionItem tenantId',
        'server/attention-engine.ts upsertAttentionItem employee.tenantId',
        'server/attention-engine.ts upsertAttentionItem employee.tenantId',
        'server/attention-engine.ts upsertAttentionItem tenantId',
        'server/attention-engine.ts upsertAttentionItem tenantId',
        'server/attention-engine.ts upsertAttentionItem tenantId',
      ].sort(),
    );
    // The engine's bare `tenantId` is the evaluated employee's, or the scheduling run's park group.
    const engine = readFileSync(join(APP_SERVER, 'attention-engine.ts'), 'utf8');
    expect(engine.match(/const tenantId = employee\.tenantId;/g)).toHaveLength(2);
    expect(engine).toMatch(/const tenantId = opts\.tenantId;/);
    // The scheduling rules read that park group's own rules, the default's where it has none (Q28).
    expect(engine).toMatch(/const config = await getAttentionConfig\(tenantId\);/);
    expect(engine).toMatch(/const setting = await storage\.getSetting\("attention_rules_config", tenantId\);/);
    // Nothing writes the table but storage and the dev seed, and the column cannot be left out.
    const writers = appSources()
      .filter(({ text }) => /\.insert\(attentionItems\)|insert into "?attention_items/i.test(text))
      .map(({ rel }) => rel)
      .sort();
    expect(writers).toEqual(['script/full/main.ts', 'server/storage.ts']);
    expect(readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8')).toMatch(/tenantId: uuid\("tenant_id"\)\.references\(\(\) => tenants\.id\)\.notNull\(\),\n\}, \(table\) => \[\n {2}index\("idx_attention_items_tenant"\)/);
  });

  const duplicateFaceBlock = () => {
    const routes = readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8');
    const start = routes.indexOf('if (enrollResult.duplicateMatch) {');
    expect(start).toBeGreaterThan(0);
    const end = routes.indexOf('"face_duplicate_detected"', start);
    expect(end).toBeGreaterThan(start);
    return routes.slice(start, end);
  };

  it('as built: the duplicate-face alert is raised in the enrolling employee’s park group, with the name and id of the matched employee looked up in every park group, from one face collection (finding 1’s arrangement)', () => {
    const block = duplicateFaceBlock();
    expect(block).toMatch(/tenantId: employee\.tenantId,/);
    expect(block).toMatch(/await storage\.getEmployee\(matchedEmployeeId\)/);
    expect(block).toMatch(/to the face already enrolled for \$\{conflictingName\} \(ID: \$\{matchedEmployeeId\}\)/);
    const face = readFileSync(join(APP_SERVER, 'face-recognition.ts'), 'utf8');
    expect(face).toMatch(/this\.collectionId = process\.env\.AWS_REKOGNITION_COLLECTION_ID \|\| "oto-hr-faces";/);
    expect(face).not.toMatch(/collectionId[^;\n]*tenant/i);
    expect(readFileSync(join(APP_SERVER, 'attention-availability.ts'), 'utf8')).toMatch(/export const ATTENTION_WRITES_READY = true;/);
  });

  /**
   * FINDING 1 (low). See the header. Prescribed fix: hold the matched
   * employee's lookup to the enrolling employee's park group, and say "an
   * employee of another park group" (no name, no id) otherwise.
   */
  it.fails('FINDING 1: the duplicate-face alert names no employee of another park group', () => {
    const block = duplicateFaceBlock();
    expect(block).toMatch(/conflictingEmployee\??\.tenantId\s*[!=]==?\s*employee\.tenantId|eq\(employees\.tenantId,\s*employee\.tenantId\)/);
  });

  const refreshOnError = () => {
    const page = readFileSync(join(APP_DIR, 'client', 'src', 'pages', 'attention-page.tsx'), 'utf8');
    const start = page.indexOf('const refreshMutation = useMutation({');
    expect(start).toBeGreaterThan(0);
    return page.slice(start, page.indexOf('const resolveMutation', start));
  };

  it('as built: the server answers a Refresh beside a run with Q35’s words, and the page’s Refresh shows its own fixed words whatever the answer (finding 2’s arrangement)', () => {
    const words = readFileSync(join(APP_SERVER, 'lib', 'nightJobs.ts'), 'utf8');
    expect(words).toMatch(/message: "Attention is already being checked for this park group\. Try Refresh again in a minute\.",/);
    expect(plan().replace(/\s+/g, ' ')).toMatch(
      /A Refresh beside the engine's run is refused in words\*\* \(Q35\): "Attention is already being checked for this park group\. Try Refresh again in a minute\."/,
    );
    const block = refreshOnError();
    expect(block).toMatch(/onError: \(\) => \{\s*toast\(\{\s*title: "Refresh failed",\s*description: "Could not refresh attention items",/);
  });

  /**
   * FINDING 2 (low). See the header. Prescribed fix: the page shows the
   * answer's message when there is one, or the plan says what the page shows.
   */
  it.fails('FINDING 2: the manager who presses Refresh during a run is told Q35’s words (or the plan says what they are told)', () => {
    const block = refreshOnError();
    const pageSaysIt = /onError: \((error|err|e)[^)]*\)/.test(block) && /message/.test(block.slice(block.indexOf('onError')));
    const planSaysWhatThePageShows = /Could not refresh attention items/.test(question(35));
    expect(pageSaysIt || planSaysWhatThePageShows).toBe(true);
  });
});

// =============================================================================
// D. The platform's two jobs: the fence at the millisecond, Run now beside a run
// =============================================================================

class Stub {
  calls: Array<{ job: string; tenantId: string }> = [];
  hold: Promise<void> | null = null;
  private server: Server | null = null;
  origin = '';
  constructor(private readonly keys: Record<string, string>) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const m = /^\/api\/directory\/jobs\/([a-z_]+)\/run$/.exec(req.url ?? '');
    const tenantId = ((raw ? JSON.parse(raw) : {}) as { tenantId?: string }).tenantId ?? '';
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!m || req.headers.authorization !== `Bearer ${this.keys[tenantId]}`) return send(403, { error: 'forbidden', message: 'no' });
    this.calls.push({ job: m[1]!, tenantId });
    if (this.hold) await this.hold;
    const now = new Date().toISOString();
    const step: { step: string; counts: Record<string, number> } =
      m[1] === 'no_show'
        ? { step: 'noShowCheck', counts: { created: 0, resolved: 0, outsideHours: 0 } }
        : { step: 'attentionReconciliation', counts: { created: 0, updated: 0, resolved: 0, errors: 0 } };
    const answer: NightJobAnswer = {
      job: m[1] as OtoAppNightJob,
      tenantId,
      ok: true,
      startedAt: now,
      finishedAt: now,
      steps: [{ ...step, ok: true, onFailure: 'continue' }],
    };
    send(200, answer);
  }
}

describe('D. the platform’s two jobs: the no-show fence at the millisecond, and Run now beside a held Attention run', () => {
  const tenant = randomUUID();
  const key = `odk_${randomBytes(32).toString('base64url')}`;
  const stub = new Stub({ [tenant]: key });
  let ctx: TestContext;
  let db: Db;
  let admin = '';

  const envFor = (): Env =>
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
      PROCESS_ROLES: 'api,jobs',
      OTOAPP_DIRECTORY_URL: stub.origin,
      OTOAPP_JOBS_KEYS: `${tenant}:${key}`,
      OTOAPP_JOBS_TIMEOUT_MS: '10000',
    });
  const jobOf = (name: OtoAppNightJob, clock: () => Date): JobDefinition =>
    buildOtoAppNightJobs({ env: envFor(), log: ctx.app.log }, { clock }).find((j) => j.name === `job:otoapp.${name}`)!;
  const runnerFor = (job: JobDefinition) => createJobRunner({ db, env: envFor(), log: ctx.app.log, channels: [], jobs: [job] });

  beforeAll(async () => {
    await stub.start();
    ctx = await createTestContext({
      otoapp: true,
      env: {
        OPS_TEST_CONTROLS: 'true',
        PROCESS_ROLES: 'api,jobs',
        OTOAPP_DIRECTORY_URL: stub.origin,
        OTOAPP_JOBS_KEYS: `${tenant}:${key}`,
        OTOAPP_JOBS_TIMEOUT_MS: '10000',
      },
    });
    db = ctx.db;
    admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const dbUrl = (db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
    await withClient(dbUrl, (c) => c.query(`insert into tenants (id, name, slug) values ($1, 'ZZ RV D', $2)`, [tenant, `zz-rv-d-${tenant.slice(-6)}`]));
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
    await stub.close();
  });

  it('the no-show fence at the millisecond: 06:59:59.999 out, 07:00:00.000 in, 21:59:59.999 in, 22:00:00.000 out, and out on both sides of midnight', async () => {
    const at = (iso: string) => new Date(iso);
    const cases: Array<[string, boolean]> = [
      ['2026-11-06T06:59:59.999+07:00', false],
      ['2026-11-06T07:00:00.000+07:00', true],
      ['2026-11-06T21:59:59.999+07:00', true],
      ['2026-11-06T22:00:00.000+07:00', false],
      ['2026-11-06T23:59:59.999+07:00', false],
      ['2026-11-07T00:00:00.000+07:00', false],
    ];
    const seen: Array<[string, boolean, number]> = [];
    for (const [iso] of cases) {
      stub.calls = [];
      const job = jobOf('no_show', () => at(iso));
      expect(await runnerFor(job).runJob(job.name, { force: true }), iso).toBe('ok');
      const [latest] = await db.select().from(opsRun).where(and(eq(opsRun.name, OTOAPP_NO_SHOW_JOB), eq(opsRun.kind, 'job'))).orderBy(desc(opsRun.startedAt)).limit(1);
      seen.push([iso, (latest!.detail as NightJobSummary).due, stub.calls.length]);
    }
    expect(seen).toEqual(cases.map(([iso, due]) => [iso, due, due ? 1 : 0]));
  });

  it('Run now pressed while a scheduled Attention run holds the job: refused in words (409), the app asked once, and the held run finishes ok', async () => {
    stub.calls = [];
    let release: () => void = () => undefined;
    stub.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = jobOf('attention', () => new Date());
    const scheduled = runnerFor(job).runJob(job.name, { force: true });
    while (stub.calls.length === 0) await sleep(10);
    const press = await ctx.app.inject({
      method: 'POST',
      url: '/ops/test-controls/otoapp.attention',
      headers: { cookie: admin, 'idempotency-key': randomUUID() },
    });
    release();
    stub.hold = null;
    expect(press.statusCode, press.body).toBe(409);
    expect(press.json().error).toMatchObject({ code: 'JOB_RUNNING' });
    expect(press.json().error.message).toBe(`${OTOAPP_ATTENTION_JOB} is already running, so it was not started a second time`);
    expect(await scheduled).toBe('ok');
    expect(stub.calls).toEqual([{ job: 'attention', tenantId: tenant }]);
  });
});

// =============================================================================
// E. Seams, fences and the plan
// =============================================================================

function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir, { recursive: true }).map(String)) {
    if (/node_modules|[\\/]dist[\\/]|^dist[\\/]|\.turbo/.test(f)) continue;
    const path = join(dir, f);
    if (/\.(ts|tsx|mjs|js|cjs|json|sql|ya?ml)$/.test(f) && statSync(path).isFile()) out.push(path);
  }
  return out;
}

describe('E. seams, fences and the plan', () => {
  it('booth, POS, console, launcher, the packages and the services name nothing of 4b', () => {
    const roots = ['apps/booth', 'apps/pos', 'apps/console', 'apps/launcher', 'packages', 'services'].map((r) => join(REPO, r));
    const patterns = [
      /otoapp\.attention|otoapp\.no_show|jobs\/(attention|no_show)\b/,
      /attention_items|attention_rules_config|attentionItems/,
      /upsertSettings|settings_key_held|settings_no_park_group|settings_tenant_id_key_unique/,
      /ATTENTION_REFRESH_RUNNING|attention_running|0x0713|ATTENTION_ITEM_LOCK/,
      /0007_tenant_ownership_contract/,
    ];
    const hits: string[] = [];
    for (const root of roots) {
      for (const path of sourcesUnder(root)) {
        const text = readFileSync(path, 'utf8');
        for (const p of patterns) if (p.test(text)) hits.push(`${path.slice(REPO.length)} ~ ${p}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('0007 touches its three tables and nothing else: no other table altered, nothing of rounds 5 to 7', () => {
    const text = committed(join(APP_MIGRATIONS, '0007_tenant_ownership_contract.sql')).replace(/--.*$/gm, '');
    const altered = [...text.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect([...new Set(altered)].sort()).toEqual(['activity_log', 'attention_items', 'settings']);
    const updated = [...text.matchAll(/UPDATE "([a-z_]+)"/g)].map((m) => m[1]);
    expect([...new Set(updated)].sort()).toEqual(['activity_log', 'attention_items', 'settings']);
    expect([...text.matchAll(/INSERT INTO "([a-z_]+)"/g)].map((m) => m[1])).toEqual(['tenants']);
    expect(text).not.toMatch(/templates|policy_documents|asset_catalog|i18n_translations|leave_policies|people|xero_|cash_|pl_facts|GRANT|REVOKE/i);
  });

  it('nothing of rounds 5 to 7 in the app: the time-off approval 503s, the legacy-table guard, Data Admin’s Attention 503, and face still the app’s', () => {
    const routes = readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8');
    expect(routes.match(/Time-off approval is unavailable until approval tracking is enabled/g)?.length).toBe(2);
    expect(routes.match(/legacyHrUser\(/g)?.length).toBe(11);
    expect(readFileSync(join(APP_SERVER, 'data-admin', 'router.ts'), 'utf8')).toMatch(
      /router\.use\("\/attention-items", \(_req: Request, res: Response\) => \{\s*res\.status\(503\)/,
    );
    expect(readFileSync(join(APP_SERVER, 'face-recognition.ts'), 'utf8')).toMatch(/const useAWS = process\.env\.USE_AWS_REKOGNITION === "true";/);
  });

  it('the plan carries 4b’s six questions with the app (or as built) as each default, and its deploy order', () => {
    for (const n of [32, 33, 34, 35, 36, 37]) expect(question(n), `Q${n}`).toMatch(/Default: (the app's behaviour|as the app|as built)/);
    expect(plan()).toMatch(/\*\*Deploy order for 4b:\*\* the app first \(its pre-deploy runs 0007; its\s+endpoint learns the two names\), then the api\./);
  });
});
