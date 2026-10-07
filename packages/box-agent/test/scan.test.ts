import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { BAND_CODE_ALPHABET, bandShortCode, mintBandCode, ulidFromUuid } from '@oto/shared';

import {
  BAND_CODE_HANDLER,
  BAND_CODE_MALFORMED,
  BAND_KEY_INVALID,
  BAND_KEY_MISSING,
  BAND_SHORT_CODE,
  BAND_SIGNATURE_INVALID,
  ScanRouter,
  UNKNOWN_BARCODE,
  isBandCodeCandidate,
  isProductBarcode,
  productBarcodeHandler,
  scanFingerprint,
  scanPrefix,
  stationSourceForScan,
} from '../src/scan';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { StationScanMessage } from '../src/contract';
import { BOX_ID, STATION_ID, fakeBoxCloud, openTestAgent, tillBundle } from './_support';

/**
 * The scanning service (S2-06).
 *
 * The two things worth proving are the two the design turns on: a code goes to
 * whichever handler claimed it and to no other, and the CODE ITSELF never
 * reaches the tape. The second is not a nicety — a band code is a gate
 * credential and the tape is a thirty-day table with a Console page over it.
 */

function open(): { store: SqlBoxStore; db: DatabaseSync; close(): void } {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  return { store, db, close: () => db.close() };
}

function events(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('select * from station_event order by received_at').all() as Array<
    Record<string, unknown>
  >;
}

test('a code with no handler resolves unhandled, and says so', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  const result = await router.deliver(STATION_ID, { code: 'T1-01J8ZQ4F7K', source: 'box_serial' });
  assert.equal(result.accepted, true);
  assert.equal(result.kind, 'unknown');
  assert.equal(result.outcome, 'unhandled');
  assert.equal(result.handler, null);
  t.close();
});

test('the tape gets a fingerprint and never the code', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  const code = 'T1-01J8ZQ4F7KSECRETBAND';
  await router.deliver(STATION_ID, { code, source: 'box_hid', actionId: 'act-12345678' });

  const [row] = events(t.db);
  assert.ok(row, 'a scan writes one line on the station tape');
  assert.equal(row!.kind, 'scan');
  // A box-attached scanner is recorded as `box`; the hardware source lives in
  // the payload, because `station_event.source` is a CHECK over screens.
  assert.equal(row!.source, 'box');
  assert.equal(row!.action_id, 'act-12345678');

  const payload = JSON.parse(String(row!.payload)) as Record<string, unknown>;
  assert.equal(payload.codeFingerprint, createHash('sha256').update(code).digest('hex').slice(0, 16));
  assert.equal(payload.codeLength, code.length);
  assert.equal(payload.codePrefix, 'T1');
  assert.equal(payload.source, 'box_hid');
  assert.equal(payload.outcome, 'unhandled');

  const whole = JSON.stringify(row);
  assert.equal(whole.includes(code), false, 'the raw code must not appear anywhere on the row');
  assert.equal(
    whole.includes('SECRETBAND'),
    false,
    'nor any recognisable part of it',
  );
  t.close();
});

test('the first handler that claims a code gets it, and only that one', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  const seen: string[] = [];
  router.register({
    name: 'bookings',
    kind: 'booking',
    matches: (code) => code.startsWith('BK'),
    handle: () => {
      seen.push('bookings');
      return { outcome: 'handled' as const, detail: { bookingId: 'b1' } };
    },
  });
  router.register({
    name: 'bands',
    kind: 'band',
    matches: (code) => code.startsWith('T'),
    handle: () => {
      seen.push('bands');
    },
  });

  const booking = await router.deliver(STATION_ID, { code: 'BK-999', source: 'camera' });
  assert.equal(booking.handler, 'bookings');
  assert.equal(booking.kind, 'booking');
  assert.equal(booking.outcome, 'handled');
  assert.deepEqual(booking.detail, { bookingId: 'b1' });

  const band = await router.deliver(STATION_ID, { code: 'T1-abc', source: 'camera' });
  assert.equal(band.handler, 'bands');
  // A handler that claimed the code and returned nothing HANDLED it.
  assert.equal(band.outcome, 'handled');
  assert.deepEqual(seen, ['bookings', 'bands']);
  t.close();
});

test('a handler that throws is an error outcome, not an exception at the counter', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  router.register({
    name: 'broken',
    kind: 'band',
    matches: () => true,
    handle: () => {
      throw new Error('the database went away');
    },
  });
  const result = await router.deliver(STATION_ID, { code: 'T1-abc', source: 'camera' });
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorCode, 'SCAN_HANDLER_FAILED');
  const payload = JSON.parse(String(events(t.db)[0]!.payload)) as Record<string, unknown>;
  assert.equal(payload.errorCode, 'SCAN_HANDLER_FAILED');
  // And the message — which quoted the failure — is nowhere on the row.
  assert.equal(JSON.stringify(events(t.db)[0]).includes('database went away'), false);
  t.close();
});

test('a matcher that throws does not stop the next handler reading the code', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  router.register({
    name: 'broken-matcher',
    kind: 'voucher',
    matches: () => {
      throw new Error('bad regex');
    },
    handle: () => ({ outcome: 'handled' as const }),
  });
  router.register({
    name: 'bands',
    kind: 'band',
    matches: () => true,
    handle: () => ({ outcome: 'handled' as const }),
  });
  const result = await router.deliver(STATION_ID, { code: 'T1-abc', source: 'box_serial' });
  assert.equal(result.handler, 'bands');
  t.close();
});

test('an empty code is refused rather than handled', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  const result = await router.deliver(STATION_ID, { code: '   ', source: 'manual' });
  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'SCAN_EMPTY');
  t.close();
});

test('the screens are told, by fingerprint', async () => {
  const t = open();
  const published: StationScanMessage[] = [];
  const router = new ScanRouter({
    boxId: BOX_ID,
    store: t.store,
    publish: (_stationId, message) => published.push(message),
  });
  const code = 'T1-01J8ZQ4F7K';
  await router.deliver(STATION_ID, { code, source: 'simulator', actionId: 'act-87654321' });
  assert.equal(published.length, 1);
  assert.equal(published[0]?.kind, 'scan');
  assert.equal(published[0]?.codeFingerprint, scanFingerprint(code));
  assert.equal(published[0]?.actionId, 'act-87654321');
  assert.equal(JSON.stringify(published).includes(code), false);
  t.close();
});

test('a scan whose tape line cannot be written is still a scan', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  // The tape is telemetry. A counter must not be told its scan failed because
  // a log row could not be written.
  const broken = {
    ...t.store,
    recordStationEvent: async () => {
      throw new Error('disk full');
    },
  } as unknown as SqlBoxStore;
  const router2 = new ScanRouter({ boxId: BOX_ID, store: broken });
  void router;
  const result = await router2.deliver(STATION_ID, { code: 'T1-abc123', source: 'box_hid' });
  assert.equal(result.accepted, true);
  t.close();
});

test('the small helpers say what they claim', () => {
  assert.equal(scanFingerprint('abc').length, 16);
  assert.equal(scanPrefix('T1-01J8'), 'T1');
  assert.equal(scanPrefix('01J8ZQ'), undefined);
  assert.equal(stationSourceForScan('box_hid'), 'box');
  assert.equal(stationSourceForScan('simulator'), 'box');
  assert.equal(stationSourceForScan('camera', 'kiosk'), 'kiosk');
});

// --- The product barcode handler (S2-09b) -----------------------------------
//
// The box's half of "scan the socks". What is proved here is the SHAPE rule and
// the seam: which strings are claimed as barcodes, and that a miss adds nothing
// and says so. What a given barcode means is the api's half, and it is proved
// in `apps/api/test/scanning-product.test.ts` against a real catalogue.

test('a barcode is claimed by its shape, and nothing else is', () => {
  // EAN-13 (885 is GS1 Thailand), UPC-A, EAN-8, ITF-14.
  assert.equal(isProductBarcode('8850000000017'), true);
  assert.equal(isProductBarcode('012345678905'), true);
  assert.equal(isProductBarcode('96385074'), true);
  assert.equal(isProductBarcode('10012345678902'), true);
  // A band code, a booking QR header, a staff PIN, and a person leaning on a key.
  assert.equal(isProductBarcode('T1-01J8ZQ4F7K'), false);
  assert.equal(isProductBarcode('OTO-SOCK'), false);
  assert.equal(isProductBarcode('1234'), false);
  assert.equal(isProductBarcode('885000000001700000'), false);
  assert.equal(isProductBarcode(''), false);
});

test('the seeded barcode resolves to the socks in size M, and the till is told what to add', async () => {
  const t = open();
  const published: StationScanMessage[] = [];
  const router = new ScanRouter({
    boxId: BOX_ID,
    store: t.store,
    publish: (_stationId, message) => published.push(message),
  });
  const asked: string[] = [];
  router.register(
    productBarcodeHandler((ctx) => {
      asked.push(ctx.code);
      // The catalogue's answer for a code printed on one SIZE's tag (S2-09b):
      // the item, and which of its sizes.
      return ctx.code === '8850000000017'
        ? {
            productId: 'p-socks',
            name: 'Grip Socks',
            sku: '8850000000017',
            priceSatang: 12000,
            variant: { id: 'm', label: 'M' },
          }
        : null;
    }),
  );

  const result = await router.deliver(STATION_ID, {
    code: '8850000000017',
    source: 'simulator',
  });
  assert.equal(result.kind, 'product');
  assert.equal(result.outcome, 'handled');
  assert.equal(result.handler, 'product-barcode');
  assert.deepEqual(asked, ['8850000000017']);
  const add = (result.detail?.add ?? {}) as Record<string, unknown>;
  assert.equal(add.productId, 'p-socks');
  assert.equal(add.name, 'Grip Socks');
  // The answer carries the size, and says the pair in words.
  assert.deepEqual(add.variant, { id: 'm', label: 'M' });
  assert.equal(add.label, 'Grip Socks M');
  assert.equal(add.priceSatang, 12000);
  assert.equal(add.quantity, 1);
  // The screens get the line; the tape does not — it names a product and a price.
  assert.equal(published[0]?.outcome, 'handled');
  assert.equal(
    (published[0]?.detail as Record<string, unknown> | null)?.add !== undefined,
    true,
  );
  const [row] = events(t.db);
  assert.equal(JSON.stringify(row).includes('Grip Socks'), false);
  assert.equal(JSON.stringify(row).includes('8850000000017'), false);
  t.close();
});

test('an item’s own code names no size, and the answer says so', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  router.register(
    productBarcodeHandler(() => ({
      productId: 'p-vest',
      name: 'Rash vest',
      sku: '8858888888887',
      priceSatang: 25000,
      variant: null,
    })),
  );
  const result = await router.deliver(STATION_ID, { code: '8858888888887', source: 'box_hid' });
  const add = (result.detail?.add ?? {}) as Record<string, unknown>;
  assert.equal(result.outcome, 'handled');
  assert.equal(add.variant, null);
  // No size, so the words are the item's name alone.
  assert.equal(add.label, 'Rash vest');
  t.close();
});

test('a barcode this park does not sell answers "unknown barcode" and adds nothing', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  router.register(productBarcodeHandler(() => null));

  const result = await router.deliver(STATION_ID, { code: '0000000000000', source: 'simulator' });
  assert.equal(result.kind, 'product');
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, UNKNOWN_BARCODE);
  assert.equal(result.detail?.message, 'Unknown barcode');
  assert.equal(result.detail?.add, undefined, 'a miss adds no line');
  t.close();
});

test('a malformed code is not a barcode at all, and no lookup is run', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  let asked = 0;
  router.register(
    productBarcodeHandler(() => {
      asked += 1;
      return null;
    }),
  );

  const result = await router.deliver(STATION_ID, { code: 'NOT-A-BARCODE', source: 'manual' });
  assert.equal(result.kind, 'unknown');
  assert.equal(result.outcome, 'unhandled');
  assert.equal(result.handler, null);
  assert.equal(result.detail, undefined);
  assert.equal(asked, 0, 'the catalogue is not queried for something that is not a barcode');
  t.close();
});

test('a lookup that throws is an error on that scan and not an exception at the counter', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  router.register(
    productBarcodeHandler(() => {
      throw new Error('the database went away');
    }),
  );
  const result = await router.deliver(STATION_ID, { code: '8850000000017', source: 'box_hid' });
  assert.equal(result.accepted, true);
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorCode, 'SCAN_HANDLER_FAILED');
  t.close();
});

// --- The signed band code (S2-11) -------------------------------------------
//
// The box's half of "scan a band": the signature is checked HERE, with no
// network, against the park's key, and the answer names the band — or says why
// it is not one. What the gate then does with a band is S2-12's. The code is
// minted with the platform's own function (`mintBandCode` in `@oto/shared`),
// which is the one the platform signs every printed band with.

const BAND_KEY = 'band-key-for-box-tests-only';
const OTHER_PARK_KEY = 'another-parks-band-key-entirely';
/** The band id `@oto/shared` pins its worked example on: a UUIDv7, so a ULID. */
const BAND_ID = '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f506';
const SIGNED = mintBandCode('T1', ulidFromUuid(BAND_ID), BAND_KEY);
const SHORT = bandShortCode(SIGNED)!;

/** The same code with the character at `at` swapped for another one a band uses. */
function alter(code: string, at: number): string {
  const was = code[at]!;
  const next = BAND_CODE_ALPHABET[(BAND_CODE_ALPHABET.indexOf(was) + 1) % BAND_CODE_ALPHABET.length]!;
  return `${code.slice(0, at)}${next}${code.slice(at + 1)}`;
}

function bandRouter(t: ReturnType<typeof open>, key: () => string | null = () => BAND_KEY) {
  const published: StationScanMessage[] = [];
  const router = new ScanRouter({
    boxId: BOX_ID,
    store: t.store,
    publish: (_stationId, message) => published.push(message),
    bandKey: key,
  });
  return { router, published };
}

test('a band this park printed is checked on the box and answers which band it is', async () => {
  const t = open();
  const { router, published } = bandRouter(t);
  const result = await router.deliver(STATION_ID, { code: SIGNED, source: 'simulator' });

  assert.equal(result.kind, 'band');
  assert.equal(result.handler, BAND_CODE_HANDLER);
  assert.equal(result.outcome, 'handled');
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.detail?.band, {
    bandId: BAND_ID,
    prefix: 'T1',
    shortCode: SHORT,
    // The UUIDv7's own clock: when the platform minted the band row.
    mintedAt: new Date(Number.parseInt('0192f3a45b6c', 16)).toISOString(),
  });
  assert.match(String(result.detail?.message), new RegExp(SHORT));

  // The credential stops at the handler: not on the tape, not on the channel,
  // not in the answer.
  const [row] = events(t.db);
  const payload = JSON.parse(String(row!.payload)) as Record<string, unknown>;
  assert.equal(payload.codeKind, 'band');
  assert.equal(payload.handler, 'band');
  assert.equal(payload.codePrefix, 'T1', 'the prefix is read where the body starts, with no dash');
  assert.equal(JSON.stringify(row).includes(SIGNED), false);
  assert.equal(JSON.stringify(published).includes(SIGNED), false);
  assert.equal(JSON.stringify(result).includes(SIGNED), false);
  assert.deepEqual((published[0]?.detail as Record<string, unknown>).band, result.detail?.band);
  t.close();
});

test('a band typed by hand in lower case is the same band', async () => {
  const t = open();
  const { router } = bandRouter(t);
  const result = await router.deliver(STATION_ID, { code: ` ${SIGNED.toLowerCase()} `, source: 'manual' });
  assert.equal(result.outcome, 'handled');
  assert.equal((result.detail?.band as { bandId: string }).bandId, BAND_ID);
  t.close();
});

test('one character changed — in the signature, the body or the prefix — is refused, and says why', async () => {
  const t = open();
  const { router } = bandRouter(t);
  const dot = SIGNED.indexOf('.');
  const tampered = [
    alter(SIGNED, SIGNED.length - 1), // the signature
    alter(SIGNED, dot - 3), // the body: another band's id
    `T2${SIGNED.slice(2)}`, // the prefix: "another till printed this"
  ];
  for (const code of tampered) {
    const result = await router.deliver(STATION_ID, { code, source: 'simulator' });
    assert.equal(result.kind, 'band', code);
    assert.equal(result.handler, BAND_CODE_HANDLER);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.errorCode, BAND_SIGNATURE_INVALID);
    assert.equal(result.detail?.reason, 'signature');
    assert.match(String(result.detail?.message), /signature does not match/);
    assert.equal(result.detail?.band, undefined, 'a refused band names no band');
  }
  // The tape counts each refusal by its code, and holds none of the codes.
  const rows = events(t.db);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal((JSON.parse(String(row.payload)) as { errorCode?: string }).errorCode, BAND_SIGNATURE_INVALID);
  }
  t.close();
});

test('a band signed with another park’s key is refused as not this park’s', async () => {
  const t = open();
  const { router } = bandRouter(t);
  const theirs = mintBandCode('T1', ulidFromUuid(BAND_ID), OTHER_PARK_KEY);
  const result = await router.deliver(STATION_ID, { code: theirs, source: 'box_hid' });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, BAND_SIGNATURE_INVALID);
  t.close();
});

test('a band with a character no band uses, or one missing, is refused as malformed — not unknown', async () => {
  const t = open();
  const { router } = bandRouter(t);
  const dot = SIGNED.indexOf('.');
  const misread = `${SIGNED.slice(0, 5)}O${SIGNED.slice(6)}`; // an O where no O can be
  const dropped = `${SIGNED.slice(0, dot - 1)}${SIGNED.slice(dot)}`; // one body character short
  for (const code of [misread, dropped]) {
    const result = await router.deliver(STATION_ID, { code, source: 'simulator' });
    assert.equal(result.kind, 'band', code);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.errorCode, BAND_CODE_MALFORMED);
    assert.equal(result.detail?.reason, 'format');
  }
  t.close();
});

test('the short code under the QR is a band’s, and opens nothing: scan the QR', async () => {
  const t = open();
  const { router } = bandRouter(t);
  const result = await router.deliver(STATION_ID, { code: SHORT, source: 'box_hid' });
  assert.equal(result.kind, 'band');
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, BAND_SHORT_CODE);
  assert.equal(result.detail?.shortCode, SHORT, 'handed over, so a till can still find the sale');
  assert.match(String(result.detail?.message), /scan the QR/);
  t.close();
});

test('a box with no band key says it cannot check, and never passes a band', async () => {
  const t = open();
  const missing = bandRouter(t, () => null).router;
  const none = await missing.deliver(STATION_ID, { code: SIGNED, source: 'simulator' });
  assert.equal(none.kind, 'band');
  assert.equal(none.outcome, 'error');
  assert.equal(none.errorCode, BAND_KEY_MISSING);
  assert.equal(none.detail?.band, undefined);

  const short = bandRouter(t, () => 'too-short').router;
  const bad = await short.deliver(STATION_ID, { code: SIGNED, source: 'simulator' });
  assert.equal(bad.outcome, 'error');
  assert.equal(bad.errorCode, BAND_KEY_INVALID);
  t.close();
});

test('a router with no key leaves band codes to nobody, as a router always has', async () => {
  const t = open();
  const router = new ScanRouter({ boxId: BOX_ID, store: t.store });
  assert.deepEqual(router.registered(), ['voucher', 'booking', 'benefit']);
  const result = await router.deliver(STATION_ID, { code: SIGNED, source: 'camera' });
  assert.equal(result.kind, 'unknown');
  assert.equal(result.outcome, 'unhandled');
  t.close();
});

test('a band is claimed before any registration, and nothing that is not one is claimed as one', async () => {
  const t = open();
  const { router } = bandRouter(t);
  const greedy: string[] = [];
  router.register({
    name: 'greedy',
    kind: 'booking',
    matches: () => true,
    handle: (ctx) => {
      greedy.push(ctx.code);
    },
  });
  assert.deepEqual(router.registered(), ['voucher', 'band', 'booking', 'benefit', 'greedy'], 'match order: voucher, band, booking, benefit, registrations');

  assert.equal((await router.deliver(STATION_ID, { code: SIGNED, source: 'box_hid' })).handler, 'band');
  assert.equal(greedy.length, 0);

  // A barcode, SKU labels, the older test code, a short code with no dash: not bands.
  for (const code of ['8850000000017', 'MR-VEST', 'SO-THING', 'T1-01J8ZQ4F7K', 'T1D4DQD2']) {
    assert.equal(isBandCodeCandidate(code), false, code);
    assert.notEqual((await router.deliver(STATION_ID, { code, source: 'box_hid' })).handler, 'band', code);
  }
  assert.equal(isBandCodeCandidate(SIGNED), true);
  assert.equal(isBandCodeCandidate(SHORT), true);
  assert.equal(scanPrefix(SIGNED), 'T1');
  t.close();
});

// The same, through the agent: where the box's key comes from, and what the
// Console's scanner simulator is told.

test('the box checks bands against the key its configuration brought; a host’s own key wins', async () => {
  const withKey = fakeBoxCloud(tillBundle({ bandKey: BAND_KEY }));
  const box = await openTestAgent(withKey);
  const fromBundle = await box.agent.scanner()!.deliver(STATION_ID, { code: SIGNED, source: 'simulator' });
  assert.equal(fromBundle.outcome, 'handled');
  assert.equal((fromBundle.detail?.band as { bandId: string }).bandId, BAND_ID);
  box.close();

  // The virtual box holds the platform's key itself, and that is the one used.
  const host = await openTestAgent(withKey, { bands: { key: () => OTHER_PARK_KEY } });
  const fromHost = await host.agent.scanner()!.deliver(STATION_ID, { code: SIGNED, source: 'simulator' });
  assert.equal(fromHost.errorCode, BAND_SIGNATURE_INVALID);
  host.close();

  // Neither: an api that sends no key yet. The box says it cannot check.
  const without = await openTestAgent(fakeBoxCloud(tillBundle()));
  const unchecked = await without.agent.scanner()!.deliver(STATION_ID, { code: SIGNED, source: 'simulator' });
  assert.equal(unchecked.outcome, 'error');
  assert.equal(unchecked.errorCode, BAND_KEY_MISSING);
  assert.deepEqual(without.agent.scanner()!.registered(), ['voucher', 'band', 'booking', 'benefit']);
  without.close();
});

test('the Console’s scanner simulator is told the band a code decoded to, or why it was refused — never the code', async () => {
  const cloud = fakeBoxCloud(tillBundle({ bandKey: BAND_KEY }));
  const box = await openTestAgent(cloud);
  const scan = (id: string, code: string) => ({
    id,
    kind: 'simulate' as const,
    payload: { action: { action: 'scanner.scan', input: { code, source: 'simulator' } } },
    actionId: null,
    attempts: 1,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  });
  cloud.commands.push(scan('cmd-band-good', SIGNED), scan('cmd-band-bad', alter(SIGNED, SIGNED.length - 1)));
  assert.equal(await box.agent.runPendingCommands(), 2);

  const [good, bad] = cloud.commandResults;
  assert.equal(good?.body.state, 'succeeded');
  assert.equal(good?.body.result?.codeKind, 'band');
  assert.equal(good?.body.result?.outcome, 'handled');
  assert.equal((good?.body.result?.band as { bandId: string }).bandId, BAND_ID);
  assert.equal((good?.body.result?.band as { shortCode: string }).shortCode, SHORT);
  assert.equal(bad?.body.result?.outcome, 'refused');
  assert.equal(bad?.body.result?.errorCode, BAND_SIGNATURE_INVALID);
  assert.equal(bad?.body.result?.band, undefined);
  // The result is stored on the command row and shown in the Console's history.
  assert.equal(JSON.stringify(cloud.commandResults).includes(SIGNED), false);
  box.close();
});
