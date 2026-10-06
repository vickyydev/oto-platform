import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_DROP_OFF_PRICING,
  DEFAULT_SUPERVISION_POLICY,
  businessDate,
  mintBandCode,
  ulidFromUuid,
  type BandStayView,
  type BridgeCheckinChild,
  type BridgeCheckinFamily,
  type WalletSnapshotItem,
} from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { prepaidCounterKey } from '../src/checkin-desk';
import { memoryCredentialStore } from '../src/credentials';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import { walletKeyDigestsOf } from '../src/wallet-lane';
import { BOX_ID, BRANCH_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * SCRUM-498 review — the food counter through its box with the internet down:
 * the allergy line reaches the scan and the kitchen ticket, a no-food child is
 * refused at the press, and a prepaid meal is served once however the press
 * arrives (twice at once, resent, split across lines).
 */

const KEY = 'park-band-key-for-the-s498-review-test';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const FOOD = '018f0000-0000-7000-8000-0000000000c4';
const HOTDOG = '018f0000-0000-7000-8000-0000000000c5';
const JUICE = '018f0000-0000-7000-8000-0000000000c6';
const OTHER_BRANCH = '018f0000-0000-7000-8000-0000000000b9';
const quiet = { info() {}, warn() {}, error() {} };

const ids = {
  mint: uuidv7(),
  nok: uuidv7(),
  gone: uuidv7(),
  away: uuidv7(),
  mintChild: uuidv7(),
};
const band = (prefix: string) => {
  const id = uuidv7();
  return { id, code: mintBandCode(prefix, ulidFromUuid(id), KEY) };
};
const bands = { mint: band('T1'), nok: band('T1'), gone: band('T1'), away: band('T2') };
const VOUCHER = 'QR-S498FOODVOUCHER0001';

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
    version: 'cat-s498',
    packages: [],
    categories: [{ id: FOOD, parentId: null, taxableCategory: 'fnb', name: 'Food', defaultPrepStation: 'kitchen' }],
    products: [product(HOTDOG, 'Hot dog', 8_000), product(JUICE, 'Juice', 5_000)],
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

function stay(
  id: string,
  over: Partial<BridgeCheckinChild> & { registrationId: string },
): BridgeCheckinChild {
  return {
    id,
    childId: null,
    childName: 'Child',
    childAgeYears: 6,
    dateOfBirth: null,
    allergies: null,
    foodRestrictions: null,
    mayOrderFood: true,
    foodProvision: null,
    service: 'drop_off',
    status: 'in_park',
    scheduledFor: null,
    bookedMinutes: null,
    nannyId: null,
    nannyName: null,
    checkedInAt: new Date(Date.now() - 600_000).toISOString(),
    checkedOutAt: null,
    saleId: null,
    bandId: null,
    visitId: null,
    photoFileId: null,
    ...over,
  };
}

function family(registrationId: string, branchId: string, children: BridgeCheckinChild[]): Omit<BridgeCheckinFamily, 'origin'> {
  return {
    registrationId,
    branchId,
    memberId: null,
    guardianName: 'Ploy',
    guardianPhone: '+66812345678',
    contactChannel: 'whatsapp',
    consentRecordedAt: new Date().toISOString(),
    source: 'till',
    photoFileId: null,
    createdAt: new Date().toISOString(),
    contact: null,
    tab: 'in_park',
    children,
    guardians: [],
  };
}

const hotDogs = (qty: number, redeemedQty = 0) => ({
  mode: 'prepaid_items' as const,
  paidSatang: 8_000 * qty,
  items: [{ menuItemId: HOTDOG, menuItemName: 'Hot dog', unitSatang: 8_000, qty, redeemedQty }],
});

/** The `checkin` copy as the platform builds it for this box. */
function checkinItem(opts: { mintFood?: ReturnType<typeof hotDogs>; mintFiled?: number } = {}) {
  const regA = '018f0000-0000-7000-8000-00000000f001';
  const regB = '018f0000-0000-7000-8000-00000000f002';
  return {
    version: `ck-${uuidv7().slice(-6)}`,
    generatedAt: new Date().toISOString(),
    branchId: BRANCH_ID,
    config: { policy: DEFAULT_SUPERVISION_POLICY, pricing: DEFAULT_DROP_OFF_PRICING, photoRetentionDays: 30 },
    nannies: [],
    families: [
      family(regA, BRANCH_ID, [
        stay(ids.mint, {
          registrationId: regA,
          childId: ids.mintChild,
          childName: 'Mint',
          allergies: 'Peanuts',
          savedAllergies: 'Saved peanuts',
          savedMedicalNotes: 'Inhaler in bag',
          savedDietary: 'No pork',
          bandId: bands.mint.id,
          foodProvision: opts.mintFood ?? hotDogs(1),
          boxPrepaidServed: opts.mintFiled ? [{ menuItemId: HOTDOG, qty: opts.mintFiled }] : [],
        }),
        stay(ids.nok, {
          registrationId: regA,
          childName: 'Nok',
          mayOrderFood: false,
          bandId: bands.nok.id,
          foodProvision: {
            mode: 'prepaid_items',
            paidSatang: 5_000,
            items: [{ menuItemId: JUICE, menuItemName: 'Juice', unitSatang: 5_000, qty: 1, redeemedQty: 0 }],
          },
          boxPrepaidServed: [],
        }),
        stay(ids.gone, {
          registrationId: regA,
          childName: 'Gone',
          status: 'out',
          bandId: bands.gone.id,
          checkedOutAt: new Date().toISOString(),
          foodProvision: hotDogs(1),
        }),
      ]),
      family(regB, OTHER_BRANCH, [stay(ids.away, { registrationId: regB, childName: 'Away', bandId: bands.away.id })]),
    ],
    releases: [],
  };
}

function walletsItem(): WalletSnapshotItem {
  return {
    version: 'w-s498',
    generatedAt: new Date().toISOString(),
    branchId: BRANCH_ID,
    businessDate: businessDate(new Date(), 'Asia/Bangkok', 5 * 60),
    capSatang: 30_000,
    truncated: false,
    wallets: [
      {
        id: uuidv7(),
        status: 'active',
        balanceSatang: 0,
        expiresAt: null,
        boxSpentSatang: 0,
        keys: [
          ...walletKeyDigestsOf({ kind: 'voucher_qr', value: VOUCHER }),
          ...walletKeyDigestsOf({ kind: 'child', value: ids.mintChild }),
        ],
      },
    ],
  };
}

interface FoodBox {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  till: BridgeTillCaller;
  write(scope: CachedBundle['scope'], items: unknown[]): Promise<void>;
  close(): void;
}

async function openFoodBox(): Promise<FoodBox> {
  const cloud = fakeBoxCloud(tillBundle());
  const harness = openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({ boxId: BOX_ID, secret: 's498-review-test-secret', syncPrivateKeyPem: harness.keys.privateKeyPem }),
    fetch: cloud.fetch,
    log: quiet,
    store: harness.store,
    printing: { retryDelayMs: 0, durable: true },
    booth: { enabled: false },
    terminal: { enabled: false },
    bands: { key: () => KEY },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const write = async (scope: CachedBundle['scope'], items: unknown[]) => {
    await harness.store.writeBundle(BOX_ID, { scope, schemaVersion: 1, cursorSeq: 0, payload: { items }, appliedAt: new Date().toISOString() });
  };
  await write('catalogue', [catalogueItem()]);
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 }]);
  await write('checkin', [checkinItem()]);
  await write('wallets', [walletsItem()]);
  await write(
    'bands',
    Object.entries(bands).map(([name, b]) => ({
      id: b.id,
      code: b.code,
      branchId: name === 'away' ? OTHER_BRANCH : BRANCH_ID,
      kind: 'kid',
      status: 'active',
    })),
  );
  const till: BridgeTillCaller = { kind: 'till', accountId: ACCOUNT, can: () => true, method: 'offline_token', offlineFresh: false, jti: null };
  return {
    agent,
    harness,
    bridge: agent.bridge()!,
    till,
    write,
    close() {
      agent.stop();
      harness.close();
    },
  };
}

async function ask(box: FoodBox, type: string, payload: Record<string, unknown>, caller: BridgeTillCaller = box.till) {
  const answer = await box.bridge.intent(STATION_ID, caller, { type, lastSeenSequence: 0, payload, actionId: `t-${uuidv7().slice(-12)}` });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads deep into each answer's shape
  return answer.result as Record<string, any>;
}

async function refusal(run: Promise<unknown>): Promise<BridgeError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof BridgeError) return err;
    throw err;
  }
  assert.fail('expected a refusal');
}

const prepaidLine = (checkinId: string, productId = HOTDOG, quantity = 1) => ({
  id: uuidv7(),
  productId,
  quantity,
  prepaid: { checkinId },
  lineTotalSatang: 0,
});

/** An F&B order through the box, quoted and paid as the till sends it. */
async function sell(box: FoodBox, cart: Record<string, unknown>) {
  const body = { channel: 'fnb', pickupCode: '42', ...cart };
  const quote = await ask(box, 'cart.quote', body);
  const gross = quote.quote.totals.grossSatang as number;
  const saleId = uuidv7();
  const answer = await ask(box, 'sale.finalise', {
    saleId,
    actionId: `pay-${saleId.slice(-8)}`,
    cart: { ...body, expectedTotalSatang: gross },
    ...(gross > 0
      ? { tender: { actionId: `cash-${saleId.slice(-8)}`, method: 'cash', kind: 'cash', amountSatang: gross, tenderedSatang: gross } }
      : {}),
  });
  return { saleId, gross, answer };
}

async function queuedFacts(box: FoodBox) {
  const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 50, maxBytes: 2_000_000, now: new Date().toISOString() });
  return batch.events;
}

function withMint(over: Partial<BridgeCheckinChild>, opts: Parameters<typeof checkinItem>[0] = {}) {
  const item = checkinItem(opts);
  const first = item.families[0]!;
  first.children = first.children.map((c) => (c.id === ids.mint ? { ...c, ...over } : c));
  return item;
}

test('s498 review — the saved allergy line reaches the scan and the kitchen ticket of a paid order', async () => {
  const box = await openFoodBox();
  try {
    await box.write('checkin', [withMint({ allergies: '   ' })]);
    const scanned = (await ask(box, 'checkin.band_food', { key: bands.mint.code })).stay as BandStayView;
    assert.equal(scanned.allergiesMedical, 'Saved peanuts; Inhaler in bag', 'a blank stay note falls back to the saved record');
    assert.equal(scanned.foodRestrictions, 'No pork');

    const juice = { id: uuidv7(), productId: JUICE, quantity: 1 };
    const sold = await sell(box, { bandHolder: { checkinId: ids.mint }, items: [juice] });
    assert.equal(sold.gross, 5_000);
    const logged = await box.agent.sales()!.recorded(sold.saleId);
    assert.deepEqual(logged?.snapshot?.bandHolder, { name: 'Mint', allergiesMedical: 'Saved peanuts; Inhaler in bag' });
  } finally {
    box.close();
  }
});

test('s498 review — a no-food child is refused at the press, not only at the quote, and nothing is queued', async () => {
  const box = await openFoodBox();
  try {
    const juice = { id: uuidv7(), productId: JUICE, quantity: 1 };
    const paid = await refusal(
      ask(box, 'sale.finalise', {
        saleId: uuidv7(),
        actionId: 'nok-paid',
        cart: { channel: 'fnb', pickupCode: '44', bandHolder: { checkinId: ids.nok }, items: [juice], expectedTotalSatang: 5_000 },
        tender: { actionId: 'nok-cash', method: 'cash', kind: 'cash', amountSatang: 5_000, tenderedSatang: 5_000 },
      }),
    );
    assert.equal(paid.code, 'FOOD_NOT_AUTHORIZED');
    assert.equal(paid.message, 'Parent did not authorize food orders for this child.');

    const mixed = await refusal(
      ask(box, 'cart.quote', {
        channel: 'fnb',
        bandHolder: { checkinId: ids.nok },
        items: [prepaidLine(ids.nok, JUICE), { id: uuidv7(), productId: JUICE, quantity: 1 }],
      }),
    );
    assert.equal(mixed.code, 'FOOD_NOT_AUTHORIZED', 'a prepaid line does not carry paid food past the consent rule');

    assert.equal(await box.harness.store.readCounter(BOX_ID, prepaidCounterKey(ids.nok, JUICE)), 0);
    assert.equal((await queuedFacts(box)).filter((e) => e.type === 'sale.finalised').length, 0);
  } finally {
    box.close();
  }
});

test('s498 review — a prepaid line for another child than the band holder is refused', async () => {
  const box = await openFoodBox();
  try {
    const wrong = await refusal(
      ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.nok }, items: [prepaidLine(ids.mint)] }),
    );
    assert.equal(wrong.code, 'PREPAID_NEEDS_BAND');
    const released = await refusal(
      ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.gone }, items: [prepaidLine(ids.gone)] }),
    );
    assert.equal(released.code, 'BAND_NOT_IN_PARK');
  } finally {
    box.close();
  }
});

test('s498 review — two presses for the last meal at once serve it once', async () => {
  const box = await openFoodBox();
  try {
    const press = (n: number) => {
      const saleId = uuidv7();
      return ask(box, 'sale.finalise', {
        saleId,
        actionId: `race-${n}`,
        cart: { channel: 'fnb', pickupCode: `6${n}`, bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint)], expectedTotalSatang: 0 },
      });
    };
    const outcomes = await Promise.allSettled([press(1), press(2)]);
    const served = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    assert.equal(served.length, 1, 'one press serves the meal');
    assert.equal(refused.length, 1);
    // The loser is refused by the counter, or by the store's one-writer rule on SQLite; either way it writes nothing.
    const reason = refused[0]!.reason as { code?: unknown };
    assert.ok(reason instanceof BridgeError ? reason.code === 'PREPAID_USED_UP' : reason.code === 'ERR_SQLITE_ERROR', String(reason));
    assert.equal(await box.harness.store.readCounter(BOX_ID, prepaidCounterKey(ids.mint, HOTDOG)), 1);
    assert.equal((await queuedFacts(box)).filter((e) => e.type === 'sale.finalised').length, 1);
  } finally {
    box.close();
  }
});

test('s498 review — the same press resent serves the meal once', async () => {
  const box = await openFoodBox();
  try {
    const saleId = uuidv7();
    const body = {
      saleId,
      actionId: 'resent-press',
      cart: { channel: 'fnb', pickupCode: '71', bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint)], expectedTotalSatang: 0 },
    };
    const first = await ask(box, 'sale.finalise', body);
    assert.equal(first.finalised, true);
    const again = await ask(box, 'sale.finalise', body);
    assert.equal(again.finalised, true);
    assert.equal(await box.harness.store.readCounter(BOX_ID, prepaidCounterKey(ids.mint, HOTDOG)), 1);
    assert.equal((await queuedFacts(box)).filter((e) => e.type === 'sale.finalised').length, 1);
  } finally {
    box.close();
  }
});

test('s498 review — the same meal split across lines is counted together, and the pickup counts the box’s meals', async () => {
  const box = await openFoodBox();
  try {
    await box.write('checkin', [checkinItem({ mintFood: hotDogs(2) })]);
    const split = await refusal(
      ask(box, 'cart.quote', {
        channel: 'fnb',
        bandHolder: { checkinId: ids.mint },
        items: [prepaidLine(ids.mint), prepaidLine(ids.mint), prepaidLine(ids.mint)],
      }),
    );
    assert.equal(split.code, 'PREPAID_USED_UP');
    assert.equal(split.message, 'Mint has only 2 prepaid Hot dog left to serve.');

    await sell(box, { bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint)] });
    const context = await ask(box, 'release.context', { checkinId: ids.mint });
    assert.equal(context.reconciliation.totalUnusedSatang, 8_000, 'one of two served on the box, one left to settle');
  } finally {
    box.close();
  }
});
