import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrintJob } from '@oto/print';
import type { BoxConfigBundle } from '../src/protocol';
import type { ChannelFactory } from '../src/printing/channel';
import { PRINT_CALLED_OFF, createPrintSubsystem, type PrintRequest } from '../src/printing/queue';
import {
  BOX_ID,
  STATION_ID,
  TILL_KIDS_BAND_PRINTER,
  TILL_RECEIPT_PRINTER,
  fakeBoxCloud,
  openTestAgent,
  openTestStore,
  tillBundle,
} from './_support';

/**
 * S2-20 K1 — `printNow`: a set of jobs on paper now, or called off.
 *
 * The self-service kiosk issues a booking's bands, prints them, and only then
 * commits the redemption (events-kiosk plan §5): a printer fault aborts the
 * whole of it and the booking stays redeemable at the till. That rests on two
 * properties of this call, proved here against the simulators a virtual box
 * runs, and against a counting channel for the one case a simulator cannot
 * stage (the roll running out between two jobs):
 *
 *   - NOTHING IS QUEUED. A set that is called off leaves no job behind for the
 *     tick to print later — a band that came out once somebody changed the
 *     roll would be a band for a redemption the kiosk had already abandoned —
 *     and no outcome goes up the platform's print-result route.
 *   - AS LITTLE PAPER AS POSSIBLE. Everything is routed and rendered, and every
 *     printer asked how it is, before the first byte; a fault after that stops
 *     the set and says how many jobs came out before it.
 */

const SIGNED_BAND = 'T1-01J9Z3M4N5P6Q7R8S9T0V1W2X3.ABCDEFGHJKMN';

const RECEIPT: PrintJob = {
  kind: 'receipt',
  data: {
    title: 'Receipt',
    taxInvoiceLines: ['ABBREVIATED TAX INVOICE'],
    receiptNumber: 'K1-000001',
    dateTime: '2026-10-07 10:00',
    lines: [{ qty: 1, name: '2 Hours Play — 1 kid, 1 adult', price: '฿690' }],
    subtotal: '฿690',
    vat: '฿45.14',
    total: '฿690',
    tenders: [{ label: 'Paid online', amount: '฿690' }],
    bandCodes: ['K1-X3ABCD'],
    creditGrants: [],
  } as PrintJob['data'],
} as PrintJob;

const KIDS_BAND: PrintJob = {
  kind: 'kids_wristband',
  data: { duration: '2 Hours', bandCode: SIGNED_BAND, shortCode: 'K1-X3ABCD' },
} as PrintJob;

const band = (id: string): PrintRequest => ({ id, kind: 'kids_wristband', job: KIDS_BAND, stationId: STATION_ID, copies: 1 });
const receipt = (id: string): PrintRequest => ({ id, kind: 'receipt', job: RECEIPT, stationId: STATION_ID, copies: 1 });

test('a set prints whole: every job out, nothing queued, nothing reported to the platform', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  const box = await openTestAgent(cloud);
  const printing = box.agent.printing()!;

  const outcome = await printing.printNow([band('job-band'), receipt('job-receipt')]);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.printed, 2);
  assert.equal(outcome.fault, null);
  assert.deepEqual(outcome.outcomes.map((o) => [o.id, o.status, o.deviceId]), [
    ['job-band', 'printed', TILL_KIDS_BAND_PRINTER],
    ['job-receipt', 'printed', TILL_RECEIPT_PRINTER],
  ]);
  assert.equal(printing.printouts(TILL_KIDS_BAND_PRINTER).length, 1);
  assert.equal(printing.printouts(TILL_RECEIPT_PRINTER).length, 1);
  assert.deepEqual(printing.jobs.pending(), [], 'nothing left on the queue');
  assert.deepEqual(await box.harness.store.loadPendingPrintJobs(BOX_ID), [], 'nothing on the card');
  assert.deepEqual(cloud.printResults, [], 'the caller owns these rows; nothing goes up the print-result route');
  box.close();
});

test('paper out on the band printer: called off before a byte, and nothing prints when the roll goes back in', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  const box = await openTestAgent(cloud);
  const printing = box.agent.printing()!;
  assert.equal(printing.setFault(TILL_KIDS_BAND_PRINTER, 'paper_out'), true);

  // The receipt is on a healthy printer and listed first: it still does not come out.
  const outcome = await printing.printNow([receipt('job-receipt'), band('job-band')]);
  assert.equal(outcome.complete, false);
  assert.equal(outcome.printed, 0);
  assert.equal(outcome.fault?.id, 'job-band');
  assert.equal(outcome.fault?.status, 'failed');
  assert.equal(outcome.fault?.errorCode, 'PRINTER_PAPER_OUT');
  assert.equal(printing.printouts(TILL_RECEIPT_PRINTER).length, 0, 'the healthy printer printed nothing either');
  assert.equal(printing.printouts(TILL_KIDS_BAND_PRINTER).length, 0);

  // A roll goes in and the heartbeat ticks: the called-off set stays called off.
  printing.clearFaults(TILL_KIDS_BAND_PRINTER);
  assert.deepEqual(await printing.jobs.tick(), []);
  assert.equal(printing.printouts(TILL_KIDS_BAND_PRINTER).length, 0);
  assert.deepEqual(await box.harness.store.loadPendingPrintJobs(BOX_ID), []);
  assert.deepEqual(cloud.printResults, []);
  box.close();
});

test('an unreachable printer, a head left open: each named by the printer’s own code', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  const box = await openTestAgent(cloud);
  const printing = box.agent.printing()!;

  printing.setFault(TILL_KIDS_BAND_PRINTER, 'unreachable');
  const offline = await printing.printNow([band('job-a')]);
  assert.equal(offline.complete, false);
  assert.equal(offline.fault?.errorCode, 'PRINTER_UNREACHABLE');

  printing.clearFaults(TILL_KIDS_BAND_PRINTER);
  printing.setFault(TILL_KIDS_BAND_PRINTER, 'cover_open');
  const open = await printing.printNow([band('job-b')]);
  assert.equal(open.fault?.errorCode, 'PRINTER_HEAD_OPEN');

  printing.clearFaults(TILL_KIDS_BAND_PRINTER);
  const clear = await printing.printNow([band('job-c')]);
  assert.equal(clear.complete, true, 'and prints once the printer is well');
  assert.equal(printing.printouts(TILL_KIDS_BAND_PRINTER).length, 1);
  box.close();
});

test('a job with no printer for its role stops the set when it must print, and is skipped when it need not', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  const box = await openTestAgent(cloud);
  const printing = box.agent.printing()!;
  const adultBand: PrintRequest = { ...band('job-adult'), kind: 'adult_wristband' };

  // The till has no adult band printer.
  const stopped = await printing.printNow([band('job-kid'), adultBand]);
  assert.equal(stopped.complete, false);
  assert.equal(stopped.printed, 0, 'stopped at routing, before any printer');
  assert.equal(stopped.fault?.errorCode, 'NO_DEVICE_FOR_ROLE');
  assert.equal(printing.printouts(TILL_KIDS_BAND_PRINTER).length, 0);

  const skipped = await printing.printNow([band('job-kid-2'), { ...receipt('job-voucher'), role: 'bar' }], {
    mustPrint: (r) => r.kind !== 'receipt',
  });
  assert.equal(skipped.complete, true);
  assert.deepEqual(skipped.outcomes.map((o) => [o.id, o.status, o.errorCode]), [
    ['job-voucher', 'skipped', 'NO_DEVICE_FOR_ROLE'],
    ['job-kid-2', 'printed', null],
  ]);
  box.close();
});

/**
 * One ESC/POS printer whose roll runs out after a given number of slips. The
 * roll is judged when a connection opens, so the slip that empties it still
 * finishes cleanly and the NEXT job finds the printer out of paper.
 */
function rollPrinter(slipsBeforeEmpty: number) {
  let slips = 0;
  const open: ChannelFactory = async () => {
    const empty = slips >= slipsBeforeEmpty;
    let wrote = false;
    return {
      async write() {
        if (!wrote) slips += 1;
        wrote = true;
      },
      async query(bytes: Uint8Array) {
        // `DLE EOT n`: paper end is bit 5 of reply 2 and bits 5 and 6 of reply 4.
        const n = bytes[2];
        if (empty && n === 2) return new Uint8Array([0x32]);
        if (empty && n === 4) return new Uint8Array([0x72]);
        return new Uint8Array([0x12]);
      },
      async close() {},
    };
  };
  return { open, slips: () => slips };
}

const ONE_PRINTER = {
  stations: [
    {
      id: STATION_ID,
      name: 'Kiosk 1',
      kind: 'kiosk',
      codePrefix: 'K1',
      devices: [
        {
          id: '018f1d2c-0000-7000-8000-0000000de0b1',
          role: 'receipt',
          kind: 'receipt_printer',
          label: 'Kiosk printer',
          transport: 'network',
          address: '10.0.0.21:9100',
          model: 'Xprinter XP-80',
          protocol: 'escpos',
          settings: {},
        },
      ],
    },
  ],
} as unknown as BoxConfigBundle;

test('the roll runs out between two jobs: the set stops there and says one came out', async () => {
  const box = openTestStore();
  await box.store.init(BOX_ID);
  const printer = rollPrinter(1);
  const reported: unknown[] = [];
  const printing = createPrintSubsystem({
    bundle: () => ONE_PRINTER,
    templates: () => [],
    open: printer.open,
    report: (outcome) => {
      reported.push(outcome);
    },
    durable: () => ({ jobs: box.store, boxId: BOX_ID }),
  });

  const outcome = await printing.printNow([receipt('job-1'), receipt('job-2'), receipt('job-3')]);
  assert.equal(outcome.complete, false);
  assert.equal(outcome.printed, 1, 'one slip came out before the fault — paper somebody has to take back');
  assert.equal(outcome.fault?.id, 'job-2');
  assert.equal(outcome.fault?.errorCode, 'PRINTER_PAPER_OUT');
  assert.deepEqual(outcome.outcomes.map((o) => [o.id, o.status]), [
    ['job-1', 'printed'],
    ['job-2', 'failed'],
  ]);
  assert.equal(printer.slips(), 1);
  assert.deepEqual(reported, [], 'no outcome reported: the caller owns the rows');
  assert.deepEqual(printing.pending(), []);
  assert.deepEqual(await box.store.loadPendingPrintJobs(BOX_ID), [], 'and nothing left for the tick');
  assert.deepEqual(await printing.tick(), []);
  assert.equal(printer.slips(), 1);
  box.close();
});

/**
 * SCRUM-504 — a job the printer failed PART-WAY says so (`partial`): the
 * socket died with some of it written, or the roll ran out under it. The
 * kiosk counts a band that may be half out of the printer as paper in the
 * family's hands. A job refused before a byte was written says nothing of the
 * kind.
 */
test('a job failed part-way is marked partial; one refused before a byte is not', async () => {
  const box = openTestStore();
  await box.store.init(BOX_ID);
  let writes = 0;
  const open: ChannelFactory = async () => ({
    async write() {
      writes += 1;
      if (writes >= 2) throw new Error('socket reset by peer');
    },
    async query() {
      return new Uint8Array([0x12]);
    },
    async close() {},
  });
  const printing = createPrintSubsystem({
    bundle: () => ONE_PRINTER,
    templates: () => [],
    open,
    report: () => undefined,
    durable: () => ({ jobs: box.store, boxId: BOX_ID }),
  });
  const torn = await printing.printNow([receipt('job-1'), receipt('job-2'), receipt('job-3')]);
  assert.equal(torn.complete, false);
  assert.equal(torn.printed, 1);
  assert.equal(torn.fault?.id, 'job-2');
  assert.equal(torn.fault?.errorCode, 'PRINTER_WRITE_FAILED');
  assert.equal(torn.fault?.partial, true, 'some of job-2 may be in the tray');
  assert.equal(torn.outcomes[0]?.partial, undefined, 'a job that came out whole is not partial');

  // The roll found empty as the next job opens: refused before a byte, nothing of it out.
  const roll = rollPrinter(1);
  const clean = createPrintSubsystem({
    bundle: () => ONE_PRINTER,
    templates: () => [],
    open: roll.open,
    report: () => undefined,
    durable: () => ({ jobs: box.store, boxId: BOX_ID }),
  });
  const refused = await clean.printNow([receipt('job-4'), receipt('job-5')]);
  assert.equal(refused.fault?.id, 'job-5');
  assert.equal(refused.fault?.errorCode, 'PRINTER_PAPER_OUT');
  assert.equal(refused.fault?.partial, undefined);
  box.close();
});

/**
 * SCRUM-504 — the kiosk holds its redemption's transaction open while a set
 * prints, and calls a set off when it runs past its budget. Called off, the
 * set starts no further job; the caller is told of every job that came out,
 * as it came out, so it can count the paper even when it stops waiting.
 */
test('a set called off from outside stops before its next job, and every job that came out was told', async () => {
  const box = openTestStore();
  await box.store.init(BOX_ID);
  const printer = rollPrinter(99);
  const reported: unknown[] = [];
  const printing = createPrintSubsystem({
    bundle: () => ONE_PRINTER,
    templates: () => [],
    open: printer.open,
    report: (outcome) => {
      reported.push(outcome);
    },
    durable: () => ({ jobs: box.store, boxId: BOX_ID }),
  });

  // Called off as the first job comes out: the second never starts.
  const controller = new AbortController();
  const told: string[] = [];
  const outcome = await printing.printNow([receipt('job-1'), receipt('job-2'), receipt('job-3')], {
    signal: controller.signal,
    onPrinted: (o) => {
      told.push(o.id);
      controller.abort();
    },
  });
  assert.equal(outcome.complete, false);
  assert.equal(outcome.printed, 1, 'the job already on the printer finished; nothing after it started');
  assert.equal(outcome.fault?.id, 'job-2');
  assert.equal(outcome.fault?.errorCode, PRINT_CALLED_OFF);
  assert.deepEqual(outcome.outcomes.map((o) => [o.id, o.status]), [
    ['job-1', 'printed'],
    ['job-2', 'failed'],
  ]);
  assert.deepEqual(told, ['job-1']);
  assert.equal(printer.slips(), 1);

  // Called off before it began: no printer asked, nothing printed.
  const early = new AbortController();
  early.abort();
  const none = await printing.printNow([receipt('job-4')], { signal: early.signal });
  assert.equal(none.complete, false);
  assert.equal(none.printed, 0);
  assert.equal(none.fault?.errorCode, PRINT_CALLED_OFF);
  assert.equal(printer.slips(), 1);

  // The last job came out before the call-off was seen: the set is whole.
  const late = new AbortController();
  const whole = await printing.printNow([receipt('job-5')], { signal: late.signal, onPrinted: () => late.abort() });
  assert.equal(whole.complete, true);
  assert.equal(whole.printed, 1);
  assert.equal(printer.slips(), 2);

  // Called off or not, nothing is left behind for the tick, and nothing reported.
  assert.deepEqual(reported, []);
  assert.deepEqual(printing.pending(), []);
  assert.deepEqual(await box.store.loadPendingPrintJobs(BOX_ID), []);
  box.close();
});
