import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-20 K1 (SCRUM-217) — the kiosk redemption migration (found by its tag,
 * whatever number it landed under), against a live database built from the
 * committed migrations (events-kiosk plan §8 and the K1 row of §9):
 *
 *   - `pos.kiosk_session` holds one row per kiosk session, one per press
 *     (`kiosk_session_action_unique`), and its CHECKs say in the database what
 *     the redemption promises: an ending carries its time, a session that did
 *     not issue says why, an issued one names its sale, and a failed or
 *     abandoned one names no sale and no band (nothing half-redeemed, H13);
 *   - `pos.sale` takes a paired device as the one who rang it up, and still
 *     refuses a sale that names nobody (`sale_actor_check`).
 *
 * The redemption that writes these rows is exercised end to end in
 * `apps/api/test/kiosk-k1.test.ts`.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(PKG, 'migrations');

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

async function one<T = string>(text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query(text, values);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

/** The SQLSTATE a statement is refused with, or null when it is accepted. */
async function code(text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await client.query(text, values);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

const columns = async (schema: string, table: string) =>
  (
    await client.query(
      `select column_name, is_nullable from information_schema.columns where table_schema = $1 and table_name = $2`,
      [schema, table],
    )
  ).rows as Array<{ column_name: string; is_nullable: 'YES' | 'NO' }>;

describe('the kiosk redemption migration — the self-service kiosk', () => {
  it('follows its predecessor in the journal, later than it, on its snapshot', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const mine = journal.entries.find((e) => e.tag.endsWith('_kiosk_redemption'));
    expect(mine).toBeDefined();
    const before = journal.entries[journal.entries.indexOf(mine!) - 1]!;
    expect(mine!.when).toBeGreaterThan(before.when);
    const snapshot = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${mine!.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { prevId: string };
    const previous = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${before.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
  });

  it('adds the session table and lets a device ring a sale up', async () => {
    expect((await columns('pos', 'kiosk_session')).map((c) => c.column_name).sort()).toEqual(
      [
        'action_id', 'band_ids', 'booking_id', 'box_id', 'branch_id', 'created_at', 'detail',
        'device_credential_id', 'ended_at', 'id', 'operator_id', 'outcome', 'reason', 'sale_id',
        'started_at', 'station_id', 'updated_at',
      ].sort(),
    );
    const sale = await columns('pos', 'sale');
    expect(sale.find((c) => c.column_name === 'created_by_account_id')?.is_nullable).toBe('YES');
    expect(sale.find((c) => c.column_name === 'device_credential_id')?.is_nullable).toBe('YES');
    const checks = (
      await client.query(
        `select conname from pg_constraint where conrelid = 'pos.sale'::regclass and contype = 'c' and conname = 'sale_actor_check'`,
      )
    ).rows;
    expect(checks).toHaveLength(1);
    const indexes = (
      await client.query(`select indexname, indexdef from pg_indexes where schemaname = 'pos' and tablename in ('kiosk_session','sale')`)
    ).rows as Array<{ indexname: string; indexdef: string }>;
    const def = (name: string) => indexes.find((i) => i.indexname === name)?.indexdef ?? '';
    expect(def('kiosk_session_action_unique')).toMatch(/UNIQUE.*\(station_id, action_id\).*WHERE \(action_id IS NOT NULL\)/);
    expect(def('sale_device_credential_idx')).toMatch(/\(device_credential_id\)/);
  });

  it('holds a session to what the redemption promises', async () => {
    const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'K1 Op') returning id`);
    const branchId = await one(
      `insert into core.branch (id, operator_id, name, code) values (gen_random_uuid(), $1, 'K1 Park', 'k1-' || substr(md5(random()::text), 1, 8)) returning id`,
      [operatorId],
    );
    const stationId = await one(
      `insert into core.station (id, operator_id, branch_id, name, kind) values (gen_random_uuid(), $1, $2, 'Kiosk 1', 'kiosk') returning id`,
      [operatorId, branchId],
    );
    const credentialId = await one(
      `insert into core.device_credential (id, operator_id, branch_id, kind, station_id, scopes)
       values (gen_random_uuid(), $1, $2, 'kiosk', $3, '["pos:kiosk:redeem"]'::jsonb) returning id`,
      [operatorId, branchId, stationId],
    );
    const session = (fields: Record<string, unknown>) => {
      const cols = ['id', 'operator_id', 'branch_id', 'station_id', 'device_credential_id', 'started_at', ...Object.keys(fields)];
      const values = [operatorId, branchId, stationId, credentialId, ...Object.values(fields)];
      const placeholders = values.map((_, i) => `$${i + 1}`);
      return code(
        `insert into pos.kiosk_session (${cols.join(', ')}) values (gen_random_uuid(), ${placeholders.slice(0, 4).join(', ')}, now()${
          placeholders.length > 4 ? `, ${placeholders.slice(4).join(', ')}` : ''
        })`,
        values,
      );
    };
    // Running, and the endings that are allowed.
    expect(await session({ action_id: 'press-1' })).toBeNull();
    expect(await session({ action_id: 'press-2', outcome: 'failed', reason: 'PRINTER_UNREACHABLE', ended_at: new Date() })).toBeNull();
    expect(await session({ action_id: 'press-3', outcome: 'handed_off', reason: 'KIOSK_SUPERVISED_AT_DESK', ended_at: new Date() })).toBeNull();
    // One press, one session.
    expect(await session({ action_id: 'press-1' })).toBe('23505');
    // An outcome is an ending; an ending is an outcome.
    expect(await session({ action_id: 'press-4', outcome: 'failed', reason: 'X' })).toBe('23514');
    expect(await session({ action_id: 'press-5', ended_at: new Date() })).toBe('23514');
    // Not a word the table knows.
    expect(await session({ action_id: 'press-6', outcome: 'party', reason: 'X', ended_at: new Date() })).toBe('23514');
    // A session that did not issue says why.
    expect(await session({ action_id: 'press-7', outcome: 'abandoned', ended_at: new Date() })).toBe('23514');
    // Issued means a sale stands behind it.
    expect(await session({ action_id: 'press-8', outcome: 'issued', ended_at: new Date() })).toBe('23514');
    // Failed names no band (H13).
    expect(
      await session({
        action_id: 'press-9',
        outcome: 'failed',
        reason: 'PRINTER_PAPER_OUT',
        ended_at: new Date(),
        band_ids: JSON.stringify(['01a11111-0000-7000-8000-000000000001']),
      }),
    ).toBe('23514');
  });
});
