import {
  EV_KEY,
  EV_SYN,
  INPUT_DEVICE_LIST,
  SYN_REPORT,
  TTY_CLASS_DIR,
  encodeInputEvent,
  type ScannerChannel,
  type ScannerIo,
} from '../src/scanner-device';

/**
 * SCRUM-700 — the kernel and the Zebra cradle, stood in for at the one seam the
 * box's scanner reader has with them (`ScannerIo`). Shared by the reader's own
 * tests and the agent's.
 */

// --- What a Zebra cradle in HID mode writes to its event node ----------------

const MSC = 0x04;

/** US layout, the scanner's default: the key and whether Shift is held. */
export const KEY_OF: Record<string, readonly [number, boolean]> = (() => {
  // prettier-ignore
  const rows: Array<[string, string, number]> = [
    ['1', '!', 2], ['2', '@', 3], ['3', '#', 4], ['4', '$', 5], ['5', '%', 6],
    ['6', '^', 7], ['7', '&', 8], ['8', '*', 9], ['9', '(', 10], ['0', ')', 11],
    ['-', '_', 12], ['=', '+', 13], ['[', '{', 26], [']', '}', 27], [';', ':', 39],
    ["'", '"', 40], ['`', '~', 41], ['\\', '|', 43], [',', '<', 51], ['.', '>', 52],
    ['/', '?', 53],
  ];
  const map: Record<string, readonly [number, boolean]> = {};
  for (const [plain, shifted, code] of rows) {
    map[plain] = [code, false];
    map[shifted] = [code, true];
  }
  const letters = 'qwertyuiop' + 'asdfghjkl' + 'zxcvbnm';
  // prettier-ignore
  const codes = [
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 31, 32, 33, 34, 35, 36, 37, 38, 44, 45, 46, 47,
    48, 49, 50,
  ];
  [...letters].forEach((ch, i) => {
    map[ch] = [codes[i]!, false];
    map[ch.toUpperCase()] = [codes[i]!, true];
  });
  return map;
})();

/**
 * The records the kernel writes for `text` typed by the cradle and then its
 * Enter suffix: per key a scan code, a press, a report, a scan code, a
 * release, a report — with Shift pressed around a capital or a symbol.
 */
export function typed(
  text: string,
  opts: { startMs?: number; perKeyMs?: number; enter?: boolean } = {},
): Buffer {
  let at = opts.startMs ?? 1_000_000;
  const per = opts.perKeyMs ?? 2;
  const out: Buffer[] = [];
  const ev = (type: number, code: number, value: number): void => {
    out.push(encodeInputEvent({ atMs: at, type, code, value }, 24));
  };
  const key = (code: number, value: number): void => {
    ev(MSC, 4, 0x70000 + code);
    ev(EV_KEY, code, value);
    ev(EV_SYN, SYN_REPORT, 0);
  };
  for (const ch of text) {
    const entry = KEY_OF[ch];
    if (!entry) throw new Error(`no key for ${ch}`);
    const [code, shift] = entry;
    if (shift) key(42, 1);
    key(code, 1);
    key(code, 0);
    if (shift) key(42, 0);
    at += per;
  }
  if (opts.enter ?? true) {
    key(28, 1);
    key(28, 0);
  }
  return Buffer.concat(out);
}

export const PROC_INPUT = [
  'I: Bus=0019 Vendor=0000 Product=0001 Version=0000',
  'N: Name="Power Button"',
  'H: Handlers=kbd event0',
  '',
  'I: Bus=0003 Vendor=05e0 Product=1200 Version=0110',
  'N: Name="Symbol Technologies, Inc, 2008 Symbol Bar Code Scanner"',
  'P: Phys=usb-xhci-hcd.0-1/input0',
  'H: Handlers=sysrq kbd leds event4',
  'B: EV=120013',
  '',
  'I: Bus=0003 Vendor=05e0 Product=1200 Version=0110',
  'N: Name="Symbol Technologies, Inc, 2008 Symbol Bar Code Scanner Consumer Control"',
  'H: Handlers=event5',
  '',
  'I: Bus=0003 Vendor=1a2c Product=4c5e Version=0110',
  'N: Name="USB Keyboard"',
  'H: Handlers=sysrq kbd leds event6',
  '',
  'I: Bus=0003 Vendor=046d Product=c077 Version=0111',
  'N: Name="Logitech USB Optical Mouse"',
  'H: Handlers=mouse0 event7',
  '',
].join('\n');

export interface FakeWorld {
  /** `/proc/bus/input/devices`; null when it cannot be read. */
  inputs: string | null;
  /** `ttyACMn` → its USB device's ids. */
  ttys: Record<string, { vendor: string; product: string }>;
  /** Device nodes that exist. */
  nodes: Set<string>;
  /** Nodes that exist but this user may not open. */
  denied: Set<string>;
}

export class FakeChannel implements ScannerChannel {
  readonly path: string;
  closed = false;
  private onData: ((chunk: Uint8Array) => void) | null = null;
  private onEnd: ((err: Error | null) => void) | null = null;

  constructor(path: string) {
    this.path = path;
  }

  start(onData: (chunk: Uint8Array) => void, onEnd: (err: Error | null) => void): void {
    this.onData = onData;
    this.onEnd = onEnd;
  }

  close(): void {
    this.closed = true;
  }

  send(bytes: Uint8Array | string): void {
    this.onData?.(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
  }

  unplug(): void {
    const err = Object.assign(new Error('no such device'), { code: 'ENODEV' });
    this.onEnd?.(err);
  }
}

export function fakeIo(world: FakeWorld): { io: ScannerIo; channels: FakeChannel[] } {
  const channels: FakeChannel[] = [];
  const enoent = (path: string): Error =>
    Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
  const io: ScannerIo = {
    async readText(path) {
      if (path === INPUT_DEVICE_LIST) {
        if (world.inputs === null) throw enoent(path);
        return world.inputs;
      }
      const match = /^\/sys\/devices\/usb\/(ttyACM\d+)\/(idVendor|idProduct)$/.exec(path);
      const tty = match ? world.ttys[match[1]!] : undefined;
      if (!match || !tty) throw enoent(path);
      return `${match[2] === 'idVendor' ? tty.vendor : tty.product}\n`;
    },
    async list(dir) {
      if (dir !== TTY_CLASS_DIR) throw enoent(dir);
      return ['ttyAMA0', 'ttyS0', ...Object.keys(world.ttys), 'tty1'];
    },
    async resolve(path) {
      const link = /^\/sys\/class\/tty\/(ttyACM\d+)\/device$/.exec(path);
      if (link && world.ttys[link[1]!]) return `/sys/devices/usb/${link[1]}/${link[1]}:1.0`;
      if (world.nodes.has(path) || world.denied.has(path)) return path;
      throw enoent(path);
    },
    async open(path) {
      if (world.denied.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      if (!world.nodes.has(path)) throw enoent(path);
      const channel = new FakeChannel(path);
      channels.push(channel);
      return channel;
    },
  };
  return { io, channels };
}

export async function until(what: string, check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
