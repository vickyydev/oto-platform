import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_DROP_OFF_PRICING,
  DEFAULT_SUPERVISION_POLICY,
  businessDate,
  mintBandCode,
  ulidFromUuid,
  type BridgeCheckinChild,
  type WalletSnapshotItem,
} from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { prepaidCounterKey } from '../src/checkin-desk';
import { memoryCredentialStore } from '../src/credentials';
import { generateSyncKeyPair, uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver, sqliteWriterBusy, type SqliteDatabaseLike } from '../src/store-sqlite';
import { walletKeyDigestsOf } from '../src/wallet-lane';
import { BOX_ID, BRANCH_ID, STATION_ID, fakeBoxCloud, tillBundle } from './_support';

/**
 * SCRUM-502 REVIEW — two presses for the last prepaid meal on a Pi.
 *
 * The box's store is ONE SQLite connection, and this suite watches it: every
 * `begin immediate` the store issues passes through a thin wrapper that counts
 * the ones SQLite refused, so a test can show the collision really happened
 * rather than assume it did. Then it attacks the fix from the sides the
 * builder's tests do not: the press that waits must spend no receipt number,
 * a paid order with no prepaid line must still be answered at once, a fault
 * that is not "the store is busy" must not be waited out, and the wait must
 * end when the store's own `busy_timeout` would.
 */

const KEY = 'park-band-key-for-the-s502-review-test';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const FOOD = '018f0000-0000-7000-8000-0000000000c4';
const HOTDOG = '018f0000-0000-7000-8000-0000000000c5';
const JUICE = '018f0000-0000-7000-8000-0000000000c6';
const quiet = { info() {}, warn() {}, error() {} };
const USED_UP = "Mint's prepaid Hot dog has already been served.";

const MINT = uuidv7();
const MINT_CHILD = uuidv7();
const MINT_BAND = (() => {
  const id = uuidv7();
  return { id, code: mintBandCode('T1', ulidFromUuid(id), KEY) };
})();

function catalogueItem() {
  const product = (id: string, name: string, priceSatang: number) => ({
    id, kind: 'menu', name, priceSatang, priceWeekendSatang: null, categoryId: FOOD,
    taxCategoryOverride: null, prepStationOverride: null, variants: [], active: true, archivedAt: null,
  });
  return {
    version: 'cat-s502-review',
    packages: [],
    categories: [{ id: FOOD, parentId: null, taxableCategory: 'fnb', name: 'Food', defaultPrepStation: 'kitchen' }],
    products: [product(HOTDOG, 'Hot dog', 8_000), product(JUICE, 'Juice', 5_000)],
    modifierGroups: [], modifierOptions: [], modifierLinks: [],
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

/** The `checkin` copy as the platform builds it: Mint in the park with `meals` prepaid hot dogs. */
function checkinItem(meals: number) {
  const registrationId = '018f0000-0000-7000-8000-00000000f501';
  const mint: BridgeCheckinChild = {
    id: MINT, registrationId, childId: MINT_CHILD, childName: 'Mint', childAgeYears: 6, dateOfBirth: null,
    allergies: 'Peanuts', foodRestrictions: null, mayOrderFood: true,
    foodProvision: {
      mode: 'prepaid_items', paidSatang: 8_000 * meals,
      items: [{ menuItemId: HOTDOG, menuItemName: 'Hot dog', unitSatang: 8_000, qty: meals, redeemedQty: 0 }],
    },
    service: 'drop_off', status: 'in_park', scheduledFor: null, bookedMinutes: null, nannyId: null, nannyName: null,
    checkedInAt: new Date(Date.now() - 600_000).toISOString(), checkedOutAt: null, saleId: null,
    bandId: MINT_BAND.id, visitId: null, photoFileId: null, boxPrepaidServed: [],
  };
  return {
    version: `ck-${uuidv7().slice(-6)}`,
    generatedAt: new Date().toISOString(),
    branchId: BRANCH_ID,
    config: { policy: DEFAULT_SUPERVISION_POLICY, pricing: DEFAULT_DROP_OFF_PRICING, photoRetentionDays: 30 },
    nannies: [],
    families: [{
      registrationId, branchId: BRANCH_ID, memberId: null, guardianName: 'Ploy', guardianPhone: '+66812345678',
      contactChannel: 'whatsapp', consentRecordedAt: new Date().toISOString(), source: 'till', photoFileId: null,
      createdAt: new Date().toISOString(), contact: null, tab: 'in_park', children: [mint], guardians: [],
    }],
    releases: [],
  };
}

function walletsItem(): WalletSnapshotItem {
  return {
    version: 'w-s502-review', generatedAt: new Date().toISOString(), branchId: BRANCH_ID,
    businessDate: businessDate(new Date(), 'Asia/Bangkok', 5 * 60), capSatang: 30_000, truncated: false,
    wallets: [{
      id: uuidv7(), status: 'active', balanceSatang: 0, expiresAt: null, boxSpentSatang: 0,
      keys: [...walletKeyDigestsOf({ kind: 'child', value: MINT_CHILD })],
    }],
  };
}

/**
 * The Pi's one connection, watched. `refused` holds every `begin immediate`
 * SQLite itself turned down; `inject` lets a test hand the NEXT begin a fault
 * of its choosing instead, to see what the press does with it.
 */
interface Watch {
  begins: number;
  refused: unknown[];
  inject: (() => unknown) | null;
}

interface WatchedBox {
  agent: BoxAgent;
  store: SqlBoxStore;
  bridge: StationBridge;
  till: BridgeTillCaller;
  watch: Watch;
  close(): void;
}

async function openWatchedBox(meals: number): Promise<WatchedBox> {
  const real = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(real);
  const watch: Watch = { begins: 0, refused: [], inject: null };
  const db: SqliteDatabaseLike = {
    exec(sql) {
      if (/^\s*begin immediate/i.test(sql)) {
        watch.begins += 1;
        const injected = watch.inject?.();
        if (injected) {
          watch.inject = null;
          throw injected;
        }
        try {
          real.exec(sql);
        } catch (err) {
          watch.refused.push(err);
          throw err;
        }
        return;
      }
      real.exec(sql);
    },
    prepare: (sql) => real.prepare(sql),
    close: () => real.close(),
  };
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => new Date() });
  const keys = generateSyncKeyPair();
  await store.init(BOX_ID);
  const cloud = fakeBoxCloud(tillBundle());
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({ boxId: BOX_ID, secret: 's502-review-secret', syncPrivateKeyPem: keys.privateKeyPem }),
    fetch: cloud.fetch,
    log: quiet,
    store,
    printing: { retryDelayMs: 0, durable: true },
    booth: { enabled: false },
    terminal: { enabled: false },
    bands: { key: () => KEY },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const write = async (scope: CachedBundle['scope'], items: unknown[]) => {
    await store.writeBundle(BOX_ID, { scope, schemaVersion: 1, cursorSeq: 0, payload: { items }, appliedAt: new Date().toISOString() });
  };
  await write('catalogue', [catalogueItem()]);
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 }]);
  await write('checkin', [checkinItem(meals)]);
  await write('wallets', [walletsItem()]);
  await write('bands', [{ id: MINT_BAND.id, code: MINT_BAND.code, branchId: BRANCH_ID, kind: 'kid', status: 'active' }]);
  const till: BridgeTillCaller = { kind: 'till', accountId: ACCOUNT, can: () => true, method: 'offline_token', offlineFresh: false, jti: null };
  return {
    agent,
    store,
    bridge: agent.bridge()!,
    till,
    watch,
    close() {
      agent.stop();
      real.close();
    },
  };
}

async function ask(box: WatchedBox, type: string, payload: Record<string, unknown>) {
  const answer = await box.bridge.intent(STATION_ID, box.till, { type, lastSeenSequence: 0, payload, actionId: `t-${uuidv7().slice(-12)}` });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads deep into each answer's shape
  return answer.result as Record<string, any>;
}

const prepaidLine = () => ({ id: uuidv7(), productId: HOTDOG, quantity: 1, prepaid: { checkinId: MINT }, lineTotalSatang: 0 });
const juiceLine = () => ({ id: uuidv7(), productId: JUICE, quantity: 1 });

/** A ฿0 press for one prepaid hot dog, as the counter sends it. */
function pressPrepaid(box: WatchedBox, tag: string) {
  return ask(box, 'sale.finalise', {
    saleId: uuidv7(),
    actionId: `press-${tag}`,
    cart: { channel: 'fnb', pickupCode: tag.slice(-2), bandHolder: { checkinId: MINT }, items: [prepaidLine()], expectedTotalSatang: 0 },
  });
}

/** A paid juice in cash, with or without a prepaid hot dog beside it. */
function pressJuice(box: WatchedBox, tag: string, withMeal = false) {
  const saleId = uuidv7();
  return ask(box, 'sale.finalise', {
    saleId,
    actionId: `juice-${tag}`,
    cart: {
      channel: 'fnb',
      pickupCode: tag.slice(-2),
      bandHolder: { checkinId: MINT },
      items: withMeal ? [prepaidLine(), juiceLine()] : [juiceLine()],
      expectedTotalSatang: 5_000,
    },
    tender: { actionId: `cash-${tag}`, method: 'cash', kind: 'cash', amountSatang: 5_000, tenderedSatang: 5_000 },
  });
}

async function servedSoFar(box: WatchedBox): Promise<number> {
  return box.store.readCounter(BOX_ID, prepaidCounterKey(MINT, HOTDOG));
}

async function salesQueued(box: WatchedBox): Promise<number> {
  const batch = await box.store.takeBatch(BOX_ID, { maxEvents: 100, maxBytes: 4_000_000, now: new Date().toISOString() });
  return batch.events.filter((e) => e.type === 'sale.finalised').length;
}

/** Hold the store's one writer, as another press's open transaction does, until released. */
function holdStore(box: WatchedBox): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = box.store.atomically(async () => {
    await gate;
    // Nothing of the hold is kept: it only stands where another press's transaction would.
    throw new Error('hold released');
  }).catch((err: unknown) => {
    if (!(err instanceof Error) || err.message !== 'hold released') throw err;
  });
  return { release, done };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 1. the race itself ---------------------------------------------------------------

test('SCRUM-502 review — two presses at once really collide on the Pi’s one connection; the loser waits, is told in the counter’s words, and spends no receipt number', async () => {
  const box = await openWatchedBox(1);
  try {
    const outcomes = await Promise.allSettled([pressPrepaid(box, 'a-61'), pressPrepaid(box, 'b-62')]);

    // The collision happened: SQLite turned at least one `begin immediate`
    // down, with its own one-writer error, and it was read as the store busy.
    assert.ok(box.watch.refused.length >= 1, 'the two presses met on the store’s one writer');
    for (const err of box.watch.refused) {
      assert.equal(sqliteWriterBusy(err), true, String(err));
      assert.match(String((err as Error).message), /cannot start a transaction within a transaction/);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads deep into each answer's shape
    const served = outcomes.filter((o): o is PromiseFulfilledResult<Record<string, any>> => o.status === 'fulfilled');
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    assert.equal(served.length, 1, 'one press serves the last meal');
    assert.equal(refused.length, 1);
    const reason = refused[0]!.reason as unknown;
    assert.ok(reason instanceof BridgeError, `the counter answers, not the store: ${String(reason)}`);
    assert.equal(reason.status, 409);
    assert.equal(reason.code, 'PREPAID_USED_UP');
    assert.equal(reason.message, USED_UP);
    assert.equal(await servedSoFar(box), 1);

    // The refused press spent no number in the till's series: the next sale
    // takes the number straight after the served one.
    const servedSeq = served[0]!.value.sale.receiptSeq as number;
    const next = await pressJuice(box, 'next-63');
    assert.equal(next.sale.receiptSeq, servedSeq + 1, 'no receipt number lost to the refused press');
    assert.equal(await salesQueued(box), 2, 'the served meal and the juice, nothing for the refused press');
  } finally {
    box.close();
  }
});

test('SCRUM-502 review — a press carrying money and the last meal: one is served and paid, the other refused in the counter’s words with nothing taken', async () => {
  const box = await openWatchedBox(1);
  try {
    const outcomes = await Promise.allSettled([pressJuice(box, 'm1-71', true), pressJuice(box, 'm2-72', true)]);
    assert.ok(box.watch.refused.length >= 1, 'the two presses met on the store’s one writer');
    const served = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    assert.equal(served.length, 1);
    assert.equal(refused.length, 1);
    const reason = refused[0]!.reason as unknown;
    assert.ok(reason instanceof BridgeError, String(reason));
    assert.equal(reason.code, 'PREPAID_USED_UP');
    assert.equal(reason.message, USED_UP);
    assert.equal(await servedSoFar(box), 1);
    assert.equal(await salesQueued(box), 1, 'the refused press queued no sale and no cash');
  } finally {
    box.close();
  }
});

// --- 2. the store held by another writer ---------------------------------------------------

test('SCRUM-502 review — a prepaid press that meets the store held waits its turn and is served once the store frees', async () => {
  const box = await openWatchedBox(2);
  try {
    const hold = holdStore(box);
    const started = Date.now();
    let settled = false;
    const press = pressPrepaid(box, 'w-81').finally(() => {
      settled = true;
    });
    await sleep(200);
    assert.equal(settled, false, 'the press is still waiting while the store is held');
    assert.ok(box.watch.refused.length >= 2, 'it asked again while it waited');
    hold.release();
    await hold.done;
    const answer = await press;
    assert.equal(answer.finalised, true);
    assert.ok(Date.now() - started >= 200);
    assert.equal(await servedSoFar(box), 1);
    assert.equal(await salesQueued(box), 1);
  } finally {
    box.close();
  }
});

test('SCRUM-502 review — a paid order with no prepaid line is answered at once with the store’s own error, as before the fix', async () => {
  const box = await openWatchedBox(1);
  try {
    const hold = holdStore(box);
    const started = Date.now();
    const before = box.watch.begins;
    const err = await pressJuice(box, 'j-91').then(
      () => assert.fail('a paid order is not waited for'),
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;
    hold.release();
    await hold.done;
    assert.equal(sqliteWriterBusy(err), true, String(err));
    assert.ok(!(err instanceof BridgeError));
    assert.equal(box.watch.begins - before, 1, 'one attempt, no retry');
    assert.ok(elapsed < 1_000, `answered at once (${elapsed} ms)`);
    assert.equal(await salesQueued(box), 0);
  } finally {
    box.close();
  }
});

// --- 3. faults that are not "the store is busy" ------------------------------------------

test('SCRUM-502 review — a prepaid press whose store fails for another reason is not waited out', async () => {
  const box = await openWatchedBox(1);
  try {
    const ioError = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10, errstr: 'disk I/O error' });
    box.watch.inject = () => ioError;
    const before = box.watch.begins;
    const started = Date.now();
    const err = await pressPrepaid(box, 'io-11').then(
      () => assert.fail('a store fault is not served'),
      (e: unknown) => e,
    );
    assert.equal(err, ioError, 'the store’s fault reaches the caller untouched');
    assert.equal(box.watch.begins - before, 1, 'not retried');
    assert.ok(Date.now() - started < 1_000);
    assert.equal(await servedSoFar(box), 0);
    assert.equal(await salesQueued(box), 0);

    // SQLITE_BUSY from the file lock is the store busy too: waited out, then served.
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
    box.watch.inject = () => busy;
    const again = box.watch.begins;
    const answer = await pressPrepaid(box, 'lk-12');
    assert.equal(answer.finalised, true);
    assert.equal(box.watch.begins - again, 2, 'one refused begin, then the one that recorded the sale');
    assert.equal(await servedSoFar(box), 1);
  } finally {
    box.close();
  }
});

// --- 4. the bound ---------------------------------------------------------------------------

test('SCRUM-502 review — a store still held after the store’s own five seconds: the press gives up with the store’s error and writes nothing', async () => {
  const box = await openWatchedBox(1);
  try {
    const hold = holdStore(box);
    const before = box.watch.begins;
    const started = Date.now();
    const err = await pressPrepaid(box, 'bd-21').then(
      () => assert.fail('a store held for ever is not waited for for ever'),
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;
    hold.release();
    await hold.done;
    assert.equal(sqliteWriterBusy(err), true, String(err));
    assert.ok(!(err instanceof BridgeError));
    assert.equal(box.watch.begins - before, 200, 'two hundred tries, every 25 ms');
    assert.ok(elapsed >= 4_900 && elapsed < 9_000, `bounded near the store’s busy_timeout (${elapsed} ms)`);
    assert.equal(await servedSoFar(box), 0);
    assert.equal(await salesQueued(box), 0);
    // And the meal is still there to serve once the store frees.
    const answer = await pressPrepaid(box, 'bd-22');
    assert.equal(answer.finalised, true);
    assert.equal(await servedSoFar(box), 1);
  } finally {
    box.close();
  }
});
