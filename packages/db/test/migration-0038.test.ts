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
 * SCRUM-209 round 1 (arrival — checkout), migration 0038, against a database
 * holding bookings shaped like staging's: rows the booking site wrote as
 * `paid` with no payment (`routes/public.ts` before S2-12), some since
 * redeemed. The plan (§2.1): they migrate as paid, with no attempt, and are
 * MARKED so in the pricing snapshot.
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

function migrate(url: string): void {
  execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
    cwd: PKG,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/** Every migration before 0038 applied, by the migrator drizzle-kit uses. */
async function databaseBefore0038(): Promise<{ url: string; client: pg.Client; drop: () => Promise<void> }> {
  const name = `oto_test_pre0038_${Date.now()}_${process.pid}`;
  await client.query(`create database ${name}`);
  const url = db.url.replace(/\/[^/]*$/, `/${name}`);
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const before = journal.entries.filter((e) => e.idx < 38);
  const folder = mkdtempSync(join(tmpdir(), 'oto-pre0038-'));
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    mkdirSync(join(folder, 'meta'));
    for (const e of before) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: before }));
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

describe('0038 is the next migration and only adds', () => {
  it('is journal entry 38, after 0037, and the file drops and renames nothing', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    // Found by idx, not by position: later lanes append their own entries
    // and this test must stay green when they do.
    const last = journal.entries.find((e) => e.idx === 38)!;
    const prev = journal.entries.find((e) => e.idx === 37)!;
    expect(last).toMatchObject({ idx: 38, tag: '0038_booking_checkout' });
    expect(prev.tag).toBe('0037_sync_anomaly_offline_kinds');
    expect(last.when).toBeGreaterThan(prev.when);
    const sql = readFileSync(join(MIGRATIONS, '0038_booking_checkout.sql'), 'utf8');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|constraint|index)\b/i);
    expect(sql).not.toMatch(/\brename\b/i);
  });
});

describe('on a database holding staging-shaped bookings', () => {
  it('migrates the demo rows as paid, with no attempt, marked legacy — and keeps their money and lines', async () => {
    const old = await databaseBefore0038();
    try {
      const c = old.client;
      const operatorId = await one(c, `insert into core.operator (id, name) values (gen_random_uuid(), 'Mig Op') returning id`);
      const branchId = await one(
        c,
        `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'Mig Park', 'mig-park') returning id`,
        [operatorId],
      );
      const pkg = async (name: string) =>
        one(
          c,
          `insert into pos.ticket_package (id, operator_id, branch_id, name, duration_label, hours, prices)
           values (gen_random_uuid(), $1, $2, $3, '1 Hour', 1, '{"tourist":{"weekday":45000,"weekend":52000}}') returning id`,
          [operatorId, branchId, name],
        );
      const oneHour = await pkg('1 Hour Play');
      const twoHours = await pkg('2 Hours Play');

      const insert = (reference: string, status: string, payload: unknown, total: number, created: string) =>
        one(
          c,
          `insert into pos.booking (id, operator_id, branch_id, reference, booking_date, status, total_satang, payload, created_at, updated_at)
           values (gen_random_uuid(), $1, $2, $3, '2026-09-20', $4, $5, $6::jsonb, $7::timestamptz, $7::timestamptz) returning id`,
          [operatorId, branchId, reference, status, total, payload === null ? null : JSON.stringify(payload), created],
        );
      // As `routes/public.ts` wrote them before S2-12: status 'paid', no payment.
      const paid = await insert(
        'OTO-0001-1111',
        'paid',
        {
          tier: 'tourist',
          rateMode: 'weekday',
          parentName: 'Khun A',
          phone: '+66811110000',
          lines: [
            { packageId: oneHour, name: '1 Hour Play', kids: 2, adults: 1, lineTotalSatang: 90000 },
            { packageId: oneHour, name: '1 Hour Play', kids: 1, adults: 0, lineTotalSatang: 45000 },
          ],
        },
        135000,
        '2026-09-19T03:00:00Z',
      );
      const redeemed = await insert(
        'OTO-0002-2222',
        'redeemed',
        {
          tier: 'tourist',
          rateMode: 'weekend',
          lines: [
            { packageId: oneHour, kids: 1, adults: 1 },
            { packageId: twoHours, kids: 2, adults: 2 },
          ],
        },
        300000,
        '2026-09-18T05:00:00Z',
      );
      const noPayload = await insert('OTO-0003-3333', 'paid', null, 0, '2026-09-17T05:00:00Z');
      const oddCounts = await insert(
        'OTO-0004-4444',
        'paid',
        { lines: [{ packageId: twoHours, kids: '3', adults: 'x' }, 'not a line'] },
        10000,
        '2026-09-16T05:00:00Z',
      );

      migrate(old.url);

      const row = async (id: string) =>
        (
          await c.query(
            `select status, channel, package_id, kids_count, adults_count, payment_attempt_id, paid_at,
                    expires_at, business_date::text as business_date, pricing_snapshot, qr_key_id, qr_signature,
                    total_satang, payload, created_at
               from pos.booking where id = $1`,
            [id],
          )
        ).rows[0] as Record<string, unknown>;

      const a = await row(paid);
      expect(a).toMatchObject({
        status: 'paid',
        channel: 'web',
        package_id: oneHour,
        kids_count: 3,
        adults_count: 1,
        payment_attempt_id: null,
        expires_at: null,
        business_date: '2026-09-20',
        qr_key_id: null,
        qr_signature: null,
        total_satang: '135000',
      });
      expect((a.paid_at as Date).toISOString()).toBe((a.created_at as Date).toISOString());
      expect(a.pricing_snapshot).toMatchObject({ legacy: true, paidBy: 'simulated_booking_flow', totalSatang: 135000 });
      // The payload is untouched: the lines the site priced are still there.
      expect((a.payload as { lines: unknown[] }).lines).toHaveLength(2);

      const b = await row(redeemed);
      expect(b).toMatchObject({ status: 'redeemed', package_id: null, kids_count: 3, adults_count: 3, payment_attempt_id: null });
      expect(b.pricing_snapshot).toMatchObject({ legacy: true });
      expect(b.paid_at).not.toBeNull();

      const d = await row(noPayload);
      expect(d).toMatchObject({ status: 'paid', kids_count: 0, adults_count: 0, package_id: null });
      expect(d.pricing_snapshot).toMatchObject({ legacy: true, lines: [] });

      const e = await row(oddCounts);
      expect(e).toMatchObject({ status: 'paid', kids_count: 3, adults_count: 0, package_id: twoHours });

      // The vocabulary is enforced from here on.
      await expect(
        c.query(`update pos.booking set status = 'confirmed' where id = $1`, [paid]),
      ).rejects.toThrow(/booking_status_check/);
      await expect(
        c.query(`update pos.booking set qr_signature = 'ABC' where id = $1`, [paid]),
      ).rejects.toThrow(/booking_qr_check/);
    } finally {
      await old.drop();
    }
  }, 180_000);
});
