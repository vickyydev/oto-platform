import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHECKIN_FACTS, DEFAULT_DROP_OFF_PRICING, DEFAULT_SUPERVISION_POLICY } from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { CachedBundle } from '../src/store';
import { BOX_ID, BRANCH_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * SCRUM-494 (REGISTER 6) — THE PAID SERVICE ON THE BOX LANE.
 *
 * The till sends each "Check in now" entry with the service its paid cart
 * line carried (the Drop-Off / Nanny switch). With the link down the box
 * applies it as the platform's `checkInNow` does: the nanny check runs against
 * the paid service before anything is written, a drop-off stay carries no
 * nanny, and the `checkin.updated` fact carries the service to the platform.
 */

const KEY = 'park-band-key-for-the-s494-checkin-test';
const ACCOUNT = '018f0000-0000-7000-8000-0000000000a1';
const PACKAGE = '018f0000-0000-7000-8000-00000000aa01';
const NANNY = '018f0000-0000-7000-8000-00000000ee01';
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
        prices: { tourist: { weekday: 35000, weekend: 45000 } },
        adultRules: null,
        hours: 2,
        durationLabel: '2 Hours',
      },
    ],
    categories: [],
    products: [],
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

function checkinItem(now = new Date()) {
  return {
    version: 'ck-v1',
    generatedAt: now.toISOString(),
    branchId: BRANCH_ID,
    config: { policy: DEFAULT_SUPERVISION_POLICY, pricing: DEFAULT_DROP_OFF_PRICING, photoRetentionDays: 30 },
    nannies: [
      {
        id: NANNY,
        name: 'Aor',
        shifts: [{ startsAt: new Date(now.getTime() - 3_600_000).toISOString(), endsAt: new Date(now.getTime() + 3_600_000).toISOString() }],
      },
    ],
    families: [],
    releases: [],
  };
}

interface Box {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  till: BridgeTillCaller;
  close(): void;
}

async function openBox(): Promise<Box> {
  const cloud = fakeBoxCloud(tillBundle());
  const harness = openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({
      boxId: BOX_ID,
      secret: 's494-checkin-test-secret',
      syncPrivateKeyPem: harness.keys.privateKeyPem,
    }),
    fetch: cloud.fetch,
    log: quiet,
    store: harness.store,
    printing: { retryDelayMs: 0, durable: true },
    booth: { enabled: false },
    terminal: { enabled: false },
    bands: { key: () => KEY },
    photos: { enabled: true, memory: true },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const write = async (scope: CachedBundle['scope'], items: unknown[]) => {
    await harness.store.writeBundle(BOX_ID, { scope, schemaVersion: 1, cursorSeq: 0, payload: { items }, appliedAt: new Date().toISOString() });
  };
  await write('catalogue', [catalogueItem()]);
  await write('receipt_series', [{ stationId: STATION_ID, prefix: 'T1', highWaterMark: 42 }]);
  await write('members', []);
  await write('checkin', [checkinItem()]);
  const till: BridgeTillCaller = { kind: 'till', accountId: ACCOUNT, can: () => true, method: 'offline_token', offlineFresh: false, jti: null };
  return {
    agent,
    harness,
    bridge: agent.bridge()!,
    till,
    close() {
      agent.stop();
      harness.close();
    },
  };
}

async function ask(box: Box, type: string, payload: Record<string, unknown>) {
  const answer = await box.bridge.intent(STATION_ID, box.till, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `t-${uuidv7().slice(-12)}`,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads deep into each answer's shape (quote.totals, children[0])
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

async function updatedFacts(box: Box) {
  const now = new Date().toISOString();
  const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 100, maxBytes: 5_000_000, now });
  if (batch.events.length > 0) {
    await box.harness.store.releaseBatch(
      BOX_ID,
      batch.events.map((e) => e.eventId),
      { errorCode: 'TEST_READ', errorMessage: 'read by the test', retryAt: now },
    );
  }
  return batch.events
    .filter((e) => e.type === CHECKIN_FACTS.updated)
    .map((e) => e.payload as { event?: string; service?: string | null; nannyId?: string | null });
}

const ALL = DEFAULT_SUPERVISION_POLICY.confirmations.map((c) => c.id);

/** Register one child on `service`, pay on the box, return the ids. */
async function registeredAndPaid(box: Box, child: { name: string; ageYears: number; service: 'drop_off' | 'nanny'; allergies?: string }) {
  const checkinId = uuidv7();
  await ask(box, 'checkin.create', {
    registrationId: uuidv7(),
    guardianName: 'Ploy',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL,
    children: [{ checkinId, ...child }],
  });
  const cart = {
    lines: [{ id: checkinId, packageId: PACKAGE, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } }],
  };
  const quote = await ask(box, 'cart.quote', cart);
  const gross = quote.quote.totals.grossSatang as number;
  const saleId = uuidv7();
  await ask(box, 'sale.finalise', {
    saleId,
    actionId: `pay-${saleId.slice(-8)}`,
    cart: { ...cart, expectedTotalSatang: gross },
    tender: { actionId: `cash-${saleId.slice(-8)}`, method: 'cash', kind: 'cash', amountSatang: gross },
  });
  return { checkinId, saleId };
}

test('s498 — the food scan reads a child checked in on this box offline, with the counter’s corrections', async () => {
  const box = await openBox();
  try {
    const { checkinId, saleId } = await registeredAndPaid(box, {
      name: 'Mint', ageYears: 6, service: 'drop_off', allergies: 'Peanuts',
    });
    const checkedIn = await ask(box, 'checkin.update', {
      event: 'check_in_now', saleId, entries: [{ checkinId }],
    });
    const key = checkedIn.bands[0].shortCode as string;
    const read = await ask(box, 'checkin.band_food', { key });
    assert.deepEqual(Object.keys(read).sort(), ['cacheAppliedAt', 'stay']);
    assert.equal(read.stay.checkinId, checkinId);
    assert.equal(read.stay.allergiesMedical, 'Peanuts');
    assert.equal(read.stay.mayOrderFood, false);
    assert.equal((await ask(box, 'checkin.band_food', { key: 'T1-AAAAAA' })).stay, null);
    await ask(box, 'checkin.update', { event: 'edit', checkinId, fields: { allergies: 'Shellfish' } });
    assert.equal((await ask(box, 'checkin.band_food', { key })).stay.allergiesMedical, 'Shellfish',
      'a safety correction on the offline board reaches the food scan at once');
  } finally {
    box.close();
  }
});

test('s494-checkin box: a Drop-Off stay paid as Nanny needs a nanny on shift and goes in as nanny, and the fact carries the service', async () => {
  const box = await openBox();
  try {
    const { checkinId, saleId } = await registeredAndPaid(box, { name: 'Mint', ageYears: 6, service: 'drop_off' });

    const noNanny = await refusal(
      ask(box, 'checkin.update', { event: 'check_in_now', saleId, entries: [{ checkinId, service: 'nanny' }] }),
    );
    assert.equal(noNanny.code, 'NANNY_REQUIRED');
    assert.equal((await updatedFacts(box)).length, 0, 'a refusal writes nothing');
    const before = await ask(box, 'checkin.board', {});
    assert.equal(before.families[0].children[0].status, 'registered');

    const now = await ask(box, 'checkin.update', {
      event: 'check_in_now',
      saleId,
      entries: [{ checkinId, nannyId: NANNY, service: 'nanny' }],
    });
    assert.equal(now.children[0].service, 'nanny');
    assert.equal(now.children[0].nannyId, NANNY);
    const [fact] = await updatedFacts(box);
    assert.equal(fact!.event, 'check_in_now');
    assert.equal(fact!.service, 'nanny');
    assert.equal(fact!.nannyId, NANNY);
  } finally {
    box.close();
  }
});

test('s494-checkin box: a nanny-age stay paid as Drop-Off goes in as drop-off with no nanny instead of being refused', async () => {
  const box = await openBox();
  try {
    const { checkinId, saleId } = await registeredAndPaid(box, { name: 'Ton', ageYears: 3, service: 'nanny' });
    const now = await ask(box, 'checkin.update', {
      event: 'check_in_now',
      saleId,
      entries: [{ checkinId, service: 'drop_off' }],
    });
    assert.equal(now.children[0].status, 'in_park');
    assert.equal(now.children[0].service, 'drop_off');
    assert.equal(now.children[0].nannyId, null);
    const [fact] = await updatedFacts(box);
    assert.equal(fact!.service, 'drop_off');
    assert.equal(fact!.nannyId, null);
  } finally {
    box.close();
  }
});

test('s494-checkin box: an entry without a service keeps the stay’s own; an unknown service is refused', async () => {
  const box = await openBox();
  try {
    const { checkinId, saleId } = await registeredAndPaid(box, { name: 'Mint', ageYears: 6, service: 'drop_off' });
    const unknown = await refusal(
      ask(box, 'checkin.update', { event: 'check_in_now', saleId, entries: [{ checkinId, service: 'babysitter' }] }),
    );
    assert.equal(unknown.status, 400);
    const now = await ask(box, 'checkin.update', { event: 'check_in_now', saleId, entries: [{ checkinId }] });
    assert.equal(now.children[0].service, 'drop_off');
    const [fact] = await updatedFacts(box);
    assert.equal(fact!.service, 'drop_off');
  } finally {
    box.close();
  }
});
