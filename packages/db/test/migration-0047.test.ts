import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-14a round 5 — promotional vouchers (migration 0047), against a live
 * database built from the committed migrations.
 *
 *   - it builds from empty, and 0047 is journal entry 47 after 0046;
 *   - a definition's limits are above zero or absent, and its window does not
 *     end before it starts; a definition written before 0047 reads as it did
 *     (no target, no limit, no window);
 *   - a campaign carries a positive quantity and a name, and a voucher may
 *     name its campaign and carry the `campaign` source;
 *   - a wallet entry may carry the `promo_voucher` source, and nothing else new.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 240_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

async function one<T = string>(text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query(text, values);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

async function code(text: string, values: unknown[] = []): Promise<string | null> {
  try {
    await client.query(text, values);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function park(): Promise<{ operatorId: string; branchId: string }> {
  const operatorId = await one(`insert into core.operator (id, name) values (gen_random_uuid(), 'Promo Op') returning id`);
  const branchId = await one(
    `insert into core.branch (id, operator_id, name, code)
     values (gen_random_uuid(), $1, 'Promo Park', 'pv-' || substr(md5(random()::text), 1, 8)) returning id`,
    [operatorId],
  );
  return { operatorId, branchId };
}

const definition = (operatorId: string, extra = '', values: unknown[] = []) =>
  client.query(
    `insert into promo.voucher_definition (id, operator_id, code, name_en, kind, value_type, value_satang${extra ? `, ${extra.split('=')[0]}` : ''})
     values (gen_random_uuid(), $1, 'pv-' || substr(md5(random()::text), 1, 10), 'Promo', 'discount', 'amount', 10000${extra ? `, ${extra.split('=')[1]}` : ''})
     returning id`,
    [operatorId, ...values],
  );

describe('migration 0047 — promotional vouchers', () => {
  it('is journal entry 47, after 0046', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const e46 = journal.entries.find((e) => e.idx === 46)!;
    const e47 = journal.entries.find((e) => e.idx === 47)!;
    expect(e47.tag).toBe('0047_promo_vouchers');
    expect(e47.when).toBeGreaterThan(e46.when);
  });

  it('a definition’s limits are above zero or absent, and its window does not end before it starts', async () => {
    const { operatorId } = await park();
    const plain = await definition(operatorId);
    const row = await client.query(
      `select target, usage_limit, per_customer_limit, valid_from, valid_until from promo.voucher_definition where id = $1`,
      [plain.rows[0].id],
    );
    expect(row.rows[0]).toEqual({ target: null, usage_limit: null, per_customer_limit: null, valid_from: null, valid_until: null });
    expect(await code(`update promo.voucher_definition set usage_limit = 0 where id = $1`, [plain.rows[0].id])).toBe('23514');
    expect(await code(`update promo.voucher_definition set per_customer_limit = -1 where id = $1`, [plain.rows[0].id])).toBe('23514');
    expect(
      await code(`update promo.voucher_definition set valid_from = '2026-11-30', valid_until = '2026-11-01' where id = $1`, [plain.rows[0].id]),
    ).toBe('23514');
    expect(
      await code(
        `update promo.voucher_definition set usage_limit = 10, per_customer_limit = 1, valid_from = '2026-11-01', valid_until = '2026-11-30', target = '{"kind":"merch"}' where id = $1`,
        [plain.rows[0].id],
      ),
    ).toBeNull();
  });

  it('a campaign has a positive quantity and a name; a voucher names its campaign under the campaign source', async () => {
    const { operatorId, branchId } = await park();
    const defId = (await definition(operatorId)).rows[0].id as string;
    const campaign = (q: number, name: string) =>
      code(
        `insert into promo.voucher_campaign (id, operator_id, branch_id, voucher_definition_id, name, quantity)
         values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [operatorId, branchId, defId, name, q],
      );
    expect(await campaign(0, 'Zero')).toBe('23514');
    expect(await campaign(5, '')).toBe('23514');
    expect(await campaign(5, 'October')).toBeNull();
    const campaignId = await one(`select id from promo.voucher_campaign where name = 'October'`);
    expect(
      await code(
        `insert into promo.voucher (id, operator_id, branch_id, voucher_definition_id, code, source, campaign_id)
         values (gen_random_uuid(), $1, $2, $3, 'CP23456789A', 'campaign', $4)`,
        [operatorId, branchId, defId, campaignId],
      ),
    ).toBeNull();
    expect(
      await code(
        `insert into promo.voucher (id, operator_id, branch_id, voucher_definition_id, code, source)
         values (gen_random_uuid(), $1, $2, $3, 'CP23456789B', 'nowhere')`,
        [operatorId, branchId, defId],
      ),
    ).toBe('23514');
  });

  it('a wallet entry may carry promo_voucher, and nothing else new', async () => {
    const { operatorId, branchId } = await park();
    const walletId = await one(
      `insert into pos.wallet (id, operator_id, branch_id, holder_name, balance_satang) values (gen_random_uuid(), $1, $2, 'Voucher credit', 10000) returning id`,
      [operatorId, branchId],
    );
    const entry = (source: string, action: string) =>
      code(
        `insert into pos.wallet_entry (id, wallet_id, operator_id, action_id, amount_satang, kind, source, branch_id, balance_after)
         values (gen_random_uuid(), $1, $2, $3, 10000, 'grant', $4, $5, 10000)`,
        [walletId, operatorId, action, source, branchId],
      );
    expect(await entry('promo_voucher', 'voucher:a:load')).toBeNull();
    expect(await entry('promo_code', 'voucher:b:load')).toBe('23514');
  });
});
