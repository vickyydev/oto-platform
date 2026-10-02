import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BridgeSaleAnswer, StockFiledMark, StockSnapshotItem } from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import type { BoxConfigBundle } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import { STOCK_TAKEN_TOTAL_DAY, STOCK_TAKEN_TOTAL_SCOPE } from '../src/stock-lane';
import type { CachedBundle } from '../src/store';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * S2-14b ROUND 3 GATE (re-check) — REPRODUCTION, kept as a test.
 *
 * The box guard computes what it may sell of a size as
 *
 *     snapshot total − max(0, takenOnBox − boxTaken)
 *
 * where `takenOnBox` is the box's ALL-DAYS count of the units its sales
 * counted and `boxTaken` is the platform's ALL-DAYS sum of this box's
 * `offline_sale` movements. The two are cumulative totals of DIFFERENT sets:
 * the platform files every offline sale of this box that takes stock, while
 * the box counts only the sales it planned against a snapshot entry. Any sale
 * the platform files for this box that the box did not count — sold while the
 * fresh snapshot had no row for the item (tracking off, then switched on before
 * the replay), a `skip` sale (a booking redeemed, a held tender) with no
 * snapshot yet, a store re-initialised under the same box id, a box sale filed
 * before this round's software — makes `boxTaken` exceed `takenOnBox` FOR
 * EVER, and that surplus silently swallows the same number of later,
 * genuinely unreflected sales: the box sells past the shelf in every outage.
 *
 * The scenario below: Oto Cap is not counted (the fresh snapshot has no row
 * for it), the box sells one cap offline uncounted. A manager switches
 * tracking on with two caps on the shelf; the box reconnects, its sale is
 * filed (`offline_sale`, box id = this box), and the next snapshot says one
 * cap left and `boxTaken: 1`. The box goes offline again and sells that last
 * cap (correct). A second cap must now be refused — the snapshot said one,
 * this box has sold one since — but it is sold.
 *
 * THE FIX (fix round 3): the snapshot carries the platform's FILED MARK for
 * this box — its journal epoch and the highest position applied — and the box
 * keeps each counted sale's share with the sale's own position. A share is
 * unreflected only when it sits above the mark: no all-time totals compared,
 * so nothing either side counted that the other did not can drift the guard.
 * The reproduction is kept, with the mark the platform now sends, and the
 * cases the reviewer named follow it.
 */

const KEY = 'park-band-key-for-the-stock-r3-recheck';
const BOX_2 = '018f0000-0000-7000-8000-00000000b0c6';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const JTI = '018f0000-0000-7000-8000-0000000000f1';
const PACKAGE = '018f0000-0000-7000-8000-00000000aa01';
const SHOP = '018f0000-0000-7000-8000-0000000000c4';
const CAP = '018f0000-0000-7000-8000-0000000000d2';
const CAP_ITEM = '018f0000-0000-7000-8000-0000000005a3';
const FOH = '018f0000-0000-7000-8000-0000000010c1';

const quiet = { info() {}, warn() {}, error() {} };

function catalogueItem(opts: { marked?: boolean } = {}) {
  return {
    version: 'cat-recheck',
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
      {
        id: CAP,
        kind: 'merch',
        name: 'Oto Cap',
        priceSatang: 25_000,
        priceWeekendSatang: null,
        categoryId: SHOP,
        taxCategoryOverride: null,
        prepStationOverride: null,
        variants: [],
        active: true,
        archivedAt: null,
        stockItemId: opts.marked === false ? null : CAP_ITEM,
      },
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

/** The platform's `stock` scope: caps counted or not, at the level given, with this box's filed mark. */
function snapshot(cap: { total: number; filed: StockFiledMark } | null): StockSnapshotItem {
  return {
    version: cap ? `stock-cap-${cap.total}-${cap.filed.journalEpoch}.${cap.filed.boxSeq}` : 'stock-no-cap',
    generatedAt: new Date().toISOString(),
    branchId: tillBundle().branch.id,
    sellPointId: FOH,
    places: [{ id: FOH, name: 'FOH', type: 'rotation', sellPoint: true }],
    items: cap
      ? [
          {
            stockItemId: CAP_ITEM,
            productId: CAP,
            itemName: 'Oto Cap',
            variantId: null,
            sizeLabel: null,
            levels: { [FOH]: cap.total },
            total: cap.total,
          },
        ]
      : [],
    boxFiled: cap ? cap.filed : { journalEpoch: 1, boxSeq: 0 },
  };
}

interface Box {
  boxId: string;
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  caller: BridgeTillCaller;
  write(scope: CachedBundle['scope'], items: unknown[]): Promise<void>;
  /** Stop the agent and start a new one on the same store: a Pi back from a power cut. */
  restart(): Promise<void>;
  close(): void;
}

async function openBox(
  opts: { boxId?: string; marked?: boolean; clock?: () => number; epoch?: number } = {},
): Promise<Box> {
  const boxId = opts.boxId ?? BOX_ID;
  const clock = opts.clock ?? (() => Date.now());
  const base = tillBundle();
  const bundle: BoxConfigBundle = tillBundle({ box: { ...base.box, id: boxId, epoch: opts.epoch ?? 1 } });
  const cloud = fakeBoxCloud(bundle);
  const harness = openTestStore(new Date(clock()).toISOString());
  await harness.store.init(boxId);
  if (opts.epoch && opts.epoch > 1) await harness.store.setEpoch(boxId, opts.epoch);
  const make = async () => {
    const agent = createBoxAgent({
      apiBaseUrl: 'http://cloud.test',
      credentials: memoryCredentialStore({ boxId, secret: 'stock-r3-recheck-secret', syncPrivateKeyPem: harness.keys.privateKeyPem }),
      fetch: cloud.fetch,
      log: quiet,
      store: harness.store,
      printing: { retryDelayMs: 0, durable: true },
      terminal: { enabled: false },
      booth: { enabled: false },
      bands: { key: () => KEY },
      now: clock,
    });
    await agent.ensureRegistered();
    await agent.syncConfig();
    const bridge = agent.bridge();
    assert.ok(bridge);
    return { agent, bridge };
  };
  const write = async (scope: CachedBundle['scope'], items: unknown[]) => {
    harness.setNow(new Date(clock()).toISOString());
    await harness.store.writeBundle(boxId, {
      scope,
      schemaVersion: 1,
      cursorSeq: 0,
      payload: { items },
      appliedAt: new Date(clock()).toISOString(),
    });
  };
  await write('catalogue', [catalogueItem({ marked: opts.marked !== false })]);
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 }]);
  const first = await make();
  const box: Box = {
    boxId,
    agent: first.agent,
    harness,
    bridge: first.bridge,
    caller: { kind: 'till', accountId: ACCOUNT, can: () => true, method: 'offline_token', offlineFresh: false, jti: JTI },
    write,
    restart: async () => {
      box.agent.stop();
      const next = await make();
      box.agent = next.agent;
      box.bridge = next.bridge;
    },
    close: () => {
      box.agent.stop();
      harness.close();
    },
  };
  return box;
}

const intent = (type: string, payload: Record<string, unknown>) => ({
  type,
  lastSeenSequence: 0,
  payload,
  actionId: `t-${uuidv7().slice(-12)}`,
});

async function sellCap(box: Box): Promise<BridgeSaleAnswer> {
  const cart = { items: [{ id: uuidv7(), productId: CAP, quantity: 1 }], channel: 'shop' };
  const quoted = await box.bridge.intent(STATION_ID, box.caller, intent('cart.quote', cart));
  const total = (quoted.result as { quote: { totals: { grossSatang: number } } }).quote.totals.grossSatang;
  const answer = await box.bridge.intent(
    STATION_ID,
    box.caller,
    intent('sale.finalise', {
      saleId: uuidv7(),
      actionId: `pay-${uuidv7().slice(-12)}`,
      cart: { ...cart, expectedTotalSatang: total },
      tender: {
        actionId: `cash-${uuidv7().slice(-12)}`,
        method: 'cash',
        kind: 'cash',
        amountSatang: total,
        tenderedSatang: total,
        changeSatang: 0,
      },
    }),
  );
  return answer.result as unknown as BridgeSaleAnswer;
}

const takenOnBox = (box: Box) =>
  box.harness.store.readCounter(box.boxId, { scope: STOCK_TAKEN_TOTAL_SCOPE, key: CAP_ITEM, businessDate: STOCK_TAKEN_TOTAL_DAY });

/**
 * Where this box's journal stands: what the platform's mark reads once
 * everything the box has queued so far is applied (or filed aside).
 */
async function journalHead(box: Box): Promise<StockFiledMark> {
  const state = await box.harness.store.readState(box.boxId);
  return { journalEpoch: state.journalEpoch, boxSeq: state.nextBoxSeq - 1 };
}

/** A cap sale that must be refused, in the counter's words. */
async function capRefused(box: Box, message = 'Oto Cap is out of stock. Nothing was saved.'): Promise<void> {
  let refused: BridgeError | null = null;
  try {
    await sellCap(box);
  } catch (err) {
    if (err instanceof BridgeError) refused = err;
    else throw err;
  }
  assert.ok(refused, 'a cap the shelf does not hold was sold');
  assert.equal(refused.code, 'STOCK_SHORT');
  assert.equal(refused.message, message);
}

test('GATE REPRO: a box sale the platform files but the box did not count swallows a later unreflected sale — the box sells past the shelf', async () => {
  const box = await openBox();
  try {
    // 1. Caps not counted here (fresh snapshot, no row): one sells uncounted.
    await box.write('stock', [snapshot(null)]);
    assert.equal((await sellCap(box)).finalised, true);
    assert.equal(await takenOnBox(box), 0, 'the uncounted sale moved no count (as designed)');

    // 2. Tracking switched on with two caps; the box's sale is filed as an
    //    offline_sale of THIS box. The platform's next snapshot: one cap left,
    //    its filed mark past that sale.
    await box.write('stock', [snapshot({ total: 1, filed: await journalHead(box) })]);

    // 3. Offline again: the last cap sells — correct.
    assert.equal((await sellCap(box)).finalised, true);
    assert.equal(await takenOnBox(box), 1);

    // 4. The shelf is empty: snapshot 1, this box sold 1 since. A second cap
    //    must be refused in the counter's words.
    let refused: BridgeError | null = null;
    try {
      await sellCap(box);
    } catch (err) {
      if (err instanceof BridgeError) refused = err;
      else throw err;
    }
    assert.ok(refused, 'a cap the shelf does not hold was SOLD: the platform-filed uncounted sale absorbed the unreflected one');
    assert.equal(refused.code, 'STOCK_SHORT');
    assert.equal(refused.message, 'Oto Cap is out of stock. Nothing was saved.');
  } finally {
    box.close();
  }
});

test('a sale with no snapshot behind it (uncounted, later filed) leaks nothing: the mark passes it and the shelf is the snapshot', async () => {
  // No stock scope at all and no catalogue marker: the cap sells uncounted, as
  // a skip-planned sale with no snapshot (a booking redeemed, a held tender
  // closed after a crash) does.
  const box = await openBox({ marked: false });
  try {
    assert.equal((await sellCap(box)).finalised, true);
    assert.equal((await sellCap(box)).finalised, true);
    assert.equal(await takenOnBox(box), 0);
    // Tracking on with three caps; both box sales filed: one left, the mark past both.
    await box.write('stock', [snapshot({ total: 1, filed: await journalHead(box) })]);
    assert.equal((await sellCap(box)).finalised, true, 'the last cap sells');
    await capRefused(box);
    // The platform files that one too: the next snapshot is 0 and the box agrees.
    await box.write('stock', [snapshot({ total: 0, filed: await journalHead(box) })]);
    await capRefused(box);
  } finally {
    box.close();
  }
});

test('a counted sale the platform filed aside (quarantined, never applied) stops counting once the mark passes it: no permanent refusal', async () => {
  const box = await openBox();
  try {
    await box.write('stock', [snapshot({ total: 2, filed: { journalEpoch: 1, boxSeq: 0 } })]);
    assert.equal((await sellCap(box)).finalised, true);
    const filedAside = await journalHead(box);
    assert.equal((await sellCap(box)).finalised, true);
    await capRefused(box);
    // A short window online: the first sale reached the platform and was
    // filed aside (quarantined — its stock never taken), so the shelf still
    // says 2 and the mark is past it. Only the second sale is above the mark:
    // one cap is sellable, not none.
    await box.write('stock', [snapshot({ total: 2, filed: filedAside })]);
    assert.equal((await sellCap(box)).finalised, true, 'the filed-aside sale is not held against the shelf');
    await capRefused(box);
    // Everything else applied: the shelf is at 0 and the box agrees.
    await box.write('stock', [snapshot({ total: 0, filed: await journalHead(box) })]);
    await capRefused(box);
    // A delivery of 2: both sell, none of the old sales held against them.
    await box.write('stock', [snapshot({ total: 2, filed: await journalHead(box) })]);
    assert.equal((await sellCap(box)).finalised, true);
    assert.equal((await sellCap(box)).finalised, true);
    await capRefused(box);
  } finally {
    box.close();
  }
});

test('restart: the open shares and their positions survive a power cut', async () => {
  const box = await openBox();
  try {
    await box.write('stock', [snapshot({ total: 3, filed: { journalEpoch: 1, boxSeq: 0 } })]);
    assert.equal((await sellCap(box)).finalised, true);
    const first = await journalHead(box);
    assert.equal((await sellCap(box)).finalised, true);
    await box.restart();
    assert.equal((await sellCap(box)).finalised, true, 'three on the shelf, two sold before the cut');
    await capRefused(box);
    await box.restart();
    // The platform has the first sale only: 2 left, two of this box's above the mark.
    await box.write('stock', [snapshot({ total: 2, filed: first })]);
    await capRefused(box);
    assert.equal(await takenOnBox(box), 3);
  } finally {
    box.close();
  }
});

test("midnight: a sale either side of the park's day boundary counts against the same snapshot", async () => {
  // 23:58 in Bangkok, then 00:02 the next day, then later that night.
  let now = Date.parse('2026-10-02T16:58:00.000Z');
  const box = await openBox({ clock: () => now });
  try {
    await box.write('stock', [snapshot({ total: 2, filed: { journalEpoch: 1, boxSeq: 0 } })]);
    assert.equal((await sellCap(box)).finalised, true);
    now = Date.parse('2026-10-02T17:02:00.000Z');
    assert.equal((await sellCap(box)).finalised, true);
    await capRefused(box);
    now = Date.parse('2026-10-02T18:30:00.000Z');
    await capRefused(box);
  } finally {
    box.close();
  }
});

test("two boxes: each subtracts only its own sales above its own mark; the other box's filed sales are in the levels", async () => {
  const a = await openBox();
  const b = await openBox({ boxId: BOX_2 });
  try {
    const start = { journalEpoch: 1, boxSeq: 0 };
    await a.write('stock', [snapshot({ total: 3, filed: start })]);
    await b.write('stock', [snapshot({ total: 3, filed: start })]);
    assert.equal((await sellCap(a)).finalised, true);
    assert.equal((await sellCap(b)).finalised, true);
    // A reconnects first: its sale filed. Shelf 2, A's mark past its sale.
    await a.write('stock', [snapshot({ total: 2, filed: await journalHead(a) })]);
    // A's own copy: 2 on the shelf, its sale in the level — not taken off twice.
    assert.equal((await sellCap(a)).finalised, true);
    assert.equal((await sellCap(a)).finalised, true);
    await capRefused(a);
    // B still offline on its old copy: 3 less its own 1, so it sells one more
    // (the shelf's last, sold twice across the two boxes: what the platform's
    // oversold anomaly is for — the guard can only know its own box's sales).
    assert.equal((await sellCap(b)).finalised, true);
    // B reconnects: both of its sales filed; the level floors at 0.
    await b.write('stock', [snapshot({ total: 0, filed: await journalHead(b) })]);
    await capRefused(b);
    // A's next copy: shelf 0. B's sales are in the level and never subtracted by A.
    await a.write('stock', [snapshot({ total: 0, filed: await journalHead(a) })]);
    await capRefused(a);
    // A delivery of 2: each box may sell 2, neither drifting from the other's history.
    await a.write('stock', [snapshot({ total: 2, filed: await journalHead(a) })]);
    await b.write('stock', [snapshot({ total: 2, filed: await journalHead(b) })]);
    assert.equal((await sellCap(a)).finalised, true);
    assert.equal((await sellCap(a)).finalised, true);
    await capRefused(a);
    assert.equal((await sellCap(b)).finalised, true);
  } finally {
    a.close();
    b.close();
  }
});

test('a re-provisioned store under the same box id starts clean on its new epoch', async () => {
  // The old store sold on epoch 1 (the platform's mark there is long past it);
  // the new store is on epoch 2 with nothing of its own.
  const box = await openBox({ epoch: 2 });
  try {
    assert.equal((await journalHead(box)).journalEpoch, 2);
    await box.write('stock', [snapshot({ total: 1, filed: { journalEpoch: 2, boxSeq: 0 } })]);
    assert.equal((await sellCap(box)).finalised, true);
    await capRefused(box);
    // A copy still on the old epoch's mark does not reflect this store's sale.
    await box.write('stock', [snapshot({ total: 1, filed: { journalEpoch: 1, boxSeq: 500 } })]);
    await capRefused(box);
    // Nor does a copy whose mark is on a NEWER epoch this store never adopted:
    // the sale was sealed on the store's own epoch 2, so only an epoch-2 mark
    // can hold it (the final gate's finding — this step once sold past the shelf).
    await box.write('stock', [snapshot({ total: 1, filed: { journalEpoch: 3, boxSeq: 0 } })]);
    await capRefused(box);
    // An epoch-2 mark past the sale: it is in the level, and the shelf's one sells.
    await box.write('stock', [snapshot({ total: 1, filed: await journalHead(box) })]);
    assert.equal((await sellCap(box)).finalised, true);
    await capRefused(box);
  } finally {
    box.close();
  }
});
