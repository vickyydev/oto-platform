import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { WALLET_QR_HANDLER, mintBandCode, mintBoothCode, mintVoucherQr } from '@oto/shared';

import { ScanRouter, productBarcodeHandler, scanFingerprint } from '../src/scan';
import { redactScanForCustomer } from '../src/station-session';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { StationScanMessage } from '../src/contract';
import { BOX_ID, STATION_ID, seededIndex } from './_support';

/**
 * SCRUM-731 — a wallet's voucher QR read at the counter.
 *
 * The box had no handler for it, so the QR on a printed credit voucher resolved
 * `unknown` and reached no till, though the platform takes the same string when
 * it is typed. The box classes it by shape and decides nothing else; what is
 * proved here is which strings are one, that the key reaches staff screens and
 * no other, and that nothing else changed its answer for it.
 */

const BAND_KEY = 'band-key-for-box-agent-tests-only';

function open(): { router: ScanRouter; db: DatabaseSync; published: StationScanMessage[] } {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db) });
  const published: StationScanMessage[] = [];
  const router = new ScanRouter({
    boxId: BOX_ID,
    store,
    bandKey: () => BAND_KEY,
    publish: (_stationId, message) => published.push(message),
  });
  return { router, db, published };
}

const tape = (db: DatabaseSync) =>
  db.prepare('select * from station_event order by received_at').all() as Array<
    Record<string, unknown>
  >;

test('a minted wallet QR is the wallet kind, and its key goes to the till', async () => {
  const { router, db, published } = open();
  const qr = mintVoucherQr();
  const result = await router.deliver(STATION_ID, { code: qr, source: 'box_hid' });

  assert.equal(result.kind, 'wallet');
  assert.equal(result.outcome, 'handled');
  assert.equal(result.handler, WALLET_QR_HANDLER);
  assert.equal(result.detail?.walletKey, qr);
  assert.equal(published[0]?.codeKind, 'wallet');
  assert.equal(published[0]?.detail?.walletKey, qr);

  const row = tape(db)[0]!;
  const payload = String(row.payload);
  assert.ok(!payload.includes(qr), 'the tape never holds the key');
  assert.ok(payload.includes(scanFingerprint(qr)), 'the tape holds its fingerprint');
});

test('the key is read the way the platform reads one: trimmed, upper case, the scanner suffix dropped', async () => {
  const { router } = open();
  const qr = mintVoucherQr();
  const result = await router.deliver(STATION_ID, { code: `  ${qr.toLowerCase()}\r\n`, source: 'keyboard' });
  assert.equal(result.kind, 'wallet');
  assert.equal(result.detail?.walletKey, qr);
});

test('the demo data’s QR, spelled with a wallet id, is claimed too', async () => {
  const { router } = open();
  const qr = 'QR-0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f777';
  const result = await router.deliver(STATION_ID, { code: qr, source: 'simulator' });
  assert.equal(result.kind, 'wallet');
  assert.equal(result.detail?.walletKey, qr.toUpperCase());
});

test('the screen facing the guest never receives the key', async () => {
  const { router, published } = open();
  const qr = mintVoucherQr();
  await router.deliver(STATION_ID, { code: qr, source: 'box_hid' });
  const customer = redactScanForCustomer(published[0]!);
  assert.ok(!JSON.stringify(customer).includes(qr));
  assert.equal(customer.codeKind, 'wallet', 'what kind of code it was is still said');
});

test('nothing else that a counter scans is taken for a wallet QR', async () => {
  const { router } = open();
  router.register(productBarcodeHandler(() => null));
  const signedBand = mintBandCode('T1', '01J8ZZZZZZZZZZZZZZZZZZZZZZ', BAND_KEY);
  const cases: Array<[string, string]> = [
    [signedBand, 'band'],
    // A band's short code whose prefix happens to be QR: the tail is six characters.
    ['QR-D4DQD2', 'band'],
    [mintBoothCode('B1', seededIndex(7)), 'voucher'],
    ['8850000000017', 'product'],
    ['QR-SHORT', 'unknown'],
    ['QR-', 'unknown'],
  ];
  for (const [code, kind] of cases) {
    assert.equal((await router.deliver(STATION_ID, { code, source: 'camera' })).kind, kind, code);
  }
});

test('a broad matcher registered later never takes a wallet QR', async () => {
  const { router } = open();
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
  assert.equal((await router.deliver(STATION_ID, { code: mintVoucherQr(), source: 'camera' })).handler, WALLET_QR_HANDLER);
  assert.deepEqual(seen, []);
});
