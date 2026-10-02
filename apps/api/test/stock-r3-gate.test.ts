import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, product, station, stockItem } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent } from '@oto/box-agent';
import { newId } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { assertCartStock } from '../src/services/stock';
import { catalogueCacheItem } from '../src/services/sync';
import { stockCacheItem } from '../src/services/sync-stock';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-14b ROUND 3 GATE — reproductions kept as tests.
 *
 * TRACKING SWITCHED OFF: the platform's definition of a counted item is "an
 * ACTIVE stock item at THIS branch" (`loadStockCatalogue` filters
 * `stock_item.active` and the branch; `sale.ts`: "An item whose tracking was
 * switched off ... still sells it without one"). The box lane's guard instead
 * also treats the catalogue's `product.stock_item_id` marker as "counted" — a
 * marker that survives a stock item being switched off (`saveStockItem` sets
 * `active` and leaves the link), and that is operator-wide on an operator-wide
 * product while stock items are per branch. So with the link down the box
 * refuses an item the platform sells uncounted: "has no stock count for that
 * item, so it cannot be sold here".
 *
 * COUNTED AT ANOTHER BRANCH ONLY: the same marker on an operator-wide product
 * whose only stock item is at another branch (Robinson Chalong) refused the
 * sale on every other branch's box offline, though that box held a fresh
 * snapshot. The fix: a fresh snapshot alone decides what is counted.
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let till1: string;
let capId: string;
let capItemId: string;
let capUnitSatang: number;
let stickersId: string;
let stickersUnitSatang: number;
let elsewhereItemId: string;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };

beforeAll(async () => {
  ctx = await createTestContext();
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  till1 = t1!.id;
  branchId = t1!.branchId;
  operatorId = t1!.operatorId;
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  expect((await ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie }, payload: { stationId: till1 } })).statusCode).toBe(200);

  const [cap] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'MR-CAP'), isNull(product.archivedAt)));
  capId = cap!.id;
  const [item] = await ctx.db
    .select()
    .from(stockItem)
    .where(and(eq(stockItem.branchId, branchId), eq(stockItem.productId, capId), isNull(stockItem.archivedAt)));
  capItemId = item!.id;
  const quoted = await ctx.app.inject({
    method: 'POST',
    url: '/sales/quote',
    headers: { cookie },
    payload: { stationId: till1, items: [{ id: newId(), productId: capId, quantity: 1 }], channel: 'shop' },
  });
  capUnitSatang = (JSON.parse(quoted.body).quote as { totals: { grossSatang: number } }).totals.grossSatang;

  // Sticker Pack, counted at another branch only: this branch's item is
  // archived and the product's marker points at the other branch's item.
  const [stickers] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'MR-STICKERS'), isNull(product.archivedAt)));
  stickersId = stickers!.id;
  const quotedStickers = await ctx.app.inject({
    method: 'POST',
    url: '/sales/quote',
    headers: { cookie },
    payload: { stationId: till1, items: [{ id: newId(), productId: stickersId, quantity: 1 }], channel: 'shop' },
  });
  stickersUnitSatang = (JSON.parse(quotedStickers.body).quote as { totals: { grossSatang: number } }).totals.grossSatang;
  const others = await ctx.db.select().from(branch).where(and(eq(branch.operatorId, operatorId), isNull(branch.archivedAt)));
  const elsewhere = others.find((b) => b.id !== branchId);
  expect(elsewhere, 'the seed has a second branch').toBeTruthy();
  await ctx.db
    .update(stockItem)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(stockItem.branchId, branchId), eq(stockItem.productId, stickersId)));
  elsewhereItemId = newId();
  await ctx.db.insert(stockItem).values({
    id: elsewhereItemId,
    operatorId,
    branchId: elsewhere!.id,
    name: 'Sticker Pack',
    productId: stickersId,
  });
  await ctx.db.update(product).set({ stockItemId: elsewhereItemId, updatedAt: new Date() }).where(eq(product.id, stickersId));

  // Tracking switched off, as `saveStockItem` leaves it: inactive, still linked.
  await ctx.db.update(stockItem).set({ active: false, updatedAt: new Date() }).where(eq(stockItem.id, capItemId));

  agent = createBoxAgent({
    apiBaseUrl: 'http://stock-gate-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'stock-gate-box',
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, box1.id)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { enabled: false },
    bands: { key: currentBandKey },
  });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  attachInProcessBox(agent);
}, 240_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
});

describe('stock round 3 gate: an item whose tracking was switched off', () => {
  it('the platform sells it uncounted, and the stock scope leaves it out — but the catalogue still marks it', async () => {
    await expect(
      assertCartStock(ctx.db, branchId, [{ kind: 'merch_item', productId: capId, quantity: 50, label: 'Oto Cap', payload: {} }]),
    ).resolves.not.toThrow();
    const snap = await stockCacheItem(ctx.db, { boxId: (await boxBySlot(ctx.db, 'virtual-1')).id, operatorId, branchId });
    expect(snap.items.some((e) => e.productId === capId)).toBe(false);
    const cat = await catalogueCacheItem(ctx.db, operatorId, branchId);
    const row = (cat.products as Array<{ id: string; stockItemId: string | null }>).find((p) => p.id === capId);
    expect(row?.stockItemId).toBe(capItemId);
  });

  it('with the link down the box lane sells it as the platform would (was refused BOX_STOCK_UNKNOWN)', async () => {
    await agent.setOffline(true, { reason: 'stock round 3 gate' });
    link.cut = true;
    const res = await sellOffline(capId, capUnitSatang);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('stock round 3 gate: an operator-wide product counted at another branch only', () => {
  it('the platform sells it uncounted here, the stock scope leaves it out, the catalogue still marks it', async () => {
    await expect(
      assertCartStock(ctx.db, branchId, [{ kind: 'merch_item', productId: stickersId, quantity: 50, label: 'Sticker Pack', payload: {} }]),
    ).resolves.not.toThrow();
    const snap = await stockCacheItem(ctx.db, { boxId: (await boxBySlot(ctx.db, 'virtual-1')).id, operatorId, branchId });
    expect(snap.items.some((e) => e.productId === stickersId)).toBe(false);
    const cat = await catalogueCacheItem(ctx.db, operatorId, branchId);
    const row = (cat.products as Array<{ id: string; stockItemId: string | null }>).find((p) => p.id === stickersId);
    expect(row?.stockItemId).toBe(elsewhereItemId);
  });

  it('with the link down this branch’s box, holding a fresh snapshot, sells it (was refused BOX_STOCK_UNKNOWN)', async () => {
    await agent.setOffline(true, { reason: 'stock round 3 gate' });
    link.cut = true;
    const res = await sellOffline(stickersId, stickersUnitSatang);
    expect(res.statusCode, res.body).toBe(200);
  });
});

async function sellOffline(productId: string, unitSatang: number) {
  return ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${till1}/intents`,
    headers: { cookie },
    payload: {
      type: 'sale.finalise',
      lastSeenSequence: 0,
      actionId: `g-${newId().slice(-12)}`,
      payload: {
        saleId: newId(),
        actionId: `pay-${newId().slice(-12)}`,
        staffName: 'Nok',
        cart: { items: [{ id: newId(), productId, quantity: 1 }], channel: 'shop', expectedTotalSatang: unitSatang },
        tender: {
          actionId: `cash-${newId().slice(-12)}`,
          method: 'cash',
          kind: 'cash',
          amountSatang: unitSatang,
          tenderedSatang: unitSatang,
          changeSatang: 0,
        },
      },
    },
  });
}
