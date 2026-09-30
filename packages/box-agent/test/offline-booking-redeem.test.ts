import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOX_BOOKING_REFUSALS,
  bandShortCode,
  verifyBandCode,
  type BridgeBookingRedeemAnswer,
  type BridgeBookingView,
} from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import type { BoxConfigBundle } from '../src/protocol';
import type { FinaliseCrashPoint } from '../src/sale-queue';
import { uuidv7 } from '../src/signing';
import {
  BridgeError,
  type BridgeTillCaller,
  type RedemptionCrashPoint,
  type StationBridge,
} from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import {
  BOX_ID,
  BRANCH_ID,
  STATION_ID,
  fakeBoxCloud,
  openTestStore,
  tillBundle,
  type TestStore,
} from './_support';

/**
 * S2-12 ROUND 5 — AN ONLINE BOOKING REDEEMED WITH THE BOX'S LINK DOWN.
 *
 * The real agent on a real SQLite store, nothing reachable. A family who booked
 * and paid online is redeemed from the box's cached `bookings` scope: the claim
 * is written to the box's redemption log first, the sale is committed through
 * the box's own sale path from the lines the family PAID for with the
 * paid-online tender — numbered, banded with the park's key, printed with the
 * children's allergy lines — and ONE `booking.redeemed` fact is queued after
 * its `sale.finalised`. The api suite (`offline-booking-redeem.test.ts`) proves
 * those facts reach the ledger once, and that a second box's are quarantined.
 */

const KEY = 'park-band-key-for-the-offline-booking-test';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const OTHER_ACCOUNT = '018f0000-0000-7000-8000-0000000000a2';
const JTI = '018f0000-0000-7000-8000-0000000000f1';
const PACKAGE = '018f0000-0000-7000-8000-00000000aa01';
const SOCKS = '018f0000-0000-7000-8000-00000000ab01';
const MEMBER = '018f0000-0000-7000-8000-00000000d001';
const PLOY = '018f0000-0000-7000-8000-00000000c0c1';
const TON = '018f0000-0000-7000-8000-00000000c0c2';
const STATION_2 = '018f0000-0000-7000-8000-0000000057a2';
const PAID = '018f0000-0000-7000-8000-0000000b0001';
const PENDING = '018f0000-0000-7000-8000-0000000b0002';
const REDEEMED_ONLINE = '018f0000-0000-7000-8000-0000000b0003';

/** Two kids at ฿350 and two adults (one free, one at ฿150), two pairs of socks at ฿50: ฿950. */
const TOTAL = 2 * 35000 + 15000 + 2 * 5000;

const quiet = { info() {}, warn() {}, error() {} };

function catalogueItem() {
  return {
    version: 'cat-v1',
    packages: [
      {
        id: PACKAGE,
        name: '2 Hours Play',
        active: true,
        archivedAt: null,
        // Today's list is dearer than what the family paid: the redemption
        // must never be re-priced from it.
        prices: { tourist: { weekday: 45000, weekend: 55000 } },
        adultRules: null,
        hours: 2,
        durationLabel: '2 Hours',
      },
    ],
    categories: [],
    products: [
      {
        id: SOCKS,
        code: 'AO-SOCKS',
        kind: 'addon',
        name: 'Regular Socks',
        priceSatang: 6000,
        priceWeekendSatang: null,
        categoryId: null,
        taxCategoryOverride: null,
        prepStationOverride: null,
        variants: [],
        active: true,
        archivedAt: null,
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
        categoryRules: [
          { category: 'tickets', taxRateId: 'vat', taxMode: 'inclusive' },
          { category: 'addons', taxRateId: 'vat', taxMode: 'inclusive' },
          { category: 'fnb', taxRateId: 'vat', taxMode: 'inclusive' },
        ],
        discountPlacement: 'before_tax',
      },
    },
    overrides: [],
    receiptHeader: { name: 'HKT Central', address: null, country: 'TH', operatorName: 'OTO' },
  };
}

function bookingRow(
  id: string,
  reference: string,
  status: string,
  redemption: Record<string, unknown> | null = null,
) {
  return {
    id,
    branchId: BRANCH_ID,
    memberId: MEMBER,
    reference,
    bookingDate: new Date().toISOString().slice(0, 10),
    status,
    totalSatang: TOTAL,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    payload: {
      tier: 'tourist',
      rateMode: 'weekday',
      parentName: 'Mali',
      phone: '+66811111111',
      lines: [
        {
          packageId: PACKAGE,
          name: '2 Hours Play',
          kids: 2,
          adults: 2,
          kidUnitSatang: 35000,
          adultsFree: 1,
          adultUnitSatang: 15000,
          socks: 2,
          socksUnitSatang: 5000,
          addOns: [],
          lineTotalSatang: TOTAL,
        },
      ],
      ...(redemption ? { redemption } : {}),
    },
  };
}

interface RedeemBox {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  till1: BridgeTillCaller;
  till2: BridgeTillCaller;
  crash: { at: FinaliseCrashPoint | null };
  close(): void;
}

async function openRedeemBox(): Promise<RedeemBox> {
  const bundle: BoxConfigBundle = tillBundle();
  const first = bundle.stations[0]!;
  bundle.stations.push({ ...first, id: STATION_2, name: 'Reception Till 2', codePrefix: 'T2', devices: [] });
  const cloud = fakeBoxCloud(bundle);
  const harness = openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const crash: RedeemBox['crash'] = { at: null };
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({
      boxId: BOX_ID,
      secret: 'offline-booking-test-secret',
      syncPrivateKeyPem: harness.keys.privateKeyPem,
    }),
    fetch: cloud.fetch,
    log: quiet,
    store: harness.store,
    printing: { retryDelayMs: 0, durable: true },
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
  const write = async (scope: CachedBundle['scope'], items: unknown[]) => {
    await harness.store.writeBundle(BOX_ID, {
      scope,
      schemaVersion: 1,
      cursorSeq: 0,
      payload: { items },
      appliedAt: new Date().toISOString(),
    });
  };
  await write('catalogue', [catalogueItem()]);
  await write('receipt_series', [
    { stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 },
    { stationId: STATION_2, prefix: 'T2', highWaterMark: 7 },
  ]);
  await write('members', [
    {
      id: MEMBER,
      phone: '+66811111111',
      nickname: 'Mali',
      name: null,
      tierCode: 'tourist',
      preferredChannel: null,
      childrenReviewSince: null,
      aliasIds: [],
      children: [
        { id: PLOY, name: 'Ploy', ageYears: 6, allergies: 'Peanuts', medicalNotes: 'Carries an EpiPen', medicalAlert: true, dietary: null },
        { id: TON, name: 'Ton', ageYears: 4, allergies: null, medicalNotes: null, medicalAlert: false, dietary: null },
      ],
    },
  ]);
  await write('bookings', [
    bookingRow(PAID, 'OTO-PAID-0001', 'paid'),
    bookingRow(PENDING, 'OTO-PEND-0002', 'pending'),
    bookingRow(REDEEMED_ONLINE, 'OTO-DONE-0003', 'redeemed', {
      redeemedAt: '2026-10-01T03:05:00.000Z',
      branchId: BRANCH_ID,
      stationId: STATION_ID,
      accountId: OTHER_ACCOUNT,
      bandCodes: ['T1-AAAA11'],
    }),
  ]);
  const bridge = agent.bridge();
  assert.ok(bridge, 'a box with a store serves the bridge');
  const till = (accountId: string): BridgeTillCaller => ({
    kind: 'till',
    accountId,
    can: () => true,
    method: 'offline_token',
    offlineFresh: false,
    jti: JTI,
  });
  return {
    agent,
    harness,
    bridge,
    till1: till(ACCOUNT),
    till2: till(OTHER_ACCOUNT),
    crash,
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
  actionId: `t-${uuidv7().slice(-12)}`,
});

async function redeem(
  box: RedeemBox,
  body: Record<string, unknown>,
  at: { station?: string; caller?: BridgeTillCaller } = {},
): Promise<BridgeBookingRedeemAnswer> {
  const answer = await box.bridge.intent(
    at.station ?? STATION_ID,
    at.caller ?? box.till1,
    intent('booking.redeem', body),
  );
  return answer.result as unknown as BridgeBookingRedeemAnswer;
}

async function lookup(box: RedeemBox, body: Record<string, unknown>): Promise<BridgeBookingView> {
  const answer = await box.bridge.intent(STATION_ID, box.till1, intent('booking.lookup', body));
  return (answer.result as { booking: BridgeBookingView }).booking;
}

/** Every fact the box is holding, oldest first — read, then put straight back. */
async function facts(box: RedeemBox) {
  const now = new Date().toISOString();
  const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 50, maxBytes: 5_000_000, now });
  if (batch.events.length > 0) {
    await box.harness.store.releaseBatch(
      BOX_ID,
      batch.events.map((e) => e.eventId),
      { errorCode: 'TEST_READ', errorMessage: 'read by the test', retryAt: now },
    );
  }
  return batch.events;
}

const press = (over: Record<string, unknown> = {}) => ({
  bookingId: PAID,
  actionId: `redeem-${uuidv7().slice(-12)}`,
  staffName: 'Nok',
  visitChildIds: [PLOY, TON],
  ...over,
});

test('a paid booking redeems on the box: its paid lines to the satang, the paid-online tender, bands with allergies, one fact after its sale', async () => {
  const box = await openRedeemBox();
  try {
    const found = await lookup(box, { bookingId: PAID });
    assert.equal(found.reference, 'OTO-PAID-0001');
    assert.equal(found.status, 'paid');
    assert.equal(found.redemption, null);

    const answer = await redeem(box, press());
    assert.equal(answer.replay, false);
    // THE SNAPSHOT TO THE SATANG: what the family paid, not today's dearer list.
    assert.equal(answer.sale.totals.grossSatang, TOTAL);
    assert.equal(answer.sale.status, 'finalised');
    assert.equal(answer.sale.receiptNumber, 'T1-000043');
    assert.equal(answer.booking.status, 'redeemed');
    assert.equal(answer.booking.redemption?.staffName, 'Nok');
    assert.equal(answer.booking.redemption?.stationName, 'Reception Till 1');

    // Two kids' bands naming the children, two adults' — minted with the park key.
    assert.deepEqual(answer.bands.map((b) => b.kind).sort(), ['adult', 'adult', 'kid', 'kid']);
    assert.deepEqual(
      answer.bands.filter((b) => b.kind === 'kid').map((b) => b.childName),
      ['Ploy', 'Ton'],
    );
    for (const band of answer.bands) assert.match(band.shortCode ?? '', /^T1-[0-9A-Z]+$/);

    // The paper carries the allergy line: the snapshot the box printed from.
    const logged = await box.agent.sales()!.recorded(answer.sale.id);
    const ploy = logged!.snapshot!.bands.find((b) => b.childName === 'Ploy');
    assert.equal(ploy?.allergies, 'Peanuts');
    assert.equal(ploy?.medicalNotes, 'Carries an EpiPen');
    assert.ok(answer.printing.jobs.some((j) => j.kind === 'kids_wristband'));
    assert.ok(answer.printing.jobs.some((j) => j.kind === 'receipt'));

    // Two facts, in order: the sale, then the redemption naming it.
    const events = await facts(box);
    assert.deepEqual(events.map((e) => e.type), ['sale.finalised', 'booking.redeemed']);
    const sale = events[0]!.payload as {
      saleId: string;
      cart: { bookingId: string; expectedTotalSatang: number; lines: Array<{ packageId: string }> };
      tenders: Array<{ methodCode: string; amountSatang: number; kind: string }>;
      bands: Array<{ code: string; childId: string | null }>;
    };
    assert.equal(sale.saleId, answer.sale.id);
    assert.equal(sale.cart.bookingId, PAID);
    assert.equal(sale.cart.expectedTotalSatang, TOTAL);
    assert.deepEqual(
      sale.tenders.map((t) => [t.methodCode, t.amountSatang, t.kind]),
      [['paid_online', TOTAL, 'other']],
      'settled by the paid-online tender, never cash',
    );
    for (const band of sale.bands) assert.equal(verifyBandCode(band.code, KEY).ok, true);
    const redeemed = events[1]!.payload as {
      bookingId: string;
      saleId: string;
      bandCodes: string[];
      receiptNumber: string;
    };
    assert.equal(redeemed.bookingId, PAID);
    assert.equal(redeemed.saleId, answer.sale.id);
    assert.equal(redeemed.receiptNumber, 'T1-000043');
    assert.deepEqual(
      [...redeemed.bandCodes].sort(),
      sale.bands.map((b) => bandShortCode(b.code)).sort(),
      'the short codes handed over, never the signed ones',
    );
  } finally {
    box.close();
  }
});

test('the local log is idempotent: the same press is answered again; another till on this box is told who and when', async () => {
  const box = await openRedeemBox();
  try {
    const body = press();
    const first = await redeem(box, body);
    const again = await redeem(box, body);
    assert.equal(again.replay, true);
    assert.equal(again.sale.id, first.sale.id);
    assert.equal(again.sale.receiptNumber, first.sale.receiptNumber);
    assert.deepEqual(
      again.bands.map((b) => b.shortCode),
      first.bands.map((b) => b.shortCode),
    );
    assert.equal((await facts(box)).length, 2, 'still one sale and one redemption');

    // The second till on this box, a new press: already redeemed, by name.
    await assert.rejects(
      redeem(box, press({ staffName: 'Ploy' }), { station: STATION_2, caller: box.till2 }),
      (err: unknown) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'BOOKING_ALREADY_REDEEMED');
        assert.equal(err.status, 409);
        assert.match(err.message, /OTO-PAID-0001 was already redeemed on \d{4}-\d{2}-\d{2} \d{2}:\d{2} at .*Reception Till 1, Nok/);
        const redemption = (err.details as { redemption: { staffName: string; stationName: string; bandCodes: string[] } })
          .redemption;
        assert.equal(redemption.staffName, 'Nok');
        assert.equal(redemption.stationName, 'Reception Till 1');
        assert.equal(redemption.bandCodes.length, 4);
        return true;
      },
    );
    // And the lookup shows it redeemed, from this box's log.
    const seen = await lookup(box, { reference: 'oto-paid-0001' });
    assert.equal(seen.status, 'redeemed');
    assert.equal(seen.source, 'log');
    assert.equal((await facts(box)).length, 2, 'the refusal wrote nothing');
  } finally {
    box.close();
  }
});

test('a cached pending booking is refused as not paid; an unknown one says see reception; one redeemed online says who and when', async () => {
  const box = await openRedeemBox();
  try {
    await assert.rejects(redeem(box, press({ bookingId: PENDING })), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'BOOKING_NOT_REDEEMABLE');
      assert.match(err.message, /OTO-PEND-0002: booking not paid\. It is pending/);
      return true;
    });
    await assert.rejects(redeem(box, press({ bookingId: uuidv7() })), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.status, 404);
      assert.equal(err.code, BOX_BOOKING_REFUSALS.unknown.code);
      assert.match(err.message, /reception/);
      return true;
    });
    await assert.rejects(lookup(box, { reference: 'OTO-NONE-9999' }), (err: unknown) => {
      assert.ok(err instanceof BridgeError && err.code === BOX_BOOKING_REFUSALS.unknown.code);
      return true;
    });
    await assert.rejects(redeem(box, press({ bookingId: REDEEMED_ONLINE })), (err: unknown) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'BOOKING_ALREADY_REDEEMED');
      assert.match(err.message, /OTO-DONE-0003 was already redeemed on 2026-10-01 10:05 at HKT Central, Reception Till 1/);
      return true;
    });
    assert.equal((await facts(box)).length, 0, 'nothing sold, nothing queued');
    assert.equal(await box.agent.sales()!.recorded(PENDING), null);
  } finally {
    box.close();
  }
});

for (const point of ['after_fact', 'after_log'] as FinaliseCrashPoint[]) {
  test(`a restart between the claim and the sale (${point.replace('_', ' ')}) recovers to exactly one sale`, async () => {
    const box = await openRedeemBox();
    try {
      box.crash.at = point;
      await assert.rejects(redeem(box, press()), /the power went/);
      assert.equal((await facts(box)).length, 0, 'the sale rolled back whole');
      // The claim is on disk, so the booking is not free for a second sale —
      // and nothing was handed over, so the lookup does not call it redeemed.
      const seen = await lookup(box, { bookingId: PAID });
      assert.equal(seen.redemption, null);

      // The next Confirm — a new press, even at another till — finishes THAT
      // sale, under the sale id the claim was written with.
      const recovered = await redeem(box, press(), { station: STATION_2, caller: box.till2 });
      assert.equal(recovered.sale.totals.grossSatang, TOTAL);
      assert.equal(recovered.bands.length, 4);
      // Any press after that is a second redemption, and is told so.
      await assert.rejects(
        redeem(box, press()),
        (err: unknown) => err instanceof BridgeError && err.code === 'BOOKING_ALREADY_REDEEMED',
      );
      const events = await facts(box);
      assert.deepEqual(events.map((e) => e.type), ['sale.finalised', 'booking.redeemed']);
      const saleIds = new Set(events.map((e) => (e.payload as { saleId: string }).saleId));
      assert.deepEqual([...saleIds], [recovered.sale.id], 'one sale id across both facts');
    } finally {
      box.close();
    }
  });
}

test('a restart between the sale and its redemption fact queues the fact once, and never a second sale', async () => {
  const box = await openRedeemBox();
  try {
    const crashes: RedemptionCrashPoint[] = ['after_sale'];
    box.bridge.redemptionCrash = (point) => {
      if (crashes[0] === point) {
        crashes.shift();
        throw new Error(`the power went at ${point}`);
      }
    };
    const body = press();
    await assert.rejects(redeem(box, body), /the power went/);
    assert.deepEqual((await facts(box)).map((e) => e.type), ['sale.finalised']);

    const retried = await redeem(box, body);
    assert.equal(retried.sale.receiptNumber, 'T1-000043', 'the one sale, answered from the log');
    const events = await facts(box);
    assert.deepEqual(events.map((e) => e.type), ['sale.finalised', 'booking.redeemed']);
    assert.equal((events[1]!.payload as { saleId: string }).saleId, retried.sale.id);

    await redeem(box, body);
    assert.equal((await facts(box)).length, 2, 'a third press writes nothing');
  } finally {
    box.bridge.redemptionCrash = null;
    box.close();
  }
});

// --- S2-12 closing audit probes ------------------------------------------------------------

test('AUDIT: an ordinary cash sale cannot carry a booking marker onto the box lane', async () => {
  // A till that is not redeeming names a paid booking on an ordinary cash cart.
  // Filed as-is, the platform would take it for the booking's redemption: the
  // cash dropped for a paid-online tender, and the booking redeemed by an
  // account that never held `pos:booking:redeem`. The box refuses it whole.
  const box = await openRedeemBox();
  try {
    const cart = {
      memberId: MEMBER,
      tier: 'tourist',
      lines: [{ id: uuidv7(), packageId: PACKAGE, kids: 1, adults: 0 }],
      bookingId: PAID,
      bookingRedemptionId: uuidv7(),
      expectedTotalSatang: 45000,
    };
    for (const body of [cart, { cart }]) {
      await assert.rejects(
        box.bridge.intent(
          STATION_ID,
          box.till1,
          intent('sale.finalise', {
            saleId: uuidv7(),
            actionId: `pay-${uuidv7().slice(-12)}`,
            cart: body,
            tender: {
              actionId: `cash-${uuidv7().slice(-12)}`,
              method: 'cash',
              kind: 'cash',
              amountSatang: 45000,
              tenderedSatang: 50000,
              changeSatang: 5000,
            },
          }),
        ),
        (err: unknown) => {
          assert.ok(err instanceof BridgeError, String(err));
          assert.equal(err.code, 'SALE_CART_NAMES_BOOKING');
          return true;
        },
      );
    }
    assert.equal((await facts(box)).length, 0, 'nothing sold, nothing queued');
    // The booking is still there to redeem properly.
    const answer = await redeem(box, press());
    assert.equal(answer.sale.totals.grossSatang, TOTAL);
  } finally {
    box.close();
  }
});

test('AUDIT: a claim a restart left unsold is not finished once the booking is known redeemed elsewhere', async () => {
  const box = await openRedeemBox();
  try {
    box.crash.at = 'after_fact';
    await assert.rejects(redeem(box, press()), /the power went/);
    assert.equal((await facts(box)).length, 0);
    // Back online for a moment: the family was redeemed at a counter online,
    // and the box's next pull says so.
    await box.harness.store.writeBundle(BOX_ID, {
      scope: 'bookings',
      schemaVersion: 1,
      cursorSeq: 1,
      payload: {
        items: [
          bookingRow(PAID, 'OTO-PAID-0001', 'redeemed', {
            redeemedAt: '2026-10-01T03:05:00.000Z',
            branchId: BRANCH_ID,
            stationId: STATION_ID,
            accountId: OTHER_ACCOUNT,
            bandCodes: ['T1-AAAA11'],
          }),
        ],
      },
      appliedAt: new Date().toISOString(),
    });
    await assert.rejects(redeem(box, press()), (err: unknown) => {
      assert.ok(err instanceof BridgeError, String(err));
      assert.equal(err.code, 'BOOKING_ALREADY_REDEEMED');
      return true;
    });
    assert.equal((await facts(box)).length, 0, 'no second set of bands on one box');
  } finally {
    box.close();
  }
});
