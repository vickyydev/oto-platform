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
}

export interface AdapterDeps {
  deviceId: string;
  label: string;
  target: ChannelTarget;
  open: ChannelFactory;
  now: () => Date;
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
 */
async function readEscposStatus(channel: PrinterChannel): Promise<PrinterStatus | null> {
  const merged: PrinterStatus = {};
  let answered = 0;
  for (const n of [1, 2, 3, 4] as const) {
    const reply = await channel.query(statusQuery(n), 1, CHANNEL_TIMEOUTS.statusMs);
    if (reply.length === 0) continue;
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

function healthFromEscpos(
  status: PrinterStatus | null,
  now: string,
  lastError: string | null = null,
): PrinterHealth {
  if (!status) {
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
  const { deviceId, label, target, open, now } = deps;

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
        return await withChannel(async (channel) =>
          healthFromEscpos(await readEscposStatus(channel), at),
        );
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
        const before = healthFromEscpos(await readEscposStatus(channel), now().toISOString());
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
         * roll until it stops.
         */
        const after = healthFromEscpos(await readEscposStatus(channel), now().toISOString());
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

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => {
    const timer = setTimeout(ok, ms);
    timer.unref?.();
  });
}

/**
 * `ESC ! ?` — one byte, "immediately returned ... even in the event of printer
 * error" (§9.1). `ESC ! S` and `SET RESPONSE` are both unconfirmed on this
 * firmware, so this is the baseline and the only thing polled.
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
  if (!status) {
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
  const { deviceId, label, target, open, now } = deps;

  async function withChannel<T>(fn: (channel: PrinterChannel) => Promise<T>): Promise<T> {
    const channel = await open(target);
    try {
      return await fn(channel);
    } finally {
      await channel.close().catch(() => {});
    }
  }

  return {
    deviceId,
    language: 'tspl2',
    target,
    async probe() {
      const at = now().toISOString();
      try {
        return await withChannel(async (channel) => healthFromLabel(await readLabelStatus(channel), at));
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
        const before = healthFromLabel(await readLabelStatus(channel), now().toISOString());
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
        let status = await readLabelStatus(channel);
        while (status?.printing === true && Date.now() < deadline) {
          await sleep(LABEL_POLL_MS);
          status = await readLabelStatus(channel);
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
  };
}
