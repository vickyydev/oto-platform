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
 * SCRUM-1010 — the park's day runs midnight to midnight (migrations 0130 and
 * 0131), asserted against a live database built from the committed migrations.
 *
 *   - before 0130 a new park takes 05:00; from 0130 the column default is
 *     00:00, and parks that already hold 05:00 keep it until 0131;
 *   - 0131 sets EVERY park's day start to 00:00, archived parks and parks on
 *     another hour included;
 *   - no stored business date is rewritten: a sale dated under 05:00 keeps
 *     its business_date and its frozen day start;
 *   - the switch run again changes nothing.
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

/** A database on the same server with every migration up to and including `last` applied. */
async function databaseThrough(last: number): Promise<{ client: pg.Client; drop: () => Promise<void> }> {
  const name = `oto_test_s1010_${last}_${Date.now()}`;
  await client.query(`create database ${name}`);
  const url = db.url.replace(/\/[^/]*$/, `/${name}`);
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const through = journal.entries.filter((e) => e.idx <= last);
  const folder = mkdtempSync(join(tmpdir(), `oto-s1010-${last}-`));
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    mkdirSync(join(folder, 'meta'));
    for (const e of through) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: through }));
    await applyMigrations(drizzle(c), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return {
    client: c,
    drop: async () => {
      await c.end();
      await client.query(`drop database if exists ${name} with (force)`);
    },
  };
}

const sql0131 = () =>
  readFileSync(join(MIGRATIONS, '0131_branch_day_start_midnight.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n');

async function park(c: pg.Client, operatorId: string, name: string, extra = ''): Promise<string> {
  return one(
    c,
    `insert into core.branch (id, operator_id, name, code${extra ? ', business_day_start' : ''})
     values (gen_random_uuid(), $1, $2, 'p-' || substr(md5(random()::text), 1, 8)${extra ? ', $3' : ''}) returning id`,
    extra ? [operatorId, name, extra] : [operatorId, name],
  );
}

describe('SCRUM-1010 — 0130 moves the default, 0131 switches every park, and nothing stored is re-dated', () => {
  it('before 0130 a new park takes 05:00; after it, 00:00, while a park already on 05:00 keeps it', async () => {
    const before = await databaseThrough(129);
    try {
      const op = await one(before.client, `insert into core.operator (id, name) values (gen_random_uuid(), 'S1010 Op') returning id`);
      const id = await park(before.client, op, 'Before the default');
      expect(await one(before.client, `select business_day_start::text from core.branch where id = $1`, [id])).toBe('05:00:00');
    } finally {
      await before.drop();
    }

    const after = await databaseThrough(130);
    try {
      const op = await one(after.client, `insert into core.operator (id, name) values (gen_random_uuid(), 'S1010 Op') returning id`);
      const fresh = await park(after.client, op, 'After the default');
      const held = await park(after.client, op, 'Still on five', '05:00');
      expect(await one(after.client, `select business_day_start::text from core.branch where id = $1`, [fresh])).toBe('00:00:00');
      expect(await one(after.client, `select business_day_start::text from core.branch where id = $1`, [held])).toBe('05:00:00');
    } finally {
      await after.drop();
    }
  }, 300_000);

  it('0131 sets every park to 00:00, re-dates no sale, and run again changes nothing', async () => {
    const d = await databaseThrough(130);
    try {
      const c = d.client;
      const op = await one(c, `insert into core.operator (id, name) values (gen_random_uuid(), 'S1010 Op') returning id`);
      const five = await park(c, op, 'On five', '05:00');
      const half = await park(c, op, 'On half past four', '04:30');
      const archived = await park(c, op, 'Archived on five', '05:00');
      await c.query(`update core.branch set archived_at = now() where id = $1`, [archived]);
      const station = await one(
        c,
        `insert into core.station (id, operator_id, branch_id, name, kind) values (gen_random_uuid(), $1, $2, 'Till', 'till') returning id`,
        [op, five],
      );
      const account = await one(
        c,
        `insert into core.account (id, operator_id, phone, status)
         values (gen_random_uuid(), $1, '+6690' || lpad(floor(random() * 10000000)::text, 7, '0'), 'active') returning id`,
        [op],
      );
      // 02:00 on 19 November in Bangkok, dated to the 18th under the 05:00 start.
      const sale = await one(
        c,
        `insert into pos.sale (id, operator_id, branch_id, station_id, business_date, business_day_start,
                               timezone, occurred_at, created_by_account_id, pricing_mode,
                               pricing_mode_reason, customer_tier, engine_version, tax_config, tax_breakdown)
         values (gen_random_uuid(), $1, $2, $3, '2026-11-18', '05:00', 'Asia/Bangkok', '2026-11-18T19:00:00Z', $4,
                 'weekday', 'test', 'tourist', 'test', '{}', '{}')
         returning id`,
        [op, five, station, account],
      );

      await c.query(sql0131());
      const parks = await c.query<{ id: string; start: string }>(
        `select id, business_day_start::text as start from core.branch where id = any($1::uuid[])`,
        [[five, half, archived]],
      );
      expect(parks.rows).toHaveLength(3);
      expect(parks.rows.every((r) => r.start === '00:00:00')).toBe(true);
      expect(await one(c, `select count(*)::int from core.branch where business_day_start <> '00:00'`)).toBe(0);

      const stored = await c.query<{ business_date: string; business_day_start: string }>(
        `select business_date::text, business_day_start::text from pos.sale where id = $1`,
        [sale],
      );
      expect(stored.rows[0]).toEqual({ business_date: '2026-11-18', business_day_start: '05:00:00' });

      // Run again: nothing left to change.
      const again = await c.query(sql0131());
      expect(again.rowCount).toBe(0);
    } finally {
      await d.drop();
    }
  }, 300_000);
});
