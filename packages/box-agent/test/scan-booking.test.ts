import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { mintBandCode, mintBookingQr, ulidFromUuid } from '@oto/shared';

import {
  BOOKING_KEY_MISSING,
  BOOKING_QR_HANDLER,
  BOOKING_QR_MALFORMED,
  BOOKING_QR_SIGNATURE_INVALID,
  ScanRouter,
  productBarcodeHandler,
} from '../src/scan';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { StationScanMessage } from '../src/contract';
import { BOX_ID, STATION_ID } from './_support';

/**
 * S2-12 (SCRUM-209 round 3) — the booking QR at the counter.
 *
 * The classifier used to refuse to guess a booking's format; the format now
 * exists (`@oto/shared` `booking-qr.ts`, minted by the api at payment), so the
 * router claims it by its header, checks its signature with the park key, and
 * hands the till the booking to open the redeem flow on. The table below is the
 * round's proof that band, booking and product codes each go to their own
 * handler and to no other.
 */

const PARK_KEY = 'band-key-for-box-tests-only';
const OTHER_PARK_KEY = 'another-parks-band-key-entirely';
const BOOKING_ID = '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f777';
const BAND_ID = '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f506';
const BOOKING_QR = mintBookingQr(BOOKING_ID, PARK_KEY);
const BAND = mintBandCode('T1', ulidFromUuid(BAND_ID), PARK_KEY);

function open(key: (() => string | null) | null = () => PARK_KEY) {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  const published: StationScanMessage[] = [];
  const router = new ScanRouter({
    boxId: BOX_ID,
    store,
    ...(key ? { bandKey: key } : {}),
    publish: (_station, message) => published.push(message),
  });
  router.register(productBarcodeHandler(async () => null));
  return { router, published, close: () => db.close() };
}

test('the classifier table: band, booking and product codes each reach their own handler', async () => {
  const t = open();
  const table: Array<{ code: string; kind: string; handler: string | null }> = [
    { code: BAND, kind: 'band', handler: 'band' },
    { code: BOOKING_QR, kind: 'booking', handler: BOOKING_QR_HANDLER },
    // Read by a camera in lower case, with the scanner's suffix.
    { code: `${BOOKING_QR.toLowerCase()}\r\n`, kind: 'booking', handler: BOOKING_QR_HANDLER },
    { code: '8850000000017', kind: 'product', handler: 'product-barcode' },
    // A typed reference is reception's fallback, not a scan anybody claims.
    { code: 'OTO-AB12-3456', kind: 'unknown', handler: null },
  ];
  for (const row of table) {
    const result = await t.router.deliver(STATION_ID, { code: row.code, source: 'box_hid' });
    assert.equal(result.kind, row.kind, row.code);
    assert.equal(result.handler, row.handler, row.code);
  }
  t.close();
});

test('a signed booking QR opens the redeem flow on its booking — and the code does not travel', async () => {
  const t = open();
  const result = await t.router.deliver(STATION_ID, { code: BOOKING_QR, source: 'box_hid' });
  assert.equal(result.outcome, 'handled');
  assert.equal(result.detail?.action, 'redeem_booking');
  assert.equal(result.detail?.bookingId, BOOKING_ID);
  const sent = t.published.at(-1)!;
  assert.equal(sent.codeKind, 'booking');
  assert.ok(!JSON.stringify(sent).includes(BOOKING_QR), 'the QR itself never rides the channel');
  t.close();
});

test('another park’s QR, a tampered one and a truncated one are refused by name', async () => {
  const t = open();
  const foreign = await t.router.deliver(STATION_ID, {
    code: mintBookingQr(BOOKING_ID, OTHER_PARK_KEY),
    source: 'box_hid',
  });
  assert.equal(foreign.outcome, 'refused');
  assert.equal(foreign.errorCode, BOOKING_QR_SIGNATURE_INVALID);

  const last = BOOKING_QR.at(-1)!;
  const tampered = `${BOOKING_QR.slice(0, -1)}${last === '0' ? '1' : '0'}`;
  const altered = await t.router.deliver(STATION_ID, { code: tampered, source: 'box_hid' });
  assert.equal(altered.errorCode, BOOKING_QR_SIGNATURE_INVALID);

  const short = await t.router.deliver(STATION_ID, { code: BOOKING_QR.slice(0, 20), source: 'box_hid' });
  assert.equal(short.kind, 'booking', 'the header claims it, so nothing broader guesses at it');
  assert.equal(short.errorCode, BOOKING_QR_MALFORMED);
  t.close();
});

test('a router with no park key still classifies a booking QR, and says it cannot check it', async () => {
  const t = open(null);
  const result = await t.router.deliver(STATION_ID, { code: BOOKING_QR, source: 'camera' });
  assert.equal(result.kind, 'booking');
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorCode, BOOKING_KEY_MISSING);
  t.close();
});
