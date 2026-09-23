/**
 * The wire to a payment terminal (S2-10a).
 *
 * `printing/channel.ts` is the shape this follows and NOT the shape it can
 * reuse: a printer is a TCP socket at `{host, port}` (`channel.ts:19-23`) and a
 * terminal is a character device on the box's own USB bus. Everything else
 * carries over — an interface rather than a port object, so the simulator sits
 * behind the SAME adapter the real terminal sits behind and whatever the
 * simulator proves is a claim about the code that goes to Phuket.
 *
 * FOUR THINGS THE PHYSICAL LAYER FORCES, all from `DEVICE_INVENTORY.md §9.5`:
 *
 *  1. **Open by id, never by `ttyACMn`** (`:946`). The handsets are lifted off
 *     the counter, charged, and put back; each time, the kernel may number the
 *     node differently. The path we are configured with is a
 *     `/dev/serial/by-id/…` symlink and it is resolved AT EVERY OPEN — caching
 *     the resolved node is the bug that makes a terminal work all morning and
 *     stop after lunch. §9.5 asks a simulator to prove exactly this by making
 *     the node come back with a different number.
 *  2. **9600 8-N-1, except on the NEXGO, where parity is an open question**
 *     (`:930`). The GHL spec's body says nothing about parity and its C# sample
 *     sets Odd (p.6 vs p.18), so odd is the default and the device row can
 *     override it — a constant here would mean a site visit to change a
 *     setting the Console already edits.
 *  3. **The 120-second budget** (`:948`) belongs to the READ, not to the port.
 *     Opening is 2 s and an idle read is 500 ms; a guest is two minutes.
 *  4. **The box does not ship a serial driver.** Node has no serial port of its
 *     own, this package carries no native dependency on purpose, and this
 *     ticket's scope is the simulators. So the opener is INJECTED: a Pi that
 *     drives real terminals passes one in, and a box without one says so by
 *     name instead of pretending a `/dev` path it cannot configure is open.
 *     What is ours and is tested here is the part that is ours — resolving the
 *     path, carrying the parameters, framing, and the deadlines.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  TERMINAL_TIMEOUTS,
  TerminalError,
  type FrameScanner,
  type TerminalChannel,
  type TerminalProtocol,
} from './contract';

export interface SerialTarget {
  /** `/dev/serial/by-id/usb-PAX_Technology_…`, as the device row carries it. */
  path: string;
  baud: number;
  dataBits: 7 | 8;
  parity: 'none' | 'odd' | 'even';
  stopBits: 1 | 2;
}

/**
 * The line settings per dialect, before the device row has its say.
 *
 * NEXGO: `9600 / 8 / parity "none (sample code: odd)" / 1`
 * (`DEVICE_INVENTORY.md:930`). The sample code is the only concrete evidence in
 * the vendor document, so it wins until somebody stands in front of the
 * terminal — and the open question is recorded there, not re-litigated here.
 * PAX: `9600 8N1` (`:938`, Digio spec §3).
 */
export const SERIAL_DEFAULTS: Record<TerminalProtocol, Omit<SerialTarget, 'path'>> = {
  ghl_linkpos: { baud: 9600, dataBits: 8, parity: 'odd', stopBits: 1 },
  digio_tlv: { baud: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
};

/**
 * Per-unit overrides off the device row's `settings` document.
 *
 * Read defensively rather than parsed with a schema: `DeviceSettings` in
 * `@oto/shared` has no terminal block yet (its own comment says a terminal's
 * parameters come from the acquirer), and a box must not refuse to open a port
 * because a field it does not know about appeared in a document written by a
 * newer Console.
 */
function serialOverrides(settings: unknown): Partial<Omit<SerialTarget, 'path'>> {
  if (!settings || typeof settings !== 'object') return {};
  const block = (settings as Record<string, unknown>).terminal;
  if (!block || typeof block !== 'object') return {};
  const held = block as Record<string, unknown>;
  const out: Partial<Omit<SerialTarget, 'path'>> = {};
  if (typeof held.baud === 'number' && held.baud > 0) out.baud = held.baud;
  if (held.parity === 'none' || held.parity === 'odd' || held.parity === 'even') {
    out.parity = held.parity;
  }
  if (held.dataBits === 7 || held.dataBits === 8) out.dataBits = held.dataBits;
  if (held.stopBits === 1 || held.stopBits === 2) out.stopBits = held.stopBits;
  return out;
}

/**
 * The target for one terminal, or null when its row has no address.
 *
 * Null rather than a guess, for the reason `parseAddress` returns null
 * (`printing/channel.ts:110-117`): a device row with no address is a
 * configuration somebody has not finished, and the tender that routes to it is
 * refused by name rather than sent to `undefined`.
 */
export function serialTargetFor(
  device: { address: string | null; settings?: unknown },
  protocol: TerminalProtocol,
): SerialTarget | null {
  const raw = device.address?.trim();
  if (!raw) return null;
  return { path: raw, ...SERIAL_DEFAULTS[protocol], ...serialOverrides(device.settings) };
}

/** Just enough of `node:fs` to resolve a symlink, so a test can stand in. */
export interface SerialFs {
  realpathSync(target: string): string;
  existsSync(target: string): boolean;
}

const nodeFs: SerialFs = {
  realpathSync: (target) => fs.realpathSync(target),
  existsSync: (target) => fs.existsSync(target),
};

/**
 * Turn the configured path into the node to open, NOW.
 *
 * Called on every open and never memoised. A `by-id` symlink survives the
 * handset being unplugged and pointed at a different `ttyACM` number when it
 * comes back, and that renumbering is normal rather than exceptional
 * (`DEVICE_INVENTORY.md:946`, `:949-957`). A path that is not a symlink — a
 * bench test pointed straight at `/dev/ttyACM0`, or a pty — is returned as it
 * stands, and a path that does not exist at all is refused as unreachable,
 * which is what a terminal that has been picked up looks like from here.
 */
export function resolveSerialPath(target: string, io: SerialFs = nodeFs): string {
  if (!io.existsSync(target)) {
    throw new TerminalError(
      'TERMINAL_UNREACHABLE',
      `${target} is not there — the terminal is unplugged, powered off, or its ECR app is closed`,
    );
  }
  try {
    return io.realpathSync(target);
  } catch (err) {
    // A symlink whose target has gone between the two calls: the handset was
    // lifted in the last millisecond. Same answer as not being there at all.
    throw new TerminalError('TERMINAL_UNREACHABLE', `${target} could not be resolved`, {
      cause: err,
    });
  }
}

/** True for the `/dev/serial/by-id` form, which is the one the park uses. */
export function isByIdPath(target: string): boolean {
  return path.posix.dirname(target.replace(/\\/g, '/')) === '/dev/serial/by-id';
}

// --- The transport ----------------------------------------------------------

/**
 * A byte pipe. One of these is a real serial port; one is a simulator.
 *
 * Deliberately smaller than `PrinterChannel`: no `query`, because a terminal
 * conversation is not request-then-one-status-byte. What arrives, arrives when
 * the guest has finished, and the framing is the channel's job above this.
 */
export interface TerminalTransport {
  write(bytes: Uint8Array): Promise<void>;
  /** Called once. Every byte from the far end goes to this sink. */
  onData(sink: (bytes: Uint8Array) => void): void;
  close(): Promise<void>;
}

/** Open a real serial port with the given line settings. Supplied by the host. */
export type SerialOpener = (target: SerialTarget) => Promise<TerminalTransport>;

/**
 * The default opener, which refuses by name.
 *
 * A box that is asked for a real terminal and has no driver must say so rather
 * than open the device node with `fs` and hope the line settings it cannot set
 * happen to be right. The park's terminals are simulated in this ticket
 * (`transport: 'simulated'` on both seeded EDC rows), and the day one is
 * tethered, whoever builds that box passes an opener in.
 */
export const noSerialDriver: SerialOpener = async (target) => {
  throw new TerminalError(
    'TERMINAL_NO_SERIAL_DRIVER',
    `this box has no serial driver, so ${target.path} cannot be opened — pass one in as terminal.openSerial`,
  );
};

// --- The channel ------------------------------------------------------------

interface ChannelOptions {
  /** Real time, not the box's skewed clock: these are deadlines on a wire. */
  now?: () => number;
}

/**
 * Framing, buffering and deadlines over any transport.
 *
 * The buffer survives a `readFrame`, and that is load-bearing rather than an
 * optimisation: a Digio QR sale answers TWICE — `A18` with the payload, then
 * `A3` when the guest pays — and the second frame can arrive while the first is
 * still being read. A channel that threw its buffer away between reads would
 * lose the payment.
 */
export function terminalChannel(
  transport: TerminalTransport,
  options: ChannelOptions = {},
): TerminalChannel {
  const now = options.now ?? (() => Date.now());
  let buffer = new Uint8Array(0);
  let waiter: (() => void) | null = null;
  let closed = false;

  transport.onData((bytes) => {
    if (bytes.length === 0) return;
    const merged = new Uint8Array(buffer.length + bytes.length);
    merged.set(buffer);
    merged.set(bytes, buffer.length);
    buffer = merged;
    const wake = waiter;
    waiter = null;
    wake?.();
  });

  return {
    async write(bytes) {
      if (closed) {
        throw new TerminalError('TERMINAL_WRITE_FAILED', 'the terminal session is closed');
      }
      try {
        await transport.write(bytes);
      } catch (err) {
        if (err instanceof TerminalError) throw err;
        throw new TerminalError('TERMINAL_WRITE_FAILED', 'the terminal closed while asking', {
          // Bytes may have reached the terminal and the terminal the host.
          partial: true,
          cause: err,
        });
      }
    },
    async readFrame(scan: FrameScanner, timeoutMs: number) {
      const deadline = now() + timeoutMs;
      for (;;) {
        const span = scan(buffer);
        if (span) {
          const frame = buffer.slice(span.start, span.end);
          buffer = buffer.slice(span.end);
          return frame;
        }
        const left = deadline - now();
        if (left <= 0 || closed) return null;
        /**
         * This timer is NOT unref'd, and that is deliberate.
         *
         * Every other timer in this package is, because a tick must never be
         * the reason a process cannot exit. A read in flight is the opposite: a
         * guest has a card in a terminal and the box is waiting for the answer,
         * and a process that exited during it would abandon a tender nobody can
         * account for afterwards. It resolves within the budget either way.
         */
        const woken = await new Promise<boolean>((ok) => {
          const timer = setTimeout(() => {
            waiter = null;
            ok(false);
          }, left);
          waiter = () => {
            clearTimeout(timer);
            ok(true);
          };
        });
        if (!woken) return null;
      }
    },
    discard() {
      buffer = new Uint8Array(0);
    },
    async close() {
      closed = true;
      const wake = waiter;
      waiter = null;
      wake?.();
      await transport.close();
    },
  };
}

/** Open a real terminal: resolve the node by id, then hand it to the opener. */
export async function openSerialChannel(
  target: SerialTarget,
  open: SerialOpener = noSerialDriver,
  io: SerialFs = nodeFs,
): Promise<TerminalChannel> {
  const node = resolveSerialPath(target.path, io);
  const transport = await open({ ...target, path: node });
  return terminalChannel(transport);
}

// --- The simulator's side of the same wire ----------------------------------

/**
 * A channel whose far end is a function.
 *
 * This is how a simulator sits behind the adapter without the adapter being
 * able to tell: it writes bytes, the bytes reach `handle`, and whatever
 * `handle` emits arrives as if it had come off a cable — including not at all,
 * which is the `no_response` outcome, and including after a delay, which is the
 * guest taking 30 to 90 seconds that §9.5 asks a simulator to reproduce.
 */
export function loopbackChannel(
  handle: (request: Uint8Array, emit: (bytes: Uint8Array, afterMs?: number) => void) => void,
  options: ChannelOptions = {},
): TerminalChannel {
  let sink: ((bytes: Uint8Array) => void) | null = null;
  let closed = false;
  const emit = (bytes: Uint8Array, afterMs = 0): void => {
    if (closed) return;
    if (afterMs <= 0) {
      sink?.(bytes);
      return;
    }
    const timer = setTimeout(() => {
      if (!closed) sink?.(bytes);
    }, afterMs);
    timer.unref?.();
  };
  return terminalChannel(
    {
      async write(bytes) {
        handle(bytes, emit);
      },
      onData(next) {
        sink = next;
      },
      async close() {
        closed = true;
      },
    },
    options,
  );
}

/** How long the adapter waits for the answer to a request of this kind. */
export function budgetFor(kind: 'sale' | 'probe'): number {
  return kind === 'sale' ? TERMINAL_TIMEOUTS.customerInteractionMs : TERMINAL_TIMEOUTS.probeMs;
}
