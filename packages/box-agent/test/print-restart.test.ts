import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { generateSyncKeyPair, sealEnvelope } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { EnvelopeSealer, PrintJobRecord } from '../src/store';
import { BOX_ID, STATION_ID, plus } from './_support';

/**
 * The box comes back with the vouchers it had not printed (S2-07a).
 *
 * **A real restart, on a real file.** Everything else in this package tests
 * SQLite in memory, where "restart" would mean nothing — the database dies
 * with the handle. Here the store is a file in a temporary directory, the
 * handle is closed, every object is dropped, and a new store is opened on the
 * same bytes. That is the shape of the acceptance criterion: three unprinted
 * vouchers, somebody presses Restart on Render, and the pending count is
 * unchanged afterwards.
 *
 * **What this file does not do, and where that is done instead.** It does not
 * build the print subsystem. `printing/queue.ts` imports `@oto/print`, which
 * cannot be LOADED by this package's test runner at all: Node's strip-only
 * mode refuses `Bitmap1`'s parameter properties (measured — the error is
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), which is the same reason S2-06's
 * printing tests live in the api's suite. So the durable half is proved here,
 * against the store the subsystem writes to, and the seam between the two —
 * submit, paper out, drop the subsystem, rebuild it on the same file, print —
 * is proved in `apps/api/test/print-restart.test.ts`, where vitest transpiles
 * properly and the real `createPrintSubsystem` and a printer simulator are
 * importable.
 */

const AT = '2026-09-21T03:00:00.000Z';

interface Box {
  db: DatabaseSync;
  store: SqlBoxStore;
  seal: EnvelopeSealer;
  close(): void;
}

const keys = generateSyncKeyPair();

/** Open the box's store on a file, as a Pi does on every boot. */
function bootBox(file: string, at = AT): Box {
  const db = new DatabaseSync(file);
  prepareSqliteBoxStore(db);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => new Date(at) });
  return {
    db,
    store,
    seal: (draft) => sealEnvelope(draft, BOX_ID, keys.privateKeyPem),
    close: () => db.close(),
  };
}

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oto-box-'));
  return join(dir, `${name}.sqlite`);
}

function voucherJob(over: Partial<PrintJobRecord> & Pick<PrintJobRecord, 'id'>): PrintJobRecord {
  return {
    boxId: BOX_ID,
    kind: 'booth_voucher',
    role: 'receipt',
    stationId: STATION_ID,
    deviceId: null,
    copies: 1,
    job: {
      kind: 'booth_voucher',
      data: {
        venueLine: 'Oto — Kids Play Park · Central Phuket',
        prizeLine: '150 THB VOUCHER',
        prizeLineThai: 'บัตรกำนัล 150 บาท',
        redemptionLine: 'Show this QR at OTO Reception.',
        terms: ['One per visit.', 'No cash value.'],
        voucherCode: 'B1K7M2QPXR',
        issuedAt: '21 Sep 2026 10:00',
        booth: 'Central Phuket · G floor',
        staff: 'Som (S-014)',
        expiresAt: '05 Oct 2026',
        footerLine: 'oto.co.th',
      },
    },
    finish: null,
    templateId: null,
    templateVersion: null,
    actionId: null,
    state: 'queued',
    attempts: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    queuedAt: AT,
    updatedAt: AT,
    ...over,
  };
}

test('three vouchers waiting on paper are still waiting after a restart', async () => {
  const file = tempFile('restart');
  const first = bootBox(file);
  await first.store.init(BOX_ID);
  assert.equal(first.store.features().printJobs, true, 'a Pi file has the table');

  for (const id of ['job-1', 'job-2', 'job-3']) {
    await first.store.putPrintJob(
      voucherJob({
        id,
        lastErrorCode: 'PRINTER_PAPER_OUT',
        attempts: 2,
        nextAttemptAt: plus(AT, 30_000),
        queuedAt: plus(AT, ['job-1', 'job-2', 'job-3'].indexOf(id) * 1_000),
      }),
    );
  }
  assert.equal((await first.store.loadPendingPrintJobs(BOX_ID)).length, 3);

  // Somebody presses Restart. Every object above is gone; the file is not.
  first.close();

  const second = bootBox(file, plus(AT, 60_000));
  await second.store.init(BOX_ID);
  const pending = await second.store.loadPendingPrintJobs(BOX_ID);
  assert.deepEqual(
    pending.map((job) => job.id),
    ['job-1', 'job-2', 'job-3'],
    'the same three, in the order they were asked for',
  );
  assert.equal(pending[0]?.attempts, 2, 'the wait resumes rather than starting again');
  assert.equal(pending[0]?.lastErrorCode, 'PRINTER_PAPER_OUT');
  assert.equal(pending[0]?.nextAttemptAt, plus(AT, 30_000));
  assert.deepEqual(
    pending[0]?.job,
    voucherJob({ id: 'job-1' }).job,
    'the voucher can still be rendered: nothing about the job was lost in the round trip',
  );
  second.close();
  rmSync(file, { force: true });
});

test('a job that was going to the printer when the power went is never reprinted', async () => {
  const file = tempFile('interrupted');
  const first = bootBox(file);
  await first.store.init(BOX_ID);
  await first.store.putPrintJob(voucherJob({ id: 'sending', state: 'sending', deviceId: 'dev-1' }));
  await first.store.putPrintJob(voucherJob({ id: 'waiting' }));
  first.close();

  const second = bootBox(file, plus(AT, 5_000));
  await second.store.init(BOX_ID);

  // D12: bytes that reached the head are already paper in somebody's hand, so
  // an unattended retry would put a second voucher beside a torn first one.
  const pending = await second.store.loadPendingPrintJobs(BOX_ID);
  assert.deepEqual(
    pending.map((job) => job.id),
    ['waiting'],
    'the one that never reached a printer resumes; the one that did does not',
  );

  const interrupted = await second.store.loadInterruptedPrintJobs(BOX_ID);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.id, 'sending');
  assert.equal(interrupted[0]?.lastErrorCode, 'PRINT_INTERRUPTED');
  assert.equal(interrupted[0]?.deviceId, 'dev-1', 'the failure can name the printer');

  // It comes back exactly once: it is handed over so the cloud can be told the
  // job failed, and deleting it is what stops it being told twice a boot.
  await second.store.deletePrintJob('sending');
  assert.equal((await second.store.loadInterruptedPrintJobs(BOX_ID)).length, 0);
  second.close();

  const third = bootBox(file, plus(AT, 10_000));
  await third.store.init(BOX_ID);
  assert.equal((await third.store.loadInterruptedPrintJobs(BOX_ID)).length, 0);
  assert.deepEqual(
    (await third.store.loadPendingPrintJobs(BOX_ID)).map((job) => job.id),
    ['waiting'],
  );
  third.close();
  rmSync(file, { force: true });
});

test('the two recoveries are opposites, and one restart does both', async () => {
  const file = tempFile('both');
  const first = bootBox(file);
  await first.store.init(BOX_ID);

  const event = await first.store.enqueue(
    BOX_ID,
    { type: 'booth.spin_recorded', payload: { prize: 'p1' } },
    first.seal,
  );
  await first.store.takeBatch(BOX_ID);
  await first.store.putPrintJob(voucherJob({ id: 'mid-print', state: 'sending' }));
  first.close();

  const second = bootBox(file, plus(AT, 1_000));
  await second.store.init(BOX_ID);

  // An event the cloud may already hold costs one deduplicated insert to send
  // twice. A voucher the printer may already have cut costs a second voucher.
  const batch = await second.store.takeBatch(BOX_ID);
  assert.deepEqual(
    batch.events.map((e) => e.eventId),
    [event.envelope.eventId],
    'the outbox re-sends',
  );
  assert.equal((await second.store.loadPendingPrintJobs(BOX_ID)).length, 0, 'the printer does not');
  assert.equal((await second.store.loadInterruptedPrintJobs(BOX_ID)).length, 1);
  second.close();
  rmSync(file, { force: true });
});

test('a job that finished leaves nothing behind for the next boot', async () => {
  const file = tempFile('finished');
  const first = bootBox(file);
  await first.store.init(BOX_ID);
  await first.store.putPrintJob(voucherJob({ id: 'printed' }));
  // What the queue does on a terminal outcome: the cloud's print_job row is
  // the history from there, and a guest's name has no reason to stay on a box.
  await first.store.deletePrintJob('printed');
  first.close();

  const second = bootBox(file, plus(AT, 1_000));
  await second.store.init(BOX_ID);
  assert.deepEqual(await second.store.loadPendingPrintJobs(BOX_ID), []);
  assert.deepEqual(await second.store.loadInterruptedPrintJobs(BOX_ID), []);
  second.close();
  rmSync(file, { force: true });
});

test('a sign-in lockout is still in force after somebody pulls the plug', async () => {
  const file = tempFile('throttle');
  const first = bootBox(file);
  await first.store.init(BOX_ID);

  let record = await first.store.recordThrottleFailure(BOX_ID, 'booth_pin', STATION_ID, {
    now: AT,
  });
  for (let i = 2; i <= 5; i += 1) {
    record = await first.store.recordThrottleFailure(BOX_ID, 'booth_pin', STATION_ID, {
      now: plus(AT, i * 1_000),
      // The policy is the caller's; the store only remembers what it decided.
      lockedUntil: i >= 5 ? plus(AT, 35_000) : null,
    });
  }
  assert.equal(record.failures, 5);
  assert.equal(record.lockedUntil, plus(AT, 35_000));

  // A kiosk in a mall is a box anybody can reach the power lead of. A lockout
  // that a restart clears is not a lockout.
  first.close();
  const second = bootBox(file, plus(AT, 6_000));
  await second.store.init(BOX_ID);
  const held = await second.store.readThrottle(BOX_ID, 'booth_pin', STATION_ID);
  assert.equal(held?.failures, 5);
  assert.equal(held?.lockedUntil, plus(AT, 35_000));
  assert.equal(held?.firstFailureAt, AT, 'the window it counted over survives too');
  second.close();
  rmSync(file, { force: true });
});

test('the booth remembers who is signed in and what it has given away today', async () => {
  const file = tempFile('booth-state');
  const first = bootBox(file);
  await first.store.init(BOX_ID);

  await first.store.writeStaffSession({
    stationId: STATION_ID,
    boxId: BOX_ID,
    accountId: 'acct-som',
    credentialKind: 'pin',
    staffCode: 'S-014',
    signedInAt: AT,
    lastSeenAt: AT,
    expiresAt: null,
  });
  await first.store.bumpCounter(BOX_ID, {
    scope: 'booth_prize',
    key: 'prize-cash-100',
    businessDate: '2026-09-21',
  });
  await first.store.bumpCounter(BOX_ID, {
    scope: 'booth_spin',
    key: 'all',
    businessDate: '2026-09-21',
  });
  await first.store.markTimeSeen(BOX_ID, AT);
  first.close();

  const second = bootBox(file, plus(AT, 30_000));
  await second.store.init(BOX_ID);
  assert.equal((await second.store.readStaffSession(STATION_ID))?.accountId, 'acct-som');
  assert.equal(
    await second.store.readCounter(BOX_ID, {
      scope: 'booth_prize',
      key: 'prize-cash-100',
      businessDate: '2026-09-21',
    }),
    1,
    'a daily cap counts the same after a restart, which is the point of a daily cap',
  );
  assert.equal(await second.store.lastGoodTime(BOX_ID), AT);
  second.close();
  rmSync(file, { force: true });
});
