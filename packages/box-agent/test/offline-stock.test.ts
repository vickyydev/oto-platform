import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BridgeSaleAnswer, StockFiledMark, StockSnapshotItem } from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import type { BoxConfigBundle } from '../src/protocol';
import type { FinaliseCrashPoint } from '../src/sale-queue';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import { STOCK_TAKEN_TOTAL_DAY, STOCK_TAKEN_TOTAL_SCOPE } from '../src/stock-lane';
import type { CachedBundle } from '../src/store';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * COUNTED STOCK ON THE BOX LANE — S2-14b round 3 (plan
 * docs/progress/plans/stock/PLAN.md §2.4).
 *
 * The real agent on a real SQLite store with nothing reachable. The box holds
 * a stock SNAPSHOT; a till sells from it; the box refuses, per size and in the
 * counter's words, what the snapshot less its own sales since cannot fill —
 * an add-on's breakdown size by size — and counts each sale write-ahead in the
 * sale's own store transaction, so a restart forgets nothing and a power cut
 * leaves nothing half-counted. With no snapshot, a stale one, or an item the
 * snapshot has no count for, a counted item is refused honestly, never
 * silently allowed; an item nobody counts sells as before. The api suite
 * (`offline-stock.test.ts`) proves the platform takes the same stock once.
 */

const KEY = 'park-band-key-for-the-offline-stock-test';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const JTI = '018f0000-0000-7000-8000-0000000000f1';
const PACKAGE = '018f0000-0000-7000-8000-00000000aa01';
const SHOP = '018f0000-0000-7000-8000-0000000000c4';
const SOCKS = '018f0000-0000-7000-8000-0000000000d1';
const CAP = '018f0000-0000-7000-8000-0000000000d2';
const STICKERS = '018f0000-0000-7000-8000-0000000000d3';
const GRIP = '018f0000-0000-7000-8000-0000000000d4';
const SI = {
  socksS: '018f0000-0000-7000-8000-0000000005a1',
  socksM: '018f0000-0000-7000-8000-0000000005a2',
  cap: '018f0000-0000-7000-8000-0000000005a3',
  gripS: '018f0000-0000-7000-8000-0000000005a4',
  gripM: '018f0000-0000-7000-8000-0000000005a5',
};
const FOH = '018f0000-0000-7000-8000-0000000010c1';
const BOH = '018f0000-0000-7000-8000-0000000010c2';

const quiet = { info() {}, warn() {}, error() {} };

function catalogueItem() {
  const product = (id: string, kind: string, name: string, priceSatang: number, variants: Array<{ id: string; label: string }>, stockItemId: string | null) => ({
    id,
    kind,
    name,
    priceSatang,
    priceWeekendSatang: null,
    categoryId: SHOP,
    taxCategoryOverride: null,
    prepStationOverride: null,
    variants,
    active: true,
    archivedAt: null,
    stockItemId,
  });
  return {
    version: 'cat-s1',
    packages: [
      {
        id: PACKAGE,
        name: '2 Hours Play',
        active: true,
        archivedAt: null,
        prices: { tourist: { weekday: 35000, weekend: 45000 } },
        adultRules: null,
        hours: 2,
        durationLabel: '2 Hours',
      },
    ],
    categories: [{ id: SHOP, parentId: null, taxableCategory: 'merch', name: 'Shop', defaultPrepStation: null }],
    products: [
      product(SOCKS, 'merch', 'Grip Socks', 9_000, [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }], SI.socksS),
      product(CAP, 'merch', 'Oto Cap', 25_000, [], SI.cap),
      // Nobody counts stickers: no stock item, and not in the snapshot.
      product(STICKERS, 'merch', 'Sticker Pack', 5_000, [], null),
      product(GRIP, 'addon', 'Grip Add-on', 6_000, [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }], SI.gripS),
    ],
    modifierGroups: [],
    modifierOptions: [],
    modifierLinks: [],
    tiers: [{ code: 'tourist', isDefault: true, archivedAt: null }],
    holidays: [],
    taxConfig: {
      config: {
        rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
        categoryRules: ['tickets', 'merch', 'addons', 'fnb'].map((category) => ({ category, taxRateId: 'vat', taxMode: 'inclusive' })),
        discountPlacement: 'before_tax',
      },
    },
    overrides: [],
    receiptHeader: { name: 'HKT Central', address: null, country: 'TH', operatorName: 'OTO' },
  };
}

/**
 * The `stock` scope as the platform builds it: socks S 3, M 0; one cap; grip
 * add-on S 2, M 1 — with the platform's filed mark for this box (nothing of
 * its journal applied yet, unless `filed` says how far).
 */
function snapshot(over: { socksS?: number; cap?: number; filed?: StockFiledMark | null } = {}): StockSnapshotItem {
  const entry = (stockItemId: string, productId: string, itemName: string, variantId: string | null, sizeLabel: string | null, foh: number, boh: number) => ({
    stockItemId,
    productId,
    itemName,
    variantId,
    sizeLabel,
    levels: { [FOH]: foh, [BOH]: boh },
    total: foh + boh,
  });
  const socksS = over.socksS ?? 3;
  const filed = over.filed === undefined ? { journalEpoch: 1, boxSeq: 0 } : over.filed;
  return {
    version: `stock-${socksS}-${over.cap ?? 1}-${filed ? `${filed.journalEpoch}.${filed.boxSeq}` : 'none'}`,
    generatedAt: new Date().toISOString(),
    branchId: tillBundle().branch.id,
    sellPointId: FOH,
    places: [
      { id: FOH, name: 'FOH', type: 'rotation', sellPoint: true },
      { id: BOH, name: 'BOH', type: 'back_of_house', sellPoint: false },
    ],
    items: [
      entry(SI.socksS, SOCKS, 'Grip Socks', 's', 'S', Math.min(2, socksS), Math.max(0, socksS - 2)),
      entry(SI.socksM, SOCKS, 'Grip Socks', 'm', 'M', 0, 0),
      entry(SI.cap, CAP, 'Oto Cap', null, null, over.cap ?? 1, 0),
      entry(SI.gripS, GRIP, 'Grip Add-on', 's', 'S', 2, 0),
      entry(SI.gripM, GRIP, 'Grip Add-on', 'm', 'M', 1, 0),
    ],
    boxFiled: filed,
  };
}

interface StockBox {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  caller: BridgeTillCaller;
  crash: { at: FinaliseCrashPoint | null };
  write(scope: CachedBundle['scope'], items: unknown[], appliedAt?: string): Promise<void>;
  restart(): Promise<void>;
  close(): void;
}

async function openStockBox(opts: { withSnapshot?: boolean } = {}): Promise<StockBox> {
  const bundle: BoxConfigBundle = tillBundle();
  const cloud = fakeBoxCloud(bundle);
  const harness = openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const crash: StockBox['crash'] = { at: null };
  const make = async () => {
    const agent = createBoxAgent({
      apiBaseUrl: 'http://cloud.test',
      credentials: memoryCredentialStore({ boxId: BOX_ID, secret: 'offline-stock-test-secret', syncPrivateKeyPem: harness.keys.privateKeyPem }),
      fetch: cloud.fetch,
      log: quiet,
      store: harness.store,
      printing: { retryDelayMs: 0, durable: true },
      terminal: { enabled: false },
      booth: { enabled: false },
      bands: { key: () => KEY },
      sales: {
        crashPoint: (point) => {
          if (crash.at === point) {
            crash.at = null;
            throw new Error(`the power went at ${point}`);
          }
        },
      },
    });
    await agent.ensureRegistered();
    await agent.syncConfig();
    const bridge = agent.bridge();
    assert.ok(bridge);
    return { agent, bridge };
  };
  const write = async (scope: CachedBundle['scope'], items: unknown[], appliedAt = new Date().toISOString()) => {
    await harness.store.writeBundle(BOX_ID, { scope, schemaVersion: 1, cursorSeq: 0, payload: { items }, appliedAt });
  };
  await write('catalogue', [catalogueItem()]);
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 }]);
  if (opts.withSnapshot !== false) await write('stock', [snapshot()]);
  const box = { harness, crash, write } as unknown as StockBox;
  const first = await make();
  box.agent = first.agent;
  box.bridge = first.bridge;
  box.caller = { kind: 'till', accountId: ACCOUNT, can: () => true, method: 'offline_token', offlineFresh: false, jti: JTI };
  box.restart = async () => {
    box.agent.stop();
    const next = await make();
    box.agent = next.agent;
    box.bridge = next.bridge;
  };
  box.close = () => {
    box.agent.stop();
    harness.close();
  };
  return box;
}

const intent = (type: string, payload: Record<string, unknown>) => ({
  type,
  lastSeenSequence: 0,
  payload,
  actionId: `t-${uuidv7().slice(-12)}`,
});

async function quote(box: StockBox, cart: Record<string, unknown>): Promise<number> {
  const quoted = await box.bridge.intent(STATION_ID, box.caller, intent('cart.quote', cart));
  return (quoted.result as { quote: { totals: { grossSatang: number } } }).quote.totals.grossSatang;
}

/** A shop order of the given lines, priced by the box, as the till would send it with cash. */
async function shopOrder(box: StockBox, items: Array<{ productId: string; quantity: number; size?: string }>) {
  const cart = {
    items: items.map((i) => ({
      id: uuidv7(),
      productId: i.productId,
      quantity: i.quantity,
      ...(i.size ? { variant: { variantId: i.size, variantLabel: i.size.toUpperCase() } } : {}),
    })),
    channel: 'shop',
  };
  const total = await quote(box, cart);
  return { saleId: uuidv7(), actionId: `pay-${uuidv7().slice(-12)}`, cart: { ...cart, expectedTotalSatang: total }, total };
}

/** A ticket for one kid with grip add-ons split across sizes. */
async function ticketOrder(box: StockBox, quantity: number, breakdown?: Array<{ variantId: string; quantity: number }>) {
  const cart = {
    lines: [
      {
        id: uuidv7(),
        packageId: PACKAGE,
        kids: 1,
        adults: 0,
        addOns: [
          {
            id: GRIP,
            quantity,
            ...(breakdown ? { variantBreakdown: breakdown.map((b) => ({ ...b, variantLabel: b.variantId.toUpperCase() })) } : {}),
          },
        ],
      },
    ],
    channel: 'till',
  };
  const total = await quote(box, cart);
  return { saleId: uuidv7(), actionId: `pay-${uuidv7().slice(-12)}`, cart: { ...cart, expectedTotalSatang: total }, total };
}

const cash = (amount: number) => ({
  actionId: `cash-${uuidv7().slice(-12)}`,
  method: 'cash',
  kind: 'cash',
  amountSatang: amount,
  tenderedSatang: amount,
  changeSatang: 0,
});

async function sell(box: StockBox, order: { saleId: string; actionId: string; cart: Record<string, unknown>; total: number }) {
  const answer = await box.bridge.intent(
    STATION_ID,
    box.caller,
    intent('sale.finalise', { saleId: order.saleId, actionId: order.actionId, cart: order.cart, tender: cash(order.total) }),
  );
  return answer.result as unknown as BridgeSaleAnswer;
}

async function refusedAs(box: StockBox, order: { saleId: string; actionId: string; cart: Record<string, unknown>; total: number }, code: string): Promise<BridgeError> {
  let caught: BridgeError | null = null;
  await assert.rejects(sell(box, order), (err: unknown) => {
    if (err instanceof BridgeError && err.code === code) {
      caught = err;
      return true;
    }
    return false;
  });
  return caught!;
}

async function takenOnBox(box: StockBox, stockItemId: string): Promise<number> {
  return box.harness.store.readCounter(BOX_ID, { scope: STOCK_TAKEN_TOTAL_SCOPE, key: stockItemId, businessDate: STOCK_TAKEN_TOTAL_DAY });
}

/** Where a counted sale sits in this box's journal, as the box kept it with its shares. */
async function positionOf(box: StockBox, saleId: string): Promise<StockFiledMark> {
  const kept = JSON.parse((await box.harness.store.readRuntimeValue(BOX_ID, `stock_taken:${saleId}`))!) as StockFiledMark;
  assert.ok(kept.journalEpoch >= 1 && kept.boxSeq >= 1, 'the share is kept with the sale’s journal position');
  return { journalEpoch: kept.journalEpoch, boxSeq: kept.boxSeq };
}

async function facts(box: StockBox) {
  const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 50, maxBytes: 1_000_000, now: new Date().toISOString() });
  await box.harness.store.releaseBatch(
    BOX_ID,
    batch.events.map((e) => e.eventId),
    { errorCode: 'TEST_PEEK', errorMessage: 'peeked', retryAt: new Date(0).toISOString() },
  );
  return batch.events;
}

test('the guard per size: more than the snapshot holds is refused in the counter’s words, and nothing is written', async () => {
  const box = await openStockBox();
  try {
    const four = await shopOrder(box, [{ productId: SOCKS, quantity: 4, size: 's' }]);
    const refused = await refusedAs(box, four, 'STOCK_SHORT');
    assert.equal(refused.message, 'Only 3 Grip Socks S left. Nothing was saved.');
    const outM = await refusedAs(box, await shopOrder(box, [{ productId: SOCKS, quantity: 1, size: 'm' }]), 'STOCK_SHORT');
    assert.equal(outM.message, 'Grip Socks M is out of stock. Nothing was saved.');
    // Two lines of one size count together.
    const split = await shopOrder(box, [
      { productId: SOCKS, quantity: 2, size: 's' },
      { productId: SOCKS, quantity: 2, size: 's' },
    ]);
    assert.equal((await refusedAs(box, split, 'STOCK_SHORT')).message, 'Only 3 Grip Socks S left. Nothing was saved.');
    assert.equal(await takenOnBox(box, SI.socksS), 0);
    assert.equal((await facts(box)).length, 0, 'a refusal numbers, queues and counts nothing');
    assert.equal(await box.agent.sales()!.recorded(four.saleId), null);
  } finally {
    box.close();
  }
});

test('write-ahead: each sale counts its sizes in its own transaction, and the count survives a restart', async () => {
  const box = await openStockBox();
  try {
    const two = await shopOrder(box, [{ productId: SOCKS, quantity: 2, size: 's' }]);
    const answer = await sell(box, two);
    assert.equal(answer.finalised, true);
    assert.equal(await takenOnBox(box, SI.socksS), 2);
    const kept = JSON.parse((await box.harness.store.readRuntimeValue(BOX_ID, `stock_taken:${two.saleId}`))!) as {
      shares: Array<{ stockItemId: string; quantity: number }>;
    };
    assert.deepEqual(kept.shares.map((s) => [s.stockItemId, s.quantity]), [[SI.socksS, 2]]);
    assert.deepEqual((await facts(box)).map((f) => f.type), ['sale.finalised']);

    // The same press again is the log's answer: nothing counted twice.
    const again = await sell(box, two);
    assert.equal(again.replay, true);
    assert.equal(await takenOnBox(box, SI.socksS), 2);

    // 3 in the snapshot, 2 sold here: one left.
    assert.equal(
      (await refusedAs(box, await shopOrder(box, [{ productId: SOCKS, quantity: 2, size: 's' }]), 'STOCK_SHORT')).message,
      'Only 1 Grip Socks S left. Nothing was saved.',
    );

    await box.restart();

    // A Pi back from a power cut remembers what it sold.
    assert.equal(await takenOnBox(box, SI.socksS), 2);
    assert.equal(
      (await refusedAs(box, await shopOrder(box, [{ productId: SOCKS, quantity: 2, size: 's' }]), 'STOCK_SHORT')).message,
      'Only 1 Grip Socks S left. Nothing was saved.',
    );
    const last = await shopOrder(box, [{ productId: SOCKS, quantity: 1, size: 's' }]);
    assert.equal((await sell(box, last)).finalised, true);
    assert.equal(
      (await refusedAs(box, await shopOrder(box, [{ productId: SOCKS, quantity: 1, size: 's' }]), 'STOCK_SHORT')).message,
      'Grip Socks S is out of stock. Nothing was saved.',
    );

    // The link came back and the first sale synced: the platform's copy now
    // holds 1 and its filed mark is the first sale's position. The later sale
    // (1) is above the mark, so nothing is left — and nothing is taken off twice.
    const first = await positionOf(box, two.saleId);
    const second = await positionOf(box, last.saleId);
    assert.ok(second.boxSeq > first.boxSeq);
    await box.write('stock', [snapshot({ socksS: 1, filed: first })]);
    assert.equal(
      (await refusedAs(box, await shopOrder(box, [{ productId: SOCKS, quantity: 1, size: 's' }]), 'STOCK_SHORT')).message,
      'Grip Socks S is out of stock. Nothing was saved.',
    );
    // A delivery arrived and everything synced: 5 on the shelf, the mark past both.
    await box.write('stock', [snapshot({ socksS: 5, filed: second })]);
    assert.equal((await sell(box, await shopOrder(box, [{ productId: SOCKS, quantity: 5, size: 's' }]))).finalised, true);
    assert.equal(await takenOnBox(box, SI.socksS), 8);
  } finally {
    box.close();
  }
});

test('an add-on’s breakdown is guarded size by size, and an unsized one is refused', async () => {
  const box = await openStockBox();
  try {
    // Grip add-on S 2, M 1: two M is short although three add-ons "fit" in total.
    const twoM = await ticketOrder(box, 2, [{ variantId: 'm', quantity: 2 }]);
    assert.equal((await refusedAs(box, twoM, 'STOCK_SHORT')).message, 'Only 1 Grip Add-on M left. Nothing was saved.');
    const unsized = await ticketOrder(box, 1);
    assert.equal(
      (await refusedAs(box, unsized, 'STOCK_SIZE_REQUIRED')).message,
      'Choose a size for Grip Add-on — it comes in S, M. Nothing was saved.',
    );
    const fits = await ticketOrder(box, 3, [
      { variantId: 's', quantity: 2 },
      { variantId: 'm', quantity: 1 },
    ]);
    assert.equal((await sell(box, fits)).finalised, true);
    assert.deepEqual([await takenOnBox(box, SI.gripS), await takenOnBox(box, SI.gripM)], [2, 1]);
    const queued = await facts(box);
    const addOn = (queued[0]!.payload as { cart: { lines: Array<{ addOns: Array<{ variantBreakdown?: unknown[] }> }> } }).cart.lines[0]!.addOns[0]!;
    assert.equal(addOn.variantBreakdown?.length, 2, 'the breakdown rides the fact, so the platform takes each size');
    assert.equal(
      (await refusedAs(box, await ticketOrder(box, 1, [{ variantId: 's', quantity: 1 }]), 'STOCK_SHORT')).message,
      'Grip Add-on S is out of stock. Nothing was saved.',
    );
  } finally {
    box.close();
  }
});

for (const point of ['after_receipt', 'after_fact', 'after_log'] as const) {
  test(`a power cut ${point.replace(/_/g, ' ')} leaves the stock count untouched`, async () => {
    const box = await openStockBox();
    try {
      const one = await shopOrder(box, [{ productId: CAP, quantity: 1 }]);
      box.crash.at = point;
      await assert.rejects(sell(box, one), /the power went/);
      assert.equal(await takenOnBox(box, SI.cap), 0, 'the count rolled back with the sale');
      assert.equal(await box.harness.store.readRuntimeValue(BOX_ID, `stock_taken:${one.saleId}`), null);
      assert.equal((await facts(box)).length, 0);
      assert.equal((await sell(box, one)).finalised, true, 'the retry takes the last cap');
      assert.equal(await takenOnBox(box, SI.cap), 1);
    } finally {
      box.close();
    }
  });
}

test('honest when it cannot know: no snapshot or a stale one refuses a marked item; a fresh snapshot alone decides what is counted', async () => {
  const box = await openStockBox({ withSnapshot: false });
  try {
    const cap = await shopOrder(box, [{ productId: CAP, quantity: 1 }]);
    const none = await refusedAs(box, cap, 'BOX_STOCK_UNKNOWN');
    assert.match(none.message, /has no stock count for that item, so it cannot be sold here/);
    // Stickers are not counted: they sell with or without a snapshot.
    assert.equal((await sell(box, await shopOrder(box, [{ productId: STICKERS, quantity: 2 }]))).finalised, true);

    // A copy a day old is not trusted for counted items.
    await box.write('stock', [snapshot()], new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    const stale = await refusedAs(box, cap, 'BOX_STOCK_STALE');
    assert.match(stale.message, /has not had a stock count from the internet for over a day/);

    // A fresh copy that has no row for an item the catalogue still marks: the
    // snapshot alone decides, as the platform does (tracking switched off, or
    // the product is counted only at another branch) — it sells uncounted.
    const partial = snapshot();
    partial.items = partial.items.filter((e) => e.productId !== CAP);
    await box.write('stock', [partial]);
    assert.equal((await sell(box, cap)).finalised, true);
    assert.equal(await takenOnBox(box, SI.cap), 0, 'an uncounted sale moves no count');
    assert.equal(await box.harness.store.readRuntimeValue(BOX_ID, `stock_taken:${cap.saleId}`), null);

    // The same marker with a stale copy is still refused: the box cannot know.
    await box.write('stock', [partial], new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    assert.equal((await refusedAs(box, await shopOrder(box, [{ productId: CAP, quantity: 1 }]), 'BOX_STOCK_STALE')).code, 'BOX_STOCK_STALE');

    await box.write('stock', [snapshot()]);
    assert.equal((await sell(box, await shopOrder(box, [{ productId: CAP, quantity: 1 }]))).finalised, true);
    assert.equal(await takenOnBox(box, SI.cap), 1);
    assert.equal(await takenOnBox(box, SI.socksS), 0);
  } finally {
    box.close();
  }
});
