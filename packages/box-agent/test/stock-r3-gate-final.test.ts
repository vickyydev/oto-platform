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
 * S2-14b ROUND 3 GATE (final check) — the reviewer's own attacks on the FILED
 * MARK rule, kept as tests.
 *
 *  1. A SALE FILED OUT OF JOURNAL ORDER: the platform applies a later sale of
 *     this box while an earlier position is still a hole. The mark is the
 *     gapless prefix, moved in the push's own transaction, so it stays below the
 *     hole and the box subtracts both sales (cautious) until the hole heals;
 *     once the mark passes both, the box sells exactly what the shelf holds.
 *     Expected to pass.
 *
 *  2. AN EPOCH CHANGE MID-OUTAGE, with the box still sealing on the old epoch.
 *     The platform mints the new epoch in the transaction that accepts a
 *     `reset_store` result (`completeCommand`, apps/api/src/services/box.ts);
 *     the box adopts it only from THAT answer (`takeMintedEpoch`), a command
 *     ack, or a push answer (`outbox.ts`). The heartbeat moves only the
 *     in-memory epoch. So when the result's answer is lost on the way back,
 *     the box keeps sealing on epoch 1 while every `stock` pull since
 *     (`pullStockScope`, which never compares epochs) brings a snapshot whose
 *     filed mark is on epoch 2. `shareReflected` calls every epoch-1 share
 *     reflected by an epoch-2 mark — including the sales this box seals AFTER
 *     that snapshot — so the guard subtracts nothing at all for the whole
 *     outage: one cap on the shelf, any number sold. (Those sales then come
 *     back `epoch_regressed` from the push, so the platform never takes their
 *     stock either.) A share sealed on the box's CURRENT epoch cannot be in the
 *     levels of a snapshot whose mark is on a different epoch.
 */

const KEY = 'park-band-key-for-the-stock-r3-final';
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
    version: 'cat-final',
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
    credentials: memoryCredentialStore({ boxId: BOX_ID, secret: 'stock-r3-final-secret', syncPrivateKeyPem: harness.keys.privateKeyPem }),
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

test('FINAL (1): a sale filed out of journal order — cautious while the hole stands, exact once the mark passes', async () => {
  const box = await openBox();
  try {
    await box.write('stock', [snapshot(3, { journalEpoch: 1, boxSeq: 0 })]);
    assert.equal((await sellCap(box)).finalised, true); // A
    const a = await journalHead(box);
    assert.equal((await sellCap(box)).finalised, true); // B
    // The platform applied B but A's position is a hole: B's cap is in the
    // level (2), the gapless mark is still below A. The box takes both off —
    // the cautious direction, never past the shelf (physically 1 left).
    await box.write('stock', [snapshot(2, { journalEpoch: 1, boxSeq: a.boxSeq - 1 })]);
    await capRefused(box);
    // The hole healed: A applied, the mark walks past B. The shelf's 1 sells, then no more.
    const b = await journalHead(box);
    await box.write('stock', [snapshot(1, b)]);
    assert.equal((await sellCap(box)).finalised, true, 'the stock the shelf has sells once the mark passes');
    await capRefused(box);
  } finally {
    box.close();
  }
});

test('FINAL (2) REPRO: an epoch change the box has not adopted — a snapshot on the new epoch disables the guard for every sale sealed on the old one', async () => {
  const box = await openBox();
  try {
    assert.equal((await journalHead(box)).journalEpoch, 1, 'the box still seals on epoch 1 (the reset_store answer was lost)');
    // The pull after the platform minted epoch 2: one cap on the shelf, the
    // filed mark on the new epoch with nothing pushed there yet.
    await box.write('stock', [snapshot(1, { journalEpoch: 2, boxSeq: 0 })]);
    // The link drops. The last cap sells — correct.
    assert.equal((await sellCap(box)).finalised, true);
    // The shelf is empty: this sale was sealed AFTER the snapshot, on the
    // box's own current epoch, so it cannot be in its levels.
    await capRefused(box);
  } finally {
    box.close();
  }
});
