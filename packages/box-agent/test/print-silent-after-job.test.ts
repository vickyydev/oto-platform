import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { describe, test } from 'node:test';

import { renderJob, type PrintJob } from '@oto/print';
import type { BoxConfigBundle, BoxConfigDevice } from '../src/protocol';
import {
  AFTER_JOB_FIRST_REPLY_MS,
  SILENT_AFTER_JOB_ASKS,
  SILENT_AFTER_JOB_PAUSE_MS,
  SILENT_AFTER_JOB_WAIT_MS,
  escposAdapter,
} from '../src/printing/adapter';
import { PrinterError, tcpChannel, type ChannelFactory } from '../src/printing/channel';
import {
  createPrintSubsystem,
  profileFor,
  type PrintJobOutcome,
  type PrintRequest,
  type PrintSubsystem,
} from '../src/printing/queue';
import { BOX_ID, STATION_ID, openTestStore, type TestStore } from './_support';

/**
 * A printer that answered before the job and is silent after it (SCRUM-429).
 *
 * After every job the adapter asks the printer how it is, and what silence
 * means depends on whether the printer answered the read before the job:
 *
 *  (a) it answers: printed, and its health is the answer;
 *  (b) it answered nothing before the job either, as a unit whose LAN board
 *      passes no `DLE EOT` back does: printed, with its status unknown,
 *      because such a unit must still print;
 *  (c) it answered before and says nothing after: asked again
 *      `SILENT_AFTER_JOB_ASKS` times, then failed with
 *      `PRINTER_SILENT_AFTER_JOB`, partial, and never sent again by the
 *      queue's timer.
 *
 * Case (c) is a slip smaller than the kernel's buffers sent to a printer that
 * then stops reading, a jam or the roll run out. The write deadline cannot
 * see it (`write` in `tcpChannel`), and it used to be recorded printed.
 *
 * Everything here goes through `tcpChannel`, with its real timings, to a fake
 * printer on loopback that reads the stream as a printer does. Waits are
 * asserted, as in `print-channel.test.ts`, only from below by the timers
 * they are made of, which never fire early, and from above as a hang guard;
 * never as tight wall-clock numbers: the proof that the asks happened is the
 * queries counted, on the wire or at the channel. The case (c) tests take
 * five to nine seconds each, all of it timers, so they run side by side.
 */

/** An idle "all clear" reply to any `DLE EOT n`: bits 1 and 4 set (§9.3). */
const ALL_CLEAR = 0x12;

/** The size of the seeded booth slip as rendered at 576 dots (the audit's 43,041 bytes). */
const SLIP_BYTES = 43_041;

const AT = '2026-09-25T03:00:00.000Z';
const DEVICE_ID = '018f1d2c-0000-7000-8000-0000000de0c1';

/** One status query as the printer read it: which one, and whether it answered. */
type Asked = [n: number, answered: boolean];

interface FakePrinterOptions {
  /**
   * Answer the queries read before any of a job has arrived. Default true;
   * false is a LAN board that passes no `DLE EOT` back.
   */
  answersBefore?: boolean;
  /**
   * What becomes of the queries read once a job has arrived: each answered
   * (the default), each left unanswered (`'silent'`), or, for a number n, the
   * first n left unanswered and every one after them answered.
   */
  afterJob?: 'answers' | 'silent' | number;
  /**
   * Stop reading once this many job bytes are in, as a printer does that
   * jams or runs out of paper. What it has not read stays in the buffers, and
   * so do the queries behind the job.
   */
  stopAfter?: number;
  /** With `stopAfter`, read again this long after stopping, as once somebody has cleared it. */
  resumeAfterMs?: number;
}

interface FakePrinter {
  port: number;
  /** Sessions opened to it. A job sent again would be a second. */
  connections(): number;
  /** Job bytes read: everything but the status queries. */
  taken(): number;
  /** The queries read before any job bytes on their session, and after. */
  asked(): { before: Asked[]; after: Asked[] };
  close(): Promise<void>;
}

/**
 * Read the stream as the printer does. A `GS v 0` image is stepped over by
 * the length its header declares, so the dots of a rendered slip are never
 * taken for a `DLE EOT` (the simulator's `countedPayload` says why that
 * matters), and a command split between two reads is put back together.
 */
function escposReader(): (data: Buffer) => { queries: number[]; jobBytes: number } {
  let image = 0;
  let carry = Buffer.alloc(0);
  return (data) => {
    const bytes = carry.length > 0 ? Buffer.concat([carry, data]) : data;
    carry = Buffer.alloc(0);
    const queries: number[] = [];
    let jobBytes = 0;
    let i = 0;
    while (i < bytes.length) {
      if (image > 0) {
        const step = Math.min(image, bytes.length - i);
        image -= step;
        jobBytes += step;
        i += step;
        continue;
      }
      const left = bytes.length - i;
      const b0 = bytes[i];
      const b1 = left > 1 ? bytes[i + 1] : undefined;
      const b2 = left > 2 ? bytes[i + 2] : undefined;
      // `DLE EOT n`: three bytes.
      if (b0 === 0x10 && (b1 === undefined || b1 === 0x04)) {
        if (left < 3) {
          carry = Buffer.from(bytes.subarray(i));
          break;
        }
        queries.push(b2 ?? 0);
        i += 3;
        continue;
      }
      // `GS v 0 m xL xH yL yH`, then (xL + xH × 256) bytes a row for (yL + yH × 256) rows.
      if (b0 === 0x1d && (b1 === undefined || b1 === 0x76) && (b2 === undefined || b2 === 0x30)) {
        if (left < 8) {
          carry = Buffer.from(bytes.subarray(i));
          break;
        }
        const widthBytes = (bytes[i + 4] ?? 0) | ((bytes[i + 5] ?? 0) << 8);
        const rows = (bytes[i + 6] ?? 0) | ((bytes[i + 7] ?? 0) << 8);
        image = widthBytes * rows;
        jobBytes += 8;
        i += 8;
        continue;
      }
      jobBytes += 1;
      i += 1;
    }
    return { queries, jobBytes };
  };
}

async function fakePrinter(opts: FakePrinterOptions = {}): Promise<FakePrinter> {
  const sockets = new Set<Socket>();
  const before: Asked[] = [];
  const after: Asked[] = [];
  let connections = 0;
  let taken = 0;

  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    const read = escposReader();
    let jobSeen = false;
    let dropped = 0;
    let stopAt = opts.stopAfter;
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));

    const answer = (n: number): void => {
      let answered: boolean;
      if (!jobSeen) {
        answered = opts.answersBefore ?? true;
      } else {
        const policy = opts.afterJob ?? 'answers';
        if (policy === 'answers') answered = true;
        else if (policy === 'silent') answered = false;
        else {
          answered = dropped >= policy;
          if (!answered) dropped += 1;
        }
      }
      (jobSeen ? after : before).push([n, answered]);
      if (answered) socket.write(Buffer.from([ALL_CLEAR]));
    };

    socket.on('data', (data: Buffer) => {
      const { queries, jobBytes } = read(data);
      // A query can share a read with the end of a job, never with its start:
      // the job is only sent once the read before it is over.
      if (jobBytes > 0) {
        jobSeen = true;
        taken += jobBytes;
      }
      if (stopAt !== undefined && taken >= stopAt) {
        stopAt = undefined;
        socket.pause();
        // Queries that came in with the end of the job are held with it: a
        // printer that has stopped acts on nothing behind the job.
        if (opts.resumeAfterMs !== undefined) {
          const timer = setTimeout(() => {
            for (const n of queries) answer(n);
            socket.resume();
          }, opts.resumeAfterMs);
          timer.unref();
        }
        return;
      }
      for (const n of queries) answer(n);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    connections: () => connections,
    taken: () => taken,
    asked: () => ({ before: [...before], after: [...after] }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * `tcpChannel`, counting what the adapter does with it: every status query it
 * asks, answered or not, including the ones a printer that has stopped
 * reading never sees, and every write.
 */
function countingChannel() {
  const asked: number[] = [];
  let writes = 0;
  let written = 0;
  const open: ChannelFactory = async (target) => {
    const channel = await tcpChannel(target);
    return {
      write(bytes) {
        writes += 1;
        written += bytes.length;
        return channel.write(bytes);
      },
      query(bytes, expect, timeoutMs) {
        asked.push(bytes[2] ?? 0);
        return channel.query(bytes, expect, timeoutMs);
      },
      close: () => channel.close(),
    };
  };
  return { open, asked: () => [...asked], writes: () => writes, written: () => written };
}

function adapterFor(printer: FakePrinter, open: ChannelFactory = tcpChannel) {
  return escposAdapter({
    deviceId: DEVICE_ID,
    label: 'Booth printer',
    target: { host: '127.0.0.1', port: printer.port },
    open,
    now: () => new Date(),
  });
}

interface Rig {
  printing: PrintSubsystem;
  reported: PrintJobOutcome[];
  logged: { level: string; msg: string; detail?: Record<string, unknown> }[];
  box: TestStore;
  /** Move the queue's clock on, as the heartbeat's ticks find it. */
  advance(ms: number): void;
}

/** The queue as the box builds it, with its store on the card, printing to `printer`. */
async function rig(printer: FakePrinter, open: ChannelFactory = tcpChannel): Promise<Rig> {
  const box = openTestStore(AT);
  await box.store.init(BOX_ID);
  let clock = Date.parse(AT);
  const reported: PrintJobOutcome[] = [];
  const logged: Rig['logged'] = [];
  const printing = createPrintSubsystem({
    bundle: () => bundleFor(printer.port),
    templates: () => [],
    open,
    now: () => new Date(clock),
    log: (level, msg, detail) => {
      logged.push({ level, msg, detail });
    },
    report: (outcome) => {
      reported.push(outcome);
    },
    durable: () => ({ jobs: box.store, boxId: BOX_ID }),
  });
  return {
    printing,
    reported,
    logged,
    box,
    advance: (ms) => {
      clock += ms;
    },
  };
}

function voucher(id: string, copies = 1): PrintRequest {
  return { id, kind: 'booth_voucher', job: VOUCHER, stationId: STATION_ID, actionId: null, copies };
}

/** A job of `size` bytes of filler: no `DLE EOT` inside it for the fake to answer. */
function filler(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x20);
}

function unanswered(count: number): Asked[] {
  return Array.from({ length: count }, (): Asked => [1, false]);
}

const ANSWERED_READ: Asked[] = [
  [1, true],
  [2, true],
  [3, true],
  [4, true],
];

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await work;
  return { value, ms: Date.now() - startedAt };
}

async function timedFailure(work: Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const startedAt = Date.now();
  try {
    await work;
  } catch (error) {
    return { error, ms: Date.now() - startedAt };
  }
  assert.fail('the job was expected to fail');
}

describe('the read after a job (SCRUM-429)', { concurrency: true }, () => {
  test('(a) answered before and after: printed, and its health is the answer', async () => {
    const printer = await fakePrinter();
    const { printing, box } = await rig(printer);
    try {
      const outcome = await printing.submit(voucher('job-a'));
      assert.equal(outcome.status, 'printed');
      assert.equal(outcome.errorCode, null);
      const health = printing.health()[DEVICE_ID];
      assert.equal(health?.statusUnknown, false);
      assert.equal(health?.paperStatus, 'ok');
      assert.equal(health?.lastError, null);
      assert.deepEqual(printer.asked(), { before: ANSWERED_READ, after: ANSWERED_READ });
    } finally {
      box.close();
      await printer.close();
    }
  });

  test('(b) silent before and after: printed with its status unknown, and not asked again', async () => {
    const printer = await fakePrinter({ answersBefore: false, afterJob: 'silent' });
    const { printing, box } = await rig(printer);
    try {
      const outcome = await printing.submit(voucher('job-b'));
      assert.equal(outcome.status, 'printed', 'a unit that answers no status query still prints');
      const health = printing.health()[DEVICE_ID];
      assert.equal(health?.reachability, 'reachable');
      assert.equal(health?.statusUnknown, true);
      assert.equal(health?.paperStatus, 'unknown');
      assert.equal(health?.lastError, null);
      // One unanswered query on each side. The asks of case (c) are for a
      // printer that answered before the job; this one never pays for them.
      assert.deepEqual(printer.asked(), { before: unanswered(1), after: unanswered(1) });
    } finally {
      box.close();
      await printer.close();
    }
  });

  test('(c) answered before, stopped with the slip in the buffers: asked again, then failed as partial within its wait', async () => {
    const printer = await fakePrinter({ stopAfter: SLIP_BYTES });
    const counted = countingChannel();
    try {
      const { error, ms } = await timedFailure(
        adapterFor(printer, counted.open).print({ bytes: filler(SLIP_BYTES) }),
      );
      assert.ok(error instanceof PrinterError, `the job ended ${String(error)}`);
      assert.equal(error.code, 'PRINTER_SILENT_AFTER_JOB');
      assert.equal(error.partial, true, 'the slip may be on the paper');
      assert.equal(error.retryable, false, 'so nothing sends it again by itself');
      assert.equal(printer.taken(), SLIP_BYTES, 'the printer took all of it');
      // Four queries before the job. After it, the first read and each ask
      // stop at their first query, which a printer that has stopped reading
      // never sees.
      assert.deepEqual(counted.asked(), [
        1,
        2,
        3,
        4,
        ...Array.from({ length: 1 + SILENT_AFTER_JOB_ASKS }, () => 1),
      ]);
      assert.deepEqual(printer.asked(), { before: ANSWERED_READ, after: [] });
      // The lower bound is the rule: it waited out every ask. The upper one
      // only guards against a hang.
      assert.ok(ms >= SILENT_AFTER_JOB_WAIT_MS - 50, `gave up after ${ms} ms`);
      assert.ok(ms < 4 * SILENT_AFTER_JOB_WAIT_MS, `gave up after ${ms} ms`);
    } finally {
      await printer.close();
    }
  });

  test('(c) at the queue: failed, the health says why, and nothing sends it again', async () => {
    // This one reads on and answers nothing after the job, so the asks can be
    // counted on the wire.
    const printer = await fakePrinter({ afterJob: 'silent' });
    const { printing, reported, logged, box, advance } = await rig(printer);
    try {
      const outcome = await printing.submit(voucher('job-c'));
      assert.equal(outcome.status, 'failed', 'not recorded printed');
      assert.equal(outcome.errorCode, 'PRINTER_SILENT_AFTER_JOB');
      assert.deepEqual(printer.asked(), {
        before: ANSWERED_READ,
        after: unanswered(1 + SILENT_AFTER_JOB_ASKS),
      });

      const health = printing.health()[DEVICE_ID];
      assert.deepEqual(
        health && {
          reachability: health.reachability,
          paperStatus: health.paperStatus,
          statusUnknown: health.statusUnknown,
          lastError: health.lastError,
        },
        {
          reachability: 'reachable',
          paperStatus: 'unknown',
          statusUnknown: true,
          lastError: 'PRINTER_SILENT_AFTER_JOB',
        },
      );
      assert.ok(
        logged.some(
          (line) => line.level === 'warn' && line.detail?.errorCode === 'PRINTER_SILENT_AFTER_JOB',
        ),
        'the box logs it at warn',
      );
      assert.deepEqual(
        reported.map((o) => [o.id, o.status, o.errorCode]),
        [['job-c', 'failed', 'PRINTER_SILENT_AFTER_JOB']],
        'reported once, as every failed job is',
      );

      // Nothing kept: not on the queue, and not on the card for a restart.
      assert.deepEqual(printing.pending(), []);
      assert.deepEqual(await box.store.loadPendingPrintJobs(BOX_ID), []);
      assert.deepEqual(await box.store.loadInterruptedPrintJobs(BOX_ID), []);

      // Well past the retry delay, the tick finds nothing to send.
      advance(10 * 60_000);
      assert.deepEqual(await printing.tick(), []);
      assert.equal(printer.connections(), 1, 'one session: the job was never sent again');
    } finally {
      box.close();
      await printer.close();
    }
  });

  test('(c) silent after the job until the last ask, which it answers: printed', async () => {
    // Silent to the read after the job and to every ask but the last: the
    // latest answer the rule accepts.
    const printer = await fakePrinter({ afterJob: SILENT_AFTER_JOB_ASKS });
    try {
      const result = await adapterFor(printer).print({ bytes: filler(SLIP_BYTES) });
      assert.equal(result.written, 1);
      assert.equal(result.health.statusUnknown, false, 'what it said is kept');
      assert.equal(result.health.paperStatus, 'ok');
      assert.deepEqual(printer.asked().after, [...unanswered(SILENT_AFTER_JOB_ASKS), ...ANSWERED_READ]);
    } finally {
      await printer.close();
    }
  });

  test('(c) stopped with the slip in the buffers, reading again before the asks run out: printed', async () => {
    // It reads again half-way through the pause before the first ask, after
    // the read that follows the job has given up. Its late answers are then
    // waiting on the socket, and the ask reads them.
    const resumeAfterMs = AFTER_JOB_FIRST_REPLY_MS + SILENT_AFTER_JOB_PAUSE_MS / 2;
    const printer = await fakePrinter({ stopAfter: SLIP_BYTES, resumeAfterMs });
    try {
      const { value, ms } = await timed(adapterFor(printer).print({ bytes: filler(SLIP_BYTES) }));
      assert.equal(value.written, 1);
      assert.equal(value.health.statusUnknown, false);
      assert.equal(value.health.paperStatus, 'ok');
      assert.ok(ms >= resumeAfterMs - 50, `printed after ${ms} ms, before the printer read again`);
      assert.ok(ms < 4 * SILENT_AFTER_JOB_WAIT_MS, `printed after ${ms} ms`);
      assert.equal(printer.connections(), 1);
    } finally {
      await printer.close();
    }
  });

  test('(c) three copies, the printer stopping once it has the first: failed, and no copy is sent again', async () => {
    const oneCopy = renderJob(VOUCHER, { device: profileFor(deviceRow(0)), templates: [] }).bytes
      .length;
    const printer = await fakePrinter({ stopAfter: oneCopy });
    const counted = countingChannel();
    const { printing, reported, box, advance } = await rig(printer, counted.open);
    try {
      const outcome = await printing.submit(voucher('job-copies', 3));
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.errorCode, 'PRINTER_SILENT_AFTER_JOB');
      // The other two went into the buffers behind the first, as a small job
      // does, so the read after the job decided it.
      assert.equal(counted.writes(), 3, 'each copy written once');
      assert.equal(counted.written(), 3 * oneCopy);
      const taken = printer.taken();
      assert.ok(taken >= oneCopy && taken <= 3 * oneCopy, `the printer read ${taken} bytes`);

      advance(10 * 60_000);
      assert.deepEqual(await printing.tick(), []);
      assert.equal(printer.connections(), 1, 'one session: no copy was sent again');
      assert.equal(counted.writes(), 3, 'and nothing more was written');
      assert.deepEqual(
        reported.map((o) => [o.id, o.status]),
        [['job-copies', 'failed']],
      );
    } finally {
      box.close();
      await printer.close();
    }
  });
});

const VOUCHER: PrintJob = {
  kind: 'booth_voucher',
  data: {
    venueLine: 'Oto — Kids Play Park · Central Phuket',
    prizeLine: '150 THB VOUCHER',
    prizeLineThai: 'บัตรกำนัล 150 บาท',
    redemptionLine: 'Show this QR at OTO Reception.',
    terms: ['One per visit.'],
    voucherCode: 'B1K7M2QPXR',
    issuedAt: '25 Sep 2026 10:00',
    booth: 'Central Phuket · G floor',
    staff: null,
    expiresAt: '09 Oct 2026',
    footerLine: 'oto.co.th',
  },
};

/** The bench's printer, as the booth station's device row names it. */
function deviceRow(port: number): BoxConfigDevice {
  return {
    id: DEVICE_ID,
    role: 'receipt',
    kind: 'receipt_printer',
    label: 'Booth printer',
    transport: 'network',
    address: `127.0.0.1:${port}`,
    model: 'Epson TM-T82IV',
    protocol: 'escpos',
    settings: {},
  } as unknown as BoxConfigDevice;
}

/** One booth station and its printer on loopback. The queue reads only `stations`. */
function bundleFor(port: number): BoxConfigBundle {
  return {
    stations: [
      {
        id: STATION_ID,
        name: 'Booth 1',
        kind: 'booth',
        codePrefix: 'B1',
        devices: [deviceRow(port)],
      },
    ],
  } as unknown as BoxConfigBundle;
}
