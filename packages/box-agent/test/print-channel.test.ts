import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { describe, test } from 'node:test';

import type { PrintJob } from '@oto/print';
import type { BoxConfigBundle } from '../src/protocol';
import { escposAdapter } from '../src/printing/adapter';
import { CHANNEL_TIMEOUTS, PrinterError, tcpChannel } from '../src/printing/channel';
import { createPrintSubsystem, type PrintJobOutcome } from '../src/printing/queue';

/**
 * The printer's wire with its real timings (H1 and M15, closing audit
 * 2026-09-25).
 *
 * Every test here goes through `tcpChannel` — a real socket, the real
 * one-second status timeout and the real write deadline — to a fake printer
 * listening on loopback. The adapter's older tests hand it a channel that
 * answers and takes bytes at once, which is why neither defect showed: a
 * printer whose LAN board passes no `DLE EOT` back cost 8 s a slip, and one
 * that kept the connection but stopped reading held its lock, and the
 * heartbeat, for as long as it stayed stopped.
 *
 * **Loopback buffers far more than a printer's network does.** The audit
 * measured 80–110 KB absorbed on Linux over a 1500-byte-MTU link before a
 * write stalls. In these tests loopback took in 0.3–0.5 MB on Windows before
 * a piece had to wait, and 2.5–9.5 MB on Linux (Node 22; Linux 6.6, whose
 * default limits of 4 MB to send and 6 MB to receive cap it at about 10 MB).
 * A job smaller than that is taken whole and never waits, so a job that has
 * to stall here is 32 MB of filler, or 1000 copies of a slip (about 40 MB):
 * more than three times the most seen.
 *
 * The tests run side by side: each waits on timers, not on the processor, and
 * one after another they would add about 25 s to the package's run.
 */

const { statusMs, writeMs } = CHANNEL_TIMEOUTS;

/** An idle "all clear" reply to any `DLE EOT n`: bits 1 and 4 set (§9.3). */
const ALL_CLEAR = 0x12;

interface FakePrinterOptions {
  /** Which `DLE EOT n` get a reply. Default: all four. An empty set is a silent LAN board. */
  answers?: ReadonlySet<number>;
  /** The reply to `DLE EOT n` once job bytes have arrived. Default: all clear. */
  afterJob?: Partial<Record<1 | 2 | 3 | 4, number>>;
  /**
   * Answer nothing until this long after the job's last bytes arrived, as a
   * printer does that reads a query only once the job in front of it has gone
   * through its input buffer. Queries that arrive meanwhile are answered then,
   * in order.
   */
  drainMs?: number;
  /** Stop reading for good after taking this many job bytes, as a stopped mechanism does. */
  stopAfter?: number;
  /** Stop reading for `ms` after every `every` job bytes, `times` times, then read on. */
  pauses?: { every: number; ms: number; times: number };
}

interface FakePrinter {
  port: number;
  /** Job bytes read so far: anything but a three-byte status query. */
  taken(): number;
  /** Status queries seen, in order. */
  queries(): number[];
  /** Resolves once the printer has stopped reading for good. */
  stopped: Promise<void>;
  close(): Promise<void>;
}

async function fakePrinter(opts: FakePrinterOptions = {}): Promise<FakePrinter> {
  const answers = opts.answers ?? new Set([1, 2, 3, 4]);
  const sockets = new Set<Socket>();
  const seen: number[] = [];
  let taken = 0;
  let markStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (markStopped = resolve));

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let jobSeen = false;
    let drainedAt = 0;
    let pausesLeft = opts.pauses?.times ?? 0;
    let sincePause = 0;
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data: Buffer) => {
      // A query can arrive in the same chunk as the end of a job, so the
      // queries are found first and the rest of the chunk is the job's.
      const queries: number[] = [];
      for (let i = 0; i + 2 < data.length; i += 1) {
        if (data[i] === 0x10 && data[i + 1] === 0x04) queries.push(data[i + 2] ?? 0);
      }
      const jobBytes = data.length - 3 * queries.length;
      if (jobBytes > 0) {
        jobSeen = true;
        taken += jobBytes;
        sincePause += jobBytes;
        drainedAt = Date.now() + (opts.drainMs ?? 0);
      }
      for (const query of queries) {
        const n = query as 1 | 2 | 3 | 4;
        seen.push(n);
        if (!answers.has(n)) continue;
        const reply = Buffer.from([jobSeen ? (opts.afterJob?.[n] ?? ALL_CLEAR) : ALL_CLEAR]);
        const wait = drainedAt - Date.now();
        if (wait > 0) setTimeout(() => socket.write(reply), wait);
        else socket.write(reply);
      }
      if (opts.stopAfter !== undefined && taken >= opts.stopAfter) {
        socket.pause();
        markStopped();
        return;
      }
      if (opts.pauses && pausesLeft > 0 && sincePause >= opts.pauses.every) {
        pausesLeft -= 1;
        sincePause = 0;
        socket.pause();
        setTimeout(() => socket.resume(), opts.pauses.ms);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    taken: () => taken,
    queries: () => [...seen],
    stopped,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function adapterFor(printer: FakePrinter) {
  return escposAdapter({
    deviceId: 'dev-booth',
    label: 'Booth printer',
    target: { host: '127.0.0.1', port: printer.port },
    open: tcpChannel,
    now: () => new Date(),
  });
}

/** A job of `size` bytes of filler: no `DLE EOT` inside it for the fake to answer. */
function filler(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x20);
}

/** The size of the seeded booth slip as rendered at 576 dots (the audit's 43,041 bytes). */
const SLIP_BYTES = 43_041;

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

describe('the printer on a real socket', { concurrency: true }, () => {
  test('a printer that answers status prints a slip in well under a second', async () => {
    const printer = await fakePrinter();
    try {
      const { value, ms } = await timed(adapterFor(printer).print({ bytes: filler(SLIP_BYTES) }));
      assert.equal(value.written, 1);
      assert.equal(value.health.statusUnknown, false);
      assert.equal(value.health.paperStatus, 'ok');
      assert.ok(ms < statusMs, `took ${ms} ms`);
      assert.deepEqual(
        printer.queries(),
        [1, 2, 3, 4, 1, 2, 3, 4],
        'four queries before, four after',
      );
    } finally {
      await printer.close();
    }
  });

  test('a status-silent printer prints a slip in about two seconds, not eight', async () => {
    const printer = await fakePrinter({ answers: new Set() });
    try {
      const { value, ms } = await timed(adapterFor(printer).print({ bytes: filler(SLIP_BYTES) }));
      // One unanswered query before the job and one after it — it used to be
      // four each, and the booth page gives up at 6 s.
      assert.ok(ms >= 2 * statusMs - 50, `took ${ms} ms`);
      assert.ok(ms < 3.5 * statusMs, `took ${ms} ms`);
      assert.equal(value.written, 1, 'the slip is still printed');
      assert.equal(printer.taken(), SLIP_BYTES, 'all of it reached the printer');
      assert.equal(value.health.statusUnknown, true);
      assert.equal(value.health.paperStatus, 'unknown');
      assert.deepEqual(printer.queries(), [1, 1], 'asked once before and once after');

      const probe = await timed(adapterFor(printer).probe());
      assert.ok(
        probe.ms >= statusMs - 50 && probe.ms < 2 * statusMs,
        `the probe took ${probe.ms} ms`,
      );
      assert.equal(probe.value.reachability, 'reachable');
      assert.equal(probe.value.statusUnknown, true);
    } finally {
      await printer.close();
    }
  });

  test('a printer that answers only the first two queries costs one timeout a read and loses nothing', async () => {
    const printer = await fakePrinter({ answers: new Set([1, 2]) });
    try {
      const { value, ms } = await timed(adapterFor(printer).print({ bytes: filler(SLIP_BYTES) }));
      assert.ok(ms >= 2 * statusMs - 50 && ms < 3.5 * statusMs, `took ${ms} ms`);
      assert.deepEqual(printer.queries(), [1, 2, 3, 1, 2, 3], 'the fourth query is never asked');
      assert.equal(value.health.statusUnknown, false, 'what it did answer is kept');
      assert.equal(value.health.paperStatus, 'ok');
    } finally {
      await printer.close();
    }
  });

  test('a printer that answered before the job is given longer for its first reply after it', async () => {
    // The printer reads nothing more for 1.5 s after the job, as one does that
    // reads a query only once a big job has gone through its input buffer, and
    // then says the roll ran out during the job. Stopping at a first query
    // given the ordinary second would have called that slip printed.
    const printer = await fakePrinter({
      drainMs: 1.5 * statusMs,
      afterJob: { 2: ALL_CLEAR | 0x20 | 0x40, 4: ALL_CLEAR | 0x60 },
    });
    try {
      const { error, ms } = await timedFailure(
        adapterFor(printer).print({ bytes: filler(SLIP_BYTES) }),
      );
      assert.ok(error instanceof PrinterError);
      assert.equal(error.code, 'PRINTER_PAPER_OUT');
      assert.equal(error.partial, true, 'paper ran out mid-job: never sent again by a timer');
      assert.ok(ms >= 1.5 * statusMs - 50 && ms < 3 * statusMs, `took ${ms} ms`);
    } finally {
      await printer.close();
    }
  });

  test('a printer that stops taking the job fails it as partial within the write deadline', async () => {
    const printer = await fakePrinter({ stopAfter: 64 * 1024 });
    // Far more than loopback takes in (see the top of the file): a job that
    // fitted would be taken whole and never meet the deadline.
    const size = 32 * 1024 * 1024;
    try {
      const { error, ms } = await timedFailure(adapterFor(printer).print({ bytes: filler(size) }));
      assert.ok(error instanceof PrinterError);
      assert.equal(error.code, 'PRINTER_WRITE_FAILED');
      assert.equal(error.partial, true, 'some of it may be on paper');
      assert.equal(error.retryable, false, 'so nothing sends it again by itself');
      // Stopped almost at once, so the job fails one write deadline in.
      assert.ok(ms >= writeMs - 50, `failed after ${ms} ms`);
      assert.ok(ms < writeMs + 2 * statusMs, `failed after ${ms} ms`);
      assert.ok(printer.taken() >= 64 * 1024 && printer.taken() < size);
    } finally {
      await printer.close();
    }
  });

  test('a printer that pauses but keeps taking the job is not cut off, however long it takes', async () => {
    // Two pauses of 3 s each, each shorter than the write deadline, 8 MB apart
    // in a 32 MB job. At each pause more of the job is left than loopback
    // takes in (see the top of the file), so the writer waits on the printer
    // through both, and the whole job takes longer than `writeMs`. It still
    // prints: the deadline is on the socket taking each piece, not on the job.
    //
    // The 8 MB the printer reads between the pauses is far more than Linux
    // wants read before it takes the next piece, so there too the writer goes
    // on as soon as a pause ends. With 256 KB read between the pauses the job
    // was cut off there at 5 s, although the printer never stopped for that
    // long (see `write` in `tcpChannel`).
    const printer = await fakePrinter({
      pauses: { every: 8 * 1024 * 1024, ms: 3 * statusMs, times: 2 },
    });
    const size = 32 * 1024 * 1024;
    try {
      const { value, ms } = await timed(adapterFor(printer).print({ bytes: filler(size) }));
      assert.equal(value.written, 1);
      assert.ok(ms > writeMs, `took ${ms} ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(printer.taken(), size, 'every byte of it reached the printer');
    } finally {
      await printer.close();
    }
  });

  test('a status query that cannot even be sent counts as unanswered at its timeout', async () => {
    const printer = await fakePrinter({ stopAfter: 0 });
    const channel = await tcpChannel({ host: '127.0.0.1', port: printer.port });
    try {
      // A write the printer is not taking, still going out when the query is made:
      // the query's three bytes queue behind it and are never handed over. It
      // is still going out because it is far more than loopback takes in (see
      // the top of the file).
      const writing = channel.write(filler(32 * 1024 * 1024)).then(
        () => 'written',
        (err: unknown) => err,
      );
      await printer.stopped;
      const { value, ms } = await timed(
        channel.query(Uint8Array.from([0x10, 0x04, 1]), 1, statusMs),
      );
      assert.equal(value.length, 0);
      assert.ok(ms >= statusMs - 50 && ms < 2 * statusMs, `took ${ms} ms`);

      // Closing gives up on the socket after a second, and the write still
      // going out ends as partial instead of waiting for ever.
      await channel.close();
      const outcome = await writing;
      assert.ok(outcome instanceof PrinterError, `the write ended ${String(outcome)}`);
      assert.equal(outcome.code, 'PRINTER_WRITE_FAILED');
      assert.equal(outcome.partial, true);
    } finally {
      await channel.close();
      await printer.close();
    }
  });

  test('the heartbeat printer check returns while a job is stuck, and keeps what the printer last said', async () => {
    const printer = await fakePrinter({ stopAfter: 64 * 1024 });
    let clock = Date.parse('2026-09-25T03:00:00.000Z');
    const reported: PrintJobOutcome[] = [];
    const printing = createPrintSubsystem({
      bundle: () => bundleFor(printer.port),
      templates: () => [],
      now: () => new Date(clock),
      report: (outcome) => {
        reported.push(outcome);
      },
    });
    try {
      const before = (await printing.probeAll())[DEVICE_ID];
      assert.equal(before?.paperStatus, 'ok');

      // 1000 copies of the slip, about 40 MB: far more than loopback takes in
      // (see the top of the file), so it stalls here as a job bigger than
      // 80–110 KB stalls on a printer's network.
      const job = printing.submit({
        id: 'job-stuck',
        kind: 'booth_voucher',
        job: VOUCHER,
        stationId: STATION_ID,
        copies: 1000,
      });
      await printer.stopped;
      const stoppedAt = Date.now();
      clock += 60_000;

      const probe = await timed(printing.probeAll());
      assert.ok(probe.ms < 200, `probeAll took ${probe.ms} ms`);
      assert.deepEqual(probe.value[DEVICE_ID], before, 'the busy printer keeps what it last said');

      const outcome = await job;
      const ms = Date.now() - stoppedAt;
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.errorCode, 'PRINTER_WRITE_FAILED');
      assert.ok(
        ms >= writeMs - 50 && ms < writeMs + 2 * statusMs,
        `ended ${ms} ms after the printer stopped`,
      );
      assert.deepEqual(printing.pending(), [], 'a partial job is not kept for a retry');
      assert.deepEqual(await printing.tick(), [], 'and no tick prints it again');
      assert.deepEqual(
        reported.map((o) => [o.id, o.status]),
        [['job-stuck', 'failed']],
      );
      assert.equal(printing.health()[DEVICE_ID]?.lastError, 'PRINTER_WRITE_FAILED');
    } finally {
      await printer.close();
    }
  });
});

const STATION_ID = '018f1d2c-0000-7000-8000-0000000057d1';
const DEVICE_ID = '018f1d2c-0000-7000-8000-0000000de0d1';

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

/** One booth station and its printer on loopback. The queue reads only `stations`. */
function bundleFor(port: number): BoxConfigBundle {
  return {
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
            address: `127.0.0.1:${port}`,
            model: 'Xprinter XP-80',
            protocol: 'escpos',
            settings: {},
          },
        ],
      },
    ],
  } as unknown as BoxConfigBundle;
}
