import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opsExpectation, opsLast, opsRun, type Db } from '@oto/db';
import { applyOtoAppMigrations, createTestDatabase } from '@oto/db/testing';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { loadEnv, type Env } from '../src/env';
import { buildDefaultJobs, buildOtoAppNightJobs, createJobRunner, type JobDefinition } from '../src/services/jobs';
import { type NightJobAnswer, type OtoAppNightJob } from '../src/services/otoapp-directory';
import {
  FORCED_FAILURE_CODE,
  NIGHT_JOB_UNKEYED,
  NIGHT_STEP_FAILED,
  OTOAPP_ATTENTION_JOB,
  OTOAPP_NO_SHOW_JOB,
  describeLatestNightRun,
  type NightJobSummary,
} from '../src/services/otoapp-jobs';

/**
 * S2-17b round 4b (SCRUM-193 under SCRUM-191) — TENANT OWNERSHIP, THE CONTRACT
 * HALF, AND ATTENTION RESUMED, proved (docs/progress/plans/otoapp-lift/PLAN.md
 * section 4 "Shared tables answer across park groups", section 5 "The app's
 * jobs on the platform runner", section 7 "Round 4 (contract)", section 8
 * round 4's 4b half; hazards H10-H12 and H20; questions Q28-Q35).
 *
 *  A. The contraction, app migration 0007: committed as generated plus the
 *     lock, 0006's backfill run again statement for statement, and the gate;
 *     from a 0006 database holding rows the previous release wrote into the
 *     gap, each is placed by its own links (and the rows 0006 placed are not
 *     moved), then NOT NULL holds and the old one-row-per-key unique is gone;
 *     a row the backfill cannot place stops it loudly with nothing changed;
 *     a write in flight is waited for and placed, and one queued behind its
 *     lock lands after it — taken when it names its park group, refused when
 *     it names none; from empty, twice.
 *  B. The settings rules as 4b leaves them (server/lib/parkGroupSettings.ts):
 *     every park group saves its own, a caller of none is refused.
 *  C. Read off the code: every Attention writer passes the park group, every
 *     auto-resolve and per-entity read names one, Attention resumed, the
 *     Attention 503s gone, a settings save one transaction, Data Admin's 4a
 *     hold lifted, the platform's two jobs, CI's OTO App job.
 *  D. The platform's two new jobs, `job:otoapp.attention` and
 *     `job:otoapp.no_show`, against a stand-in app: registered as every job
 *     is; no keys, a no-op; every park group each run; the run adds up what
 *     each park group raised, rule by rule — the first run's burst kept, not
 *     smoothed; the no-show check's 07:00-22:00 Bangkok fence; once per
 *     window (the runner's interval, and its exclusive lock); the deliberate
 *     failures on Failures with a Retry that runs for real; a park group the
 *     app holds staff in with no key (F1); a failed step; an app that does
 *     not know the batch yet.
 *  E. The real app (when its node_modules are present): the app's two
 *     checks over HTTP (apps/oto-app/tests/tenant-ownership.check.ts as 4b
 *     leaves it, and tests/attention.check.ts) against fresh databases, each
 *     read back clean after; and the platform's two jobs against the real
 *     app: each park group's items raised in its own, a second run raising
 *     nothing new (H20).
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
const MIGRATION = '0007_tenant_ownership_contract';
const TABLES = ['settings', 'activity_log', 'attention_items'] as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}
const journal = (): Journal => JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;

/** A copy of the app's migrations up to and including `idx`. */
function migrationsUpTo(idx: number): string {
  const j = journal();
  const live = j.entries.filter((e) => e.idx <= idx);
  const dir = mkdtempSync(join(tmpdir(), 'otoapp-r4b-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...j, entries: live }));
  for (const e of live) copyFileSync(join(APP_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>, name = 'zz-r4b'): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: name });
  await c.connect();
  try {
    await c.query('set search_path to otoapp');
    return await work(c);
  } finally {
    await c.end();
  }
}

/** A fresh platform database whose otoapp schema stands at 0006 (round 4a), as staging stands before 4b. */
async function databaseAt0006(): Promise<{ url: string; drop: () => Promise<void> }> {
  const { url, drop } = await createTestDatabase();
  const dir = migrationsUpTo(6);
  await withClient(url, (c) => migrate(drizzle(c), { migrationsFolder: dir, migrationsSchema: 'otoapp' }));
  return {
    url,
    drop: async () => {
      rmSync(dir, { recursive: true, force: true });
      await drop();
    },
  };
}

/** The app's own migrator where it can run here, its output; else the same SQL through the same Drizzle migrator. */
function upgrade(url: string): { status: number; output: string } {
  if (HAS_APP_MODULES) {
    const out = spawnSync(process.execPath, [join(APP_DIR, 'script', 'migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    return { status: out.status ?? 1, output: `${out.stdout ?? ''}\n${out.stderr ?? ''}` };
  }
  throw new Error('use upgradeAsync without the app modules');
}

async function upgradeAsync(url: string): Promise<{ status: number; output: string }> {
  if (HAS_APP_MODULES) return upgrade(url);
  try {
    await applyOtoAppMigrations(url);
    return { status: 0, output: 'applyOtoAppMigrations' };
  } catch (err) {
    // The whole cause chain: drizzle's migrator wraps a refused statement as
    // "Failed query: <sql>" and keeps the database's own words (the 0007
    // gate's RAISE) in `cause`. The app's migrate.mjs child prints the chain;
    // this in-process path has to surface it too, or CI (which has no app
    // node_modules and so takes this path) never sees the gate's words.
    const parts: string[] = [];
    for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
      parts.push(String((e as Error)?.message ?? e));
    }
    return { status: 1, output: parts.join(String.fromCharCode(10)) };
  }
}

const insertRow = (c: pg.Client, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return c.query(
    `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
};

/** One migration file's statements, comments and blank lines out, whitespace collapsed. */
function statementsOf(tag: string): string[] {
  return readFileSync(join(APP_MIGRATIONS, `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function readback(url: string): { status: number; output: string } {
  const out = spawnSync(process.execPath, [READBACK], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  return { status: out.status ?? 2, output: `${out.stdout ?? ''}\n${out.stderr ?? ''}` };
}

// =============================================================================
// A. The contraction
// =============================================================================

describe('A. the contraction, app migration 0007', () => {
  it('is journalled as 0007 after 0006, with its snapshot, and has "public." stripped', () => {
    const entries = journal().entries;
    const e = entries.find((x) => x.tag === MIGRATION);
    expect(e?.idx).toBe(7);
    expect(e!.when).toBeGreaterThan(entries.find((x) => x.idx === 6)!.when);
    expect(entries.at(-1)!.tag).toBe(MIGRATION);
    expect(existsSync(join(APP_MIGRATIONS, 'meta', '0007_snapshot.json'))).toBe(true);
    expect(readFileSync(join(APP_MIGRATIONS, `${MIGRATION}.sql`), 'utf8').includes('"public".')).toBe(false);
  });

  it('runs, in order: the lock, 0006’s backfill statement for statement, the gate, NOT NULL on the three, the old unique dropped last', () => {
    const s = statementsOf(MIGRATION);
    expect(s[0]).toBe('LOCK TABLE "settings", "activity_log", "attention_items" IN SHARE ROW EXCLUSIVE MODE;');
    const expand = statementsOf('0006_tenant_ownership_expand');
    const backfill = expand.slice(expand.findIndex((x) => x.startsWith('UPDATE "activity_log" AS a SET "tenant_id" = b.')), expand.findIndex((x) => x.startsWith('CREATE INDEX')));
    expect(backfill).toHaveLength(11);
    expect(s.slice(1, 1 + backfill.length)).toEqual(backfill);
    const rest = s.slice(1 + backfill.length);
    expect(rest[0]).toMatch(/^DO \$\$ .* RAISE EXCEPTION 'tenant ownership \(0007\): % settings, % activity_log and % attention_items rows still have no park group/);
    expect(rest.slice(1)).toEqual([
      'ALTER TABLE "activity_log" ALTER COLUMN "tenant_id" SET NOT NULL;',
      'ALTER TABLE "attention_items" ALTER COLUMN "tenant_id" SET NOT NULL;',
      'ALTER TABLE "settings" ALTER COLUMN "tenant_id" SET NOT NULL;',
      'ALTER TABLE "settings" DROP CONSTRAINT "settings_key_unique";',
    ]);
    // Nothing else is dropped, renamed or retyped.
    const text = s.join('\n');
    expect(text.match(/\bDROP\b/g)).toHaveLength(1);
    expect(text).not.toMatch(/\bRENAME\b|\bTYPE\b|\bTRUNCATE\b|\bDELETE FROM\b/);
  });

  it('its snapshot is the schema the code declares: the three tenant_id NOT NULL, no unique on key alone', () => {
    const snap = JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '0007_snapshot.json'), 'utf8')) as {
      tables: Record<string, { columns: Record<string, { notNull: boolean }>; uniqueConstraints: Record<string, unknown>; indexes: Record<string, unknown> }>;
    };
    for (const t of TABLES) expect(snap.tables[`public.${t}`]!.columns.tenant_id!.notNull, t).toBe(true);
    expect(snap.tables['public.settings']!.uniqueConstraints).toEqual({});
    expect(Object.keys(snap.tables['public.settings']!.indexes)).toContain('settings_tenant_id_key_unique');
    const schema = readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8');
    expect(schema).toMatch(/key: text\("key"\)\.notNull\(\),/);
  });

  describe('from a 0006 database with rows the previous release wrote into the gap', () => {
    let url = '';
    let drop: () => Promise<void> = async () => undefined;
    const D = randomUUID();
    const A = randomUUID();
    const B = randomUUID();
    const id = {
      bA: randomUUID(),
      bB: randomUUID(),
      eA: randomUUID(),
      eB: randomUUID(), // B's, in no branch
      cB: randomUUID(),
      uA: randomUUID(),
      uB: randomUUID(),
      uSplit: randomUUID(),
    };
    /** The gap's rows (no park group) and where 0007 must put each. */
    const gapActivity: Record<string, { row: Record<string, string>; expected: string }> = {
      byBranch: { row: { branch_id: id.bB }, expected: B },
      byEmployee: { row: { employee_id: id.eA }, expected: A },
      byContract: { row: { contract_instance_id: id.cB }, expected: B },
      byActor: { row: { created_by: id.uA }, expected: A },
      byActorInTwo: { row: { created_by: id.uSplit }, expected: D },
      byNothing: { row: {}, expected: D },
    };
    const gapAttention: Record<string, { row: Record<string, string>; expected: string }> = {
      byBranch: { row: { branch_id: id.bA }, expected: A },
      byEmployee: { row: { employee_id: id.eB }, expected: B },
      byContract: { row: { contract_instance_id: id.cB }, expected: B },
      resolvedByA: { row: { resolved_by: id.uA }, expected: D },
    };
    const rowIds = new Map<string, string>();
    let placedBefore: Record<string, string> = {};
    let totalsBefore: Record<string, number> = {};
    let run1 = { status: 0, output: '' };
    let run2 = { status: 0, output: '' };

    beforeAll(async () => {
      ({ url, drop } = await databaseAt0006());
      await withClient(url, async (c) => {
        await c.query(`insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default'), ($2, 'ZZ R4B A', 'zz-r4b-a'), ($3, 'ZZ R4B B', 'zz-r4b-b')`, [D, A, B]);
        await insertRow(c, 'branches', { id: id.bA, tenant_id: A, name: 'ZZ R4B A', address: 'x' });
        await insertRow(c, 'branches', { id: id.bB, tenant_id: B, name: 'ZZ R4B B', address: 'x' });
        await insertRow(c, 'employees', { id: id.eA, tenant_id: A, branch_id: id.bA, full_name: 'ZZ A', nickname: 'ZZ', email: `zz-a-${id.eA}@example.com` });
        await insertRow(c, 'employees', { id: id.eB, tenant_id: B, full_name: 'ZZ B', nickname: 'ZZ', email: `zz-b-${id.eB}@example.com` });
        for (const user of [id.uA, id.uB, id.uSplit]) {
          await insertRow(c, 'users', { id: user, email: `zz-u-${user}@example.com`, password: 'x', full_name: 'ZZ', role: 'admin' });
        }
        const access = (user: string, tenant: string) =>
          insertRow(c, 'user_branch_access', { tenant_id: tenant, user_id: user, branch_id: null, access_scope: 'all_branches' });
        await access(id.uA, A);
        await access(id.uB, B);
        await access(id.uSplit, A);
        await access(id.uSplit, B);
        const template = randomUUID();
        await insertRow(c, 'templates', { id: template, name: 'ZZ R4B template', html_body: '<p>zz</p>' });
        await insertRow(c, 'contract_instances', {
          id: id.cB,
          employee_id: id.eB,
          template_id: template,
          template_snapshot_html: '<p>zz</p>',
          template_snapshot_version: 1,
          merge_data_json: '{}',
          created_by: id.uB,
        });
        // What 4a placed (or wrote with its park group): never moved by 0007.
        for (const [name, row] of [
          ['placedActivityB', { tenant_id: B, branch_id: id.bA }], // deliberately against its branch: 0007 places only nulls
          ['placedActivityD', { tenant_id: D }],
        ] as const) {
          const rowId = randomUUID();
          rowIds.set(`activity:${name}`, rowId);
          await insertRow(c, 'activity_log', { id: rowId, activity_type: 'employee_updated', summary_text: `ZZ ${name}`, ...row });
        }
        await c.query(`insert into settings (key, value, tenant_id) values ('md_signatory_name', 'ZZ D MD', $1), ('zz_b_only', 'B', $2)`, [D, B]);
        // The gap: the previous release's writes, no park group named.
        for (const [name, { row }] of Object.entries(gapActivity)) {
          const rowId = randomUUID();
          rowIds.set(`activity:${name}`, rowId);
          await insertRow(c, 'activity_log', { id: rowId, activity_type: 'employee_updated', summary_text: `ZZ gap ${name}`, ...row });
        }
        for (const [name, { row }] of Object.entries(gapAttention)) {
          const rowId = randomUUID();
          rowIds.set(`attention:${name}`, rowId);
          await insertRow(c, 'attention_items', { id: rowId, type: 'CONTRACT_NOT_SENT', title: `ZZ gap ${name}`, ...row });
        }
        await c.query(`insert into settings (key, value) values ('zz_gap_key', 'from the gap')`);
        const placed = await c.query<{ id: string; tenant_id: string }>('select id, tenant_id from activity_log where tenant_id is not null');
        placedBefore = Object.fromEntries(placed.rows.map((r) => [r.id, r.tenant_id]));
        totalsBefore = {};
        for (const t of TABLES) totalsBefore[t] = Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
      });
      run1 = await upgradeAsync(url);
      run2 = await upgradeAsync(url);
    }, 120_000);

    afterAll(async () => {
      await drop();
    });

    const tenantsOf = async (table: string) =>
      new Map((await withClient(url, (c) => c.query<{ id: string; tenant_id: string }>(`select id, tenant_id from ${table}`))).rows.map((r) => [r.id, r.tenant_id]));

    it('the app’s migrator applies 0007 alone, then nothing', () => {
      expect(run1.status, run1.output).toBe(0);
      expect(run2.status, run2.output).toBe(0);
      if (HAS_APP_MODULES) {
        expect(run1.output).toContain(`applied ${MIGRATION}`);
        expect(run1.output).not.toContain('applied 0006');
        expect(run2.output).toMatch(new RegExp(`up to date .* ${journal().entries.length} migration`));
      }
    });

    it('every gap row lands where its own links put it, by 0006’s order', async () => {
      const activity = await tenantsOf('activity_log');
      const attention = await tenantsOf('attention_items');
      const wrong = [
        ...Object.entries(gapActivity).filter(([n, { expected }]) => activity.get(rowIds.get(`activity:${n}`)!) !== expected).map(([n]) => `activity:${n}`),
        ...Object.entries(gapAttention).filter(([n, { expected }]) => attention.get(rowIds.get(`attention:${n}`)!) !== expected).map(([n]) => `attention:${n}`),
      ];
      expect(wrong).toEqual([]);
      const settings = await withClient(url, (c) => c.query<{ key: string; tenant_id: string }>('select key, tenant_id from settings order by key'));
      expect(settings.rows).toEqual([
        { key: 'md_signatory_name', tenant_id: D },
        { key: 'zz_b_only', tenant_id: B },
        { key: 'zz_gap_key', tenant_id: D },
      ]);
    });

    it('a row already placed is not moved, even one that disagrees with its branch; nothing is lost or added; no park group is made', async () => {
      const activity = await tenantsOf('activity_log');
      for (const [rowId, tenant] of Object.entries(placedBefore)) expect(activity.get(rowId), rowId).toBe(tenant);
      await withClient(url, async (c) => {
        for (const t of TABLES) expect(Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n), t).toBe(totalsBefore[t]);
        expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(3);
      });
    });

    it('then NOT NULL holds on all three: a row with no park group is refused', async () => {
      await withClient(url, async (c) => {
        const cols = await c.query<{ table_name: string; is_nullable: string }>(
          `select table_name, is_nullable from information_schema.columns
            where table_schema = 'otoapp' and column_name = 'tenant_id' and table_name = any($1) order by 1`,
          [TABLES],
        );
        expect(cols.rows).toEqual([
          { table_name: 'activity_log', is_nullable: 'NO' },
          { table_name: 'attention_items', is_nullable: 'NO' },
          { table_name: 'settings', is_nullable: 'NO' },
        ]);
        for (const [table, row] of [
          ['settings', { key: 'zz_after', value: 'x' }],
          ['activity_log', { activity_type: 'employee_updated', summary_text: 'ZZ after' }],
          ['attention_items', { type: 'CONTRACT_NOT_SENT', title: 'ZZ after' }],
        ] as const) {
          await expect(insertRow(c, table, row), table).rejects.toMatchObject({ code: '23502' });
        }
      });
    });

    it('and the old one-row-per-key unique is gone: a second park group keeps its own row for a key the default holds', async () => {
      await withClient(url, async (c) => {
        const cons = await c.query<{ conname: string }>(
          `select conname from pg_constraint where conrelid = 'otoapp.settings'::regclass and contype = 'u'`,
        );
        expect(cons.rows).toEqual([]);
        const uniques = await c.query<{ indexname: string }>(
          `select indexname from pg_indexes where schemaname = 'otoapp' and tablename = 'settings' and indexdef like 'CREATE UNIQUE%' order by 1`,
        );
        expect(uniques.rows.map((r) => r.indexname)).toEqual(['settings_pkey', 'settings_tenant_id_key_unique']);
        await c.query(`insert into settings (key, value, tenant_id) values ('md_signatory_name', 'ZZ B MD', $1)`, [B]);
        await expect(c.query(`insert into settings (key, value, tenant_id) values ('md_signatory_name', 'twice', $1)`, [B])).rejects.toMatchObject({
          code: '23505',
        });
        await c.query(`delete from settings where key = 'md_signatory_name' and tenant_id = $1`, [B]);
      });
    });

    it.skipIf(!HAS_APP_MODULES)('the read-back answers clean: every row placed, NOT NULL, the (tenant_id, key) unique alone', () => {
      const out = readback(url);
      expect(out.status, out.output).toBe(0);
      expect(out.output).toMatch(/settings: \d+ rows?, 0 with no park group/);
      expect(out.output).toMatch(/activity_log: \d+ rows?, 0 with no park group/);
      expect(out.output).toMatch(/attention_items: \d+ rows?, 0 with no park group/);
      expect(out.output).toMatch(/settings uniques: \(tenant_id, key\) alone/);
      expect(out.output).toMatch(/tenant_id NOT NULL \(round 4b, 0007\): activity_log yes, attention_items yes, settings yes/);
    });
  });

  it('the gate: a row the backfill cannot place stops 0007 loudly, and nothing is changed', async () => {
    const { url, drop } = await databaseAt0006();
    try {
      const D = randomUUID();
      const stuck = randomUUID();
      await withClient(url, async (c) => {
        await c.query(`insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default')`, [D]);
        await insertRow(c, 'activity_log', { id: stuck, activity_type: 'employee_updated', summary_text: 'ZZ unplaceable' });
        // Whatever no one foresaw, standing in: a row that will not take a park group.
        await c.query(`create function zz_r4b_keep_null() returns trigger language plpgsql as $$
                         begin new.tenant_id := null; return new; end $$`);
        await c.query(`create trigger zz_r4b_keep_null before update on activity_log
                         for each row when (new.summary_text = 'ZZ unplaceable') execute function zz_r4b_keep_null()`);
      });
      const out = await upgradeAsync(url);
      expect(out.status, out.output).not.toBe(0);
      expect(out.output).toMatch(/tenant ownership \(0007\): 0 settings, 1 activity_log and 0 attention_items rows still have no park group/);
      await withClient(url, async (c) => {
        const cols = await c.query<{ is_nullable: string }>(
          `select is_nullable from information_schema.columns where table_schema = 'otoapp' and column_name = 'tenant_id' and table_name = any($1)`,
          [TABLES],
        );
        expect(cols.rows.map((r) => r.is_nullable)).toEqual(['YES', 'YES', 'YES']);
        const cons = await c.query(`select 1 from pg_constraint where conname = 'settings_key_unique'`);
        expect(cons.rowCount).toBe(1);
        expect(Number((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n)).toBe(7);
        expect((await c.query('select tenant_id from activity_log where id = $1', [stuck])).rows).toEqual([{ tenant_id: null }]);
      });
    } finally {
      await drop();
    }
  }, 120_000);

  it('the window: a write in flight is waited for and placed; a write queued behind the lock lands after — refused naming no park group, taken naming one', async () => {
    const { url, drop } = await databaseAt0006();
    const D = randomUUID();
    const A = randomUUID();
    const bA = randomUUID();
    const inFlight = randomUUID();
    const queuedBare = randomUUID();
    const queuedPlaced = randomUUID();
    try {
      await withClient(url, async (c) => {
        await c.query(`insert into tenants (id, name, slug) values ($1, 'OTO Default', 'default'), ($2, 'ZZ window A', 'zz-window-a')`, [D, A]);
        await insertRow(c, 'branches', { id: bA, tenant_id: A, name: 'ZZ window branch', address: 'x' });
      });
      const clients = ['zz-r4b-w1', 'zz-r4b-w2', 'zz-r4b-w3', 'zz-r4b-migrate', 'zz-r4b-watch'].map(
        (name) => new pg.Client({ connectionString: url, application_name: name }),
      );
      const [w1, w2, w3, mig, watch] = clients as [pg.Client, pg.Client, pg.Client, pg.Client, pg.Client];
      await Promise.all(clients.map((c) => c.connect()));
      const waitForLockWait = async (application: string) => {
        const until = Date.now() + 60_000;
        while (Date.now() < until) {
          const r = await watch.query(`select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`, [application]);
          if (r.rowCount) return;
          await sleep(25);
        }
        throw new Error(`${application} never waited on a lock`);
      };
      let bare: unknown = null;
      try {
        for (const c of [w1, w2, w3, mig]) await c.query('set search_path to otoapp');
        // A write with no park group, mid-transaction, as the deploy's migrator starts.
        await w1.query('begin');
        await w1.query(`insert into activity_log (id, activity_type, summary_text, branch_id) values ($1, 'employee_updated', 'ZZ in flight', $2)`, [
          inFlight,
          bA,
        ]);
        const migrating = migrate(drizzle(mig), { migrationsFolder: APP_MIGRATIONS, migrationsSchema: 'otoapp' });
        await waitForLockWait('zz-r4b-migrate');
        const writingBare = w2
          .query(`insert into activity_log (id, activity_type, summary_text, branch_id) values ($1, 'employee_updated', 'ZZ queued bare', $2)`, [
            queuedBare,
            bA,
          ])
          .catch((err: unknown) => {
            bare = err;
          });
        await waitForLockWait('zz-r4b-w2');
        const writingPlaced = w3.query(
          `insert into activity_log (id, activity_type, summary_text, branch_id, tenant_id) values ($1, 'employee_updated', 'ZZ queued placed', $2, $3)`,
          [queuedPlaced, bA, A],
        );
        await waitForLockWait('zz-r4b-w3');
        await w1.query('commit');
        await migrating;
        await writingBare;
        await writingPlaced;
      } finally {
        await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
      }
      expect(bare).toMatchObject({ code: '23502' });
      await withClient(url, async (c) => {
        const rows = await c.query<{ id: string; tenant_id: string }>('select id, tenant_id from activity_log');
        expect(new Map(rows.rows.map((r) => [r.id, r.tenant_id]))).toEqual(
          new Map([
            [inFlight, A],
            [queuedPlaced, A],
          ]),
        );
        expect(Number((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n)).toBe(journal().entries.length);
      });
    } finally {
      await drop();
    }
  }, 120_000);

  it('from empty, twice: 0007’s shape, and no park group made', async () => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      const again = await upgradeAsync(url);
      expect(again.status, again.output).toBe(0);
      if (HAS_APP_MODULES) expect(again.output).toMatch(new RegExp(`up to date .* ${journal().entries.length} migration`));
      await withClient(url, async (c) => {
        const cols = await c.query<{ is_nullable: string }>(
          `select is_nullable from information_schema.columns where table_schema = 'otoapp' and column_name = 'tenant_id' and table_name = any($1)`,
          [TABLES],
        );
        expect(cols.rows.map((r) => r.is_nullable)).toEqual(['NO', 'NO', 'NO']);
        const uniques = await c.query<{ indexname: string }>(
          `select indexname from pg_indexes where schemaname = 'otoapp' and tablename = 'settings' and indexdef like 'CREATE UNIQUE%' order by 1`,
        );
        expect(uniques.rows.map((r) => r.indexname)).toEqual(['settings_pkey', 'settings_tenant_id_key_unique']);
        expect(Number((await c.query('select count(*)::int as n from tenants')).rows[0].n)).toBe(0);
      });
    } finally {
      await drop();
    }
  }, 120_000);
});

// =============================================================================
// B. The settings rules
// =============================================================================

interface SettingsRules {
  settingsWritableBy(owner: string | null): boolean;
  settingsReadRank(rowTenant: string | null, reader: string | null, defaultParkGroup: string | null): number | null;
  SETTINGS_KEY_HELD_REFUSAL: { reason: string; message: string };
  SETTINGS_NO_PARK_GROUP_REFUSAL: { reason: string; message: string };
  [name: string]: unknown;
}

describe('B. the settings rules as 4b leaves them (server/lib/parkGroupSettings.ts)', () => {
  let rules: SettingsRules;
  beforeAll(async () => {
    rules = (await import(/* @vite-ignore */ pathToFileURL(join(APP_DIR, 'server', 'lib', 'parkGroupSettings.ts')).href)) as SettingsRules;
  });

  it('every park group saves its own; a caller of no park group saves nothing', () => {
    expect(rules.settingsWritableBy(randomUUID())).toBe(true);
    expect(rules.settingsWritableBy(null)).toBe(false);
    expect(rules.settingsWritableBy('')).toBe(false);
  });

  it('4a’s refusal of every other park group is gone; the two left are words a person can act on', () => {
    expect(rules.SETTINGS_SHARED_REFUSAL).toBeUndefined();
    expect(rules.SETTINGS_NO_PARK_GROUP_REFUSAL.reason).toBe('settings_no_park_group');
    expect(rules.SETTINGS_KEY_HELD_REFUSAL.reason).toBe('settings_key_held');
    expect(rules.SETTINGS_KEY_HELD_REFUSAL.message).toMatch(/migration 0007/);
    expect(rules.SETTINGS_KEY_HELD_REFUSAL.message).not.toMatch(/next release/);
  });

  it('the read order is 4a’s (Q28): its own, then the default’s, never another park group’s', () => {
    const [D, B] = [randomUUID(), randomUUID()];
    expect(rules.settingsReadRank(B, B, D)).toBe(0);
    expect(rules.settingsReadRank(D, B, D)).toBe(1);
    expect(rules.settingsReadRank(randomUUID(), B, D)).toBeNull();
  });
});

// =============================================================================
// C. Read off the code
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

describe('C. read off the code', () => {
  it('every Attention writer names the park group: each createAttentionItem and upsertAttentionItem carries tenantId', () => {
    const offenders: string[] = [];
    const counted = { createAttentionItem: 0, upsertAttentionItem: 0 };
    for (const { rel, text } of appFiles()) {
      if (rel === 'server/storage.ts') continue;
      for (const name of ['createAttentionItem', 'upsertAttentionItem'] as const) {
        for (const { line, args } of callsOf(text, name)) {
          counted[name] += 1;
          if (!/\btenantId\b/.test(args[0] ?? '')) offenders.push(`${rel}:${line} ${name}`);
        }
      }
    }
    // The round 4a review counted nine gated creators: seven in routes.ts, two in the night batches.
    // Round 5 restored the app's tenth, the sick-day coverage alert (Q1, H14), in the person's park group.
    expect(counted).toEqual({ createAttentionItem: 10, upsertAttentionItem: 8 });
    expect(offenders).toEqual([]);
  });

  it('every auto-resolve and per-entity read names its park group; the engine reads one park group’s open items', () => {
    const offenders: string[] = [];
    let n = 0;
    for (const { rel, text } of appFiles()) {
      if (rel === 'server/storage.ts') continue;
      for (const { line, args } of callsOf(text, 'autoResolveAttentionItems')) {
        n += 1;
        if (args.length !== 3) offenders.push(`${rel}:${line}`);
      }
      for (const { line, args } of callsOf(text, 'getOpenAttentionItemsForEntity')) {
        n += 1;
        if (args.length !== 2) offenders.push(`${rel}:${line}`);
      }
    }
    expect(n).toBeGreaterThanOrEqual(6);
    expect(offenders).toEqual([]);
    const engine = code(readFileSync(join(APP_SERVER, 'attention-engine.ts'), 'utf8'));
    for (const { args } of callsOf(engine, 'getAttentionItems')) expect(args[0]).toMatch(/tenantId/);
    const storage = code(readFileSync(join(APP_SERVER, 'storage.ts'), 'utf8'));
    expect(storage).toMatch(/pg_advisory_xact_lock\(\$\{ATTENTION_ITEM_LOCK_NAMESPACE\}::int4/);
    expect(storage).toMatch(/eq\(attentionItems\.tenantId, item\.tenantId\),\s*eq\(attentionItems\.ruleKey, item\.ruleKey\)/);
  });

  it('Attention resumed: the switch is on, the Attention 503s are gone, and Data Admin’s Attention model stays closed until round 7', () => {
    expect(readFileSync(join(APP_SERVER, 'attention-availability.ts'), 'utf8')).toMatch(/export const ATTENTION_WRITES_READY = true;/);
    const routes = readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8');
    expect(routes).not.toMatch(/Attention rules are unavailable until tenant settings are isolated/);
    expect(routes).not.toMatch(/Attention updates are unavailable until tenant ownership is recorded/);
    expect(routes).not.toMatch(/Attention refresh is unavailable until tenant jobs are isolated/);
    expect(routes).toMatch(/holdNightBatch\(pool, "attention", scope\.tenantId\)/);
    expect(readFileSync(join(APP_SERVER, 'data-admin', 'router.ts'), 'utf8')).toMatch(/router\.use\("\/attention-items"[\s\S]{0,120}res\.status\(503\)/);
    // Rounds 6 and 7 untouched: the legacy-table guard stands. The time-off
    // approval 503s were round 5's to lift (Q1, apps/api/test/s217b-r5.test.ts).
    expect(routes).not.toMatch(/Time-off approval is unavailable until approval tracking is enabled/);
    expect(routes.match(/legacyHrUser\(/g)?.length).toBe(11);
  });

  it('a settings save is one transaction, the route saves through it, and Data Admin’s 4a hold to the default is lifted', () => {
    const storage = code(readFileSync(join(APP_SERVER, 'storage.ts'), 'utf8'));
    const body = storage.slice(storage.indexOf('async upsertSettings('), storage.indexOf('async getActivityLogs('));
    expect(body).toMatch(/return db\.transaction\(async \(tx\) => \{/);
    expect(body).not.toMatch(/\bdb\.(select|insert|update)\(/);
    const routes = code(readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8'));
    const post = routes.slice(routes.indexOf('app.post("/api/settings"'), routes.indexOf('app.post("/api/seed"'));
    expect(post).toMatch(/storage\.upsertSettings\(/);
    expect(post).not.toMatch(/for \(const setting of settingsArray\)/);
    const dataAdmin = readFileSync(join(APP_SERVER, 'data-admin', 'models', 'setting.ts'), 'utf8');
    expect(dataAdmin).not.toMatch(/heldToDefault|SETTINGS_SHARED_REFUSAL/);
    expect(code(readFileSync(join(APP_SERVER, 'lib', 'parkGroupSettings.ts'), 'utf8'))).not.toMatch(/settings_shared/);
  });

  it('the platform registers job:otoapp.attention and job:otoapp.no_show; nothing else in the suite names the three tables or 4b’s words', () => {
    const jobs = readFileSync(join(REPO, 'apps', 'api', 'src', 'services', 'otoapp-jobs.ts'), 'utf8');
    expect(jobs).toMatch(/OTOAPP_ATTENTION_JOB = 'job:otoapp\.attention'/);
    expect(jobs).toMatch(/OTOAPP_NO_SHOW_JOB = 'job:otoapp\.no_show'/);
    const roots = ['apps/booth/src', 'apps/pos/src', 'apps/console/src', 'apps/launcher/src', 'apps/api/src', 'packages', 'services'].map((r) =>
      join(REPO, r),
    );
    const hits: string[] = [];
    for (const root of roots) {
      for (const path of sourcesUnder(root, /\.(ts|tsx|mjs|js|cjs|json|sql|ya?ml)$/)) {
        const text = readFileSync(path, 'utf8');
        for (const p of [/otoapp\.(settings|activity_log|attention_items)\b/, /attention_rules_config/, /settings_key_unique/, /ATTENTION_WRITES_READY/]) {
          if (p.test(text)) hits.push(`${path.slice(REPO.length)} ~ ${p}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("CI's OTO App job runs the Attention check after the tenant ownership check, and the read-back last", () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('\n  oto-app:'));
    expect(job).toMatch(/npx tsx tests\/attention\.check\.ts/);
    expect(job.indexOf('tests/attention.check.ts')).toBeGreaterThan(job.indexOf('tests/tenant-ownership.check.ts'));
    expect(job.indexOf('tenant:readback')).toBeGreaterThan(job.indexOf('tests/attention.check.ts'));
  });

  it('the image carries the read-back, so a deployment can read itself back', () => {
    expect(readFileSync(join(APP_DIR, 'Dockerfile'), 'utf8')).toMatch(
      /COPY script\/tenant-ownership-readback\.mjs \.\/script\/tenant-ownership-readback\.mjs/,
    );
  });
});

// =============================================================================
// D. The platform's two jobs, against a stand-in app
// =============================================================================

const BANGKOK_AT = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);
const key = () => `odk_${randomBytes(32).toString('base64url')}`;

interface StubCall {
  job: string;
  tenantId: string;
}

type StubReply = { kind: 'answer'; status: number; body: unknown } | { kind: 'hold'; until: Promise<void>; then: StubReply };

const STEPS: Record<OtoAppNightJob, Array<{ step: string; onFailure: 'continue' | 'stop'; counts: Record<string, number> }>> = {
  midnight: [{ step: 'autoCheckout', onFailure: 'continue', counts: { checkedOut: 0 } }],
  reconcile: [{ step: 'presenceReconciliation', onFailure: 'continue', counts: { stuckClockIns: 0 } }],
  presence: [{ step: 'presenceReconciliation', onFailure: 'continue', counts: { stuckClockIns: 0 } }],
  attention: [{ step: 'attentionReconciliation', onFailure: 'continue', counts: { created: 0, updated: 0, resolved: 0, errors: 0 } }],
  no_show: [{ step: 'noShowCheck', onFailure: 'continue', counts: { created: 0, resolved: 0, outsideHours: 0 } }],
};

function answer(job: OtoAppNightJob, tenantId: string, counts?: Record<string, number>, failed?: string): NightJobAnswer {
  const now = new Date().toISOString();
  const steps = STEPS[job].map((s) => ({
    ...s,
    counts: counts ?? s.counts,
    ok: !failed,
    ...(failed ? { error: failed } : {}),
  }));
  return { job, tenantId, ok: !failed, startedAt: now, finishedAt: now, steps };
}

const KEYS: Record<string, string> = {};

class StubApp {
  calls: StubCall[] = [];
  reply: (call: StubCall) => StubReply = (call) => this.ok(call);
  private server: Server | null = null;
  origin = '';

  ok(call: StubCall): StubReply {
    return { kind: 'answer', status: 200, body: answer(call.job as OtoAppNightJob, call.tenantId) };
  }

  reset(): void {
    this.calls = [];
    this.reply = (call) => this.ok(call);
  }

  callsFor(job: string, tenantId?: string): StubCall[] {
    return this.calls.filter((c) => c.job === job && (!tenantId || c.tenantId === tenantId));
  }

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
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !m) return send(404, { error: 'not_found', message: 'Not found' });
    const body = (raw ? JSON.parse(raw) : {}) as { tenantId?: string };
    const tenantId = body.tenantId ?? '';
    if (req.headers.authorization !== `Bearer ${KEYS[tenantId]}`) {
      return send(403, { error: 'Invalid directory key', message: 'The key is not one this app issued' });
    }
    const call: StubCall = { job: m[1]!, tenantId };
    this.calls.push(call);
    let reply = this.reply(call);
    while (reply.kind === 'hold') {
      await reply.until;
      reply = reply.then;
    }
    send(reply.status, reply.body);
  }
}

const stub = new StubApp();

afterAll(async () => {
  await teardownAll();
});

describe('D. the platform’s two new jobs against a stand-in app', () => {
  let ctx: TestContext;
  let db: Db;
  let admin = '';
  let appPool: pg.Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const keyA = key();
  const keyB = key();

  const envFor = (groups: Array<[string, string]>, extra: Partial<Record<keyof Env, string>> = {}): Env =>
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
      PROCESS_ROLES: 'api,jobs',
      OTOAPP_DIRECTORY_URL: stub.origin,
      OTOAPP_JOBS_KEYS: groups.map(([t, k]) => `${t}:${k}`).join(','),
      OTOAPP_JOBS_TIMEOUT_MS: '5000',
      ...extra,
    });
  const bothKeys = () => envFor([[tenantA, keyA], [tenantB, keyB]]);

  function jobOf(name: OtoAppNightJob, clock: () => Date, env: Env = bothKeys()): JobDefinition {
    const job = buildOtoAppNightJobs({ env, log: ctx.app.log }, { clock }).find((j) => j.name === `job:otoapp.${name}`);
    if (!job) throw new Error(`no ${name} job`);
    return job;
  }
  const runnerFor = (job: JobDefinition, env: Env = bothKeys()) => createJobRunner({ db, env, log: ctx.app.log, channels: [], jobs: [job] });
  const runsOf = (job: string) =>
    db.select().from(opsRun).where(and(eq(opsRun.name, job), eq(opsRun.kind, 'job'))).orderBy(desc(opsRun.startedAt));
  const detailOf = (run: { detail: unknown }) => run.detail as NightJobSummary;
  const press = (k: string, cookie = admin) =>
    ctx.app.inject({ method: 'POST', url: `/ops/test-controls/${k}`, headers: { cookie, 'idempotency-key': randomUUID() } });

  beforeAll(async () => {
    await stub.start();
    KEYS[tenantA] = keyA;
    KEYS[tenantB] = keyB;
    ctx = await createTestContext({
      otoapp: true,
      env: {
        OPS_TEST_CONTROLS: 'true',
        PROCESS_ROLES: 'api,jobs',
        OTOAPP_DIRECTORY_URL: stub.origin,
        OTOAPP_JOBS_KEYS: `${tenantA}:${keyA}`,
        OTOAPP_JOBS_TIMEOUT_MS: '5000',
      },
    });
    db = ctx.db;
    admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const dbUrl = (db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
    appPool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=otoapp', max: 4 });
    for (const [t, label] of [
      [tenantA, 'a'],
      [tenantB, 'b'],
    ] as const) {
      await appPool.query(`insert into tenants (id, name, slug) values ($1, $2, $3)`, [t, `ZZ r4b ${label}`, `zz-r4b-${label}-${t.slice(-6)}`]);
    }
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await ctx?.close();
    await stub.close();
  });

  it('registered as every job is: Attention every six hours, no-show every ten minutes, both exclusive, each with its expectation and its Health row', async () => {
    const env = envFor([]);
    const ours = buildDefaultJobs({ db, env, log: ctx.app.log, channels: [] }).filter((j) =>
      [OTOAPP_ATTENTION_JOB, OTOAPP_NO_SHOW_JOB].includes(j.name),
    );
    expect(ours.map((j) => [j.name, j.intervalSeconds, j.exclusive])).toEqual([
      [OTOAPP_ATTENTION_JOB, 21_600, true],
      [OTOAPP_NO_SHOW_JOB, 600, true],
    ]);
    for (const j of ours) expect(j.description).toMatch(/^Runs the OTO App's /);
    const runner = createJobRunner({ db, env, log: ctx.app.log, channels: [], jobs: ours });
    await runner.start();
    await runner.stop();
    const expectations = await db.select().from(opsExpectation);
    for (const j of ours) {
      expect(expectations.find((e) => e.name === j.name), j.name).toMatchObject({ kind: 'job', intervalSeconds: j.intervalSeconds, enabled: true });
    }
    const health = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie: admin } });
    const rows = (health.json() as { jobs: Array<{ name: string; lastOutcome: string | null }> }).jobs;
    for (const j of ours) expect(rows.find((r) => r.name === j.name)?.lastOutcome, j.name).toBe('ok');
  });

  it('no keys: each a no-op that says so, and nothing is called', async () => {
    stub.reset();
    const env = envFor([]);
    for (const name of ['attention', 'no_show'] as const) {
      const job = jobOf(name, () => BANGKOK_AT('2026-11-03', '12:00'), env);
      expect(await runnerFor(job, env).runJob(job.name, { force: true })).toBe('ok');
      const [run] = await runsOf(job.name);
      expect(detailOf(run!)).toMatchObject({ configured: false, due: false, groups: [], failed: 0 });
    }
    expect(stub.calls).toEqual([]);
  });

  it('Attention: every run asks every keyed park group (no date), and adds up what each raised — the first run’s burst kept rule by rule, never smoothed', async () => {
    stub.reset();
    const burst: Record<string, Record<string, number>> = {
      [tenantA]: { created: 400, updated: 0, resolved: 3, errors: 0, 'created.CONTRACT_NOT_SENT': 380, 'created.MISSING_LOGIN_ACCESS': 20 },
      [tenantB]: { created: 12, updated: 2, resolved: 1, errors: 0, 'created.EMPLOYEE_MISSING_ROLE': 12 },
    };
    stub.reply = (call) => ({ kind: 'answer', status: 200, body: answer('attention', call.tenantId, burst[call.tenantId]) });
    const job = jobOf('attention', () => BANGKOK_AT('2026-11-03', '02:00'));
    expect(await runnerFor(job).runJob(job.name, { force: true })).toBe('ok');
    const [run] = await runsOf(job.name);
    const detail = detailOf(run!);
    expect(detail.date).toBeNull();
    expect(detail.groups.map((g) => [g.tenantId, g.outcome])).toEqual([
      [tenantA, 'ran'],
      [tenantB, 'ran'],
    ]);
    // Each park group's own numbers stay in the run...
    expect(detail.groups.map((g) => g.steps![0]!.counts.created)).toEqual([400, 12]);
    // ...and the run adds them up, rule by rule.
    expect(detail.alerts).toEqual({
      created: 412,
      updated: 2,
      resolved: 4,
      byRule: { CONTRACT_NOT_SENT: 380, MISSING_LOGIN_ACCESS: 20, EMPLOYEE_MISSING_ROLE: 12 },
    });
    expect(await describeLatestNightRun(db, 'attention')).toMatch(/ran for 2 park groups; 412 new alerts raised, 2 updated, 4 resolved\.$/);
    // The next run asks again: there is no "done for the date" for a six-hourly run.
    stub.reset();
    expect(await runnerFor(job).runJob(job.name, { force: true })).toBe('ok');
    expect(stub.callsFor('attention').map((c) => c.tenantId)).toEqual([tenantA, tenantB]);
    expect(detailOf((await runsOf(job.name))[0]!).alerts).toEqual({ created: 0, updated: 0, resolved: 0, byRule: {} });
  });

  it('no-show: the 07:00-22:00 Bangkok fence — outside it nothing is called and the run says so; inside it every keyed park group is asked', async () => {
    for (const [time, due] of [
      ['06:59', false],
      ['07:00', true],
      ['12:30', true],
      ['21:59', true],
      ['22:00', false],
      ['23:30', false],
      ['03:00', false],
    ] as const) {
      stub.reset();
      const job = jobOf('no_show', () => BANGKOK_AT('2026-11-04', time));
      expect(await runnerFor(job).runJob(job.name, { force: true }), time).toBe('ok');
      const detail = detailOf((await runsOf(job.name))[0]!);
      expect(detail.due, time).toBe(due);
      if (due) {
        expect(stub.callsFor('no_show').map((c) => c.tenantId), time).toEqual([tenantA, tenantB]);
        expect(detail.alerts, time).toEqual({ created: 0, updated: 0, resolved: 0, byRule: {} });
      } else {
        expect(stub.calls, time).toEqual([]);
        expect(detail.reason, time).toBe('Not due outside 07:00-22:00 Bangkok time: the OTO App checks for no-shows only in those hours.');
      }
    }
  });

  it('once per window: a second tick inside the interval is not due, so the app is not even asked', async () => {
    for (const name of ['attention', 'no_show'] as const) {
      stub.reset();
      const job = jobOf(name, () => BANGKOK_AT('2026-11-04', '10:00'));
      await db.update(opsLast).set({ lastStartedAt: new Date(Date.now() - 7 * 3_600_000) }).where(eq(opsLast.name, job.name));
      const runner = runnerFor(job);
      expect(await runner.runJob(job.name), name).toBe('ok');
      expect(await runner.runJob(job.name), name).toBe('not_due');
      expect(stub.callsFor(name).map((c) => c.tenantId), name).toEqual([tenantA, tenantB]);
    }
  });

  it('two invocations at once: one runs and one is locked, and the app is asked once per park group', async () => {
    for (const name of ['attention', 'no_show'] as const) {
      stub.reset();
      let release: () => void = () => undefined;
      const until = new Promise<void>((resolve) => {
        release = resolve;
      });
      stub.reply = (call) => ({ kind: 'hold', until, then: stub.ok(call) });
      const job = jobOf(name, () => BANGKOK_AT('2026-11-04', '10:00'));
      const first = runnerFor(job).runJob(job.name, { force: true });
      while (stub.calls.length === 0) await sleep(10);
      const second = await runnerFor(job).runJob(job.name, { force: true });
      release();
      expect([await first, second], name).toEqual(['ok', 'locked']);
      expect(stub.callsFor(name).map((c) => c.tenantId), name).toEqual([tenantA, tenantB]);
    }
  });

  it('a failed step fails the run: the park group, the step and the words — and what it raised before failing is still counted', async () => {
    stub.reset();
    stub.reply = (call) =>
      call.tenantId === tenantB
        ? { kind: 'answer', status: 200, body: answer('attention', call.tenantId, { created: 5, updated: 0, resolved: 0, errors: 1, 'created.EMPLOYEE_MISSING_ROLE': 5 }, 'zz rule failed for one employee') }
        : stub.ok(call);
    const job = jobOf('attention', () => BANGKOK_AT('2026-11-04', '10:00'));
    expect(await runnerFor(job).runJob(job.name, { force: true })).toBe('failed');
    const [run] = await runsOf(job.name);
    expect(run!.errorCode).toBe(NIGHT_STEP_FAILED);
    expect(run!.errorMessage).toBe(
      `OTO App attention batch: park group ${tenantB}: attentionReconciliation failed (the batch carried on): zz rule failed for one employee`,
    );
    expect(detailOf(run!).alerts).toMatchObject({ created: 5, byRule: { EMPLOYEE_MISSING_ROLE: 5 } });
  });

  it('an OTO App that does not know the batch yet (deployed after the api) fails the run in the app’s own words', async () => {
    stub.reset();
    stub.reply = () => ({
      kind: 'answer',
      status: 404,
      body: { error: 'job_not_found', message: 'There is no night job of that name. The night jobs are midnight, reconcile, presence.' },
    });
    const job = jobOf('no_show', () => BANGKOK_AT('2026-11-04', '10:00'));
    expect(await runnerFor(job).runJob(job.name, { force: true })).toBe('failed');
    const [run] = await runsOf(job.name);
    expect(run!.errorCode).toBe('OTOAPP_JOB_NOT_FOUND');
    expect(run!.errorMessage).toMatch(/OTOAPP_JOB_NOT_FOUND: There is no night job of that name/);
  });

  it('the Console: Run now for each, offered to the platform administrator only', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/ops/test-controls', headers: { cookie: admin } });
    const keys = (list.json() as { controls: Array<{ key: string }> }).controls.map((c) => c.key);
    const ours = ['otoapp.attention', 'otoapp.attention.fail', 'otoapp.no_show', 'otoapp.no_show.fail'];
    expect(keys).toEqual(expect.arrayContaining(ours));
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    for (const k of ours) expect((await press(k, reception)).statusCode, k).toBe(403);
    stub.reset();
    const res = await press('otoapp.attention');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().message).toBe('job:otoapp.attention ran (ok): ran for 1 park group; 0 new alerts raised, 0 updated, 0 resolved.');
    expect(stub.callsFor('attention', tenantA)).toHaveLength(1);
    const noShow = await press('otoapp.no_show');
    expect(noShow.statusCode, noShow.body).toBe(200);
    expect(noShow.json().message).toMatch(/^job:otoapp\.no_show ran \(ok\): (ran for 1 park group; 0 new alerts raised, 0 updated, 0 resolved\.|Not due outside 07:00-22:00 Bangkok time)/);
  });

  it('the deliberate failures: each lands on Failures, nothing reaches the app, and its Retry runs the job for real', async () => {
    for (const [control, job] of [
      ['otoapp.attention.fail', OTOAPP_ATTENTION_JOB],
      ['otoapp.no_show.fail', OTOAPP_NO_SHOW_JOB],
    ] as const) {
      stub.reset();
      const res = await press(control);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().message).toMatch(new RegExp(`deliberately failed run of ${job.replace('.', '\\.')} \\(failed\\)`));
      expect(stub.calls).toEqual([]);
      const failures = await ctx.app.inject({ method: 'GET', url: '/ops/failures', headers: { cookie: admin } });
      const group = (failures.json() as { groups: Array<{ name: string; kind: string; retryable: boolean; lastRunId: string; lastError: string }> }).groups.find(
        (g) => g.name === job,
      );
      expect(group, job).toMatchObject({ kind: 'job', retryable: true });
      expect(group!.lastError).toMatch(new RegExp(`^${FORCED_FAILURE_CODE}: Deliberate failure`));
      const retry = await ctx.app.inject({
        method: 'POST',
        url: `/ops/runs/${group!.lastRunId}/retry`,
        headers: { cookie: admin, 'idempotency-key': randomUUID() },
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ ok: true, outcome: 'ok' });
      // The attention Retry asks the app; the no-show Retry does too when Bangkok is inside its hours.
      if (job === OTOAPP_ATTENTION_JOB) expect(stub.callsFor('attention', tenantA)).toHaveLength(1);
      const [latest] = await runsOf(job);
      expect(latest!.outcome).toBe('ok');
    }
  });

  describe('review F1 on the two new jobs: a park group the app holds staff in, with no key here', () => {
    const tenantU = randomUUID();
    const employeeU = randomUUID();
    beforeAll(async () => {
      await appPool.query(`insert into tenants (id, name, slug) values ($1, 'ZZ r4b unkeyed', $2)`, [tenantU, `zz-r4b-u-${tenantU.slice(-6)}`]);
      await appPool.query(`insert into employees (id, tenant_id, full_name, nickname, email) values ($1, $2, 'ZZ r4b unkeyed', 'ZZ', $3)`, [
        employeeU,
        tenantU,
        `zz-r4b-unkeyed-${tenantU.slice(-6)}@example.com`,
      ]);
    });
    afterAll(async () => {
      // So the real-app section below reads only its own park groups.
      await appPool.query('delete from employees where id = $1', [employeeU]);
    });

    it('both fail naming it while the keyed park groups still run; the no-show check outside its hours checks nothing and fails nothing', async () => {
      for (const [name, time] of [
        ['attention', '02:00'],
        ['no_show', '10:00'],
      ] as const) {
        stub.reset();
        const job = jobOf(name, () => BANGKOK_AT('2026-11-05', time));
        expect(await runnerFor(job).runJob(job.name, { force: true }), name).toBe('failed');
        const [run] = await runsOf(job.name);
        expect(run!.errorCode, name).toBe(NIGHT_JOB_UNKEYED);
        expect(detailOf(run!).groups.map((g) => [g.tenantId, g.outcome]), name).toEqual([
          [tenantA, 'ran'],
          [tenantB, 'ran'],
          [tenantU, 'failed'],
        ]);
        expect(stub.callsFor(name).map((c) => c.tenantId), name).toEqual([tenantA, tenantB]);
      }
      stub.reset();
      const night = jobOf('no_show', () => BANGKOK_AT('2026-11-05', '23:00'));
      expect(await runnerFor(night).runJob(night.name, { force: true })).toBe('ok');
      expect(stub.calls).toEqual([]);
    });
  });
});

// =============================================================================
// E. The real app
// =============================================================================

describe.skipIf(!HAS_APP_RUNTIME)('E. the real app: its two checks, and the platform’s two jobs against it', () => {
  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const child of children) child.kill();
  });

  const runCheck = async (file: string, marker: RegExp) => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      const result = spawnSync(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), file], {
        cwd: APP_DIR,
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 280_000,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      expect(output).toMatch(marker);
      // Every row the check wrote through the routes and the batches carries its park group.
      const back = readback(url);
      expect(back.status, back.output).toBe(0);
      return output;
    } finally {
      await drop();
    }
  };

  it('apps/oto-app/tests/tenant-ownership.check.ts (settings per park group, the logbook, H12) passes against a fresh database', async () => {
    await runCheck('tests/tenant-ownership.check.ts', /tenant-ownership\.check: \d+ checks passed/);
  }, 300_000);

  it('apps/oto-app/tests/attention.check.ts (Attention per park group, H20) passes against a fresh database', async () => {
    await runCheck('tests/attention.check.ts', /attention\.check: \d+ checks passed/);
  }, 300_000);

  it('the platform’s Attention job against the real app: each park group’s items in its own, a second run raising nothing new (H20)', async () => {
    const ctx = await createTestContext({ otoapp: true });
    const pool = new pg.Pool({
      connectionString: (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!,
      options: '-c search_path=otoapp',
      max: 4,
    });
    try {
      const q = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;
      const groups: Array<{ tenant: string; key: string; employee: string }> = [];
      for (const label of ['r1', 'r2']) {
        const tenant = randomUUID();
        await q(`insert into tenants (id, name, slug) values ($1, $2, $3)`, [tenant, `ZZ r4b ${label}`, `zz-r4b-${label}-${tenant.slice(-6)}`]);
        const branch = randomUUID();
        await q(`insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ')`, [branch, tenant, `ZZ r4b ${label}`]);
        const employee = randomUUID();
        await q(
          `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, created_at)
           values ($1, $2, $3, $4, 'ZZ', $5, 'active', now() - interval '10 days')`,
          [employee, tenant, branch, `ZZ r4b ${label}`, `zz-r4b-${label}-${employee.slice(0, 8)}@example.com`],
        );
        const k = key();
        await q(`insert into directory_clients (tenant_id, name, key_hash, scopes) values ($1, 'ZZ r4b', $2, $3)`, [
          tenant,
          createHash('sha256').update(k).digest('hex'),
          ['jobs:run'],
        ]);
        groups.push({ tenant, key: k, employee });
      }
      const dbUrl = (ctx.db as unknown as { $client: pg.Pool }).$client.options.connectionString!;
      const child = spawn(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/harness/serve-routes.ts'], {
        cwd: APP_DIR,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          APP_ENV: 'dev',
          STORAGE_ENV_PREFIX: 'zz-r4b',
          OBJECT_STORAGE: 'local',
          OTOAPP_LEGACY_LOGIN: 'true',
          LOG_LEVEL: 'warn',
          DEPLOY_ENV: 'local',
          TZ: 'UTC',
          OTOAPP_JOBS: 'platform',
          DATABASE_URL: dbUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      const origin = await new Promise<string>((resolve, reject) => {
        let output = '';
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
      const env = loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://oto:oto@localhost:1/unused',
        PROCESS_ROLES: 'api,jobs',
        OTOAPP_DIRECTORY_URL: origin,
        OTOAPP_JOBS_KEYS: groups.map((g) => `${g.tenant}:${g.key}`).join(','),
        OTOAPP_JOBS_TIMEOUT_MS: '60000',
      });
      const job = buildOtoAppNightJobs({ env, log: ctx.app.log }).find((j) => j.name === OTOAPP_ATTENTION_JOB)!;
      const runner = createJobRunner({ db: ctx.db, env, log: ctx.app.log, channels: [], jobs: [job] });
      expect(await runner.runJob(job.name, { force: true })).toBe('ok');
      const latest = async () =>
        (await ctx.db.select().from(opsRun).where(eq(opsRun.name, OTOAPP_ATTENTION_JOB)).orderBy(desc(opsRun.startedAt)).limit(1))[0]!;
      const firstDetail = (await latest()).detail as NightJobSummary;
      expect(firstDetail.groups.map((g) => g.outcome)).toEqual(['ran', 'ran']);
      const items = await q<{ tenant_id: string; employee_id: string }>(
        `select tenant_id, employee_id from attention_items where employee_id = any($1)`,
        [groups.map((g) => g.employee)],
      );
      expect(items.length).toBe(firstDetail.alerts!.created);
      expect(items.length).toBeGreaterThanOrEqual(6);
      for (const g of groups) {
        const theirs = items.filter((i) => i.employee_id === g.employee);
        expect(theirs.length).toBeGreaterThanOrEqual(3);
        for (const i of theirs) expect(i.tenant_id).toBe(g.tenant);
      }
      expect(await runner.runJob(job.name, { force: true })).toBe('ok');
      expect(((await latest()).detail as NightJobSummary).alerts!.created).toBe(0);
      const again = await q(`select 1 from attention_items where employee_id = any($1)`, [groups.map((g) => g.employee)]);
      expect(again.length).toBe(items.length);
    } finally {
      await pool.end();
      await ctx.close();
    }
  }, 300_000);
});
