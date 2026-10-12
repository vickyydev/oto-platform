import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * S2-17b round 7b (SCRUM-191): the contraction AFTER R7a writers are live.
 * FINDING 1 (high, prescribed fix applied): retain the old omitted-owner
 * writer through0009; SET NOT NULL belongs to this subsequent release0010.
 * The 0009 hash pin preserves the separate landed expand shape. Runtime pins
 * drive a late omitted-owner write, another park's branch, an unforeseen
 * null-preserving trigger, the gate rollback/retry and a repeated migration.
 */
const MIGRATIONS = fileURLToPath(new URL('../../oto-app/migrations/', import.meta.url));
const TABLES = ['templates', 'policy_documents', 'asset_catalog', 'leave_policies'];
const SQL = readFileSync(join(MIGRATIONS, '0010_document_tenant_ownership_contract.sql'), 'utf8');
type Entry = { idx: number; tag: string };

async function query<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('set search_path to otoapp');
    return await work(c);
  } finally { await c.end(); }
}

async function apply(url: string, idx: number): Promise<void> {
  const j = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: Entry[] };
  const entries = j.entries.filter((entry) => entry.idx <= idx);
  const directory = mkdtempSync(join(tmpdir(), 'oto-r7b-documents-'));
  mkdirSync(join(directory, 'meta'));
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...j, entries }));
  for (const entry of entries) copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  try {
    await query(url, (c) => migrate(drizzle(c), { migrationsFolder: directory, migrationsSchema: 'otoapp' }));
  } catch (err) {
    const messages: string[] = [];
    let cause: unknown = err;
    while (cause instanceof Error) { messages.push(cause.message); cause = cause.cause; }
    throw new Error(messages.join('\n'));
  } finally {
    // mkdtemp returned this absolute path inside the OS temp root.
    rmSync(directory, { recursive: true, force: true });
  }
}

async function fixture<T>(last: number, work: (url: string) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try { await apply(database.url, last); return await work(database.url); }
  finally { await database.drop(); }
}

describe('S2-17b round 7b document contraction review', () => {
  it('FINDING 1 (high, fixed): keeps0009 compatible and journals contraction separately', () => {
    const expand = readFileSync(join(MIGRATIONS, '0009_document_finance_constraints.sql'), 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(expand).digest('hex')).toBe('0c0627113533e9acabbda48d47695af7fa199e2571556fdc518d3b4244c7b7e2');
    expect(expand.replace(/--.*$/gm, '')).not.toContain('SET NOT NULL');
    const statements = SQL.replace(/--.*$/gm, '');
    expect(statements.match(/ALTER COLUMN "tenant_id" SET NOT NULL/g)).toHaveLength(4);
    expect(statements).not.toMatch(/ADD COLUMN|PRIMARY KEY|DROP|RENAME/i);
    expect(statements.indexOf('LOCK TABLE "employee_offboarding"')).toBeLessThan(statements.indexOf('LOCK TABLE "employees"'));
  });

  it('runs from empty twice without extra journal or park-group rows', async () => {
    await fixture(10, async (url) => {
      await apply(url, 10);
      await query(url, async (c) => {
        expect((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n).toBe(11);
        expect((await c.query('select count(*)::int as n from tenants')).rows[0].n).toBe(0);
        const nullable = (await c.query(`select is_nullable from information_schema.columns
          where table_schema='otoapp' and column_name='tenant_id' and table_name=any($1)`, [TABLES])).rows;
        expect(nullable).toHaveLength(4);
        expect(nullable.every((row) => row.is_nullable === 'NO')).toBe(true);
      });
    });
  }, 120_000);

  it('places late R6 writes by their branches/default and leaves owned rows untouched', async () => {
    await fixture(9, async (url) => {
      await query(url, async (c) => {
        await c.query("insert into tenants(id,name,slug) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ZZ TEST Default','default'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','ZZ TEST Other','zz-test-other')");
        await c.query("insert into branches(id,tenant_id,name,address) values ('zz-test-other','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','ZZ TEST Other Branch','ZZ TEST Address')");
        await c.query("insert into templates(id,name,html_body) values ('zz-test-late-template','ZZ TEST Late Template','<p>ZZ TEST</p>')");
        await c.query("insert into policy_documents(id,title,branch_id) values ('zz-test-late-policy','ZZ TEST Late Policy','zz-test-other')");
        await c.query("insert into asset_catalog(id,name) values ('zz-test-late-asset','ZZ TEST Late Asset')");
        await c.query("insert into leave_policies(id,name,branch_id,days_worked_required,days_off_earned) values ('zz-test-late-leave','ZZ TEST Late Leave','zz-test-other',5,2)");
        await c.query("insert into templates(id,tenant_id,name,html_body) values ('zz-test-owned','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','ZZ TEST Owned','<p>ZZ TEST</p>')");
      });
      await apply(url, 10);
      await apply(url, 10);
      await query(url, async (c) => {
        expect((await c.query("select tenant_id from templates where id='zz-test-late-template'")).rows[0].tenant_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
        expect((await c.query("select tenant_id from asset_catalog where id='zz-test-late-asset'")).rows[0].tenant_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
        expect((await c.query("select tenant_id from policy_documents where id='zz-test-late-policy'")).rows[0].tenant_id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
        expect((await c.query("select tenant_id from leave_policies where id='zz-test-late-leave'")).rows[0].tenant_id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
        expect((await c.query("select tenant_id from templates where id='zz-test-owned'")).rows[0].tenant_id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
        await expect(c.query("insert into templates(name,html_body) values ('ZZ TEST Omitted Owner','<p>ZZ TEST</p>')")).rejects.toMatchObject({ code: '23502' });
        const row = (await c.query("insert into templates(tenant_id,name,html_body) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','ZZ TEST Current Writer','<p>ZZ TEST</p>') returning tenant_id")).rows[0];
        expect(row.tenant_id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
      });
    });
  }, 120_000);

  it('names both unplaced sets, rolls back and contracts only after retry succeeds', async () => {
    await fixture(9, async (url) => {
      await query(url, async (c) => {
        await c.query("insert into templates(name,html_body) values ('ZZ TEST Held Template','<p>ZZ TEST</p>')");
        await c.query("insert into policy_documents(title) values ('ZZ TEST Held Policy')");
        await c.query('create function zz_test_hold_owner() returns trigger language plpgsql as $$ begin return null; end $$');
        for (const table of ['templates', 'policy_documents']) await c.query(`create trigger zz_test_hold before update on ${table} for each row execute function zz_test_hold_owner()`);
      });
      await expect(apply(url, 10)).rejects.toThrow('unplaced rows templates=1, policy_documents=1, asset_catalog=0, leave_policies=0');
      await query(url, async (c) => {
        expect((await c.query('select count(*)::int as n from tenants')).rows[0].n).toBe(0);
        expect((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n).toBe(10);
        const columns = (await c.query(`select is_nullable from information_schema.columns
          where table_schema='otoapp' and column_name='tenant_id' and table_name=any($1)`, [TABLES])).rows;
        expect(columns.every((row) => row.is_nullable === 'YES')).toBe(true);
        for (const table of ['templates', 'policy_documents']) await c.query(`drop trigger zz_test_hold on ${table}`);
        await c.query('drop function zz_test_hold_owner()');
      });
      await apply(url, 10);
      await query(url, async (c) => {
        const columns = (await c.query(`select is_nullable from information_schema.columns
          where table_schema='otoapp' and column_name='tenant_id' and table_name=any($1)`, [TABLES])).rows;
        expect(columns.every((row) => row.is_nullable === 'NO')).toBe(true);
      });
    });
  }, 120_000);
});
