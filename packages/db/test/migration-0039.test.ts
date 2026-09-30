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
 * SCRUM-471 — the booth's own voucher slip (migration 0039), asserted against
 * a live database built from the committed migrations.
 *
 * What the database itself has to hold, whatever the api does:
 *   - five columns on `booth.booth_settings`, three switches that default on
 *     and two texts that default to nothing — so a booth row written without
 *     them is today's slip, which is what keeps every published wheel's hash
 *     where it was;
 *   - the two texts refused past the print templates' own limits, 200 and
 *     400 characters, and taking Thai as typed;
 *   - and, from the gate's reproductions: 0039 is journal entry 39, after
 *     0038 and later than it, found BY INDEX (never "the last entry", which
 *     is whatever lands next); and rows that exist at the 0038 state come
 *     through with today's slip and every other column untouched, a second
 *     run changing nothing.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function readJournal(): { entries: JournalEntry[] } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  } & Record<string, unknown>;
}

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

/** A tenant with one booth station and its settings row, written as before 0039. */
async function booth(): Promise<string> {
  const operatorId = await one(
    `insert into core.operator (id, name) values (gen_random_uuid(), 'Slip Op') returning id`,
  );
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Slip Park', 'sl-' || substr(md5(random()::text), 1, 8)) returning id`,
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
  return stationId;
}

describe('booth.booth_settings — the voucher slip (0039)', () => {
  it('adds three switches that default on and two texts that default to nothing', async () => {
    const { rows } = await client.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'booth' and table_name = 'booth_settings' and column_name like 'voucher_%'
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'voucher_footer_text', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'voucher_header_text', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'voucher_show_logo', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
      { column_name: 'voucher_show_staff', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
      { column_name: 'voucher_show_terms', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
    ]);
  });

  it('gives a booth written without them today’s slip', async () => {
    const stationId = await booth();
    const { rows } = await client.query(
      `select voucher_show_logo, voucher_header_text, voucher_footer_text, voucher_show_staff, voucher_show_terms
         from booth.booth_settings where station_id = $1`,
      [stationId],
    );
    expect(rows[0]).toEqual({
      voucher_show_logo: true,
      voucher_header_text: null,
      voucher_footer_text: null,
      voucher_show_staff: true,
      voucher_show_terms: true,
    });
  });

  it('takes a header up to 200 characters and a footer up to 400, Thai as typed, and refuses more', async () => {
    const stationId = await booth();
    await client.query(
      `update booth.booth_settings set voucher_header_text = $2, voucher_footer_text = $3 where station_id = $1`,
      [stationId, 'ห'.repeat(200), 'ข'.repeat(400)],
    );
    expect(
      await one(`select char_length(voucher_footer_text)::int from booth.booth_settings where station_id = $1`, [
        stationId,
      ]),
    ).toBe(400);

    await expect(
      client.query(`update booth.booth_settings set voucher_header_text = $2 where station_id = $1`, [
        stationId,
        'h'.repeat(201),
      ]),
    ).rejects.toThrow(/booth_settings_voucher_header_text_check/);
    await expect(
      client.query(`update booth.booth_settings set voucher_footer_text = $2 where station_id = $1`, [
        stationId,
        'f'.repeat(401),
      ]),
    ).rejects.toThrow(/booth_settings_voucher_footer_text_check/);
  });
});

describe('0039 lands after 0038 and only adds (gate reproductions)', () => {
  it('is journal entry 39, after 0038 and later than it, with the indexes unbroken', () => {
    const journal = readJournal();
    const e38 = journal.entries.find((e) => e.idx === 38);
    const e39 = journal.entries.find((e) => e.idx === 39);
    expect(e38?.tag).toBe('0038_booking_checkout');
    expect(e39?.tag).toBe('0039_booth_voucher_slip');
    expect(e39!.when).toBeGreaterThan(e38!.when);
    expect(journal.entries.map((e) => e.idx)).toEqual([...journal.entries.keys()]);

    const sql = readFileSync(join(MIGRATIONS, '0039_booth_voucher_slip.sql'), 'utf8');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|constraint|index)\b/i);
    expect(sql).not.toMatch(/\brename\b/i);
  });

  it('brings rows written at the 0038 state through with today’s slip, and a re-run changes nothing', async () => {
    const name = `oto_test_pre0039_${Date.now()}_${process.pid}`;
    await client.query(`create database ${name}`);
    const url = db.url.replace(/\/[^/]*$/, `/${name}`);
    const journal = readJournal();
    const c = new pg.Client({ connectionString: url });
    await c.connect();

    /** Every migration up to `upTo` applied, by the migrator drizzle-kit uses. */
    const migrateTo = async (upTo: number) => {
      const folder = mkdtempSync(join(tmpdir(), 'oto-pre0039-'));
      try {
        mkdirSync(join(folder, 'meta'));
        const entries = journal.entries.filter((e) => e.idx <= upTo);
        for (const e of entries) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
        writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
        await applyMigrations(drizzle(c), { migrationsFolder: folder });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    };
    const first = async (text: string, values: unknown[] = []): Promise<string> => {
      const { rows } = await c.query(text, values);
      return Object.values(rows[0] as Record<string, unknown>)[0] as string;
    };

    try {
      await migrateTo(38);
      const none = await c.query(
        `select column_name from information_schema.columns
          where table_schema = 'booth' and table_name = 'booth_settings' and column_name like 'voucher_%'`,
      );
      expect(none.rows, 'the 0038 state has no slip columns').toEqual([]);

      const operatorId = await first(
        `insert into core.operator (id, name) values (gen_random_uuid(), 'Pre-0039 Op') returning id`,
      );
      const branchId = await first(
        `insert into core.branch (id, operator_id, name, code)
         values (gen_random_uuid(), $1, 'Pre-0039 Park', 'p39-park') returning id`,
        [operatorId],
      );
      const stationIds: string[] = [];
      for (const booth of ['Booth A', 'Booth B']) {
        const stationId = await first(
          `insert into core.station (id, operator_id, branch_id, name, kind)
           values (gen_random_uuid(), $1, $2, $3, 'booth') returning id`,
          [operatorId, branchId, booth],
        );
        await c.query(
          `insert into booth.booth_settings (station_id, operator_id, branch_id, daily_spin_cap) values ($1, $2, $3, 5)`,
          [stationId, operatorId, branchId],
        );
        stationIds.push(stationId);
      }

      await migrateTo(39);
      const read = async () =>
        (
          await c.query(
            `select daily_spin_cap, voucher_show_logo, voucher_header_text, voucher_footer_text,
                    voucher_show_staff, voucher_show_terms
               from booth.booth_settings where station_id = any($1) order by station_id`,
            [stationIds],
          )
        ).rows;
      const rows = await read();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toEqual({
          daily_spin_cap: 5,
          voucher_show_logo: true,
          voucher_header_text: null,
          voucher_footer_text: null,
          voucher_show_staff: true,
          voucher_show_terms: true,
        });
      }

      await migrateTo(39);
      expect(await read(), 'a second run is a no-op').toEqual(rows);
    } finally {
      await c.end();
      await client.query(`drop database if exists ${name} with (force)`);
    }
  }, 180_000);
});
