import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  businessDate,
  type BridgeSaleAnswer,
  type BridgeWalletBalance,
  type BridgeWalletSpendAnswer,
  type WalletSnapshotItem,
} from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import type { BoxConfigBundle } from '../src/protocol';
import type { FinaliseCrashPoint } from '../src/sale-queue';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import { WALLET_SPEND_COUNTER_SCOPE, walletKeyDigestsOf } from '../src/wallet-lane';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * CREDIT ON THE BOX LANE, UNDER THE CAP — S2-14a round 4 (plan
 * docs/progress/plans/wallet/PLAN.md §2.6).
 *
 * The real agent on a real SQLite store with nothing reachable: a till scans a
 * band or voucher, the box finds the wallet in its balance SNAPSHOT, takes
 * credit up to min(snapshot, ฿300 a day counted on this box), and writes it
 * ahead in the store transaction an offline sale is written in — the sale,
 * its number and paper, `sale.finalised` and `wallet.spent`, and the wallet's
 * day on this box, all or none. The api suite (`offline-wallet.test.ts`)
 * proves the same facts land once, and the overdraft.
 */

const KEY = 'park-band-key-for-the-offline-wallet-test';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const JTI = '018f0000-0000-7000-8000-0000000000f1';
const RICE = '018f0000-0000-7000-8000-0000000000c5';
const JUICE = '018f0000-0000-7000-8000-0000000000c6';
const FOOD = '018f0000-0000-7000-8000-0000000000c4';
const WALLET = '018f0000-0000-7000-8000-00000000aa77';
const EMPTY = '018f0000-0000-7000-8000-00000000aa78';
const OLD = '018f0000-0000-7000-8000-00000000aa79';
const QR = 'QR-WALLETROUNDFOURTEST01';
const EMPTY_QR = 'QR-WALLETROUNDFOUREMPTY1';
const OLD_QR = 'QR-WALLETROUNDFOURGONE01';

const quiet = { info() {}, warn() {}, error() {} };

function catalogueItem() {
  const product = (id: string, name: string, priceSatang: number) => ({
    id,
    kind: 'menu',
    name,
    priceSatang,
    priceWeekendSatang: null,
    categoryId: FOOD,
    taxCategoryOverride: null,
    prepStationOverride: null,
    variants: [],
    active: true,
    archivedAt: null,
  });
  return {
    version: 'cat-w1',
    packages: [],
    categories: [{ id: FOOD, parentId: null, taxableCategory: 'fnb', name: 'Food', defaultPrepStation: 'kitchen' }],
    products: [product(RICE, 'Fried rice', 12_000), product(JUICE, 'Juice', 5_000)],
    modifierGroups: [],
    modifierOptions: [],
    modifierLinks: [],
    tiers: [{ code: 'tourist', isDefault: true, archivedAt: null }],
    holidays: [],
    taxConfig: {
      config: {
        rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
        categoryRules: [{ category: 'fnb', taxRateId: 'vat', taxMode: 'inclusive' }],
        discountPlacement: 'before_tax',
      },
    },
    overrides: [],
    paymentMethods: [{ code: 'partner_tender', kind: 'other', enabled: true }],
    receiptHeader: { name: 'HKT Central', address: null, country: 'TH', operatorName: 'OTO' },
  };
}

/** The `wallets` scope as the platform builds it: balances, the cap, keys as digests. */
function snapshot(over: Partial<WalletSnapshotItem> = {}, balance = 50_000): WalletSnapshotItem {
  return {
    version: 'w-v1',
    generatedAt: new Date().toISOString(),
    branchId: tillBundle().branch.id,
    businessDate: businessDate(new Date(), 'Asia/Bangkok', 5 * 60),
    capSatang: 30_000,
    truncated: false,
    wallets: [
      { id: WALLET, status: 'active', balanceSatang: balance, expiresAt: null, boxSpentSatang: 0, keys: walletKeyDigestsOf({ kind: 'voucher_qr', value: QR }) },
      { id: EMPTY, status: 'active', balanceSatang: 0, expiresAt: null, boxSpentSatang: 0, keys: walletKeyDigestsOf({ kind: 'voucher_qr', value: EMPTY_QR }) },
      {
        id: OLD,
        status: 'active',
        balanceSatang: 10_000,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        boxSpentSatang: 0,
        keys: walletKeyDigestsOf({ kind: 'voucher_qr', value: OLD_QR }),
      },
    ],
    ...over,
  };
}

interface WalletBox {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  caller: BridgeTillCaller;
  crash: { at: FinaliseCrashPoint | null };
  write(scope: CachedBundle['scope'], items: unknown[], appliedAt?: string): Promise<void>;
  /** A restart: a new agent over the same store, as a Pi coming back from a power cut. */
  restart(): Promise<void>;
  close(): void;
}

async function openWalletBox(): Promise<WalletBox> {
  const bundle: BoxConfigBundle = tillBundle();
  const cloud = fakeBoxCloud(bundle);
  const harness = openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const crash: WalletBox['crash'] = { at: null };
  const make = async () => {
    const agent = createBoxAgent({
      apiBaseUrl: 'http://cloud.test',
      credentials: memoryCredentialStore({
        boxId: BOX_ID,
        secret: 'offline-wallet-test-secret',
        syncPrivateKeyPem: harness.keys.privateKeyPem,
      }),
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
  await write('wallets', [snapshot()]);
  const box = { harness, crash, write } as unknown as WalletBox;
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

async function send<T = BridgeSaleAnswer>(box: WalletBox, type: string, body: Record<string, unknown>): Promise<T> {
  const answer = await box.bridge.intent(STATION_ID, box.caller, intent(type, body));
  return answer.result as unknown as T;
}

async function refusedAs(box: WalletBox, type: string, body: Record<string, unknown>, code: string): Promise<BridgeError> {
  let caught: BridgeError | null = null;
  await assert.rejects(box.bridge.intent(STATION_ID, box.caller, intent(type, body)), (err: unknown) => {
    if (err instanceof BridgeError && err.code === code) {
      caught = err;
      return true;
    }
    return false;
  });
  return caught!;
}

/** A food order: `rice` plates and `juice` glasses, priced by the box. */
async function order(box: WalletBox, rice: number, juice = 0, channel: 'fnb' | null = 'fnb') {
  const items = [
    ...(rice ? [{ id: uuidv7(), productId: RICE, quantity: rice }] : []),
    ...(juice ? [{ id: uuidv7(), productId: JUICE, quantity: juice }] : []),
  ];
  const cart = { items, pickupCode: '7', ...(channel ? { channel } : {}) };
  const quoted = await box.bridge.intent(STATION_ID, box.caller, intent('cart.quote', cart));
  const total = (quoted.result as { quote: { totals: { grossSatang: number } } }).quote.totals.grossSatang;
  return { total, saleId: uuidv7(), actionId: `pay-${uuidv7().slice(-12)}`, cart: { ...cart, expectedTotalSatang: total } };
}

const credit = (key: string, extra: Record<string, unknown> = { useCredit: true }) => ({
  key,
  actionId: uuidv7(),
  ...extra,
});

const cash = (amount: number) => ({
  actionId: `cash-${uuidv7().slice(-12)}`,
  method: 'cash',
  kind: 'cash',
  amountSatang: amount,
  tenderedSatang: amount,
  changeSatang: 0,
});

async function dayCount(box: WalletBox, walletId = WALLET): Promise<number> {
  return box.harness.store.readCounter(BOX_ID, {
    scope: WALLET_SPEND_COUNTER_SCOPE,
    key: walletId,
    businessDate: businessDate(new Date(), 'Asia/Bangkok', 5 * 60),
  });
}

async function facts(box: WalletBox) {
  const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 50, maxBytes: 1_000_000, now: new Date().toISOString() });
  // Put them back: a test reading the queue must not send it.
  await box.harness.store.releaseBatch(
    BOX_ID,
    batch.events.map((e) => e.eventId),
    { errorCode: 'TEST_PEEK', errorMessage: 'peeked', retryAt: new Date(0).toISOString() },
  );
  return batch.events;
}

test('credit that covers the order closes it on the box: one transaction, the sale then wallet.spent, the day counted', async () => {
  const box = await openWalletBox();
  try {
    const o = await order(box, 2);
    assert.equal(o.total, 24_000);
    const press = credit(QR.toLowerCase());
    const answer = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: press });
    assert.equal(answer.finalised, true);
    assert.equal(answer.sale.receiptNumber, 'T1-000043');
    assert.equal(answer.outstandingSatang, 0);
    assert.equal(answer.attempt, null, 'no cash was taken');
    assert.equal(answer.drawer, 'not_asked', 'credit does not open the drawer');
    assert.deepEqual(
      { amount: answer.walletSpend.amountSatang, after: answer.walletSpend.balanceAfterSatang, capLeft: answer.walletSpend.capLeftSatang },
      { amount: 24_000, after: 26_000, capLeft: 6_000 },
    );
    assert.equal(answer.walletAttempt.method, 'wallet');
    assert.equal(answer.walletAttempt.offline, true);
    assert.equal(answer.walletAttempt.actionId, press.actionId);
    assert.equal(await dayCount(box), 24_000, 'the wallet’s day on this box');

    const queued = await facts(box);
    assert.deepEqual(queued.map((f) => f.type), ['sale.finalised', 'wallet.spent'], 'the sale first, then the money that closes it');
    assert.equal(queued[1]!.boxSeq, queued[0]!.boxSeq + 1);
    const sale = queued[0]!.payload as { tenders: unknown[]; receipt: { number: string } };
    assert.deepEqual(sale.tenders, [], 'the credit is not a tender the platform resolves');
    const spent = queued[1]!.payload as Record<string, unknown>;
    assert.equal(queued[1]!.actionId, press.actionId, 'the credit press is the replay key');
    assert.equal(queued[1]!.stationId, STATION_ID);
    assert.deepEqual(
      [spent.walletId, spent.saleId, spent.amountSatang, spent.spentTodaySatang, spent.capSatang, spent.snapshotBalanceSatang, spent.source],
      [WALLET, o.saleId, 24_000, 24_000, 30_000, 50_000, 'fnb_order'],
    );
    assert.equal((spent.receipt as { number: string }).number, 'T1-000043');

    // The receipt lists the credit above the money.
    const logged = await box.agent.sales()!.recorded(o.saleId);
    assert.deepEqual(logged!.snapshot!.tenders.map((t) => [t.method, t.amountSatang]), [['wallet_credit', 24_000]]);

    // The same press again: the log's answer, nothing counted or queued twice.
    const again = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: press });
    assert.equal(again.replay, true);
    assert.equal(again.walletSpend.amountSatang, 24_000);
    assert.equal((await facts(box)).length, 2);
    assert.equal(await dayCount(box), 24_000);
  } finally {
    box.close();
  }
});

test('the cap on the box: exactly ฿300 a day is allowed, the rest of the order is cash, and a satang more is refused in the counter’s words', async () => {
  const box = await openWalletBox();
  try {
    // ฿360 of food, use credit: min(฿500 held, ฿300 cap, ฿360 owed) = ฿300 — written ahead, ฿60 owed.
    const big = await order(box, 3);
    assert.equal(big.total, 36_000);
    const held = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...big, wallet: credit(QR) });
    assert.equal(held.finalised, false);
    assert.equal(held.sale.status, 'tendering');
    assert.equal(held.outstandingSatang, 6_000);
    assert.equal(held.walletSpend.amountSatang, 30_000);
    assert.equal(held.walletSpend.capLeftSatang, 0);
    assert.equal(await dayCount(box), 30_000, 'counted before the till is told');
    assert.equal((await facts(box)).length, 0, 'no fact until the sale closes');

    // The rest in cash closes it with both.
    const closed = await send(box, 'sale.finalise', { saleId: big.saleId, actionId: big.actionId, cart: big.cart, tender: cash(6_000) });
    assert.equal(closed.finalised, true);
    assert.equal((closed as BridgeWalletSpendAnswer).walletSpend.amountSatang, 30_000);
    const queued = await facts(box);
    assert.deepEqual(queued.map((f) => f.type), ['sale.finalised', 'wallet.spent']);
    assert.deepEqual((queued[0]!.payload as { tenders: Array<{ amountSatang: number }> }).tenders.map((t) => t.amountSatang), [6_000]);
    assert.equal((queued[1]!.payload as { amountSatang: number }).amountSatang, 30_000);
    assert.equal(await dayCount(box), 30_000, 'the close counted nothing again');

    // At exactly ฿300 the next order's credit is refused — online only above ฿300 per day.
    const small = await order(box, 0, 1);
    const refused = await refusedAs(box, 'payment.wallet', { ...small, wallet: credit(QR) }, 'WALLET_OFFLINE_CAP');
    assert.match(refused.message, /online only above ฿300 per day/);
    await refusedAs(box, 'payment.wallet', { ...small, wallet: credit(QR, { amountSatang: 1 }) }, 'WALLET_OFFLINE_CAP');
    assert.equal(await dayCount(box), 30_000);
    assert.equal((await facts(box)).length, 2, 'a refusal writes nothing');

    // What the wallet can still do here, as the till would ask.
    const read = await send<{ wallet: BridgeWalletBalance }>(box, 'wallet.lookup', { key: QR });
    assert.deepEqual(
      [read.wallet.balanceSatang, read.wallet.capLeftSatang, read.wallet.spendableSatang],
      [20_000, 0, 0],
    );
  } finally {
    box.close();
  }
});

test('an Other remainder beside held credit stays Other and leaves the drawer shut', async () => {
  const box = await openWalletBox();
  try {
    const o = await order(box, 3);
    const press = credit(QR, { amountSatang: 20_000 });
    const held = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: press });
    assert.equal(held.outstandingSatang, 16_000);
    const tender = { actionId: `other-${uuidv7().slice(-12)}`, method: 'partner_tender', kind: 'other', amountSatang: 16_000 };
    const closed = await send(box, 'sale.finalise', { ...o, tender });
    assert.equal(closed.finalised, true);
    assert.equal(closed.attempt?.method, 'other');
    assert.equal(closed.attempt?.tenderedSatang, null);
    assert.equal(closed.drawer, 'not_asked');
    const queued = await facts(box);
    assert.deepEqual(queued.map((fact) => fact.type), ['sale.finalised', 'wallet.spent']);
    assert.deepEqual((queued[0]!.payload as { tenders: Array<{ kind: string; methodCode: string; tenderedSatang?: number }> }).tenders
      .map((line) => [line.kind, line.methodCode, line.tenderedSatang ?? null]), [['other', 'partner_tender', null]]);
    await box.restart();
    const replay = await send(box, 'sale.finalise', { ...o, tender });
    assert.equal(replay.replay, true);
    assert.equal((await facts(box)).length, 2);
  } finally {
    box.close();
  }
});

test('write-ahead: credit held for an order survives a restart, is answered again and never counted twice', async () => {
  const box = await openWalletBox();
  try {
    const o = await order(box, 3);
    const press = credit(QR, { amountSatang: 20_000 });
    const first = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: press });
    assert.equal(first.outstandingSatang, 16_000);
    assert.equal(await dayCount(box), 20_000);

    await box.restart();

    const again = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: press });
    assert.equal(again.replay, true, 'answered from the hold on disk');
    assert.equal(again.walletSpend.amountSatang, 20_000);
    assert.equal(await dayCount(box), 20_000);
    // A different credit press for the same order meets the same hold.
    const other = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: credit(QR) });
    assert.equal(other.walletSpend.amountSatang, 20_000);
    assert.equal(await dayCount(box), 20_000);
    // A card for the rest is not this lane's: the rest is cash beside the credit.
    await refusedAs(
      box,
      'payment.start',
      { saleId: o.saleId, actionId: o.actionId, cart: o.cart, tender: { actionId: 'card-1', method: 'card', kind: 'card', amountSatang: 16_000 } },
      'BOX_LANE_SPLIT_REFUSED',
    );

    const closed = await send(box, 'sale.finalise', { saleId: o.saleId, actionId: o.actionId, cart: o.cart, tender: cash(16_000) });
    assert.equal(closed.finalised, true);
    await box.restart();
    const retried = await send(box, 'sale.finalise', { saleId: o.saleId, actionId: o.actionId, cart: o.cart, tender: cash(16_000) });
    assert.equal(retried.replay, true);
    assert.deepEqual((await facts(box)).map((f) => f.type), ['sale.finalised', 'wallet.spent']);
    assert.equal(await dayCount(box), 20_000);
  } finally {
    box.close();
  }
});

for (const point of ['after_receipt', 'after_fact', 'after_log'] as const) {
  test(`a power cut ${point.replace(/_/g, ' ')} in the credit's transaction leaves nothing half-written`, async () => {
    const box = await openWalletBox();
    try {
      const o = await order(box, 1);
      const press = credit(QR);
      box.crash.at = point;
      await assert.rejects(send(box, 'payment.wallet', { ...o, wallet: press }), /the power went/);
      assert.equal(await dayCount(box), 0, 'the day was not counted');
      assert.equal((await facts(box)).length, 0, 'no fact');
      assert.equal(await box.agent.sales()!.recorded(o.saleId), null, 'no sale');
      const retried = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: press });
      assert.equal(retried.finalised, true);
      assert.equal(retried.sale.receiptNumber, 'T1-000043', 'the number the lost attempt never spent');
      assert.equal(await dayCount(box), 12_000);
    } finally {
      box.close();
    }
  });
}

test('honest refusals: an unknown key, an empty or expired wallet, a stale copy, a ticket sale, a tender named wallet', async () => {
  const box = await openWalletBox();
  try {
    const o = await order(box, 1);
    await refusedAs(box, 'payment.wallet', { ...o, wallet: credit('QR-NOBODYHASTHISONE00') }, 'WALLET_NOT_ON_BOX');
    await refusedAs(box, 'payment.wallet', { ...o, wallet: credit(EMPTY_QR) }, 'WALLET_EMPTY');
    await refusedAs(box, 'payment.wallet', { ...o, wallet: credit(OLD_QR) }, 'WALLET_EXPIRED');
    const notFood = await order(box, 1, 0, null);
    await refusedAs(box, 'payment.wallet', { ...notFood, wallet: credit(QR) }, 'WALLET_NOT_HERE');
    // Credit is scanned, never picked off the grid: a tender named `wallet` stays refused.
    await refusedAs(
      box,
      'sale.finalise',
      { saleId: o.saleId, actionId: o.actionId, cart: o.cart, tender: { ...cash(o.total), method: 'wallet' } },
      'BOX_LANE_WALLET_REFUSED',
    );
    // A copy a day old is not trusted.
    await box.write('wallets', [snapshot()], new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    await refusedAs(box, 'payment.wallet', { ...o, wallet: credit(QR) }, 'WALLET_SNAPSHOT_STALE');
    assert.equal(await dayCount(box), 0);
    assert.equal((await facts(box)).length, 0);
  } finally {
    box.close();
  }
});

test('a station’s own offline cap overrides the branch policy’s', async () => {
  const box = await openWalletBox();
  try {
    await box.write('station_config', [{ id: STATION_ID, offlineWalletCapSatang: 10_000 }]);
    const o = await order(box, 2);
    const answer = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: credit(QR) });
    assert.equal(answer.walletSpend.amountSatang, 10_000);
    assert.equal(answer.outstandingSatang, 14_000);
    const next = await order(box, 0, 1);
    const refused = await refusedAs(box, 'payment.wallet', { ...next, wallet: credit(QR) }, 'WALLET_OFFLINE_CAP');
    assert.match(refused.message, /online only above ฿100 per day/);
  } finally {
    box.close();
  }
});

test('a snapshot that already reflects this box’s filed spends is not taken off twice', async () => {
  const box = await openWalletBox();
  try {
    const o = await order(box, 2);
    await send(box, 'payment.wallet', { ...o, wallet: credit(QR) });
    assert.equal(await dayCount(box), 24_000);
    // The link came back, the spend synced: the platform's copy now holds ฿260
    // and says ฿240 of this box's spends are filed.
    const synced = snapshot({}, 26_000);
    synced.wallets[0]!.boxSpentSatang = 24_000;
    await box.write('wallets', [synced]);
    const read = await send<{ wallet: BridgeWalletBalance }>(box, 'wallet.lookup', { key: QR });
    assert.deepEqual([read.wallet.balanceSatang, read.wallet.capLeftSatang], [26_000, 6_000]);
  } finally {
    box.close();
  }
});
