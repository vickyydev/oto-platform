import { createHash, randomUUID } from 'node:crypto';
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
 * S2-17b round 7 (SCRUM-191), the adversarial review: a failed gate across
 * two document tables; contradictory people links; a settled/deferred census;
 * and the real writer failure/replay check in s217b-r7-finance.test.ts.
 *
 * FINDING 1 (medium), prescribed fix applied: PL's raw row and all cell
 * batches must use its transaction connection. Tracking categories/options
 * and cash upserts/daily rebuilding likewise commit or roll back together.
 * The four injected failures are passing pins in tests/finance.check.ts.
 * FINDING 2 (low), standing Q55: no P&L cell identity has been approved.
 * Prescribed disposition: retain snapshots and repeated labels; ask which
 * identifier makes a cell unique before adding the planned extra unique.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const MIGRATIONS = join(APP, 'migrations');
const SQL = readFileSync(join(MIGRATIONS, '0009_document_finance_constraints.sql'), 'utf8');
type Journal = { entries: { idx: number; tag: string }[] };

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
  const dir = mkdtempSync(join(tmpdir(), 'oto-r7-review-'));
  const j = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
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
    // This path is the absolute directory mkdtemp created inside the OS temp root.
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fixture<T>(work: (url: string) => Promise<T>): Promise<T> {
  const db = await createTestDatabase();
  try {
    await apply(db.url, 8);
    return await work(db.url);
  } finally {
    await db.drop();
  }
}

describe('S2-17b round 7 finance review', () => {
  it('keeps applied 0008 immutable and its placement statements unchanged', () => {
    const expand = readFileSync(join(MIGRATIONS, '0008_document_tenant_ownership_expand.sql'), 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(expand).digest('hex')).toBe('f02a04fec5dc92c6d158bed0b5d15572a938495354dab67bbb31f8c080b87992');
    const placement = expand.slice(expand.indexOf('-- templates: its branches'), expand.indexOf('CREATE INDEX "idx_asset_catalog_tenant"'));
    expect(SQL.replace(/\r\n/g, '\n')).toContain(placement);
  }, 120_000);

  it('counts two unforeseen unplaced sets, leaves no partial ownership and retries', async () => {
    await fixture(async (url) => {
      await query(url, async (c) => {
        await c.query("insert into templates(name,html_body) values ('ZZ TEST Late','<p>ZZ TEST</p>')");
        await c.query("insert into policy_documents(title) values ('ZZ TEST Late Policy')");
        await c.query(`create function zz_test_hold_null() returns trigger language plpgsql as $$ begin return null; end $$`);
        for (const table of ['templates', 'policy_documents']) await c.query(`create trigger zz_test_hold before update on ${table} for each row execute function zz_test_hold_null()`);
      });
      await expect(apply(url, 9)).rejects.toThrow('unplaced rows templates=1, policy_documents=1, asset_catalog=0, leave_policies=0');
      await query(url, async (c) => {
        expect((await c.query('select count(*)::int as n from tenants')).rows[0].n).toBe(0);
        expect((await c.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n).toBe(9);
        for (const table of ['templates', 'policy_documents']) await c.query(`drop trigger zz_test_hold on ${table}`);
        await c.query('drop function zz_test_hold_null()');
      });
      await apply(url, 9);
      await query(url, async (c) => {
        expect((await c.query('select count(*)::int as n from tenants')).rows[0].n).toBe(1);
        expect((await c.query("select count(*)::int as n from templates where tenant_id is null")).rows[0].n).toBe(0);
      });
    });
  }, 120_000);

  it('places people only when all policy and employee anchors agree', async () => {
    await fixture(async (url) => {
      const a = randomUUID(), b = randomUUID();
      await query(url, async (c) => {
        await c.query("insert into tenants(id,name,slug) values ($1,'ZZ TEST A','zz-test-a'),($2,'ZZ TEST B','zz-test-b')", [a, b]);
        for (const id of ['agree', 'mixed', 'orphan', 'employee']) await c.query(
          "insert into people(id,full_name,email,person_type) values ($1,$2,$3,'ADVISOR')", [`zz-test-${id}`, `ZZ TEST ${id}`, `${id}@zz-test.invalid`],
        );
        await c.query(`insert into access_policies(tenant_id,person_id,access_level,modules,branch_scope)
          values ($1,'zz-test-agree','MANAGER','{}','ALL'),($1,'zz-test-mixed','MANAGER','{}','ALL')`, [a]);
        for (const [id, tenant] of [['agree', a], ['mixed', b], ['employee', b]]) await c.query(
          'insert into employees(tenant_id,person_id,full_name,nickname,email) values ($1,$2,$3,$3,$4)',
          [tenant, `zz-test-${id}`, `ZZ TEST ${id}`, `employee-${id}@zz-test.invalid`],
        );
      });
      await apply(url, 9);
      await query(url, async (c) => {
        const owners = Object.fromEntries((await c.query('select id,tenant_id from people')).rows.map((r) => [r.id, r.tenant_id]));
        expect(owners).toEqual({ 'zz-test-agree': a, 'zz-test-mixed': null, 'zz-test-orphan': null, 'zz-test-employee': b });
        expect((await c.query('select count(*)::int as n from tenants')).rows[0].n).toBe(2);
        await c.query("insert into people(tenant_id,full_name,email,person_type) values ($1,'ZZ TEST Unlinked','new@zz-test.invalid','ADVISOR')", [a]);
        expect((await c.query("select count(*)::int as n from access_policies where person_id=(select id from people where email='new@zz-test.invalid')")).rows[0].n).toBe(0);
      });
    });
  }, 120_000);

  it('retries a settled offboarding index without deleting any document rows', async () => {
    await fixture(async (url) => {
      await query(url, (c) => c.query('drop index employee_offboarding_employee_unique'));
      await apply(url, 9);
      await query(url, async (c) => {
        expect((await c.query("select count(*)::int as n from pg_indexes where schemaname='otoapp' and indexname='employee_offboarding_employee_unique'")).rows[0].n).toBe(1);
      });
    });
  }, 120_000);

  it('FINDING 1 (medium), fixed: every finance batch uses the transaction writer', () => {
    const source = readFileSync(join(APP, 'server', 'finance-sync.ts'), 'utf8');
    expect(source.match(/await db\.transaction\(async \(tx\)/g)).toHaveLength(3);
    expect(source).not.toContain('client.query("BEGIN")');
    expect(source).toContain('await tx.insert(plFacts)');
    expect(source).toContain('await rebuildCashDaily(tenantId, fromDate, toDate, tx)');
  }, 120_000);

  it('FINDING 3 (high), fixed: every finance read and sync resolves its own park mapping', () => {
    const routes = readFileSync(join(APP, 'server', 'finance-sync-routes.ts'), 'utf8');
    expect(routes.match(/await resolveFinanceOrganisation\(req\)/g)).toHaveLength(7);
    expect(routes).not.toContain('from(xeroTokens)');
    const helper = readFileSync(join(APP, 'server', 'lib', 'financeOrganisationAccess.ts'), 'utf8');
    expect(helper).toContain('req.userWithAccess?.tenantId');
    expect(helper).toContain('eq(xeroTokens.tenantId, parkGroup)');
    expect(helper).toContain('mappings.some((mapping) => mapping.parkGroup !== parkGroup)');
  });

  it('FINDING 4 (high), fixed: Xero status, reports, disconnect and callback stay in the signed-in park', () => {
    const source = readFileSync(join(APP, 'server', 'xero-routes.ts'), 'utf8');
    expect(source.match(/await getActiveTokenSet\(financeParkGroup\(req\)\)/g)).toHaveLength(7);
    expect(source).toContain('eq(xeroTokens.tenantId, identity.parkGroup)');
    expect(source).toContain('tenantId: identity.parkGroup');
    expect(source).toContain('eq(xeroTokens.tenantId, parkGroup)');
    expect(source).toContain('pending.userId !== req.user?.id');
    expect(source).toContain('req.session.reload');
    expect(source).toContain('delete req.session.xeroConnection');
  });

  it.fails('FINDING 2 (low), Q55: prescribed disposition is an agreed cell identity before a P&L unique', () => {
    const statements = SQL.replace(/--.*$/gm, '');
    expect(statements).toMatch(/CREATE UNIQUE INDEX[^;]+"pl_facts"/);
  }, 120_000);
});
