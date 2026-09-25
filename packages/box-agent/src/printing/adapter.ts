/**
 * Printer adapters (S2-06): the two things that actually push bytes at a
 * machine.
 *
 * `@oto/print` has already turned a template and its data into a complete,
 * self-contained job — ESC/POS for the receipt family, TSPL2 for the band
 * printers — and its bytes are verified against an independent decoder. Nothing
 * here re-derives them. What an adapter adds is everything the renderer refuses
 * to know about: a socket, a clock, a status query, and what to do when the
 * machine at the other end is out of paper or has been unplugged.
 *
 * **One adapter per family, parameterised per unit.** The Welltech G4 and the
 * three XP-80s speak the same ESC/POS (§9.4: "Status commands, cut, drawer
 * kick, raster and code pages are identical to §9.3 — the same 80XX programmer
 * manual applies"), so they share one implementation and differ by
 * `widthDots`, whether there is a cutter and whether a drawer hangs off the
 * RJ11. Those per-unit facts come from the S2-04 device row and its `settings`
 * document, never from a constant here: the only way to know whether a unit is
 * 576 or 512 dots per line is to read its self-test page (D6), and two printers
 * with the same model string can disagree.
 */

import {
  decodeLabelStatus,
  decodeStatus,
  drawerKick,
  statusQuery,
  TSPL,
  type LabelStatus,
  type PrinterStatus,
} from '@oto/print';
import {
  CHANNEL_TIMEOUTS,
  PrinterError,
  type ChannelFactory,
  type ChannelTarget,
  type PrinterChannel,
} from './channel';

/** What the box knows about a printer right now. Shaped for `DeviceReport`. */
export interface PrinterHealth {
  reachability: 'unknown' | 'reachable' | 'unreachable';
  paperStatus: 'unknown' | 'ok' | 'low' | 'out';
  coverOpen: boolean;
  cutterError: boolean;
  offline: boolean;
  drawerOpen: boolean;
  /**
   * True when the unit accepted bytes but answered no status query.
   *
   * It is NOT the same as `reachability: 'unknown'`: the printer is there and
   * printing, we simply cannot see inside it. §9.3 leaves open whether every
   * firmware in this family answers `DLE EOT` over the LAN board, so this is a
   * state the park can really be in and the header indicator has to be able to
   * say so.
   */
  statusUnknown: boolean;
  /** A short label, never a printed line. */
  lastError: string | null;
  checkedAt: string;
}

export function unknownHealth(now: string): PrinterHealth {
  return {
    reachability: 'unknown',
    paperStatus: 'unknown',
    coverOpen: false,
    cutterError: false,
    offline: false,
    drawerOpen: false,
    statusUnknown: true,
    lastError: null,
    checkedAt: now,
  };
}

/**
 * A printer that took the connection and answered no status query: there,
 * and nothing known about inside it. Not `unknownHealth`, which is a printer
 * nobody has reached.
 */
export function unansweredHealth(now: string, lastError: string | null = null): PrinterHealth {
  return {
    reachability: 'reachable',
    paperStatus: 'unknown',
    coverOpen: false,
    cutterError: false,
    offline: false,
    drawerOpen: false,
    statusUnknown: true,
    lastError,
    checkedAt: now,
  };
}

export interface PrintAttempt {
  /** Bytes as `@oto/print` emitted them, complete and ready for one write. */
  bytes: Uint8Array;
  /**
   * How many times to put this on paper.
   *
   * ESC/POS has no copy count, so the job is written once per copy; TSPL2 has
   * `PRINT n,1` and the renderer has already put the count in the bytes, so a
   * label adapter writes once and this is only checked for consistency.
   */
  copies?: number;
}

export interface PrintResult {
  health: PrinterHealth;
  /** How many whole jobs went down the socket. */
  written: number;
  /** Milliseconds from opening the socket to closing it. */
  elapsedMs: number;
}

export interface PrinterAdapter {
  readonly deviceId: string;
  readonly language: 'escpos' | 'tspl2';
  readonly target: ChannelTarget;
  /** Ask the machine how it is. Never throws: an unreachable printer is news. */
  probe(): Promise<PrinterHealth>;
  /** Put a rendered job on paper. Throws `PrinterError` on anything but success. */
  print(attempt: PrintAttempt): Promise<PrintResult>;
  /**
   * Open the cash drawer, and print NOTHING (S2-10a).
   *
   * Its own call rather than a print with an empty document, and the two
   * reasons are both about the till rather than about tidiness:
   *
   *  - **A pulse is not a job.** `print` renders a page, feeds paper past the
   *    blade and cuts it. The platform does not print a receipt on finalise yet
   *    (S2-13 does), so a drawer that opened by printing would hand every cash
   *    guest a blank slip and put a metre of paper on the floor by closing time.
   *  - **The blockers are the opposite way round.** `print` refuses before it
   *    writes a byte when the roll is out or the cover is open, which is right
   *    for a receipt and wrong for a drawer: the cash is in the drawer whatever
   *    the printer's paper is doing, and a till that cannot open it until
   *    somebody changes the roll is a till with a queue in front of it.
   *
   * Throws `PrinterError` when the machine cannot be reached. `supported` is
   * false on a printer that has no drawer line at all — a band printer — and
   * that is an answer, not a failure.
   */
  pulseDrawer(pulse: DrawerPulse): Promise<DrawerPulseResult>;
}

/** `ESC p m t1 t2`, as the renderer emits it. §9.3: 24 V / 1 A on RJ11. */
export interface DrawerPulse {
  /** 0 for drawer pin 2, 1 for pin 5. */
  pin: 0 | 1;
  onMs: number;
  offMs: number;
}

export interface DrawerPulseResult {
  /** False when this printer has no drawer line to pulse. Nothing was written. */
  supported: boolean;
  /** How the machine looked on the way past. Never defaulted cheerful. */
  health: PrinterHealth;
  elapsedMs: number;
}

/**
 * Whether one printer has answered a status query in this process: what tells
 * a printer that has stopped from a unit that never answers, when either is
 * silent before a job (case 5 in `queue.ts`'s header; SCRUM-431).
 *
 * The queue keeps it for each device, beside its health map, and hands it to
 * every adapter it builds. An answer to a job's read before or after the job,
 * or to the heartbeat's probe, is remembered, and nothing forgets one but a
 * restart. That is accepted: after a restart the unit is one never heard from
 * until it answers again, and a job that meets its silence is printed blind,
 * as case (b) in `readAfterJob` says.
 */
export interface StatusMemory {
  /** True once the unit has answered a status query in this process. */
  answered(): boolean;
  /** The unit has just answered one. */
  heard(): void;
}

export interface AdapterDeps {
  deviceId: string;
  label: string;
  target: ChannelTarget;
  open: ChannelFactory;
  now: () => Date;
  /**
   * What the box remembers of this unit's answers. Absent — an adapter built
   * on its own, as a bench test builds one — is a unit never heard from.
   */
  memory?: StatusMemory;
}

/** A pause that does not hold the process open by itself: the socket does that. */
function sleep(ms: number): Promise<void> {
  return new Promise((ok) => {
    const timer = setTimeout(ok, ms);
    timer.unref?.();
  });
}

/**
 * A printer the box has heard answer status is silent before a job: case 5 in
 * `queue.ts`'s header (SCRUM-431).
 *
 * Thrown before a byte of the job is written, which is what makes it
 * `retryable` and never `partial`: nothing can have reached the paper, so the
 * queue's retry sending the job later cannot put a second slip beside a
 * first.
 */
function silentBeforeJob(label: string): PrinterError {
  return new PrinterError(
    'PRINTER_SILENT_BEFORE_JOB',
    `${label} stopped answering status, so the job was not sent`,
    { retryable: true },
  );
}

// --- ESC/POS ----------------------------------------------------------------

/**
 * Read `DLE EOT 1..4` on an open channel.
 *
 * Returns null when the unit answered nothing at all, which is a different
 * thing from answering "everything is fine": §9.3 records `GS r` as
 * serial-only and ASB over LAN as unconfirmed, and the one command the manual
 * promises is answered "even when the printer is off-line, the receive buffer
 * is full, or there is an error status" is this one. If even this goes
 * unanswered the honest report is "I cannot see inside this printer".
 *
 * What a null before a job means depends on the unit (SCRUM-431). A unit the
 * box has heard answer before, in this process, has stopped — a jam, the roll
 * out, its input buffer full — and the job is not sent into it: it waits,
 * `PRINTER_SILENT_BEFORE_JOB` (case 5 in `queue.ts`'s header). A unit never
 * heard from may be one whose LAN board passes no `DLE EOT` back, and the job
 * is sent anyway (case (b) in `readAfterJob`). What counts as heard is an
 * answer to a job's read or to the heartbeat's probe (`StatusMemory`).
 *
 * **It stops at the first query that goes unanswered** (H1, closing audit
 * 2026-09-25). It used to ask all four whatever happened, waiting a second on
 * each that went unanswered, so a unit whose LAN board passes no `DLE EOT`
 * back cost 4 s before a job and 4 s after it: 8 s a slip, past the booth
 * page's 6 s, and every press read "Booth not ready" while the slip printed.
 * Now a silent unit costs one timeout per read.
 *
 * What stopping gives up is a later answer from a unit that ignored an earlier
 * query, and nothing in §9.3 or §9.4 describes one. A unit that answers only
 * the first few (n = 1–2, say) loses nothing: the read stops at the query it
 * would not have answered anyway. A reply byte that is not a status byte
 * does not stop the read, though it is not counted as an answer (see the
 * `catch` below).
 *
 * `firstReplyMs` is how long the first query waits; `readAfterJob` gives it
 * longer after a job, to a printer that answered before it.
 */
async function readEscposStatus(
  channel: PrinterChannel,
  firstReplyMs: number = CHANNEL_TIMEOUTS.statusMs,
): Promise<PrinterStatus | null> {
  const merged: PrinterStatus = {};
  let answered = 0;
  for (const n of [1, 2, 3, 4] as const) {
    const reply = await channel.query(
      statusQuery(n),
      1,
      n === 1 ? firstReplyMs : CHANNEL_TIMEOUTS.statusMs,
    );
    if (reply.length === 0) break;
    try {
      Object.assign(merged, decodeStatus(n, reply[0] ?? 0));
      answered += 1;
    } catch {
      // A byte that is not a `DLE EOT` reply — the tail of some other answer,
      // or a firmware that echoes. Counted as no answer for this query rather
      // than believed: a misread status bit turns into a printer the header
      // calls red for no reason.
    }
  }
  return answered === 0 ? null : merged;
}

/**
 * How long the read after a job waits for its first reply, from a printer that
 * answered the read before it.
 *
 * Over TCP the printer reads the query only after every byte of the job in
 * front of it on the connection, so its reply comes once the job has gone
 * into its input buffer — on a job bigger than that buffer, only once enough
 * of it has been printed. Four seconds is what the four queries' waits used
 * to add up to, and it is counted from when the first query is sent, because
 * the sending can stall too (see `query` in `tcpChannel`). A printer that did
 * not answer before the job gets the ordinary second: that is the silent
 * case, and the one this read is made shorter for. One that did answer and
 * is silent even so is asked again (`SILENT_AFTER_JOB_ASKS`).
 */
export const AFTER_JOB_FIRST_REPLY_MS = 4 * CHANNEL_TIMEOUTS.statusMs;

/**
 * How many more times the read after a job is made, and how far apart, when
 * the printer answered the read before the job and not the one after it:
 * case (c) in `readAfterJob` (SCRUM-429).
 *
 * Twice, a second apart, each a whole read whose first query is given the
 * ordinary second (`CHANNEL_TIMEOUTS.statusMs`). After the first read's
 * `AFTER_JOB_FIRST_REPLY_MS`, that gives the printer 4 + 2 × (1 + 1) = 8 s from
 * the end of the job to answer (`SILENT_AFTER_JOB_WAIT_MS`). Closing the
 * socket then takes up to one second more, because a printer that is not
 * reading does not take the close either (`close` in `tcpChannel`).
 *
 * **Why not longer.** The printer's lock is held for all of it (`serialise` in
 * `queue.ts`), and the next job and a cash-drawer pulse wait behind it: when
 * this is a till's receipt printer, the drawer of a cash sale there waits out
 * those nine seconds at most. And a printer that stopped mid-job — the roll
 * out, a jam, the cover up — is waiting for a person to walk over, which no
 * wait the lock can bear would see the end of.
 *
 * **Why not shorter.** The booth loses nothing to it: a press answers
 * `queued` once its three seconds are up (`BOOTH_PRINT_WAIT_MS` in
 * `booth.ts`), which the first read alone is past, and the television then
 * shows the code and its QR. The asks are for a printer that is late rather
 * than stopped — one that let a query go by while it cut, say, or reached it
 * only behind the tail of a job that took longer than
 * `AFTER_JOB_FIRST_REPLY_MS` allows. A second apart is so that a busy
 * printer is asked again once it has had a moment to finish, not in the same
 * moment; a reply that comes during the pause is not lost (see
 * `readAfterJob`).
 */
export const SILENT_AFTER_JOB_ASKS = 2;
export const SILENT_AFTER_JOB_PAUSE_MS = CHANNEL_TIMEOUTS.statusMs;
/** From the end of the job to `PRINTER_SILENT_AFTER_JOB`: 8 s. */
export const SILENT_AFTER_JOB_WAIT_MS =
  AFTER_JOB_FIRST_REPLY_MS +
  SILENT_AFTER_JOB_ASKS * (SILENT_AFTER_JOB_PAUSE_MS + CHANNEL_TIMEOUTS.statusMs);

/**
 * The read after a job, and what its silence means (SCRUM-429).
 *
 *  (a) **The printer answers.** The job is printed and the answer is its
 *      health, as it always was: `print` still fails it when the answer is
 *      the roll run out.
 *  (b) **It answered nothing before the job either.** A unit whose LAN board
 *      passes no `DLE EOT` back (case 2 in `queue.ts`'s header). The read is
 *      made once, and silence comes back as null: the job is printed with
 *      its status unknown, because refusing it would mean such a unit never
 *      prints at all. Only a unit the box has never heard answer gets this
 *      far: a silent read before the job, from one it has heard, stops the
 *      job before a byte of it is sent (`PRINTER_SILENT_BEFORE_JOB`, case 5
 *      in `queue.ts`'s header; SCRUM-431). So the next job to a printer
 *      still stopped after (c) waits, rather than being sent blind.
 *  (c) **It answered before the job and says nothing after it.** It stopped
 *      with the job inside it: a jam, or the roll run out, while the kernel's
 *      buffers held the whole slip (see `write` in `tcpChannel`). The query
 *      waits unread behind the slip, or, with the buffers full, cannot even
 *      be handed over. Nothing on the wire can say how much of the slip
 *      reached the paper. It is asked again `SILENT_AFTER_JOB_ASKS` times,
 *      `SILENT_AFTER_JOB_PAUSE_MS` apart, and if it is still silent the job is
 *      `PRINTER_SILENT_AFTER_JOB`: failed rather than printed, and `partial`,
 *      so no timer sends it again. That is case 1 in `queue.ts`'s header, for
 *      its reason: the slip may be on the paper, and a person pressing reprint
 *      is a different act.
 *
 * A reply that comes after its query's time is not lost: the channel keeps it
 * for the next query (`query` in `tcpChannel`), so one that arrives during a
 * pause is read by the next ask at once. `DLE EOT` replies carry no query
 * number, so when more than one is late a query can be handed an earlier
 * one's reply. They share one frame, so the worst of that is a status bit
 * read under the wrong query.
 */
async function readAfterJob(
  channel: PrinterChannel,
  label: string,
  answeredBefore: boolean,
): Promise<PrinterStatus | null> {
  if (!answeredBefore) return readEscposStatus(channel);
  let status = await readEscposStatus(channel, AFTER_JOB_FIRST_REPLY_MS);
  for (let ask = 0; status === null && ask < SILENT_AFTER_JOB_ASKS; ask += 1) {
    await sleep(SILENT_AFTER_JOB_PAUSE_MS);
    status = await readEscposStatus(channel);
  }
  if (status !== null) return status;
  throw new PrinterError(
    'PRINTER_SILENT_AFTER_JOB',
    `${label} took the slip but did not confirm it: no status for ${
      SILENT_AFTER_JOB_WAIT_MS / 1000
    } s after it`,
    { partial: true },
  );
}

function healthFromEscpos(
  status: PrinterStatus | null,
  now: string,
  lastError: string | null = null,
): PrinterHealth {
  if (!status) return unansweredHealth(now, lastError);
  return {
    reachability: 'reachable',
    paperStatus: status.paperEnd ? 'out' : status.paperNearEnd ? 'low' : 'ok',
    coverOpen: status.coverOpen === true,
    cutterError: status.cutterError === true,
    offline: status.offline === true,
    drawerOpen: status.drawerOpen === true,
    statusUnknown: false,
    lastError,
    checkedAt: now,
  };
}

/**
 * The condition that must stop a job BEFORE anything is written.
 *
 * Order matters only in what the person is told; any of them means no bytes
 * go out, so the job stays queued and retries when the machine is fixed —
 * which is the acceptance criterion for paper-out.
 */
function escposBlocker(health: PrinterHealth): PrinterError | null {
  if (health.paperStatus === 'out') {
    return new PrinterError('PRINTER_PAPER_OUT', 'The printer is out of paper', { retryable: true });
  }
  if (health.coverOpen) {
    return new PrinterError('PRINTER_COVER_OPEN', 'The printer cover is open', { retryable: true });
  }
  if (health.offline) {
    return new PrinterError('PRINTER_OFFLINE', 'The printer is off-line', { retryable: true });
  }
  return null;
}

export function escposAdapter(deps: AdapterDeps): PrinterAdapter {
  const { deviceId, label, target, open, now, memory } = deps;

  async function withChannel<T>(fn: (channel: PrinterChannel) => Promise<T>): Promise<T> {
    const channel = await open(target);
    try {
      return await fn(channel);
    } finally {
      await channel.close().catch(() => {
        // The job is already decided by here. A socket that will not close
        // tidily must not turn a printed receipt into a failure.
      });
    }
  }

  return {
    deviceId,
    language: 'escpos',
    target,
    async probe() {
      const at = now().toISOString();
      try {
        return await withChannel(async (channel) => {
          const status = await readEscposStatus(channel);
          // The heartbeat's answer is remembered as a job's is (SCRUM-431).
          if (status !== null) memory?.heard();
          return healthFromEscpos(status, at);
        });
      } catch (err) {
        return {
          ...unknownHealth(at),
          reachability: 'unreachable' as const,
          lastError: err instanceof PrinterError ? err.code : 'PRINTER_UNREACHABLE',
        };
      }
    },
    async print(attempt) {
      const startedAt = Date.now();
      const copies = Math.max(1, attempt.copies ?? 1);
      return withChannel(async (channel) => {
        const beforeStatus = await readEscposStatus(channel);
        if (beforeStatus !== null) {
          memory?.heard();
        } else if (memory?.answered()) {
          /**
           * Silent, from a unit that has answered before: it has stopped, and
           * the slip is not sent into it. It waits, and the queue's retry
           * sends it once the printer answers again (case 5 in `queue.ts`'s
           * header; SCRUM-431). A unit never heard from goes on, and is
           * printed to blind (case (b) in `readAfterJob`).
           */
          throw silentBeforeJob(label);
        }
        const before = healthFromEscpos(beforeStatus, now().toISOString());
        const blocked = escposBlocker(before);
        if (blocked) throw blocked;

        let written = 0;
        for (let i = 0; i < copies; i += 1) {
          try {
            await channel.write(attempt.bytes);
          } catch (err) {
            /**
             * The socket died with part of the job on the paper.
             *
             * Marked partial and NOT retryable. Whether paper came out is
             * genuinely unknown from here — some of the job may still be in
             * the printer's input buffer, and some of it may already be on
             * the floor — and "unknown" is the reason, not "printed": an
             * automatic retry risks handing the guest a second, complete
             * receipt beside a torn-off first one, with nobody able to tell
             * afterwards which is real. A person pressing reprint is a
             * different act and mints its own job.
             */
            if (err instanceof PrinterError) throw err;
            throw new PrinterError('PRINTER_WRITE_FAILED', `${label} closed mid-job`, {
              partial: true,
              cause: err,
            });
          }
          written += 1;
        }

        /**
         * Ask again afterwards. A roll that ran out halfway through is the one
         * failure a status query before the job cannot catch, and it is the
         * common one: a receipt is a metre of paper and nobody changes the
         * roll until it stops. What silence here means is `readAfterJob`'s
         * to say: printed from a unit that never answers, failed from one
         * that answered before the job.
         */
        const afterStatus = await readAfterJob(channel, label, beforeStatus !== null);
        if (afterStatus !== null) memory?.heard();
        const after = healthFromEscpos(afterStatus, now().toISOString());
        if (after.paperStatus === 'out') {
          throw new PrinterError('PRINTER_PAPER_OUT', `${label} ran out of paper during the job`, {
            partial: true,
          });
        }
        /**
         * A cutter error is reported and the job still counts as printed: the
         * paper came out, it simply was not cut, and the person at the till
         * can tear it off. Sending it again would produce a second receipt to
         * solve a problem with a blade.
         */
        return { health: after, written, elapsedMs: Date.now() - startedAt };
      });
    },
    async pulseDrawer(pulse) {
      const startedAt = Date.now();
      return withChannel(async (channel) => {
        /**
         * Written with NO blocker in front of it — see the interface. The
         * status is still read, because a pulse is also the cheapest health
         * probe this printer will ever get and a till taking cash is exactly
         * when somebody wants to know the roll is nearly out; but nothing it
         * says stops the drawer.
         */
        try {
          await channel.write(drawerKick(pulse.pin, pulse.onMs, pulse.offMs));
        } catch (err) {
          if (err instanceof PrinterError) throw err;
          throw new PrinterError('DRAWER_WRITE_FAILED', `${label} closed before the drawer opened`, {
            cause: err,
          });
        }
        const health = healthFromEscpos(await readEscposStatus(channel), now().toISOString());
        return { supported: true, health, elapsedMs: Date.now() - startedAt };
      });
    },
  };
}

// --- TSPL2 ------------------------------------------------------------------

/**
 * How long to wait between two `ESC ! ?` polls while a band is coming out.
 *
 * Without it the loop would query as fast as the socket answers, which on a
 * simulator is a tight loop and on a real printer is a thousand status queries
 * competing with the job they are asking about.
 */
const LABEL_POLL_MS = 100;

/**
 * `ESC ! ?` — one byte, "immediately returned ... even in the event of printer
 * error" (§9.1). `ESC ! S` and `SET RESPONSE` are both unconfirmed on this
 * firmware, so this is the baseline and the only thing polled.
 *
 * A null before a band job means what it means before a slip
 * (`readEscposStatus`): from a unit the box has heard answer, the job is not
 * sent and waits, `PRINTER_SILENT_BEFORE_JOB` (case 5 in `queue.ts`'s header;
 * SCRUM-431); from one never heard, it is sent anyway.
 */
async function readLabelStatus(channel: PrinterChannel): Promise<LabelStatus | null> {
  const reply = await channel.query(TSPL.statusQuery, 1, CHANNEL_TIMEOUTS.statusMs);
  if (reply.length === 0) return null;
  return decodeLabelStatus(reply[0] ?? 0);
}

function healthFromLabel(
  status: LabelStatus | null,
  now: string,
  lastError: string | null = null,
): PrinterHealth {
  if (!status) return unansweredHealth(now, lastError);
  return {
    reachability: 'reachable',
    // A band printer has no near-end sensor in this family's status byte, so
    // there is no `low` state to report — only bands and no bands.
    paperStatus: status.paperOut ? 'out' : 'ok',
    coverOpen: status.headOpen,
    /** No cutter is fitted (§9.1: `cut_kick: none`); a jam is the nearest fault. */
    cutterError: status.paperJam,
    offline: status.paused,
    drawerOpen: false,
    statusUnknown: false,
    lastError,
    checkedAt: now,
  };
}

export function tsplAdapter(deps: AdapterDeps): PrinterAdapter {
  const { deviceId, label, target, open, now, memory } = deps;

  async function withChannel<T>(fn: (channel: PrinterChannel) => Promise<T>): Promise<T> {
    const channel = await open(target);
    try {
      return await fn(channel);
    } finally {
      await channel.close().catch(() => {});
    }
  }

  /** `readLabelStatus`, with an answer remembered (`StatusMemory`; SCRUM-431). */
  async function readStatus(channel: PrinterChannel): Promise<LabelStatus | null> {
    const status = await readLabelStatus(channel);
    if (status !== null) memory?.heard();
    return status;
  }

  return {
    deviceId,
    language: 'tspl2',
    target,
    async probe() {
      const at = now().toISOString();
      try {
        return await withChannel(async (channel) => healthFromLabel(await readStatus(channel), at));
      } catch (err) {
        return {
          ...unknownHealth(at),
          reachability: 'unreachable' as const,
          lastError: err instanceof PrinterError ? err.code : 'PRINTER_UNREACHABLE',
        };
      }
    },
    async print(attempt) {
      const startedAt = Date.now();
      return withChannel(async (channel) => {
        const beforeStatus = await readStatus(channel);
        // Silent, from a unit that has answered before: stopped, so the band
        // is not sent into it, as a slip is not (`escposAdapter`; SCRUM-431).
        if (beforeStatus === null && memory?.answered()) throw silentBeforeJob(label);
        const before = healthFromLabel(beforeStatus, now().toISOString());
        if (before.paperStatus === 'out') {
          throw new PrinterError('PRINTER_PAPER_OUT', `${label} has no bands loaded`, {
            retryable: true,
          });
        }
        if (before.coverOpen) {
          throw new PrinterError('PRINTER_HEAD_OPEN', `${label} has its head open`, {
            retryable: true,
          });
        }
        if (before.cutterError) {
          throw new PrinterError('PRINTER_PAPER_JAM', `${label} is jammed`, { retryable: true });
        }

        try {
          await channel.write(attempt.bytes);
        } catch (err) {
          if (err instanceof PrinterError) throw err;
          throw new PrinterError('PRINTER_WRITE_FAILED', `${label} closed mid-job`, {
            partial: true,
            cause: err,
          });
        }

        /**
         * Poll until the machine stops saying `printing`, or until the job
         * budget runs out.
         *
         * A band is 250 mm of media at 4 ips, so a label takes seconds rather
         * than milliseconds and a job that "succeeded" the moment its bytes
         * were flushed would report success while the band was still coming
         * out — and would miss the media running out mid-label, which is
         * exactly what the next queued band needs to know.
         */
        const deadline = Date.now() + CHANNEL_TIMEOUTS.jobCompleteMs;
        let status = await readStatus(channel);
        while (status?.printing === true && Date.now() < deadline) {
          await sleep(LABEL_POLL_MS);
          status = await readStatus(channel);
        }
        const health = healthFromLabel(status, now().toISOString());
        if (health.paperStatus === 'out') {
          throw new PrinterError('PRINTER_PAPER_OUT', `${label} ran out of bands during the job`, {
            partial: true,
          });
        }
        return { health, written: 1, elapsedMs: Date.now() - startedAt };
      });
    },
    async pulseDrawer() {
      /**
       * A band printer has no drawer line: §9.1 lists `cut_kick: none` for this
       * family, and the renderer's own band template says the same
       * (`templates/band.ts:136`). Answering `supported: false` rather than
       * throwing is what lets the caller say "this station's drawer is on the
       * receipt printer" instead of painting a failure nobody can fix.
       */
      return {
        supported: false,
        health: unknownHealth(now().toISOString()),
        elapsedMs: 0,
      };
    },
  };
}
