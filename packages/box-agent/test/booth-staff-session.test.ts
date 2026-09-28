import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  BOOTH_PRESS_COUNTER_SCOPE,
  BOOTH_PRIZE_COUNTER_SCOPE,
  BOOTH_STAFF_THROTTLE_SCOPE,
  BoothRefusal,
  createBooth,
  type BoothAccountVerdict,
  type BoothModule,
  type BoothCacheEntry,
  type BoothPrintPort,
  type BoothStaffRecord,
} from '../src/booth';
import { createBoothHttp } from '../src/booth-http';
import { generateSyncKeyPair } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { BoothVoucherData, PrintJob as RenderPrintJob } from '@oto/print';
import { BOX_ID, BRANCH_ID, OPERATOR_ID, seededIndex } from './_support';

/**
 * SCRUM-223 — the person at the booth: signing in with a phone and password
 * through the cloud, or a PIN on the box; how long that lasts; what ends it;
 * whose name goes on the slip; and the staff-only reprint.
 *
 * Built against the booth module and a real SQLite FILE, so "survives a
 * restart" is a store closed and opened again rather than a claim.
 */

const STATION_A = '018f1d2c-0000-7000-8000-0000000057c1';
const STATION_B = '018f1d2c-0000-7000-8000-0000000057c2';
const ACCOUNT = '018f1d2c-0000-7000-8000-00000000fb11';
const OTHER_ACCOUNT = '018f1d2c-0000-7000-8000-00000000fb12';
const AT = '2026-09-24T06:00:00.000Z';
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

function entry(over: Partial<BoothCacheEntry> & { staffSessionMinutes?: number } = {}): BoothCacheEntry {
  const { staffSessionMinutes, ...rest } = over;
  return {
    stationId: STATION_A,
    configVersionId: '018f1d2c-0000-7000-8000-00000000fc21',
    version: 1,
    bundleHash: 'a'.repeat(64),
    allowedStaff: [ACCOUNT],
    voucherDefinitions: [
      {
        id: '018f1d2c-0000-7000-8000-00000000fd21',
        termsEn: 'Cannot be combined with other offers.',
        termsTh: null,
        expiryDays: 14,
      },
    ],
    bundle: {
      schemaVersion: 1,
      settings: {
        eligibility: 'none',
        buttonKey: 'Space',
        dailySpinCap: null,
        ...(staffSessionMinutes === undefined ? {} : { staffSessionMinutes }),
      },
      layout: {
        id: '018f1d2c-0000-7000-8000-00000000fa00',
        name: 'Classic wheel',
        version: 1,
        design: {},
        assetManifest: {},
      },
      prizes: [prize(1, 10_000), prize(2, 0, false)],
    },
    ...rest,
  };
}

const staff = (over: Partial<BoothStaffRecord> = {}): BoothStaffRecord => ({
  accountId: ACCOUNT,
  status: 'active',
  pinHash: 'argon2:7391',
  badgeHash: null,
  staffCode: 'S-7KMQ',
  displayName: 'Nok',
  ...over,
});

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
  verdicts: BoothAccountVerdict[];
  asked: Array<{ stationId: string; phone: string }>;
  close(): void;
}

function open(options: {
  file?: string;
  staffList?: BoothStaffRecord[];
  verify?: 'none' | 'queue';
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
  const verdicts: BoothAccountVerdict[] = [];
  const asked: Harness['asked'] = [];
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
    staff: () => options.staffList ?? [staff()],
    verifySecret: async (hash, secret) => hash === `argon2:${secret}`,
    ...(options.verify === 'none'
      ? {}
      : {
          verifyAccount: async (request) => {
            asked.push({ stationId: request.stationId, phone: request.phone });
            const next = verdicts.shift();
            if (!next) throw new Error('the test queued no verdict');
            return next;
          },
        }),
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
    verdicts,
    asked,
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

// --- Signing in with a phone and password ----------------------------------

test('an account sign-in the cloud accepts opens a session, and the slip names the person', async () => {
  const h = open();
  await publish(h, [entry()]);
  h.verdicts.push({ ok: true, accountId: ACCOUNT, displayName: 'Nok', staffCode: 'S-7KMQ' });

  const result = await h.booth.signIn({ account: { phone: '0812345678', password: 'pw' } });
  assert.deepEqual(result, { ok: true, accountId: ACCOUNT });
  assert.deepEqual(h.asked, [{ stationId: STATION_A, phone: '0812345678' }]);

  const session = await h.booth.staffSession();
  assert.equal(session?.credentialKind, 'password');
  assert.equal(session?.staffCode, 'S-7KMQ');

  const status = await h.booth.status({ online: true });
  assert.equal(status.staffSignedIn, true);
  assert.equal(status.staff?.name, 'Nok');
  assert.equal(status.staff?.code, 'S-7KMQ');
  assert.equal(status.staff?.method, 'account');

  const spin = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: spin.spinId });
  assert.equal(spin.staffAccountId, ACCOUNT);
  assert.equal(voucherData(h.submitted[0]?.job).staff, 'Nok (S-7KMQ)');
  h.close();
});

test('with no internet an account sign-in is refused "offline", and the PIN still works', async () => {
  const h = open();
  await publish(h, [entry()]);
  h.verdicts.push({ ok: false, reason: 'offline' });
  const refused = await h.booth.signIn({ account: { phone: '0812345678', password: 'pw' } });
  assert.deepEqual(refused, { ok: false, reason: 'offline' });
  // Not a guess, so it spends nothing on the booth's throttle.
  assert.equal(await h.store.readThrottle(BOX_ID, BOOTH_STAFF_THROTTLE_SCOPE, STATION_A), null);

  const pin = await h.booth.signIn({ pin: '7391' });
  assert.equal(pin.ok, true);
  assert.equal((await h.booth.staffSession())?.credentialKind, 'pin');
  h.close();
});

test('a booth that cannot reach the cloud at all answers "offline" too', async () => {
  const h = open({ verify: 'none' });
  await publish(h, [entry()]);
  assert.deepEqual(await h.booth.signIn({ account: { phone: '0812345678', password: 'pw' } }), {
    ok: false,
    reason: 'offline',
  });

  const thrown = open();
  await publish(thrown, [entry()]);
  // A verifier that throws — a dropped line mid-request — is the same answer.
  assert.deepEqual(await thrown.booth.signIn({ account: { phone: '0812345678', password: 'pw' } }), {
    ok: false,
    reason: 'offline',
  });
  thrown.close();
  h.close();
});

test('the cloud’s reasons reach the panel: not on this booth, a role that may not, locked', async () => {
  const h = open();
  await publish(h, [entry()]);
  h.verdicts.push(
    { ok: false, reason: 'not_assigned' },
    { ok: false, reason: 'not_allowed' },
    { ok: false, reason: 'locked', retryAfterMs: 120_000 },
  );
  const account = { phone: '0812345678', password: 'pw' };
  assert.deepEqual(await h.booth.signIn({ account }), { ok: false, reason: 'not_assigned' });
  assert.deepEqual(await h.booth.signIn({ account }), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await h.booth.signIn({ account }), {
    ok: false,
    reason: 'locked',
    retryAfterMs: 120_000,
  });
  assert.equal(await h.booth.staffSession(), null);
  h.close();
});

test('a wrong password counts against the booth like a wrong PIN, and the sixth waits', async () => {
  const h = open();
  await publish(h, [entry()]);
  for (let i = 0; i < 6; i += 1) h.verdicts.push({ ok: false, reason: 'wrong' });
  const account = { phone: '0812345678', password: 'nope' };
  for (let i = 1; i <= 5; i += 1) {
    assert.deepEqual(await h.booth.signIn({ account }), { ok: false }, `attempt ${i} is free`);
  }
  const sixth = await h.booth.signIn({ account });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.retryAfterMs, 30_000);
  // And the lock stands for a PIN as well: the throttle is the booth's.
  const pin = await h.booth.signIn({ pin: '7391' });
  assert.equal(pin.ok, false);
  assert.ok((pin.retryAfterMs ?? 0) > 0);
  h.close();
});

test('overlapping wrong passwords are taken one at a time, and those the lock refuses never reach the cloud', async () => {
  /**
   * Closing audit M11, for the account path: a wrong password is counted on
   * the same throttle as a wrong PIN, so an account sign-in waits its turn
   * too. Fired together, the attempts used to read the same count, all went
   * to the cloud, and none of them locked the booth.
   */
  const h = open();
  await publish(h, [entry()]);
  for (let i = 0; i < 8; i += 1) h.verdicts.push({ ok: false, reason: 'wrong' });
  const account = { phone: '0812345678', password: 'nope' };

  const results = await Promise.all(Array.from({ length: 8 }, () => h.booth.signIn({ account })));
  for (let i = 0; i < 5; i += 1)
    assert.deepEqual(results[i], { ok: false }, `attempt ${i + 1} is free`);
  assert.equal(results[5]?.retryAfterMs, 30_000, 'the sixth starts the wait');
  for (const late of results.slice(6)) {
    assert.equal(late.ok, false);
    assert.ok((late.retryAfterMs ?? 0) > 0, 'refused by the lock');
  }
  assert.equal(h.asked.length, 6, 'the two refused by the lock were never forwarded');
  assert.equal(
    (await h.store.readThrottle(BOX_ID, BOOTH_STAFF_THROTTLE_SCOPE, STATION_A))?.failures,
    6,
  );
  h.close();
});

// --- How long a session lasts ----------------------------------------------

test('a session lasts the booth’s session length, survives a restart, and never ends on idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oto-booth-session-'));
  const file = join(dir, 'box.sqlite');
  try {
    const first = open({ file });
    await publish(first, [entry({ staffSessionMinutes: 90 })]);
    assert.equal((await first.booth.signIn({ pin: '7391' })).ok, true);
    const session = await first.booth.staffSession();
    assert.equal(session?.expiresAt, plus(90), 'sign-in plus ninety minutes');
    first.close();

    // The power goes. A new process opens the same file.
    const second = open({ file });
    // What the agent does at every start: open the store before anything reads it.
    await second.store.init(BOX_ID);
    await second.booth.refresh();
    second.setNow(plus(89));
    const held = await second.booth.staffSession();
    assert.equal(held?.accountId, ACCOUNT, 'still signed in after the restart, with nothing pressed');
    const late = await second.booth.spin({ idempotencyKey: 'late-press' });
    await second.booth.print({ spinId: late.spinId });
    assert.equal(late.staffAccountId, ACCOUNT);

    second.setNow(plus(91));
    assert.equal(await second.booth.staffSession(), null, 'ended by its length, not by a sign-out');
    const after = await second.booth.spin({ idempotencyKey: 'after-press' });
    await second.booth.print({ spinId: after.spinId });
    assert.equal(after.staffAccountId, null, 'and the wheel plays on, unattributed');
    assert.equal(voucherData(second.submitted.at(-1)?.job).staff, null);
    assert.equal((await second.booth.status({ online: true })).staffSignedIn, false);
    second.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps a closed SQLite file busy for a moment; the temp folder can wait.
    }
  }
});

test('with no length in the published wheel a session runs twelve hours', async () => {
  const h = open();
  await publish(h, [entry()]);
  await h.booth.signIn({ pin: '7391' });
  assert.equal((await h.booth.staffSession())?.expiresAt, plus(720));
  h.close();
});

test('somebody taken off the booth after signing in is signed out at the next pull', async () => {
  const h = open();
  await publish(h, [entry()]);
  assert.equal((await h.booth.signIn({ pin: '7391' })).ok, true);

  // The Console removes them; the next pull carries the shorter list.
  await publish(h, [entry({ allowedStaff: [OTHER_ACCOUNT] })], plus(5));
  assert.equal(await h.booth.staffSession(), null);
  h.close();
});

test('a list pulled BEFORE an account sign-in does not sign that person out', async () => {
  const h = open();
  // The box last pulled at 06:00, before this person was added in the Console.
  await publish(h, [entry({ allowedStaff: [] })]);
  h.setNow(plus(2));
  h.verdicts.push({ ok: true, accountId: ACCOUNT, displayName: 'Nok', staffCode: 'S-7KMQ' });
  assert.equal((await h.booth.signIn({ account: { phone: '081', password: 'pw' } })).ok, true);
  await h.booth.refresh();
  assert.equal((await h.booth.staffSession())?.accountId, ACCOUNT, 'the cloud checked them seconds ago');
  h.close();
});

test('a staff list change reaches the booth without a new publish', async () => {
  const h = open();
  await publish(h, [entry({ allowedStaff: [] })]);
  assert.deepEqual(await h.booth.signIn({ pin: '7391' }), { ok: false }, 'not on the list yet');

  // Same version, same wheel, a longer staff list beside it.
  await publish(h, [entry({ allowedStaff: [ACCOUNT] })], plus(1));
  assert.equal(h.booth.config()?.version, 1);
  assert.equal((await h.booth.signIn({ pin: '7391' })).ok, true);
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

test('a reprint is staff-only, prints the same code, and never draws a second prize', async () => {
  const h = open();
  await publish(h, [entry()]);
  const won = await h.booth.spin({ idempotencyKey: 'press-1' });
  await h.booth.print({ spinId: won.spinId });
  assert.equal(h.submitted.length, 1);

  await assert.rejects(
    () => h.booth.reprint({}),
    (err: unknown) => err instanceof BoothRefusal && err.code === 'staff_required',
  );
  assert.equal(h.submitted.length, 1, 'nothing printed for nobody');

  await h.booth.signIn({ pin: '7391' });
  const countersBefore = await h.store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, '2026-09-24');
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
  assert.equal(copy.staff, first.staff, 'the person on duty when it was WON');

  assert.deepEqual(
    await h.store.readCounters(BOX_ID, BOOTH_PRIZE_COUNTER_SCOPE, '2026-09-24'),
    countersBefore,
    'no prize counted',
  );
  assert.equal((await h.store.depth(BOX_ID)).queued, depthBefore, 'no spin, no voucher queued');
  assert.deepEqual(
    await h.store.readCounters(BOX_ID, BOOTH_PRESS_COUNTER_SCOPE, '2026-09-24'),
    { 'press-1': 1 },
  );

  // The copy is recorded as a reprint of that voucher, with the account that
  // was signed in when it was asked for — the session's, which is all the box
  // can know about who pressed the button.
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
  assert.equal(print?.payload.requestedByAccountId, ACCOUNT);
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
    await h.booth.signIn({ pin: '7391' });
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
  await h.booth.signIn({ pin: '7391' });
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
  await h.booth.signIn({ pin: '7391' });
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

test('the http contract takes an account sign-in and a reprint, and words neither', async () => {
  const h = open();
  await publish(h, [entry()]);
  const handle = createBoothHttp({ booth: h.booth, online: () => false });

  h.verdicts.push({ ok: false, reason: 'offline' });
  const offline = await handle({
    method: 'POST',
    path: '/staff/sign-in',
    body: { mode: 'account', phone: '0812345678', password: 'pw' },
  });
  assert.equal(offline.status, 200);
  assert.deepEqual(offline.body, { ok: false, reason: 'offline' });

  const noStaff = await handle({ method: 'POST', path: '/reprint', body: {} });
  assert.equal(noStaff.status, 403);
  assert.equal((noStaff.body as { error: { code: string } }).error.code, 'staff_required');

  await handle({ method: 'POST', path: '/staff/sign-in', body: { mode: 'pin', pin: '7391' } });
  const nothing = await handle({ method: 'POST', path: '/reprint', body: {} });
  assert.equal(nothing.status, 404);
  assert.equal((nothing.body as { error: { code: string } }).error.code, 'nothing_to_reprint');

  await handle({ method: 'POST', path: '/spin', body: { idempotencyKey: 'k1' } });
  const reprinted = await handle({ method: 'POST', path: '/reprint', body: {} });
  assert.equal(reprinted.status, 200);
  assert.equal((reprinted.body as { printState: string }).printState, 'printed');

  const status = await handle({ method: 'GET', path: '/status' });
  const body = status.body as { staff: { name: string; code: string } | null };
  assert.equal(body.staff?.name, 'Nok');
  assert.equal(body.staff?.code, 'S-7KMQ');
  assert.equal(JSON.stringify(body).includes(ACCOUNT), false, 'never the account id');
  h.close();
});
