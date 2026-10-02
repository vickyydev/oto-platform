import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BOX_CHECKIN_REFUSALS,
  CHECKIN_FACTS,
  DEFAULT_DROP_OFF_PRICING,
  DEFAULT_SUPERVISION_POLICY,
  OFFLINE_PHOTO_POLICY,
  childPhotosEnabled,
  prepaidPaidMismatchRefusal,
  verifyBandCode,
} from '@oto/shared';
import { createBoxAgent, type BoxAgent } from '../src/agent';
import { fsBlobStore, memoryBlobStore, type BlobStore } from '../src/blob-store';
import { memoryCredentialStore } from '../src/credentials';
import { createPhotoUploader } from '../src/photo-upload';
import { uuidv7 } from '../src/signing';
import { BridgeError, type BridgeTillCaller, type StationBridge } from '../src/station-bridge';
import type { BoxStore, CachedBundle } from '../src/store';
import { prepareSqliteBoxStore } from '../src/store-sqlite';
import { BOX_ID, BRANCH_ID, STATION_ID, fakeBoxCloud, openTestStore, tillBundle, type TestStore } from './_support';

/**
 * S2-13 ROUND 4 — CHECK-IN ON THE BOX LANE, ON THE PI'S OWN STORE.
 *
 * The real agent on a real SQLite store with nothing reachable: the gate's
 * registration, "Check in now" with its band minted and printed on the box,
 * the board, the release with its photo — each one store transaction, each
 * answered again from the box when pressed again. And the bounds: the photo
 * store's cap refuses capture in the counter's words before the disk
 * suffers, `CHILD_PHOTOS_ENABLED` off leaves no capture path at all, and a
 * Pi's card from before this round has its overlay table widened at boot
 * with nothing lost. The api suite (`apps/api/test/offline-checkin.test.ts`)
 * proves the facts reach the ledger once.
 */

const KEY = 'park-band-key-for-the-offline-checkin-test';
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

interface CheckinBox {
  agent: BoxAgent;
  harness: TestStore;
  bridge: StationBridge;
  till: BridgeTillCaller;
  photos: BlobStore | null;
  /** The process goes; the store stays. */
  restart(): Promise<void>;
  close(): void;
}

async function openCheckinBox(
  opts: { photosEnabled?: boolean; photoStore?: () => BlobStore; harness?: TestStore } = {},
): Promise<CheckinBox> {
  const cloud = fakeBoxCloud(tillBundle());
  const harness = opts.harness ?? openTestStore(new Date().toISOString());
  await harness.store.init(BOX_ID);
  const store = opts.photoStore?.() ?? memoryBlobStore();
  const make = () =>
    createBoxAgent({
      apiBaseUrl: 'http://cloud.test',
      credentials: memoryCredentialStore({
        boxId: BOX_ID,
        secret: 'offline-checkin-test-secret',
        syncPrivateKeyPem: harness.keys.privateKeyPem,
      }),
      fetch: cloud.fetch,
      log: quiet,
      store: harness.store,
      printing: { retryDelayMs: 0, durable: true },
      booth: { enabled: false },
      terminal: { enabled: false },
      bands: { key: () => KEY },
      photos: { enabled: opts.photosEnabled ?? true, memory: true },
    });
  let agent = make();
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
  const box: CheckinBox = {
    agent,
    harness,
    bridge: agent.bridge()!,
    till,
    photos: null,
    async restart() {
      agent.stop();
      agent = make();
      await agent.prepare();
      // The config bundle a Pi keeps on its card; here the fake cloud hands it back.
      await agent.syncConfig();
      box.agent = agent;
      box.bridge = agent.bridge()!;
      box.photos = agent.photoStore();
    },
    close() {
      agent.stop();
      harness.close();
    },
  };
  // A store of the test's choosing (a small cap, a real directory) replaces the agent's own.
  const bridge = box.bridge as unknown as { host: { blobs?: () => BlobStore | null } };
  if (opts.photoStore) bridge.host.blobs = () => store;
  box.photos = opts.photoStore ? store : agent.photoStore();
  return box;
}

const intent = (type: string, payload: Record<string, unknown>, actionId = `t-${uuidv7().slice(-12)}`) => ({
  type,
  lastSeenSequence: 0,
  payload,
  actionId,
});

async function ask(box: CheckinBox, type: string, payload: Record<string, unknown>) {
  const answer = await box.bridge.intent(STATION_ID, box.till, intent(type, payload));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads into each answer's shape
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

/** Every fact the box is holding, oldest first — read, then put straight back. */
async function facts(box: CheckinBox) {
  const now = new Date().toISOString();
  const batch = await box.harness.store.takeBatch(BOX_ID, { maxEvents: 100, maxBytes: 5_000_000, now });
  if (batch.events.length > 0) {
    await box.harness.store.releaseBatch(
      BOX_ID,
      batch.events.map((e) => e.eventId),
      { errorCode: 'TEST_READ', errorMessage: 'read by the test', retryAt: now },
    );
  }
  return batch.events;
}

function jpeg(seed: number, size = 6_000): string {
  const bytes = Buffer.alloc(size, seed);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

const ALL = DEFAULT_SUPERVISION_POLICY.confirmations.map((c) => c.id);

function registrationBody(over: Record<string, unknown> = {}) {
  return {
    registrationId: uuidv7(),
    guardianName: 'Ploy',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL,
    children: [{ checkinId: uuidv7(), name: 'Mint', ageYears: 6, service: 'drop_off' }],
    ...over,
  };
}

/** Register, pay on the box and return the ids — the gate and the till's payment. */
async function registeredAndPaid(box: CheckinBox, service: 'drop_off' | 'nanny' = 'drop_off') {
  const body = registrationBody({
    children: [{ checkinId: uuidv7(), name: service === 'nanny' ? 'Ton' : 'Mint', ageYears: service === 'nanny' ? 3 : 6, service }],
  });
  await ask(box, 'checkin.create', body);
  const checkinId = (body.children as Array<{ checkinId: string }>)[0]!.checkinId;
  const cart = {
    lines: [{ id: checkinId, packageId: PACKAGE, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } }],
  };
  const quote = await ask(box, 'cart.quote', cart);
  const gross = quote.quote.totals.grossSatang as number;
  const saleId = uuidv7();
  const paid = await ask(box, 'sale.finalise', {
    saleId,
    actionId: `pay-${saleId.slice(-8)}`,
    cart: { ...cart, expectedTotalSatang: gross },
    tender: { actionId: `cash-${saleId.slice(-8)}`, method: 'cash', kind: 'cash', amountSatang: gross },
  });
  return { registrationId: body.registrationId as string, checkinId, saleId, paid };
}

test('the gate on the box: one registration, its stays and its consent in one fact, answered again on a second press', async () => {
  const box = await openCheckinBox();
  try {
    const body = registrationBody();
    const first = await ask(box, 'checkin.create', body);
    assert.equal(first.registration.id, body.registrationId);
    assert.equal(first.registration.children[0].status, 'registered');
    const again = await ask(box, 'checkin.create', body);
    assert.equal(again.replayed, true);
    const held = (await facts(box)).filter((e) => e.type === CHECKIN_FACTS.created);
    assert.equal(held.length, 1, 'one fact however often it was pressed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads into the queued fact's shape
    const payload = held[0]!.payload as Record<string, any>;
    assert.equal(payload.guardianPhone, '+66812345678');
    assert.ok(payload.consentRecordedAt, 'the consent carries the box’s moment');
    assert.deepEqual(
      payload.acknowledgedConfirmations.map((c: { itemId: string }) => c.itemId).sort(),
      [...ALL].sort(),
    );
    const awaiting = await ask(box, 'checkin.awaiting', {});
    assert.deepEqual(awaiting.registrations.map((r: { id: string }) => r.id), [body.registrationId]);

    // The platform's refusals, in its words.
    const wrongService = await refusal(
      ask(box, 'checkin.create', registrationBody({ children: [{ checkinId: uuidv7(), name: 'Ben', ageYears: 6, service: 'nanny' }] })),
    );
    assert.equal(wrongService.code, 'SERVICE_MISMATCH');
    assert.match(wrongService.message, /Ben is 6 and needs drop-off, not a nanny/);
    const unticked = await refusal(ask(box, 'checkin.create', registrationBody({ acknowledgedConfirmationIds: [ALL[0]] })));
    assert.equal(unticked.code, 'CONFIRMATIONS_REQUIRED');
  } finally {
    box.close();
  }
});

test('s494 prepaid food at the box gate: every item starts unserved, and an amount paid that is not the items’ sum is refused in the platform’s words', async () => {
  const box = await openCheckinBox();
  try {
    const hotDog = { menuItemId: uuidv7(), menuItemName: 'Hot dog', unitSatang: 6_000 };
    const checkinId = uuidv7();
    const body = registrationBody({
      children: [
        {
          checkinId,
          name: 'Mint',
          ageYears: 6,
          service: 'drop_off',
          foodProvision: { mode: 'prepaid_items', paidSatang: 12_000, items: [{ ...hotDog, qty: 2, redeemedQty: 2 }] },
        },
      ],
    });
    await ask(box, 'checkin.create', body);
    const held = (await facts(box)).filter((e) => e.type === CHECKIN_FACTS.created);
    assert.equal(held.length, 1);
    const sent = (
      held[0]!.payload as { children: Array<{ foodProvision: { paidSatang: number; items: Array<{ qty: number; redeemedQty: number }> } }> }
    ).children[0]!.foodProvision;
    assert.equal(sent.paidSatang, 12_000);
    assert.deepEqual(
      sent.items.map((i: { qty: number; redeemedQty: number }) => [i.qty, i.redeemedQty]),
      [[2, 0]],
      'the fact the box queues carries every item unserved',
    );
    const awaiting = await ask(box, 'checkin.awaiting', {});
    const kept = awaiting.registrations[0].children.find((c: { id: string }) => c.id === checkinId);
    assert.deepEqual(
      kept.foodProvision.items.map((i: { redeemedQty: number }) => i.redeemedQty),
      [0],
      'the box’s own copy starts unserved too',
    );

    const mismatch = await refusal(
      ask(
        box,
        'checkin.create',
        registrationBody({
          children: [
            {
              checkinId: uuidv7(),
              name: 'Ben',
              ageYears: 6,
              service: 'drop_off',
              foodProvision: { mode: 'prepaid_items', paidSatang: 6_100, items: [{ ...hotDog, qty: 1 }] },
            },
          ],
        }),
      ),
    );
    assert.equal(mismatch.code, 'PREPAID_PAID_MISMATCH');
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.message, prepaidPaidMismatchRefusal('Ben', 6_000, 6_100));
    assert.equal(
      (await facts(box)).filter((e) => e.type === CHECKIN_FACTS.created).length,
      1,
      'the refused registration queued nothing',
    );
  } finally {
    box.close();
  }
});

test('payment on the box leaves the supervised band for check-in; "Check in now" mints it with the park’s key, prints it, and is answered again on a second press', async () => {
  const box = await openCheckinBox();
  try {
    const { checkinId, saleId, paid } = await registeredAndPaid(box);
    assert.deepEqual(paid.bands, [], 'finalisation leaves a drop-off child’s band alone, as online');

    const press = { event: 'check_in_now', saleId, entries: [{ checkinId }], staffName: 'Nok' };
    const now = await ask(box, 'checkin.update', press);
    assert.equal(now.replay, false);
    assert.equal(now.bands.length, 1);
    assert.match(now.bands[0].shortCode, /^T1-/);
    assert.deepEqual(now.printJobs.map((j: { kind: string }) => j.kind), ['kids_wristband']);
    const fact = (await facts(box)).find((e) => e.type === CHECKIN_FACTS.updated)!;
    const band = (fact.payload as { band: { id: string; code: string; cartLineId: string } }).band;
    assert.equal(band.cartLineId, checkinId);
    assert.ok(verifyBandCode(band.code, KEY).ok, 'a band the gate will admit');
    // The paper went to the kids band printer the station names.
    assert.ok(['printed', 'queued'].includes(now.printJobs[0].status), `the band was handed to its printer (${now.printJobs[0].status})`);

    const again = await ask(box, 'checkin.update', press);
    assert.equal(again.replay, true);
    assert.equal(again.bands[0].id, now.bands[0].id);
    assert.equal((await facts(box)).filter((e) => e.type === CHECKIN_FACTS.updated).length, 1);
  } finally {
    box.close();
  }
});

test('a double power cut inside "Check in now" leaves nothing half-landed; the third press checks the child in once', async () => {
  const box = await openCheckinBox();
  try {
    const { checkinId, saleId } = await registeredAndPaid(box);
    const store = box.harness.store as BoxStore & { atomically: BoxStore['atomically'] };
    const original = store.atomically.bind(store);
    let cuts = 2;
    store.atomically = (async (fn: (tx: BoxStore) => Promise<unknown>) =>
      original(async (tx) => {
        const result = await fn(tx);
        if (cuts > 0) {
          cuts -= 1;
          throw new Error('the power went before the commit');
        }
        return result;
      })) as BoxStore['atomically'];
    const press = { event: 'check_in_now', saleId, entries: [{ checkinId }] };
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(ask(box, 'checkin.update', press), /the power went/);
      assert.equal((await facts(box)).filter((e) => e.type === CHECKIN_FACTS.updated).length, 0);
      const board = await ask(box, 'checkin.board', {});
      assert.equal(board.families[0].children[0].status, 'registered');
      assert.equal(board.families[0].children[0].bandId, null);
    }
    store.atomically = original;
    await box.restart();
    const now = await ask(box, 'checkin.update', press);
    assert.equal(now.bands.length, 1);
    assert.equal((await facts(box)).filter((e) => e.type === CHECKIN_FACTS.updated).length, 1);
    const board = await ask(box, 'checkin.board', {});
    assert.equal(board.families[0].children[0].status, 'in_park');
    assert.equal(board.families[0].children[0].bandId, now.bands[0].id);
  } finally {
    box.close();
  }
});

test('the board on the box: a nanny must be on shift, edits are recorded, a release names its photo — and survives a restart', async () => {
  const box = await openCheckinBox();
  try {
    const { checkinId, saleId, registrationId } = await registeredAndPaid(box, 'nanny');
    const noNanny = await refusal(ask(box, 'checkin.update', { event: 'check_in_now', saleId, entries: [{ checkinId }] }));
    assert.equal(noNanny.code, 'NANNY_REQUIRED');
    assert.equal(noNanny.message, 'Assign a nanny to Ton before checking them in.');
    const offShift = await refusal(
      ask(box, 'checkin.update', { event: 'check_in_now', saleId, entries: [{ checkinId, nannyId: uuidv7() }] }),
    );
    assert.equal(offShift.code, 'NANNY_NOT_ON_ROSTER');
    const now = await ask(box, 'checkin.update', { event: 'check_in_now', saleId, entries: [{ checkinId, nannyId: NANNY }] });
    assert.equal(now.children[0].nannyId, NANNY);

    const edit = await ask(box, 'checkin.update', { event: 'edit', checkinId, fields: { allergies: 'Peanuts', bookedMinutes: 180 } });
    assert.equal(edit.changed, 2);
    const board = await ask(box, 'checkin.board', {});
    assert.equal(board.families[0].children[0].allergies, 'Peanuts');
    assert.equal(board.nannies[0].load, 1);

    await box.restart();
    const photoId = uuidv7();
    const photo = await ask(box, 'photo.capture', { photoId, registrationId, purpose: 'pickup', dataUrl: jpeg(5) });
    assert.equal(photo.pendingUpload, true);
    const releaseId = uuidv7();
    const released = await ask(box, 'release.create', { releaseId, checkinId, collector: { kind: 'dropper_off' }, pickupPhotoId: photoId });
    assert.equal(released.release.collectorName, 'Ploy');
    const fact = (await facts(box)).find((e) => e.type === CHECKIN_FACTS.release)!;
    assert.equal((fact.payload as { pickupPhotoId: string }).pickupPhotoId, photoId);
    const after = await ask(box, 'checkin.board', {});
    assert.equal(after.families[0].tab, 'out');
    assert.equal(after.nannies[0].load, 0, 'the release frees the nanny');
    // The photo's row is known to the upload worker.
    assert.deepEqual(await box.bridge.photoTarget(photoId), { kind: 'release', id: releaseId });
  } finally {
    box.close();
  }
});

test('CHILD_PHOTOS_ENABLED off: no capture path at all, and a release goes ahead without a photo', async () => {
  assert.equal(childPhotosEnabled(undefined), true, 'on unless switched off');
  assert.equal(childPhotosEnabled('false'), false);
  assert.equal(childPhotosEnabled('0'), false);
  const box = await openCheckinBox({ photosEnabled: false });
  try {
    const { checkinId, saleId, registrationId } = await registeredAndPaid(box);
    await ask(box, 'checkin.update', { event: 'check_in_now', saleId, entries: [{ checkinId }] });
    const capture = await refusal(ask(box, 'photo.capture', { photoId: uuidv7(), registrationId, purpose: 'pickup', dataUrl: jpeg(1) }));
    assert.equal(capture.code, BOX_CHECKIN_REFUSALS.photosOff.code);
    assert.equal(capture.message, BOX_CHECKIN_REFUSALS.photosOff.message);
    assert.deepEqual(await box.photos!.list(), []);
    const withPhoto = await refusal(
      ask(box, 'release.create', { releaseId: uuidv7(), checkinId, collector: { kind: 'dropper_off' }, pickupPhotoId: uuidv7() }),
    );
    assert.equal(withPhoto.code, BOX_CHECKIN_REFUSALS.photosOff.code);
    const released = await ask(box, 'release.create', { releaseId: uuidv7(), checkinId, collector: { kind: 'dropper_off' } });
    assert.equal(released.release.pickupPhotoFileId, null);
    const config = await ask(box, 'checkin.config', {});
    assert.equal(config.photosEnabled, false);
  } finally {
    box.close();
  }
});

test('the photo store’s cap refuses capture in plain words before the disk suffers', async () => {
  const small = memoryBlobStore({ limits: { capBytes: 10_000, maxPhotoBytes: 8_000 } });
  const box = await openCheckinBox({ photoStore: () => small });
  try {
    const registrationId = uuidv7();
    const first = await ask(box, 'photo.capture', { photoId: uuidv7(), registrationId, purpose: 'consent', dataUrl: jpeg(1, 6_000) });
    assert.equal(first.size, 6_000);
    const full = await refusal(ask(box, 'photo.capture', { photoId: uuidv7(), registrationId, purpose: 'pickup', dataUrl: jpeg(2, 6_000) }));
    assert.equal(full.status, 507);
    assert.equal(full.code, 'PHOTO_STORE_FULL');
    assert.equal(full.message, BOX_CHECKIN_REFUSALS.photoStoreFull.message);
    const big = await refusal(ask(box, 'photo.capture', { photoId: uuidv7(), registrationId, purpose: 'pickup', dataUrl: jpeg(3, 9_000) }));
    assert.equal(big.code, 'PHOTO_TOO_LARGE');
    const notImage = await refusal(
      ask(box, 'photo.capture', {
        photoId: uuidv7(),
        registrationId,
        purpose: 'pickup',
        dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.7 passport scan').toString('base64')}`,
      }),
    );
    assert.equal(notImage.code, 'PHOTO_NOT_AN_IMAGE', 'never a document');
    assert.equal((await small.usage()).count, 1);
  } finally {
    box.close();
  }

  // The card's own floor: a store with room, on a disk that has none.
  const lowDisk = memoryBlobStore({ freeBytes: () => OFFLINE_PHOTO_POLICY.minFreeBytes + 1_000 });
  await assert.rejects(
    lowDisk.put(
      { id: uuidv7(), registrationId: uuidv7(), purpose: 'pickup', contentType: 'image/jpeg', capturedAt: new Date().toISOString() },
      Buffer.from(jpeg(4, 6_000).split(',')[1]!, 'base64'),
    ),
    (err: Error & { reason?: string }) => err.reason === 'full',
  );
});

test('the upload worker links a photo exactly once through a crash after the presign, and waits for a row not filed yet', async () => {
  const store = memoryBlobStore();
  const photoId = uuidv7();
  const releaseId = uuidv7();
  await store.put(
    { id: photoId, registrationId: uuidv7(), purpose: 'pickup', contentType: 'image/jpeg', capturedAt: new Date().toISOString() },
    Buffer.from(jpeg(6).split(',')[1]!, 'base64'),
  );
  let filed = false;
  let linked: string | null = null;
  let links = 0;
  const puts: string[] = [];
  let crash: string | null = 'after_presign';
  let clock = Date.now();
  const uploader = createPhotoUploader({
    blobs: () => store,
    request: async <T,>(path: string) => {
      if (!filed) return { status: 409, body: { error: { code: 'PHOTO_TARGET_NOT_READY' } } as T };
      if (path.endsWith('/upload-url')) return { status: 200, body: { uploadUrl: `memory://${photoId}`, linked: linked === photoId } as T };
      if (linked === photoId) return { status: 200, body: { linked: true, replay: true } as T };
      linked = photoId;
      links += 1;
      return { status: 200, body: { linked: true, replay: false } as T };
    },
    put: async (url) => {
      puts.push(url);
      return 200;
    },
    target: async () => ({ kind: 'release', id: releaseId }),
    isOnline: () => true,
    now: () => new Date(clock),
    note: () => undefined,
    crashPoint: (point) => {
      if (crash === point) {
        crash = null;
        throw new Error(`power cut at ${point}`);
      }
    },
  });
  let tick = await uploader.tick();
  assert.equal(tick.waiting, 1, 'the row is not on the platform yet');
  filed = true;
  clock += 3_600_000;
  tick = await uploader.tick();
  assert.equal(tick.failed, 1, 'the power went after the presign');
  clock += 3_600_000;
  tick = await uploader.tick();
  assert.equal(tick.linked, 1);
  assert.equal(links, 1, 'linked exactly once');
  assert.equal(puts.length, 1);
  const meta = await store.get(photoId);
  assert.ok(meta?.linkedAt);
  assert.deepEqual(meta?.target, { kind: 'release', id: releaseId });
  // Another pass finds nothing to do.
  tick = await uploader.tick();
  assert.equal(tick.linked + tick.failed + tick.waiting, 0);
});

test('MEASURED: the photo store on a real disk — a week at the park’s volume against the cap', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oto-blob-measure-'));
  try {
    const store = fsBlobStore(dir);
    // A box-lane photo after the till's shrink (960 px, JPEG 0.7): ~60–140 KB.
    // 100 KB is the planning figure; 50 of them are written and measured.
    const PHOTO = 100 * 1024;
    const N = 50;
    for (let i = 0; i < N; i += 1) {
      await store.put(
        { id: uuidv7(), registrationId: uuidv7(), purpose: 'pickup', contentType: 'image/jpeg', capturedAt: new Date().toISOString() },
        Buffer.from(jpeg(i, PHOTO).split(',')[1]!, 'base64'),
      );
    }
    const onDisk = readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
    const perPhoto = onDisk / N;
    const usage = await store.usage();
    assert.equal(usage.count, N);
    assert.equal(usage.bytes, N * PHOTO);
    // The park's volume, generously: 150 supervised children a day, one sign-up
    // photo per family (~100 families), one pickup photo per child, ~10
    // collectors added on the spot — 260 photos a day.
    const perDay = 260;
    // Worst case held: a WHOLE WEEK offline (nothing uploads) plus the week a
    // photo is kept after its upload — fourteen days of photos at once.
    const worstDays = 14;
    const worstBytes = perPhoto * perDay * worstDays;
    t.diagnostic(
      `measured ${perPhoto.toFixed(0)} B/photo on disk (image + bookkeeping, ${((perPhoto - PHOTO) / 1).toFixed(0)} B overhead); ` +
        `${perDay} photos/day x ${worstDays} days = ${(worstBytes / 1024 / 1024).toFixed(0)} MiB worst case; ` +
        `cap ${OFFLINE_PHOTO_POLICY.capBytes / 1024 / 1024} MiB, disk floor ${OFFLINE_PHOTO_POLICY.minFreeBytes / 1024 / 1024} MiB`,
    );
    assert.ok(worstBytes < OFFLINE_PHOTO_POLICY.capBytes, 'a fortnight of photos fits under the cap');
    assert.ok(perPhoto - PHOTO < 1024, 'the bookkeeping costs under a kilobyte a photo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Pi’s card from before this round: its overlay table is widened at boot, nothing it held is lost', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table box_overlay (
    box_id text not null, kind text not null, entity_id text not null, member_id text, phone text,
    payload text not null, created_at text not null, updated_at text not null,
    primary key (box_id, kind, entity_id),
    check (kind in ('member', 'child', 'visit'))
  )`);
  db.prepare(`insert into box_overlay values (?, 'member', ?, ?, '+66811111111', '{}', 'a', 'a')`).run(BOX_ID, 'm1', 'm1');
  assert.throws(() =>
    db.prepare(`insert into box_overlay values (?, 'checkin', 'c0', 'r0', null, '{}', 'a', 'a')`).run(BOX_ID),
  );
  prepareSqliteBoxStore(db);
  const rows = (db.prepare('select kind, entity_id from box_overlay').all() as Array<{ kind: string; entity_id: string }>).map(
    (r) => ({ kind: r.kind, entity_id: r.entity_id }),
  );
  assert.deepEqual(rows, [{ kind: 'member', entity_id: 'm1' }]);
  db.prepare(`insert into box_overlay values (?, 'checkin', 'c1', 'r1', null, '{}', 'a', 'a')`).run(BOX_ID);
  // Booting again changes nothing.
  prepareSqliteBoxStore(db);
  assert.equal((db.prepare('select count(*) as n from box_overlay').all()[0] as { n: number }).n, 2);
  db.close();
});
