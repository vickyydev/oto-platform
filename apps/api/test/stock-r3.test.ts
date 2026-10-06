import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, branch, product, station, stockItem, stockLocation } from '@oto/db';
import { newId, type StockSnapshotItem } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import type { BoxAuth } from '../src/services/box';
import {
  CACHE_SCOPES,
  CACHE_VOLATILE_SCOPES,
  bundleVersionCovers,
  cacheBundle,
  cacheScopesOffered,
  catalogueVersionOf,
  pullChanges,
} from '../src/services/sync';
import { STOCK_CLOSING_FACTS, stockCacheItem } from '../src/services/sync-stock';

/**
 * S2-14b round 3 — THE `stock` CACHE SCOPE (plan docs/progress/plans/stock/
 * PLAN.md §2.4, §5 "Catalogue hash churn").
 *
 * What a counter box is shipped to sell counted stock with the link down: the
 * branch's level snapshot per stocked size and per place, with this box's own
 * filed offline sales of each. Volatile, and kept OUT of the `catalogue` scope
 * and the bundle's version: a sale that moves stock moves this scope's own
 * version and nothing a box prices from. The closing walk with two boxes, the
 * replay and the anomaly is `offline-stock.test.ts`.
 */

let ctx: TestContext;
let cookie: string;
let auth: BoxAuth;
let operatorId: string;
let branchId: string;
let stationId: string;
const productIds = new Map<string, string>();

async function snapshot(): Promise<StockSnapshotItem> {
  return stockCacheItem(ctx.db, auth);
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const stations = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  const till = stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!;
  stationId = till.id;
  const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, till.boxId!));
  auth = {
    boxId: boxRow!.id,
    operatorId: boxRow!.operatorId,
    branchId: boxRow!.branchId,
    name: boxRow!.name,
    slot: boxRow!.slot,
    role: boxRow!.role,
    status: boxRow!.status,
    currentEpoch: boxRow!.currentEpoch,
    syncPublicKey: boxRow!.syncPublicKey,
    lastStatus: boxRow!.lastStatus as Record<string, unknown> | null,
  };
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code) productIds.set(p.code, p.id);
  }
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the stock scope', () => {
  it('is offered to a counter box, never to a booth-only one, and is volatile', () => {
    expect(CACHE_SCOPES).toContain('stock');
    expect(CACHE_VOLATILE_SCOPES).toContain('stock');
    expect(cacheScopesOffered('counter')).toContain('stock');
    expect(cacheScopesOffered('booth_only')).not.toContain('stock');
    expect(STOCK_CLOSING_FACTS.has('sale.finalised')).toBe(true);
    expect(STOCK_CLOSING_FACTS.has('payment.recorded')).toBe(true);
    expect(STOCK_CLOSING_FACTS.has('wallet.spent')).toBe(true);
  });

  it('ships every counted size per place from the seeded opening, with what this box has filed', async () => {
    const snap = await snapshot();
    expect(snap.branchId).toBe(branchId);
    const places = await ctx.db.select().from(stockLocation).where(eq(stockLocation.branchId, branchId));
    const byName = new Map(places.map((p) => [p.name, p.id]));
    expect(snap.sellPointId).toBe(byName.get('FOH'));
    // The sell point first, then back of house, then bulk — the cascade's order.
    expect(snap.places.map((p) => [p.name, p.type, p.sellPoint])).toEqual([
      ['FOH', 'rotation', true],
      ['BOH', 'back_of_house', false],
      ['Store', 'bulk', false],
    ]);
    // Grip Socks (shop): S 18 BOH + 7 FOH, M 28 + 12, L 14 + 6 — one row per size, in the catalogue's size order.
    const socks = snap.items.filter((e) => e.productId === productIds.get('MR-SOCKS'));
    expect(socks.map((e) => [e.variantId, e.sizeLabel, e.total, e.levels[byName.get('FOH')!], e.levels[byName.get('BOH')!]])).toEqual([
      ['s', 'S', 25, 7, 18],
      ['m', 'M', 40, 12, 28],
      ['l', 'L', 20, 6, 14],
    ]);
    // No all-time sum of this box's sales: the filed mark of its journal
    // instead — its current epoch, nothing pushed yet.
    expect(socks[0]).not.toHaveProperty('boxTaken');
    expect(snap.boxFiled).toEqual({ journalEpoch: 1, boxSeq: 0 });
    // An item out everywhere is still a row: the box refuses it, it does not forget it.
    const keyring = snap.items.find((e) => e.productId === productIds.get('MR-KEYRING'));
    expect(keyring).toMatchObject({ variantId: null, sizeLabel: null, total: 0 });
    // Only sellables are shipped, and no cost.
    expect(JSON.stringify(snap)).not.toContain('unitCost');
    const items = await ctx.db
      .select()
      .from(stockItem)
      .where(and(eq(stockItem.branchId, branchId), sql`${stockItem.productId} is not null`, eq(stockItem.active, true)));
    expect(snap.items).toHaveLength(items.filter((i) => !i.archivedAt).length);
  });

  it('is its own answer in the bundle: alone it carries no validator, and it never reaches the change feed', async () => {
    const alone = await cacheBundle(ctx.db, auth, { scopes: ['stock'] });
    expect(Object.keys(alone.scopes)).toEqual(['stock']);
    expect(bundleVersionCovers(alone)).toBe(false);
    const full = await cacheBundle(ctx.db, auth, {});
    expect(Object.keys(full.scopes)).toContain('stock');
    expect(full.truncated).not.toContain('stock');
    // The feed's own list does not name it (a cache scope only); a box asking anyway is fed nothing of it.
    const fed = await pullChanges(ctx.db, auth, { cursorSeq: 0, limit: 500, scopes: ['stock' as never] });
    expect(fed.changes).toEqual([]);
  });

  it('a sale that moves stock moves the stock scope’s version — and neither the catalogue’s nor the bundle’s', async () => {
    const before = await snapshot();
    const catalogueBefore = await catalogueVersionOf(ctx.db, operatorId, branchId);
    const bundleBefore = (await cacheBundle(ctx.db, auth, {})).bundleVersion;

    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        stationId,
        id: saleId,
        items: [{ id: newId(), productId: productIds.get('MR-SOCKS')!, quantity: 2, variant: { variantId: 's', variantLabel: 'S' } }],
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie } });
    expect(closed.statusCode, closed.body).toBe(200);

    const after = await snapshot();
    expect(after.version).not.toBe(before.version);
    const s = (snap: StockSnapshotItem) => snap.items.find((e) => e.productId === productIds.get('MR-SOCKS') && e.variantId === 's')!;
    expect(s(after).total).toBe(s(before).total - 2);
    // An online sale is not in this box's journal: its filed mark does not move.
    expect(after.boxFiled).toEqual(before.boxFiled);
    expect(await catalogueVersionOf(ctx.db, operatorId, branchId)).toBe(catalogueBefore);
    expect((await cacheBundle(ctx.db, auth, {})).bundleVersion).toBe(bundleBefore);
    // Built the same way twice, the scope's own version is stable: it leaves out when it was built.
    expect((await snapshot()).version).toBe(after.version);
  });
});
