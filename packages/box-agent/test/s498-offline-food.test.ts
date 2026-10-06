import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_DROP_OFF_PRICING,
  DEFAULT_SUPERVISION_POLICY,
  bandShortCode,
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
 * SCRUM-498 — THE FOOD COUNTER THROUGH ITS BOX WITH THE INTERNET DOWN.
 *
 * A scanned band reads the child's stay from the box's `checkin` copy as the
 * platform's scan reads it online; a prepaid meal is served through the box,
 * counted on the box and refused once used up there, in the counter's words.
 */

const KEY = 'park-band-key-for-the-s498-food-test';
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
    credentials: memoryCredentialStore({ boxId: BOX_ID, secret: 's498-food-test-secret', syncPrivateKeyPem: harness.keys.privateKeyPem }),
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

const mintView = (redeemedQty: number, qty = 1): BandStayView => ({
  checkinId: ids.mint,
  branchId: BRANCH_ID,
  childName: 'Mint',
  allergiesMedical: 'Peanuts; Inhaler in bag',
  foodRestrictions: 'No pork',
  mayOrderFood: true,
  foodProvision: {
    mode: 'prepaid_items',
    paidSatang: 8_000 * qty,
    creditSatang: null,
    items: [{ menuItemId: HOTDOG, menuItemName: 'Hot dog', unitSatang: 8_000, qty, redeemedQty }],
  },
});

test('s498 — a scanned band reads the in-park child of this park from the box, as the online scan does', async () => {
  const box = await openFoodBox();
  try {
    const byCode = await ask(box, 'checkin.band_food', { key: bands.mint.code });
    assert.deepEqual(Object.keys(byCode).sort(), ['cacheAppliedAt', 'stay']);
    assert.deepEqual(byCode.stay, mintView(0), 'the stay’s allergies, the saved medical and dietary notes, consent and prepaid food');
    const short = bandShortCode(bands.mint.code)!;
    assert.deepEqual((await ask(box, 'checkin.band_food', { key: short.toLowerCase() })).stay, mintView(0), 'a short code typed in lower case');
    assert.deepEqual((await ask(box, 'checkin.band_food', { key: VOUCHER })).stay, mintView(0), 'a voucher QR whose wallet is the child’s');

    assert.equal((await ask(box, 'checkin.band_food', { key: bands.gone.code })).stay, null, 'a released child reads nothing');
    assert.equal((await ask(box, 'checkin.band_food', { key: bands.away.code })).stay, null, 'another park’s child reads nothing');
    assert.equal((await ask(box, 'checkin.band_food', { key: 'T1-AAAAAA' })).stay, null);
    const noCheckin: BridgeTillCaller = { ...box.till, can: (p: string) => p !== 'pos:checkin:read' };
    assert.equal(
      (await ask(box, 'checkin.band_food', { key: bands.mint.code }, noCheckin)).stay,
      null,
      'an account that may not read check-ins is told no stay, as online',
    );
    const nok = (await ask(box, 'checkin.band_food', { key: bands.nok.code })).stay as BandStayView;
    assert.equal(nok.mayOrderFood, false);
  } finally {
    box.close();
  }
});

test('s498 — a prepaid meal is served through the box once, at ฿0, to the kitchen ticket and the queue', async () => {
  const box = await openFoodBox();
  try {
    const hotDog = prepaidLine(ids.mint);
    const sold = await sell(box, { bandHolder: { checkinId: ids.mint }, items: [hotDog] });
    assert.equal(sold.gross, 0, 'a prepaid line is ฿0 on the box as online, so the till’s ฿0 line is not a price mismatch');
    assert.equal(sold.answer.finalised, true);

    const logged = await box.agent.sales()!.recorded(sold.saleId);
    assert.deepEqual(logged?.snapshot?.bandHolder, { name: 'Mint', allergiesMedical: 'Peanuts; Inhaler in bag' },
      'the prep ticket carries the band holder’s own allergy line');
    const line = logged?.snapshot?.lines.find((l) => l.kind === 'fnb_item');
    assert.equal(line?.quantity, 1);
    assert.equal(line?.grossSatang, 0);

    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 20, maxBytes: 1_000_000, now: new Date().toISOString() });
    const fact = batch.events.find((e) => e.type === 'sale.finalised')!.payload as { cart: Record<string, unknown> };
    assert.deepEqual(fact.cart.bandHolder, { checkinId: ids.mint });
    assert.deepEqual((fact.cart.items as Array<{ prepaid?: unknown }>)[0]!.prepaid, { checkinId: ids.mint });

    assert.equal(await box.harness.store.readCounter(BOX_ID, prepaidCounterKey(ids.mint, HOTDOG)), 1);
    assert.deepEqual((await ask(box, 'checkin.band_food', { key: bands.mint.code })).stay, mintView(1), 'the scan shows it served');

    const again = await refusal(ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint)] }));
    assert.equal(again.code, 'PREPAID_USED_UP');
    assert.equal(again.message, 'Mint\'s prepaid Hot dog has already been served.');
    const pay = await refusal(
      ask(box, 'sale.finalise', {
        saleId: uuidv7(),
        actionId: 'pay-twice',
        cart: { channel: 'fnb', pickupCode: '43', bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint)], expectedTotalSatang: 0 },
      }),
    );
    assert.equal(pay.code, 'PREPAID_USED_UP');
    assert.equal(await box.harness.store.readCounter(BOX_ID, prepaidCounterKey(ids.mint, HOTDOG)), 1, 'a refused press counts nothing');

    const context = await ask(box, 'release.context', { checkinId: ids.mint });
    assert.equal(context.reconciliation.totalUnusedSatang, 0, 'the pickup does not settle a meal this box served as unused');
  } finally {
    box.close();
  }
});

test('s498 — the box counts only what the copy does not reflect yet', async () => {
  const box = await openFoodBox();
  try {
    await sell(box, { bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint)] });
    // The link came back: the platform filed the box's meal and the copy says so.
    await box.write('checkin', [checkinItem({ mintFood: hotDogs(1, 1), mintFiled: 1 })]);
    assert.deepEqual((await ask(box, 'checkin.band_food', { key: bands.mint.code })).stay, mintView(1), 'not counted twice');
    // Two were paid for: the second is still servable, and only once.
    await box.write('checkin', [checkinItem({ mintFood: hotDogs(2, 1), mintFiled: 1 })]);
    assert.deepEqual((await ask(box, 'checkin.band_food', { key: bands.mint.code })).stay, mintView(1, 2));
    const two = await refusal(ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint, HOTDOG, 2)] }));
    assert.equal(two.message, 'Mint has only 1 prepaid Hot dog left to serve.');
    await sell(box, { bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint)] });
    assert.deepEqual((await ask(box, 'checkin.band_food', { key: bands.mint.code })).stay, mintView(2, 2));
  } finally {
    box.close();
  }
});

test('s498 — the food permission and the prepaid rules refuse in the platform’s words', async () => {
  const box = await openFoodBox();
  try {
    const juice = { id: uuidv7(), productId: JUICE, quantity: 1 };
    const denied = await refusal(ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.nok }, items: [juice] }));
    assert.equal(denied.code, 'FOOD_NOT_AUTHORIZED');
    assert.equal(denied.message, 'Parent did not authorize food orders for this child.');
    const overridden = await ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.nok, foodOverride: true }, items: [juice] });
    assert.equal(overridden.quote.totals.grossSatang, 5_000);
    const prepaidJuice = await ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.nok }, items: [prepaidLine(ids.nok, JUICE)] });
    assert.equal(prepaidJuice.quote.totals.grossSatang, 0, 'the prepaid line is not food the parent did not authorise');

    const noBand = await refusal(ask(box, 'cart.quote', { channel: 'fnb', items: [prepaidLine(ids.mint)] }));
    assert.equal(noBand.code, 'PREPAID_NEEDS_BAND');
    const notHis = await refusal(ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.mint }, items: [prepaidLine(ids.mint, JUICE)] }));
    assert.equal(notHis.code, 'PREPAID_NOT_ENTITLED');
    assert.equal(notHis.message, 'Juice is not one of Mint\'s prepaid items.');
    const options = await refusal(
      ask(box, 'cart.quote', {
        channel: 'fnb',
        bandHolder: { checkinId: ids.mint },
        items: [{ ...prepaidLine(ids.mint), modifiers: [{ groupId: uuidv7(), optionIds: [uuidv7()] }] }],
      }),
    );
    assert.equal(options.code, 'BAD_REQUEST');
    const gone = await refusal(ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.gone }, items: [juice] }));
    assert.equal(gone.code, 'BAND_NOT_IN_PARK');
    assert.equal(gone.message, 'Gone is not in the park, so food cannot be ordered against their band.');
    const away = await refusal(ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: ids.away }, items: [juice] }));
    assert.equal(away.code, 'BAND_OTHER_PARK');
    const unknown = await refusal(ask(box, 'cart.quote', { channel: 'fnb', bandHolder: { checkinId: uuidv7() }, items: [juice] }));
    assert.equal(unknown.code, 'BAND_STAY_NOT_FOUND');
  } finally {
    box.close();
  }
});
