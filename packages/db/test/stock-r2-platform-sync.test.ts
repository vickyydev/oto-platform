import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { newId } from '@oto/shared';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import { platformSync } from '../src/seed/index';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-14b round 2, handover H4 — the deploy's platform-sync lays down stock
 * setup, and only that.
 *
 * Staging runs migrations plus `platform:sync`, never the full seed, so after
 * 0048 it had stock tables with nothing in them. The sync now gives a branch
 * with none of them its places, its stocked items and sizes, their packs and
 * their links — and NO opening quantity (OD-S5: the opening is a count done in
 * the app). The half that is easy to lose is the second run: it must change
 * nothing at all, and a park that has since made its own choices is never
 * argued with.
 */

interface Harness {
  db: Db;
  close: () => Promise<void>;
}

let h: Harness;

async function makeDatabase(): Promise<Harness> {
  const { url, drop } = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  return {
    db: drizzle(pool, { schema }) as Db,
    close: async () => {
      await pool.end();
      await drop();
    },
  };
}

/** A park with one branch and the products the stock seed knows, as staging has them. */
async function park(db: Db, name: string): Promise<{ operatorId: string; branchId: string; products: Map<string, string> }> {
  const operatorId = newId();
  await db.insert(s.operator).values({ id: operatorId, name });
  const branchId = newId();
  await db.insert(s.branch).values({ id: branchId, operatorId, name: `${name} Central`, code: `${name.toLowerCase().replace(/\W+/g, '-')}-c`, timezone: 'Asia/Bangkok' });
  const products = new Map<string, string>();
  const rows: Array<{ code: string; name: string; kind: 'merch' | 'addon' | 'menu'; variants?: Array<{ id: string; label: string }> }> = [
    { code: 'MR-CAP', name: 'Oto Cap', kind: 'merch' },
    { code: 'MR-SOCKS', name: 'Grip Socks', kind: 'merch', variants: [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }] },
    // Staging's add-on predates sizes: the sync gives it the prototype's S, M, L once.
    { code: 'AO-GRIPSOCKS', name: 'Grip Socks', kind: 'addon' },
    { code: 'FB-WATER', name: 'Bottled Water', kind: 'menu' },
  ];
  for (const r of rows) {
    const id = newId();
    products.set(r.code, id);
    await db.insert(s.product).values({
      id,
      operatorId,
      branchId,
      kind: r.kind,
      code: r.code,
      name: r.name,
      priceSatang: 10000,
      variants: r.variants ?? [],
    });
  }
  return { operatorId, branchId, products };
}

/** Every stock row of a branch, and its products, exactly as stored — ids and updated_at included. */
async function snapshot(db: Db, branchId: string) {
  const locations = await db.select().from(s.stockLocation).where(eq(s.stockLocation.branchId, branchId)).orderBy(asc(s.stockLocation.id));
  const items = await db.select().from(s.stockItem).where(eq(s.stockItem.branchId, branchId)).orderBy(asc(s.stockItem.id));
  const ids = items.map((i) => i.id);
  const units = ids.length ? await db.select().from(s.stockUnit).where(inArray(s.stockUnit.stockItemId, ids)).orderBy(asc(s.stockUnit.id)) : [];
  const levels = ids.length ? await db.select().from(s.stockLevel).where(inArray(s.stockLevel.stockItemId, ids)) : [];
  const movements = await db.select().from(s.stockMovement).where(eq(s.stockMovement.branchId, branchId));
  const takes = await db.select().from(s.stockTake).where(eq(s.stockTake.branchId, branchId));
  const products = await db.select().from(s.product).where(eq(s.product.branchId, branchId)).orderBy(asc(s.product.id));
  return { locations, items, units, levels, movements, takes, products };
}

beforeAll(async () => {
  h = await makeDatabase();
}, 180_000);

afterAll(async () => {
  await h?.close();
  await stopTestServer();
});

describe('platformSync lays down stock setup for a branch that has none (H4)', () => {
  it('gives the branch its three places, the sell point among them', async () => {
    const p = await park(h.db, 'Staging Park');
    await platformSync(h.db);
    const { locations } = await snapshot(h.db, p.branchId);
    expect(locations.map((l) => [l.name, l.type, l.sellPoint]).sort()).toEqual([
      ['BOH', 'back_of_house', false],
      ['FOH', 'rotation', true],
      ['Store', 'bulk', false],
    ]);
  });

  it('lays the stocked items, one per size, linked — and writes no opening quantity', async () => {
    const p = await park(h.db, 'Linked Park');
    await platformSync(h.db);
    const snap = await snapshot(h.db, p.branchId);
    const byProduct = (code: string) => snap.items.filter((i) => i.productId === p.products.get(code));
    expect(byProduct('MR-CAP').map((i) => i.variantId)).toEqual([null]);
    expect(byProduct('MR-SOCKS').map((i) => i.variantId).sort()).toEqual(['l', 'm', 's']);
    expect(byProduct('FB-WATER')).toHaveLength(1);
    // The add-on had no sizes; it is given the prototype's, and stocked in all of them (H3).
    const addon = snap.products.find((x) => x.code === 'AO-GRIPSOCKS')!;
    expect(addon.variants.map((v) => v.id)).toEqual(['s', 'm', 'l']);
    expect(byProduct('AO-GRIPSOCKS').map((i) => i.variantId).sort()).toEqual(['l', 'm', 's']);
    // The "tracked" marker on each product points at one of its own sizes.
    for (const code of ['MR-CAP', 'MR-SOCKS', 'AO-GRIPSOCKS', 'FB-WATER']) {
      const prod = snap.products.find((x) => x.code === code)!;
      expect(byProduct(code).map((i) => i.id)).toContain(prod.stockItemId);
    }
    // Packs, pars at the sell point and the reorder settings come with them.
    const water = byProduct('FB-WATER')[0]!;
    expect(snap.units.filter((u) => u.stockItemId === water.id).map((u) => [u.label, u.eaches])).toEqual([['Case', 24]]);
    const foh = snap.locations.find((l) => l.sellPoint)!;
    expect(water.parByLocation).toEqual({ [foh.id]: 24 });
    expect(water.supplierName).toBe('Island Beverages Co.');
    // OD-S5: nothing on any shelf until somebody counts it.
    expect(snap.levels).toEqual([]);
    expect(snap.movements).toEqual([]);
    expect(snap.takes).toEqual([]);
  });

  it('changes nothing the second time — same rows, same ids, same updated_at', async () => {
    const p = await park(h.db, 'Twice Park');
    await platformSync(h.db);
    const first = await snapshot(h.db, p.branchId);
    expect(first.items.length).toBeGreaterThan(0);
    await platformSync(h.db);
    expect(await snapshot(h.db, p.branchId)).toEqual(first);
  });

  it('PLANT — leaves a branch a manager has set up alone: a retired place, an unlinked item', async () => {
    const p = await park(h.db, 'Opinionated Park');
    const place = newId();
    await h.db.insert(s.stockLocation).values({
      id: place,
      operatorId: p.operatorId,
      branchId: p.branchId,
      name: 'Shelf',
      type: 'rotation',
      sellPoint: false,
      active: false,
    });
    await h.db.insert(s.stockItem).values({ id: newId(), operatorId: p.operatorId, branchId: p.branchId, name: 'Own thing' });
    const before = await snapshot(h.db, p.branchId);
    await platformSync(h.db);
    expect(await snapshot(h.db, p.branchId)).toEqual(before);
  });

  it('gives a branch with places but no items its items, pars at its own sell point', async () => {
    const p = await park(h.db, 'Half Park');
    const counter = newId();
    await h.db.insert(s.stockLocation).values({
      id: counter,
      operatorId: p.operatorId,
      branchId: p.branchId,
      name: 'Counter',
      type: 'rotation',
      sellPoint: true,
    });
    await platformSync(h.db);
    const snap = await snapshot(h.db, p.branchId);
    expect(snap.locations.map((l) => l.name)).toEqual(['Counter']);
    const cap = snap.items.find((i) => i.productId === p.products.get('MR-CAP'))!;
    expect(cap.parByLocation).toEqual({ [counter]: 10 });
  });

  it('does not stock a sized product whose sizes the seed does not name exactly (H3: all or none)', async () => {
    const p = await park(h.db, 'Sized Park');
    // A manager gave the shop socks an XL the seed knows nothing about.
    await h.db
      .update(s.product)
      .set({ variants: [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }, { id: 'xl', label: 'XL' }] })
      .where(eq(s.product.id, p.products.get('MR-SOCKS')!));
    await platformSync(h.db);
    const snap = await snapshot(h.db, p.branchId);
    expect(snap.items.filter((i) => i.productId === p.products.get('MR-SOCKS'))).toEqual([]);
    expect(snap.products.find((x) => x.code === 'MR-SOCKS')!.stockItemId).toBeNull();
    // The rest of the branch is stocked as usual.
    expect(snap.items.some((i) => i.productId === p.products.get('MR-CAP'))).toBe(true);
  });

  it('the stock tables still add up: no level exists without its movements', async () => {
    const { rows } = await h.db.execute(sql`select count(*)::int as n from pos.stock_level`);
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});
