import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-400 (S2-07d) — the staff session length on a booth and the park's
 * wording on a voucher definition (migration 0022), asserted against a live
 * database built from the committed migrations.
 *
 * What the database itself has to hold, whatever the api does:
 *   - the four wording columns exist, are text and nullable, and take Thai;
 *   - the session length is nullable, and a value is more than nothing and at
 *     most one trading day (1440 minutes) — the box's own ceiling;
 *   - a row written before the migration keeps null in all five, which is
 *     what keeps every published wheel's hash where it was;
 *   - the migration applied twice leaves the same database.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

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

async function one<T = string>(text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query(text, values);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

/** A tenant with one booth station, its settings row, and one voucher definition. */
async function tenancy(): Promise<{ stationId: string; definitionId: string }> {
  const operatorId = await one(
    `insert into core.operator (id, name) values (gen_random_uuid(), 'Setup Op') returning id`,
  );
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Setup Park', 'sp-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  const stationId = await one(
    `insert into core.station (id, operator_id, branch_id, name, kind)
     values (gen_random_uuid(), $1, $2, 'Booth', 'booth') returning id`,
    [operatorId, branchId],
  );
  await client.query(
    `insert into booth.booth_settings (station_id, operator_id, branch_id) values ($1, $2, $3)`,
    [stationId, operatorId, branchId],
  );
  const definitionId = await one(
    `insert into promo.voucher_definition (id, operator_id, code, name_en, kind, value_type, value_satang)
     values (gen_random_uuid(), $1, 'd-' || md5(random()::text), '100 THB Voucher', 'discount', 'amount', 10000)
     returning id`,
    [operatorId],
  );
  return { stationId, definitionId };
}

describe('promo.voucher_definition — the words on the slip', () => {
  it('adds a title and an instruction in English and Thai, as nullable text', async () => {
    const { rows } = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'promo' and table_name = 'voucher_definition'
          and column_name in ('title_en','title_th','instruction_en','instruction_th')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'instruction_en', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'instruction_th', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'title_en', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'title_th', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('leaves a definition written without them unworded, and keeps Thai exactly as typed', async () => {
    const { definitionId } = await tenancy();
    const { rows } = await client.query(
      `select title_en, title_th, instruction_en, instruction_th from promo.voucher_definition where id = $1`,
      [definitionId],
    );
    expect(rows[0]).toEqual({
      title_en: null,
      title_th: null,
      instruction_en: null,
      instruction_th: null,
    });

    await client.query(
      `update promo.voucher_definition set title_th = $2, instruction_th = $3 where id = $1`,
      [definitionId, 'พิซซ่าเด็กฟรี', 'แสดงสลิปนี้ที่ร้านอาหาร OTO รับพิซซ่าเด็กฟรี 1 ถาด'],
    );
    const saved = await client.query(
      `select title_th, instruction_th from promo.voucher_definition where id = $1`,
      [definitionId],
    );
    expect(saved.rows[0]).toEqual({
      title_th: 'พิซซ่าเด็กฟรี',
      instruction_th: 'แสดงสลิปนี้ที่ร้านอาหาร OTO รับพิซซ่าเด็กฟรี 1 ถาด',
    });
  });
});

describe('booth.booth_settings — how long a sign-in lasts', () => {
  it('adds the session length as a nullable integer with no default', async () => {
    const { rows } = await client.query(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'booth' and table_name = 'booth_settings' and column_name = 'staff_session_minutes'`,
    );
    expect(rows).toEqual([{ data_type: 'integer', is_nullable: 'YES', column_default: null }]);
  });

  it('keeps null for a booth nobody has set — the box then grants its own twelve hours', async () => {
    const { stationId } = await tenancy();
    expect(
      await one(`select staff_session_minutes from booth.booth_settings where station_id = $1`, [
        stationId,
      ]),
    ).toBeNull();
  });

  it('takes ten hours and a whole day, and refuses nothing, less than nothing and more than a day', async () => {
    const { stationId } = await tenancy();
    for (const ok of [600, 1440, 1, null]) {
      await client.query(
        `update booth.booth_settings set staff_session_minutes = $2 where station_id = $1`,
        [stationId, ok],
      );
    }
    for (const refused of [0, -30, 1441]) {
      await expect(
        client.query(
          `update booth.booth_settings set staff_session_minutes = $2 where station_id = $1`,
          [stationId, refused],
        ),
        `${refused} minutes was accepted`,
      ).rejects.toThrow(/booth_settings_staff_session_minutes_check/);
    }
  });
});

/**
 * Every column and constraint in the two schemas this migration touches, as
 * the catalogue describes them — the thing that must not move when the
 * migration runs again.
 */
async function fingerprint(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ line: string }>(
    `select 'col ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type
              || ' ' || is_nullable || ' ' || coalesce(column_default, '') as line
       from information_schema.columns where table_schema in ('promo', 'booth')
     union all
     select 'con ' || n.nspname || '.' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid)
       from pg_constraint c join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace where n.nspname in ('promo', 'booth')
     union all
     select 'idx ' || schemaname || '.' || tablename || '.' || indexname || ' ' || indexdef
       from pg_indexes where schemaname in ('promo', 'booth')
     order by 1`,
  );
  return rows.map((r) => r.line);
}

function migrate(url: string): void {
  execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

describe('the migration, run twice', () => {
  it('leaves the same database when it is applied again', async () => {
    const before = await fingerprint(client);
    expect(before.some((l) => l.startsWith('col booth.booth_settings.staff_session_minutes '))).toBe(
      true,
    );
    expect(before.some((l) => l.includes('booth_settings_staff_session_minutes_check'))).toBe(true);
    expect(before.some((l) => l.startsWith('col promo.voucher_definition.instruction_th '))).toBe(
      true,
    );
    migrate(db.url);
    expect(await fingerprint(client)).toEqual(before);
    expect(
      await one(
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

describe('booth.booth_settings - spin duration (0028)', () => {
  it('defaults a new booth to ten whole seconds', async () => {
    const { stationId } = await tenancy();
    expect(await one<number>(
      'select spin_duration_seconds from booth.booth_settings where station_id = $1',
      [stationId],
    )).toBe(10);
    const { rows } = await client.query(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'booth' and table_name = 'booth_settings'
         and column_name = 'spin_duration_seconds'`,
    );
    expect(rows).toEqual([{ data_type: 'integer', is_nullable: 'NO', column_default: '10' }]);
  });

  it('accepts the supported bounds and refuses durations outside them', async () => {
    const { stationId } = await tenancy();
    for (const seconds of [2, 10, 20]) {
      await client.query(
        'update booth.booth_settings set spin_duration_seconds = $2 where station_id = $1',
        [stationId, seconds],
      );
      expect(await one<number>(
        'select spin_duration_seconds from booth.booth_settings where station_id = $1',
        [stationId],
      )).toBe(seconds);
    }
    for (const seconds of [0, 1, 21]) {
      await expect(client.query(
        'update booth.booth_settings set spin_duration_seconds = $2 where station_id = $1',
        [stationId, seconds],
      )).rejects.toThrow(/booth_settings_spin_duration_seconds_check/);
    }
    await expect(client.query(
      'update booth.booth_settings set spin_duration_seconds = null where station_id = $1',
      [stationId],
    )).rejects.toThrow(/not-null constraint/);
  });
});
