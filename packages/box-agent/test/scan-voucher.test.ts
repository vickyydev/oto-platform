import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { BOOTH_CODE_ALPHABET, boothCodeCheckCharacter, mintBoothCode, verifyBoothCode } from '@oto/shared';

import {
  ScanRouter,
  VOUCHER_CODE_HANDLER,
  isBoothVoucherCode,
  productBarcodeHandler,
  scanFingerprint,
} from '../src/scan';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { StationScanMessage } from '../src/contract';
import { BOX_ID, STATION_ID, seededIndex } from './_support';

/**
 * S2-10b (SCRUM-207) — a Lucky Wheel voucher read at the counter.
 *
 * The box classes the code by its SHAPE and decides nothing else: the voucher
 * is validated by the platform alone, at the till's request (spec §8). What is
 * proved here is the classifier — which strings are a voucher and which are
 * not — and the seam: the code reaches the screens on the station channel,
 * because it is the thing the till must ask the cloud about, and never the
 * tape, which keeps its fingerprint as it does for every scan.
 */

function open(): { router: ScanRouter; db: DatabaseSync; published: StationScanMessage[] } {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  const published: StationScanMessage[] = [];
  const router = new ScanRouter({
    boxId: BOX_ID,
    store,
    publish: (_stationId, message) => published.push(message),
  });
  return { router, db, published };
}

const tape = (db: DatabaseSync) =>
  db.prepare('select * from station_event order by received_at').all() as Array<
    Record<string, unknown>
  >;

/** Codes as a booth mints them: `B1`, eight drawn characters and the check. */
const mint = (seed: number) => mintBoothCode('B1', seededIndex(seed));

/** The same code with one character changed to another the alphabet allows. */
function alterOne(code: string, at: number): string {
  const current = code[at]!;
  const next = BOOTH_CODE_ALPHABET.indexOf(current) + 1;
  const other = BOOTH_CODE_ALPHABET[next % BOOTH_CODE_ALPHABET.length]!;
  return `${code.slice(0, at)}${other}${code.slice(at + 1)}`;
}

test('an eleven-character code with a right check is a voucher, and the code goes to the till', async () => {
  const { router, db, published } = open();
  const code = mint(11);
  assert.equal(verifyBoothCode(code).ok, true, 'the fixture is a code a booth prints');

  const result = await router.deliver(STATION_ID, {
    code,
    source: 'box_hid',
    actionId: 'act-voucher-1',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.kind, 'voucher');
  assert.equal(result.handler, VOUCHER_CODE_HANDLER);
  // The box validates nothing: the answer is always "handled", never a refusal.
  assert.equal(result.outcome, 'handled');
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.detail, { code });

  // The screens are told, with the code: the one thing the till asks the cloud about.
  assert.equal(published.length, 1);
  assert.equal(published[0]?.codeKind, 'voucher');
  assert.equal(published[0]?.handler, 'voucher');
  assert.deepEqual(published[0]?.detail, { code });
  assert.equal(published[0]?.codeFingerprint, scanFingerprint(code));

  // The tape keeps the fingerprint and never the code.
  const [row] = tape(db);
  assert.ok(row, 'a scan writes one line on the station tape');
  const payload = JSON.parse(String(row!.payload)) as Record<string, unknown>;
  assert.equal(payload.codeKind, 'voucher');
  assert.equal(payload.handler, 'voucher');
  assert.equal(payload.codeFingerprint, scanFingerprint(code));
  assert.equal(JSON.stringify(row).includes(code), false, 'the code must not appear on the tape');
});

test('a ten-character code of the shape printed before the check is a voucher too', async () => {
  const { router } = open();
  // A prefix and eight characters of the alphabet: every booth code before S2-10b.
  const legacy = 'B1RT7KMQ4X';
  assert.equal(isBoothVoucherCode(legacy), true);
  const result = await router.deliver(STATION_ID, { code: legacy, source: 'simulator' });
  assert.equal(result.kind, 'voucher');
  assert.equal(result.outcome, 'handled');
  assert.deepEqual(result.detail, { code: legacy });
});

test('a code with one character wrong fails its check and is not a voucher', async () => {
  const { router, published } = open();
  const code = mint(23);
  // Every place, the prefix and the check included: MOD 37-2 catches every
  // single substitution, so no altered code is claimed.
  for (let at = 0; at < code.length; at += 1) {
    const altered = alterOne(code, at);
    assert.equal(isBoothVoucherCode(altered), false, `${altered} (position ${at}) is not a voucher`);
  }
  const altered = alterOne(code, 5);
  const result = await router.deliver(STATION_ID, { code: altered, source: 'box_hid' });
  assert.equal(result.kind, 'unknown');
  assert.equal(result.outcome, 'unhandled');
  assert.equal(result.handler, null);
  assert.equal(published[0]?.detail, null, 'nothing is sent for the till to ask about');
});

test('read the way the platform reads one: lower case, spaces and dashes are the same code', async () => {
  const { router } = open();
  const code = mint(31);
  const head = code.slice(0, 2).toLowerCase();
  const middle = code.slice(2, 6).toLowerCase();
  const typed = `${head}-${middle} ${code.slice(6)}`;
  const result = await router.deliver(STATION_ID, { code: typed, source: 'simulator' });
  assert.equal(result.kind, 'voucher');
  // The till is handed the code in the one form the platform stores.
  assert.deepEqual(result.detail, { code });
});

test('a non-code is not a voucher: a band, a barcode, a PIN, a word, or digits alone', () => {
  for (const notOne of [
    'T1-01J8ZQ4F7K', // a band code: a station-prefixed ULID
    '8850000000017', // an EAN-13 on the socks
    '1234', // a staff PIN, or one of Radar's old four-digit codes
    'NOT-A-BARCODE',
    '',
    `${mint(41)}X`, // twelve characters
    mint(43).slice(0, 9), // nine
  ]) {
    assert.equal(isBoothVoucherCode(notOne), false, JSON.stringify(notOne));
  }
  // Digits alone are a retail barcode's shape, even when they would pass the
  // booth shape: ten digits of the old shape, or eleven with a right check.
  assert.equal(isBoothVoucherCode('2345678923'), false);
  let digitsWithCheck: string | null = null;
  for (let n = 0; n < 100_000 && !digitsWithCheck; n += 1) {
    const body = `22${String(23456789 + n)}`;
    if (body.length !== 10 || /[01]/.test(body.slice(2))) continue;
    const check = boothCodeCheckCharacter(body);
    if (check && /[0-9]/.test(check)) digitsWithCheck = `${body}${check}`;
  }
  assert.ok(digitsWithCheck, 'an eleven-digit string with a right check exists');
  assert.equal(verifyBoothCode(digitsWithCheck!).ok, true);
  assert.equal(isBoothVoucherCode(digitsWithCheck!), false);
});

test('digits alone stay the shop’s: the product handler gets them, not the voucher', async () => {
  const { router } = open();
  router.register(productBarcodeHandler(() => null));
  const barcode = await router.deliver(STATION_ID, { code: '2345678923', source: 'box_hid' });
  assert.equal(barcode.kind, 'product');
  assert.equal(barcode.handler, 'product-barcode');
});

test('the router claims a voucher ahead of any registered handler, and lists it first', async () => {
  const { router } = open();
  assert.deepEqual(router.registered(), ['voucher', 'booking', 'benefit'], 'the router’s own handlers are always on');
  const seen: string[] = [];
  router.register({
    name: 'greedy',
    kind: 'booking',
    matches: () => true,
    handle: (ctx) => {
      seen.push(ctx.code);
      return { outcome: 'handled' as const };
    },
  });
  assert.deepEqual(router.registered(), ['voucher', 'booking', 'benefit', 'greedy'], 'match order: the voucher, the booking QR, the benefit QR, then registrations');

  const code = mint(53);
  const voucher = await router.deliver(STATION_ID, { code, source: 'camera' });
  assert.equal(voucher.handler, 'voucher');
  assert.deepEqual(seen, [], 'a broad matcher registered later never takes a voucher');

  const other = await router.deliver(STATION_ID, { code: 'BK-999', source: 'camera' });
  assert.equal(other.handler, 'greedy');
});
