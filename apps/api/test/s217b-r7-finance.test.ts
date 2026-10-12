import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/** S2-17b round 7, H16: committed migration, hand-over, census and real writers. */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const MIGRATIONS = join(APP, 'migrations');
const DOC_TABLES = ['asset_catalog', 'leave_policies', 'policy_documents', 'templates'];
const FINANCE_TABLES = ['cash_daily', 'cash_txns', 'xero_tracking_categories', 'xero_tracking_options'];
const HAS_APP = existsSync(join(APP, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
type Journal = { entries: { idx: number; tag: string; when: number }[] };
const journal = () => JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;

async function query<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('set search_path to otoapp');
    return await work(c);
  } finally {
    await c.end();
  }
}

async function apply(url: string, idx: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'oto-r7-finance-'));
  const j = journal();
  const entries = j.entries.filter((e) => e.idx <= idx);
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...j, entries }));
  for (const e of entries) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  try {
    await query(url, (c) => migrate(drizzle(c), { migrationsFolder: dir, migrationsSchema: 'otoapp' }));
  } catch (err) {
    const messages: string[] = [];
    let cause: unknown = err;
    while (cause instanceof Error) {
      messages.push(cause.message);
      cause = cause.cause;
    }
    throw new Error(messages.join('\n'));
  } finally {
    // The resolved directory came directly from mkdtemp inside the OS temp root.
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fixture<T>(idx: number, work: (url: string) => Promise<T>): Promise<T> {
  const db = await createTestDatabase();
  try {
    await apply(db.url, idx);
    return await work(db.url);
  } finally {
    await db.drop();
  }
}

describe('S2-17b round 7 finance and document keys', () => {
  it('journals the one forward migration after the deployed expand', () => {
    const entries = journal().entries;
    expect(entries[9]?.tag).toBe('0009_document_finance_constraints');
    expect(entries[9]?.when).toBeGreaterThan(entries[8]!.when);
    const sql = readFileSync(join(MIGRATIONS, `${entries[9]!.tag}.sql`), 'utf8');
    expect(sql).not.toContain('"public".');
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|RENAME COLUMN|DELETE FROM)\b/i);
  }, 120_000);

  it('runs the empty chain twice without extra ownership or journal rows', async () => {
    await fixture(9, async (url) => {
      await apply(url, 9);
      await query(url, async (c) => {
        expect((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n).toBe(10);
        expect((await c.query('select count(*)::int as n from tenants')).rows[0].n).toBe(0);
        const columns = (await c.query(`select table_name, is_nullable from information_schema.columns
          where table_schema='otoapp' and column_name='tenant_id' and table_name=any($1)`, [DOC_TABLES])).rows;
        expect(columns).toHaveLength(4);
        expect(columns.every((r) => r.is_nullable === 'NO')).toBe(true);
        expect((await c.query(`select count(*)::int as n from pg_constraint c
          join pg_class t on t.oid=c.conrelid join pg_namespace s on s.oid=t.relnamespace
          where s.nspname='otoapp' and c.contype='p' and t.relname=any($1)`, [FINANCE_TABLES])).rows[0].n).toBe(4);
      });
    });
  }, 120_000);

  it('places hand-over rows by the unchanged 0008 rule and preserves owned rows', async () => {
    await fixture(8, async (url) => {
      const a = randomUUID(), b = randomUUID();
      await query(url, async (c) => {
        await c.query("insert into tenants(id,name,slug) values ($1,'ZZ TEST A','default'),($2,'ZZ TEST B','zz-test-b')", [a, b]);
        await c.query("insert into branches(id,tenant_id,name,address) values ('zz-test-b',$1,'ZZ TEST Branch B','ZZ TEST Address')", [b]);
        await c.query("insert into templates(id,name,html_body) values ('zz-test-template','ZZ TEST Template','<p>ZZ TEST</p>')");
        await c.query("insert into policy_documents(id,title,branch_id) values ('zz-test-policy','ZZ TEST Policy','zz-test-b')");
        await c.query("insert into asset_catalog(id,name) values ('zz-test-asset','ZZ TEST Asset')");
        await c.query("insert into leave_policies(id,name,branch_id,days_worked_required,days_off_earned) values ('zz-test-leave','ZZ TEST Leave','zz-test-b',5,2)");
        await c.query("insert into templates(id,tenant_id,name,html_body) values ('zz-test-owned',$1,'ZZ TEST Owned','<p>ZZ TEST</p>')", [b]);
      });
      await apply(url, 9);
      await query(url, async (c) => {
        expect((await c.query("select tenant_id from templates where id='zz-test-template'")).rows[0].tenant_id).toBe(a);
        expect((await c.query("select tenant_id from templates where id='zz-test-owned'")).rows[0].tenant_id).toBe(b);
        expect((await c.query("select tenant_id from policy_documents where id='zz-test-policy'")).rows[0].tenant_id).toBe(b);
        expect((await c.query("select tenant_id from asset_catalog where id='zz-test-asset'")).rows[0].tenant_id).toBe(a);
        expect((await c.query("select tenant_id from leave_policies where id='zz-test-leave'")).rows[0].tenant_id).toBe(b);
        await expect(c.query("insert into templates(name,html_body) values ('ZZ TEST Refused','<p>ZZ TEST</p>')")).rejects.toMatchObject({ code: '23502' });
      });
    });
  }, 120_000);

  it('reports all four duplicate groups and rolls back placement before retry', async () => {
    await fixture(8, async (url) => {
      await query(url, async (c) => {
        await c.query("insert into tenants(name,slug) values ('ZZ TEST A','default')");
        await c.query("insert into templates(id,name,html_body) values ('zz-test-late','ZZ TEST Late','<p>ZZ TEST</p>')");
        await c.query("insert into xero_tracking_categories(tenant_id,tracking_category_id,name,raw_json) select 'ZZ TEST Xero','category','ZZ TEST Category','{}'::jsonb from generate_series(1,2)");
        await c.query("insert into xero_tracking_options(tenant_id,tracking_category_id,tracking_option_id,name) select 'ZZ TEST Xero','category','option','ZZ TEST Option' from generate_series(1,2)");
        await c.query("insert into cash_txns(tenant_id,xero_bank_transaction_id,date,total,direction,raw_json) select 'ZZ TEST Xero','txn','2026-10-12',1,'in','{}'::jsonb from generate_series(1,2)");
        await c.query("insert into cash_daily(tenant_id,date) select 'ZZ TEST Xero','2026-10-12' from generate_series(1,2)");
      });
      await expect(apply(url, 9)).rejects.toThrow('duplicate keys xero_tracking_categories=1, xero_tracking_options=1, cash_txns=1, cash_daily=1');
      await query(url, async (c) => {
        expect((await c.query("select tenant_id from templates where id='zz-test-late'")).rows[0].tenant_id).toBeNull();
        expect((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n).toBe(9);
        expect((await c.query("select count(*)::int as n from information_schema.columns where table_schema='otoapp' and table_name='people' and column_name='tenant_id'")).rows[0].n).toBe(0);
        for (const table of FINANCE_TABLES) await c.query(`delete from ${table} where ctid not in (select distinct on (tenant_id) ctid from ${table} order by tenant_id, ctid)`);
      });
      await apply(url, 9);
      await apply(url, 9);
      await query(url, async (c) => {
        expect((await c.query("select tenant_id from templates where id='zz-test-late'")).rows[0].tenant_id).not.toBeNull();
        expect((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n).toBe(10);
      });
    });
  }, 120_000);

  it.skipIf(!HAS_APP)('proves actual app upserts, failure rollback and snapshot behaviour', async () => {
    await fixture(9, async (url) => {
      const run = spawnSync(process.execPath, [join(APP, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(APP, 'tests', 'finance.check.ts')], {
        cwd: APP, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 60_000,
      });
      expect(run.status, `${run.stdout ?? ''}\n${run.stderr ?? ''}`).toBe(0);
      expect(run.stdout).toContain('finance.check: four upsert keys');
    });
  }, 120_000);
});
