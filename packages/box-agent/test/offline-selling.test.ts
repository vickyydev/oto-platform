import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOX_LANE_REFUSALS,
  mintBoothCode,
  saleReceiptDocument,
  verifyBandCode,
  type BridgeSaleAnswer,
} from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import type { BoxCommandHandout, BoxConfigBundle } from '../src/protocol';
import { FINALISE_CRASH_POINTS, type FinaliseCrashPoint } from '../src/sale-queue';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import {
  BOX_ID,
  STATION_ID,
  TILL_RECEIPT_PRINTER,
  fakeBoxCloud,
  openTestStore,
  seededIndex,
  tillBundle,
  type FakeBoxCloud,
  type TestStore,
} from './_support';

/**
 * SELLING ON THE BOX LANE — offline plan Round 4 (SCRUM-269; SCRUM-206's
 * offline half).
 *
 * The real agent on a real SQLite store, with the cloud faked at the HTTP
 * boundary and nothing reachable: a till's money goes through the box's own
 * bridge into `SaleQueue.record`, which numbers the sale, mints its bands with
 * the park's key, composes its paper from the shared composer and writes all
 * of it, and the fact, in one store transaction — then opens the drawer and
 * prints from the box's own queue. What is proved here is the box's half; the
 * api suite (`offline-selling.test.ts`) proves the same sales reach the ledger
 * exactly once under the numbers printed here.
 */

const KEY = 'park-band-key-for-the-offline-selling-test';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const JTI = '018f0000-0000-7000-8000-0000000000f1';
const PACKAGE = '018f0000-0000-7000-8000-00000000aa01';
const LATTE = '018f0000-0000-7000-8000-0000000000c1';
const MILK = '018f0000-0000-7000-8000-0000000000c2';
const OAT = '018f0000-0000-7000-8000-0000000000c3';
const DRINKS = '018f0000-0000-7000-8000-0000000000c4';
const MEMBER = '018f0000-0000-7000-8000-00000000d001';
const PLOY = '018f0000-0000-7000-8000-00000000c0c1';
const TON = '018f0000-0000-7000-8000-00000000c0c2';
const CARD = '018f0000-0000-7000-8000-00000000ed01';
const PAX = '018f0000-0000-7000-8000-00000000ed03';

const quiet = { info() {}, warn() {}, error() {} };

function catalogueItem(kidWeekday = 35000) {
  return {
    version: 'cat-v1',
    packages: [
      {
        id: PACKAGE,
        name: '2 Hours Play',
        active: true,
        archivedAt: null,
        prices: {
          tourist: { weekday: kidWeekday, weekend: kidWeekday + 10000 },
        },
        adultRules: null,
        hours: 2,
        durationLabel: '2 Hours',
      },
    ],
    categories: [
      { id: DRINKS, parentId: null, taxableCategory: 'fnb', name: 'Drinks', defaultPrepStation: 'bar' },
    ],
    products: [
      {
        id: LATTE,
        kind: 'menu',
        name: 'Latte',
        priceSatang: 9000,
        priceWeekendSatang: null,
        categoryId: DRINKS,
        taxCategoryOverride: null,
        prepStationOverride: null,
        variants: [],
        active: true,
        archivedAt: null,
      },
    ],
    modifierGroups: [
      {
        id: MILK,
        productId: LATTE,
        name: 'Milk',
        required: true,
        selectionType: 'single',
        minSelect: null,
        maxSelect: null,
        sortOrder: 0,
      },
    ],
    modifierOptions: [
      { id: OAT, modifierGroupId: MILK, name: 'Oat', priceSatang: 1500, priceWeekendSatang: null, sortOrder: 0 },
    ],
    modifierLinks: [],
    tiers: [{ code: 'tourist', isDefault: true, archivedAt: null }],
    holidays: [],
    taxConfig: {
      config: {
        rates: [{ id: 'vat', name: 'VAT', percent: 7 }],
        categoryRules: [
          { category: 'tickets', taxRateId: 'vat', taxMode: 'inclusive' },
          { category: 'fnb', taxRateId: 'vat', taxMode: 'inclusive' },
        ],
        discountPlacement: 'before_tax',
      },
    },
    overrides: [],
    receiptHeader: { name: 'HKT Central', address: null, country: 'TH', operatorName: 'OTO' },
  };
}

function terminal(id: string, role: string, protocol: string, label: string) {
  return {
    id,
    role,
    kind: 'terminal',
    label,
    transport: 'simulated',
    address: null,
    model: protocol === 'ghl_linkpos' ? 'NEXGO N5' : 'PAX A920Pro',
    protocol,
    serialNumber: null,
    terminalId: protocol === 'ghl_linkpos' ? '65703235' : null,
    merchantId: protocol === 'ghl_linkpos' ? '4648434010' : null,
    settings: {},
  };
}

interface SellingBox {
  agent: BoxAgent;
  harness: TestStore;
  cloud: FakeBoxCloud;
  bridge: StationBridge;
  caller: BridgeTillCaller;
  crash: { at: FinaliseCrashPoint | null };
  write(scope: CachedBundle['scope'], items: unknown[]): Promise<void>;
  close(): void;
}

async function openSellingBox(opts: { mark?: number; terminals?: 'both' | 'card' | 'none' } = {}): Promise<SellingBox> {
  const bundle: BoxConfigBundle = tillBundle();
  const which = opts.terminals ?? 'both';
  const station = bundle.stations[0]!;
  if (which !== 'none') station.devices.push(terminal(CARD, 'card_terminal', 'ghl_linkpos', 'EDC 1') as never);
  if (which === 'both') station.devices.push(terminal(PAX, 'qr_terminal', 'digio_tlv', 'EDC 3') as never);
  const cloud = fakeBoxCloud(bundle);
  const harness = openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const crash: SellingBox['crash'] = { at: null };
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({
      boxId: BOX_ID,
      secret: 'offline-selling-test-secret',
      syncPrivateKeyPem: harness.keys.privateKeyPem,
    }),
    fetch: cloud.fetch,
    log: quiet,
    store: harness.store,
    // Durable, as a Pi runs it: a sale's print jobs are written in its own
    // transaction, so the crash points below prove they roll back with it.
    printing: { retryDelayMs: 0, durable: true },
    terminal: { timeouts: { saleMs: 250, probeMs: 250 } },
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
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: opts.mark ?? 42 }]);
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
        { id: PLOY, name: 'Ploy', ageYears: 6, allergies: 'Peanuts', medicalNotes: null, medicalAlert: true, dietary: 'No dairy' },
        { id: TON, name: 'Ton', ageYears: 4, allergies: null, medicalNotes: null, medicalAlert: false, dietary: null },
      ],
    },
  ]);
  const bridge = agent.bridge();
  assert.ok(bridge, 'a box with a store serves the bridge');
  const caller: BridgeTillCaller = {
    kind: 'till',
    accountId: ACCOUNT,
    can: () => true,
    method: 'offline_token',
    offlineFresh: false,
    jti: JTI,
  };
  return {
    agent,
    harness,
    cloud,
    bridge,
    caller,
    crash,
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
  actionId: `t-${uuidv7().slice(-12)}`,
});

/** Paper the receipt printer cut — a drawer pulse rides the same printer and cuts nothing. */
const receipts = (box: SellingBox): number =>
  box.agent.printing()!.printouts(TILL_RECEIPT_PRINTER).filter((p) => !p.truncated && p.heightDots > 0).length;

async function quote(box: SellingBox, cart: Record<string, unknown>): Promise<number> {
  const answer = await box.bridge.intent(STATION_ID, box.caller, intent('cart.quote', cart));
  return (answer.result as { quote: { totals: { grossSatang: number } } }).quote.totals.grossSatang;
}

async function send(box: SellingBox, type: string, body: Record<string, unknown>): Promise<BridgeSaleAnswer> {
  const answer = await box.bridge.intent(STATION_ID, box.caller, intent(type, body));
  return answer.result as unknown as BridgeSaleAnswer;
}

/** A family's two kids and one adult on two hours, rung up at the till. */
function ticketCart(total?: number) {
  return {
    memberId: MEMBER,
    lines: [{ id: uuidv7(), packageId: PACKAGE, kids: 2, adults: 1 }],
    ...(total === undefined ? {} : { expectedTotalSatang: total }),
  };
}

async function ticketSale(box: SellingBox, over: Record<string, unknown> = {}) {
  const cart = ticketCart();
  const total = await quote(box, cart);
  return {
    total,
    body: {
      saleId: uuidv7(),
      actionId: `pay-${uuidv7().slice(-12)}`,
      staffName: 'Nok',
      visitChildIds: [PLOY, TON],
      cart: { ...cart, expectedTotalSatang: total },
      tender: {
        actionId: `cash-${uuidv7().slice(-12)}`,
        method: 'cash',
        kind: 'cash',
        amountSatang: total,
        tenderedSatang: total + 10_000,
        changeSatang: 10_000,
      },
      ...over,
    },
  };
}

test('cash on the box lane: numbered from the mark, banded with the park key, printed from the box queue, one fact', async () => {
  const box = await openSellingBox();
  try {
    const { total, body } = await ticketSale(box);
    const answer = await send(box, 'sale.finalise', body);
    assert.equal(answer.finalised, true);
    assert.equal(answer.replay, false);
    assert.equal(answer.sale.status, 'finalised');
    assert.equal(answer.sale.receiptNumber, 'T1-000043', 'the next number after the mark the box pulled');
    assert.equal(answer.sale.totals.grossSatang, total);
    assert.equal(answer.attempt?.status, 'approved');
    assert.equal(answer.attempt?.offline, true);
    assert.notEqual(answer.drawer, 'not_asked', 'cash asks for the drawer');

    // The fact: one `sale.finalised`, carrying the number, the bands, the price basis.
    const depth = await box.agent.outbox()!.depth();
    assert.equal(depth.queued, 1);
    const batch = await box.harness.store.takeBatch(BOX_ID, {
      maxEvents: 10,
      maxBytes: 1_000_000,
      now: new Date().toISOString(),
    });
    const fact = batch.events[0]!;
    assert.equal(fact.type, 'sale.finalised');
    assert.equal(fact.actorAccountId, ACCOUNT);
    const payload = fact.payload as {
      saleId: string;
      receipt: { number: string };
      bands: Array<{ id: string; code: string; kind: string; childId: string | null }>;
      tenders: Array<{ amountSatang: number; changeSatang: number }>;
      catalogueVersion: string;
      priceBasis: { pricingMode: string; packages: unknown[] };
      staffTokenJti: string;
    };
    assert.equal(payload.saleId, body.saleId);
    assert.equal(payload.receipt.number, 'T1-000043');
    assert.equal(payload.staffTokenJti, JTI);
    assert.equal(payload.catalogueVersion, 'cat-v1');
    assert.equal(payload.priceBasis.packages.length, 1);
    assert.deepEqual(payload.tenders.map((t) => [t.amountSatang, t.changeSatang]), [[total, 10_000]]);

    // OD-13: three bands, minted with the park's key in the platform's format.
    assert.deepEqual(payload.bands.map((b) => b.kind), ['kid', 'kid', 'adult']);
    assert.deepEqual(payload.bands.map((b) => b.childId), [PLOY, TON, null]);
    for (const band of payload.bands) {
      assert.equal(verifyBandCode(band.code, KEY).ok, true, 'a band the gate can check with the park key');
      assert.match(band.code, /^T1/);
    }

    // The paper, from the box's own queue: receipt and kids bands printed; the
    // adult band has no printer at this counter and says so.
    const kinds = answer.printing.jobs.map((j) => [j.kind, j.status]);
    assert.deepEqual(kinds.filter(([k]) => k === 'receipt'), [['receipt', 'printed']]);
    assert.equal(kinds.filter(([k, s]) => k === 'kids_wristband' && s === 'printed').length, 2);
    const adult = kinds.find(([k]) => k === 'adult_wristband');
    assert.ok(adult && adult[1] !== 'printed', 'no adult band printer here');
    assert.ok(answer.printing.notes.some((n) => /adult wristband not printed/i.test(n)));
    assert.equal(receipts(box), 1);
    // The box's own jobs never go up the print-result route: the cloud has no row for them.
    assert.deepEqual(box.cloud.printResults, []);

    // The receipt it printed is the composer's, from the box's own snapshot.
    const logged = await box.agent.sales()!.recorded(body.saleId);
    const receipt = saleReceiptDocument(logged!.snapshot!);
    assert.equal(receipt.receiptNumber, 'T1-000043');
    assert.equal(receipt.staffName, 'Nok');
    assert.equal(receipt.memberNickname, 'Mali');
    assert.deepEqual(receipt.taxInvoiceLines?.slice(0, 3), [
      'ใบกำกับภาษีอย่างย่อ',
      'ABBREVIATED TAX INVOICE',
      'OTO · HKT Central',
    ]);
    assert.equal(receipt.bandCodes?.length, 3);
    assert.ok(receipt.tenders?.some((t) => t.label === 'Change'));
  } finally {
    box.close();
  }
});

test('the same sale sent again is answered from the box log: one sale, one number, one fact', async () => {
  const box = await openSellingBox();
  try {
    const { body } = await ticketSale(box);
    const first = await send(box, 'sale.finalise', body);
    const again = await send(box, 'sale.finalise', body);
    assert.equal(again.replay, true);
    assert.equal(again.sale.receiptNumber, first.sale.receiptNumber);
    assert.equal(again.drawer, 'not_asked', 'a retry does not open the drawer twice');
    assert.equal((await box.agent.outbox()!.depth()).queued, 1);
    assert.equal(receipts(box), 1, 'nor print twice');
    const next = await send(box, 'sale.finalise', (await ticketSale(box)).body);
    assert.equal(next.sale.receiptNumber, 'T1-000044');
  } finally {
    box.close();
  }
});

for (const point of FINALISE_CRASH_POINTS) {
  test(`a power cut ${point.replace(/_/g, ' ')} leaves nothing half-written, and the retry takes the same number`, async () => {
    const box = await openSellingBox();
    try {
      const { body } = await ticketSale(box);
      box.crash.at = point;
      await assert.rejects(send(box, 'sale.finalise', body), /the power went/);
      assert.equal((await box.agent.outbox()!.depth()).queued, 0, 'no fact');
      assert.equal(await box.agent.sales()!.recorded(body.saleId), null, 'no log');
      assert.deepEqual(await box.harness.store.loadPendingPrintJobs(BOX_ID), [], 'no print job');
      assert.equal(receipts(box), 0, 'no paper');

      const retried = await send(box, 'sale.finalise', body);
      assert.equal(retried.sale.receiptNumber, 'T1-000043', 'the number the lost attempt never spent');
      assert.equal((await box.agent.outbox()!.depth()).queued, 1);
    } finally {
      box.close();
    }
  });
}

test('OD-4: the series continues from the higher of the pulled mark, the observed number and its own', async () => {
  const box = await openSellingBox({ mark: 42 });
  try {
    const observed = await box.bridge.intent(
      STATION_ID,
      box.caller,
      intent('receipt.observed', { receiptNumber: 'T1-000050' }),
    );
    assert.deepEqual((observed.result as { observed: unknown }).observed, { prefix: 'T1', seq: 50 });
    // A number from another series is not this station's.
    const foreign = await box.bridge.intent(
      STATION_ID,
      box.caller,
      intent('receipt.observed', { receiptNumber: 'K9-000900' }),
    );
    assert.equal((foreign.result as { observed: unknown }).observed, null);

    const first = await send(box, 'sale.finalise', (await ticketSale(box)).body);
    assert.equal(first.sale.receiptNumber, 'T1-000051');
    const second = await send(box, 'sale.finalise', (await ticketSale(box)).body);
    assert.equal(second.sale.receiptNumber, 'T1-000052');

    // The mark catches up part-way (one of the two synced) — the box does not
    // print 52 a second time.
    await box.write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 51 }]);
    const third = await send(box, 'sale.finalise', (await ticketSale(box)).body);
    assert.equal(third.sale.receiptNumber, 'T1-000053');
    // And one far ahead of everything moves it on.
    await box.write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 90 }]);
    const fourth = await send(box, 'sale.finalise', (await ticketSale(box)).body);
    assert.equal(fourth.sale.receiptNumber, 'T1-000091');
  } finally {
    box.close();
  }
});

test('a ฿0 comp closes with no tender, is numbered and banded', async () => {
  const box = await openSellingBox();
  try {
    const cart = {
      ...ticketCart(),
      manualDiscounts: [{ id: uuidv7(), scope: 'order', type: 'comp', value: 0, reason: 'Staff / family' }],
    };
    const total = await quote(box, cart);
    assert.equal(total, 0);
    const answer = await send(box, 'sale.finalise', {
      saleId: uuidv7(),
      actionId: 'pay-comp',
      cart: { ...cart, expectedTotalSatang: 0 },
      tender: null,
    });
    assert.equal(answer.finalised, true);
    assert.equal(answer.attempt, null);
    assert.equal(answer.drawer, 'not_asked');
    assert.equal(answer.sale.receiptNumber, 'T1-000043');
    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 5, maxBytes: 1_000_000, now: new Date().toISOString() });
    const payload = batch.events[0]!.payload as { tenders: unknown[]; bands: unknown[] };
    assert.deepEqual(payload.tenders, []);
    assert.equal(payload.bands.length, 3);
  } finally {
    box.close();
  }
});

test('what the box lane will not take is refused before anything is numbered', async () => {
  const box = await openSellingBox();
  try {
    const refused = async (body: Record<string, unknown>, code: string, type = 'sale.finalise') =>
      assert.rejects(
        send(box, type, body),
        (err: unknown) => err instanceof BridgeError && err.code === code,
        code,
      );
    const { total, body } = await ticketSale(box);
    // A split: the box closes a sale with one payment.
    await refused({ ...body, tender: { ...body.tender, amountSatang: total - 100 } }, BOX_LANE_REFUSALS.split.code);
    // A total the till saw differently.
    await refused({ ...body, cart: { ...body.cart, expectedTotalSatang: total + 1 } }, 'SALE_TOTAL_MISMATCH');
    // Wallet spend (OD-14).
    await refused({ ...body, tender: { ...body.tender, method: 'wallet', kind: 'other' } }, BOX_LANE_REFUSALS.wallet.code);
    // A voucher on the cart.
    const code = mintBoothCode('B1', seededIndex(7));
    await refused({ ...body, cart: { ...body.cart, promoCodes: [code] } }, BOX_LANE_REFUSALS.voucher.code);
    // An F&B order with no pick-up code.
    const coffee = { items: [{ id: uuidv7(), productId: LATTE, quantity: 1, modifiers: [{ groupId: MILK, optionIds: [OAT] }] }] };
    const coffeeTotal = await quote(box, coffee);
    await refused(
      {
        ...body,
        cart: { ...coffee, expectedTotalSatang: coffeeTotal },
        tender: { ...body.tender, amountSatang: coffeeTotal, tenderedSatang: coffeeTotal },
      },
      'PICKUP_CODE_REQUIRED',
    );
    // Nothing was numbered or queued on the way.
    assert.equal((await box.agent.outbox()!.depth()).queued, 0);
    const next = await send(box, 'sale.finalise', body);
    assert.equal(next.sale.receiptNumber, 'T1-000043');
  } finally {
    box.close();
  }
});

test('an F&B order prints its prep ticket at its station with the pick-up code', async () => {
  const box = await openSellingBox();
  try {
    const coffee = {
      pickupCode: '42',
      items: [{ id: uuidv7(), productId: LATTE, quantity: 2, modifiers: [{ groupId: MILK, optionIds: [OAT] }], note: 'extra hot' }],
      channel: 'fnb',
    };
    const total = await quote(box, coffee);
    const answer = await send(box, 'sale.finalise', {
      saleId: uuidv7(),
      actionId: 'pay-coffee',
      cart: { ...coffee, expectedTotalSatang: total },
      tender: { actionId: 'cash-coffee', method: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total },
    });
    assert.deepEqual(
      answer.printing.jobs.map((j) => j.kind),
      ['receipt', 'bar_ticket'],
      'the drink prints at the bar, where its category sends it',
    );
    const logged = await box.agent.sales()!.recorded(answer.sale.id);
    const line = logged!.snapshot!.lines[0]!;
    assert.equal(line.kind, 'fnb_item');
    assert.deepEqual(line.payload?.modifiers?.map((m) => m.optionName), ['Oat']);
    assert.equal(line.payload?.pickupCode, '42');
    assert.equal(line.payload?.prepStation, 'bar');
  } finally {
    box.close();
  }
});

test('a late first print of a sale this box printed is refused; a copy asked for is printed', async () => {
  const box = await openSellingBox();
  try {
    const { body } = await ticketSale(box);
    await send(box, 'sale.finalise', body);
    const late = uuidv7();
    const copy = uuidv7();
    const command = (jobId: string, extra: Record<string, unknown>): BoxCommandHandout => ({
      id: `cmd-${jobId.slice(-6)}`,
      kind: 'test_print',
      payload: {
        printJobId: jobId,
        kind: 'receipt',
        role: 'receipt',
        stationId: STATION_ID,
        copies: 1,
        document: 'platform',
        subjectType: 'sale',
        saleId: body.saleId,
        ...extra,
      },
      actionId: 'platform-finalise',
      attempts: 1,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    });
    box.cloud.documents.set(copy, {
      status: 200,
      body: {
        printJobId: copy,
        kind: 'receipt',
        role: 'receipt',
        stationId: STATION_ID,
        templateId: null,
        templateVersion: null,
        reprintOf: null,
        job: { kind: 'receipt', data: { title: 'Receipt (copy)', lines: [], total: '฿0' } },
      },
    });
    box.cloud.commands.push(command(late, {}), command(copy, { reprint: true }));
    const before = receipts(box);
    assert.equal(await box.agent.runPendingCommands(), 2);
    assert.deepEqual(box.cloud.documentsAsked, [copy], 'the late first print is not even fetched');
    const lateResult = box.cloud.printResults.find((r) => r.jobId === late);
    assert.equal(lateResult?.body.status, 'skipped');
    assert.equal(lateResult?.body.errorCode, 'PRINTED_ON_BOX');
    assert.equal(box.cloud.printResults.find((r) => r.jobId === copy)?.body.status, 'printed');
    assert.equal(receipts(box), before + 1);
  } finally {
    box.close();
  }
});

test('Reprint: today’s sale from the box’s own log; a sale it did not take is not its to reprint', async () => {
  const box = await openSellingBox();
  try {
    const { body } = await ticketSale(box);
    await send(box, 'sale.finalise', body);
    const before = receipts(box);
    const copy = await box.bridge.intent(
      STATION_ID,
      box.caller,
      intent('sale.reprint', { saleId: body.saleId, kind: 'receipt', reason: 'Guest asked' }),
    );
    const jobs = (copy.result as { jobs: Array<{ kind: string; status: string }> }).jobs;
    assert.deepEqual(jobs.map((j) => [j.kind, j.status]), [['receipt', 'printed']]);
    assert.equal(receipts(box), before + 1);
    const logged = await box.agent.sales()!.recorded(body.saleId);
    assert.equal(logged!.jobs.filter((j) => j.copy).length, 1, 'the copy is in the print log');
    await assert.rejects(
      box.bridge.intent(STATION_ID, box.caller, intent('sale.reprint', { saleId: uuidv7(), kind: 'receipt' })),
      (err: unknown) => err instanceof BridgeError && err.code === 'REPRINT_NOT_ON_THIS_BOX',
    );
  } finally {
    box.close();
  }
});

test('a card on the counter’s own terminal closes the sale with what the terminal said', async () => {
  const box = await openSellingBox();
  try {
    const { total, body } = await ticketSale(box);
    const answer = await send(box, 'payment.start', {
      ...body,
      tender: { actionId: 'card-press', method: 'card', kind: 'card', amountSatang: total },
    });
    assert.equal(answer.finalised, true);
    assert.equal(answer.attempt?.status, 'approved');
    assert.equal(answer.attempt?.provider, 'ghl');
    assert.ok(answer.attempt?.approvalCode, 'the approval code the terminal printed');
    assert.equal(answer.drawer, 'not_asked', 'a card leaves the drawer shut');
    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 5, maxBytes: 1_000_000, now: new Date().toISOString() });
    const tender = (batch.events[0]!.payload as { tenders: Array<Record<string, unknown>> }).tenders[0]!;
    assert.equal(tender.kind, 'card');
    assert.equal(tender.deviceId, CARD);
    assert.equal(tender.status, 'approved');
    assert.ok(tender.approvalCode);
  } finally {
    box.close();
  }
});

test('the PAX QR closes the sale flagged awaiting settlement; with no terminal QR, a QR is the 2C2P one and is refused', async () => {
  const box = await openSellingBox();
  try {
    const { total, body } = await ticketSale(box);
    const answer = await send(box, 'payment.start', {
      ...body,
      tender: { actionId: 'qr-press', method: 'promptpay', kind: 'qr', amountSatang: total },
    });
    assert.equal(answer.finalised, true);
    assert.equal(answer.attempt?.status, 'awaiting_settlement');
    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 5, maxBytes: 1_000_000, now: new Date().toISOString() });
    const tender = (batch.events[0]!.payload as { tenders: Array<Record<string, unknown>> }).tenders[0]!;
    assert.equal(tender.status, 'awaiting_settlement');
    assert.equal(tender.provider, 'digio');
  } finally {
    box.close();
  }
  const bare = await openSellingBox({ terminals: 'card' });
  try {
    const { total, body } = await ticketSale(bare);
    await assert.rejects(
      send(bare, 'payment.start', { ...body, tender: { actionId: 'qr', method: 'promptpay', kind: 'qr', amountSatang: total } }),
      (err: unknown) => err instanceof BridgeError && err.code === BOX_LANE_REFUSALS.qr2c2p.code,
    );
  } finally {
    bare.close();
  }
});

test('OD-3: a GHL card with no answer is held, never charged twice, and closed by staff with the typed approval code', async () => {
  const box = await openSellingBox();
  try {
    box.agent.terminal()!.setOutcome(CARD, 'no_response');
    const { total, body } = await ticketSale(box);
    const start = { ...body, tender: { actionId: 'card-press', method: 'card', kind: 'card', amountSatang: total } };
    const held = await send(box, 'payment.start', start);
    assert.equal(held.finalised, false);
    assert.equal(held.attempt?.status, 'awaiting_staff_confirmation');
    assert.equal(held.attempt?.inquirySupported, false);
    const requests = () =>
      box.agent.terminal()!.events(CARD).filter((e) => e.kind === 'request').length;
    const sent = requests();

    // Asking again sends nothing to the terminal: no replacement charge after an unknown outcome.
    const again = await send(box, 'payment.start', start);
    assert.equal(again.attempt?.id, held.attempt?.id);
    assert.equal(requests(), sent);
    const status = await send(box, 'payment.status', { saleId: body.saleId, attemptId: held.attempt!.id });
    assert.equal(status.attempt?.status, 'awaiting_staff_confirmation');

    // A confirmation without the code is refused.
    await assert.rejects(
      send(box, 'payment.confirm', { saleId: body.saleId, attemptId: held.attempt!.id, took: true }),
      (err: unknown) => err instanceof BridgeError && err.code === 'VALIDATION',
    );
    const confirmed = await send(box, 'payment.confirm', {
      saleId: body.saleId,
      attemptId: held.attempt!.id,
      took: true,
      approvalCode: '654321',
      last4: '4242',
    });
    assert.equal(confirmed.finalised, true);
    assert.equal(confirmed.sale.receiptNumber, 'T1-000043');
    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 5, maxBytes: 1_000_000, now: new Date().toISOString() });
    const tender = (batch.events[0]!.payload as { tenders: Array<Record<string, unknown>> }).tenders[0]!;
    assert.equal(tender.approvalCode, '654321');
    assert.deepEqual(
      { accountId: (tender.staffConfirmation as { accountId: string }).accountId, code: (tender.staffConfirmation as { approvalCode: string }).approvalCode },
      { accountId: ACCOUNT, code: '654321' },
    );
  } finally {
    box.close();
  }
});

/** The tender the box wrote down for a sale, as it sits on disk. */
async function heldOnDisk(box: SellingBox, saleId: string): Promise<{ attemptId: string; status: string; terminalRef: string | null }> {
  const raw = await box.harness.store.readRuntimeValue(BOX_ID, `terminal_tender:${saleId}`);
  assert.ok(raw, 'the terminal write-ahead is on disk');
  return JSON.parse(raw) as { attemptId: string; status: string; terminalRef: string | null };
}

/**
 * The power going mid-exchange, as the bridge sees it: the write-ahead is on
 * disk and the terminal's answer never comes back. A process that restarts
 * holds no exchange for the sale, which is what the next call finds.
 */
function powerCutOn(box: SellingBox, mode: 'sale' | 'inquire'): () => void {
  const terminals = box.agent.terminal()!;
  const real = terminals.runCommand.bind(terminals);
  terminals.runCommand = async (payload, opts) => {
    if (payload.mode === mode) throw new Error(`the power went mid-${mode}`);
    return real(payload, opts);
  };
  return () => {
    terminals.runCommand = real;
  };
}

test('a tender left at sent_to_terminal by a power cut is set down for a person to confirm, and the terminal is sent nothing again', async () => {
  const box = await openSellingBox();
  try {
    const { total, body } = await ticketSale(box);
    const start = { ...body, tender: { actionId: 'card-press', method: 'card', kind: 'card', amountSatang: total } };
    const restore = powerCutOn(box, 'sale');
    await assert.rejects(send(box, 'payment.start', start), /the power went mid-sale/);
    restore();
    const left = await heldOnDisk(box, body.saleId);
    assert.equal(left.status, 'sent_to_terminal', 'the write-ahead is all that is left');
    const requests = () =>
      box.agent.terminal()!.events(CARD).filter((e) => e.kind === 'request').length;
    const sent = requests();

    // Every call that used to echo `sent_to_terminal` now reads a tender a person can resolve.
    const status = await send(box, 'payment.status', { saleId: body.saleId, attemptId: left.attemptId });
    assert.equal(status.attempt?.status, 'awaiting_staff_confirmation');
    assert.equal(status.attempt?.inquirySupported, false);
    assert.equal((await heldOnDisk(box, body.saleId)).status, 'awaiting_staff_confirmation', 'and it is written down');
    const again = await send(box, 'payment.start', start);
    assert.equal(again.attempt?.id, left.attemptId, 'the same tender, not a second charge');
    assert.equal(again.finalised, false);
    const inquired = await send(box, 'payment.inquire', { saleId: body.saleId, attemptId: left.attemptId });
    assert.equal(inquired.attempt?.status, 'awaiting_staff_confirmation', 'a GHL card cannot be asked');
    // Cash on top is refused while the card may have taken the money, as online.
    await assert.rejects(
      send(box, 'sale.finalise', body),
      (err: unknown) => err instanceof BridgeError && err.code === 'PAYMENT_IN_FLIGHT',
    );

    const confirmed = await send(box, 'payment.confirm', {
      saleId: body.saleId,
      attemptId: left.attemptId,
      took: true,
      approvalCode: '112233',
    });
    assert.equal(confirmed.finalised, true);
    assert.equal(confirmed.sale.receiptNumber, 'T1-000043');
    assert.equal(requests(), sent, 'nothing more went to the terminal');
    assert.equal((await box.agent.outbox()!.depth()).queued, 1);
  } finally {
    box.close();
  }
});

test('a live exchange is not set down: the till asking while the terminal works is told where it stands, and one charge is sent', async () => {
  const box = await openSellingBox();
  try {
    const terminals = box.agent.terminal()!;
    const real = terminals.runCommand.bind(terminals);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    terminals.runCommand = async (payload, opts) => {
      await gate; // the guest is still tapping the card
      return real(payload, opts);
    };
    const requests = () => terminals.events(CARD).filter((e) => e.kind === 'request').length;
    const { total, body } = await ticketSale(box);
    const start = { ...body, tender: { actionId: 'card-press', method: 'card', kind: 'card', amountSatang: total } };
    const first = send(box, 'payment.start', start);
    let left: { attemptId: string; status: string } | null = null;
    for (let i = 0; i < 200 && !left; i++) {
      const raw = await box.harness.store.readRuntimeValue(BOX_ID, `terminal_tender:${body.saleId}`);
      if (raw) left = JSON.parse(raw) as { attemptId: string; status: string };
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(left?.status, 'sent_to_terminal');

    const pressedAgain = await send(box, 'payment.start', start);
    assert.equal(pressedAgain.finalised, false);
    assert.equal(pressedAgain.attempt?.status, 'sent_to_terminal', 'read, never set down');
    const polled = await send(box, 'payment.status', { saleId: body.saleId, attemptId: left!.attemptId });
    assert.equal(polled.attempt?.status, 'sent_to_terminal');
    await assert.rejects(
      send(box, 'sale.finalise', body),
      (err: unknown) => err instanceof BridgeError && err.code === 'PAYMENT_IN_FLIGHT',
    );

    open();
    const answered = await first;
    terminals.runCommand = real;
    assert.equal(answered.finalised, true);
    assert.equal(answered.attempt?.status, 'approved');
    assert.equal(requests(), 1, 'one charge went to the terminal');
    const after = await send(box, 'payment.status', { saleId: body.saleId, attemptId: left!.attemptId });
    assert.equal(after.finalised, true);
    assert.equal(after.sale.receiptNumber, answered.sale.receiptNumber);
    assert.equal((await box.agent.outbox()!.depth()).queued, 1);
  } finally {
    box.close();
  }
});

test('a Digio tender cut off mid-exchange: with no reference a person confirms it; cut off mid-inquiry it is asked again', async () => {
  const box = await openSellingBox();
  try {
    // The QR request went and its reference never came back: nothing to ask the terminal by.
    const first = await ticketSale(box);
    const qr = { actionId: 'qr-press', method: 'promptpay', kind: 'qr', amountSatang: first.total };
    let restore = powerCutOn(box, 'sale');
    await assert.rejects(send(box, 'payment.start', { ...first.body, tender: qr }), /the power went mid-sale/);
    restore();
    const noRef = await heldOnDisk(box, first.body.saleId);
    assert.equal(noRef.terminalRef, null);
    const read = await send(box, 'payment.status', { saleId: first.body.saleId, attemptId: noRef.attemptId });
    assert.equal(read.attempt?.status, 'awaiting_staff_confirmation');
    const declined = await send(box, 'payment.confirm', {
      saleId: first.body.saleId,
      attemptId: noRef.attemptId,
      took: false,
    });
    assert.equal(declined.attempt?.status, 'declined');

    // No answer to the QR, then the power goes while the terminal is being asked about it.
    const second = await ticketSale(box);
    box.agent.terminal()!.setOutcome(PAX, 'no_response');
    const held = await send(box, 'payment.start', {
      ...second.body,
      tender: { ...qr, amountSatang: second.total },
    });
    assert.equal(held.attempt?.status, 'unknown');
    assert.equal(held.attempt?.inquirySupported, true);
    box.agent.terminal()!.setOutcome(PAX, 'approved');
    restore = powerCutOn(box, 'inquire');
    await assert.rejects(
      send(box, 'payment.inquire', { saleId: second.body.saleId, attemptId: held.attempt!.id }),
      /the power went mid-inquire/,
    );
    restore();
    assert.equal((await heldOnDisk(box, second.body.saleId)).status, 'inquiring');
    const status = await send(box, 'payment.status', { saleId: second.body.saleId, attemptId: held.attempt!.id });
    assert.equal(status.attempt?.status, 'unknown', 'askable again');
    const asked = await send(box, 'payment.inquire', { saleId: second.body.saleId, attemptId: held.attempt!.id });
    assert.equal(asked.attempt?.status, 'not_found', 'the terminal never took it');
    assert.equal(asked.finalised, false);
    assert.equal((await box.agent.outbox()!.depth()).queued, 0, 'nothing recorded');
  } finally {
    box.close();
  }
});

test('a card the terminal approved is never charged again when its sale was not written: the retry closes it with that tender', async () => {
  const box = await openSellingBox();
  try {
    const requests = () =>
      box.agent.terminal()!.events(CARD).filter((e) => e.kind === 'request').length;
    const { total, body } = await ticketSale(box);
    const start = { ...body, tender: { actionId: 'card-press', method: 'card', kind: 'card', amountSatang: total } };
    box.crash.at = 'after_receipt';
    await assert.rejects(send(box, 'payment.start', start), /the power went at after_receipt/);
    assert.equal(requests(), 1);
    const approved = await heldOnDisk(box, body.saleId);
    assert.equal(approved.status, 'approved');
    assert.equal((await box.agent.outbox()!.depth()).queued, 0, 'no sale was written');

    const retried = await send(box, 'payment.start', start);
    assert.equal(requests(), 1, 'the terminal was not asked to charge the card again');
    assert.equal(retried.finalised, true);
    assert.equal(retried.attempt?.id, approved.attemptId);
    assert.equal(retried.attempt?.status, 'approved');
    assert.equal(retried.sale.receiptNumber, 'T1-000043', 'the number the lost attempt never spent');
    assert.equal(retried.drawer, 'not_asked');
    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 5, maxBytes: 1_000_000, now: new Date().toISOString() });
    assert.equal(batch.events.length, 1, 'one sale, one tender');
    const tenders = (batch.events[0]!.payload as { tenders: Array<Record<string, unknown>> }).tenders;
    assert.equal(tenders.length, 1);
    assert.equal(tenders[0]!.kind, 'card');
    assert.equal(tenders[0]!.deviceId, CARD);

    // The same, answered by a status read, and by cash pressed on top: both close with the card.
    for (const via of ['payment.status', 'sale.finalise'] as const) {
      const next = await ticketSale(box);
      const press = { ...next.body, tender: { actionId: `card-${via}`, method: 'card', kind: 'card', amountSatang: next.total } };
      box.crash.at = 'after_fact';
      await assert.rejects(send(box, 'payment.start', press), /the power went/);
      const before = requests();
      const held = await heldOnDisk(box, next.body.saleId);
      const closed =
        via === 'payment.status'
          ? await send(box, via, { saleId: next.body.saleId, attemptId: held.attemptId })
          : await send(box, via, next.body);
      assert.equal(closed.finalised, true, via);
      assert.equal(closed.attempt?.id, held.attemptId, via);
      assert.equal(closed.attempt?.provider, 'ghl', `${via} closes with the card, not cash`);
      assert.equal(closed.drawer, 'not_asked', `${via} opens no drawer`);
      assert.equal(requests(), before, `${via} sends the terminal nothing`);
    }
  } finally {
    box.close();
  }
});

test('a staff-confirmed card whose sale was not written closes on the retry, still named on who confirmed it', async () => {
  const box = await openSellingBox();
  try {
    box.agent.terminal()!.setOutcome(CARD, 'no_response');
    const { total, body } = await ticketSale(box);
    const held = await send(box, 'payment.start', {
      ...body,
      tender: { actionId: 'card-press', method: 'card', kind: 'card', amountSatang: total },
    });
    const confirm = {
      saleId: body.saleId,
      attemptId: held.attempt!.id,
      took: true,
      approvalCode: '654321',
      note: 'read off the terminal',
    };
    box.crash.at = 'after_log';
    await assert.rejects(send(box, 'payment.confirm', confirm), /the power went at after_log/);
    const confirmed = await send(box, 'payment.confirm', confirm);
    assert.equal(confirmed.finalised, true);
    assert.equal(confirmed.sale.receiptNumber, 'T1-000043');
    const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 5, maxBytes: 1_000_000, now: new Date().toISOString() });
    assert.equal(batch.events.length, 1);
    const tender = (batch.events[0]!.payload as { tenders: Array<Record<string, unknown>> }).tenders[0]!;
    const staff = tender.staffConfirmation as { accountId: string; approvalCode: string; note?: string };
    assert.deepEqual(
      { accountId: staff.accountId, code: staff.approvalCode, note: staff.note, approvalCode: tender.approvalCode },
      { accountId: ACCOUNT, code: '654321', note: 'read off the terminal', approvalCode: '654321' },
    );
  } finally {
    box.close();
  }
});

test('a card declined on the terminal leaves the sale open and nothing numbered', async () => {
  const box = await openSellingBox();
  try {
    box.agent.terminal()!.setOutcome(CARD, 'declined');
    const { total, body } = await ticketSale(box);
    const answer = await send(box, 'payment.start', {
      ...body,
      tender: { actionId: 'card-press', method: 'card', kind: 'card', amountSatang: total },
    });
    assert.equal(answer.finalised, false);
    assert.equal(answer.attempt?.status, 'declined');
    assert.equal(answer.sale.receiptNumber, null);
    assert.equal((await box.agent.outbox()!.depth()).queued, 0);
    // Cash then closes it, under the number the decline never spent.
    const cash = await send(box, 'sale.finalise', body);
    assert.equal(cash.sale.receiptNumber, 'T1-000043');
  } finally {
    box.close();
  }
});

test('the paper in the sale log is kept for the trading day it is for, and a late print of an older sale is still refused', async () => {
  const box = await openSellingBox();
  try {
    const first = await ticketSale(box);
    await send(box, 'sale.finalise', first.body);
    // Put the first sale on an earlier trading day, as a box running overnight finds it.
    await box.harness.store.writeRuntimeValue(
      BOX_ID,
      'sale_log_index',
      JSON.stringify([{ saleId: first.body.saleId, businessDate: '2000-01-01' }]),
    );
    await send(box, 'sale.finalise', (await ticketSale(box)).body);
    const retired = await box.agent.sales()!.recorded(first.body.saleId);
    assert.equal(retired!.snapshot, null, 'names and allergy lines are gone');
    assert.ok(retired!.bands.every((b) => b.code === ''), 'and so are the bands’ signed codes');
    assert.equal(retired!.receipt.number, 'T1-000043', 'the number it printed is kept');
    await assert.rejects(
      box.bridge.intent(STATION_ID, box.caller, intent('sale.reprint', { saleId: first.body.saleId, kind: 'receipt' })),
      (err: unknown) => err instanceof BridgeError && err.code === 'REPRINT_NOT_TODAY',
    );
  } finally {
    box.close();
  }
});
