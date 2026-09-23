import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BOOTH_PRESS_COUNTER_SCOPE,
  BOOTH_PRIZE_COUNTER_SCOPE,
  createBooth,
  type Booth,
  type BoothCacheEntry,
  type BoothPrintPort,
  type BoothPrintSubmitOutcome,
} from '../src/booth';
import { canonicalSyncBytes, type SyncEventEnvelope } from '../src/contract';
import type { PrintJob as RenderPrintJob } from '@oto/print';
import { generateSyncKeyPair, payloadHash, verifyCanonical } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import { BOX_ID, BRANCH_ID, OPERATOR_ID } from './_support';

/**
 * The booth with no internet, across a real restart (S2-07a).
 *
 * The acceptance criterion in one sentence: **three children spin, the mall's
 * link is down, somebody pulls the power, and afterwards the park still owes
 * three vouchers and can prove which.**
 *
 * **A real restart, on a real file.** Everything else in this package tests
 * SQLite in memory, where "restart" would mean nothing — the database dies
 * with the handle. Here the store is a file in a temporary directory, the
 * handle is closed, every object is dropped, and a new store and a new booth
 * are opened on the same bytes. That is the shape of the thing being claimed;
 * a fake would only prove the fake.
 *
 * **What this file does NOT build, stated plainly.** It does not build
 * `createBoxAgent`. That file reaches `printing/index.ts`, which imports
 * `@oto/print`, which this package's test runner cannot load at all — Node's
 * strip-only mode refuses `Bitmap1`'s parameter properties, measured as
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. So what restarts below is the BOOTH
 * MODULE and its store, which is where every durable thing in this ticket
 * lives: the outbox rows, their signatures, the daily counters, the press
 * guard and the unprinted vouchers. The agent adds wiring on top of that —
 * when to call `refresh`, where the heartbeat's booth block goes, which
 * outcomes route to the outbox — and none of it is state that survives a
 * power cut, because none of it is on disk.
 *
 * **"Signed such that the cloud accepts them"** is checked with the cloud's
 * own check: `canonicalSyncBytes` over the stored envelope plus the box id,
 * then `verifyCanonical` against the PUBLIC half of the box's key — the half
 * that went up at registration and sits in `core.box.sync_public_key`, which
 * is the whole reason the keyring exists. The box id is added back by the
 * verifier rather than carried in the envelope, exactly as the cloud does it,
 * so a box could not express a fact attributed to another one even if it
 * tried.
 */

const STATION_ID = '018f1d2c-0000-7000-8000-0000000057b1';
const LAYOUT_ID = '018f1d2c-0000-7000-8000-00000000fa00';
const CONFIG_VERSION_ID = '018f1d2c-0000-7000-8000-00000000fc01';
const AT = '2026-09-21T06:00:00.000Z';
const BUSINESS_DATE = '2026-09-21';

/** The keypair the box minted at registration and keeps in its credential file. */
const keys = generateSyncKeyPair();

function prize(index: number, weightBp: number) {
  return {
    id: `018f1d2c-0000-7000-8000-00000000fa1${index}`,
    nameEn: `Prize ${index}`,
    nameTh: 'รางวัล',
    wheelLabel: null,
    weightBp,
    active: true,
    dailyCap: null,
    expiryDays: 14,
    costSatang: 15_000,
    sliceColor: null,
    textColor: null,
    sortOrder: index,
    voucherDefinitionId: `018f1d2c-0000-7000-8000-00000000fd0${index}`,
  };
}

const CACHED: BoothCacheEntry = {
  stationId: STATION_ID,
  configVersionId: CONFIG_VERSION_ID,
  version: 3,
  bundleHash: 'a'.repeat(64),
  allowedStaff: [],
  voucherDefinitions: [],
  bundle: {
    schemaVersion: 1,
    settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
    layout: { id: LAYOUT_ID, name: 'Classic wheel', version: 2, design: {}, assetManifest: {} },
    prizes: [prize(0, 4000), prize(1, 6000)],
  },
};

interface Box {
  db: DatabaseSync;
  store: SqlBoxStore;
  booth: Booth;
  /** Print jobs this run handed to the printer. */
  submissions: string[];
  close(): void;
}

/**
 * Boot the booth on a file, as a Pi does on every power-up.
 *
 * `printOutcome` models the printer: `queued` is a machine that has taken the
 * job and not produced paper — out of paper, or waiting its turn — which is
 * the state a voucher has to survive a restart in.
 */
function bootBooth(file: string, printOutcome: BoothPrintSubmitOutcome['status'] = 'queued'): Box {
  const db = new DatabaseSync(file);
  prepareSqliteBoxStore(db);
  const now = new Date(AT);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => now });
  const submissions: string[] = [];
  const port: BoothPrintPort = {
    async submit(request) {
      submissions.push(request.id);
      return {
        id: request.id,
        status: printOutcome,
        attempts: 1,
        deviceId: '018f1d2c-0000-7000-8000-00000000de01',
        errorCode: null,
        errorMessage: null,
      };
    },
  };
  const booth = createBooth({
    boxId: BOX_ID,
    store,
    station: () => ({ id: STATION_ID, name: 'Booth 1', codePrefix: 'B1' }),
    branch: () => ({
      id: BRANCH_ID,
      operatorId: OPERATOR_ID,
      name: 'HKT Central',
      timezone: 'Asia/Bangkok',
      businessDayStart: '05:00',
    }),
    privateKey: () => keys.privateKeyPem,
    print: port,
    /**
     * **No push, no fetch, no base URL — there is nowhere to pass one** (D2).
     * `createBooth` takes no transport at all, so "with no line" is not a flag
     * this test sets: it is the only state the module has. An offline demo
     * whose browser is quietly talking to a reachable cloud proves nothing, so
     * the illegal call is unrepresentable rather than merely switched off.
     */
    now: () => now,
  });
  return { db, store, booth, submissions, close: () => db.close() };
}

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'oto-booth-')), `${name}.sqlite`);
}

/**
 * The code on a stored job's paper, narrowed rather than cast.
 *
 * `PrintJob` is a union and the narrowing is itself an assertion: a job that
 * came back off the disk as some other kind is a failure worth seeing, not a
 * field to read through a cast that would keep compiling.
 */
function voucherCodeOf(job: RenderPrintJob): string {
  assert.equal(job.kind, 'booth_voucher');
  if (job.kind !== 'booth_voucher') throw new Error('unreachable');
  return job.data.voucherCode;
}

/** The cloud's own check, run here so the test does not need an api. */
function accepts(event: SyncEventEnvelope): boolean {
  const canonical = canonicalSyncBytes({ ...event, boxId: BOX_ID });
  if (payloadHash(canonical) !== event.payloadHash) return false;
  return verifyCanonical(canonical, event.sig, keys.publicKeyPem);
}

test('three spins with no line survive a restart, still pending and still verifiable', async () => {
  const file = tempFile('booth-offline');

  // --- Before the power cut ------------------------------------------------
  const first = bootBooth(file);
  await first.store.init(BOX_ID);
  await first.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 9,
    payload: { items: [CACHED] },
    appliedAt: AT,
  });
  await first.booth.start();
  assert.equal(first.booth.config()?.version, 3, 'the wheel came off the disk, not off a wire');

  const before: { spinId: string; code: string }[] = [];
  for (let press = 1; press <= 3; press += 1) {
    const response = await first.booth.spin({ idempotencyKey: `press-${press}` });
    assert.notEqual(response.voucherCode, null, 'a code is minted with no internet at all');
    assert.equal(response.printState, 'queued');
    before.push({ spinId: response.spinId, code: response.voucherCode! });
  }
  assert.equal(first.submissions.length, 3);
  assert.equal((await first.store.depth(BOX_ID)).queued, 6, 'three spins and three vouchers');

  const codes = new Set(before.map((b) => b.code));
  assert.equal(codes.size, 3, 'three distinct codes');

  // Pull the plug: close the handle and drop every object built on it.
  first.booth.stop();
  first.close();

  // --- After the power cut -------------------------------------------------
  const second = bootBooth(file);
  const state = await second.store.init(BOX_ID);
  await second.booth.start();

  assert.equal(second.booth.config()?.version, 3, 'the booth came back on the same wheel');

  const batch = await second.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 6, 'nothing was lost and nothing was invented');

  /**
   * Every one of them is still a fact the cloud would take: the hash still
   * describes the bytes, and the signature still verifies against the public
   * half the cloud holds for this box. Signing happened inside the same
   * transaction that allocated the sequence, so a restart cannot have left a
   * sealed envelope whose sequence was rolled back or a sequence with no
   * envelope behind it.
   */
  for (const event of batch.events) {
    assert.equal(accepts(event), true, `${event.type} #${event.boxSeq} is not acceptable`);
  }

  assert.deepEqual(
    batch.events.map((e) => e.type),
    [
      'booth.spin_recorded',
      'promo.voucher_issued',
      'booth.spin_recorded',
      'promo.voucher_issued',
      'booth.spin_recorded',
      'promo.voucher_issued',
    ],
    'in journal order, each spin beside its own voucher',
  );
  assert.deepEqual(
    batch.events.map((e) => e.boxSeq),
    [1, 2, 3, 4, 5, 6],
    'gapless: a gap is indistinguishable from a lost event',
  );
  for (const event of batch.events) {
    assert.equal(event.journalEpoch, state.journalEpoch);
    assert.equal(event.payload.businessDate, BUSINESS_DATE);
  }
  assert.deepEqual(
    batch.events.filter((e) => e.type === 'booth.spin_recorded').map((e) => e.payload.spinId),
    before.map((b) => b.spinId),
    'the same three spins, under the same three ids',
  );
  assert.deepEqual(
    batch.events.filter((e) => e.type === 'promo.voucher_issued').map((e) => e.payload.code),
    before.map((b) => b.code),
    'and the same three codes, which are the ones on the paper',
  );

  // --- The rest of what a power cut must not lose --------------------------
  const pending = await second.store.loadPendingPrintJobs(BOX_ID);
  assert.equal(pending.length, 3, 'three vouchers are still waiting on paper');
  assert.deepEqual(
    pending.map((job) => voucherCodeOf(job.job)).sort(),
    [...codes].sort(),
    'and they are the same three vouchers, with their codes intact through jsonb',
  );
  for (const job of pending) {
    assert.equal(second.booth.ownsPrintJob(job.id), true, 'adopted, so their outcomes go to the outbox (D20)');
  }

  const counters = await second.store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, BUSINESS_DATE);
  assert.equal(
    Object.values(counters).reduce((sum, n) => sum + n, 0),
    3,
    'the daily caps counted three, which is what stops a restart resetting a cap',
  );

  second.booth.stop();
  second.close();
});

test('a spin after the restart continues the journal rather than reusing sequences', async () => {
  const file = tempFile('booth-continues');
  const first = bootBooth(file);
  await first.store.init(BOX_ID);
  await first.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 1,
    payload: { items: [CACHED] },
    appliedAt: AT,
  });
  await first.booth.start();
  await first.booth.spin({ idempotencyKey: 'press-1' });
  first.booth.stop();
  first.close();

  const second = bootBooth(file);
  await second.store.init(BOX_ID);
  await second.booth.start();
  await second.booth.spin({ idempotencyKey: 'press-2' });

  const batch = await second.store.takeBatch(BOX_ID, { now: AT });
  assert.deepEqual(
    batch.events.map((e) => e.boxSeq),
    [1, 2, 3, 4],
    'the sequence generator is a row, not a variable — it does not restart at 1',
  );
  for (const event of batch.events) assert.equal(accepts(event), true);
  second.booth.stop();
  second.close();
});

test('the press guard outlives the power cut, so a retried press is never a second prize', async () => {
  const file = tempFile('booth-press-guard');
  const first = bootBooth(file);
  await first.store.init(BOX_ID);
  await first.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 1,
    payload: { items: [CACHED] },
    appliedAt: AT,
  });
  await first.booth.start();
  await first.booth.spin({ idempotencyKey: 'press-1' });
  first.booth.stop();
  first.close();

  const presses = await (async () => {
    const box = bootBooth(file);
    await box.store.init(BOX_ID);
    const counters = await box.store.readCounters(
      BOX_ID,
      BOOTH_PRESS_COUNTER_SCOPE,
      BUSINESS_DATE,
    );
    box.close();
    return counters;
  })();
  assert.equal(presses['press-1'], 1, 'the press is remembered on disk, not in a process');

  const second = bootBooth(file);
  await second.store.init(BOX_ID);
  await second.booth.start();
  await assert.rejects(
    () => second.booth.spin({ idempotencyKey: 'press-1' }),
    /already recorded/,
    'a retry of a press this process cannot answer for is refused, not redrawn',
  );
  const batch = await second.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 2, 'still exactly one spin and one voucher');
  second.booth.stop();
  second.close();
});

test('the day’s spin cap holds with no line and across the power cut (SCRUM-257)', async () => {
  /**
   * "Spins per day" is a limit set in the Console, and the booth it limits is
   * a Raspberry Pi in a mall that may not have spoken to the cloud since this
   * morning. So the count is the BOX's own, kept in the same counter table as
   * the per-prize caps and therefore on the same disk — nothing here asks
   * anybody's permission to refuse, and there is nobody to ask.
   *
   * The restart is the point of testing it here rather than only in
   * `booth.test.ts`: a cap kept in a process is a cap that resets whenever a
   * cleaner unplugs the television, which is a booth that hands out a second
   * day's prizes for the price of a power strip.
   */
  const file = tempFile('booth-spin-cap');
  const capped: BoothCacheEntry = {
    ...CACHED,
    version: 4,
    bundleHash: 'b'.repeat(64),
    bundle: { ...CACHED.bundle, settings: { ...CACHED.bundle.settings, dailySpinCap: 2 } },
  };

  const first = bootBooth(file);
  await first.store.init(BOX_ID);
  await first.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 1,
    payload: { items: [capped] },
    appliedAt: AT,
  });
  await first.booth.start();
  await first.booth.spin({ idempotencyKey: 'press-1' });
  first.booth.stop();
  first.close();

  const second = bootBooth(file);
  await second.store.init(BOX_ID);
  await second.booth.start();
  // The second of the two, after the plug came out. The booth still owes one.
  await second.booth.spin({ idempotencyKey: 'press-2' });
  await assert.rejects(
    () => second.booth.spin({ idempotencyKey: 'press-3' }),
    /all the spins it is allowed today/,
    'the count came off the disk, so the restart did not give the booth a fresh day',
  );

  const batch = await second.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 4, 'two spins and two vouchers — the third press minted none');
  for (const event of batch.events) assert.equal(accepts(event), true);
  assert.equal(
    (await second.store.loadPendingPrintJobs(BOX_ID)).length,
    2,
    'and there are two slips to print, not three',
  );
  second.booth.stop();
  second.close();
});
