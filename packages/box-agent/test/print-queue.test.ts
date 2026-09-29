import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderPreviewPng, type PrintJob } from '@oto/print';
import type { BoxCommandHandout, BoxConfigBundle } from '../src/protocol';
import type { PrintJobRecord } from '../src/store';
import type { ChannelFactory } from '../src/printing/channel';
import {
  createPrintSubsystem,
  profileFor,
  type PrintJobOutcome,
  type PrintRequest,
  type PrintSubsystem,
} from '../src/printing/queue';
import {
  BOX_ID,
  STATION_ID,
  TILL_KIDS_BAND_PRINTER,
  TILL_KITCHEN_PRINTER,
  TILL_RECEIPT_PRINTER,
  fakeBoxCloud,
  openTestAgent,
  openTestStore,
  plus,
  tillBundle,
  type TestStore,
} from './_support';

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

/** A printer that answers "all clear", counts its jobs, can be held mid-job, and can run out of paper. */
function countingPrinter() {
  let slips = 0;
  let queries = 0;
  let paper = true;
  let held: Promise<void> | null = null;
  let release: () => void = () => {};
  let onWrite: (() => void) | null = null;
  const open: ChannelFactory = async () => ({
    async write() {
      onWrite?.();
      if (held) await held;
      slips += 1;
    },
    async query(bytes: Uint8Array) {
      queries += 1;
      // `DLE EOT n`: paper end is bit 5 of reply 2 and bits 5 and 6 of reply 4.
      const n = bytes[2];
      if (!paper && n === 2) return new Uint8Array([0x32]);
      if (!paper && n === 4) return new Uint8Array([0x72]);
      return new Uint8Array([0x12]);
    },
    async close() {},
  });
  return {
    open,
    slips: () => slips,
    /** Status queries asked of it, by jobs and probes alike. */
    queries: () => queries,
    /** Take the paper out (`false`), or put a roll in. */
    paper(loaded: boolean) {
      paper = loaded;
    },
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

/** `now` is the box's clock as the queue reads it; fixed at `AT` unless a test moves it. */
async function rig(opts: { now?: () => Date } = {}): Promise<Rig> {
  const box = openTestStore(AT);
  await box.store.init(BOX_ID);
  const printer = countingPrinter();
  const reported: PrintJobOutcome[] = [];
  const printing = createPrintSubsystem({
    bundle: () => BUNDLE,
    templates: () => [],
    open: printer.open,
    now: opts.now ?? (() => new Date(AT)),
    report: (outcome) => {
      reported.push(outcome);
    },
    durable: () => ({ jobs: box.store, boxId: BOX_ID }),
  });
  return { printing, printer, box, reported };
}

test('the first hand-over after a boot, of a job whose row is already on the card, prints once', async () => {
  let clock = AT;
  const { printing, printer, box, reported } = await rig({ now: () => new Date(clock) });
  // The spin's transaction has written the row; nothing has resumed the queue yet.
  await box.store.putPrintJob({ ...writtenBySpin('job-1'), nextAttemptAt: plus(AT, 30_000) });
  assert.deepEqual(await printing.tick(), [], 'a restart also respects the saved hold');

  await printing.hold(request('job-1'), new Date(plus(AT, 30_000)));
  assert.deepEqual(await printing.tick(), [], 'the retry leaves a held slip alone');
  assert.equal(printer.slips(), 0);
  const outcome = await printing.submit(request('job-1'));
  assert.equal(outcome.status, 'printed');
  assert.deepEqual(
    printing.pending(),
    [],
    'the row read back at the resume was this job, not a second one',
  );
  assert.deepEqual(await printing.tick(), [], 'so the next tick has nothing to print');
  assert.equal(printer.slips(), 1);
  assert.deepEqual(
    reported.map((o) => [o.id, o.status]),
    [['job-1', 'printed']],
    'one outcome, reported once',
  );
  await box.store.putPrintJob({
    ...writtenBySpin('held-fallback'),
    nextAttemptAt: plus(AT, 30_000),
  });
  await printing.hold(request('held-fallback'), new Date(plus(AT, 30_000)));
  clock = plus(AT, 29_999);
  assert.deepEqual(await printing.tick(), [], 'no paper during the animation');
  clock = plus(AT, 30_000);
  assert.equal(
    (await printing.tick())[0]?.status,
    'printed',
    'a missing reveal call gets its slip',
  );
  assert.equal(printer.slips(), 2);
  assert.deepEqual(
    await box.store.loadPendingPrintJobs(BOX_ID),
    [],
    'and nothing left on the card',
  );
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

/**
 * The heartbeat asks every printer how it is before it is sent, through the
 * same per-printer lock the jobs take (M15, closing audit 2026-09-25). A
 * printer busy with a slip is left out and reported as it last was, so a job
 * the printer is not finishing cannot hold the heartbeat's printer check. The
 * same over a real socket, with a printer that stops taking the job, is in
 * `print-channel.test.ts`.
 */
test('the heartbeat printer check does not queue behind a slip on the printer', async () => {
  const { printing, printer, box } = await rig();
  await printing.resume();
  const idle = await printing.probeAll();
  assert.equal(idle[DEVICE_ID]?.paperStatus, 'ok');
  assert.equal(printer.queries(), 4, 'a free printer is asked');

  printer.hold();
  const reached = printer.writing();
  const submitted = printing.submit(request('job-4'));
  await reached;
  const asked = printer.queries();

  const during = await Promise.race([
    printing.probeAll(),
    new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 100)),
  ]);
  if (during === 'waited') assert.fail('probeAll waited for the slip on the printer');
  assert.equal(printer.queries(), asked, 'the busy printer is asked nothing');
  assert.deepEqual(during[DEVICE_ID], idle[DEVICE_ID], 'and reported as it last was');

  printer.release();
  assert.equal((await submitted).status, 'printed');
  const afterJob = printer.queries();
  await printing.probeAll();
  assert.equal(printer.queries(), afterJob + 4, 'once it is free, it is asked again');
  assert.equal(printer.slips(), 1);
  box.close();
});

/**
 * A retry time set on a clock that has since been corrected back (SCRUM-439).
 *
 * The box corrects its clock, not the retry times it wrote before the
 * correction: a Pi that booted three hours ahead after a power cut, took a
 * voucher while the printer was out of paper, and then measured itself
 * against the platform (SCRUM-402) is left with a retry due three hours from
 * now on the corrected clock. The queue holds it to its own cap the way the
 * outbox holds its retries to `OUTBOX_BACKOFF_CAP_MS`: a retry further off
 * than one delay is due now. One inside the delay still waits its turn.
 */
test('a retry set before the clock was corrected back is due now; one inside the delay waits', async () => {
  const HOUR = 3_600_000;
  // Booted three hours ahead; nothing has measured the clock yet.
  let clock = plus(AT, 3 * HOUR);
  const { printing, printer, box } = await rig({ now: () => new Date(clock) });
  await printing.resume();

  printer.paper(false);
  const queued = await printing.submit(request('job-5'));
  assert.equal(queued.status, 'queued');
  assert.equal(queued.errorCode, 'PRINTER_PAPER_OUT');
  assert.equal(printer.slips(), 0);

  // A roll goes in ten seconds on: the retry is twenty seconds away, and stays so.
  printer.paper(true);
  clock = plus(AT, 3 * HOUR + 10_000);
  assert.deepEqual(await printing.tick(), [], 'an ordinary wait is not cut short');
  assert.equal(printing.pending().length, 1);

  // The heartbeat is answered and the box measures itself: three hours back.
  clock = plus(AT, 10_000);
  const outcomes = await printing.tick();
  assert.deepEqual(
    outcomes.map((o) => [o.id, o.status]),
    [['job-5', 'printed']],
    'the voucher waited out the whole offset',
  );
  assert.equal(printer.slips(), 1);
  assert.deepEqual(printing.pending(), []);
  assert.deepEqual(await box.store.loadPendingPrintJobs(BOX_ID), [], 'and nothing is left on the card');
  box.close();
});

// --- A sale's printouts, from the platform (S2-11) ----------------------------
//
// A finalised sale writes one `print_job` per printout and one `test_print`
// command per job, carrying `document: 'platform'` and the job id — and nothing
// a printout says. The box fetches the content by job id as it prints and
// sends it through the same templates, queue and simulators as a test page.
// The documents below are shaped exactly as the platform's
// `GET /box/v1/print-jobs/:id/document` answers them (`sale-printing.ts` in
// the api), extra receipt fields included.

const RECEIPT_JOB = '018f0000-0000-7000-8000-000000000a01';
const KIDS_BAND_JOB = '018f0000-0000-7000-8000-000000000a02';
const KITCHEN_JOB = '018f0000-0000-7000-8000-000000000a03';
const MISSING_JOB = '018f0000-0000-7000-8000-000000000a04';

/** The platform's worked example band code (`@oto/shared`'s pinned test). */
const SIGNED_BAND = 'T1229E98P2DRXHTB6MKV5J2D4DQD2.AJRVQ9V6FDME';

function platformDocument(jobId: string, role: string, job: PrintJob) {
  return {
    status: 200,
    body: {
      printJobId: jobId,
      kind: job.kind,
      role,
      stationId: STATION_ID,
      templateId: null,
      templateVersion: null,
      reprintOf: null,
      job,
    },
  };
}

const SALE_RECEIPT: PrintJob = {
  kind: 'receipt',
  data: {
    title: 'Receipt',
    taxInvoiceLines: ['ใบกำกับภาษีอย่างย่อ', 'ABBREVIATED TAX INVOICE', 'OTO · HKT Central', 'VAT included'],
    receiptNumber: 'T1-000042',
    dateTime: '2026-09-30 14:32',
    staffName: 'Nok',
    memberNickname: 'Mali',
    lines: [{ qty: 1, name: '2 Hours Play — 2 kids, 1 adult', price: '฿1,090' }],
    subtotal: '฿1,090',
    vat: '฿71.31',
    total: '฿1,090',
    tenders: [
      { label: 'Cash', amount: '฿1,090' },
      { label: 'Cash tendered', amount: '฿1,100' },
      { label: 'Change', amount: '฿10' },
    ],
    bandCodes: ['T1-D4DQD2'],
    creditGrants: ['2× Grip Socks to collect'],
    // The two fields the platform adds beyond `ReceiptData`. The template does
    // not draw them; they must not stop the receipt printing either.
    taxRows: [{ label: 'VAT included', amount: '฿71.31', kind: 'tax_included' }],
    copy: false,
  } as PrintJob['data'] & Record<string, unknown>,
} as PrintJob;

const KIDS_BAND: PrintJob = {
  kind: 'kids_wristband',
  data: {
    holderName: 'Mali',
    duration: '2 Hours · valid until 16:32',
    allergy: 'Peanuts',
    bandCode: SIGNED_BAND,
    shortCode: 'T1-D4DQD2',
  },
};

const KITCHEN_TICKET: PrintJob = {
  kind: 'kitchen_ticket',
  data: {
    title: 'Kitchen',
    orderRef: '42',
    time: '14:32',
    holderName: 'Mali',
    allergiesMedical: 'Mali: Peanuts',
    lines: [{ qty: 1, name: 'Hot dog', note: 'no onions' }],
    orderNote: 'Birthday table',
  },
};

/** The command the platform writes for one of a sale's jobs (`writeJob` in `sale-printing.ts`). */
function saleCommand(jobId: string, kind: string, role: string, deviceId: string): BoxCommandHandout {
  return {
    id: `cmd-${jobId.slice(-4)}`,
    kind: 'test_print',
    payload: {
      printJobId: jobId,
      kind,
      role,
      stationId: STATION_ID,
      deviceId,
      copies: 1,
      document: 'platform',
      subjectType: kind === 'receipt' || kind === 'kitchen_ticket' ? 'sale' : 'band',
    },
    actionId: 'sale-finalise-0001',
    attempts: 1,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  };
}

function deviceIn(bundle: BoxConfigBundle, deviceId: string) {
  return bundle.stations.flatMap((s) => s.devices).find((d) => d.id === deviceId)!;
}

test('a sale’s receipt, kids band and kitchen ticket print from the platform’s documents, dot for dot', async () => {
  const bundle = tillBundle();
  const cloud = fakeBoxCloud(bundle);
  cloud.documents.set(RECEIPT_JOB, platformDocument(RECEIPT_JOB, 'receipt', SALE_RECEIPT));
  cloud.documents.set(KIDS_BAND_JOB, platformDocument(KIDS_BAND_JOB, 'kids_band', KIDS_BAND));
  cloud.documents.set(KITCHEN_JOB, platformDocument(KITCHEN_JOB, 'kitchen', KITCHEN_TICKET));
  cloud.commands.push(
    saleCommand(RECEIPT_JOB, 'receipt', 'receipt', TILL_RECEIPT_PRINTER),
    saleCommand(KIDS_BAND_JOB, 'kids_wristband', 'kids_band', TILL_KIDS_BAND_PRINTER),
    saleCommand(KITCHEN_JOB, 'kitchen_ticket', 'kitchen', TILL_KITCHEN_PRINTER),
  );
  const box = await openTestAgent(cloud);
  const printing = box.agent.printing()!;

  assert.equal(await box.agent.runPendingCommands(), 3);
  assert.deepEqual(cloud.documentsAsked, [RECEIPT_JOB, KIDS_BAND_JOB, KITCHEN_JOB], 'each fetched once, by job id');
  assert.deepEqual(
    cloud.printResults.map((r) => [r.jobId, r.body.status]),
    [
      [RECEIPT_JOB, 'printed'],
      [KIDS_BAND_JOB, 'printed'],
      [KITCHEN_JOB, 'printed'],
    ],
  );
  assert.deepEqual(
    cloud.commandResults.map((r) => [r.body.state, r.body.result?.kind, r.body.result?.status]),
    [
      ['succeeded', 'receipt', 'printed'],
      ['succeeded', 'kids_wristband', 'printed'],
      ['succeeded', 'kitchen_ticket', 'printed'],
    ],
  );

  // What each simulator burned is exactly what the renderer draws for the
  // platform's document on that device — the Thai tax-invoice line, the
  // band's QR and short code, the allergy line and all.
  for (const [deviceId, job] of [
    [TILL_RECEIPT_PRINTER, SALE_RECEIPT],
    [TILL_KIDS_BAND_PRINTER, KIDS_BAND],
    [TILL_KITCHEN_PRINTER, KITCHEN_TICKET],
  ] as const) {
    const printouts = printing.printouts(deviceId);
    assert.equal(printouts.length, 1, `one printout on ${deviceId}`);
    assert.equal(printouts[0]!.truncated, false);
    const expected = renderPreviewPng(job, { device: profileFor(deviceIn(bundle, deviceId)), templates: [] });
    assert.deepEqual(printouts[0]!.preview, expected, `${job.kind} is the platform's document, rendered`);
  }
  // Nothing a printout says rode the command history.
  assert.equal(JSON.stringify(cloud.commandResults).includes(SIGNED_BAND), false);
  assert.equal(JSON.stringify(cloud.printResults).includes('Peanuts'), false);
  box.close();
});

test('a job whose content the platform will not hand over prints nothing, and says so on the job and the command', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  // One the platform has no such job for (404), one answered with something
  // that is not a printout.
  cloud.documents.set(RECEIPT_JOB, { status: 200, body: { printJobId: RECEIPT_JOB, job: { kind: 'poster', data: {} } } });
  cloud.commands.push(
    saleCommand(MISSING_JOB, 'receipt', 'receipt', TILL_RECEIPT_PRINTER),
    saleCommand(RECEIPT_JOB, 'receipt', 'receipt', TILL_RECEIPT_PRINTER),
  );
  const box = await openTestAgent(cloud);

  assert.equal(await box.agent.runPendingCommands(), 2);
  for (const [i, jobId] of [MISSING_JOB, RECEIPT_JOB].entries()) {
    const command = cloud.commandResults[i]!.body;
    assert.equal(command.state, 'failed');
    assert.equal(command.errorCode, 'DOCUMENT_UNAVAILABLE');
    // The job's own row is told too, so the till's printer light does not
    // count it as queued for ever; History's reprint mints a new job.
    const job = cloud.printResults.find((r) => r.jobId === jobId)!.body;
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode, 'DOCUMENT_UNAVAILABLE');
    assert.equal(job.attempts, 0);
  }
  assert.match(String(cloud.commandResults[0]!.body.errorMessage), /PRINT_JOB_NOT_FOUND/);
  assert.equal(box.agent.printing()!.printouts(TILL_RECEIPT_PRINTER).length, 0);
  box.close();
});

test('a receipt waiting on an empty roll keeps its document, and prints once paper is back — fetched once', async () => {
  const cloud = fakeBoxCloud(tillBundle());
  cloud.documents.set(RECEIPT_JOB, platformDocument(RECEIPT_JOB, 'receipt', SALE_RECEIPT));
  cloud.commands.push(saleCommand(RECEIPT_JOB, 'receipt', 'receipt', TILL_RECEIPT_PRINTER));
  const box = await openTestAgent(cloud);
  const printing = box.agent.printing()!;
  assert.equal(printing.setFault(TILL_RECEIPT_PRINTER, 'paper_out'), true);

  assert.equal(await box.agent.runPendingCommands(), 1);
  // The command worked — the box understood it and queued it — and the job
  // says it is waiting on paper. The sale closed long before either.
  assert.equal(cloud.commandResults[0]!.body.state, 'succeeded');
  assert.equal(cloud.commandResults[0]!.body.result?.status, 'queued');
  assert.equal(cloud.printResults.at(-1)!.body.status, 'queued');
  assert.equal(cloud.printResults.at(-1)!.body.errorCode, 'PRINTER_PAPER_OUT');
  assert.equal(printing.printouts(TILL_RECEIPT_PRINTER).length, 0);

  // A roll goes in; the heartbeat's tick tries the queue again.
  printing.clearFaults(TILL_RECEIPT_PRINTER);
  const outcomes = await printing.jobs.tick();
  assert.deepEqual(outcomes.map((o) => [o.id, o.status]), [[RECEIPT_JOB, 'printed']]);
  assert.equal(printing.printouts(TILL_RECEIPT_PRINTER).length, 1);
  assert.equal(cloud.printResults.at(-1)!.body.status, 'printed');
  assert.deepEqual(cloud.documentsAsked, [RECEIPT_JOB], 'the queue held the document; nothing was fetched twice');
  box.close();
});
