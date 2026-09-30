import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BoothCacheEntrySchema,
  createBooth,
  type BoothCacheEntry,
  type BoothPrintPort,
} from '../src/booth';
import { generateSyncKeyPair } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { BoothVoucherData, PrintJob as RenderPrintJob } from '@oto/print';
import { escposProfile, renderJob } from '@oto/print';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, seededIndex } from './_support';

/**
 * SCRUM-473 (plan D5, D6) — the day's booth staff on the box.
 *
 * The voucher's Staff row becomes the MERGED label of today's roster ("Tom
 * and Jerry"), plus a stand-in who signed in; before anyone is attributed
 * today (no roster, or an empty one) it is exactly the signed-in person it
 * always was, and with nobody at all it is still "unattributed". Once the
 * day's roster holds anyone — a stand-in the cloud self-assigned at their
 * first sign-in included — the label is names only for the rest of the day
 * (the owner's format ruling). Sign-in is the standing list and today's
 * roster together. The spin still records the one signed-in account.
 */

const STATION_ID = '018f1d2c-0000-7000-8000-0000000047a1';
const LAYOUT_ID = '018f1d2c-0000-7000-8000-00000000fa00';
const CONFIG_VERSION_ID = '018f1d2c-0000-7000-8000-00000000fc01';
const DEFINITION_ID = '018f1d2c-0000-7000-8000-00000000fd01';
/** On the standing list: Nok. */
const NOK = '018f1d2c-0000-7000-8000-00000000fb01';
/** On today's roster only: Tom. */
const TOM = '018f1d2c-0000-7000-8000-00000000fb02';
/** On neither: Ploy. */
const PLOY = '018f1d2c-0000-7000-8000-00000000fb03';
/** 13:00 in Bangkok: trading day 2026-09-21. */
const AT = '2026-09-21T06:00:00.000Z';
const TODAY = '2026-09-21';

const keys = generateSyncKeyPair();
let nextSeed = 473;

type Roster = { date: string; people: Array<{ accountId: string | null; displayName: string }> };

/** The cache item as the cloud serves it; `dutyRoster` absent is an older cloud. */
function item(dutyRoster?: Roster | unknown): Record<string, unknown> {
  return {
    stationId: STATION_ID,
    configVersionId: CONFIG_VERSION_ID,
    version: 1,
    bundleHash: '1'.repeat(64),
    allowedStaff: [NOK],
    ...(dutyRoster === undefined ? {} : { dutyRoster }),
    voucherDefinitions: [{ id: DEFINITION_ID, expiryDays: 14, termsEn: 'One per family.', termsTh: null }],
    bundle: {
      schemaVersion: 1,
      settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
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
    staff: () => [
      { accountId: NOK, status: 'active', pinHash: 'pin:73910', staffCode: 'S-7KMQ', displayName: 'Nok' },
      { accountId: TOM, status: 'active', pinHash: 'pin:11111', staffCode: 'S-TTTT', displayName: 'Tom' },
      { accountId: PLOY, status: 'active', pinHash: 'pin:22222', staffCode: 'S-PPPP', displayName: 'Ploy' },
    ],
    verifySecret: async (hash, secret) => hash === `pin:${secret}`,
    randomIndex: seededIndex(nextSeed++),
    now: () => now,
  });
  return { db, store, booth, submitted };
}

type Harness = ReturnType<typeof open>;

async function publish(h: Harness, raw: Record<string, unknown>, cursorSeq = 1): Promise<void> {
  await h.store.init(BOX_ID);
  await h.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq,
    payload: { items: [raw] },
    appliedAt: AT,
  });
  await h.booth.refresh();
}

function voucherData(job: RenderPrintJob | undefined): BoothVoucherData {
  assert.ok(job, 'nothing was printed');
  if (job.kind !== 'booth_voucher') throw new Error('not a booth voucher');
  return job.data;
}

/** One press, printed; what the Staff row said and whom the spin named. */
async function press(h: Harness, key: string): Promise<{ staff: string | null; staffAccountId: string | null; data: BoothVoucherData }> {
  const spin = await h.booth.spin({ idempotencyKey: key });
  await h.booth.print({ spinId: spin.spinId });
  const data = voucherData(h.submitted[h.submitted.length - 1]);
  return { staff: data.staff ?? null, staffAccountId: spin.staffAccountId, data };
}

const rosterToday = (people: Roster['people'], date = TODAY): Roster => ({ date, people });

test('the Staff row is every name on today’s roster, casuals included', async () => {
  const h = open();
  await publish(
    h,
    item(
      rosterToday([
        { accountId: TOM, displayName: 'Tom' },
        { accountId: null, displayName: 'Jerry' },
      ]),
    ),
  );
  const out = await press(h, 'press-1');
  assert.equal(out.staff, 'Tom and Jerry');
  // Nobody signed in: the spin is unattributed underneath, as today.
  assert.equal(out.staffAccountId, null);
  h.db.close();
});

test('a single name on the roster prints alone', async () => {
  const h = open();
  await publish(h, item(rosterToday([{ accountId: TOM, displayName: 'Tom' }])));
  assert.equal((await press(h, 'press-1')).staff, 'Tom');
  h.db.close();
});

test('a stand-in who signs in joins the label; the spin records them alone', async () => {
  const h = open();
  await publish(
    h,
    item(
      rosterToday([
        { accountId: TOM, displayName: 'Tom' },
        { accountId: null, displayName: 'Jerry' },
      ]),
    ),
  );
  // Nok is on the standing list and not on today's roster.
  assert.deepEqual(await h.booth.signIn({ pin: '73910' }), { ok: true, accountId: NOK });
  const out = await press(h, 'press-1');
  assert.equal(out.staff, 'Tom, Jerry and Nok');
  assert.equal(out.staffAccountId, NOK);
  h.db.close();
});

test('somebody on the roster who signs in is not said twice', async () => {
  const h = open();
  await publish(
    h,
    item(
      rosterToday([
        { accountId: TOM, displayName: 'Tom' },
        { accountId: null, displayName: 'Jerry' },
      ]),
    ),
  );
  // Tom is on the roster only — sign-in eligibility is the union (D5.2).
  assert.deepEqual(await h.booth.signIn({ pin: '11111' }), { ok: true, accountId: TOM });
  const out = await press(h, 'press-1');
  assert.equal(out.staff, 'Tom and Jerry');
  assert.equal(out.staffAccountId, TOM);
  h.db.close();
});

test('somebody on neither the standing list nor the roster cannot sign in', async () => {
  const h = open();
  await publish(h, item(rosterToday([{ accountId: TOM, displayName: 'Tom' }])));
  const refused = await h.booth.signIn({ pin: '22222' });
  assert.equal(refused.ok, false);
  h.db.close();
});

test('yesterday’s roster names nobody today, and gives nobody sign-in', async () => {
  const h = open();
  await publish(h, item(rosterToday([{ accountId: TOM, displayName: 'Tom' }], '2026-09-20')));
  assert.equal((await h.booth.signIn({ pin: '11111' })).ok, false);
  assert.equal((await press(h, 'press-1')).staff, null);
  h.db.close();
});

test('before anyone is attributed today, an empty roster prints exactly the slip an older cloud’s entry prints — signed in or not', async () => {
  // The differential: the same booth and the same press, once with no roster
  // field at all (an older cloud) and once with an empty roster for today.
  // Scoped to "before anyone is attributed today": the cloud self-assigns a
  // stand-in at their first sign-in, and from the next pull the roster is
  // non-empty and the label is names only (the owner's format ruling).
  const results: Array<{ signedIn: string | null; nobody: string | null; bytes: Buffer }> = [];
  for (const raw of [item(), item(rosterToday([]))]) {
    const h = open();
    await publish(h, raw);
    const nobody = (await press(h, 'press-1')).staff;
    await h.booth.signIn({ pin: '73910' });
    const out = await press(h, 'press-2');
    const device = escposProfile({ id: 'booth', label: 'Booth printer', model: 'sample', widthDots: 576 });
    // Render with the code and the time pinned, so the bytes compare the slip and not the draw.
    const pinned = { ...out.data, voucherCode: 'B1XXXXXX', issuedAt: '21 Sep 2026 13:00', expiresAt: null };
    results.push({
      signedIn: out.staff,
      nobody,
      bytes: Buffer.from(renderJob({ kind: 'booth_voucher', data: pinned }, { device }).bytes),
    });
    h.db.close();
  }
  const [older, empty] = results;
  assert.equal(older!.signedIn, 'Nok (S-7KMQ)');
  assert.equal(empty!.signedIn, 'Nok (S-7KMQ)');
  assert.equal(older!.nobody, null);
  assert.equal(empty!.nobody, null);
  assert.ok(older!.bytes.equals(empty!.bytes), 'the slip is not byte-identical');
});

test('a roster the box cannot read is dropped, never the booth', async () => {
  const h = open();
  await publish(h, item({ date: 'yesterday', people: 'Tom' }));
  // The wheel was adopted and plays; the Staff row falls back as with no roster.
  assert.equal((await press(h, 'press-1')).staff, null);
  h.db.close();
});

test('a box built before the roster reads an entry carrying one', () => {
  const older = BoothCacheEntrySchema.omit({ dutyRoster: true });
  const parsed = older.safeParse(item(rosterToday([{ accountId: TOM, displayName: 'Tom' }])));
  assert.equal(parsed.success, true);
  assert.equal('dutyRoster' in (parsed.success ? parsed.data : {}), false);
  // And this box keeps it.
  const current = BoothCacheEntrySchema.parse(item(rosterToday([{ accountId: null, displayName: 'Jerry' }])));
  assert.deepEqual((current as BoothCacheEntry).dutyRoster, {
    date: TODAY,
    people: [{ accountId: null, displayName: 'Jerry' }],
  });
});
