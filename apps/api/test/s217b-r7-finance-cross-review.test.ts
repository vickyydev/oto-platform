import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * S2-17b round 7 (SCRUM-191), independent concurrency review.
 * FINDING 1 (medium): acquire offboarding before employees so a transaction
 * following the app's insert-then-update order and 0009 both finish.
 * FINDING 2 (medium): hold a per-Xero-organisation transaction lock before
 * cash upserts/rebuilding; distinct imports for one day must sum together.
 * Existing snapshot behaviour and its standing Q55 pin remain in the builder
 * review. No finance values or credentials from staging are used here.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const MIGRATIONS = join(APP, 'migrations');
const HAS_APP = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
type Entry = { idx: number; tag: string };
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
  entries: Entry[];
};
let overlapProof: { reached: boolean; code: string | null } | null = null;
let cashProof: { ledger: string; daily: string; reached: boolean } | null = null;

async function client(url: string, name: string): Promise<pg.Client> {
  const result = new pg.Client({ connectionString: url, application_name: name });
  await result.connect();
  await result.query('set search_path to otoapp');
  return result;
}

async function apply(c: pg.Client, last: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'oto-r7-cross-'));
  const entries = journal.entries.filter((entry) => entry.idx <= last);
  mkdirSync(join(directory, 'meta'));
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  try {
    await migrate(drizzle(c), { migrationsFolder: directory, migrationsSchema: 'otoapp' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 750; i += 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('ZZ TEST controlled overlap did not reach its barrier');
}

describe('S2-17b round 7 finance independent concurrency review', () => {
  it(
    'FINDING 1 (medium, fixed): migration and the app’s offboarding both finish; prescribed fix: take employee_offboarding before employees at final lock strength',
    async () => {
      const database = await createTestDatabase();
      const writer = await client(database.url, 'zz-test-offboarding-writer');
      const migration = await client(database.url, 'zz-test-finance-migration');
      const observer = await client(database.url, 'zz-test-finance-observer');
      try {
        await apply(observer, 8);
        const park = randomUUID();
        const creator = randomUUID();
        await observer.query(
          "insert into tenants(id,name,slug) values ($1,'ZZ TEST Cross Review','zz-test-cross-review')",
          [park],
        );
        await observer.query(
          "insert into users(id,email,password,full_name) values ($1,'cross-user@zz-test.invalid',$2,'ZZ TEST Cross Creator')",
          [creator, randomBytes(24).toString('hex')],
        );
        await observer.query(
          "insert into employees(id,tenant_id,full_name,nickname,email) values ('zz-test-cross-employee',$1,'ZZ TEST Cross Employee','ZZ TEST Cross','cross@zz-test.invalid')",
          [park],
        );
        await migration.query("set deadlock_timeout to '100ms'");
        const pid = (await migration.query('select pg_backend_pid() as pid')).rows[0].pid;
        await writer.query('begin');
        await writer.query(
          "insert into employee_offboarding(employee_id,offboarding_type,reason_code,last_working_day,created_by) values ('zz-test-cross-employee','resignation','personal_reasons',now(),$1)",
          [creator],
        );
        const migrated = apply(migration, 9)
          .then(() => ({ ok: true, code: null }))
          .catch((error: unknown) => {
            let cause = error as { code?: string; cause?: unknown };
            while (cause.cause) cause = cause.cause as typeof cause;
            return { ok: false, code: cause.code ?? null };
          });
        await eventually(
          async () =>
            Number(
              (
                await observer.query(
                  `select count(*) as n from pg_locks l
        join pg_class t on t.oid=l.relation where l.pid=$1 and t.relname='employee_offboarding' and not l.granted`,
                  [pid],
                )
              ).rows[0].n,
            ) === 1,
        );
        const updated = await writer
          .query(
            "update employees set nickname='ZZ TEST Finished' where id='zz-test-cross-employee'",
          )
          .then(() => true)
          .catch(() => false);
        await writer.query(updated ? 'commit' : 'rollback');
        const completed = await migrated;
        overlapProof = { reached: true, code: completed.code };
        // Before the prescription, one of these transactions is a deadlock victim.
        expect({ updated, migrated: completed.ok, code: completed.code }).toEqual({
          updated: true,
          migrated: true,
          code: null,
        });
        expect(
          (await observer.query("select nickname from employees where id='zz-test-cross-employee'"))
            .rows[0].nickname,
        ).toBe('ZZ TEST Finished');
        expect(
          (await observer.query('select count(*)::int as n from __drizzle_migrations')).rows[0].n,
        ).toBe(10);
      } finally {
        await writer.query('rollback').catch(() => undefined);
        await Promise.all([writer.end(), migration.end(), observer.end()]);
        await database.drop();
      }
    },
    120_000,
  );

  it('the migration overlap reaches the intended table lock, with no unrelated database refusal', () => {
    expect(overlapProof?.reached).toBe(true);
    expect([null, '40P01']).toContain(overlapProof?.code);
  });

  it.skipIf(!HAS_APP)(
    'FINDING 2 (medium, fixed): concurrent disjoint cash imports retain the combined day; prescribed fix: a transaction-held lock per Xero organisation before any upsert or rebuild',
    async () => {
      const database = await createTestDatabase();
      const setup = await client(database.url, 'zz-test-finance-setup');
      const directory = mkdtempSync(join(tmpdir(), 'oto-r7-cash-cross-'));
      try {
        await apply(setup, 9);
        const script = join(directory, 'cash-review.mts');
        writeFileSync(
          script,
          `
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(${JSON.stringify(join(APP, 'package.json'))});
const pg=require('pg');
const {pool}=await import(${JSON.stringify(pathToFileURL(join(APP, 'server/db.ts')).href)});
const {syncCash}=await import(${JSON.stringify(pathToFileURL(join(APP, 'server/finance-sync.ts')).href)});
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('set search_path to otoapp');
const request=new AsyncLocalStorage();const org='ZZ TEST Cash Organisation '+randomUUID();
const park=(await c.query("insert into tenants(name,slug) values ('ZZ TEST Cash Cross Review',$1) returning id",['zz-test-cash-'+randomUUID()])).rows[0].id;
await c.query("insert into xero_tokens(tenant_id,xero_tenant_id,access_token,refresh_token,expires_at) values ($1,$2,$3,$4,now()+interval '1 hour')",[park,org,randomBytes(24).toString('hex'),randomBytes(24).toString('hex')]);
globalThis.fetch=async()=>Response.json({BankTransactions:[{BankTransactionID:'ZZ TEST '+request.getStore(),Date:'2026-10-12',Total:request.getStore()==='first'?11:23}]});
await c.query("create function zz_test_cash_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(884411); return NEW; end $$");
await c.query('create trigger zz_test_cash_barrier before insert on cash_daily for each row execute function zz_test_cash_barrier()');
await c.query('select pg_advisory_lock(884411)');
try {
 const first=request.run('first',()=>syncCash(org,'2026-10-12','2026-10-12'));
 const second=request.run('second',()=>syncCash(org,'2026-10-12','2026-10-12'));
 for(let n=0;n<250;n++){const waits=Number((await c.query("select count(*) as n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())")).rows[0].n);if(waits===2)break;if(n===249)throw new Error('ZZ TEST cash barrier was not reached');await new Promise(r=>setTimeout(r,20));}
 await c.query('select pg_advisory_unlock(884411)');await Promise.all([first,second]);
 const row=(await c.query('select net::text as net from cash_daily where tenant_id=$1',[org])).rows[0];
 const ledger=(await c.query('select sum(total)::text as n from cash_txns where tenant_id=$1',[org])).rows[0];
 console.log('cash-proof:'+JSON.stringify({ledger:ledger.n,daily:row.net,reached:true}));
 assert.equal(ledger.n,'34');assert.equal(row.net,'34');
 console.log('cash-cross-review: two disjoint imports retain their combined daily total');
} finally {await c.query('select pg_advisory_unlock_all()');await c.end();await pool.end();}
`,
        );
        const output = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                join(APP, 'node_modules/tsx/dist/cli.mjs'),
                '--tsconfig',
                join(APP, 'tsconfig.json'),
                script,
              ],
              {
                cwd: APP,
                env: {
                  ...process.env,
                  DATABASE_URL: database.url,
                  APP_ENV: 'dev',
                  DEPLOY_ENV: 'local',
                  DB_SCHEMA: 'otoapp',
                  OBJECT_STORAGE: 'local',
                  STORAGE_ENV_PREFIX: 'zz-test',
                },
                stdio: 'pipe',
              },
            );
            let stdout = '',
              stderr = '';
            child.stdout.on('data', (chunk) => {
              stdout += chunk.toString();
            });
            child.stderr.on('data', (chunk) => {
              stderr += chunk.toString();
            });
            const timeout = setTimeout(() => {
              child.kill();
              reject(new Error('ZZ TEST cash child did not finish'));
            }, 90_000);
            child.once('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
            child.once('exit', (status) => {
              clearTimeout(timeout);
              resolve({ status, stdout, stderr });
            });
          },
        );
        const proof = output.stdout.split('\n').find((line) => line.startsWith('cash-proof:'));
        if (proof) cashProof = JSON.parse(proof.slice('cash-proof:'.length));
        if (!proof) console.log(`ZZ TEST cash setup did not reach its proof: ${output.stderr}`);
        expect(output.status, `${output.stdout}\n${output.stderr}`).toBe(0);
        expect(output.stdout).toContain('cash-cross-review: two disjoint imports');
      } finally {
        await setup.end();
        await database.drop();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    150_000,
  );

  it.skipIf(!HAS_APP)(
    'both actual finance writers reach the cash barrier and retain both source transactions',
    () => {
      expect(cashProof?.reached).toBe(true);
      expect(cashProof?.ledger).toBe('34');
    },
  );
});
