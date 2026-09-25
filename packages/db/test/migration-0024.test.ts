import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as applyMigrations } from 'drizzle-orm/node-postgres/migrator';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-406 (booth closing audit M8) — each wrong code at a till carries the
 * hash of its code (migration 0024), asserted against a live database built
 * from the committed migrations.
 *
 * The guessing limit counts different codes now, not tries, so a slip printed
 * while its booth was offline can be tried again without locking the till.
 * What the database itself has to hold for that:
 *   - `promo.redemption_throttle.recent_miss_code_hashes` exists beside
 *     `recent_misses`, is text[], nullable, with no default;
 *   - a row written BEFORE 0024 keeps its misses and gets null — the api reads
 *     that as "no hash for any of these", and each still counts one;
 *   - a null element can sit beside a hash, which is how the api carries such
 *     a miss forward next to a new one;
 *   - the migration applied twice leaves the same database, and a database
 *     built from empty again is the same.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

async function one<T = string>(c: pg.Client, text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await c.query(text, values);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

/** A tenant with one till, and that till's throttle row holding two misses. */
async function tillWithTwoMisses(c: pg.Client, hashes: string | null): Promise<string> {
  const operatorId = await one(
    c,
    `insert into core.operator (id, name) values (gen_random_uuid(), 'Throttle Op') returning id`,
  );
  const branchId = await one(
    c,
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Throttle Park', 'tp-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const stationId = await one(
    c,
    `insert into core.station (id, operator_id, branch_id, name, kind)
     values (gen_random_uuid(), $1, $2, 'Till', 'till') returning id`,
    [operatorId, branchId],
  );
  const columns = hashes === null ? '' : ', recent_miss_code_hashes';
  const value = hashes === null ? '' : `, ${hashes}`;
  await c.query(
    `insert into promo.redemption_throttle (station_id, operator_id, branch_id, recent_misses${columns})
     values ($1, $2, $3, array['2026-09-25T08:00:10Z', '2026-09-25T08:00:20Z']::timestamptz[]${value})`,
    [stationId, operatorId, branchId],
  );
  return stationId;
}

function migrate(url: string): void {
  execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/**
 * A database on the same server with every migration BEFORE 0024 applied, by
 * the migrator `drizzle-kit migrate` itself uses: the committed SQL of 0000 to
 * 0023 and a journal that stops there. A row can then be written the way the
 * api wrote one before 0024, and 0024 applied on top of it.
 */
async function databaseBefore0024(): Promise<{
  url: string;
  client: pg.Client;
  drop: () => Promise<void>;
}> {
  const name = `oto_test_pre0024_${Date.now()}`;
  await client.query(`create database ${name}`);
  const url = db.url.replace(/\/[^/]*$/, `/${name}`);

  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const before = journal.entries.filter((e) => e.idx < 24);
  const folder = mkdtempSync(join(tmpdir(), 'oto-pre0024-'));
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    mkdirSync(join(folder, 'meta'));
    for (const e of before) {
      copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    }
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: before }),
    );
    await applyMigrations(drizzle(c), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return {
    url,
    client: c,
    drop: async () => {
      await c.end();
      await client.query(`drop database if exists ${name} with (force)`);
    },
  };
}

describe('promo.redemption_throttle — the hash of the code beside each miss', () => {
  it('adds recent_miss_code_hashes as a nullable text array with no default', async () => {
    const { rows } = await client.query(
      `select data_type, udt_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'promo' and table_name = 'redemption_throttle'
          and column_name = 'recent_miss_code_hashes'`,
    );
    expect(rows).toEqual([
      { data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('leaves a row written before 0024 with its misses, and null beside them', async () => {
    const old = await databaseBefore0024();
    try {
      const hashColumn = () =>
        one<number>(
          old.client,
          `select count(*)::int from information_schema.columns
            where table_schema = 'promo' and table_name = 'redemption_throttle'
              and column_name = 'recent_miss_code_hashes'`,
        );
      // Before 0024 there is no such column: this row is the old api's.
      expect(await hashColumn()).toBe(0);
      const stationId = await tillWithTwoMisses(old.client, null);

      migrate(old.url);

      expect(await hashColumn()).toBe(1);
      const { rows } = await old.client.query(
        `select recent_misses, recent_miss_code_hashes, locked_until, lock_count
           from promo.redemption_throttle where station_id = $1`,
        [stationId],
      );
      expect(rows).toEqual([
        {
          recent_misses: [new Date('2026-09-25T08:00:10Z'), new Date('2026-09-25T08:00:20Z')],
          recent_miss_code_hashes: null,
          locked_until: null,
          lock_count: 0,
        },
      ]);
    } finally {
      await old.drop();
    }
  }, 180_000);

  it('holds a null beside a hash, the way the api carries a miss from before 0024 forward', async () => {
    const hash = 'a'.repeat(64);
    const stationId = await tillWithTwoMisses(client, `array[null, '${hash}']::text[]`);
    const { rows } = await client.query(
      `select recent_misses, recent_miss_code_hashes from promo.redemption_throttle where station_id = $1`,
      [stationId],
    );
    expect(rows[0].recent_miss_code_hashes).toEqual([null, hash]);
    expect(rows[0].recent_misses).toHaveLength(2);
  });
});

/**
 * Every column, constraint and index in the schema this migration touches, as
 * the catalogue describes them — the thing that must not move when the
 * migration runs again.
 */
async function fingerprint(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ line: string }>(
    `select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || udt_name
              || ' ' || is_nullable || ' ' || coalesce(column_default, '') as line
       from information_schema.columns where table_schema = 'promo'
     union all
     select 'con ' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid)
       from pg_constraint c join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'promo'
     union all
     select 'idx ' || tablename || '.' || indexname || ' ' || indexdef
       from pg_indexes where schemaname = 'promo'
     order by 1`,
  );
  return rows.map((r) => r.line);
}

describe('the migration, run twice', () => {
  it('leaves the same database when it is applied again', async () => {
    const before = await fingerprint(client);
    expect(before).toContain('col redemption_throttle.recent_miss_code_hashes ARRAY _text YES ');
    migrate(db.url);
    expect(await fingerprint(client)).toEqual(before);
    expect(
      await one(
        client,
        `select count(*)::int from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`,
      ),
    ).toBe(1);
  }, 120_000);

  it('builds the same database from empty a second time', async () => {
    const second = await createTestDatabase();
    const other = new pg.Client({ connectionString: second.url });
    await other.connect();
    try {
      expect(await fingerprint(other)).toEqual(await fingerprint(client));
    } finally {
      await other.end();
      await second.drop();
    }
  }, 180_000);
});
