/**
 * Printer simulators (S2-06).
 *
 * A simulator here is not a stub that says "printed". It is a byte-stream
 * device: it takes exactly the bytes the adapter writes to a real printer,
 * answers the same status queries with the same bit frames, and turns what it
 * received into the picture that would have come out of the machine. That is
 * the only shape of simulator worth having — a stub would have gone green on
 * every one of the eight defects the fixtures found in the renderer.
 *
 * **It parses with the renderer's own reader.** `@oto/print/reader` is
 * `packages/print/test/escpos-reader.ts`, written during the renderer work and
 * documented there as "the shape the S2-06 printer simulator's parser needs, so
 * it is written to be lifted". Lifting it rather than writing a second parser
 * is what keeps the simulator honest: the reader is the same code that proves,
 * in `emit.test.ts`, that the emitted bytes carry the rendered dots and nothing
 * else, so a simulator preview that differs from the renderer's preview means
 * the transport lost something.
 *
 * What is faithfully reproduced, from DEVICE_INVENTORY §9.1 and §9.3:
 *   - `DLE EOT n` answered immediately with one byte, in any state, including
 *     mid-job and while in error — bits 1 and 4 always set, 0 and 7 always
 *     clear, so an idle n=1 reply is 0x12.
 *   - `ESC ! ?` answered with one bit-OR'd byte on the label printer.
 *   - `~!T` / `~!I` model and code-page identity.
 *   - One session at a time; a second is refused rather than interleaved.
 *   - While paper is out, the job is dropped rather than drawn.
 *
 * What is NOT reproduced, and is left out rather than faked: `GS a` automatic
 * status back (unconfirmed over LAN on this firmware), `SET RESPONSE` per-label
 * acknowledgement (firmware >= V7.09, unconfirmed here), the vendor IP-set
 * command, and dump mode. Each of those is a thing the adapter deliberately
 * does not rely on, so a simulator that answered them would be testing a path
 * the park cannot use.
 */

import net from 'node:net';
import { previewPng } from '@oto/print';
import { parseEscpos, parseTsplBitmap, tsplSetupLines } from '@oto/print/reader';
import type { PrinterFault } from '@oto/shared';
import { asBytes, PrinterError, type PrinterChannel, type ChannelTarget } from './channel';

/** One thing that came out of the machine. */
export interface Printout {
  /** 1-based, per simulator — the label counter a real unit keeps. */
  seq: number;
  at: string;
  widthDots: number;
  heightDots: number;
  /** PNG of exactly the dots the device was told to burn. */
  preview: Uint8Array;
  /** How many bytes the job was. */
  jobBytes: number;
  /**
   * True when the session ended without the job's terminator — a cut on
   * ESC/POS, a `PRINT` on TSPL. This is the paper that came out of a printer
   * somebody unplugged mid-job.
   */
  truncated: boolean;
  /** TSPL setup lines (`SIZE`, `GAP`, `DENSITY`…), for the label family only. */
  setup?: string[];
}

export type SimulatorEventKind =
  | 'job.printed'
  | 'job.dropped'
  | 'drawer.kick'
  | 'cut'
  | 'status.read'
  | 'fault.set'
  | 'fault.cleared'
  | 'session.refused';

export interface SimulatorEvent {
  at: string;
  kind: SimulatorEventKind;
  detail: Record<string, unknown>;
}

export interface PrinterSimulator {
  readonly deviceId: string;
  readonly label: string;
  readonly model: string;
  readonly language: 'escpos' | 'tspl2';
  readonly widthDots: number;
  /** Faults currently injected. `unreachable` is checked before the socket opens. */
  readonly faults: ReadonlySet<PrinterFault>;
  setFault(fault: PrinterFault): void;
  clearFaults(): void;
  /** Open a session. Throws when one is already open, as the real units do. */
  connect(): PrinterChannel;
  printouts(limit?: number): Printout[];
  events(limit?: number): SimulatorEvent[];
  /** Serve this simulator on a real TCP port, as the printers are served. */
  listen(port?: number): Promise<{ port: number; close: () => Promise<void> }>;
}

export interface SimulatorOptions {
  deviceId: string;
  label: string;
  model: string;
  language: 'escpos' | 'tspl2';
  /** 576 on most of the family, 512 on some; 400 on a 50 mm band (§9.4, §9.1). */
  widthDots: number;
  now?: () => Date;
  /** How many printouts and events to keep. A Pi has finite memory. */
  keep?: number;
}

const DLE = 0x10;
const ESC = 0x1b;
const KEEP_DEFAULT = 20;
const TSPL_BITMAP = new TextEncoder().encode('BITMAP ');

export function createPrinterSimulator(options: SimulatorOptions): PrinterSimulator {
  const now = options.now ?? (() => new Date());
  const keep = options.keep ?? KEEP_DEFAULT;
  const faults = new Set<PrinterFault>();
  const outs: Printout[] = [];
  const log: SimulatorEvent[] = [];
  let seq = 0;
  let open = false;
  /** Bytes of the job in flight, realtime commands already taken out. */
  let buffer = new Uint8Array(0);

  function note(kind: SimulatorEventKind, detail: Record<string, unknown> = {}): void {
    log.push({ at: now().toISOString(), kind, detail });
    if (log.length > keep * 4) log.splice(0, log.length - keep * 4);
  }

  /**
   * The `DLE EOT n` reply byte.
   *
   * Built from the fixed frame outward rather than from a table, so the two
   * invariants the manual states — bits 1 and 4 set, bits 0 and 7 clear — hold
   * for every fault combination instead of for the ones somebody remembered.
   */
  function escposStatusByte(n: number): number {
    let b = 0x12;
    if (n === 1) {
      if (faults.has('cover_open')) b |= 0x08; // off-line while the cover is up
    } else if (n === 2) {
      if (faults.has('cover_open')) b |= 0x04;
      if (faults.has('paper_out')) b |= 0x20;
      if (faults.has('paper_out') || faults.has('cover_open') || faults.has('cutter_error')) b |= 0x40;
    } else if (n === 3) {
      if (faults.has('cutter_error')) b |= 0x48; // cutter error, auto-recoverable
    } else if (n === 4) {
      if (faults.has('paper_out')) b |= 0x60;
      else if (faults.has('paper_low')) b |= 0x0c;
    }
    return b;
  }

  /** `ESC ! ?` — one bit-OR'd byte; 0x00 is ready (§9.1). */
  function labelStatusByte(): number {
    let b = 0;
    if (faults.has('cover_open')) b |= 0x01; // head open
    if (faults.has('cutter_error')) b |= 0x02; // jam — the nearest fault a band printer has
    if (faults.has('paper_out')) b |= 0x04;
    return b;
  }

  /**
   * Pull the commands a real printer executes out of band out of the stream.
   *
   * §9.3 is explicit that `DLE EOT` is "executed even when the printer is
   * off-line, the receive buffer is full, or there is an error status", which
   * is precisely what makes it the status baseline — so the simulator answers
   * it from wherever it appears, including between two raster bands, and does
   * not let it reach the job buffer where the reader would call it unknown.
   */
  function takeRealtime(chunk: Uint8Array): { job: Uint8Array; reply: Uint8Array } {
    const job: number[] = [];
    const reply: number[] = [];
    let i = 0;
    while (i < chunk.length) {
      const b = chunk[i] ?? 0;
      /**
       * Step OVER a counted image payload rather than through it.
       *
       * A raster band is arbitrary binary — a receipt with the right pattern
       * of black dots contains the bytes `10 04 01` — and a scanner looking
       * for real-time commands byte by byte would pull three bytes out of the
       * middle of the picture, misalign everything after them, and produce a
       * printout that is unreadable or, worse, subtly wrong. A real printer
       * does not have this problem because it reads the length first, so
       * neither does this. Found by a kitchen ticket that came out truncated
       * in one run and whole in the next, which is the shape of the bug.
       */
      const counted = countedPayload(chunk, i);
      if (counted !== null) {
        for (let k = i; k < counted; k += 1) job.push(chunk[k] ?? 0);
        i = counted;
        continue;
      }
      if (options.language === 'escpos' && b === DLE && i + 2 < chunk.length) {
        const n = chunk[i + 1];
        const arg = chunk[i + 2] ?? 0;
        if (n === 0x04) {
          reply.push(escposStatusByte(arg));
          note('status.read', { query: `DLE EOT ${arg}`, byte: escposStatusByte(arg) });
          i += 3;
          continue;
        }
        if (n === 0x05) {
          // `DLE ENQ n` — recover from an auto-cutter error and carry on.
          faults.delete('cutter_error');
          i += 3;
          continue;
        }
      }
      if (options.language === 'tspl2' && b === ESC && chunk[i + 1] === 0x21 && i + 2 < chunk.length) {
        const cmd = chunk[i + 2];
        if (cmd === 0x3f) {
          reply.push(labelStatusByte());
          note('status.read', { query: 'ESC ! ?', byte: labelStatusByte() });
          i += 3;
          continue;
        }
        if (cmd === 0x2e) {
          // `ESC ! .` cancel all printing — drop whatever is buffered.
          buffer = new Uint8Array(0);
          i += 3;
          continue;
        }
      }
      if (options.language === 'tspl2' && b === 0x7e && chunk[i + 1] === 0x21 && i + 2 < chunk.length) {
        const cmd = chunk[i + 2];
        const answer =
          cmd === 0x54 ? `${options.model}\r` : cmd === 0x49 ? '850, 001\r' : null;
        if (answer !== null) {
          for (const byte of new TextEncoder().encode(answer)) reply.push(byte);
          i += 3;
          // The query is terminated by the line ending the adapter sent.
          while (i < chunk.length && (chunk[i] === 0x0d || chunk[i] === 0x0a)) i += 1;
          continue;
        }
      }
      job.push(b);
      i += 1;
    }
    return { job: Uint8Array.from(job), reply: Uint8Array.from(reply) };
  }

  /**
   * If a command with a counted binary payload starts at `at`, where it ends.
   *
   * `GS v 0 m xL xH yL yH <widthBytes * height>` on ESC/POS and
   * `BITMAP x,y,widthBytes,height,mode,<widthBytes * height>` on TSPL2 — the
   * two places in either language where the stream carries bytes that must not
   * be read as commands. Returns null when this is not one of them, and when
   * the payload has not fully arrived yet, so the caller keeps buffering.
   */
  function countedPayload(chunk: Uint8Array, at: number): number | null {
    if (options.language === 'escpos') {
      if (chunk[at] !== 0x1d || chunk[at + 1] !== 0x76 || chunk[at + 2] !== 0x30) return null;
      if (at + 8 > chunk.length) return null;
      const widthBytes = (chunk[at + 4] ?? 0) | ((chunk[at + 5] ?? 0) << 8);
      const height = (chunk[at + 6] ?? 0) | ((chunk[at + 7] ?? 0) << 8);
      const end = at + 8 + widthBytes * height;
      return end <= chunk.length ? end : null;
    }
    if (chunk[at] !== 0x42 /* B */) return null;
    for (let k = 0; k < TSPL_BITMAP.length; k += 1) {
      if (chunk[at + k] !== TSPL_BITMAP[k]) return null;
    }
    let cursor = at + TSPL_BITMAP.length;
    const fields: number[] = [];
    let current = '';
    while (fields.length < 5 && cursor < chunk.length) {
      const ch = String.fromCharCode(chunk[cursor] ?? 0);
      cursor += 1;
      if (ch === ',') {
        fields.push(Number(current));
        current = '';
      } else current += ch;
    }
    if (fields.length < 5) return null;
    const [, , widthBytes = 0, height = 0] = fields;
    const end = cursor + widthBytes * height;
    return end <= chunk.length ? end : null;
  }

  function append(job: Uint8Array): void {
    if (job.length === 0) return;
    /**
     * While paper is out the machine takes the bytes and prints nothing —
     * §9.3's simulator note, "refuse to render further lines until paper
     * loaded". Recording the drop rather than silently swallowing it is what
     * makes "the job queued and nothing came out" visible in the Box log.
     */
    if (faults.has('paper_out')) {
      note('job.dropped', { bytes: job.length, reason: 'paper_out' });
      return;
    }
    const merged = new Uint8Array(buffer.length + job.length);
    merged.set(buffer);
    merged.set(job, buffer.length);
    buffer = merged;
    if (complete(buffer)) finish(false);
  }

  /** Has the terminator arrived — a cut on ESC/POS, a `PRINT` on TSPL? */
  function complete(bytes: Uint8Array): boolean {
    if (options.language === 'escpos') {
      try {
        return parseEscpos(bytes, options.widthDots).cuts > 0;
      } catch {
        // Not a whole job yet — a raster band cut off mid-payload.
        return false;
      }
    }
    return tsplPrintAt(bytes) >= 0;
  }

  /** Turn the buffer into a printout. */
  function finish(truncated: boolean): void {
    if (buffer.length === 0) return;
    const bytes = buffer;
    buffer = new Uint8Array(0);
    try {
      seq += 1;
      if (options.language === 'escpos') {
        const parsed = parseEscpos(bytes, options.widthDots);
        for (const kick of parsed.drawerKicks) note('drawer.kick', { ...kick });
        for (let c = 0; c < parsed.cuts; c += 1) note('cut', { seq });
        push({
          seq,
          at: now().toISOString(),
          widthDots: parsed.bitmap.width,
          heightDots: parsed.bitmap.height,
          preview: previewPng(parsed.bitmap),
          jobBytes: bytes.length,
          truncated,
        });
        note('job.printed', {
          seq,
          bands: parsed.bands,
          cuts: parsed.cuts,
          drawerKicks: parsed.drawerKicks.length,
          unknown: parsed.unknown.length,
          truncated,
        });
        return;
      }
      const bitmap = parseTsplBitmap(bytes, options.widthDots);
      push({
        seq,
        at: now().toISOString(),
        widthDots: bitmap.width,
        heightDots: bitmap.height,
        preview: previewPng(bitmap),
        jobBytes: bytes.length,
        truncated,
        setup: tsplSetupLines(bytes),
      });
      note('job.printed', { seq, labels: 1, truncated });
    } catch (err) {
      /**
       * Bytes that will not parse are the honest outcome of a socket cut in
       * the middle of a raster band: there is not enough of a picture to draw.
       * A real printer would have burned the rows it received; the simulator
       * cannot reconstruct them, and says so rather than inventing a blank
       * page or throwing at the adapter, which has already finished its job.
       */
      seq -= 1;
      note('job.dropped', {
        bytes: bytes.length,
        reason: 'unreadable',
        detail: err instanceof Error ? err.message : String(err),
        truncated,
      });
    }
  }

  function push(out: Printout): void {
    outs.push(out);
    if (outs.length > keep) outs.splice(0, outs.length - keep);
  }

  function connect(): PrinterChannel {
    if (faults.has('unreachable')) {
      note('session.refused', { reason: 'unreachable' });
      throw new PrinterError('PRINTER_UNREACHABLE', `${options.label} does not answer`, {
        retryable: true,
      });
    }
    if (open) {
      /**
       * One session at a time. Both families say so (§9.1 "accept ONE
       * connection at a time", §9.6 "raw print port 9100, one session at a
       * time") and neither vendor document says whether a second is refused or
       * stalled — an open "confirm on site" item. Refusing is the option that
       * cannot deadlock a till.
       */
      note('session.refused', { reason: 'busy' });
      throw new PrinterError('PRINTER_UNREACHABLE', `${options.label} is busy with another job`, {
        retryable: true,
      });
    }
    open = true;
    let replies: Uint8Array = new Uint8Array(0);
    return {
      async write(bytes) {
        const { job, reply } = takeRealtime(bytes);
        replies = concat(replies, reply);
        append(job);
      },
      async query(bytes, expect) {
        const { job, reply } = takeRealtime(bytes);
        replies = concat(replies, reply);
        append(job);
        const take = Math.min(expect, replies.length);
        const out = replies.subarray(0, take);
        replies = replies.subarray(take);
        return out;
      },
      async close() {
        finish(true);
        open = false;
      },
    };
  }

  return {
    deviceId: options.deviceId,
    label: options.label,
    model: options.model,
    language: options.language,
    widthDots: options.widthDots,
    faults,
    setFault(fault) {
      faults.add(fault);
      note('fault.set', { fault });
    },
    clearFaults() {
      const had = [...faults];
      faults.clear();
      note('fault.cleared', { cleared: had });
    },
    connect,
    printouts(limit = keep) {
      return outs.slice(-limit);
    },
    events(limit = keep * 2) {
      return log.slice(-limit);
    },
    async listen(port = 0) {
      const server = net.createServer((socket) => {
        let channel: PrinterChannel;
        try {
          channel = connect();
        } catch {
          socket.destroy();
          return;
        }
        socket.on('data', (chunk) => {
          void (async () => {
            const { job, reply } = takeRealtime(asBytes(chunk));
            append(job);
            if (reply.length > 0) socket.write(reply);
          })();
        });
        const done = (): void => {
          void channel.close();
        };
        socket.on('close', done);
        socket.on('error', done);
      });
      await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      return {
        port: bound,
        close: () =>
          new Promise<void>((ok) => {
            server.close(() => ok());
          }),
      };
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Where a TSPL job's `PRINT` command starts, or -1 if it has not arrived.
 *
 * This is framing, not parsing: `BITMAP`'s payload is raw 1-bpp rows with no
 * escaping, so it can and does contain the bytes of the word PRINT, and the
 * only safe way to find the end of the job is to skip the payload by its
 * declared length first. `parseTsplBitmap` does the actual decoding.
 */
function tsplPrintAt(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1');
  const marker = 'BITMAP ';
  const head = text.decode(bytes);
  const at = head.indexOf(marker);
  if (at < 0) return head.indexOf('PRINT ');
  let cursor = at + marker.length;
  const fields: number[] = [];
  let current = '';
  while (fields.length < 5 && cursor < bytes.length) {
    const ch = String.fromCharCode(bytes[cursor] ?? 0);
    cursor += 1;
    if (ch === ',') {
      fields.push(Number(current));
      current = '';
    } else current += ch;
  }
  if (fields.length < 5) return -1;
  const [, , widthBytes = 0, height = 0] = fields;
  const tailStart = cursor + widthBytes * height;
  if (tailStart > bytes.length) return -1;
  const tail = text.decode(bytes.subarray(tailStart));
  const printAt = tail.indexOf('PRINT ');
  return printAt < 0 ? -1 : tailStart + printAt;
}

/** A `ChannelFactory` that reaches simulators instead of sockets. */
export function simulatorChannels(
  find: (target: ChannelTarget) => PrinterSimulator | undefined,
): (target: ChannelTarget) => Promise<PrinterChannel> {
  return async (target) => {
    const sim = find(target);
    if (!sim) {
      throw new PrinterError('PRINTER_UNREACHABLE', `nothing is listening on ${target.host}:${target.port}`, {
        retryable: true,
      });
    }
    return sim.connect();
  };
}
