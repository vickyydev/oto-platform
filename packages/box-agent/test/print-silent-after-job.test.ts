import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { renderJob, type PrintJob } from '@oto/print';
import type { BoxConfigBundle, BoxConfigDevice } from '../src/protocol';
import type { PrintJobRecord } from '../src/store';
import {
  AFTER_JOB_FIRST_REPLY_MS,
  SILENT_AFTER_JOB_ASKS,
  SILENT_AFTER_JOB_PAUSE_MS,
  SILENT_AFTER_JOB_WAIT_MS,
  escposAdapter,
  tsplAdapter,
  type StatusMemory,
} from '../src/printing/adapter';
import {
  CHANNEL_TIMEOUTS,
  PrinterError,
  tcpChannel,
  type ChannelFactory,
} from '../src/printing/channel';
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
 * five to nine seconds each, nearly all of it timers, so they run side by
 * side.
 *
 * Nearly: a test that prints through the queue renders its slip on the box's
 * one thread, and side by side the renders meet. On a slow CI runner
 * (2026-09-25) seven of them held the thread for over two seconds just after
 * the adapter and probe tests had opened their sockets, and those
 * connections, made by the kernel meanwhile, were failed as unreachable. Two
 * things make a held thread harmless here. The channel gives a deadline's
 * verdict only once the sockets have been read (`afterSocketsRead` in
 * `channel.ts`, proved in `print-channel.test.ts`). And the fake printers are
 * served from a thread of their own (`printerThread`), as a printer is a
 * machine of its own, so they read and answer while the box's thread
 * renders. Served from the box's thread, they answered nothing until it was
 * free, and at 1.7 times the runner's slowness that still cost a test its
 * answers.
 */

/** An idle "all clear" reply to any `DLE EOT n`: bits 1 and 4 set (§9.3). */
const ALL_CLEAR = 0x12;

/** The size of the seeded booth slip as rendered at 576 dots (the audit's 43,041 bytes). */
const SLIP_BYTES = 43_041;

const AT = '2026-09-25T03:00:00.000Z';
const DEVICE_ID = '018f1d2c-0000-7000-8000-0000000de0c1';
/** A second printer on the booth station, under a role of its own. */
const OTHER_DEVICE_ID = '018f1d2c-0000-7000-8000-0000000de0c2';
const OTHER_ROLE = 'kitchen';

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
   * so do the queries behind the job. It stays stopped: a session opened
   * after it has stopped acts on nothing it is sent, not even its first
   * query, until `set` clears this.
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
  /**
   * Change how it behaves from here on, as a printer does that goes silent or
   * is cleared. The options are read as each session goes, `stopAfter` as it
   * opens.
   */
  set(next: FakePrinterOptions): void;
  close(): Promise<void>;
}

/**
 * Where a fake printer keeps its state: 32-bit slots of memory that the
 * printers' thread shares with the tests. The tests write the options and the
 * printer reads them as it goes; the printer alone writes the counts and the
 * query logs, each entry before the count that shows it.
 */
const SLOT = {
  // `FakePrinterOptions`, as numbers.
  answersBefore: 0,
  afterJob: 1,
  stopAfter: 2,
  resumeAfterMs: 3,
  // What it has done: `connections`, `taken` and `asked` in `FakePrinter`.
  connections: 4,
  taken: 5,
  beforeCount: 6,
  afterCount: 7,
  /** Each query read, as n × 2, plus 1 when it was answered. */
  beforeLog: 8,
  afterLog: 8 + 64,
  logSize: 64,
} as const;
/** `afterJob` as a number: answer every query, or none. A count is itself. */
const AFTER_JOB_ANSWERS = -1;
const AFTER_JOB_SILENT = -2;
/** `stopAfter` or `resumeAfterMs` not set. */
const UNSET = -1;

/** A band printer's state: whether it answers `ESC ! ?`, and the band bytes it has read. */
const BAND_SLOT = { answering: 0, taken: 1 } as const;

/**
 * The fake printers, as the thread that serves them runs them.
 *
 * Plain JavaScript, as a worker made from a string is, and built when the
 * thread is started, once every constant it names is defined. What each
 * option does is in `FakePrinterOptions`, and the band printer is
 * `fakeBandPrinter`'s.
 */
function printerThreadSource(): string {
  return `
const { parentPort } = require('node:worker_threads');
const net = require('node:net');

const SLOT = ${JSON.stringify(SLOT)};
const BAND_SLOT = ${JSON.stringify(BAND_SLOT)};
const printers = new Map();

// Read the stream as the printer does. A GS v 0 image is stepped over by the
// length its header declares, so the dots of a rendered slip are never taken
// for a DLE EOT (the simulator's countedPayload says why that matters), and a
// command split between two reads is put back together.
function escposReader() {
  let image = 0;
  let carry = Buffer.alloc(0);
  return (data) => {
    const bytes = carry.length > 0 ? Buffer.concat([carry, data]) : data;
    carry = Buffer.alloc(0);
    const queries = [];
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
      // DLE EOT n: three bytes.
      if (b0 === 0x10 && (b1 === undefined || b1 === 0x04)) {
        if (left < 3) {
          carry = Buffer.from(bytes.subarray(i));
          break;
        }
        queries.push(b2);
        i += 3;
        continue;
      }
      // GS v 0 m xL xH yL yH, then (xL + xH * 256) bytes a row for (yL + yH * 256) rows.
      if (b0 === 0x1d && (b1 === undefined || b1 === 0x76) && (b2 === undefined || b2 === 0x30)) {
        if (left < 8) {
          carry = Buffer.from(bytes.subarray(i));
          break;
        }
        image = (bytes[i + 4] | (bytes[i + 5] << 8)) * (bytes[i + 6] | (bytes[i + 7] << 8));
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

function escposPrinter(state) {
  const log = (afterJob, n, answered) => {
    const countSlot = afterJob ? SLOT.afterCount : SLOT.beforeCount;
    const count = Atomics.load(state, countSlot);
    if (count < SLOT.logSize) {
      const logSlot = afterJob ? SLOT.afterLog : SLOT.beforeLog;
      Atomics.store(state, logSlot + count, n * 2 + (answered ? 1 : 0));
    }
    Atomics.store(state, countSlot, count + 1);
  };
  return (socket) => {
    Atomics.add(state, SLOT.connections, 1);
    const read = escposReader();
    let jobSeen = false;
    let dropped = 0;
    let stopAt = Atomics.load(state, SLOT.stopAfter);
    const answer = (n) => {
      let answered;
      if (!jobSeen) {
        answered = Atomics.load(state, SLOT.answersBefore) === 1;
      } else {
        const policy = Atomics.load(state, SLOT.afterJob);
        if (policy === ${AFTER_JOB_ANSWERS}) answered = true;
        else if (policy === ${AFTER_JOB_SILENT}) answered = false;
        else {
          answered = dropped >= policy;
          if (!answered) dropped += 1;
        }
      }
      log(jobSeen, n, answered);
      if (answered) socket.write(Buffer.from([${ALL_CLEAR}]));
    };
    socket.on('data', (data) => {
      const { queries, jobBytes } = read(data);
      // A query can share a read with the end of a job, never with its start:
      // the job is only sent once the read before it is over.
      if (jobBytes > 0) {
        jobSeen = true;
        Atomics.add(state, SLOT.taken, jobBytes);
      }
      if (stopAt !== ${UNSET} && Atomics.load(state, SLOT.taken) >= stopAt) {
        stopAt = ${UNSET};
        socket.pause();
        // Queries that came in with the end of the job are held with it: a
        // printer that has stopped acts on nothing behind the job.
        const resumeAfterMs = Atomics.load(state, SLOT.resumeAfterMs);
        if (resumeAfterMs !== ${UNSET}) {
          setTimeout(() => {
            for (const n of queries) answer(n);
            socket.resume();
          }, resumeAfterMs);
        }
        return;
      }
      for (const n of queries) answer(n);
    });
  };
}

function bandPrinter(state) {
  return (socket) => {
    socket.on('data', (data) => {
      let queries = 0;
      for (let i = 0; i + 2 < data.length; i += 1) {
        if (data[i] === 0x1b && data[i + 1] === 0x21 && data[i + 2] === 0x3f) queries += 1;
      }
      Atomics.add(state, BAND_SLOT.taken, data.length - 3 * queries);
      if (Atomics.load(state, BAND_SLOT.answering) !== 1) return;
      for (let q = 0; q < queries; q += 1) socket.write(Buffer.from([${LABEL_READY}]));
    });
  };
}

parentPort.on('message', (message) => {
  if (message.open) {
    const state = new Int32Array(message.state);
    const serve = message.open === 'band' ? bandPrinter(state) : escposPrinter(state);
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      serve(socket);
    });
    printers.set(message.id, { server, sockets });
    server.listen(0, '127.0.0.1', () => {
      parentPort.postMessage({ id: message.id, port: server.address().port });
    });
    return;
  }
  const printer = printers.get(message.id);
  printers.delete(message.id);
  if (!printer) {
    parentPort.postMessage({ id: message.id, port: 0 });
    return;
  }
  for (const socket of printer.sockets) socket.destroy();
  printer.server.close(() => parentPort.postMessage({ id: message.id, port: 0 }));
});
`;
}

interface PrinterThread {
  worker: Worker;
  /** Serve a printer of this kind with this state. Resolves with its id and port. */
  open(kind: 'escpos' | 'band', state: SharedArrayBuffer): Promise<{ id: number; port: number }>;
  /** Close its sockets and stop listening, as `close` on a server does. */
  close(id: number): Promise<void>;
}

let started: PrinterThread | null = null;

/**
 * The thread every fake printer here is served from, started with the first.
 *
 * A printer is a machine of its own: it reads what it is sent and answers
 * while the box is busy rendering the next slip. Served from the box's
 * thread, the fakes could not, and on a slow runner the slips rendered by
 * the tests beside them kept them silent for a second and more (see the top
 * of the file). Stopped once the file is done. A thread that has stopped
 * fails what is asked of it rather than leaving a test waiting for ever.
 */
function printerThread(): PrinterThread {
  if (started) return started;
  const worker = new Worker(printerThreadSource(), { eval: true, execArgv: [] });
  const waiting = new Map<number, { ok: (port: number) => void; no: (err: unknown) => void }>();
  let stopped: Error | null = null;
  const failAll = (err: unknown): void => {
    for (const wait of waiting.values()) wait.no(err);
    waiting.clear();
  };
  worker.on('message', ({ id, port }: { id: number; port: number }) => {
    waiting.get(id)?.ok(port);
    waiting.delete(id);
  });
  worker.on('error', failAll);
  worker.on('exit', () => {
    stopped = new Error('the printers’ thread stopped');
    failAll(stopped);
  });
  const ask = (message: { id: number; open?: string; state?: SharedArrayBuffer }) =>
    new Promise<number>((ok, no) => {
      if (stopped) {
        no(stopped);
        return;
      }
      waiting.set(message.id, { ok, no });
      worker.postMessage(message);
    });
  let next = 0;
  started = {
    worker,
    open: async (kind, state) => {
      const id = next;
      next += 1;
      return { id, port: await ask({ id, open: kind, state }) };
    },
    close: async (id) => {
      await ask({ id });
    },
  };
  return started;
}

after(async () => {
  await started?.worker.terminate();
});

/** A receipt printer on loopback that reads the stream as a printer does, on its own thread. */
async function fakePrinter(opts: FakePrinterOptions = {}): Promise<FakePrinter> {
  const shared = new SharedArrayBuffer(
    (SLOT.afterLog + SLOT.logSize) * Int32Array.BYTES_PER_ELEMENT,
  );
  const state = new Int32Array(shared);
  const set = (next: FakePrinterOptions): void => {
    if ('answersBefore' in next) {
      Atomics.store(state, SLOT.answersBefore, next.answersBefore === false ? 0 : 1);
    }
    if ('afterJob' in next) {
      const policy = next.afterJob ?? 'answers';
      Atomics.store(
        state,
        SLOT.afterJob,
        policy === 'answers' ? AFTER_JOB_ANSWERS : policy === 'silent' ? AFTER_JOB_SILENT : policy,
      );
    }
    if ('stopAfter' in next) Atomics.store(state, SLOT.stopAfter, next.stopAfter ?? UNSET);
    if ('resumeAfterMs' in next) {
      Atomics.store(state, SLOT.resumeAfterMs, next.resumeAfterMs ?? UNSET);
    }
  };
  set({ answersBefore: true, afterJob: 'answers', stopAfter: undefined, resumeAfterMs: undefined });
  set(opts);
  const { id, port } = await printerThread().open('escpos', shared);
  const logged = (countSlot: number, logSlot: number): Asked[] => {
    const count = Atomics.load(state, countSlot);
    assert.ok(count <= SLOT.logSize, `the fake printer read ${count} queries, more than it keeps`);
    return Array.from({ length: count }, (_, i): Asked => {
      const entry = Atomics.load(state, logSlot + i);
      return [entry >> 1, (entry & 1) === 1];
    });
  };
  return {
    port,
    connections: () => Atomics.load(state, SLOT.connections),
    taken: () => Atomics.load(state, SLOT.taken),
    asked: () => ({
      before: logged(SLOT.beforeCount, SLOT.beforeLog),
      after: logged(SLOT.afterCount, SLOT.afterLog),
    }),
    set,
    close: () => printerThread().close(id),
  };
}

/**
 * `tcpChannel`, counting what the adapter does with it: every session it
 * opens, taken by the printer or refused, every status query it asks,
 * answered or not, including the ones a printer that has stopped reading
 * never sees, and every write.
 */
function countingChannel() {
  const asked: number[] = [];
  let opens = 0;
  let writes = 0;
  let written = 0;
  const open: ChannelFactory = async (target) => {
    opens += 1;
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
  return {
    open,
    opens: () => opens,
    asked: () => [...asked],
    writes: () => writes,
    written: () => written,
  };
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

/**
 * The queue as the box builds it, with its store on the card, printing to
 * `printer`. `maxAttempts` is the queue's own attempt limit, lowered where a
 * test would otherwise wait out a read for every one of its default attempts.
 * `bundle` replaces the booth station's one printer, where a test needs two.
 */
async function rig(
  printer: FakePrinter,
  open: ChannelFactory = tcpChannel,
  { maxAttempts, bundle: given }: { maxAttempts?: number; bundle?: BoxConfigBundle } = {},
): Promise<Rig> {
  const box = openTestStore(AT);
  await box.store.init(BOX_ID);
  let clock = Date.parse(AT);
  const reported: PrintJobOutcome[] = [];
  const logged: Rig['logged'] = [];
  const printing = createPrintSubsystem({
    bundle: () => given ?? bundleFor(printer.port),
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
    maxAttempts,
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

/** The bytes of one seeded booth slip as the queue renders it for this printer. */
function oneSlip(): number {
  return renderJob(VOUCHER, { device: profileFor(deviceRow(0)), templates: [] }).bytes.length;
}

/** The printer's health as far as a person is shown it. */
function shown(printing: PrintSubsystem) {
  const health = printing.health()[DEVICE_ID];
  return (
    health && {
      reachability: health.reachability,
      paperStatus: health.paperStatus,
      statusUnknown: health.statusUnknown,
      lastError: health.lastError,
    }
  );
}

/** "Ready": the idle reply to `ESC ! ?` (§9.1). */
const LABEL_READY = 0x00;

interface FakeBandPrinter {
  port: number;
  /** Band bytes read: everything but the status queries. */
  taken(): number;
  /** Whether it answers `ESC ! ?` from here on. */
  answering(on: boolean): void;
  close(): Promise<void>;
}

/**
 * A band printer on loopback, as far as the read before a band needs one: it
 * answers `ESC ! ?` with "ready" while it is answering, and counts every other
 * byte it reads as the band's. The bands sent to it are filler, with no
 * `ESC ! ?` inside them to find. Served from the printers' thread
 * (`printerThread`), as the receipt printers are.
 */
async function fakeBandPrinter(): Promise<FakeBandPrinter> {
  const shared = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(shared);
  Atomics.store(state, BAND_SLOT.answering, 1);
  const { id, port } = await printerThread().open('band', shared);
  return {
    port,
    taken: () => Atomics.load(state, BAND_SLOT.taken),
    answering: (on) => {
      Atomics.store(state, BAND_SLOT.answering, on ? 1 : 0);
    },
    close: () => printerThread().close(id),
  };
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
      assert.deepEqual(printer.asked().after, [
        ...unanswered(SILENT_AFTER_JOB_ASKS),
        ...ANSWERED_READ,
      ]);
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

  /**
   * The read before the next job (SCRUM-431).
   *
   * A printer that stopped with a slip inside it, case (c), is still stopped
   * when the next job comes, and the read before that job goes unanswered
   * too. Case (b) cannot tell that from a unit that never answers, so the
   * slip was sent blind and recorded printed. The box now remembers, for each
   * printer and in this process, that it has answered a status query — a
   * job's read before or after the job, or the heartbeat's probe — and a job
   * that meets silence from a printer it remembers is not sent: it stays
   * queued with `PRINTER_SILENT_BEFORE_JOB`, and the queue's retry sends it
   * once the printer answers again, until the queue's attempt limit ends it
   * failed. A unit never heard from still prints blind.
   *
   * Inside the suite above so that it runs beside it, being timers too. That
   * a job was not sent is proved by its bytes, counted at the channel and at
   * the printer; for the retries the queue's clock is moved on, as the
   * heartbeat's ticks find it, rather than waited out.
   */
  describe('the read before the next job (SCRUM-431)', { concurrency: true }, () => {
    /** The heartbeat that ticks the queue: a minute, past the retry delay. */
    const HEARTBEAT_MS = 60_000;
    /** A held job costs the one read before it and a close. Only a hang guard. */
    const HELD_WITHIN_MS = 5 * CHANNEL_TIMEOUTS.statusMs;

    test('(1) a printer that has answered, silent before the next job: not sent, queued, printed once it answers again', async () => {
      const printer = await fakePrinter();
      const counted = countingChannel();
      const { printing, reported, box, advance } = await rig(printer, counted.open);
      try {
        assert.equal((await printing.submit(voucher('job-heard'))).status, 'printed');
        const slip = printer.taken();

        // The same printer, answering nothing now, and still reading what it is sent.
        printer.set({ answersBefore: false });
        const { value: held, ms } = await timed(printing.submit(voucher('job-held')));
        assert.equal(held.status, 'queued', 'neither printed nor failed');
        assert.equal(held.errorCode, 'PRINTER_SILENT_BEFORE_JOB');
        assert.equal(counted.writes(), 1, 'nothing of it was written');
        assert.equal(printer.taken(), slip, 'and not a byte of it reached the printer');
        assert.deepEqual(printer.asked().before, [...ANSWERED_READ, ...unanswered(1)]);
        // It waited out the read before the job; the upper bound only guards against a hang.
        assert.ok(ms >= CHANNEL_TIMEOUTS.statusMs - 50, `held after ${ms} ms`);
        assert.ok(ms < HELD_WITHIN_MS, `held after ${ms} ms`);

        assert.deepEqual(shown(printing), {
          reachability: 'reachable',
          paperStatus: 'unknown',
          statusUnknown: true,
          lastError: 'PRINTER_SILENT_BEFORE_JOB',
        });
        assert.deepEqual(printing.pending(), [
          {
            id: 'job-held',
            kind: 'booth_voucher',
            attempts: 1,
            lastError: 'PRINTER_SILENT_BEFORE_JOB',
          },
        ]);
        assert.deepEqual(
          (await box.store.loadPendingPrintJobs(BOX_ID)).map((job) => [
            job.id,
            job.state,
            job.attempts,
            job.lastErrorCode,
          ]),
          [['job-held', 'queued', 1, 'PRINTER_SILENT_BEFORE_JOB']],
          'on the card, as a job waiting on paper is, so a restart does not lose it',
        );
        assert.deepEqual(await printing.tick(), [], 'and it waits for the retry timer');

        printer.set({ answersBefore: true });
        advance(HEARTBEAT_MS);
        assert.deepEqual(
          (await printing.tick()).map((o) => [o.id, o.status, o.attempts]),
          [['job-held', 'printed', 2]],
        );
        assert.equal(counted.writes(), 2);
        assert.equal(printer.taken(), 2 * slip, 'the slip came out, once');
        assert.deepEqual(
          reported.map((o) => [o.id, o.status, o.errorCode]),
          [
            ['job-heard', 'printed', null],
            ['job-held', 'queued', 'PRINTER_SILENT_BEFORE_JOB'],
            ['job-held', 'printed', null],
          ],
        );
        assert.equal(shown(printing)?.lastError, null);
        assert.deepEqual(printing.pending(), []);
        assert.deepEqual(await box.store.loadPendingPrintJobs(BOX_ID), []);
      } finally {
        box.close();
        await printer.close();
      }
    });

    test('(2) a unit never heard to answer still prints blind, job after job: case (b) unchanged', async () => {
      const printer = await fakePrinter({ answersBefore: false, afterJob: 'silent' });
      const { printing, reported, box } = await rig(printer);
      try {
        // Silence to the heartbeat is not an answer, so nothing is remembered.
        assert.equal((await printing.probeAll())[DEVICE_ID]?.statusUnknown, true);
        const first = await printing.submit(voucher('job-blind-1'));
        const second = await printing.submit(voucher('job-blind-2'));
        assert.deepEqual(
          [first.status, second.status],
          ['printed', 'printed'],
          'a unit that answers no status query still prints',
        );
        assert.equal(printer.taken(), 2 * oneSlip(), 'both slips reached it');
        // One unanswered query to the probe and before each job, one after each job.
        assert.deepEqual(printer.asked(), { before: unanswered(3), after: unanswered(2) });
        assert.deepEqual(shown(printing), {
          reachability: 'reachable',
          paperStatus: 'unknown',
          statusUnknown: true,
          lastError: null,
        });
        assert.deepEqual(
          reported.map((o) => [o.id, o.status]),
          [
            ['job-blind-1', 'printed'],
            ['job-blind-2', 'printed'],
          ],
        );
      } finally {
        box.close();
        await printer.close();
      }
    });

    test('(3) after a job fails silent after it, the next job to the still-stopped printer is held, not printed', async () => {
      const slip = oneSlip();
      // It takes the first slip whole, stops reading, and stays stopped.
      const printer = await fakePrinter({ stopAfter: slip });
      const counted = countingChannel();
      const { printing, reported, box, advance } = await rig(printer, counted.open);
      try {
        const stopped = await printing.submit(voucher('job-stopped'));
        assert.equal(stopped.status, 'failed');
        assert.equal(stopped.errorCode, 'PRINTER_SILENT_AFTER_JOB');

        const { value: next, ms } = await timed(printing.submit(voucher('job-next')));
        assert.equal(next.status, 'queued', 'held, and not recorded printed');
        assert.equal(next.errorCode, 'PRINTER_SILENT_BEFORE_JOB');
        assert.equal(counted.writes(), 1, 'the first slip is the only one ever written');
        assert.equal(printer.taken(), slip);
        // Four queries before the first job, then the read after it and its
        // asks, then the one query before the next job: none of those
        // answered by a printer that has stopped reading.
        assert.deepEqual(counted.asked(), [
          1,
          2,
          3,
          4,
          ...Array.from({ length: 1 + SILENT_AFTER_JOB_ASKS }, () => 1),
          1,
        ]);
        assert.ok(ms >= CHANNEL_TIMEOUTS.statusMs - 50, `held after ${ms} ms`);
        assert.ok(ms < HELD_WITHIN_MS, `held after ${ms} ms`);
        assert.deepEqual(shown(printing), {
          reachability: 'reachable',
          paperStatus: 'unknown',
          statusUnknown: true,
          lastError: 'PRINTER_SILENT_BEFORE_JOB',
        });

        // Somebody clears the jam, and the retry prints the slip that waited.
        printer.set({ stopAfter: undefined });
        advance(HEARTBEAT_MS);
        assert.deepEqual(
          (await printing.tick()).map((o) => [o.id, o.status]),
          [['job-next', 'printed']],
        );
        assert.equal(counted.writes(), 2);
        assert.equal(printer.taken(), 2 * slip);
        assert.deepEqual(
          reported.map((o) => [o.id, o.status, o.errorCode]),
          [
            ['job-stopped', 'failed', 'PRINTER_SILENT_AFTER_JOB'],
            ['job-next', 'queued', 'PRINTER_SILENT_BEFORE_JOB'],
            ['job-next', 'printed', null],
          ],
        );
      } finally {
        box.close();
        await printer.close();
      }
    });

    test("(4) an answer to the heartbeat's probe counts: a job silent before it afterwards is held", async () => {
      const printer = await fakePrinter();
      const counted = countingChannel();
      const { printing, reported, box, advance } = await rig(printer, counted.open);
      try {
        // All the box has heard from this printer is its answer to the probe.
        assert.equal((await printing.probeAll())[DEVICE_ID]?.statusUnknown, false);
        assert.deepEqual(printer.asked(), { before: ANSWERED_READ, after: [] });

        printer.set({ answersBefore: false });
        const held = await printing.submit(voucher('job-after-probe'));
        assert.equal(held.status, 'queued');
        assert.equal(held.errorCode, 'PRINTER_SILENT_BEFORE_JOB');
        assert.equal(counted.writes(), 0, 'nothing of it was written');
        assert.equal(printer.taken(), 0);

        printer.set({ answersBefore: true });
        advance(HEARTBEAT_MS);
        assert.deepEqual(
          (await printing.tick()).map((o) => [o.id, o.status]),
          [['job-after-probe', 'printed']],
        );
        assert.equal(counted.writes(), 1);
        assert.equal(printer.taken(), oneSlip());
        assert.deepEqual(
          reported.map((o) => [o.id, o.status]),
          [
            ['job-after-probe', 'queued'],
            ['job-after-probe', 'printed'],
          ],
        );
      } finally {
        box.close();
        await printer.close();
      }
    });

    test('(5) a printer that never answers again: failed at the attempt limit, and no byte of the job ever sent', async () => {
      const limit = 3;
      const printer = await fakePrinter();
      const counted = countingChannel();
      const { printing, reported, box, advance } = await rig(printer, counted.open, {
        maxAttempts: limit,
      });
      try {
        await printing.probeAll();
        printer.set({ answersBefore: false });

        const outcomes = [await printing.submit(voucher('job-never'))];
        // A retry each heartbeat until the queue gives up. The bound on the
        // loop only guards against one that never ends.
        while (outcomes.at(-1)?.status === 'queued' && outcomes.length <= limit) {
          advance(HEARTBEAT_MS);
          outcomes.push(...(await printing.tick()));
        }
        assert.deepEqual(
          outcomes.map((o) => [o.status, o.attempts, o.errorCode]),
          Array.from({ length: limit }, (_, i) => [
            i + 1 < limit ? 'queued' : 'failed',
            i + 1,
            'PRINTER_SILENT_BEFORE_JOB',
          ]),
          'waiting at every attempt before the last, and failed at the last',
        );
        assert.equal(counted.writes(), 0, 'no byte of the job was ever written');
        assert.equal(printer.taken(), 0);
        assert.equal(printer.connections(), 1 + limit, 'the probe, and one session an attempt');
        assert.deepEqual(
          reported.map((o) => [o.id, o.status, o.errorCode]),
          [
            ['job-never', 'queued', 'PRINTER_SILENT_BEFORE_JOB'],
            ['job-never', 'failed', 'PRINTER_SILENT_BEFORE_JOB'],
          ],
          'the wait reported once, then the failure',
        );
        assert.deepEqual(printing.pending(), []);
        assert.deepEqual(await box.store.loadPendingPrintJobs(BOX_ID), []);
        assert.deepEqual(await box.store.loadInterruptedPrintJobs(BOX_ID), []);

        advance(10 * 60_000);
        assert.deepEqual(await printing.tick(), [], 'and nothing sends it again');
        assert.equal(printer.connections(), 1 + limit);
      } finally {
        box.close();
        await printer.close();
      }
    });

    test('(6) the band printers keep the same rule', async () => {
      const printer = await fakeBandPrinter();
      const bandBytes = 2_000;
      let heard = false;
      const remembered: StatusMemory = {
        answered: () => heard,
        heard: () => {
          heard = true;
        },
      };
      const band = (memory: StatusMemory) =>
        tsplAdapter({
          deviceId: DEVICE_ID,
          label: 'Band printer',
          target: { host: '127.0.0.1', port: printer.port },
          open: tcpChannel,
          now: () => new Date(),
          memory,
        });
      try {
        assert.equal((await band(remembered).probe()).statusUnknown, false);
        assert.equal(heard, true, 'its answer to the probe is remembered');

        printer.answering(false);
        const { error, ms } = await timedFailure(
          band(remembered).print({ bytes: filler(bandBytes) }),
        );
        assert.ok(error instanceof PrinterError, `the band ended ${String(error)}`);
        assert.equal(error.code, 'PRINTER_SILENT_BEFORE_JOB');
        assert.equal(error.retryable, true, 'nothing was sent, so the queue may send it later');
        assert.equal(error.partial, false);
        assert.equal(printer.taken(), 0, 'not a byte of the band was sent');
        assert.ok(ms < HELD_WITHIN_MS, `held after ${ms} ms`);

        // A band printer never heard from is printed to blind, as before.
        const blind = await band({ answered: () => false, heard: () => {} }).print({
          bytes: filler(bandBytes),
        });
        assert.equal(blind.written, 1);
        assert.equal(blind.health.statusUnknown, true);
        assert.equal(printer.taken(), bandBytes);
      } finally {
        await printer.close();
      }
    });

    test('(7) an answer to the read after a job counts: a unit silent only before it is held at the next job', async () => {
      // Silent to every read before a job, and answering the read after one.
      // The first slip goes blind, as case (b) says, and its read after the
      // job is what the box remembers.
      const printer = await fakePrinter({ answersBefore: false });
      const counted = countingChannel();
      const { printing, box } = await rig(printer, counted.open);
      try {
        const first = await printing.submit(voucher('job-blind'));
        assert.equal(first.status, 'printed', 'never heard from before it, so sent blind');
        assert.deepEqual(printer.asked(), { before: unanswered(1), after: ANSWERED_READ });

        const next = await printing.submit(voucher('job-after-answer'));
        assert.equal(next.status, 'queued');
        assert.equal(next.errorCode, 'PRINTER_SILENT_BEFORE_JOB');
        assert.equal(counted.writes(), 1, 'nothing of it was written');
        assert.equal(printer.taken(), oneSlip(), 'and not a byte of it reached the printer');
      } finally {
        box.close();
        await printer.close();
      }
    });

    test('(8) the memory is kept per printer: one never heard from prints blind beside one that is remembered', async () => {
      const remembered = await fakePrinter();
      const never = await fakePrinter({ answersBefore: false, afterJob: 'silent' });
      const { printing, box } = await rig(remembered, tcpChannel, {
        bundle: twoPrintersBundle(remembered.port, never.port),
      });
      try {
        // The heartbeat's probe hears the one and not the other.
        const probed = await printing.probeAll();
        assert.equal(probed[DEVICE_ID]?.statusUnknown, false);
        assert.equal(probed[OTHER_DEVICE_ID]?.statusUnknown, true);

        const blind = await printing.submit({ ...voucher('job-never-heard'), role: OTHER_ROLE });
        assert.equal(blind.deviceId, OTHER_DEVICE_ID);
        assert.equal(
          blind.status,
          'printed',
          'another printer answering is not this one answering',
        );
        assert.equal(never.taken(), oneSlip());

        remembered.set({ answersBefore: false });
        const held = await printing.submit(voucher('job-remembered'));
        assert.equal(held.deviceId, DEVICE_ID);
        assert.equal(held.status, 'queued');
        assert.equal(held.errorCode, 'PRINTER_SILENT_BEFORE_JOB');
        assert.equal(remembered.taken(), 0, 'not a byte of it reached the printer');
      } finally {
        box.close();
        await remembered.close();
        await never.close();
      }
    });

    /**
     * Several jobs held on one printer that does not answer (SCRUM-440).
     *
     * A held attempt waits out the read before the job, a second, and the
     * tick used to make one for every job it held: five vouchers waiting on
     * a stopped booth printer put five seconds on every heartbeat, which
     * awaits the tick before it is sent, and at about ninety the Console
     * called the box offline. Now a tick makes one attempt on a printer that
     * does not answer — silent before the job, or unreachable — and leaves
     * its other due jobs, untouched, for the next tick. A printer that
     * answers is tried for every job due on it, in the same tick as the
     * stopped one. And once the stopped one answers again, everything held on
     * it comes out in that one tick, rather than one voucher a heartbeat, a
     * minute apart: a job on a printer that answers costs what its slip
     * takes, not a timeout, and the guests whose slips waited are the ones
     * standing at the booth.
     *
     * Here beside the tests above, being the same timers: each held press
     * waits out one read, so five held vouchers are five seconds to stage.
     * Which jobs a tick attempted is proved by the counts — sessions opened,
     * bytes taken, attempts on each job — and a tick's wall time is bounded
     * only from below by the read it waited out and from above as a hang
     * guard, never as a tight number.
     */
    describe('one attempt a tick on a printer that does not answer (SCRUM-440)', { concurrency: true }, () => {
      /** A press while the printer is silent: answered `queued`, and nothing of it sent. */
      async function pressHeld(printing: PrintSubsystem, request: PrintRequest): Promise<void> {
        const outcome = await printing.submit(request);
        assert.equal(outcome.status, 'queued', `${request.id} was ${outcome.status}`);
        assert.equal(outcome.errorCode, 'PRINTER_SILENT_BEFORE_JOB');
      }

      const FIVE = ['job-held-1', 'job-held-2', 'job-held-3', 'job-held-4', 'job-held-5'];

      test('(1) five held on a stopped printer and one due on a printer that answers: one attempt on the first, the second’s printed, four left as they were', async () => {
        const printer = await fakePrinter();
        const other = await fakePrinter();
        const counted = countingChannel();
        const { printing, reported, box, advance } = await rig(printer, counted.open, {
          bundle: twoPrintersBundle(printer.port, other.port),
        });
        try {
          // Both heard by the heartbeat's probe, and then both silent: five
          // presses for the one, a press for the other, all held.
          const probed = await printing.probeAll();
          assert.equal(probed[DEVICE_ID]?.statusUnknown, false);
          assert.equal(probed[OTHER_DEVICE_ID]?.statusUnknown, false);
          printer.set({ answersBefore: false });
          other.set({ answersBefore: false });
          for (const id of FIVE) await pressHeld(printing, voucher(id));
          await pressHeld(printing, { ...voucher('job-other'), role: OTHER_ROLE });
          assert.equal(counted.writes(), 0, 'nothing of any of them was written');
          // The other printer answers again; the first stays stopped.
          other.set({ answersBefore: true });
          const sessions = printer.connections();
          const staged = await box.store.loadPendingPrintJobs(BOX_ID);
          assert.equal(staged.length, 6, 'six on the card');
          const row = (rows: PrintJobRecord[], id: string) => rows.find((r) => r.id === id);

          advance(HEARTBEAT_MS);
          const { value: outcomes, ms } = await timed(printing.tick());
          assert.deepEqual(
            outcomes.map((o) => [o.id, o.status, o.attempts, o.errorCode]),
            [
              ['job-held-1', 'queued', 2, 'PRINTER_SILENT_BEFORE_JOB'],
              ['job-other', 'printed', 2, null],
            ],
            'one attempt on the stopped printer, and the other printer’s job printed',
          );
          assert.equal(printer.connections(), sessions + 1, 'one session to the stopped printer');
          assert.deepEqual(printer.asked().before.slice(-1), unanswered(1), 'one read, unanswered');
          assert.equal(printer.taken(), 0, 'not a byte reached it');
          assert.equal(other.taken(), oneSlip(), 'the other printer’s slip came out');
          assert.equal(counted.writes(), 1);
          // The tick waited out the one read before a job; the upper bound is
          // the one-attempt hang guard, under which five attempts do not fit.
          assert.ok(ms >= CHANNEL_TIMEOUTS.statusMs - 50, `the tick took ${ms} ms`);
          assert.ok(ms < HELD_WITHIN_MS, `the tick took ${ms} ms`);

          assert.deepEqual(
            printing.pending().map((p) => [p.id, p.attempts, p.lastError]),
            FIVE.map((id, i) => [id, i === 0 ? 2 : 1, 'PRINTER_SILENT_BEFORE_JOB']),
            'the four left were not attempted',
          );
          // Untouched: on the card as the presses left them, retry time and all.
          const after = await box.store.loadPendingPrintJobs(BOX_ID);
          for (const id of FIVE.slice(1)) {
            assert.deepEqual(row(after, id), row(staged, id), `${id} is as it was`);
          }
          assert.notDeepEqual(row(after, 'job-held-1'), row(staged, 'job-held-1'), 'the attempted one moved on');
          assert.equal(row(after, 'job-other'), undefined, 'printed, so off the card');

          // And still due: the next tick, on the same clock, is the second job's turn.
          const { value: next, ms: nextMs } = await timed(printing.tick());
          assert.deepEqual(
            next.map((o) => [o.id, o.status, o.attempts, o.errorCode]),
            [['job-held-2', 'queued', 2, 'PRINTER_SILENT_BEFORE_JOB']],
          );
          assert.equal(printer.connections(), sessions + 2);
          assert.ok(nextMs < HELD_WITHIN_MS, `the tick took ${nextMs} ms`);
          assert.deepEqual(
            printing.pending().map((p) => [p.id, p.attempts]),
            FIVE.map((id, i) => [id, i < 2 ? 2 : 1]),
          );
          assert.deepEqual(
            reported.map((o) => [o.id, o.status]),
            [...FIVE.map((id) => [id, 'queued']), ['job-other', 'queued'], ['job-other', 'printed']],
            'a held job’s wait is reported once, and a job left for the next tick reports nothing',
          );
        } finally {
          box.close();
          await printer.close();
          await other.close();
        }
      });

      test('(2) once the stopped printer answers again, the one tick prints everything held on it', async () => {
        const printer = await fakePrinter();
        const counted = countingChannel();
        const { printing, reported, box, advance } = await rig(printer, counted.open);
        try {
          assert.equal((await printing.submit(voucher('job-heard'))).status, 'printed');
          printer.set({ answersBefore: false });
          for (const id of FIVE) await pressHeld(printing, voucher(id));
          assert.equal(printer.taken(), oneSlip(), 'only the first slip has reached it');
          assert.equal(printing.pending().length, 5);

          // Somebody clears it, and it answers again: all five, oldest first,
          // in the tick that finds it answering — not one a heartbeat.
          printer.set({ answersBefore: true });
          advance(HEARTBEAT_MS);
          const outcomes = await printing.tick();
          assert.deepEqual(
            outcomes.map((o) => [o.id, o.status, o.attempts]),
            FIVE.map((id) => [id, 'printed', 2]),
            'all five, in the order they were pressed, in the one tick',
          );
          assert.equal(counted.writes(), 6);
          assert.equal(printer.taken(), 6 * oneSlip(), 'each slip came out, once');
          assert.deepEqual(printing.pending(), []);
          assert.deepEqual(await box.store.loadPendingPrintJobs(BOX_ID), [], 'and the card is clear');
          assert.deepEqual(
            reported.map((o) => [o.id, o.status]),
            [
              ['job-heard', 'printed'],
              ...FIVE.map((id) => [id, 'queued']),
              ...FIVE.map((id) => [id, 'printed']),
            ],
          );
          assert.deepEqual(await printing.tick(), [], 'nothing left for the next');
        } finally {
          box.close();
          await printer.close();
        }
      });

      test('(3) the same for a printer that cannot be reached: one connect a tick, the rest left', async () => {
        // A port nobody listens on: every session to it is refused.
        const dead = await fakePrinter();
        await dead.close();
        const counted = countingChannel();
        const { printing, box, advance } = await rig(dead, counted.open);
        try {
          const ids = ['job-dead-1', 'job-dead-2', 'job-dead-3', 'job-dead-4', 'job-dead-5'];
          for (const id of ids) {
            const outcome = await printing.submit(voucher(id));
            assert.equal(outcome.status, 'queued', `${id} was ${outcome.status}`);
            assert.equal(outcome.errorCode, 'PRINTER_UNREACHABLE');
          }
          const connects = counted.opens();
          assert.equal(connects, 5, 'a press is one connect');

          advance(HEARTBEAT_MS);
          const outcomes = await printing.tick();
          assert.deepEqual(
            outcomes.map((o) => [o.id, o.status, o.attempts, o.errorCode]),
            [['job-dead-1', 'queued', 2, 'PRINTER_UNREACHABLE']],
          );
          assert.equal(counted.opens(), connects + 1, 'one connect for the five');
          assert.deepEqual(
            printing.pending().map((p) => [p.id, p.attempts, p.lastError]),
            ids.map((id, i) => [id, i === 0 ? 2 : 1, 'PRINTER_UNREACHABLE']),
          );
          assert.equal(shown(printing)?.reachability, 'unreachable');
        } finally {
          box.close();
        }
      });
    });
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

/** The booth station with a second printer beside the first, under a role of its own. */
function twoPrintersBundle(port: number, otherPort: number): BoxConfigBundle {
  return {
    stations: [
      {
        id: STATION_ID,
        name: 'Booth 1',
        kind: 'booth',
        codePrefix: 'B1',
        devices: [
          deviceRow(port),
          { ...deviceRow(otherPort), id: OTHER_DEVICE_ID, role: OTHER_ROLE },
        ],
      },
    ],
  } as unknown as BoxConfigBundle;
}
