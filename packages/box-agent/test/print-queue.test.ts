import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrintJob } from '@oto/print';
import type { BoxConfigBundle } from '../src/protocol';
import type { PrintJobRecord } from '../src/store';
import type { ChannelFactory } from '../src/printing/channel';
import {
  createPrintSubsystem,
  type PrintJobOutcome,
  type PrintRequest,
  type PrintSubsystem,
} from '../src/printing/queue';
import { BOX_ID, STATION_ID, openTestStore, type TestStore } from './_support';

/**
 * One job id is one slip (SCRUM-223).
 *
 * The queue is attempted from two places — `submit`, when somebody presses,
 * and `tick`, from the heartbeat — and it picks up the rows on the card the
 * first time either of them runs. Each of those was a way to put one job on the
 * printer twice: a row its caller had already written, read back beside the
 * caller's own copy; a tick arriving while `submit` was still printing; a
 * `submit` arriving while the tick was printing the row it had just read.
 *
 * The printer here is a channel that counts the jobs written to it and can be
 * held mid-job, so "while it is printing" is a state the test stands in rather
 * than a race it hopes to win. The runner's tests prove the same over a real
 * socket, on the boot that made the first case reachable.
 */

const DEVICE_ID = '018f1d2c-0000-7000-8000-0000000de0a1';
const AT = '2026-09-21T03:00:00.000Z';

const VOUCHER: PrintJob = {
  kind: 'booth_voucher',
  data: {
    venueLine: 'Oto — Kids Play Park · Central Phuket',
    prizeLine: '150 THB VOUCHER',
    prizeLineThai: 'บัตรกำนัล 150 บาท',
    redemptionLine: 'Show this QR at OTO Reception.',
    terms: ['One per visit.'],
    voucherCode: 'B1K7M2QPXR',
    issuedAt: '21 Sep 2026 10:00',
    booth: 'Central Phuket · G floor',
    staff: null,
    expiresAt: '05 Oct 2026',
    footerLine: 'oto.co.th',
  },
};

/** The one station and printer the queue routes to. Only `stations` is read. */
const BUNDLE = {
  stations: [
    {
      id: STATION_ID,
      name: 'Booth 1',
      kind: 'booth',
      codePrefix: 'B1',
      devices: [
        {
          id: DEVICE_ID,
          role: 'receipt',
          kind: 'receipt_printer',
          label: 'Booth printer',
          transport: 'network',
          address: '10.0.0.9:9100',
          model: 'Xprinter XP-80',
          protocol: 'escpos',
          settings: {},
        },
      ],
    },
  ],
} as unknown as BoxConfigBundle;

function request(id: string): PrintRequest {
  return { id, kind: 'booth_voucher', job: VOUCHER, stationId: STATION_ID, actionId: null, copies: 1 };
}

/** The row a spin writes inside its own transaction, before it hands the job over. */
function writtenBySpin(id: string): PrintJobRecord {
  return {
    id,
    boxId: BOX_ID,
    kind: 'booth_voucher',
    role: 'receipt',
    stationId: STATION_ID,
    deviceId: null,
    copies: 1,
    job: VOUCHER,
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
  };
}

/** A printer that answers "all clear", counts its jobs, and can be held mid-job. */
function countingPrinter() {
  let slips = 0;
  let held: Promise<void> | null = null;
  let release: () => void = () => {};
  let onWrite: (() => void) | null = null;
  const open: ChannelFactory = async () => ({
    async write() {
      onWrite?.();
      if (held) await held;
      slips += 1;
    },
    async query() {
      return new Uint8Array([0x12]);
    },
    async close() {},
  });
  return {
    open,
    slips: () => slips,
    /** The next job stops on the printer until `release`. */
    hold() {
      held = new Promise<void>((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
    },
    release: () => release(),
    /** Resolves when a job has reached the printer. */
    writing: () => new Promise<void>((resolve) => (onWrite = resolve)),
  };
}

interface Rig {
  printing: PrintSubsystem;
  printer: ReturnType<typeof countingPrinter>;
  box: TestStore;
  reported: PrintJobOutcome[];
}

async function rig(): Promise<Rig> {
  const box = openTestStore(AT);
  await box.store.init(BOX_ID);
  const printer = countingPrinter();
  const reported: PrintJobOutcome[] = [];
  const printing = createPrintSubsystem({
    bundle: () => BUNDLE,
    templates: () => [],
    open: printer.open,
    now: () => new Date(AT),
    report: (outcome) => {
      reported.push(outcome);
    },
    durable: () => ({ jobs: box.store, boxId: BOX_ID }),
  });
  return { printing, printer, box, reported };
}

test('the first hand-over after a boot, of a job whose row is already on the card, prints once', async () => {
  const { printing, printer, box, reported } = await rig();
  // The spin's transaction has written the row; nothing has resumed the queue yet.
  await box.store.putPrintJob(writtenBySpin('job-1'));

  const outcome = await printing.submit(request('job-1'));
  assert.equal(outcome.status, 'printed');
  assert.deepEqual(printing.pending(), [], 'the row read back at the resume was this job, not a second one');
  assert.deepEqual(await printing.tick(), [], 'so the next tick has nothing to print');
  assert.equal(printer.slips(), 1);
  assert.deepEqual(
    reported.map((o) => [o.id, o.status]),
    [['job-1', 'printed']],
    'one outcome, reported once',
  );
  assert.deepEqual(await box.store.loadPendingPrintJobs(BOX_ID), [], 'and nothing left on the card');
  box.close();
});

test('a tick that arrives while a slip is on the printer leaves that job alone', async () => {
  const { printing, printer, box, reported } = await rig();
  await printing.resume();
  printer.hold();
  const reached = printer.writing();
  const submitted = printing.submit(request('job-2'));
  await reached;

  const ticked = printing.tick();
  printer.release();
  const outcome = await submitted;
  assert.equal(outcome.status, 'printed');
  assert.deepEqual(await ticked, [], 'the tick found it on the printer and did not start it again');
  assert.equal(printer.slips(), 1);
  assert.equal(reported.length, 1);
  box.close();
});

test('a hand-over while the tick is printing the same job answers with that attempt', async () => {
  const { printing, printer, box, reported } = await rig();
  await box.store.putPrintJob(writtenBySpin('job-3'));
  printer.hold();
  const reached = printer.writing();
  // The heartbeat gets there first: it resumes the queue, reads the row, and prints it.
  const ticked = printing.tick();
  await reached;

  const submitted = printing.submit(request('job-3'));
  printer.release();
  const [tickOutcomes, outcome] = await Promise.all([ticked, submitted]);
  assert.equal(printer.slips(), 1, 'one slip');
  assert.equal(outcome.status, 'printed', 'the caller hears how the attempt on the printer went');
  assert.deepEqual(
    tickOutcomes.map((o) => o.id),
    ['job-3'],
  );
  assert.equal(reported.length, 1);
  assert.deepEqual(printing.pending(), []);
  box.close();
});
