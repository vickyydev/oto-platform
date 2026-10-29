import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BOOTH_PRESS_COUNTER_SCOPE,
  BOOTH_PRIZE_COUNTER_SCOPE,
  BoothRefusal,
  createBooth,
  type BoothModule,
  type BoothCacheEntry,
  type BoothPrintPort,
} from '../src/booth';
import { createBoothHttp } from '../src/booth-http';
import { generateSyncKeyPair } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { BoothVoucherData, PrintJob as RenderPrintJob } from '@oto/print';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, seededIndex } from './_support';

/**
 * SCRUM-223, SCRUM-694 — the reprint, today's roster and two booths on one
 * box. Nobody signs in at the booth: the slip names today's roster, and
 * anyone at the screen may ask for a copy of the last voucher, which is the
 * same code marked "Reprint" and is recorded with no account.
 *
 * Built against the booth module and a real SQLite FILE, so "survives a
 * restart" is a store closed and opened again rather than a claim.
 */

const STATION_A = '018f1d2c-0000-7000-8000-0000000057c1';
const STATION_B = '018f1d2c-0000-7000-8000-0000000057c2';
const ACCOUNT = '018f1d2c-0000-7000-8000-00000000fb11';
/** 13:00 in Bangkok: trading day 2026-09-24. */
const AT = '2026-09-24T06:00:00.000Z';
const TODAY = '2026-09-24';
const keys = generateSyncKeyPair();
/**
 * Each harness draws from its own seed, so two opened on one file — a restart —
 * do not mint the same code twice.
 */
let nextSeed = 0x5eed0223;

function prize(n: number, weightBp: number, active = true) {
  return {
    id: `018f1d2c-0000-7000-8000-00000000fa2${n}`,
    nameEn: `Prize ${n}`,
    nameTh: null,
    wheelLabel: null,
    weightBp,
    active,
    dailyCap: null,
    expiryDays: 14,
    costSatang: 5_000,
    sliceColor: null,
    textColor: null,
    sortOrder: n,
    voucherDefinitionId: `018f1d2c-0000-7000-8000-00000000fd2${n}`,
  };
}

function entry(over: Partial<BoothCacheEntry> = {}): BoothCacheEntry {
  return {
    stationId: STATION_A,
    configVersionId: '018f1d2c-0000-7000-8000-00000000fc21',
    version: 1,
    bundleHash: 'a'.repeat(64),
    dutyRoster: null,
    voucherDefinitions: [
      {
        id: '018f1d2c-0000-7000-8000-00000000fd21',
        termsEn: 'Cannot be combined with other offers.',
        termsTh: null,
        expiryDays: 14,
        fixedCode: null,
      },
    ],
    bundle: {
      schemaVersion: 1,
      settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
      layout: {
        id: '018f1d2c-0000-7000-8000-00000000fa00',
        name: 'Classic wheel',
        version: 1,
        design: {},
        assetManifest: {},
      },
      prizes: [prize(1, 10_000), prize(2, 0, false)],
    },
    ...over,
  };
}

interface Harness {
  booth: BoothModule;
  store: SqlBoxStore;
  submitted: Array<{ id: string; job: RenderPrintJob }>;
  setNow(iso: string): void;
  setStation(id: string | null): void;
  /**
   * Hold every print handed to the port from now on until the returned
   * function is called: a printer that has the job and has not answered.
   */
  holdPrints(): () => void;
  close(): void;
}

function open(options: {
  file?: string;
  station?: string | null;
  print?: boolean;
  /** How long a press or a reprint waits on the printer. The booth's default unless set. */
  printWaitMs?: number;
} = {}): Harness {
  const db = new DatabaseSync(options.file ?? ':memory:');
  prepareSqliteBoxStore(db);
  let now = new Date(AT);
  let station: string | null = options.station === undefined ? STATION_A : options.station;
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => now });
  const submitted: Harness['submitted'] = [];
  let held: Promise<void> | null = null;
  const port: BoothPrintPort = {
    async submit(request) {
      submitted.push({ id: request.id, job: request.job });
      if (held) await held;
      return { id: request.id, status: 'printed', attempts: 1, deviceId: null, errorCode: null, errorMessage: null };
    },
  };
  const booth = createBooth({
    boxId: BOX_ID,
    store,
    station: () =>
      station === null
        ? null
        : { id: station, name: station === STATION_A ? 'Booth A' : 'Booth B', codePrefix: station === STATION_A ? 'BA' : 'BB' },
    branch: () => ({
      id: BRANCH_ID,
      operatorId: OPERATOR_ID,
      name: 'Oto Play Park, Central Floresta',
      timezone: 'Asia/Bangkok',
      businessDayStart: '05:00',
    }),
    privateKey: () => keys.privateKeyPem,
    print: options.print === false ? null : port,
    // A varying source, as a booth has (see `seededIndex` for why a constant
    // one will not do). The draw itself does not care — one prize carries all
    // the weight.
    randomIndex: seededIndex(nextSeed++),
    ...(options.printWaitMs === undefined ? {} : { printWaitMs: options.printWaitMs }),
    now: () => now,
  });
  return {
    booth,
    store,
    submitted,
    setNow(iso) {
      now = new Date(iso);
    },
    setStation(id) {
      station = id;
    },
    holdPrints() {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = gate;
      return () => {
        if (held === gate) held = null;
        release();
      };
    },
    close: () => db.close(),
  };
}

/** Give everything already under way five turns of the event loop to run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function publish(h: Harness, entries: BoothCacheEntry[], appliedAt = AT): Promise<void> {
  await h.store.init(BOX_ID);
  await h.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 1,
    payload: { items: entries },
    appliedAt,
  });
  await h.booth.refresh();
}

const plus = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const voucherData = (job: RenderPrintJob | undefined): BoothVoucherData => {
  assert.equal(job?.kind, 'booth_voucher');
  return (job as { data: BoothVoucherData }).data;
};

// --- Today's roster ---------------------------------------------------------

test('a roster or terms change reaches the booth without a new publish', async () => {
  const h = open();
  await publish(h, [entry()]);
  const before = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: before.spinId });
  assert.equal(voucherData(h.submitted.at(-1)?.job).staff, null, 'nobody on the roster yet');

  // Same version, same wheel, today's roster beside it.
  await publish(
    h,
    [entry({ dutyRoster: { date: TODAY, people: [{ accountId: ACCOUNT, displayName: 'Tom' }] } })],
    plus(1),
  );
  assert.equal(h.booth.config()?.version, 1);
  const after = await h.booth.spin({ idempotencyKey: 'press-2' });
  await h.booth.print({ spinId: after.spinId });
  assert.equal(voucherData(h.submitted.at(-1)?.job).staff, 'Tom');
  assert.equal(after.staffLabel, 'Tom');
  h.close();
});

// --- Two booths on one box -------------------------------------------------

test('a box with two booths runs the chosen one, and none until one is chosen', async () => {
  const h = open({ station: null });
  await publish(h, [
    entry(),
    entry({ stationId: STATION_B, version: 1, bundleHash: 'b'.repeat(64) }),
  ]);
  assert.equal(h.booth.config(), null, 'no booth chosen: no wheel, rather than a guess');

  h.setStation(STATION_B);
  assert.equal(await h.booth.refresh(), true);
  const spin = await h.booth.spin({ idempotencyKey: 'b-press' });
  await h.booth.print({ spinId: spin.spinId });
  assert.match(spin.voucherCode ?? '', /^BB/, 'Booth B’s prefix on Booth B’s voucher');

  h.setStation(STATION_A);
  await h.booth.refresh();
  const other = await h.booth.spin({ idempotencyKey: 'a-press' });
  await h.booth.print({ spinId: other.spinId });
  assert.match(other.voucherCode ?? '', /^BA/);
  h.close();
});

// --- Reprint ---------------------------------------------------------------

test('a reprint with nobody signed in prints the same code, names no account, and never draws a second prize', async () => {
  const h = open();
  await publish(h, [entry()]);
  const won = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: won.spinId });
  assert.equal(h.submitted.length, 1);

  const countersBefore = await h.store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, TODAY);
  const depthBefore = (await h.store.depth(BOX_ID)).queued;

  const again = await h.booth.reprint({});
  assert.equal(again.spinId, won.spinId);
  assert.equal(again.printState, 'printed');
  assert.equal(h.submitted.length, 2);
  const copy = voucherData(h.submitted[1]?.job);
  const first = voucherData(h.submitted[0]?.job);
  assert.equal(copy.voucherCode, won.voucherCode, 'the same code');
  assert.equal(copy.voucherCode, first.voucherCode);
  assert.match(copy.reprintNote ?? '', /^Reprint · /);
  assert.equal(copy.staff, first.staff, 'the Staff row of the day it was WON');

  assert.deepEqual(
    await h.store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, TODAY),
    countersBefore,
    'no prize counted',
  );
  assert.equal((await h.store.depth(BOX_ID)).queued, depthBefore, 'no spin, no voucher queued');
  assert.deepEqual(
    await h.store.readCounters(BOX_ID, BOOTH_PRESS_COUNTER_SCOPE, TODAY),
    { 'press-1': 1 },
  );

  // The copy is recorded as a reprint of that voucher, with no account.
  await h.booth.reportPrint({
    id: h.submitted[1]!.id,
    status: 'printed',
    attempts: 1,
    deviceId: null,
    errorCode: null,
    errorMessage: null,
  });
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  const print = batch.events.find((e) => e.type === 'booth.voucher_printed');
  assert.equal(print?.payload.reason, 'reprint');
  assert.equal('requestedByAccountId' in (print?.payload ?? {}), false, 'no account on a reprint');
  assert.equal(print?.payload.voucherCode, won.voucherCode);
  assert.equal(
    batch.events.filter((e) => e.type === 'promo.voucher_issued').length,
    1,
    'one voucher, printed twice',
  );
  h.close();
});

test('a reprint of a named spin, one that is not here, and one after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oto-booth-reprint-'));
  const file = join(dir, 'box.sqlite');
  try {
    const h = open({ file });
    await publish(h, [entry()]);
    const one = await h.booth.spin({ idempotencyKey: 'p1' });
    await h.booth.print({ spinId: one.spinId });
    const two = await h.booth.spin({ idempotencyKey: 'p2' });
    await h.booth.print({ spinId: two.spinId });
    assert.equal((await h.booth.reprint({ spinId: one.spinId })).spinId, one.spinId);
    await assert.rejects(
      () => h.booth.reprint({ spinId: '018f1d2c-0000-7000-8000-0000000000ff' }),
      (err: unknown) => err instanceof BoothRefusal && err.code === 'nothing_to_reprint',
    );
    h.close();

    const restarted = open({ file });
    await restarted.store.init(BOX_ID);
    await restarted.booth.refresh();
    const last = await restarted.booth.reprint({});
    assert.equal(last.spinId, two.spinId, 'the last voucher is still reprintable after a power cut');
    assert.equal(voucherData(restarted.submitted[0]?.job).voucherCode, two.voucherCode);
    restarted.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps a closed SQLite file busy for a moment; the temp folder can wait.
    }
  }
});

test('with no printer a reprint is still recorded, as a skipped print', async () => {
  const h = open({ print: false });
  await publish(h, [entry()]);
  const won = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: won.spinId });
  assert.deepEqual(await h.booth.reprint({}), { spinId: won.spinId, printState: 'no_printer' });
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  const print = batch.events.find((e) => e.type === 'booth.voucher_printed');
  assert.equal(print?.payload.status, 'skipped');
  assert.equal(print?.payload.reason, 'reprint');
  h.close();
});

test('a reprint answers "queued" in time when the printer is slow, and asking again joins the copy on its way', async () => {
  /**
   * Closing audit H1, for the reprint. The panel gives up on a call after six
   * seconds; a reprint used to wait for the printer however long it took, so
   * a slow one made the panel say "The reprint did not go through" while the
   * copy came out, and asking again while it was still printing put a second
   * copy of the same live code on paper.
   */
  const h = open({ printWaitMs: 40 });
  await publish(h, [entry()]);
  const won = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: won.spinId });
  const release = h.holdPrints();

  const first = await h.booth.reprint({});
  assert.deepEqual(
    first,
    { spinId: won.spinId, printState: 'queued' },
    'answered before the printer did',
  );
  assert.equal(h.submitted.length, 2, 'the copy is with the printer');

  const again = await h.booth.reprint({});
  assert.deepEqual(again, first, 'the same copy');
  assert.equal(h.submitted.length, 2, 'and not a second one');

  // The printer finishes the copy. Asking after that is a new copy, as always.
  release();
  await settle();
  const later = await h.booth.reprint({});
  assert.deepEqual(later, { spinId: won.spinId, printState: 'printed' });
  assert.equal(h.submitted.length, 3);
  h.close();
});

test('a slip a restarted box prints before a booth is chosen is filed under its own booth, by code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oto-booth-adopt-'));
  const file = join(dir, 'box.sqlite');
  try {
    const first = open({ file });
    await publish(first, [entry()]);
    const won = await first.booth.spin({ idempotencyKey: 'press-1' });
    await first.booth.print({ spinId: won.spinId });
    const jobId = first.submitted[0]!.id;
    first.close();

    // A box with two booths is back up and nobody has chosen one on the
    // television yet; the paper it still owes comes out first.
    const second = open({ file, station: null });
    await second.store.init(BOX_ID);
    await second.booth.start();
    assert.equal(second.booth.ownsPrintJob(jobId), true, 'adopted');
    await second.booth.reportPrint({
      id: jobId,
      status: 'printed',
      attempts: 2,
      deviceId: null,
      errorCode: null,
      errorMessage: null,
    });
    const batch = await second.store.takeBatch(BOX_ID, { now: AT });
    const print = batch.events.find((e) => e.type === 'booth.voucher_printed');
    assert.ok(print, 'the outcome is queued for the cloud, not dropped for want of a booth');
    assert.equal(print.stationId, STATION_A, 'under the booth the voucher was won at');
    assert.equal(print.payload.voucherCode, won.voucherCode);
    assert.equal(
      'voucherId' in print.payload,
      false,
      'the id a restart lost is left out: the cloud refuses a null one as malformed',
    );
    second.booth.stop();
    second.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps a closed SQLite file busy for a moment; the temp folder can wait.
    }
  }
});

test('a booth started again in the same process keeps what it knows about a slip still waiting', async () => {
  const h = open();
  await publish(h, [entry()]);
  await h.booth.start();
  const won = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: won.spinId });
  const jobId = h.submitted[0]!.id;

  // A `restart` command stops the booth and starts it again while the slip
  // is still waiting on the printer.
  h.booth.stop();
  await h.booth.start();
  await h.booth.reportPrint({
    id: jobId,
    status: 'printed',
    attempts: 2,
    deviceId: null,
    errorCode: null,
    errorMessage: null,
  });
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  const issued = batch.events.find((e) => e.type === 'promo.voucher_issued');
  const printed = batch.events.find((e) => e.type === 'booth.voucher_printed');
  assert.equal(printed?.payload.voucherCode, won.voucherCode);
  assert.ok(issued?.payload.voucherId, 'the voucher was issued with an id');
  assert.equal(
    printed?.payload.voucherId,
    issued?.payload.voucherId,
    'the id this process knew is kept, not replaced by what a cold start could recover',
  );
  h.booth.stop();
  h.close();
});

// --- The /booth/* contract --------------------------------------------------

test('the http contract reprints with nobody signed in, has no staff routes, and names the roster only', async () => {
  const h = open();
  await publish(h, [
    entry({ dutyRoster: { date: TODAY, people: [{ accountId: ACCOUNT, displayName: 'Tom' }] } }),
  ]);
  const handle = createBoothHttp({ booth: h.booth, online: () => false });

  const nothing = await handle({ method: 'POST', path: '/reprint', body: {} });
  assert.equal(nothing.status, 404);
  assert.equal((nothing.body as { error: { code: string } }).error.code, 'nothing_to_reprint');

  await handle({ method: 'POST', path: '/spin', body: { idempotencyKey: 'k1' } });
  const reprinted = await handle({ method: 'POST', path: '/reprint', body: {} });
  assert.equal(reprinted.status, 200, 'no sign-in needed');
  assert.equal((reprinted.body as { printState: string }).printState, 'printed');

  for (const [method, path] of [
    ['GET', '/staff'],
    ['POST', '/staff/sign-in'],
    ['POST', '/staff/sign-out'],
  ] as const) {
    const gone = await handle({ method, path, body: { mode: 'pin', pin: '73910' } });
    assert.equal(gone.status, 404, `${method} ${path} is gone`);
    assert.equal((gone.body as { error: { code: string } }).error.code, 'not_found');
  }
  // S2-21 H8: a staff benefit QR offered where the badge path was signs nobody
  // in and is never counted — there is no path for it to be tried at.
  const badge = await handle({ method: 'POST', path: '/staff/sign-in', body: { mode: 'badge', badge: 'OTOB1.zz-test-benefit-qr' } });
  assert.equal(badge.status, 404, 'a benefit QR at the old badge path reaches nothing');

  const status = await handle({ method: 'GET', path: '/status' });
  const body = status.body as Record<string, unknown>;
  assert.equal(body.dutyLabel, 'Tom');
  assert.equal('staff' in body, false);
  assert.equal('staffSignedIn' in body, false);
  assert.equal(JSON.stringify(body).includes(ACCOUNT), false, 'never the account id');
  h.close();
});
