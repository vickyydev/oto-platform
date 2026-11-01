import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-699, nannies and their shifts from the OTO App rota — one migration.
 * Expand-only: columns that are nullable or carry a constant default, one new
 * table (`pos.nanny_sync`), and new indexes and checks. Every nanny and shift
 * that existed before it is the demo seed's, so both `source` columns are
 * added with DEFAULT 'seed' and only then given 'manual' for later rows.
 *
 * The entry is found by its tag suffix, never by number, so a lane that lands
 * another 0098 first and renumbers this one does not break the test.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const entry = journal.entries.find((e) => /_nanny_duty$/.test(e.tag));

let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({
    connectionString: database.url,
    application_name: 'oto-test-699-nanny-duty-migration',
  });
  await client.connect();
}, 300_000);

afterAll(async () => {
  try {
    await client?.end();
  } finally {
    try {
      await database?.drop();
    } finally {
      await stopTestServer();
    }
  }
});

const column = async (table: string, name: string) => {
  const { rows } = await client.query<{ is_nullable: string; column_default: string | null; data_type: string }>(
    `select is_nullable, column_default, data_type
       from information_schema.columns
      where table_schema = 'pos' and table_name = $1 and column_name = $2`,
    [table, name],
  );
  return rows;
};

describe('SCRUM-699 nanny duty migration', () => {
  it('is journalled, and adds both source columns as seed before defaulting them to manual', () => {
    expect(entry, 'a journalled *_nanny_duty migration').toBeDefined();
    const sqlText = readFileSync(join(MIGRATIONS, `${entry!.tag}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n');
    for (const table of ['nanny', 'nanny_shift']) {
      const add = sqlText.indexOf(`ALTER TABLE "pos"."${table}" ADD COLUMN "source" text DEFAULT 'seed' NOT NULL;`);
      const reset = sqlText.indexOf(`ALTER TABLE "pos"."${table}" ALTER COLUMN "source" SET DEFAULT 'manual';`);
      expect(add, `${table}.source is added with DEFAULT 'seed'`).toBeGreaterThanOrEqual(0);
      expect(reset, `${table}.source then defaults to 'manual'`).toBeGreaterThan(add);
    }
    // Expand-only: nothing is dropped, renamed or rewritten.
    expect(sqlText).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN "[a-z_]+" (SET DATA )?TYPE/);
  });

  it('leaves nanny.source and nanny_shift.source not null with default manual', async () => {
    for (const table of ['nanny', 'nanny_shift']) {
      expect(await column(table, 'source')).toEqual([
        { is_nullable: 'NO', column_default: "'manual'::text", data_type: 'text' },
      ]);
    }
    expect(await column('nanny', 'app_employee_id')).toEqual([
      { is_nullable: 'YES', column_default: null, data_type: 'text' },
    ]);
    for (const name of ['business_date', 'app_assignment_id', 'synced_at', 'added_by_account_id']) {
      const [row] = await column('nanny_shift', name);
      expect(row?.is_nullable, `nanny_shift.${name} is nullable`).toBe('YES');
      expect(row?.column_default, `nanny_shift.${name} has no default`).toBeNull();
    }
  });

  it('defaults supervision_policy.nanny_match_text to Nanny', async () => {
    expect(await column('supervision_policy', 'nanny_match_text')).toEqual([
      { is_nullable: 'NO', column_default: "'Nanny'::text", data_type: 'text' },
    ]);
  });

  it('creates pos.nanny_sync keyed by branch and trading day', async () => {
    const { rows } = await client.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = 'pos.nanny_sync'::regclass and contype = 'p'`,
    );
    expect(rows).toEqual([{ conname: 'nanny_sync_branch_id_business_date_pk', def: 'PRIMARY KEY (branch_id, business_date)' }]);
  });

  it('holds the source checks: an app row names its app id, and a manual row needs no business date', async () => {
    const { rows: checks } = await client.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid in ('pos.nanny'::regclass, 'pos.nanny_shift'::regclass, 'pos.supervision_policy'::regclass)
          and contype = 'c'
          and conname in ('nanny_source_check','nanny_app_employee_check','nanny_shift_source_check','nanny_shift_app_check','supervision_policy_nanny_match_text_check')
        order by conname`,
    );
    expect(checks.map((c) => c.conname)).toEqual([
      'nanny_app_employee_check',
      'nanny_shift_app_check',
      'nanny_shift_source_check',
      'nanny_source_check',
      'supervision_policy_nanny_match_text_check',
    ]);
  });
});
