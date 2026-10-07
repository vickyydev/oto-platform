import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-502 — the prepaid food lines of one supervised stay, found by the stay
 * (migration found by its tag, whatever number it lands under), against a live
 * database built from the committed migrations.
 *
 * Every box's check-in copy carries the prepaid units that box's own sales have
 * filed (`boxPrepaidFiled` in apps/api/src/services/band-food.ts), and a
 * counter's commit counts what open orders hold (`prepaidHeldOnOpenOrders`).
 * Both look a stay up by `payload -> 'prepaid' ->> 'checkinId'`, which no
 * index covered: the lookup read every food line the park had sold.
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

/** The plan's index names, wherever they sit in the tree. */
function indexesIn(plan: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n['Index Name'] === 'string') out.push(n['Index Name']);
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(plan);
  return out;
}

/** The plan Postgres chooses with a full scan priced out, so an empty table still shows whether the index can serve. */
async function planOf(text: string, values: unknown[]): Promise<string[]> {
  await client.query('begin');
  try {
    await client.query('set local enable_seqscan = off');
    const { rows } = await client.query(`explain (format json) ${text}`, values);
    return indexesIn(rows[0]);
  } finally {
    await client.query('rollback');
  }
}

describe('the prepaid stay index — SCRUM-502', () => {
  it('follows its predecessor in the journal, later than it, on its snapshot', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const mine = journal.entries.find((e) => e.tag.endsWith('_sale_line_prepaid_stay_index'));
    expect(mine).toBeDefined();
    const at = journal.entries.indexOf(mine!);
    const before = journal.entries[at - 1]!;
    expect(mine!.idx).toBe(before.idx + 1);
    expect(mine!.when).toBeGreaterThan(before.when);
    const snapshot = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${mine!.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { prevId: string };
    const previous = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', `${before.tag.slice(0, 4)}_snapshot.json`), 'utf8'),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
  });

  it('indexes the stay a prepaid line names, and only lines that name one', async () => {
    const { rows } = await client.query(
      `select indexdef from pg_indexes where schemaname = 'pos' and tablename = 'sale_line' and indexname = 'sale_line_prepaid_stay_idx'`,
    );
    expect(rows).toHaveLength(1);
    const def = (rows[0] as { indexdef: string }).indexdef;
    expect(def).toMatch(/\(\(\(payload -> 'prepaid'::text\) ->> 'checkinId'::text\)\)/);
    expect(def).toMatch(/WHERE \(\(\(payload -> 'prepaid'::text\) ->> 'checkinId'::text\) IS NOT NULL\)/);
  });

  it('serves the stay half of both lookups, with the stays bound as the platform binds them', async () => {
    /**
     * Both lookups put the same condition on the line — a food line naming one
     * of these stays (`inArray`, so `in ($n, …)` with bound values) — and join
     * the sale for its park. On an empty table the planner would rather drive
     * from the sale's own indexes, so the line's half is asked on its own: the
     * index has to be able to answer it, bound parameters and partial
     * predicate included.
     */
    const stays = ['018f0000-0000-7000-8000-00000000f501', '018f0000-0000-7000-8000-00000000f502'];
    const lines = await planOf(
      `select sl.sale_id, sl.quantity, sl.payload from pos.sale_line sl
        where sl.kind = 'fnb_item' and (sl.payload -> 'prepaid' ->> 'checkinId') in ($1, $2)`,
      stays,
    );
    expect(lines).toEqual(['sale_line_prepaid_stay_idx']);
    const one = await planOf(`select 1 from pos.sale_line sl where (sl.payload -> 'prepaid' ->> 'checkinId') in ($1)`, [stays[0]]);
    expect(one).toEqual(['sale_line_prepaid_stay_idx']);
  });
});
