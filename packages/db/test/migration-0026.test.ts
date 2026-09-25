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
 * SCRUM-425 (the booth's closing audit, section 3.1 and T25) — every wrong
 * voucher code tried at a till is a row with the person who tried it
 * (migration 0026), asserted against a live database built from the committed
 * migrations.
 *
 * The api counts one person's different codes in those rows across every
 * till, and locks that person on the fifth inside a minute; the till's own
 * budget stays in `promo.redemption_throttle`. What the database itself has
 * to hold for that:
 *   - `promo.voucher_miss` with its columns, every key ON DELETE restrict, and
 *     an index leading with each of them;
 *   - the code's hash and never the code: the CHECK refuses anything that is
 *     not a SHA-256 in lower-case hex;
 *   - what the till answered, from a closed list;
 *   - on a database from before 0026, the tills' rows exactly as they were
 *     and nothing copied in: those misses name nobody;
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

interface Place {
  operatorId: string;
  branchId: string;
  stationId: string;
  accountId: string;
}

/** A tenant with one till and one person, written straight in. */
async function tillAndPerson(c: pg.Client): Promise<Place> {
  const operatorId = await one(
    c,
    `insert into core.operator (id, name) values (gen_random_uuid(), 'Miss Op') returning id`,
  );
  const branchId = await one(
    c,
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Miss Park', 'mp-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const stationId = await one(
    c,
    `insert into core.station (id, operator_id, branch_id, name, kind)
     values (gen_random_uuid(), $1, $2, 'Till', 'till') returning id`,
    [operatorId, branchId],
  );
  const accountId = await one(
    c,
    `insert into core.account (id, operator_id, phone)
     values (gen_random_uuid(), $1, '+6690' || lpad((floor(random() * 10000000))::int::text, 7, '0')) returning id`,
    [operatorId],
  );
  return { operatorId, branchId, stationId, accountId };
}

const HASH = 'ab'.repeat(32);

/** One wrong code at `at`, as the api writes it; `over` replaces any column. */
async function insertMiss(
  c: pg.Client,
  at: Place,
  over: { codeHash?: string; result?: string } = {},
): Promise<void> {
  await c.query(
    `insert into promo.voucher_miss (id, operator_id, branch_id, station_id, account_id, code_hash, result)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
    [
      at.operatorId,
      at.branchId,
      at.stationId,
      at.accountId,
      over.codeHash ?? HASH,
      over.result ?? 'not_found',
    ],
  );
}

function migrate(url: string): void {
  execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/**
 * A database on the same server with every migration BEFORE 0026 applied, by
 * the migrator `drizzle-kit migrate` itself uses: the committed SQL of 0000 to
 * 0025 and a journal that stops there. A till's row can then be written the
 * way the api wrote one before 0026, and 0026 applied on top of it.
 */
async function databaseBefore0026(): Promise<{
  url: string;
  client: pg.Client;
  drop: () => Promise<void>;
}> {
  const name = `oto_test_pre0026_${Date.now()}_${process.pid}`;
  await client.query(`create database ${name}`);
  const url = db.url.replace(/\/[^/]*$/, `/${name}`);

  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const before = journal.entries.filter((e) => e.idx < 26);
  const folder = mkdtempSync(join(tmpdir(), 'oto-pre0026-'));
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

describe('promo.voucher_miss — every wrong code, with the person who tried it', () => {
  it('has the columns the api writes, typed and nullable as it needs', async () => {
    const { rows } = await client.query(
      `select column_name, udt_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'promo' and table_name = 'voucher_miss' order by ordinal_position`,
    );
    expect(rows).toEqual([
      { column_name: 'id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
      { column_name: 'operator_id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
      { column_name: 'branch_id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
      { column_name: 'station_id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
      { column_name: 'account_id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
      { column_name: 'code_hash', udt_name: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'result', udt_name: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'request_id', udt_name: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'occurred_at', udt_name: 'timestamptz', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'account_locked_until', udt_name: 'timestamptz', is_nullable: 'YES', column_default: null },
      { column_name: 'created_at', udt_name: 'timestamptz', is_nullable: 'NO', column_default: 'now()' },
    ]);
  });

  it('keys every row to its operator, branch, till and person, ON DELETE restrict', async () => {
    const { rows } = await client.query<{ col: string; ref: string; action: string }>(
      `select a.attname as col, rn.nspname || '.' || rt.relname as ref, c.confdeltype as action
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join pg_class rt on rt.oid = c.confrelid
         join pg_namespace rn on rn.oid = rt.relnamespace
         join pg_attribute a on a.attrelid = t.oid and a.attnum = c.conkey[1]
        where c.contype = 'f' and n.nspname = 'promo' and t.relname = 'voucher_miss'
        order by 1`,
    );
    expect(rows).toEqual([
      { col: 'account_id', ref: 'core.account', action: 'r' },
      { col: 'branch_id', ref: 'core.branch', action: 'r' },
      { col: 'operator_id', ref: 'core.operator', action: 'r' },
      { col: 'station_id', ref: 'core.station', action: 'r' },
    ]);
  });

  it('carries an index leading with every foreign key', async () => {
    // CLAUDE.md §8. The person's own, (account_id, occurred_at), is also the
    // read the api makes for a person's budget and lock on every look-up.
    const { rows } = await client.query<{ column: string }>(
      `select a.attname as column
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join pg_attribute a on a.attrelid = t.oid and a.attnum = c.conkey[1]
        where c.contype = 'f' and n.nspname = 'promo' and t.relname = 'voucher_miss'
          and not exists (
            select 1 from pg_index i where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
    );
    expect(rows).toEqual([]);
    const account = await one(
      client,
      `select indexdef from pg_indexes where schemaname = 'promo' and indexname = 'voucher_miss_account_idx'`,
    );
    expect(account).toContain('(account_id, occurred_at)');
  });
});

describe('never the code: the hash rule of 0024, kept by the database', () => {
  let at: Place;
  beforeAll(async () => {
    at = await tillAndPerson(client);
  });

  it('takes a SHA-256 in lower-case hex, and what the till answered', async () => {
    await insertMiss(client, at, { codeHash: HASH, result: 'not_found' });
    await insertMiss(client, at, { codeHash: 'c'.repeat(64), result: 'invalid' });
    const n = await one<number>(
      client,
      `select count(*)::int from promo.voucher_miss where account_id = $1`,
      [at.accountId],
    );
    expect(n).toBe(2);
  });

  it.each([
    ['a voucher code itself', 'B1RT7KMQ4PX'],
    ['a code with a dash', 'B1-RT7K MQ4P'],
    ['a hash in capitals', 'AB'.repeat(32)],
    ['a hash a character short', 'a'.repeat(63)],
    ['an empty string', ''],
  ])('refuses %s', async (_what, codeHash) => {
    await expect(insertMiss(client, at, { codeHash })).rejects.toThrow(
      /voucher_miss_code_hash_check/,
    );
  });

  it('refuses an answer the till never gives', async () => {
    await expect(insertMiss(client, at, { result: 'expired' })).rejects.toThrow(
      /voucher_miss_result_check/,
    );
  });

  it('refuses a person who is not there', async () => {
    await expect(
      insertMiss(client, { ...at, accountId: '00000000-0000-7000-8000-000000000000' }),
    ).rejects.toThrow(/voucher_miss_account_id_account_id_fk/);
  });
});

describe('on a database from before 0026', () => {
  it('leaves every till’s row as it was, and copies nothing in: those misses name nobody', async () => {
    const old = await databaseBefore0026();
    try {
      const table = () =>
        one<number>(
          old.client,
          `select count(*)::int from information_schema.tables
            where table_schema = 'promo' and table_name = 'voucher_miss'`,
        );
      // Before 0026 there is no such table: this till's row is the old api's.
      expect(await table()).toBe(0);
      const at = await tillAndPerson(old.client);
      await old.client.query(
        `insert into promo.redemption_throttle
           (station_id, operator_id, branch_id, recent_misses, recent_miss_code_hashes)
         values ($1, $2, $3, array['2026-09-25T08:00:10Z', '2026-09-25T08:00:20Z']::timestamptz[],
                 array[null, $4::text])`,
        [at.stationId, at.operatorId, at.branchId, HASH],
      );
      const throttle = `select recent_misses, recent_miss_code_hashes, locked_until, lock_count
                          from promo.redemption_throttle where station_id = $1`;
      const before = (await old.client.query(throttle, [at.stationId])).rows;

      migrate(old.url);

      expect(await table()).toBe(1);
      expect((await old.client.query(throttle, [at.stationId])).rows).toEqual(before);
      expect(
        await one<number>(old.client, `select count(*)::int from promo.voucher_miss`),
      ).toBe(0);
      // And the new table takes the api's rows at once.
      await insertMiss(old.client, at);
      expect(
        await one<number>(old.client, `select count(*)::int from promo.voucher_miss`),
      ).toBe(1);
    } finally {
      await old.drop();
    }
  }, 180_000);
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
    expect(before).toContain('col voucher_miss.code_hash text text NO ');
    expect(before.filter((l) => l.startsWith('idx voucher_miss.'))).toHaveLength(5);
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
