import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createBooth, type BoothCacheEntry, type BoothPrintPort } from '../src/booth';
import { generateSyncKeyPair } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { BoothVoucherData, PrintJob as RenderPrintJob } from '@oto/print';
import { escposProfile, renderJob } from '@oto/print';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, seededIndex } from './_support';

/**
 * SCRUM-471 — the booth's own voucher slip, from the published wheel to the
 * print job.
 *
 * The box is where the slip is resolved (a booth prints with no internet), so
 * what is proved here is that the choices an administrator published ride into
 * the renderer's input, that a wheel published before they existed prints the
 * slip it always did, and that a reprint is the same slip as its first copy.
 */

const STATION_ID = '018f1d2c-0000-7000-8000-0000000057b1';
const LAYOUT_ID = '018f1d2c-0000-7000-8000-00000000fa00';
const CONFIG_VERSION_ID = '018f1d2c-0000-7000-8000-00000000fc01';
const DEFINITION_ID = '018f1d2c-0000-7000-8000-00000000fd01';
const ACCOUNT_ID = '018f1d2c-0000-7000-8000-00000000fb01';
const AT = '2026-09-21T06:00:00.000Z';

const keys = generateSyncKeyPair();
let nextSeed = 471;

type Settings = BoothCacheEntry['bundle']['settings'];

function entry(settings: Partial<Settings> = {}, version = 1): BoothCacheEntry {
  return {
    stationId: STATION_ID,
    configVersionId: CONFIG_VERSION_ID,
    version,
    bundleHash: String(version).repeat(64),
    allowedStaff: [ACCOUNT_ID],
    voucherDefinitions: [
      { id: DEFINITION_ID, expiryDays: 14, termsEn: 'Cannot be combined with other offers.', termsTh: null },
    ] as BoothCacheEntry['voucherDefinitions'],
    bundle: {
      schemaVersion: 1,
      settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null, ...settings },
      layout: { id: LAYOUT_ID, name: 'Classic wheel', version: 1, design: {}, assetManifest: {} },
      prizes: [
        {
          id: '018f1d2c-0000-7000-8000-00000000fa11',
          nameEn: '100 THB VOUCHER',
          nameTh: null,
          wheelLabel: null,
          weightBp: 10_000,
          active: true,
          dailyCap: null,
          expiryDays: 14,
          costSatang: 10_000,
          sliceColor: null,
          textColor: null,
          sortOrder: 0,
          voucherDefinitionId: DEFINITION_ID,
        },
      ],
    },
  };
}

function open() {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const now = new Date(AT);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => now });
  const submitted: RenderPrintJob[] = [];
  const port: BoothPrintPort = {
    async submit(request) {
      submitted.push(request.job);
      return { id: request.id, status: 'printed', attempts: 1, deviceId: null, errorCode: null, errorMessage: null };
    },
  };
  const booth = createBooth({
    boxId: BOX_ID,
    store,
    station: () => ({ id: STATION_ID, name: 'Booth 1', codePrefix: 'B1' }),
    branch: () => ({
      id: BRANCH_ID,
      operatorId: OPERATOR_ID,
      name: 'Oto Play Park, Central Floresta',
      timezone: 'Asia/Bangkok',
      businessDayStart: '05:00',
    }),
    privateKey: () => keys.privateKeyPem,
    print: port,
    // A reprint needs somebody signed in; the PIN check is the test's own.
    staff: () => [
      { accountId: ACCOUNT_ID, status: 'active', pinHash: 'pin:73910', staffCode: 'S-7KMQ', displayName: 'Nok' },
    ],
    verifySecret: async (hash, secret) => hash === `pin:${secret}`,
    randomIndex: seededIndex(nextSeed++),
    now: () => now,
  });
  return { db, store, booth, submitted };
}

type Harness = ReturnType<typeof open>;

async function publish(h: Harness, item: BoothCacheEntry, cursorSeq = 1): Promise<void> {
  await h.store.init(BOX_ID);
  await h.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq,
    payload: { items: [item] },
    appliedAt: AT,
  });
  await h.booth.refresh();
}

function voucherData(job: RenderPrintJob | undefined): BoothVoucherData {
  assert.ok(job, 'nothing was printed');
  assert.equal(job.kind, 'booth_voucher');
  if (job.kind !== 'booth_voucher') throw new Error('unreachable');
  return job.data;
}

test('the print job carries the slip the booth published', async () => {
  const h = open();
  await publish(
    h,
    entry({
      voucherShowLogo: false,
      voucherHeaderText: 'Lucky Wheel · spin to win',
      voucherFooterText: 'Thank you for playing!',
      voucherShowStaff: false,
      voucherShowTerms: false,
    }),
  );
  const spin = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: spin.spinId });

  const data = voucherData(h.submitted[0]);
  assert.equal(data.showLogo, false);
  assert.equal(data.headerLine, 'Lucky Wheel · spin to win');
  assert.equal(data.footerLine, 'Thank you for playing!');
  assert.equal(data.showStaff, false);
  assert.equal(data.showTerms, false);
  // The venue line is still the branch: the header sits under it, never in its place.
  assert.equal(data.venueLine, 'Oto Play Park, Central Floresta');
  // The terms are still resolved; it is the slip that leaves them off.
  assert.deepEqual(data.terms, ['Cannot be combined with other offers.']);
  h.db.close();
});

test('a wheel published before the slip fields existed prints today’s slip', async () => {
  const h = open();
  await publish(h, entry());
  const spin = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: spin.spinId });

  const data = voucherData(h.submitted[0]);
  assert.equal(data.showLogo, true);
  assert.equal(data.headerLine, null);
  assert.equal(data.footerLine, '');
  assert.equal(data.showStaff, true);
  assert.equal(data.showTerms, true);

  // And it lays down exactly the dots the same data does with the fields left
  // out — the job a box built before this round would have stored.
  const device = escposProfile({ id: 'booth', label: 'Booth printer', model: 'sample', widthDots: 576 });
  const { showLogo: _l, headerLine: _h, showStaff: _s, showTerms: _t, ...before } = data;
  const withFields = renderJob({ kind: 'booth_voucher', data }, { device }).bytes;
  const without = renderJob({ kind: 'booth_voucher', data: before }, { device }).bytes;
  assert.ok(Buffer.from(withFields).equals(Buffer.from(without)));
  h.db.close();
});

test('a reprint after a new publish is the same slip as its first copy', async () => {
  const h = open();
  await publish(h, entry({ voucherFooterText: 'First footer' }));
  const spin = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: spin.spinId });
  assert.equal(voucherData(h.submitted[0]).footerLine, 'First footer');

  await publish(h, entry({ voucherFooterText: 'Second footer', voucherShowLogo: false }, 2), 2);
  assert.deepEqual(await h.booth.signIn({ pin: '73910' }), { ok: true, accountId: ACCOUNT_ID });
  const reprint = await h.booth.reprint({ spinId: spin.spinId });
  assert.equal(reprint.spinId, spin.spinId);
  const copy = voucherData(h.submitted[h.submitted.length - 1]);
  assert.equal(copy.footerLine, 'First footer');
  assert.equal(copy.showLogo, true);
  assert.match(copy.reprintNote ?? '', /^Reprint · /);

  // The next voucher is the new slip.
  const next = await h.booth.spin({ idempotencyKey: 'press-2' });
  await h.booth.print({ spinId: next.spinId });
  const fresh = voucherData(h.submitted[h.submitted.length - 1]);
  assert.equal(fresh.footerLine, 'Second footer');
  assert.equal(fresh.showLogo, false);
  h.db.close();
});
