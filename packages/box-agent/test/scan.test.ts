import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  ScanRouter,
  UNKNOWN_BARCODE,
  isProductBarcode,
  productBarcodeHandler,
  scanFingerprint,
  scanPrefix,
  stationSourceForScan,
} from '../src/scan';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { StationScanMessage } from '../src/contract';
import { BOX_ID, STATION_ID } from './_support';

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

test('the seeded barcode resolves to the merch item, and the till is told what to add', async () => {
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
      return ctx.code === '8850000000017'
        ? {
            productId: 'p-socks-m',
            name: 'Grip socks M',
            sku: '8850000000017',
            priceSatang: 12000,
            variant: null,
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
  assert.equal(add.productId, 'p-socks-m');
  assert.equal(add.name, 'Grip socks M');
  assert.equal(add.priceSatang, 12000);
  assert.equal(add.quantity, 1);
  assert.equal(add.variant, null);
  // The screens get the line; the tape does not — it names a product and a price.
  assert.equal(published[0]?.outcome, 'handled');
  assert.equal(
    (published[0]?.detail as Record<string, unknown> | null)?.add !== undefined,
    true,
  );
  const [row] = events(t.db);
  assert.equal(JSON.stringify(row).includes('Grip socks'), false);
  assert.equal(JSON.stringify(row).includes('8850000000017'), false);
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
