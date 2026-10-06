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
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import { WALLET_SPEND_COUNTER_SCOPE, WALLET_SPEND_TOTAL_DAY, WALLET_SPEND_TOTAL_SCOPE, walletKeyDigestsOf } from '../src/wallet-lane';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * GATE — S2-14a round 4, invariant (1) THE CAP / the snapshot bound, attacked
 * across the trading-day boundary with the link still down.
 *
 * Reproductions kept as tests. Each test states the invariant it holds the
 * box to; a failing assertion here is a path the gate found.
 */

const KEY = 'park-band-key-for-the-offline-wallet-gate';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const JTI = '018f0000-0000-7000-8000-0000000000f1';
const RICE = '018f0000-0000-7000-8000-0000000000c5';
const JUICE = '018f0000-0000-7000-8000-0000000000c6';
const FOOD = '018f0000-0000-7000-8000-0000000000c4';
const WALLET = '018f0000-0000-7000-8000-00000000ab77';
const QR = 'QR-WALLETGATEROUNDFOUR01';
const TZ = 'Asia/Bangkok';
const DAY_START = 5 * 60;

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
    version: 'cat-gate',
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
    receiptHeader: { name: 'HKT Central', address: null, country: 'TH', operatorName: 'OTO' },
  };
}

function snapshotAt(at: Date, balance: number): WalletSnapshotItem {
  return {
    version: `w-${balance}`,
    generatedAt: at.toISOString(),
    branchId: tillBundle().branch.id,
    businessDate: businessDate(at, TZ, DAY_START),
    capSatang: 30_000,
    truncated: false,
    wallets: [
      { id: WALLET, status: 'active', balanceSatang: balance, expiresAt: null, boxSpentSatang: 0, keys: walletKeyDigestsOf({ kind: 'voucher_qr', value: QR }) },
    ],
  };
}

interface GateBox {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  caller: BridgeTillCaller;
  setNow(iso: string): void;
  now(): Date;
  write(scope: CachedBundle['scope'], items: unknown[], appliedAt: string): Promise<void>;
  close(): void;
}

async function openGateBox(startIso: string, balance: number): Promise<GateBox> {
  const bundle: BoxConfigBundle = tillBundle();
  const cloud = fakeBoxCloud(bundle);
  const harness = openTestStore(startIso);
  let nowMs = Date.parse(startIso);
  await harness.store.init(BOX_ID);
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({ boxId: BOX_ID, secret: 'gate-secret', syncPrivateKeyPem: harness.keys.privateKeyPem }),
    fetch: cloud.fetch,
    log: quiet,
    store: harness.store,
    now: () => nowMs,
    monotonic: () => nowMs,
    printing: { retryDelayMs: 0, durable: true },
    terminal: { enabled: false },
    booth: { enabled: false },
    bands: { key: () => KEY },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const bridge = agent.bridge();
  assert.ok(bridge);
  const write = async (scope: CachedBundle['scope'], items: unknown[], appliedAt: string) => {
    await harness.store.writeBundle(BOX_ID, { scope, schemaVersion: 1, cursorSeq: 0, payload: { items }, appliedAt });
  };
  await write('catalogue', [catalogueItem()], startIso);
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 }], startIso);
  await write('wallets', [snapshotAt(new Date(startIso), balance)], startIso);
  return {
    agent,
    harness,
    bridge,
    caller: { kind: 'till', accountId: ACCOUNT, can: () => true, method: 'offline_token', offlineFresh: false, jti: JTI },
    setNow(iso) {
      nowMs = Date.parse(iso);
      harness.setNow(iso);
    },
    now: () => new Date(nowMs),
    write,
    close() {
      agent.stop();
      harness.close();
    },
  };
}

const intent = (type: string, payload: Record<string, unknown>) => ({
  type,
  lastSeenSequence: 0,
  payload,
  actionId: `g-${uuidv7().slice(-12)}`,
});

async function send<T = BridgeSaleAnswer>(box: GateBox, type: string, body: Record<string, unknown>): Promise<T> {
  const answer = await box.bridge.intent(STATION_ID, box.caller, intent(type, body));
  return answer.result as unknown as T;
}

async function order(box: GateBox, rice: number, juice = 0) {
  const items = [
    ...(rice ? [{ id: uuidv7(), productId: RICE, quantity: rice }] : []),
    ...(juice ? [{ id: uuidv7(), productId: JUICE, quantity: juice }] : []),
  ];
  const cart = { items, pickupCode: '7', channel: 'fnb' };
  const quoted = await box.bridge.intent(STATION_ID, box.caller, intent('cart.quote', cart));
  const total = (quoted.result as { quote: { totals: { grossSatang: number } } }).quote.totals.grossSatang;
  return { total, saleId: uuidv7(), actionId: `pay-${uuidv7().slice(-12)}`, cart: { ...cart, expectedTotalSatang: total } };
}

const credit = (extra: Record<string, unknown> = { useCredit: true }) => ({ key: QR, actionId: uuidv7(), ...extra });
const cash = (amount: number) => ({
  actionId: `cash-${uuidv7().slice(-12)}`,
  method: 'cash',
  kind: 'cash',
  amountSatang: amount,
  tenderedSatang: amount,
  changeSatang: 0,
});

/** Spend `amount` of credit (useCredit on an order of exactly that much or more), closing the rest in cash. */
async function spendAndClose(box: GateBox, rice: number, juice = 0): Promise<number> {
  const o = await order(box, rice, juice);
  const answer = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: credit() });
  if (!answer.finalised) {
    await send(box, 'sale.finalise', { saleId: o.saleId, actionId: o.actionId, cart: o.cart, tender: cash(answer.outstandingSatang) });
  }
  return answer.walletSpend.amountSatang;
}

async function counted(box: GateBox, day: string): Promise<number> {
  return box.harness.store.readCounter(BOX_ID, { scope: WALLET_SPEND_COUNTER_SCOPE, key: WALLET, businessDate: day });
}

async function countedAllDays(box: GateBox): Promise<number> {
  return box.harness.store.readCounter(BOX_ID, { scope: WALLET_SPEND_TOTAL_SCOPE, key: WALLET, businessDate: WALLET_SPEND_TOTAL_DAY });
}

test('GATE (1): one box, one wallet, link down across the trading-day boundary — the box never spends more than its snapshot held', async () => {
  // 19:00 Bangkok on 1 Oct: the last snapshot the box got says ฿400.
  const start = '2026-10-01T12:00:00.000Z';
  const box = await openGateBox(start, 40_000);
  try {
    const day1 = businessDate(new Date(start), TZ, DAY_START);
    // Day 1, offline: ฿300 of credit (the cap), the rest in cash.
    assert.equal(await spendAndClose(box, 3), 30_000);
    assert.equal(await counted(box, day1), 30_000);

    // 06:00 Bangkok on 2 Oct — a new trading day, still offline, the same copy
    // (eleven hours old, inside the 24 h trust window).
    box.setNow('2026-10-01T23:00:00.000Z');
    const day2 = businessDate(box.now(), TZ, DAY_START);
    assert.notEqual(day2, day1);

    // The snapshot said ฿400 and this box has already taken ฿300 of it, unsynced:
    // at most ฿100 is left to spend here, whatever day it is.
    const read = await send<{ wallet: BridgeWalletBalance }>(box, 'wallet.lookup', { key: QR });
    assert.ok(
      read.wallet.spendableSatang <= 10_000,
      `the box offers ${read.wallet.spendableSatang} satang of a ฿400 snapshot it already spent ฿300 of`,
    );

    // And a spend may not take it: total credit this box gave stays within the snapshot.
    let taken = 0;
    try {
      taken = await spendAndClose(box, 3);
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
    }
    assert.ok(30_000 + taken <= 40_000, `one box gave ${30_000 + taken} satang of credit from a ฿400 snapshot`);
    // The fix's own shape: the day's count started again, the all-days count did not.
    assert.equal(await counted(box, day2), taken);
    assert.equal(await countedAllDays(box), 30_000 + taken);
    // Whatever "use credit" took, the ฿100 left of the snapshot is all this
    // box ever gives — and after it, the wallet is empty here, not refilled.
    const left = 40_000 - (30_000 + taken);
    if (left > 0) assert.equal(await spendAndClose(box, 1), left, 'the rest of the snapshot');
    assert.equal(await countedAllDays(box), 40_000);
    await assert.rejects(spendAndClose(box, 1), (err: unknown) => err instanceof BridgeError && err.code === 'WALLET_EMPTY');
  } finally {
    box.close();
  }
});

test('GATE (1): credit held before the trading day turns and closed after it — the box’s days add up to what it closed', async () => {
  // 04:50 Bangkok on 2 Oct is still trading day 1 Oct (the day starts at 05:00).
  const start = '2026-10-01T21:50:00.000Z';
  const box = await openGateBox(start, 100_000);
  try {
    const day1 = businessDate(new Date(start), TZ, DAY_START);
    const held = await order(box, 3);
    const first = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...held, wallet: credit() });
    assert.equal(first.walletSpend.amountSatang, 30_000);
    assert.equal(first.finalised, false);

    // 05:10: trading day 2 Oct. The held order is closed in cash, then a new order spends the cap again.
    box.setNow('2026-10-01T22:10:00.000Z');
    const day2 = businessDate(box.now(), TZ, DAY_START);
    assert.notEqual(day2, day1);
    await send(box, 'sale.finalise', { saleId: held.saleId, actionId: held.actionId, cart: held.cart, tender: cash(first.outstandingSatang) });
    const second = await spendAndClose(box, 3);

    // What the box closed on day 2, by the facts it queued.
    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 50, maxBytes: 1_000_000, now: box.now().toISOString() });
    const spent = batch.events.filter((e) => e.type === 'wallet.spent');
    const sales = batch.events.filter((e) => e.type === 'sale.finalised');
    assert.equal(spent.length, 2);
    assert.equal(sales.length, 2);
    const closedOnDay2 = sales.filter((e) => businessDate(new Date(e.occurredAt), TZ, DAY_START) === day2).length;
    const creditDays = spent.map((e) => (e.payload as { businessDate: string }).businessDate);
    // Both sales closed on day 2; the credit facts name the day each was COUNTED on.
    assert.equal(closedOnDay2, 2);
    assert.deepEqual(creditDays, [day1, day2]);
    assert.equal(await counted(box, day1), 30_000);
    assert.equal(await counted(box, day2), second);
  } finally {
    box.close();
  }
});

test('GATE (1): two tills on one box press credit on two orders at the same instant — the cap holds', async () => {
  const start = '2026-10-01T06:00:00.000Z';
  const box = await openGateBox(start, 100_000);
  try {
    const day = businessDate(new Date(start), TZ, DAY_START);
    const a = await order(box, 2);
    const b = await order(box, 2);
    const results = await Promise.allSettled([
      send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...a, wallet: credit() }),
      send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...b, wallet: credit() }),
    ]);
    const taken = results
      .filter((r): r is PromiseFulfilledResult<BridgeWalletSpendAnswer> => r.status === 'fulfilled')
      .reduce((sum, r) => sum + r.value.walletSpend.amountSatang, 0);
    // The loser is refused — by the cap, or by the store's one-writer-at-a-time
    // rule on a Pi's SQLite file (landed, not this round's) — and writes nothing.
    assert.ok(results.some((r) => r.status === 'fulfilled'), 'one of the two presses goes through');
    assert.ok(taken <= 30_000, `one box took ${taken} satang in one day`);
    assert.equal(await counted(box, day), taken);
  } finally {
    box.close();
  }
});

test('GATE (4): unknown key, expired status in the snapshot, above the cap — refused in the counter’s words, nothing written', async () => {
  const start = '2026-10-01T06:00:00.000Z';
  const box = await openGateBox(start, 100_000);
  try {
    const day = businessDate(new Date(start), TZ, DAY_START);
    const expiredQr = 'QR-WALLETGATEEXPIRED001';
    const snap = snapshotAt(new Date(start), 100_000);
    snap.wallets.push({
      id: '018f0000-0000-7000-8000-00000000ab78',
      status: 'expired',
      balanceSatang: 5_000,
      expiresAt: null,
      boxSpentSatang: 0,
      keys: walletKeyDigestsOf({ kind: 'voucher_qr', value: expiredQr }),
    });
    await box.write('wallets', [snap], start);
    const o = await order(box, 3);
    const refusals: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ key: 'QR-NOBODYHOLDSTHIS0001', actionId: uuidv7(), useCredit: true }, 'WALLET_NOT_ON_BOX', /take the order in cash or card/],
      [{ key: expiredQr, actionId: uuidv7(), useCredit: true }, 'WALLET_EXPIRED', /expired/],
      [{ key: QR, actionId: uuidv7(), amountSatang: 30_001 }, 'WALLET_OFFLINE_CAP', /online only above ฿300 per day/],
    ];
    for (const [wallet, code, words] of refusals) {
      await assert.rejects(box.bridge.intent(STATION_ID, box.caller, intent('payment.wallet', { ...o, wallet })), (err: unknown) => {
        assert.ok(err instanceof BridgeError, String(err));
        assert.equal(err.code, code);
        assert.match(err.message, words);
        return true;
      });
    }
    assert.equal(await counted(box, day), 0);
    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 50, maxBytes: 1_000_000, now: box.now().toISOString() });
    assert.equal(batch.events.length, 0, 'no fact');
    assert.equal(await box.agent.sales()!.recorded(o.saleId), null, 'no sale');
    // Exactly ฿300 is the boundary, and goes through; the number is the one no refusal spent.
    const exact = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: { key: QR, actionId: uuidv7(), amountSatang: 30_000 }, tender: cash(o.total - 30_000) });
    assert.equal(exact.finalised, true);
    assert.equal(exact.sale.receiptNumber, 'T1-000043');
    assert.equal(await counted(box, day), 30_000);
  } finally {
    box.close();
  }
});

test('GATE (2): a credit press that reuses the sale’s or the cash tender’s action id is refused before anything moves', async () => {
  // On the platform the credit is filed under its own press key; a cash tender
  // already filed under the same key would read as "credit already filed" and
  // the credit would be dropped with the sale left tendering.
  const start = '2026-10-01T06:00:00.000Z';
  const box = await openGateBox(start, 100_000);
  try {
    const day = businessDate(new Date(start), TZ, DAY_START);
    const o = await order(box, 3);
    const shared = `shared-${uuidv7().slice(-12)}`;
    const refused = async (body: Record<string, unknown>) =>
      assert.rejects(box.bridge.intent(STATION_ID, box.caller, intent('payment.wallet', body)), (err: unknown) => {
        assert.ok(err instanceof BridgeError, String(err));
        assert.equal(err.code, 'VALIDATION');
        assert.match(err.message, /action id of its own/);
        return true;
      });
    // The same key as the sale's own press.
    await refused({ ...o, actionId: shared, wallet: { key: QR, actionId: shared, useCredit: true } });
    // The same key as the cash tender taken in the same press.
    await refused({ ...o, wallet: { key: QR, actionId: shared, useCredit: true }, tender: { ...cash(o.total - 30_000), actionId: shared } });
    // Credit held, then the rest in cash under the credit's key: refused, the hold untouched.
    const held = await send<BridgeWalletSpendAnswer>(box, 'payment.wallet', { ...o, wallet: { key: QR, actionId: shared, useCredit: true } });
    assert.equal(held.finalised, false);
    await assert.rejects(
      box.bridge.intent(STATION_ID, box.caller, intent('sale.finalise', { saleId: o.saleId, actionId: o.actionId, cart: o.cart, tender: { ...cash(held.outstandingSatang), actionId: shared } })),
      (err: unknown) => err instanceof BridgeError && err.code === 'VALIDATION' && /action id of its own/.test(err.message),
    );
    assert.equal(await counted(box, day), 30_000, 'the one hold, counted once');
    assert.equal(await box.agent.sales()!.recorded(o.saleId), null, 'no sale yet');
    // A key of its own closes it.
    const closed = await send(box, 'sale.finalise', { saleId: o.saleId, actionId: o.actionId, cart: o.cart, tender: cash(held.outstandingSatang) });
    assert.equal(closed.finalised, true);
  } finally {
    box.close();
  }
});
