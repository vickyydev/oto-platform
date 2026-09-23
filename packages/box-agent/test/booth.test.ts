import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BOOTH_PRESS_COUNTER_SCOPE,
  BOOTH_PRIZE_COUNTER_SCOPE,
  BOOTH_SPIN_COUNTER_SCOPE,
  BOOTH_STAFF_THROTTLE_SCOPE,
  BoothRefusal,
  createBooth,
  type Booth,
  type BoothCacheEntry,
  type BoothPrintPort,
  type BoothPrintSubmitOutcome,
  type BoothStaffRecord,
} from '../src/booth';
import { createBoothHttp } from '../src/booth-http';
import { drawPrize } from '../src/booth-draw';
import { generateSyncKeyPair, verifyCanonical } from '../src/signing';
import { canonicalSyncBytes } from '../src/contract';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { BoxStore, CounterKey, PrintJobRecord } from '../src/store';
import type { BoothVoucherData, PrintJob as RenderPrintJob } from '@oto/print';
import { BOX_ID, BRANCH_ID, OPERATOR_ID } from './_support';

/**
 * The Lucky Wheel on the box (S2-07a).
 *
 * **What this file can and cannot build.** It builds the booth module, a real
 * SQLite store and a print port, and drives a press end to end. It does NOT
 * build `createBoxAgent`: that file reaches `printing/index.ts`, which imports
 * `@oto/print`, which this package's test runner cannot load at all — Node's
 * strip-only mode refuses `Bitmap1`'s parameter properties, and the failure is
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` rather than anything subtle. That is the
 * same wall `print-restart.test.ts` describes, and the booth is built against
 * an injected print PORT precisely so that this wall costs the tests nothing:
 * everything the agent adds on top is wiring, and the seam it wires to is
 * exercised here.
 *
 * So nothing below claims to prove the agent. It proves the module the agent
 * constructs, which is where every rule in this ticket actually lives.
 */

const STATION_ID = '018f1d2c-0000-7000-8000-0000000057b1';
const OTHER_STATION_ID = '018f1d2c-0000-7000-8000-0000000057b2';
const LAYOUT_ID = '018f1d2c-0000-7000-8000-00000000fa00';
const CONFIG_VERSION_ID = '018f1d2c-0000-7000-8000-00000000fc01';
const ACCOUNT_ID = '018f1d2c-0000-7000-8000-00000000fb01';
const AT = '2026-09-21T06:00:00.000Z';

/** 13:00 in Bangkok, which is the middle of a trading day that starts at 05:00. */
const BUSINESS_DATE = '2026-09-21';

interface Prize {
  id: string;
  nameEn: string;
  weightBp: number;
  active?: boolean;
  dailyCap?: number | null;
}

function prize(index: number, over: Partial<Prize> & { weightBp: number }): BoothCacheEntry['bundle']['prizes'][number] {
  return {
    id: `018f1d2c-0000-7000-8000-00000000fa1${index}`,
    nameEn: over.nameEn ?? `Prize ${index}`,
    nameTh: null,
    wheelLabel: null,
    weightBp: over.weightBp,
    active: over.active ?? true,
    dailyCap: over.dailyCap ?? null,
    expiryDays: 14,
    costSatang: 10_000,
    sliceColor: null,
    textColor: null,
    sortOrder: index,
    voucherDefinitionId: `018f1d2c-0000-7000-8000-00000000fd0${index}`,
  };
}

function entry(over: Partial<BoothCacheEntry> = {}): BoothCacheEntry {
  return {
    stationId: STATION_ID,
    configVersionId: CONFIG_VERSION_ID,
    version: 1,
    bundleHash: 'a'.repeat(64),
    allowedStaff: [],
    voucherDefinitions: [],
    bundle: {
      schemaVersion: 1,
      settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
      layout: { id: LAYOUT_ID, name: 'Classic wheel', version: 1, design: {}, assetManifest: {} },
      prizes: [prize(1, { weightBp: 100 }), prize(2, { weightBp: 200 })],
    },
    ...over,
  };
}

interface Harness {
  store: SqlBoxStore;
  booth: Booth;
  printed: PrintJobRecord[];
  submissions: { id: string }[];
  /** What the port answers. Changed per test to model a printer that is out. */
  printOutcome: BoothPrintSubmitOutcome['status'];
  setNow(iso: string): void;
  close(): void;
}

const keys = generateSyncKeyPair();

interface HarnessOptions {
  entries?: BoothCacheEntry[];
  staff?: BoothStaffRecord[];
  /** The draw's source. A counter by default, so every test is deterministic. */
  rolls?: number[];
  print?: boolean;
  store?: BoxStore;
  file?: string;
  privateKey?: string | null;
}

function openBooth(options: HarnessOptions = {}): Harness {
  const db = new DatabaseSync(options.file ?? ':memory:');
  prepareSqliteBoxStore(db);
  let now = new Date(AT);
  const store = options.store ?? new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => now });
  const submissions: { id: string }[] = [];
  const harness: Partial<Harness> = { printOutcome: 'printed' };

  const rolls = options.rolls ? [...options.rolls] : null;
  let rollIndex = 0;

  const port: BoothPrintPort = {
    async submit(request) {
      submissions.push({ id: request.id });
      return {
        id: request.id,
        status: harness.printOutcome ?? 'printed',
        attempts: 1,
        deviceId: '018f1d2c-0000-7000-8000-00000000de01',
        errorCode: null,
        errorMessage: null,
      };
    },
  };

  const booth = createBooth({
    boxId: BOX_ID,
    store: store as BoxStore,
    station: () => ({ id: STATION_ID, name: 'Booth 1', codePrefix: 'B1' }),
    branch: () => ({
      id: BRANCH_ID,
      operatorId: OPERATOR_ID,
      name: 'HKT Central',
      timezone: 'Asia/Bangkok',
      businessDayStart: '05:00',
    }),
    privateKey: () =>
      options.privateKey === undefined ? keys.privateKeyPem : options.privateKey,
    print: options.print === false ? null : port,
    staff: () => options.staff ?? [],
    // A stand-in for argon2id: the SHAPE under test is "iterate the booth's
    // allowed staff and verify against each hash" (D18), and a native
    // dependency would prove nothing more about that while costing this
    // package a lockfile change it is not allowed to make. The real verifier
    // is `@node-rs/argon2`, injected by the api.
    verifySecret: async (hash, secret) => hash === `argon2:${secret}`,
    randomIndex: (max) => {
      if (!rolls) return 0;
      const value = rolls[rollIndex % rolls.length] ?? 0;
      rollIndex += 1;
      // A scripted roll is clamped rather than allowed out of range, so a test
      // that scripts a draw does not accidentally exercise the range guard —
      // there is a test below that does that on purpose.
      return Math.min(value, max - 1);
    },
    now: () => now,
  });

  return Object.assign(harness, {
    store: store as SqlBoxStore,
    booth,
    printed: [],
    submissions,
    setNow(iso: string) {
      now = new Date(iso);
    },
    close: () => db.close(),
  }) as Harness;
}

async function seed(h: Harness, entries: BoothCacheEntry[] = [entry()]): Promise<void> {
  await h.store.init(BOX_ID);
  await h.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 1,
    payload: { items: entries },
    appliedAt: AT,
  });
  await h.booth.refresh();
}

// --- The published wheel ----------------------------------------------------

test('a published wheel is read from the cache and applied whole', async () => {
  const h = openBooth();
  await seed(h);
  const held = h.booth.config();
  assert.equal(held?.version, 1);
  assert.equal(held?.bundle.prizes.length, 2);
  h.close();
});

test('a newer version replaces the wheel; an older one never does', async () => {
  const h = openBooth();
  await seed(h);

  await h.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 2,
    payload: {
      items: [
        entry({
          version: 4,
          bundleHash: 'b'.repeat(64),
          bundle: { ...entry().bundle, prizes: [prize(1, { weightBp: 10000 })] },
        }),
      ],
    },
    appliedAt: AT,
  });
  assert.equal(await h.booth.refresh(), true);
  assert.equal(h.booth.config()?.version, 4);

  // A cache rebuilt from behind must not restore odds an administrator has
  // already replaced.
  await h.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 3,
    payload: { items: [entry({ version: 2, bundleHash: 'c'.repeat(64) })] },
    appliedAt: AT,
  });
  assert.equal(await h.booth.refresh(), false);
  assert.equal(h.booth.config()?.version, 4, 'the newer wheel is still running');
  h.close();
});

test('an entry for another booth, and one that does not parse, are both ignored', async () => {
  const h = openBooth();
  await seed(h);
  const broken = { stationId: STATION_ID, version: 9 } as unknown as BoothCacheEntry;
  await h.store.writeBundle(BOX_ID, {
    scope: 'booth',
    schemaVersion: 1,
    cursorSeq: 2,
    payload: { items: [entry({ stationId: OTHER_STATION_ID, version: 7 }), broken] },
    appliedAt: AT,
  });
  assert.equal(await h.booth.refresh(), false);
  assert.equal(h.booth.config()?.version, 1, 'the running wheel is untouched');
  h.close();
});

// --- The draw ---------------------------------------------------------------

test('the weighted pick tests before it subtracts, so a zero-weight prize can never win', () => {
  // Weights 100 and 200 over a total of 300: the boundary is at 100 exactly.
  const prizes = [prize(1, { weightBp: 100 }), prize(2, { weightBp: 200 })];
  const at = (roll: number): string => {
    const outcome = drawPrize(prizes, () => roll);
    assert.equal(outcome.ok, true);
    return outcome.ok ? outcome.prize.id : '';
  };
  assert.equal(at(0), prizes[0]!.id);
  assert.equal(at(99), prizes[0]!.id, 'the last index of the first slice');
  assert.equal(at(100), prizes[1]!.id, 'the boundary belongs to the SECOND slice');
  assert.equal(at(299), prizes[1]!.id);

  /**
   * The rule this whole module is written against (D21). The outgoing game's
   * `pickWeightedPrize` subtracts first and tests `roll <= 0`, which hands a
   * zero-weight slice the win at its boundary. Here a zero-weight prize is not
   * even a candidate — it is `zero_weight` and out of the renormalisation —
   * so there is no boundary at which it can be reached.
   */
  const withZero = [prize(1, { weightBp: 0 }), prize(2, { weightBp: 300 })];
  for (const roll of [0, 1, 150, 299]) {
    const outcome = drawPrize(withZero, () => roll);
    assert.equal(outcome.ok && outcome.prize.id, withZero[1]!.id);
  }
  const judged = drawPrize(withZero, () => 0);
  assert.equal(judged.judged[0]?.reason, 'zero_weight');
});

test('a source that answers outside the range throws rather than picking wrongly', () => {
  const prizes = [prize(1, { weightBp: 100 })];
  assert.throws(() => drawPrize(prizes, () => 100), /not an index into 100 basis points/);
  assert.throws(() => drawPrize(prizes, () => -1), /not an index into/);
  assert.throws(() => drawPrize(prizes, () => 1.5), /not an index into/);
});

test('a prize at its daily cap is excluded from the next draw and the weights renormalise', async () => {
  const capped = prize(1, { weightBp: 100, dailyCap: 1 });
  const other = prize(2, { weightBp: 200 });
  const h = openBooth({ rolls: [0] });
  await seed(h, [entry({ bundle: { ...entry().bundle, prizes: [capped, other] } })]);

  // Roll 0 over a total of 300 lands on the first slice.
  const first = await h.booth.spin({ idempotencyKey: 'press-1' });
  assert.equal(first.prizeId, capped.id);

  /**
   * The cap is now used up, so the second draw is over `other` alone — total
   * 200 rather than 300, which is what "renormalised, not zeroed" means. Roll
   * 0 would still have chosen the capped prize had it stayed in the set, so
   * this assertion distinguishes exclusion from a lucky second draw.
   */
  const second = await h.booth.spin({ idempotencyKey: 'press-2' });
  assert.equal(second.prizeId, other.id, 'the capped prize was excluded');
  assert.equal(second.prizeIndex, 1);

  const status = await h.booth.status({ online: true });
  assert.deepEqual(status.dailyCapsReached, [capped.id]);
  h.close();
});

test('a wheel with nothing winnable refuses the press rather than drawing (D5)', async () => {
  const h = openBooth();
  await seed(h, [
    entry({
      bundle: {
        ...entry().bundle,
        prizes: [prize(1, { weightBp: 100, active: false }), prize(2, { weightBp: 0 })],
      },
    }),
  ]);
  await assert.rejects(
    () => h.booth.spin({ idempotencyKey: 'press-1' }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'booth_not_ready',
  );
  h.close();
});

// --- One press --------------------------------------------------------------

test('a press writes the spin, mints a code, queues the print and moves the counter — together', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  const response = await h.booth.spin({ idempotencyKey: 'press-1', actionId: 'act-1' });

  assert.match(response.voucherCode ?? '', /^B1[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  assert.equal(response.configVersion, 1);
  assert.equal(response.printState, 'printed');
  assert.equal(response.staffAccountId, null, 'nobody is signed in, and that is allowed');
  assert.equal(response.clockSuspect, false);
  // The prize the page will animate to is the prize the box drew.
  assert.equal(h.booth.config()?.bundle.prizes[response.prizeIndex]?.id, response.prizeId);

  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  assert.deepEqual(
    batch.events.map((e) => e.type),
    ['booth.spin_recorded', 'promo.voucher_issued'],
    'both facts, in order, from one transaction',
  );
  assert.equal(batch.events[0]?.boxSeq, 1);
  assert.equal(batch.events[1]?.boxSeq, 2, 'consecutive sequences: no gap in the journal');
  assert.equal(batch.events[0]?.payload.spinId, response.spinId);
  assert.equal(batch.events[0]?.payload.businessDate, BUSINESS_DATE);
  assert.equal(batch.events[0]?.payload.boothConfigVersionId, CONFIG_VERSION_ID);
  assert.equal(batch.events[1]?.payload.code, response.voucherCode);

  const counters = await h.store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, BUSINESS_DATE);
  assert.equal(counters[response.prizeId], 1);
  assert.equal(h.submissions.length, 1, 'the voucher was handed to the printer');
  assert.equal(h.booth.ownsPrintJob(h.submissions[0]!.id), true, 'and the booth owns the job (D20)');
  h.close();
});

test('the print job is on disk before the printer is touched, so a restart still prints it', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  h.printOutcome = 'queued';
  const response = await h.booth.spin({ idempotencyKey: 'press-1' });
  assert.equal(response.printState, 'queued', 'a printer that has not produced paper says so');
  // And the code is minted regardless: a printer fault must never hide a valid
  // voucher from a family standing in front of the screen.
  assert.notEqual(response.voucherCode, null);

  const pending = await h.store.loadPendingPrintJobs(BOX_ID);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, 'booth_voucher');
  const data = voucherData(pending[0]?.job);
  assert.equal(data.voucherCode, response.voucherCode);
  assert.equal(data.staff, null, 'unattributed prints a visible null, not a missing row');
  assert.equal(data.prizeLineThai, null);
  assert.deepEqual(data.terms, [], 'no definitions cached, so no terms — see resolveExpiry');
  h.close();
});

test('a simulated press changes nothing at all (D16)', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  const response = await h.booth.spin({ idempotencyKey: 'sim-1', simulate: true });

  assert.equal(response.voucherCode, null);
  assert.equal(response.printState, 'no_printer');
  assert.equal(h.booth.config()?.bundle.prizes[response.prizeIndex]?.id, response.prizeId);

  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 0, 'no spin, no voucher');
  const counters = await h.store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, BUSINESS_DATE);
  assert.deepEqual(counters, {}, 'no cap consumed');
  assert.equal((await h.store.loadPendingPrintJobs(BOX_ID)).length, 0, 'nothing to print');
  assert.equal(h.submissions.length, 0);
  h.close();
});

// --- D7: one press, one spin ------------------------------------------------

test('a retry carrying the same key is one spin; a second press is two', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  const first = await h.booth.spin({ idempotencyKey: 'press-1' });
  const retry = await h.booth.spin({ idempotencyKey: 'press-1' });
  assert.deepEqual(retry, first, 'the identical answer, not a second draw');

  const second = await h.booth.spin({ idempotencyKey: 'press-2' });
  assert.notEqual(second.spinId, first.spinId);

  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 4, 'two presses, two facts each');
  assert.equal(h.submissions.length, 2);
  h.close();
});

test('a repeated key the process can no longer answer for is refused, never redrawn', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  await h.booth.spin({ idempotencyKey: 'press-1' });

  /**
   * A second booth module on the SAME store is what a restart looks like from
   * here: the in-memory replay is gone, the durable press counter is not. The
   * honest answer to "I cannot tell you what you won last time" is a refusal —
   * a second draw would put a second voucher in somebody's hand for one press.
   */
  const restarted = openBooth({ rolls: [0], store: h.store });
  await restarted.booth.refresh();
  await assert.rejects(
    () => restarted.booth.spin({ idempotencyKey: 'press-1' }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'duplicate_press',
  );

  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 2, 'still one spin');
  restarted.close();
  h.close();
});

test('a retry that arrives after the trading day rolls over is still one spin', async () => {
  /**
   * The counter rows a press is guarded by are keyed by trading day, so the
   * boundary — 05:00 on the branch's wall clock — is the one moment at which a
   * naive guard forgets everything and draws a second prize for one press. A
   * booth is shut at five in the morning, which is exactly why this would have
   * gone unnoticed.
   */
  const h = openBooth({ rolls: [0] });
  await seed(h);
  h.setNow('2026-09-21T21:30:00.000Z'); // 04:30 on the 22nd in Bangkok: still the 21st.
  const first = await h.booth.spin({ idempotencyKey: 'press-1' });

  // The day rolls. A fresh module, so only the durable guard is left.
  const restarted = openBooth({ rolls: [0], store: h.store });
  restarted.setNow('2026-09-21T22:30:00.000Z'); // 05:30 on the 22nd: a new trading day.
  await restarted.booth.refresh();
  await assert.rejects(
    () => restarted.booth.spin({ idempotencyKey: 'press-1' }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'duplicate_press',
  );

  // And a genuinely new press on the new day is unaffected.
  const next = await restarted.booth.spin({ idempotencyKey: 'press-2' });
  assert.notEqual(next.spinId, first.spinId);
  restarted.close();
  h.close();
});

test('a write that fails refuses the press and leaves nothing behind (D7)', async () => {
  const base = openBooth({ rolls: [0] });
  await seed(base);
  const broken = failing(base.store, 'enqueueMany');
  const h = openBooth({ rolls: [0], store: broken });
  await h.booth.refresh();

  await assert.rejects(
    () => h.booth.spin({ idempotencyKey: 'press-1' }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'cannot_record',
  );

  // Every part of the press rolled back together: no counter, no print job,
  // and — the one that would be worst — no paper.
  const counters = await base.store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, BUSINESS_DATE);
  assert.deepEqual(counters, {});
  const presses = await base.store.readCounters(BOX_ID, BOOTH_PRESS_COUNTER_SCOPE, BUSINESS_DATE);
  assert.deepEqual(presses, {}, 'the press guard rolled back too, so a genuine retry still works');
  assert.equal((await base.store.loadPendingPrintJobs(BOX_ID)).length, 0);
  assert.equal(h.submissions.length, 0);
  base.close();
});

test('a box with no signing key refuses the press rather than drawing unrecordably', async () => {
  const h = openBooth({ rolls: [0], privateKey: null });
  await seed(h);
  await assert.rejects(
    () => h.booth.spin({ idempotencyKey: 'press-1' }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'cannot_record',
  );
  h.close();
});

// --- SCRUM-257: spins per day ----------------------------------------------

/**
 * The seeded wheel with a "spins per day" on it, and nothing else changed.
 *
 * The setting travels inside the published bundle, so a cap is not something a
 * test can switch on at the booth: it is a wheel an administrator published,
 * which is the only way a real booth ever gets one.
 */
function withSpinCap(dailySpinCap: number | null): BoothCacheEntry {
  const base = entry();
  return entry({
    bundle: { ...base.bundle, settings: { ...base.bundle.settings, dailySpinCap } },
  });
}

test('a booth refuses the press once it has given away its spins for the day', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h, [withSpinCap(2)]);

  await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.spin({ idempotencyKey: 'press-2' });
  await assert.rejects(
    () => h.booth.spin({ idempotencyKey: 'press-3' }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'daily_spin_cap_reached',
  );

  /**
   * The refused press left NOTHING behind, which is the half of this that
   * matters: a spin row the cloud accepts, or a voucher code on a slip, is
   * something reception has to honour — a cap that stopped the television
   * animating and still printed the paper would be worse than no cap at all.
   */
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 4, 'two spins and their two vouchers, and nothing else');
  assert.equal(h.submissions.length, 2, 'two slips, not three');
  const spins = await h.store.readCounters(BOX_ID, BOOTH_SPIN_COUNTER_SCOPE, BUSINESS_DATE);
  assert.deepEqual(spins, { [STATION_ID]: 2 }, 'the refused press did not count towards the day');
  const presses = await h.store.readCounters(BOX_ID, BOOTH_PRESS_COUNTER_SCOPE, BUSINESS_DATE);
  assert.deepEqual(
    Object.keys(presses).sort(),
    ['press-1', 'press-2'],
    'and it is not remembered as a press, so nothing about it has to be unpicked',
  );
  h.close();
});

test('a booth with no cap plays on: null is no limit', async () => {
  const h = openBooth({ rolls: [0] });
  // The seeded entry carries `dailySpinCap: null`, which is what most booths
  // run on — the cap is the exception, not the rule.
  await seed(h, [withSpinCap(null)]);
  for (let i = 1; i <= 5; i += 1) {
    const response = await h.booth.spin({ idempotencyKey: `press-${i}` });
    assert.equal(typeof response.voucherCode, 'string', `press ${i} drew a prize`);
  }
  const spins = await h.store.readCounters(BOX_ID, BOOTH_SPIN_COUNTER_SCOPE, BUSINESS_DATE);
  assert.deepEqual(
    spins,
    { [STATION_ID]: 5 },
    'counted even with no cap, so switching one on mid-afternoon counts the morning too',
  );
  h.close();
});

test('the day’s spins reset at the trading-day boundary, not at midnight', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h, [withSpinCap(1)]);

  // 23:30 in Bangkok on the 21st: the booth's one spin for that trading day.
  h.setNow('2026-09-21T16:30:00.000Z');
  await h.booth.spin({ idempotencyKey: 'press-1' });

  /**
   * 04:30 the next morning. Midnight has passed and the date on a wall
   * calendar has changed, and the booth is still inside the 21st's trading day
   * — which is the whole of this test. A cap that reset at midnight would hand
   * out a second day's prizes to whoever was still at the mall at one in the
   * morning.
   */
  h.setNow('2026-09-21T21:30:00.000Z');
  await assert.rejects(
    () => h.booth.spin({ idempotencyKey: 'press-2' }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'daily_spin_cap_reached',
  );

  // 05:30: a new trading day, and the booth plays again without anybody
  // touching it.
  h.setNow('2026-09-21T22:30:00.000Z');
  const next = await h.booth.spin({ idempotencyKey: 'press-3' });
  assert.equal(typeof next.voucherCode, 'string');

  assert.deepEqual(await h.store.readCounters(BOX_ID, BOOTH_SPIN_COUNTER_SCOPE, '2026-09-21'), {
    [STATION_ID]: 1,
  });
  assert.deepEqual(
    await h.store.readCounters(BOX_ID, BOOTH_SPIN_COUNTER_SCOPE, '2026-09-22'),
    { [STATION_ID]: 1 },
    'the new day counts from zero, in a row of its own',
  );
  h.close();
});

test('a simulated press is refused by the cap as well, and spends none of it', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h, [withSpinCap(1)]);

  // Below the cap: the table draws, and the booth's day is untouched by it.
  const simulated = await h.booth.spin({ idempotencyKey: 'sim-1', simulate: true });
  assert.equal(simulated.voucherCode, null);
  assert.deepEqual(
    await h.store.readCounters(BOX_ID, BOOTH_SPIN_COUNTER_SCOPE, BUSINESS_DATE),
    {},
    'a simulation does not spend the booth’s day',
  );

  /**
   * At the cap, the simulation is refused too. The `#debug` distribution table
   * asks what a press would do NOW, and on a booth that has run its day the
   * answer is that it would be refused — a table still showing prizes flowing
   * would say the opposite of what the red button does.
   */
  await h.booth.spin({ idempotencyKey: 'press-1' });
  await assert.rejects(
    () => h.booth.spin({ idempotencyKey: 'sim-2', simulate: true }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'daily_spin_cap_reached',
  );
  h.close();
});

test('a retry of a press the box already answered is not turned away by the cap', async () => {
  /**
   * The order of the two guards, pinned. A press that filled the last of the
   * day's spins and whose answer was lost to a slow mall connection is retried
   * by the page with the same key: the box owes it the spin it already made,
   * not "come back tomorrow" — the voucher is already on paper and in the
   * outbox.
   */
  const h = openBooth({ rolls: [0] });
  await seed(h, [withSpinCap(1)]);
  const first = await h.booth.spin({ idempotencyKey: 'press-1' });
  const retry = await h.booth.spin({ idempotencyKey: 'press-1' });
  assert.deepEqual(retry, first, 'the same answer, not a refusal');
  h.close();
});

test('a press that read the count a moment too early is still refused by the cap', async () => {
  /**
   * The second of the two guards, on its own.
   *
   * The read before the draw is what refuses the ordinary press cheaply, and
   * it is a read: between it and the write, another press can land. `staleCount`
   * below is that window held open — a store whose pre-draw read answers with
   * a number that was true a moment ago — and what must happen then is that the
   * counter's own increment, inside the transaction, comes back over the cap
   * and takes the whole press out with it.
   *
   * A booth has one button and the race is unlikely. A cap that can be stepped
   * over by pressing twice quickly is still not a cap, and this is the only
   * way to make the crossing happen on purpose.
   */
  const h = openBooth({ rolls: [0] });
  await seed(h, [withSpinCap(1)]);
  await h.booth.spin({ idempotencyKey: 'press-1' });

  const blind = openBooth({ rolls: [0], store: staleCount(h.store) });
  await blind.booth.refresh();
  await assert.rejects(
    () => blind.booth.spin({ idempotencyKey: 'press-2' }),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'daily_spin_cap_reached',
  );

  // And the press it refused rolled back whole: one spin, one voucher, one
  // slip, and the day's count still reading one.
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 2, 'the refused press queued nothing');
  assert.deepEqual(await h.store.readCounters(BOX_ID, BOOTH_SPIN_COUNTER_SCOPE, BUSINESS_DATE), {
    [STATION_ID]: 1,
  });
  assert.equal(blind.submissions.length, 0, 'and no paper came out of it');
  blind.close();
  h.close();
});

test('the cap’s refusal reaches the page as 409 with a code of its own', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h, [withSpinCap(1)]);
  const handle = createBoothHttp({ booth: h.booth, online: () => true });

  assert.equal((await handle({ method: 'POST', path: '/spin', body: {} })).status, 200);
  const refused = await handle({ method: 'POST', path: '/spin', body: {} });
  /**
   * 409 rather than 503: a booth that has run the day a manager configured is
   * the system working, and it must not be the thing that lights up an error
   * rate. And a code of its own rather than `booth_not_ready`, because the
   * television says something different about it — "come back tomorrow" rather
   * than "please call staff", which is an errand nobody can complete today.
   */
  assert.equal(refused.status, 409);
  const envelope = refused.body as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'daily_spin_cap_reached');
  // The message is for a log (D15): no booth, no branch, no number a guest
  // could read as a promise.
  assert.doesNotMatch(envelope.error.message, new RegExp(STATION_ID));
  assert.doesNotMatch(envelope.error.message, /HKT Central|Booth 1/);
  h.close();
});

// --- D11: the clock ---------------------------------------------------------

test('a clock behind a time the box has lived through is suspect, and the day does not go back', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  // The cloud said it was the 21st; the box now believes it is the 19th.
  await h.store.markTimeSeen(BOX_ID, '2026-09-21T06:00:00.000Z');
  h.setNow('2026-09-19T06:00:00.000Z');

  const response = await h.booth.spin({ idempotencyKey: 'press-1' });
  assert.equal(response.clockSuspect, true);

  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  const spin = batch.events[0]!;
  assert.equal(
    spin.payload.businessDate,
    BUSINESS_DATE,
    'the trading day is the later one, never the earlier',
  );
  assert.equal(
    spin.occurredAt,
    '2026-09-19T06:00:00.000Z',
    'occurredAt is still what the clock said — kept as sent, even when disbelieved',
  );
  assert.equal(spin.payload.clockSuspect, true);
  h.close();
});

test('a clock inside the ten-minute tolerance is not flagged', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  await h.store.markTimeSeen(BOX_ID, '2026-09-21T06:05:00.000Z');
  h.setNow('2026-09-21T06:00:00.000Z');
  const response = await h.booth.spin({ idempotencyKey: 'press-1' });
  assert.equal(response.clockSuspect, false, 'five minutes is ordinary NTP correction');
  h.close();
});

// --- D18: staff sign-in -----------------------------------------------------

const staffRecord = (over: Partial<BoothStaffRecord> = {}): BoothStaffRecord => ({
  accountId: ACCOUNT_ID,
  status: 'active',
  pinHash: 'argon2:2468',
  badgeHash: null,
  staffCode: 'S-014',
  ...over,
});

test('a PIN is verified by iterating the booth’s own staff, and signs somebody in', async () => {
  const h = openBooth({ staff: [staffRecord()] });
  await seed(h, [entry({ allowedStaff: [ACCOUNT_ID] })]);

  assert.deepEqual(await h.booth.signIn({ pin: '1111' }), { ok: false });
  const ok = await h.booth.signIn({ pin: '2468' });
  assert.equal(ok.ok, true);
  assert.equal(ok.accountId, ACCOUNT_ID);

  const session = await h.booth.staffSession();
  assert.equal(session?.accountId, ACCOUNT_ID);
  assert.equal(session?.credentialKind, 'pin');
  assert.equal(session?.staffCode, 'S-014');
  h.close();
});

test('somebody not on this booth’s list cannot sign in, however good their PIN', async () => {
  const h = openBooth({ staff: [staffRecord()] });
  // A wheel with an empty `allowedStaff` — which is every booth today, since
  // nothing fills the scope yet.
  await seed(h, [entry({ allowedStaff: [] })]);
  assert.deepEqual(await h.booth.signIn({ pin: '2468' }), { ok: false });
  assert.equal(await h.booth.staffSession(), null);
  h.close();
});

test('five wrong PINs are free; the sixth starts a wait that a restart does not clear', async () => {
  const h = openBooth({ staff: [staffRecord()] });
  await seed(h, [entry({ allowedStaff: [ACCOUNT_ID] })]);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await h.booth.signIn({ pin: '0000' });
    assert.deepEqual(result, { ok: false }, `attempt ${attempt} is free`);
  }
  const sixth = await h.booth.signIn({ pin: '0000' });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.retryAfterMs, 30_000);

  /**
   * The point of keeping the count on disk: a booth in a mall is a kiosk
   * anybody can reach the power lead of, and "five wrong PINs, then wait" has
   * to mean the same thing after somebody has pulled the plug.
   */
  const restarted = openBooth({ staff: [staffRecord()], store: h.store });
  await restarted.booth.refresh();
  const afterRestart = await restarted.booth.signIn({ pin: '2468' });
  assert.equal(afterRestart.ok, false, 'the correct PIN is refused while the lock stands');
  assert.equal(typeof afterRestart.retryAfterMs, 'number');

  const held = await h.store.readThrottle(BOX_ID, BOOTH_STAFF_THROTTLE_SCOPE, STATION_ID);
  assert.equal(held?.failures, 6);
  restarted.close();
  h.close();
});

test('a sign-in problem never stops the wheel', async () => {
  const h = openBooth({ rolls: [0], staff: [staffRecord()] });
  await seed(h, [entry({ allowedStaff: [ACCOUNT_ID] })]);
  for (let attempt = 0; attempt < 8; attempt += 1) await h.booth.signIn({ pin: '0000' });

  const response = await h.booth.spin({ idempotencyKey: 'press-1' });
  assert.equal(response.staffAccountId, null, 'unattributed, which is a real and expected state');
  assert.notEqual(response.voucherCode, null, 'and the child still got a voucher');
  h.close();
});

test('a signed-in booth attributes the spin and prints the staff code', async () => {
  const h = openBooth({ rolls: [0], staff: [staffRecord()] });
  await seed(h, [entry({ allowedStaff: [ACCOUNT_ID] })]);
  await h.booth.signIn({ pin: '2468' });

  const response = await h.booth.spin({ idempotencyKey: 'press-1' });
  assert.equal(response.staffAccountId, ACCOUNT_ID);
  const pending = await h.store.loadPendingPrintJobs(BOX_ID);
  const data = voucherData(pending[0]?.job);
  assert.equal(data.staff, 'S-014', 'the code, never a name — the slip is read at a counter');

  await h.booth.signOut();
  assert.equal(await h.booth.staffSession(), null);
  h.close();
});

test('a badge is verified the same way, and finds nobody while no badge hash is cached', async () => {
  const h = openBooth({ staff: [staffRecord({ badgeHash: null })] });
  await seed(h, [entry({ allowedStaff: [ACCOUNT_ID] })]);
  assert.deepEqual(await h.booth.signIn({ badge: 'BADGE-12345' }), { ok: false });

  // And it works the moment something writes one, which is what makes this a
  // seam rather than a gap: the verification path is the same iteration.
  const withBadge = openBooth({
    staff: [staffRecord({ badgeHash: 'argon2:BADGE-12345' })],
    store: h.store,
  });
  await withBadge.booth.refresh();
  const ok = await withBadge.booth.signIn({ badge: 'BADGE-12345' });
  assert.equal(ok.ok, true);
  assert.equal((await withBadge.booth.staffSession())?.credentialKind, 'badge');
  withBadge.close();
  h.close();
});

// --- Reporting --------------------------------------------------------------

test('the heartbeat block is measured, not defaulted', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);

  const before = await h.booth.heartbeat();
  assert.equal(before?.configVersion, 1);
  assert.equal(before?.printerReachable, 'unknown', 'nothing has been asked of a printer yet');
  assert.equal(before?.paperStatus, 'unknown');
  assert.equal(before?.lastSpinAt, null);
  assert.equal(before?.staffSignedIn, false);
  assert.equal(before?.vouchersPending, 0);

  await h.booth.spin({ idempotencyKey: 'press-1' });
  const after = await h.booth.heartbeat();
  assert.equal(after?.lastSpinAt, AT);
  assert.equal(after?.vouchersPending, 2, 'the spin and the voucher are both still queued');
  h.close();
});

test('a box with no booth station sends no booth block at all', async () => {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => new Date(AT) });
  await store.init(BOX_ID);
  const booth = createBooth({
    boxId: BOX_ID,
    store,
    station: () => null,
    branch: () => null,
    privateKey: () => keys.privateKeyPem,
  });
  assert.equal(await booth.heartbeat(), null);
  assert.equal(booth.config(), null);
  db.close();
});

test('a print outcome for a booth voucher becomes an outbox fact (D20)', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  h.printOutcome = 'queued';
  await h.booth.spin({ idempotencyKey: 'press-1' });
  const jobId = h.submissions[0]!.id;

  await h.booth.reportPrint({
    id: jobId,
    status: 'printed',
    attempts: 2,
    deviceId: '018f1d2c-0000-7000-8000-00000000de01',
    errorCode: null,
    errorMessage: null,
  });

  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  const printed = batch.events.find((e) => e.type === 'booth.voucher_printed');
  assert.ok(printed, 'the outcome travels as a fact, not to the cloud print route');
  assert.equal(printed?.payload.printJobId, jobId);
  assert.equal(printed?.payload.status, 'printed');
  /**
   * **The fact names the VOUCHER, not only the job.** `printJobId` is an
   * `edge.print_job` row on this box, raised for a spin the cloud may not have
   * received yet — it resolves to nothing on the other side. An outcome
   * carrying only that arrives at the cloud and cannot be matched to anything,
   * which is a silent failure: the sync succeeds and the voucher's print state
   * never moves.
   */
  const voucherFact = batch.events.find((e) => e.type === 'promo.voucher_issued');
  assert.equal(printed?.payload.voucherId, voucherFact?.payload.voucherId);
  assert.equal(printed?.payload.voucherCode, voucherFact?.payload.code);
  assert.equal(
    h.booth.ownsPrintJob(jobId),
    false,
    'and the booth lets the finished job go once the fact is on disk',
  );
  h.close();
});

test('a booth adopts the vouchers a previous process left unprinted, and can still name them', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  h.printOutcome = 'queued';
  const response = await h.booth.spin({ idempotencyKey: 'press-1' });
  const jobId = h.submissions[0]!.id;

  const restarted = openBooth({ store: h.store });
  assert.equal(restarted.booth.ownsPrintJob(jobId), false, 'it knows nothing before it starts');
  await restarted.booth.start();
  assert.equal(
    restarted.booth.ownsPrintJob(jobId),
    true,
    'and afterwards the outcome still goes to the outbox rather than the cloud',
  );

  /**
   * The point of adopting them: when the paper finally comes out, the outcome
   * still says WHICH voucher. The voucher id died with the process that
   * minted it — nothing on a stored print job carries one, because a print job
   * holds what goes on the paper — so the code is what survives, and the code
   * is enough for the cloud to find the row.
   */
  await restarted.booth.reportPrint({
    id: jobId,
    status: 'printed',
    attempts: 3,
    deviceId: null,
    errorCode: null,
    errorMessage: null,
  });
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  const printed = batch.events.find((e) => e.type === 'booth.voucher_printed');
  assert.equal(printed?.payload.voucherCode, response.voucherCode);
  assert.equal(printed?.payload.voucherId, null, 'honestly null rather than invented');
  restarted.booth.stop();
  restarted.close();
  h.close();
});

// --- The /booth/* surface ---------------------------------------------------

test('the http handler answers the contract the page was written against', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  const handle = createBoothHttp({ booth: h.booth, online: () => true });

  const config = await handle({ method: 'GET', path: '/config' });
  assert.equal(config.status, 200);
  const configBody = config.body as { version: number; bundle: unknown };
  assert.equal(configBody.version, 1, 'the version rides BESIDE the bundle');
  assert.ok(configBody.bundle);

  const status = await handle({ method: 'GET', path: '/status' });
  assert.equal((status.body as { online: boolean }).online, true);
  assert.equal((status.body as { neverSynced: boolean }).neverSynced, false);

  const spin = await handle({
    method: 'POST',
    path: '/spin',
    body: { idempotencyKey: 'press-1' },
    headers: { 'x-oto-action-id': 'act-9' },
  });
  assert.equal(spin.status, 200);
  assert.notEqual((spin.body as { voucherCode: string | null }).voucherCode, null);

  const signOut = await handle({ method: 'POST', path: '/staff/sign-out', body: {} });
  assert.equal(signOut.status, 204);

  assert.equal((await handle({ method: 'GET', path: '/nope' })).status, 404);
  assert.equal((await handle({ method: 'GET', path: '/spin' })).status, 405);
  h.close();
});

test('the handler honours simulate, which is what stops a debug table minting 200 vouchers', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  const handle = createBoothHttp({ booth: h.booth, online: () => true });
  for (let i = 0; i < 5; i += 1) {
    await handle({ method: 'POST', path: '/spin', body: { simulate: true } });
  }
  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  assert.equal(batch.events.length, 0);
  assert.equal(h.submissions.length, 0);
  h.close();
});

test('a refused press comes back as the platform envelope with a code the page knows', async () => {
  const h = openBooth();
  await seed(h, [
    entry({ bundle: { ...entry().bundle, prizes: [prize(1, { weightBp: 100, active: false })] } }),
  ]);
  const handle = createBoothHttp({ booth: h.booth, online: () => false });
  const refused = await handle({ method: 'POST', path: '/spin', body: {} });
  assert.equal(refused.status, 409);
  const envelope = refused.body as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'booth_not_ready');
  // The message is for a log. Nothing in it names the booth, the branch or a
  // path, because the page must be able to ignore it safely (D15).
  assert.doesNotMatch(envelope.error.message, new RegExp(STATION_ID));
  assert.doesNotMatch(envelope.error.message, /HKT Central|Booth 1/);
  h.close();
});

test('a sign-in refusal is 200 with ok:false, so the panel shows a countdown and not a fault', async () => {
  const h = openBooth({ staff: [staffRecord()] });
  await seed(h, [entry({ allowedStaff: [ACCOUNT_ID] })]);
  const handle = createBoothHttp({ booth: h.booth, online: () => true });
  for (let i = 0; i < 6; i += 1) {
    await handle({ method: 'POST', path: '/staff/sign-in', body: { pin: '0000' } });
  }
  const locked = await handle({ method: 'POST', path: '/staff/sign-in', body: { pin: '0000' } });
  assert.equal(locked.status, 200);
  const body = locked.body as { ok: boolean; retryAfterMs?: number };
  assert.equal(body.ok, false);
  assert.ok((body.retryAfterMs ?? 0) > 0);
  h.close();
});

// --- The facts the cloud will read -----------------------------------------

test('every fact a press queues verifies against the public half of the box’s key', async () => {
  const h = openBooth({ rolls: [0] });
  await seed(h);
  await h.booth.spin({ idempotencyKey: 'press-1' });

  const batch = await h.store.takeBatch(BOX_ID, { now: AT });
  for (const event of batch.events) {
    const canonical = canonicalSyncBytes({ ...event, boxId: BOX_ID });
    assert.equal(
      verifyCanonical(canonical, event.sig, keys.publicKeyPem),
      true,
      `${event.type} verifies with the same check the cloud runs`,
    );
  }
  h.close();
});

/**
 * The stored job, narrowed to the voucher it must be.
 *
 * Narrowed rather than cast: `PrintJob` is a union, and a cast to a bag of
 * unknowns would go on compiling after somebody changed what the booth builds
 * — which is the one thing these assertions exist to notice. The `kind` check
 * is the narrowing, and it is also an assertion worth making.
 */
function voucherData(job: RenderPrintJob | undefined): BoothVoucherData {
  assert.ok(job, 'there was no print job to read');
  assert.equal(job.kind, 'booth_voucher');
  if (job.kind !== 'booth_voucher') throw new Error('unreachable');
  return job.data;
}

/**
 * A store whose pre-draw read of the day's spins answers zero, while every
 * write goes to the real counter.
 *
 * What it models is a moment, not a fault: two presses reaching the box
 * together both read the count before either has written one. The transaction
 * is deliberately NOT wrapped — the increment inside it has to be the real one,
 * because the whole question is whether the number it comes back with is what
 * refuses the press.
 */
function staleCount(store: BoxStore): BoxStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'readCounter') {
        return async (boxId: string, key: CounterKey): Promise<number> =>
          key.scope === BOOTH_SPIN_COUNTER_SCOPE ? 0 : target.readCounter(boxId, key);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * A store whose one named method throws, INCLUDING inside a transaction.
 *
 * The wrapping of the transaction's own store is the part that matters: the
 * booth writes through the `tx` it is handed, not through the outer store, so
 * a proxy that only broke the outer one would prove nothing about what happens
 * when a write fails mid-press.
 */
function failing(store: BoxStore, method: keyof BoxStore): BoxStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === method) {
        return () => {
          throw new Error('the disk is full');
        };
      }
      if (prop === 'atomically') {
        return <T,>(fn: (tx: BoxStore) => Promise<T>): Promise<T> =>
          target.atomically((tx) => fn(failing(tx, method)));
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
