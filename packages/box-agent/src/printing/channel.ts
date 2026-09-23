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
  writeMs: 5000,
  /** One status byte. 800 ms on ESC/POS, 1000 on the label printer. */
  statusMs: 1000,
  /** How long a label job may take to come off the machine. */
  jobCompleteMs: 15_000,
} as const;

/** Why a print attempt ended. Short, non-leaking: these reach a Console page. */
export type PrinterErrorCode =
  /** Nothing answered on the address. Cable, power, or the wrong IP. */
  | 'PRINTER_UNREACHABLE'
  /** The socket died while the job was going out. */
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
  /** Hand bytes to the machine. Rejects with a `PrinterError` on a dead socket. */
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
        write(bytes) {
          return new Promise<void>((ok, no) => {
            socket.write(bytes, (err) =>
              err
                ? no(
                    new PrinterError(
                      'PRINTER_WRITE_FAILED',
                      `${target.host}:${target.port} closed while the job was going out`,
                      { partial: true, cause: err },
                    ),
                  )
                : ok(),
            );
          });
        },
        async query(bytes, expect, timeoutMs) {
          if (pending.length >= expect) {
            const out = pending.subarray(0, expect);
            pending = pending.subarray(expect);
            return out;
          }
          await new Promise<void>((ok, no) => {
            socket.write(bytes, (err) =>
              err
                ? no(new PrinterError('PRINTER_NO_STATUS', 'the status query could not be sent', { cause: err }))
                : ok(),
            );
          });
          return new Promise<Uint8Array>((ok) => {
            const timer = setTimeout(() => {
              waiter = null;
              ok(new Uint8Array(0));
            }, timeoutMs);
            timer.unref?.();
            waiter = (chunk) => {
              clearTimeout(timer);
              ok(chunk);
            };
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
