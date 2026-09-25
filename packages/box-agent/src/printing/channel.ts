/**
 * The wire to a printer (S2-06).
 *
 * Both families in the park are reached the same way: a raw TCP socket on port
 * 9100, one session at a time, no framing and no handshake — you write bytes
 * and, for the two status commands, you read a byte back. That is true of the
 * Welltech G4 and the XP-80 units (DEVICE_INVENTORY §9.3, §9.4) and of the
 * 4B-2082A (§9.1). So there is one channel interface and the adapters above it
 * differ only in what they write.
 *
 * It is an interface rather than a socket because the simulator has to sit
 * behind the SAME adapter the real printer sits behind. A simulator reached
 * through a different code path would prove the simulator, not the adapter —
 * and the adapter is the thing that goes to Phuket.
 */

import net from 'node:net';

export interface ChannelTarget {
  host: string;
  /** 9100 on every unit in the park; carried so a bench test can use another. */
  port: number;
}

/**
 * Timeouts, from the adapter parameter blocks in DEVICE_INVENTORY §9.1 and
 * §9.3. They are short on purpose: a till waiting on a printer is a queue of
 * people waiting on a till.
 */
export const CHANNEL_TIMEOUTS = {
  connectMs: 2000,
  /**
   * How long the socket may take to accept one piece of a job
   * (`WRITE_PIECE_BYTES`) — see `write` in `tcpChannel` for why a job is sent
   * in pieces, and for what this does and does not measure.
   */
  writeMs: 5000,
  /**
   * One status query, from sending it to its one-byte reply. 800 ms on ESC/POS
   * and 1000 on the label printer in the inventory; 1000 is used for both.
   */
  statusMs: 1000,
  /** How long a label job may take to come off the machine. */
  jobCompleteMs: 15_000,
} as const;

/**
 * The piece a job is written in, and what `CHANNEL_TIMEOUTS.writeMs` is
 * measured against.
 *
 * 16 KB is 227 raster lines of an 80 mm slip, about 28 mm of paper: a
 * receipt printer in this family printing at its rated 200–260 mm/s (§9.3,
 * §9.4) reads that much in about a tenth of a second, and the band printer
 * at the `SPEED 4` the renderer sets by default (4 in/s, 50-byte lines) in
 * under half a second. Linux may want more than one piece read before it
 * takes the next (see `write` in `tcpChannel`), but never more than its
 * buffers hold, which is 80–110 KB over a 1500-byte-MTU link (measured in
 * the audit) — about a second of printing for the receipt printer at those
 * speeds, and under three for the band printer. So five seconds is a stopped
 * printer, not a slow one.
 */
const WRITE_PIECE_BYTES = 16 * 1024;

/** Why a print attempt ended. Short, non-leaking: these reach a Console page. */
export type PrinterErrorCode =
  /** Nothing answered on the address. Cable, power, or the wrong IP. */
  | 'PRINTER_UNREACHABLE'
  /**
   * The socket died while the job was going out, or it took no piece of the
   * job for `CHANNEL_TIMEOUTS.writeMs` because the printer was not reading
   * enough of what went before (see `write` in `tcpChannel`).
   */
  | 'PRINTER_WRITE_FAILED'
  /** A status query went unanswered. Not fatal on its own — see `escpos.ts`. */
  | 'PRINTER_NO_STATUS'
  | 'PRINTER_PAPER_OUT'
  | 'PRINTER_COVER_OPEN'
  | 'PRINTER_CUTTER_ERROR'
  | 'PRINTER_HEAD_OPEN'
  | 'PRINTER_PAPER_JAM'
  | 'PRINTER_OFFLINE'
  /** The device row this job was routed to is not on this box any more. */
  | 'DEVICE_GONE'
  /** The device has no address, so there is nothing to open. */
  | 'DEVICE_NO_ADDRESS'
  /** The socket died before the cash-drawer pulse reached the printer (S2-10a). */
  | 'DRAWER_WRITE_FAILED'
  /** The printer this station's drawer would ride has no drawer line at all. */
  | 'PRINTER_HAS_NO_DRAWER'
  /** The renderer refused the job — a bitmap wider than the head, say. */
  | 'RENDER_FAILED';

export class PrinterError extends Error {
  readonly code: PrinterErrorCode;
  /**
   * Whether trying again unattended could reasonably work.
   *
   * `false` does NOT mean "never print this": it means no timer should send it
   * again on its own. A person pressing reprint is a different act, and it
   * mints a new job.
   */
  readonly retryable: boolean;
  /**
   * True when bytes had already gone down the socket when this failed, so
   * whether paper came out is unknown.
   *
   * This is the field that decides against an automatic retry. A receipt that
   * stopped halfway is paper in a guest's hand; sending it again unattended
   * produces a second one and nobody can tell which is which afterwards.
   */
  readonly partial: boolean;

  constructor(
    code: PrinterErrorCode,
    message: string,
    opts: { retryable?: boolean; partial?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PrinterError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.partial = opts.partial ?? false;
  }
}

export interface PrinterChannel {
  /**
   * Hand bytes to the machine. Rejects with a `PrinterError` on a dead socket,
   * and on a printer that stops taking them (`tcpChannel` says how long it is
   * given).
   */
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Write a command and read the reply.
   *
   * Resolves with however many bytes arrived before `timeoutMs`, which may be
   * none — an unanswered status query is a fact about the firmware, not an
   * exception, and §9.3 leaves open which of these units answer over LAN.
   */
  query(bytes: Uint8Array, expect: number, timeoutMs: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Open one session. Rejects with `PRINTER_UNREACHABLE` if nothing answers. */
export type ChannelFactory = (target: ChannelTarget) => Promise<PrinterChannel>;

/**
 * `192.168.88.202:9100` or `192.168.88.202`.
 *
 * Returns null rather than guessing when there is no address at all: a device
 * row with an empty address is a configuration somebody has not finished, and
 * the job that routes to it is skipped by name instead of failing against
 * `undefined:9100`.
 */
export function parseAddress(address: string | null | undefined): ChannelTarget | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  const at = trimmed.lastIndexOf(':');
  if (at <= 0) return { host: trimmed, port: 9100 };
  const port = Number.parseInt(trimmed.slice(at + 1), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return { host: trimmed, port: 9100 };
  return { host: trimmed.slice(0, at), port };
}

/**
 * What a socket hands a `data` listener.
 *
 * Node types it `Buffer | string` because `setEncoding` would make it a
 * string. Nothing here ever calls that — a printer's reply is one status byte
 * and decoding it as text would destroy it — so the string branch is
 * unreachable in this file and is converted rather than asserted away, which
 * costs nothing and cannot be wrong.
 */
export function asBytes(chunk: Buffer | string): Uint8Array {
  return typeof chunk === 'string'
    ? new TextEncoder().encode(chunk)
    : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * The real thing: a TCP socket, as both families want it.
 *
 * No keep-alive and no pooling. §9.1 and §9.6 both say one session at a time
 * per printer and neither vendor document says what a second connection does —
 * refused or stalled is an open "confirm on site" item — so the box holds a
 * socket for exactly as long as one job takes and lets go. Serialising two
 * jobs for one printer is the queue's business (`queue.ts`), not the socket's.
 */
export function tcpChannel(target: ChannelTarget): Promise<PrinterChannel> {
  return new Promise<PrinterChannel>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    /** Bytes that arrived when nobody was reading. Kept for the next query. */
    let pending: Uint8Array = new Uint8Array(0);
    let waiter: ((chunk: Uint8Array) => void) | null = null;

    const fail = (code: PrinterErrorCode, message: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new PrinterError(code, message, { retryable: true, cause }));
    };

    socket.setTimeout(CHANNEL_TIMEOUTS.connectMs);
    socket.once('timeout', () => fail('PRINTER_UNREACHABLE', `${target.host}:${target.port} did not answer`));
    socket.once('error', (err) =>
      fail('PRINTER_UNREACHABLE', `${target.host}:${target.port} refused the connection`, err),
    );

    socket.on('data', (chunk) => {
      const bytes = asBytes(chunk);
      const merged = new Uint8Array(pending.length + bytes.length);
      merged.set(pending);
      merged.set(bytes, pending.length);
      pending = merged;
      const take = waiter;
      if (take) {
        waiter = null;
        const out = pending;
        pending = new Uint8Array(0);
        take(out);
      }
    });

    socket.connect(target.port, target.host, () => {
      if (settled) return;
      settled = true;
      // The connect timeout must not go on firing for the life of the job.
      socket.setTimeout(0);
      resolve({
        /**
         * Send the job in `WRITE_PIECE_BYTES` pieces, and fail it once the
         * socket has taken no piece for `CHANNEL_TIMEOUTS.writeMs` (M15,
         * closing audit 2026-09-25).
         *
         * One `socket.write` of the whole job settled only when the socket
         * callback came, and on the Pi (Linux) a printer that keeps the
         * connection open but has stopped reading — a jam or the roll run out
         * mid-job, or any fault at all on a board that does not answer status,
         * which the check before the job cannot see — never lets it come once
         * the job is bigger than what the two ends buffer (80–110 KB over a
         * 1500-byte-MTU link, measured in the audit). The job then held the
         * printer's lock in `queue.ts` for as long as the printer stayed
         * stopped: every later slip waited behind it, and so did the
         * heartbeat's printer check.
         *
         * What the deadline measures is whether the socket took the next
         * piece in time, not whether the printer read anything. The kernel
         * takes pieces while its buffers have room, and only the printer
         * reading makes room again. So:
         *  - A printer that stops reading does not stop the socket at once:
         *    the kernel goes on taking pieces until its buffers are full. A
         *    job that ends before then — all of a small one, or the tail of a
         *    big one — completes its write and never meets the deadline. The
         *    status read after it decides, and from a printer that answers
         *    nothing then, the job is recorded printed with its status
         *    unknown (`adapter.ts`). How much the buffers take differs by
         *    system and link: 80–110 KB on the link above, so a booth slip
         *    (about 40 KB) is such a job on the Pi; on loopback 0.3–0.5 MB on
         *    Windows and 2.5–9.5 MB on Linux (`print-channel.test.ts`).
         *  - A bigger job fails `writeMs` after the socket last took a piece:
         *    about `writeMs` after a printer stopped. A printer still reading,
         *    but not enough, can be cut off too: the socket takes the next
         *    piece only once the printer has made room, and Linux wants well
         *    over a piece read first (hundreds of KB on loopback). On the Pi's
         *    link that is never more than the 80–110 KB the buffers hold,
         *    which a printer printing at its rated speed reads inside
         *    `writeMs` (see `WRITE_PIECE_BYTES`).
         *
         * Counting pieces scales the deadline to the job's size without
         * guessing a speed: a job of N bytes is given at most
         * ⌈N / 16 KB⌉ × `writeMs`. Pieces are also what lets a stall show on
         * Windows: there one large write can settle at once, even to a
         * printer reading nothing (64 MB in a few tens of milliseconds on
         * loopback), and leave the stall to whatever is written next.
         *
         * A stall is `PRINTER_WRITE_FAILED`, `partial`: some of the job may
         * already be on paper, so nothing sends it again by itself (see
         * `PrinterError.partial`). The socket is destroyed at the deadline,
         * but what the kernel had already taken still goes out, up to a send
         * buffer's worth, to a printer that starts reading again: part of a
         * job reported failed — whole copies, on a job of several — can still
         * come out of it.
         */
        write(bytes) {
          return new Promise<void>((ok, no) => {
            let offset = 0;
            let done = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (err: PrinterError | null): void => {
              if (done) return;
              done = true;
              if (timer !== undefined) clearTimeout(timer);
              if (err) no(err);
              else ok();
            };
            const next = (): void => {
              if (offset >= bytes.length) {
                finish(null);
                return;
              }
              if (socket.destroyed) {
                finish(
                  new PrinterError(
                    'PRINTER_WRITE_FAILED',
                    `${target.host}:${target.port} closed while the job was going out`,
                    { partial: true },
                  ),
                );
                return;
              }
              const piece = bytes.subarray(offset, offset + WRITE_PIECE_BYTES);
              timer = setTimeout(() => {
                socket.destroy();
                finish(
                  new PrinterError(
                    'PRINTER_WRITE_FAILED',
                    `${target.host}:${target.port} held up the job: no more of it could be sent for ${
                      CHANNEL_TIMEOUTS.writeMs / 1000
                    } s`,
                    { partial: true },
                  ),
                );
              }, CHANNEL_TIMEOUTS.writeMs);
              timer.unref?.();
              socket.write(piece, (err) => {
                if (timer !== undefined) clearTimeout(timer);
                if (done) return;
                if (err) {
                  finish(
                    new PrinterError(
                      'PRINTER_WRITE_FAILED',
                      `${target.host}:${target.port} closed while the job was going out`,
                      { partial: true, cause: err },
                    ),
                  );
                  return;
                }
                offset += piece.length;
                next();
              });
            };
            next();
          });
        },
        /**
         * Send a query and wait for its reply, `timeoutMs` for the two
         * together.
         *
         * The clock starts before the query is sent, not after, because the
         * sending can stall too: when a printer stops reading just as the end
         * of a job fills the socket's buffer, the job's write completes and it
         * is the query's three bytes that cannot be handed over. Waiting for
         * that write before starting the clock made the status read after
         * such a job a wait with no end. A query that could not be sent in
         * time is an unanswered one.
         *
         * The reply is listened for from the start, so one that arrives before
         * the write's callback is not left in `pending` for the next query.
         */
        async query(bytes, expect, timeoutMs) {
          if (pending.length >= expect) {
            const out = pending.subarray(0, expect);
            pending = pending.subarray(expect);
            return out;
          }
          return new Promise<Uint8Array>((ok, no) => {
            let done = false;
            const take = (chunk: Uint8Array): void => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              ok(chunk);
            };
            const timer = setTimeout(() => {
              if (waiter === take) waiter = null;
              take(new Uint8Array(0));
            }, timeoutMs);
            timer.unref?.();
            waiter = take;
            socket.write(bytes, (err) => {
              if (!err || done) return;
              done = true;
              clearTimeout(timer);
              if (waiter === take) waiter = null;
              no(
                new PrinterError('PRINTER_NO_STATUS', 'the status query could not be sent', {
                  cause: err,
                }),
              );
            });
          });
        },
        /**
         * Close, and WAIT for the socket to be closed.
         *
         * Ending and destroying in the same breath looks tidier and is wrong:
         * the far end has not necessarily seen the FIN when this resolves, so
         * the next job's connection can arrive at a printer that still thinks
         * the last session is open — and both families accept exactly one at a
         * time (§9.1, §9.6). Measured, not theorised: it refused every second
         * job against the simulator's TCP server until this waited.
         *
         * The timeout is the other half. A printer that will not close
         * politely must not hold a till's queue, so after a second it is
         * destroyed and the job is over either way.
         */
        close() {
          return new Promise<void>((ok) => {
            if (socket.destroyed) {
              ok();
              return;
            }
            const done = (): void => {
              clearTimeout(timer);
              ok();
            };
            const timer = setTimeout(() => {
              socket.destroy();
              ok();
            }, 1000);
            timer.unref?.();
            socket.once('close', done);
            socket.end();
          });
        },
      });
    });
  });
}
