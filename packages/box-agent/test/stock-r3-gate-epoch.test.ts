import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BridgeSaleAnswer, StockFiledMark, StockSnapshotItem } from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import type { BoxConfigBundle } from '../src/protocol';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * S2-14b ROUND 3 GATE (re-check of the epoch rule) — the reviewer's own epoch
 * attacks on `shareReflected` with the box's sealing epoch, kept as tests.
 *
 * The box ADOPTS a new epoch mid-outage between two sales. Adoption without a
 * wipe happens only in `outbox.ts` (a push answer naming another epoch:
 * `store.setEpoch`, the sequence back at 1); it is simulated here with that same
 * store call, because the link is otherwise down.
 *
 *  E1. A snapshot pulled BEFORE the adoption (mark on the old epoch) and used
 *      after it: the old-epoch sale above that mark and the new-epoch sale are
 *      both held against the shelf (cautious) — never past it.
 *  E2. The FINAL (2) set-up carried one step further: the snapshot's mark is
 *      already on the new epoch; the box sells the last unit on the old epoch,
 *      then adopts. From then on the old-epoch sale is one the platform files
 *      aside (`epoch_regressed`: every event of a replaced epoch is quarantined,
 *      never applied), so — exactly as the verified-clean "filed aside" rule —
 *      it is not held against the platform's level; the new-epoch sale is, and
 *      the box never sells past the level the snapshot reports.
 *  E3. The new-epoch mark reaching the box after the adoption: exact again.
 */

const KEY = 'park-band-key-for-the-stock-r3-epoch';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const JTI = '018f0000-0000-7000-8000-0000000000f1';
const PACKAGE = '018f0000-0000-7000-8000-00000000aa01';
const SHOP = '018f0000-0000-7000-8000-0000000000c4';
const CAP = '018f0000-0000-7000-8000-0000000000d2';
const CAP_ITEM = '018f0000-0000-7000-8000-0000000005a3';
const FOH = '018f0000-0000-7000-8000-0000000010c1';

const quiet = { info() {}, warn() {}, error() {} };

function catalogueItem() {
  return {
    version: 'cat-epoch',
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
        stockItemId: CAP_ITEM,
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

function snapshot(total: number, filed: StockFiledMark): StockSnapshotItem {
  return {
    version: `stock-cap-${total}-${filed.journalEpoch}.${filed.boxSeq}`,
    generatedAt: new Date().toISOString(),
    branchId: tillBundle().branch.id,
    sellPointId: FOH,
    places: [{ id: FOH, name: 'FOH', type: 'rotation', sellPoint: true }],
    items: [
      { stockItemId: CAP_ITEM, productId: CAP, itemName: 'Oto Cap', variantId: null, sizeLabel: null, levels: { [FOH]: total }, total },
    ],
    boxFiled: filed,
  };
}

interface Box {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  caller: BridgeTillCaller;
  write(scope: CachedBundle['scope'], items: unknown[]): Promise<void>;
  close(): void;
}

async function openBox(): Promise<Box> {
  const base = tillBundle();
  const bundle: BoxConfigBundle = tillBundle({ box: { ...base.box, id: BOX_ID, epoch: 1 } });
  const cloud = fakeBoxCloud(bundle);
  const harness = openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({ boxId: BOX_ID, secret: 'stock-r3-epoch-secret', syncPrivateKeyPem: harness.keys.privateKeyPem }),
    fetch: cloud.fetch,
    log: quiet,
    store: harness.store,
    printing: { retryDelayMs: 0, durable: true },
    terminal: { enabled: false },
    booth: { enabled: false },
    bands: { key: () => KEY },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const bridge = agent.bridge();
  assert.ok(bridge);
  const write = async (scope: CachedBundle['scope'], items: unknown[]) => {
    harness.setNow(new Date().toISOString());
    await harness.store.writeBundle(BOX_ID, { scope, schemaVersion: 1, cursorSeq: 0, payload: { items }, appliedAt: new Date().toISOString() });
  };
  await write('catalogue', [catalogueItem()]);
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 }]);
  return {
    agent,
    harness,
    bridge,
    caller: { kind: 'till', accountId: ACCOUNT, can: () => true, method: 'offline_token', offlineFresh: false, jti: JTI },
    write,
    close: () => {
      agent.stop();
      harness.close();
    },
  };
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
      tender: { actionId: `cash-${uuidv7().slice(-12)}`, method: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total, changeSatang: 0 },
    }),
  );
  return answer.result as unknown as BridgeSaleAnswer;
}

async function journalHead(box: Box): Promise<StockFiledMark> {
  const state = await box.harness.store.readState(BOX_ID);
  return { journalEpoch: state.journalEpoch, boxSeq: state.nextBoxSeq - 1 };
}

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


async function adopt(box: Box, epoch: number): Promise<void> {
  // What `outbox.ts` does on a push answer naming another epoch.
  await box.harness.store.setEpoch(BOX_ID, epoch, new Date().toISOString());
}

test('EPOCH E1: a snapshot pulled before an adoption and used after it holds both epochs\' sales (cautious)', async () => {
  const box = await openBox();
  try {
    await box.write('stock', [snapshot(2, { journalEpoch: 1, boxSeq: 0 })]);
    assert.equal((await sellCap(box)).finalised, true); // A, epoch 1, above the mark
    await adopt(box, 2);
    assert.equal((await journalHead(box)).journalEpoch, 2);
    assert.equal((await sellCap(box)).finalised, true); // B, epoch 2, seq restarted
    // Shelf 2, two sold since the snapshot: neither hidden by the old-epoch mark.
    await capRefused(box);
    // A copy whose epoch-1 mark has passed A (applied before the reset): B still held.
    await box.write('stock', [snapshot(1, { journalEpoch: 1, boxSeq: 500 })]);
    await capRefused(box);
  } finally {
    box.close();
  }
});

test('EPOCH E2: FINAL (2) carried on — adoption between two sales never sells past the level the snapshot reports', async () => {
  const box = await openBox();
  try {
    await box.write('stock', [snapshot(2, { journalEpoch: 2, boxSeq: 0 })]);
    assert.equal((await sellCap(box)).finalised, true); // A on epoch 1 (not adopted yet)
    assert.equal((await sellCap(box)).finalised, true); // A2 on epoch 1
    await capRefused(box); // the unadopted epoch: both held, shelf 2 gone
    await adopt(box, 2);
    // A and A2 were sealed on a replaced epoch: every one of their events comes
    // back epoch_regressed (filed aside, never applied) — the verified-clean
    // filed-aside rule says they are not held against the level. The level the
    // snapshot reports is 2, nothing of this epoch is in it: 2 sell, then none.
    assert.equal((await sellCap(box)).finalised, true);
    assert.equal((await sellCap(box)).finalised, true);
    await capRefused(box);
  } finally {
    box.close();
  }
});

test('EPOCH E3: the new-epoch mark after the adoption — exact', async () => {
  const box = await openBox();
  try {
    await box.write('stock', [snapshot(3, { journalEpoch: 1, boxSeq: 0 })]);
    assert.equal((await sellCap(box)).finalised, true); // A epoch 1
    await adopt(box, 2);
    assert.equal((await sellCap(box)).finalised, true); // B epoch 2 seq 1
    const b = await journalHead(box);
    assert.equal((await sellCap(box)).finalised, true); // C epoch 2
    await capRefused(box); // 3 - (A + B + C)
    // The platform: A filed aside, B applied, C not yet: level 2, mark at B.
    await box.write('stock', [snapshot(2, b)]);
    assert.equal((await sellCap(box)).finalised, true, 'level 2 less C: one sells');
    await capRefused(box);
  } finally {
    box.close();
  }
});
