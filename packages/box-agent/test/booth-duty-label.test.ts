import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BoothCacheEntrySchema,
  createBooth,
  type BoothCacheEntry,
  type BoothPrintPort,
} from '../src/booth';
import { createBoothHttp } from '../src/booth-http';
import { generateSyncKeyPair } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { BoothVoucherData, PrintJob as RenderPrintJob } from '@oto/print';
import { escposProfile, renderJob } from '@oto/print';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, seededIndex } from './_support';

/**
 * SCRUM-473, SCRUM-694 — the day's booth staff on the box.
 *
 * Nobody signs in at the booth. The voucher's Staff row is the MERGED label
 * of today's roster ("Tom and Jerry"), from Console → Booths → Today's staff;
 * with nobody on today's roster it is "unattributed", and the press is never
 * blocked. The spin carries the same label to the cloud, with the rostered
 * accounts, and the facts are filed by the device, not by an account.
 */

const STATION_ID = '018f1d2c-0000-7000-8000-0000000047a1';
const LAYOUT_ID = '018f1d2c-0000-7000-8000-00000000fa00';
const CONFIG_VERSION_ID = '018f1d2c-0000-7000-8000-00000000fc01';
const DEFINITION_ID = '018f1d2c-0000-7000-8000-00000000fd01';
/** On the standing list of an older cloud: Nok. */
const NOK = '018f1d2c-0000-7000-8000-00000000fb01';
/** On today's roster: Tom. */
const TOM = '018f1d2c-0000-7000-8000-00000000fb02';
/** 13:00 in Bangkok: trading day 2026-09-21. */
const AT = '2026-09-21T06:00:00.000Z';
const TODAY = '2026-09-21';

const keys = generateSyncKeyPair();
let nextSeed = 473;

type Roster = { date: string; people: Array<{ accountId: string | null; displayName: string }> };

/**
 * The cache item as the cloud serves it; `dutyRoster` absent is an older cloud.
 * `allowedStaff` is what a cloud older than SCRUM-694 still sends beside it.
 */
function item(dutyRoster?: Roster | unknown, settings: Record<string, unknown> = {}): Record<string, unknown> {
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
    randomIndex: seededIndex(nextSeed++),
    now: () => now,
  });
  return { db, store, booth, submitted };
}

type Harness = ReturnType<typeof open>;

async function publish(h: Harness, raw: Record<string, unknown>, cursorSeq = 1): Promise<boolean> {
  await h.store.init(BOX_ID);
  await h.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq,
    payload: { items: [raw] },
    appliedAt: AT,
  });
  return h.booth.refresh();
}

function voucherData(job: RenderPrintJob | undefined): BoothVoucherData {
  assert.ok(job, 'nothing was printed');
  if (job.kind !== 'booth_voucher') throw new Error('not a booth voucher');
  return job.data;
}

/** One press, printed; what the Staff row said and what the press answered. */
async function press(h: Harness, key: string): Promise<{ staff: string | null; staffLabel: string | null; data: BoothVoucherData }> {
  const spin = await h.booth.spin({ idempotencyKey: key });
  await h.booth.print({ spinId: spin.spinId });
  const data = voucherData(h.submitted[h.submitted.length - 1]);
  return { staff: data.staff ?? null, staffLabel: spin.staffLabel ?? null, data };
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
  assert.equal(out.staffLabel, 'Tom and Jerry', 'the press answers what the slip printed');

  // The spin carries the same label and the rostered accounts — the casual
  // has none — and both facts are filed by the device, with no account.
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  const spin = batch.events.find((e) => e.type === 'booth.spin_recorded');
  const voucher = batch.events.find((e) => e.type === 'promo.voucher_issued');
  assert.equal(spin?.payload.staffLabel, 'Tom and Jerry');
  assert.deepEqual(spin?.payload.dutyAccountIds, [TOM]);
  assert.equal('staffAccountId' in (spin?.payload ?? {}), false);
  for (const fact of [spin, voucher]) {
    assert.equal(fact?.actorKind, 'device', `${fact?.type} is filed by the device`);
    assert.equal(fact?.actorAccountId ?? null, null, `${fact?.type} names no account`);
  }
  h.db.close();
});

test('a single name on the roster prints alone', async () => {
  const h = open();
  await publish(h, item(rosterToday([{ accountId: TOM, displayName: 'Tom' }])));
  assert.equal((await press(h, 'press-1')).staff, 'Tom');
  h.db.close();
});

test('the label travels whatever the slip shows: a booth that hides the Staff row still attributes the spin', async () => {
  const h = open();
  await publish(h, item(rosterToday([{ accountId: TOM, displayName: 'Tom' }]), { voucherShowStaff: false }));
  const out = await press(h, 'press-1');
  assert.equal(out.data.showStaff, false);
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.find((e) => e.type === 'booth.spin_recorded')?.payload.staffLabel, 'Tom');
  h.db.close();
});

test('a simulated press answers the label too, and records nothing', async () => {
  const h = open();
  await publish(h, item(rosterToday([{ accountId: TOM, displayName: 'Tom' }])));
  const simulated = await h.booth.spin({ idempotencyKey: 'sim-1', simulate: true });
  assert.equal(simulated.staffLabel, 'Tom');
  assert.equal('staffAccountId' in simulated, false);
  assert.equal((await h.store.takeBatch(BOX_ID, { now: AT })).events.length, 0);
  h.db.close();
});

test('yesterday’s roster names nobody today', async () => {
  const h = open();
  await publish(h, item(rosterToday([{ accountId: TOM, displayName: 'Tom' }], '2026-09-20')));
  const out = await press(h, 'press-1');
  assert.equal(out.staff, null);
  assert.equal(out.staffLabel, null);
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  const spin = batch.events.find((e) => e.type === 'booth.spin_recorded');
  assert.equal(spin?.payload.staffLabel, null);
  assert.deepEqual(spin?.payload.dutyAccountIds, []);
  h.db.close();
});

test('an empty roster prints the byte-identical slip an older cloud’s entry prints', async () => {
  // The differential: the same booth and the same press, once with no roster
  // field at all (an older cloud) and once with an empty roster for today.
  const results: Array<{ staff: string | null; bytes: Buffer }> = [];
  for (const raw of [item(), item(rosterToday([]))]) {
    const h = open();
    await publish(h, raw);
    const out = await press(h, 'press-1');
    const device = escposProfile({ id: 'booth', label: 'Booth printer', model: 'sample', widthDots: 576 });
    // Render with the code and the time pinned, so the bytes compare the slip and not the draw.
    const pinned = { ...out.data, voucherCode: 'B1XXXXXX', issuedAt: '21 Sep 2026 13:00', expiresAt: null };
    results.push({
      staff: out.staff,
      bytes: Buffer.from(renderJob({ kind: 'booth_voucher', data: pinned }, { device }).bytes),
    });
    h.db.close();
  }
  const [older, empty] = results;
  assert.equal(older!.staff, null);
  assert.equal(empty!.staff, null);
  assert.ok(older!.bytes.equals(empty!.bytes), 'the slip is not byte-identical');
});

test('a roster the box cannot read is dropped, never the booth', async () => {
  const h = open();
  await publish(h, item({ date: 'yesterday', people: 'Tom' }));
  // The wheel was adopted and plays; the Staff row falls back as with no roster.
  assert.equal((await press(h, 'press-1')).staff, null);
  h.db.close();
});

test('the television’s status names today’s roster, and nothing on another day or with none', async () => {
  for (const [roster, expected] of [
    [rosterToday([{ accountId: TOM, displayName: 'Tom' }, { accountId: null, displayName: 'Jerry' }]), 'Tom and Jerry'],
    [rosterToday([{ accountId: TOM, displayName: 'Tom' }], '2026-09-20'), null],
    [undefined, null],
  ] as const) {
    const h = open();
    await publish(h, item(roster));
    const handle = createBoothHttp({ booth: h.booth, online: () => true });
    const status = (await handle({ method: 'GET', path: '/status' })).body as Record<string, unknown>;
    assert.equal(status.dutyLabel, expected);
    assert.equal(JSON.stringify(status).includes(TOM), false, 'never an account id');
    const beat = await h.booth.heartbeat();
    assert.equal(beat?.rostered, expected !== null);
    h.db.close();
  }
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

test('an older cloud’s entry — allowedStaff and a session length — still applies, and the sent hash decides', async () => {
  const h = open();
  const older = item(rosterToday([{ accountId: TOM, displayName: 'Tom' }]), { staffSessionMinutes: 600 });
  // Parsed: the retired fields are dropped, never refused.
  const parsed = BoothCacheEntrySchema.parse(older);
  assert.equal('allowedStaff' in parsed, false);
  assert.equal('staffSessionMinutes' in parsed.bundle.settings, false);

  assert.equal(await publish(h, older), true, 'applied');
  assert.equal(h.booth.config()?.version, 1);
  assert.equal((await press(h, 'press-1')).staff, 'Tom');

  // The same entry again, as the next pull delivers it: the box compares the
  // hash the cloud sent, not one of the document it parsed, so nothing is
  // re-applied for the field it dropped.
  assert.equal(await publish(h, older, 2), false, 'no re-apply');
  h.db.close();
});
