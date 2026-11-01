import { constants as fsConstants, open as openFd, closeSync } from 'node:fs';
import { open as openFile, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path/posix';
import { ReadStream as TtyReadStream, isatty } from 'node:tty';

import {
  DeviceSettingsSchema,
  SCANNER_BURST_GAP_MS,
  SCANNER_USB_DEFAULTS,
  type ScannerMode,
} from '@oto/shared';

import type { BoxConfigStation, ScannerHealth } from './protocol';
import type { ScanInput } from './scan';
import {
  HidBurstReader,
  SerialScanReader,
  type HidBurstEvent,
  type HidKeyEvent,
} from './scan-input';

/**
 * THE COUNTER SCANNER, READ BY THE BOX ITSELF (SCRUM-700).
 *
 * DEVICE_INVENTORY D2 put the Zebra DS2278's cradle on the box rather than on
 * the iPad, and until now nothing on the box opened it: a cradle plugged into
 * a Pi typed into nothing, and Till 1 recorded no scans while the cradle sat in
 * its box. This file is the missing reader. It opens the scanner the station's
 * device row names, turns what comes off it into codes with the readers that
 * already decide what a scan is (`scan-input.ts`), and hands each code to the
 * agent, which delivers it to the scanning service for that station exactly as
 * the Console's simulator does. The till, the display, the gate and the kiosk
 * then see the scan on the station channel as they always have.
 *
 * TWO WAYS IN, BOTH WITH NODE'S OWN `fs` (no native module, no package):
 *
 *  - `hid` — the cradle as it ships, a USB keyboard (`05e0:1200`). The box
 *    reads its input event node, `/dev/input/eventN`, as the stream of 24-byte
 *    `struct input_event` records the kernel writes (16 bytes on a 32-bit
 *    system): the time, then type, code and value. Key presses become
 *    characters on a US layout with Shift, and `HidBurstReader` tells a scan
 *    from anything else by its pace and its Enter. The node is opened
 *    non-blocking and read on a short poll, because a blocking read of a
 *    character device holds one of libuv's four threads until the next key —
 *    and a box restarted a few times with nobody scanning would run out of
 *    them.
 *  - `cdc` — the cradle switched to USB serial by scanning one configuration
 *    bar code (`05e0:1701`, `/dev/ttyACM*`): clean lines of bytes, the mode
 *    §9.2 recommends. Read through Node's tty stream in raw mode, so a code
 *    with no suffix still arrives, nothing is echoed back, and a record ends
 *    at CR, LF or half a second of quiet (`SerialScanReader`).
 *
 * KEEPING THE KEYSTROKES AWAY FROM THE SCREEN. The design called for an
 * exclusive grab (`EVIOCGRAB`), which is an ioctl Node cannot make. The box
 * installer instead writes a udev rule that tells libinput — the kiosk's
 * browser and its display server — to ignore the cradle, and gives the box's
 * own user read access to it and nothing else (`scripts/pi/install.sh`). The
 * one reader left is a text console on the box's own screen, which a kiosk
 * box never shows.
 *
 * NEVER CRASH THE AGENT, NEVER GIVE UP. A scanner that is not plugged in, is
 * pulled out mid-shift or cannot be opened is a state, reported on the
 * heartbeat (`ScannerHealth`) and retried every few seconds; nothing here
 * throws into the agent.
 */

// --- What the box should read ----------------------------------------------

/** One scanner this box reads, from its config bundle. */
export interface ScannerSpec {
  deviceId: string;
  /** The station its scans are delivered to. */
  stationId: string;
  label: string;
  mode: ScannerMode;
  /** Four lower-case hex digits, as Linux writes them. */
  vendorId: string;
  productId: string;
  /** A node to open instead of finding one by the USB ids. Under `/dev/` only. */
  path: string | null;
  /** The suffix the scanner ends a code with, as `HidBurstReader` names keys. */
  terminatorKey: 'Enter' | 'Tab';
  /** The burst gap from the row, or the shared default when it names none. */
  burstGapMs?: number;
}

/**
 * The scanners in a config bundle that this box reads itself.
 *
 * A device of kind `scanner` on one of the box's stations, reached over `usb`
 * or `serial`. A `simulated` scanner — every one the seed declares, and the
 * virtual box's — is never opened: the Console's simulator is what drives
 * those. A `bluetooth` one is paired to something else. A device that serves
 * two stations is read once, for the first station that names it.
 *
 * How it is read is the row's `settings.scanner.mode`, or the transport when
 * the row does not say (`serial` reads CDC, `usb` reads HID), because the
 * Console's edit cannot move a device's transport but can change its mode.
 * The USB ids default to the park's Zebra cradle for that mode, and the path
 * to the row's address when that is a device node.
 */
export function scannerSpecsOf(stations: readonly BoxConfigStation[] | undefined): ScannerSpec[] {
  const specs: ScannerSpec[] = [];
  const seen = new Set<string>();
  for (const station of stations ?? []) {
    for (const device of station.devices) {
      if (device.kind !== 'scanner') continue;
      if (device.transport !== 'usb' && device.transport !== 'serial') continue;
      if (seen.has(device.id)) continue;
      seen.add(device.id);
      // Read leniently: a section the box cannot parse leaves the defaults,
      // which is the park's cradle as it ships, rather than no scanner at all.
      const parsed = DeviceSettingsSchema.safeParse(device.settings ?? {});
      const settings = parsed.success ? (parsed.data.scanner ?? {}) : {};
      const mode: ScannerMode = settings.mode ?? (device.transport === 'serial' ? 'cdc' : 'hid');
      const address = device.address?.startsWith('/dev/') ? device.address : null;
      specs.push({
        deviceId: device.id,
        stationId: station.id,
        label: device.label,
        mode,
        vendorId: (settings.vendorId ?? SCANNER_USB_DEFAULTS.vendorId).toLowerCase(),
        productId: (settings.productId ?? SCANNER_USB_DEFAULTS.productId[mode]).toLowerCase(),
        path: settings.devicePath ?? address,
        terminatorKey: settings.suffix === 'tab' ? 'Tab' : 'Enter',
        ...(settings.burstGapMs !== undefined ? { burstGapMs: settings.burstGapMs } : {}),
      });
    }
  }
  return specs.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

/** What the readers are built from; a host is rebuilt only when this moves. */
export function scannerSignature(specs: readonly ScannerSpec[]): string {
  return JSON.stringify(specs);
}

// --- The input event stream (HID) ------------------------------------------

/** `EV_SYN`, `EV_KEY` and `SYN_DROPPED` from `linux/input-event-codes.h`. */
export const EV_SYN = 0x00;
export const EV_KEY = 0x01;
export const SYN_REPORT = 0;
export const SYN_DROPPED = 3;

/** One `struct input_event`, with its time in milliseconds. */
export interface InputEvent {
  atMs: number;
  type: number;
  code: number;
  value: number;
}

/**
 * The size of `struct input_event` on this machine: two 64-bit time fields
 * then 2 + 2 + 4 bytes on a 64-bit kernel (a Raspberry Pi 5 on its 64-bit OS
 * — the only kind the installer supports), two 32-bit ones on a 32-bit system.
 */
export function inputEventSize(arch: string = process.arch): 16 | 24 {
  return arch === 'arm' || arch === 'ia32' ? 16 : 24;
}

/**
 * Bytes off an event node, as events. A read can end part-way through a
 * record, so the tail is kept for the next chunk rather than misread.
 */
export class InputEventDecoder {
  private readonly size: 16 | 24;
  private carry: Buffer = Buffer.alloc(0);

  constructor(size: 16 | 24 = inputEventSize()) {
    this.size = size;
  }

  push(chunk: Uint8Array): InputEvent[] {
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const buf = this.carry.length > 0 ? Buffer.concat([this.carry, incoming]) : incoming;
    const events: InputEvent[] = [];
    let at = 0;
    while (buf.length - at >= this.size) {
      const wide = this.size === 24;
      const sec = wide ? Number(buf.readBigInt64LE(at)) : buf.readInt32LE(at);
      const usec = wide ? Number(buf.readBigInt64LE(at + 8)) : buf.readInt32LE(at + 4);
      const body = at + (wide ? 16 : 8);
      events.push({
        atMs: sec * 1000 + usec / 1000,
        type: buf.readUInt16LE(body),
        code: buf.readUInt16LE(body + 2),
        value: buf.readInt32LE(body + 4),
      });
      at += this.size;
    }
    // A copy, so the chunk the caller passed can be reused under us.
    this.carry = Buffer.from(buf.subarray(at));
    return events;
  }

  reset(): void {
    this.carry = Buffer.alloc(0);
  }
}

/** One `struct input_event` as the kernel writes it — for tests and the bench. */
export function encodeInputEvent(event: InputEvent, size: 16 | 24 = inputEventSize()): Buffer {
  const buf = Buffer.alloc(size);
  const sec = Math.floor(event.atMs / 1000);
  const usec = Math.round((event.atMs - sec * 1000) * 1000);
  let body: number;
  if (size === 24) {
    buf.writeBigInt64LE(BigInt(sec), 0);
    buf.writeBigInt64LE(BigInt(usec), 8);
    body = 16;
  } else {
    buf.writeInt32LE(sec, 0);
    buf.writeInt32LE(usec, 4);
    body = 8;
  }
  buf.writeUInt16LE(event.type, body);
  buf.writeUInt16LE(event.code, body + 2);
  buf.writeInt32LE(event.value, body + 4);
  return buf;
}

/**
 * Linux key codes (`KEY_*`) to what a US keyboard types, unshifted and
 * shifted. The scanner emulates a North American keyboard by default
 * (DEVICE_INVENTORY §9.2, `keyboard_layout: us`), and the host has to read it
 * the same way or `-`, `_` and `:` transpose.
 */
// prettier-ignore
const US_KEYS: Record<number, readonly [string, string]> = {
  2: ['1', '!'], 3: ['2', '@'], 4: ['3', '#'], 5: ['4', '$'], 6: ['5', '%'],
  7: ['6', '^'], 8: ['7', '&'], 9: ['8', '*'], 10: ['9', '('], 11: ['0', ')'],
  12: ['-', '_'], 13: ['=', '+'],
  16: ['q', 'Q'], 17: ['w', 'W'], 18: ['e', 'E'], 19: ['r', 'R'], 20: ['t', 'T'],
  21: ['y', 'Y'], 22: ['u', 'U'], 23: ['i', 'I'], 24: ['o', 'O'], 25: ['p', 'P'],
  26: ['[', '{'], 27: [']', '}'],
  30: ['a', 'A'], 31: ['s', 'S'], 32: ['d', 'D'], 33: ['f', 'F'], 34: ['g', 'G'],
  35: ['h', 'H'], 36: ['j', 'J'], 37: ['k', 'K'], 38: ['l', 'L'],
  39: [';', ':'], 40: ["'", '"'], 41: ['`', '~'], 43: ['\\', '|'],
  44: ['z', 'Z'], 45: ['x', 'X'], 46: ['c', 'C'], 47: ['v', 'V'], 48: ['b', 'B'],
  49: ['n', 'N'], 50: ['m', 'M'],
  51: [',', '<'], 52: ['.', '>'], 53: ['/', '?'], 57: [' ', ' '],
};

/** The numeric keypad, read as Num Lock on: what a scanner's keypad emulation types. */
// prettier-ignore
const KEYPAD: Record<number, string> = {
  71: '7', 72: '8', 73: '9', 74: '-', 75: '4', 76: '5', 77: '6', 78: '+',
  79: '1', 80: '2', 81: '3', 82: '0', 83: '.', 55: '*', 98: '/',
};

/** Keys with a name rather than a character, as `HidBurstReader` names them. */
// prettier-ignore
const NAMED_KEYS: Record<number, string> = {
  1: 'Escape', 14: 'Backspace', 15: 'Tab', 28: 'Enter', 96: 'Enter',
  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
  65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12',
};

const KEY_LEFTSHIFT = 42;
const KEY_RIGHTSHIFT = 54;
const KEY_LEFTCTRL = 29;
const KEY_RIGHTCTRL = 97;
const KEY_LEFTALT = 56;
const KEY_RIGHTALT = 100;
const KEY_CAPSLOCK = 58;
const LETTER = /^[a-z]$/;

/**
 * Key events to the key a person (or a scanner) typed: a character for a
 * printable key with Shift and Caps Lock applied, a name for Enter, Tab and
 * the function keys, nothing for a release or a modifier.
 *
 * Two of the scanner's own habits are read too. Alt held over keypad digits is
 * a character by its decimal code — how "keypad emulation" sends one the
 * layout lacks — delivered when Alt is let go. Ctrl+M and Ctrl+J are a CR and
 * an LF — how "function key mapping" sends the suffix — and read as Enter.
 */
export class EvdevKeyboard {
  private readonly shift = new Set<number>();
  private readonly ctrl = new Set<number>();
  private readonly alt = new Set<number>();
  private capsLock = false;
  private altCode = '';

  /** The key this event typed, or null. */
  key(event: InputEvent): string | null {
    if (event.type !== EV_KEY) return null;
    const { code, value } = event;
    const down = value === 1;
    const up = value === 0;
    // 2 is the kernel's auto-repeat: a scanner never holds a key down.
    if (!down && !up) return null;

    if (code === KEY_LEFTSHIFT || code === KEY_RIGHTSHIFT) {
      if (down) this.shift.add(code);
      else this.shift.delete(code);
      return null;
    }
    if (code === KEY_LEFTCTRL || code === KEY_RIGHTCTRL) {
      if (down) this.ctrl.add(code);
      else this.ctrl.delete(code);
      return null;
    }
    if (code === KEY_LEFTALT || code === KEY_RIGHTALT) {
      if (down) {
        this.alt.add(code);
        return null;
      }
      this.alt.delete(code);
      if (this.alt.size > 0 || this.altCode === '') return null;
      const typed = Number.parseInt(this.altCode, 10);
      this.altCode = '';
      return typed >= 0x20 && typed <= 0x7e ? String.fromCharCode(typed) : null;
    }
    if (!down) return null;
    if (code === KEY_CAPSLOCK) {
      this.capsLock = !this.capsLock;
      return null;
    }
    if (this.alt.size > 0) {
      const digit = KEYPAD[code];
      if (digit !== undefined && /^[0-9]$/.test(digit)) this.altCode += digit;
      return null;
    }
    const named = NAMED_KEYS[code];
    if (named) return named;
    const pair = US_KEYS[code];
    if (this.ctrl.size > 0) {
      return pair && (pair[0] === 'm' || pair[0] === 'j') ? 'Enter' : null;
    }
    if (pair) {
      const shifted = this.shift.size > 0;
      if (LETTER.test(pair[0])) return shifted !== this.capsLock ? pair[1] : pair[0];
      return shifted ? pair[1] : pair[0];
    }
    return KEYPAD[code] ?? null;
  }

  /** Forget what is held: the stream lost events and the state may be wrong. */
  reset(): void {
    this.shift.clear();
    this.ctrl.clear();
    this.alt.clear();
    this.altCode = '';
  }
}

/** A burst the kernel dropped events from: thrown away rather than misread. */
export interface ScanOverrun {
  kind: 'overrun';
  at: number;
}

export type ScannerReadEvent = HidBurstEvent | ScanOverrun;

/**
 * The HID reader: bytes off `/dev/input/eventN` in, scans out.
 *
 * Each key is timed by the KERNEL's timestamp on its event, not by when the box
 * got round to reading it, so the burst rule sees the scanner's real pace
 * however late a poll lands. Those timestamps are mapped onto `now()` — the
 * clock `tick` closes a quiet burst by — once, and again only if the two drift
 * apart by a second (the kernel stamps by a clock the box may not run on), and
 * never while a burst is open: a burst is timed by one clock from its first
 * key to its last, or a read that lands late would look like a pause inside it.
 *
 * When the kernel's buffer overflows it says so (`SYN_DROPPED`) and the events
 * up to the next report are unreliable. A code read through that would be a
 * code with characters missing — and the tail of a long code is still long
 * enough to pass for one — so the WHOLE burst the drop fell in is thrown away
 * and reported once as an overrun; the person scans again.
 *
 * Where that burst ends is decided by the scanner's clock alone: its suffix, or
 * a key that comes more than the burst gap after the last one (or after the
 * drop, which carries the time of the newest event the kernel kept). Never by
 * the box's own clock: a box that stopped reading long enough to overflow has
 * stopped for longer than the burst gap, so a pause measured by when the box
 * read the keys says nothing about the scan.
 *
 * The same holds for a burst the quiet tick closes. After a stall the tick can
 * run before the read that holds the rest of the code, so the box's clock says
 * the burst went quiet while its tail sits unread in the kernel. A key that
 * comes within the burst gap of the closed burst's last one, by the kernel's
 * stamps, is that tail: it is thrown away up to its suffix, as an overrun.
 */
export class EvdevScanReader {
  private readonly decoder: InputEventDecoder;
  private readonly keyboard = new EvdevKeyboard();
  private readonly burst: HidBurstReader;
  private readonly gapMs: number;
  private readonly terminatorKey: string;
  private readonly now: () => number;
  private skew: number | null = null;
  /** Between a `SYN_DROPPED` and the report after it: every event is unreliable. */
  private dropping = false;
  /**
   * The burst in progress lost keys — to a drop, or to a tick that closed it
   * before its tail was read. Its keys are swallowed until its suffix, or until
   * a key the kernel stamps more than the burst gap after the last.
   */
  private poisoned = false;
  /** The kernel's time of the last key read, or of the drop. */
  private lastKernelAt: number | null = null;
  /** The kernel's time of the last key of a burst the quiet tick closed. */
  private cutAt: number | null = null;

  constructor(
    options: {
      terminatorKey?: string;
      burstGapMs?: number;
      eventSize?: 16 | 24;
      now?: () => number;
    } = {},
  ) {
    this.decoder = new InputEventDecoder(options.eventSize ?? inputEventSize());
    this.gapMs = options.burstGapMs ?? SCANNER_BURST_GAP_MS;
    this.terminatorKey = options.terminatorKey ?? 'Enter';
    this.burst = new HidBurstReader({
      source: 'box_hid',
      burstGapMs: this.gapMs,
      terminatorKey: this.terminatorKey,
    });
    this.now = options.now ?? Date.now;
  }

  push(chunk: Uint8Array): ScannerReadEvent[] {
    const out: ScannerReadEvent[] = [];
    for (const event of this.decoder.push(chunk)) {
      const kernelAt = event.atMs;
      const at = this.localTime(kernelAt);
      if (event.type === EV_SYN && event.code === SYN_DROPPED) {
        if (!this.poisoned) out.push({ kind: 'overrun', at });
        this.dropping = true;
        this.poisoned = true;
        this.cutAt = null;
        // The drop is part of the burst it damaged: the next key is timed from it.
        this.lastKernelAt = kernelAt;
        this.keyboard.reset();
        this.burst.reset();
        continue;
      }
      if (this.dropping) {
        if (event.type === EV_SYN && event.code === SYN_REPORT) this.dropping = false;
        continue;
      }
      const key = this.keyboard.key(event);
      if (key === null) continue;
      if (this.cutAt !== null) {
        // The tick closed the last burst for quiet. Within the burst gap of its
        // last key by the scanner's clock, this key is that burst, read late.
        if (!this.poisoned && kernelAt - this.cutAt <= this.gapMs) {
          out.push({ kind: 'overrun', at });
          this.poisoned = true;
        }
        this.cutAt = null;
      }
      if (this.poisoned) {
        // The scanner paused after the damage: by its own clock this key starts
        // a new burst. Anything else is the damaged burst, swallowed up to and
        // including its suffix.
        const gap = this.lastKernelAt === null ? Infinity : kernelAt - this.lastKernelAt;
        if (gap <= this.gapMs) {
          this.lastKernelAt = kernelAt;
          if (key === this.terminatorKey) this.poisoned = false;
          continue;
        }
        this.poisoned = false;
      }
      this.lastKernelAt = kernelAt;
      const keyEvent: HidKeyEvent = { key, at };
      const result = this.burst.push(keyEvent);
      if (result) out.push(result);
    }
    return out;
  }

  /**
   * Close a burst that never got its suffix — `HidBurstReader`'s rule 3. Only
   * ever closes: a damaged burst is ended by the scanner's clock, in `push`.
   */
  tick(now: number = this.now()): ScannerReadEvent | null {
    const result = this.burst.tick(now);
    if (result) this.cutAt = this.lastKernelAt;
    return result;
  }

  private localTime(eventMs: number): number {
    const wall = this.now();
    if (this.skew === null || (!this.burst.open && Math.abs(wall - (eventMs + this.skew)) > 1000)) {
      this.skew = wall - eventMs;
    }
    return eventMs + this.skew;
  }
}

// --- Finding the device ------------------------------------------------------

/** The kernel's list of input devices, with the handlers each one feeds. */
export const INPUT_DEVICE_LIST = '/proc/bus/input/devices';
/** Where the serial devices are listed; each links back to its USB device. */
export const TTY_CLASS_DIR = '/sys/class/tty';

/** One block of `/proc/bus/input/devices`. */
export interface InputDeviceEntry {
  vendor: string;
  product: string;
  name: string;
  handlers: string[];
}

/**
 * `/proc/bus/input/devices`, as entries. Blocks of `X: …` lines separated by
 * blank lines; the two that matter read
 * `I: Bus=0003 Vendor=05e0 Product=1200 Version=0110` and
 * `H: Handlers=sysrq kbd leds event4`.
 */
export function parseInputDeviceList(text: string): InputDeviceEntry[] {
  const entries: InputDeviceEntry[] = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    let vendor = '';
    let product = '';
    let name = '';
    let handlers: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('I:')) {
        vendor = /Vendor=([0-9a-fA-F]{4})/.exec(line)?.[1]?.toLowerCase() ?? '';
        product = /Product=([0-9a-fA-F]{4})/.exec(line)?.[1]?.toLowerCase() ?? '';
      } else if (line.startsWith('N:')) {
        name = /Name="(.*)"/.exec(line)?.[1] ?? '';
      } else if (line.startsWith('H:')) {
        handlers = line
          .replace(/^H:\s*Handlers=/, '')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      }
    }
    if (vendor && product) entries.push({ vendor, product, name, handlers });
  }
  return entries;
}

/**
 * The event node of the keyboard with these USB ids, or null.
 *
 * A HID device can present several input devices — the keyboard and a
 * consumer-control interface beside it — and only the one with a `kbd`
 * handler types the code, so that one is preferred.
 */
export function hidEventNodeFor(
  entries: readonly InputDeviceEntry[],
  vendorId: string,
  productId: string,
): string | null {
  const matching = entries.filter(
    (e) => e.vendor === vendorId.toLowerCase() && e.product === productId.toLowerCase(),
  );
  const keyboard = matching.find((e) => e.handlers.includes('kbd')) ?? matching[0];
  const event = keyboard?.handlers.find((h) => /^event\d+$/.test(h));
  return event ? `/dev/input/${event}` : null;
}

/**
 * What the box needs of the operating system, injected so a test can stand in
 * for the kernel. `nodeScannerIo` is the real one.
 */
export interface ScannerIo {
  readText(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
  /** The real path of a link; throws when there is nothing there. */
  resolve(path: string): Promise<string>;
  open(path: string, mode: ScannerMode): Promise<ScannerChannel>;
}

/** An open scanner: bytes until it goes away. */
export interface ScannerChannel {
  /**
   * Called once. `onData` gets every chunk; `onEnd` is called once when the
   * device stops — pulled out, reset — with the error or null.
   */
  start(onData: (chunk: Uint8Array) => void, onEnd: (err: Error | null) => void): void;
  close(): void;
}

/**
 * The `/dev/ttyACM*` of the serial device with these USB ids, or null.
 *
 * Each `/sys/class/tty/ttyACMn/device` links to the USB interface the port
 * belongs to, and the interface's parent is the USB device, which holds
 * `idVendor` and `idProduct`. A `ttyACM` that has gone away mid-search is
 * skipped rather than failing the search.
 */
export async function cdcNodeFor(
  io: ScannerIo,
  vendorId: string,
  productId: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = await io.list(TTY_CLASS_DIR);
  } catch {
    return null;
  }
  const ports = names
    .filter((n) => /^ttyACM\d+$/.test(n))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  for (const port of ports) {
    try {
      const usbInterface = await io.resolve(`${TTY_CLASS_DIR}/${port}/device`);
      const usbDevice = dirname(usbInterface);
      const vendor = (await io.readText(`${usbDevice}/idVendor`)).trim().toLowerCase();
      const product = (await io.readText(`${usbDevice}/idProduct`)).trim().toLowerCase();
      if (vendor === vendorId.toLowerCase() && product === productId.toLowerCase())
        return `/dev/${port}`;
    } catch {
      continue;
    }
  }
  return null;
}

/** Where this scanner is now, or why it cannot be found. */
export async function locateScanner(
  io: ScannerIo,
  spec: Pick<ScannerSpec, 'mode' | 'vendorId' | 'productId' | 'path'>,
): Promise<{ path: string } | { path: null; problem: string }> {
  if (spec.path !== null) {
    // The row names the node. Only a device node: a path into the box's own
    // home would read its credential as a stream of "scans".
    if (!spec.path.startsWith('/dev/')) {
      return {
        path: null,
        problem: `The scanner's path must be a device under /dev/, not ${spec.path}`,
      };
    }
    try {
      await io.resolve(spec.path);
      return { path: spec.path };
    } catch {
      return {
        path: null,
        problem: `Nothing at ${spec.path}: is the scanner plugged into this box?`,
      };
    }
  }
  const ids = `${spec.vendorId}:${spec.productId}`;
  const missing = {
    path: null,
    problem:
      spec.mode === 'cdc'
        ? `No serial scanner with USB id ${ids} is plugged into this box (is the cradle in USB CDC mode?)`
        : `No scanner with USB id ${ids} is plugged into this box`,
  } as const;
  if (spec.mode === 'cdc') {
    const found = await cdcNodeFor(io, spec.vendorId, spec.productId);
    return found ? { path: found } : missing;
  }
  let list: string;
  try {
    list = await io.readText(INPUT_DEVICE_LIST);
  } catch {
    return {
      path: null,
      problem: `This box cannot read ${INPUT_DEVICE_LIST} to look for the scanner`,
    };
  }
  const found = hidEventNodeFor(parseInputDeviceList(list), spec.vendorId, spec.productId);
  return found ? { path: found } : missing;
}

// --- The host: one reader per scanner, kept open -------------------------------

export interface ScannerHostOptions {
  specs: readonly ScannerSpec[];
  io: ScannerIo;
  /** One code, for this scanner's station. Its failures are logged, never thrown back. */
  deliver(spec: ScannerSpec, input: ScanInput): Promise<void>;
  note(level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>): void;
  /** The clock the readers close a quiet burst by. Default `Date.now`. */
  now?: () => number;
  /** The box's own stamp, corrected against the platform, for `lastScanAt` and `scannedAt`. */
  stamp?: () => string;
  /** How long a scanner that is not there waits before it is looked for again. Default 3 s. */
  retryMs?: number;
  /** How often a quiet burst is checked for. Default 100 ms. */
  tickMs?: number;
}

/** What the heartbeat says about one scanner, with the fault the device row carries. */
export type ScannerReport = ScannerHealth & { lastError?: string };

export interface ScannerHost {
  readonly signature: string;
  start(): void;
  stop(): void;
  /** By device id. */
  health(): Record<string, ScannerReport>;
  /** Resolves once every reader has finished what it is doing now — for tests. */
  settled(): Promise<void>;
}

interface Line {
  spec: ScannerSpec;
  present: boolean;
  open: boolean;
  path: string | null;
  lastScanAt: string | null;
  scans: number;
  dropped: number;
  problem: string | null;
  /** The problem last written to the log, so a retry every few seconds is one line, not hundreds. */
  noted: string | null;
  channel: ScannerChannel | null;
  reader: {
    push(chunk: Uint8Array): ScannerReadEvent[];
    tick(now: number): ScannerReadEvent | ScanInput | null;
  } | null;
  retry: ReturnType<typeof setTimeout> | null;
  attempt: Promise<void>;
  deliveries: Promise<void>;
}

const DEFAULT_RETRY_MS = 3_000;
const DEFAULT_TICK_MS = 100;

export function createScannerHost(options: ScannerHostOptions): ScannerHost {
  const now = options.now ?? Date.now;
  const stamp = options.stamp ?? (() => new Date().toISOString());
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const lines: Line[] = options.specs.map((spec) => ({
    spec,
    present: false,
    open: false,
    path: null,
    lastScanAt: null,
    scans: 0,
    dropped: 0,
    problem: null,
    noted: null,
    channel: null,
    reader: null,
    retry: null,
    attempt: Promise.resolve(),
    deliveries: Promise.resolve(),
  }));
  let running = false;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const detail = (line: Line, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    module: 'scanner',
    deviceId: line.spec.deviceId,
    stationId: line.spec.stationId,
    mode: line.spec.mode,
    ...extra,
  });

  function setProblem(line: Line, problem: string | null): void {
    line.problem = problem;
    if (problem && problem !== line.noted) {
      options.note('warn', `scanner ${line.spec.label}: ${problem}`, detail(line));
    }
    line.noted = problem;
  }

  function scheduleRetry(line: Line): void {
    if (!running || line.retry) return;
    line.retry = setTimeout(() => {
      line.retry = null;
      line.attempt = attempt(line);
    }, retryMs);
    line.retry.unref?.();
  }

  function handle(line: Line, event: ScannerReadEvent | ScanInput): void {
    if ('code' in event) {
      deliver(line, event);
      return;
    }
    if (event.kind === 'scan') {
      deliver(line, event.input);
      return;
    }
    if (event.kind === 'partial' || event.kind === 'overrun') {
      line.dropped += 1;
      options.note(
        'warn',
        event.kind === 'overrun'
          ? 'a scan was lost while the box was busy — scan it again'
          : event.reason === 'too_short'
            ? 'a scan shorter than a code was dropped'
            : 'a partial scan was dropped: the code never got its suffix (is the scanner set to send Enter?)',
        detail(
          line,
          event.kind === 'partial' ? { length: event.length, reason: event.reason } : {},
        ),
      );
    }
    // A button press on a scanner's own keys means nothing here.
  }

  function deliver(line: Line, input: ScanInput): void {
    const at = stamp();
    line.lastScanAt = at;
    line.scans += 1;
    const code: ScanInput = { ...input, scannedAt: at };
    // One at a time and in order, per scanner: two scans a second apart are
    // two scans, and the second must not overtake the first.
    line.deliveries = line.deliveries
      .then(() => options.deliver(line.spec, code))
      .catch((err: unknown) => {
        options.note(
          'error',
          'a scan read from the box scanner could not be delivered',
          detail(line, { err: String(err) }),
        );
      });
  }

  function readerFor(spec: ScannerSpec): NonNullable<Line['reader']> {
    if (spec.mode === 'cdc') {
      const serial = new SerialScanReader({ source: 'box_serial' });
      return {
        push: (chunk) =>
          serial
            .push(chunk, now())
            .map((input) => ({ kind: 'scan', input, length: input.code.length }) as const),
        tick: (at) => serial.tick(at),
      };
    }
    const hid = new EvdevScanReader({
      terminatorKey: spec.terminatorKey,
      ...(spec.burstGapMs !== undefined ? { burstGapMs: spec.burstGapMs } : {}),
      now,
    });
    return { push: (chunk) => hid.push(chunk), tick: (at) => hid.tick(at) };
  }

  async function attempt(line: Line): Promise<void> {
    if (!running || line.channel) return;
    let where: Awaited<ReturnType<typeof locateScanner>>;
    try {
      where = await locateScanner(options.io, line.spec);
    } catch (err) {
      where = { path: null, problem: `The box could not look for the scanner (${String(err)})` };
    }
    if (!running) return;
    if (where.path === null) {
      line.present = false;
      line.open = false;
      line.path = line.spec.path;
      setProblem(line, where.problem);
      scheduleRetry(line);
      return;
    }
    line.present = true;
    line.path = where.path;
    let channel: ScannerChannel;
    try {
      channel = await options.io.open(where.path, line.spec.mode);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      line.open = false;
      if (code === 'ENOENT' || code === 'ENODEV' || code === 'ENXIO') line.present = false;
      setProblem(
        line,
        code === 'EACCES' || code === 'EPERM'
          ? `The scanner is at ${where.path} but the box may not read it — run the box installer again`
          : `The scanner at ${where.path} could not be opened (${code ?? String(err)})`,
      );
      scheduleRetry(line);
      return;
    }
    if (!running) {
      channel.close();
      return;
    }
    line.channel = channel;
    line.reader = readerFor(line.spec);
    line.open = true;
    line.problem = null;
    line.noted = null;
    options.note(
      'info',
      `scanner ${line.spec.label} open at ${where.path}`,
      detail(line, { path: where.path }),
    );
    channel.start(
      (chunk) => {
        if (line.channel !== channel || !line.reader) return;
        try {
          for (const event of line.reader.push(chunk)) handle(line, event);
        } catch (err) {
          options.note(
            'error',
            'the box scanner sent something the reader could not read',
            detail(line, { err: String(err) }),
          );
        }
      },
      (err) => {
        if (line.channel !== channel) return;
        line.channel = null;
        line.reader = null;
        line.open = false;
        try {
          channel.close();
        } catch {
          // Already gone.
        }
        setProblem(
          line,
          `The scanner stopped answering${err ? ` (${(err as NodeJS.ErrnoException).code ?? err.message})` : ''} — unplugged? The box keeps looking for it`,
        );
        scheduleRetry(line);
      },
    );
  }

  return {
    signature: scannerSignature(options.specs),
    start() {
      if (running) return;
      running = true;
      for (const line of lines) line.attempt = attempt(line);
      if (lines.length > 0) {
        ticker = setInterval(() => {
          const at = now();
          for (const line of lines) {
            if (!line.reader) continue;
            try {
              const event = line.reader.tick(at);
              if (event) handle(line, event);
            } catch (err) {
              options.note(
                'error',
                'the box scanner reader failed on its tick',
                detail(line, { err: String(err) }),
              );
            }
          }
        }, tickMs);
        ticker.unref?.();
      }
    },
    stop() {
      running = false;
      if (ticker) clearInterval(ticker);
      ticker = null;
      for (const line of lines) {
        if (line.retry) clearTimeout(line.retry);
        line.retry = null;
        const channel = line.channel;
        line.channel = null;
        line.reader = null;
        line.open = false;
        try {
          channel?.close();
        } catch {
          // Already gone.
        }
      }
    },
    health() {
      const out: Record<string, ScannerReport> = {};
      for (const line of lines) {
        out[line.spec.deviceId] = {
          mode: line.spec.mode,
          present: line.present,
          open: line.open,
          // Bounded as the heartbeat's schema bounds them: an over-long path
          // typed on a row must not cost the box its whole heartbeat.
          path: line.path === null ? null : line.path.slice(0, 128),
          lastScanAt: line.lastScanAt,
          scans: line.scans,
          dropped: line.dropped,
          ...(line.problem ? { lastError: line.problem.slice(0, 200) } : {}),
        };
      }
      return out;
    },
    async settled() {
      await Promise.all(lines.map((line) => line.attempt));
      await Promise.all(lines.map((line) => line.deliveries));
    },
  };
}

// --- The real operating system ----------------------------------------------

/**
 * How often a non-blocking HID node is read. The kernel holds 64 events for a
 * keyboard reader — about ten characters, since each key is a press and a
 * release with a scan code and a report each — and the cradle can type a
 * character every two milliseconds, so the poll has to come round well inside
 * twenty. Each poll is one short read on libuv's pool.
 */
export const HID_POLL_MS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** A node read non-blocking on a short poll — the input event node, or a serial line that is not a tty. */
async function openPolled(path: string, pollMs: number): Promise<ScannerChannel> {
  const handle = await openFile(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOCTTY ?? 0),
  );
  let closed = false;
  return {
    start(onData, onEnd) {
      const buf = Buffer.alloc(4096);
      const loop = async (): Promise<void> => {
        while (!closed) {
          let bytesRead: number;
          try {
            ({ bytesRead } = await handle.read(buf, 0, buf.length, null));
          } catch (err) {
            if (closed) return;
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
              await sleep(pollMs);
              continue;
            }
            closed = true;
            onEnd(err as Error);
            return;
          }
          if (closed) return;
          if (bytesRead === 0) {
            closed = true;
            onEnd(null);
            return;
          }
          onData(Buffer.from(buf.subarray(0, bytesRead)));
        }
      };
      void loop();
    },
    close() {
      closed = true;
      void handle.close().catch(() => undefined);
    },
  };
}

/**
 * A serial port in raw mode, through Node's own tty stream: epoll-driven, no
 * poll, no thread held. Opened `O_NOCTTY` — without it the agent, a session
 * leader under systemd, would take the port as its controlling terminal and
 * be hung up when the cradle is pulled out — and non-blocking, so the open
 * does not wait for a carrier the cradle never raises.
 */
async function openSerial(path: string, pollMs: number): Promise<ScannerChannel> {
  const fd = await new Promise<number>((resolve, reject) => {
    openFd(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOCTTY ?? 0),
      (err, opened) => (err ? reject(err) : resolve(opened)),
    );
  });
  if (!isatty(fd)) {
    // Not a terminal — a pipe on a bench, say. Read it the way a HID node is.
    closeSync(fd);
    return openPolled(path, pollMs);
  }
  let stream: TtyReadStream;
  try {
    stream = new TtyReadStream(fd);
    // No line editing (a code with no suffix still arrives), no echo back to
    // the scanner, CR kept as CR.
    stream.setRawMode(true);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // The stream may already own it.
    }
    throw err;
  }
  return {
    start(onData, onEnd) {
      let ended = false;
      const finish = (err: Error | null): void => {
        if (ended) return;
        ended = true;
        onEnd(err);
      };
      stream.on('data', (chunk: Buffer) => onData(chunk));
      stream.on('error', (err) => finish(err));
      stream.on('end', () => finish(null));
      stream.on('close', () => finish(null));
    },
    close() {
      stream.destroy();
    },
  };
}

/** The operating system as a Raspberry Pi presents it. */
export function nodeScannerIo(options: { pollMs?: number } = {}): ScannerIo {
  const pollMs = options.pollMs ?? HID_POLL_MS;
  return {
    readText: (path) => readFile(path, 'utf8'),
    list: (dir) => readdir(dir),
    resolve: (path) => realpath(path),
    open: (path, mode) => (mode === 'cdc' ? openSerial(path, pollMs) : openPolled(path, pollMs)),
  };
}
