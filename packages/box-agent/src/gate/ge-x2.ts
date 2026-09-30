/**
 * The GE-X2 serial protocol, as bytes (S2-12 round 2).
 *
 * The gate's HX-X1 control board speaks three frame families on one RS232 /
 * RS485 line, 19200 N81 by default (GE-X2 protocol header; HX-X1 §6.1.1 L-31):
 *
 *   - `7E`-framed board frames — the §1 open / close commands and their
 *     acknowledgements, the §1 machine-number read, and the §2 passage
 *     feedback the board pushes on its own (HX-X1 L-34 = 1, the default);
 *   - Modbus-style status frames — the §3.2 door-state and §3.3 infrared-state
 *     queries, answered `addr 03 02 00 0n` plus two trailing bytes;
 *   - menu frames `55 01|02 nn X1 X2 X3 AA 55` — the §4 L menu and §5 D menu.
 *
 * Everything here is a pure function over bytes. What is sent and when lives
 * in `link.ts` and `controller.ts`.
 *
 * THREE FACTS OF THE WIRE THIS FILE IS SHAPED BY:
 *
 *  1. **The checksum of a `7E` frame can itself contain `7E`** (the §1 close
 *     acknowledgement's checksum ends in it). A `7E` is therefore not a
 *     delimiter that can be split on: a frame's length is known from its
 *     command byte, and the scanner reads exactly that many bytes.
 *  2. **The board may double the leading `7E`** (§2: "if a reply starts with
 *     two 7E bytes, ignore the first"). A `7E 7E` at a frame start drops one.
 *  3. **The checksum of a sent command is CRC-16/XMODEM** (poly 0x1021, init 0,
 *     no reflection) over every byte after the leading `7E` up to the last
 *     data byte, high byte first — it reproduces the §1 worked examples. §1
 *     also allows the fixed bytes `95 FC` in its place; `crc: 'fixed'` sends
 *     those. Received checksums are NOT verified: §2 says they need not be,
 *     and the §2 examples carry them in either byte order.
 *
 * NEVER A WRITE. The builders below produce the §1 open and close commands
 * (which are what the gate is for), the §1 machine read, the §3 status
 * queries and the §4 READS. No setting is ever written from the box: the
 * installer sets the board at its keypad, and the box reads what it needs to
 * know (HX-X1 §6.1.1) and says when it differs from the station's config.
 */

// --- Sides and constants ----------------------------------------------------

export type GateSide = 'left' | 'right';

export const GE_X2_FRAME_START = 0x7e;
/** Byte 2 of every `7E` frame in the document. */
export const GE_X2_FRAME_KIND = 0x80;
/** Byte 8: a command from the host carries `AA`, a frame from the board `00`. */
export const GE_X2_FLAG_HOST = 0xaa;
export const GE_X2_FLAG_BOARD = 0x00;
/** §1: "the fixed bytes 95 FC can be sent instead" of a computed checksum. */
export const GE_X2_FIXED_CRC = [0x95, 0xfc] as const;

/** The GE-X2 line defaults (protocol header; HX-X1 L-30 default 1, L-31 default 1 = 19200). */
export const GE_X2_DEFAULT_BAUD = 19200;
export const GE_X2_DEFAULT_MACHINE_ID = 1;
/** HX-X1 L-31 values, index = setting value. */
export const GE_X2_BAUD_RATES = [9600, 19200, 38400, 57600, 115200] as const;

const SIDE_BYTE: Record<GateSide, number> = { left: 0x01, right: 0x02 };

/** §1 command bytes (byte 7 of a host frame). */
const CMD_READ_MACHINE = 0x01;
const CMD_OPEN = 0x80;
const CMD_CLOSE = 0x81;

/** Header length of a `7E` frame: `7E 80 00 id 00 00 cmd flag 00 01`. */
const HEADER_LENGTH = 10;

export function isValidMachineId(id: number): boolean {
  return Number.isInteger(id) && id >= 1 && id <= 255;
}

// --- Checksums --------------------------------------------------------------

/** CRC-16/XMODEM — the checksum of a `7E` command (see the file header, fact 3). */
export function crc16Xmodem(bytes: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= (bytes[i]! & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** The standard Modbus RTU CRC — the checksum on the §3 status queries, low byte first. */
export function crc16Modbus(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]! & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

// --- §1 commands ------------------------------------------------------------

export type GeX2Command =
  /** §1 "read machine number"; machine 0 is the broadcast form. */
  | { op: 'read_machine'; machineId: number }
  /** §1 "open gate", single pass, or `hold` = stay open (normally open). */
  | { op: 'open'; machineId: number; side: GateSide; hold?: boolean }
  /** §1 "close gate" — ends a `hold`. */
  | { op: 'close'; machineId: number; side: GateSide };

export interface BuildOptions {
  /** `computed` (default) sends the real checksum; `fixed` sends §1's `95 FC`. */
  crc?: 'computed' | 'fixed';
}

/** Build a §1 command frame. Throws on a machine id the board cannot hold (L-30: 1–255). */
export function buildCommand(command: GeX2Command, options: BuildOptions = {}): Uint8Array {
  const broadcast = command.op === 'read_machine' && command.machineId === 0;
  if (!broadcast && !isValidMachineId(command.machineId)) {
    throw new RangeError(`GE-X2 machine id must be 1-255 (HX-X1 L-30), got ${command.machineId}`);
  }
  let cmd: number;
  let data: number[];
  switch (command.op) {
    case 'read_machine':
      cmd = CMD_READ_MACHINE;
      data = [];
      break;
    case 'open':
      cmd = CMD_OPEN;
      data = [SIDE_BYTE[command.side], command.hold ? 0x01 : 0x00];
      break;
    case 'close':
      cmd = CMD_CLOSE;
      data = [SIDE_BYTE[command.side]];
      break;
  }
  const body = [
    GE_X2_FRAME_KIND,
    0x00,
    command.machineId & 0xff,
    0x00,
    0x00,
    cmd,
    GE_X2_FLAG_HOST,
    0x00,
    0x01,
    ...data,
  ];
  const crc =
    options.crc === 'fixed'
      ? [...GE_X2_FIXED_CRC]
      : (() => {
          const value = crc16Xmodem(body);
          return [value >> 8, value & 0xff];
        })();
  return Uint8Array.from([GE_X2_FRAME_START, ...body, ...crc, GE_X2_FRAME_START]);
}

// --- §3 status queries --------------------------------------------------------

/** §3.2 door state (register 0x12) and §3.3 infrared state (register 0x21). */
export type StatusQuery = 'door' | 'infrared';

const STATUS_REGISTER: Record<StatusQuery, number> = { door: 0x12, infrared: 0x21 };

/**
 * A §3 status query: `addr 03 00 reg 00 01` and the Modbus checksum.
 *
 * The document addresses these at 01 and calls them Modbus-style; the address
 * is taken as the machine id, which is 01 at the factory setting (an inference
 * — confirm on site where two boards share a line).
 */
export function buildStatusQuery(query: StatusQuery, address: number): Uint8Array {
  if (!isValidMachineId(address)) {
    throw new RangeError(`GE-X2 status address must be 1-255, got ${address}`);
  }
  const body = [address, 0x03, 0x00, STATUS_REGISTER[query], 0x00, 0x01];
  const crc = crc16Modbus(body);
  return Uint8Array.from([...body, crc & 0xff, crc >> 8]);
}

/** §3.2 door states, by the value the board answers. */
export const DOOR_STATES = [
  'closed',
  'open_a',
  'open_b',
  'opening_a',
  'opening_b',
  'closing_a',
  'closing_b',
  'initialising',
  'pushed',
  'zero_search',
] as const;
export type DoorState = (typeof DOOR_STATES)[number] | 'unknown';

/** §3.3 infrared states, by the value the board answers. */
export const INFRARED_STATES = [
  'clear',
  'first_point',
  'second_point',
  'third_point',
  'reverse',
  'tailgating',
  'timeout_closing',
  'intrusion',
  'passed_standby',
] as const;
export type InfraredState = (typeof INFRARED_STATES)[number] | 'unknown';

export function doorStateOf(value: number): DoorState {
  return DOOR_STATES[value] ?? 'unknown';
}

export function infraredStateOf(value: number): InfraredState {
  return INFRARED_STATES[value] ?? 'unknown';
}

/** Door open in position or moving, which is what "held open" is read from. */
export function isDoorOpen(state: DoorState): boolean {
  return state === 'open_a' || state === 'open_b' || state === 'opening_a' || state === 'opening_b';
}

// --- §4 menu reads ------------------------------------------------------------

/**
 * The settings the box reads at startup (HX-X1 §6.1.1), by L-menu number.
 * The menu byte of L-n is n (§4: L-10 is `0A`, L-19 is `13`).
 */
export const WATCHED_SETTINGS = {
  /** L-1, seconds. */
  openDurationS: 1,
  /** L-2: 0 card both sides, 1 IR left / card right, 2 IR right / card left, 3 IR both. */
  workingMode: 2,
  /** L-3, tenths of a second (HX-X1: "0.2 s (value 2)"). */
  closeDelayDs: 3,
  /** L-9: 0 no memory, 1 memory, 2 reverse-passage memory. */
  entryExitMemory: 9,
  /** L-21: 0 off, 1 on. */
  tailgatingDetection: 21,
  /** L-22: 0 alarm only, 1 alarm then close, 2 close immediately. */
  closeOnTailgating: 22,
  /** L-34: 0 reply only when polled, 1 push on change, 2-999 push and repeat every n. */
  uploadMode: 34,
} as const;
export type WatchedSetting = keyof typeof WATCHED_SETTINGS;
export const WATCHED_SETTING_KEYS = Object.keys(WATCHED_SETTINGS) as WatchedSetting[];

/**
 * HX-X1 §6.1.1 factory values. L-1 is 5 there and 6 in GE-X2 §4 — the
 * documents disagree, which is exactly why the box reads it rather than
 * assuming either.
 */
export const HX_X1_FACTORY: Record<WatchedSetting, number> = {
  openDurationS: 5,
  workingMode: 0,
  closeDelayDs: 2,
  entryExitMemory: 0,
  tailgatingDetection: 0,
  closeOnTailgating: 0,
  uploadMode: 1,
};

/** Menu frame length: `55 menu nn X1 X2 X3 AA 55`. */
const MENU_LENGTH = 8;

/** §4: read an L-menu parameter — `55 01 nn 00 00 01 AA 55`. */
export function buildSettingRead(number: number): Uint8Array {
  if (!Number.isInteger(number) || number < 1 || number > 0xfc) {
    throw new RangeError(`L-menu number out of range: ${number}`);
  }
  return Uint8Array.from([0x55, 0x01, number, 0x00, 0x00, 0x01, 0xaa, 0x55]);
}

/** §4 "Query supply voltage" — `55 01 FF 00 00 00 AA 55`, answered in mV. */
export function buildSupplyVoltageRead(): Uint8Array {
  return Uint8Array.from([0x55, 0x01, 0xff, 0x00, 0x00, 0x00, 0xaa, 0x55]);
}

/** §4 "Get infrared state" — the six pairs as a bit mask. */
export function buildInfraredPairsRead(): Uint8Array {
  return Uint8Array.from([0x55, 0x01, 0xfd, 0x00, 0x00, 0x01, 0xaa, 0x55]);
}

// --- §2 passage feedback --------------------------------------------------------

export type FeedbackKind =
  /** `61` / `62` */
  | 'passed'
  /** `63` / `64` — nobody passed. */
  | 'timeout'
  /** `73` / `74` — timed out with a person still in the lane. */
  | 'timeout_in_lane'
  /** `83` / `84` */
  | 'reverse'
  /** `93` / `94` */
  | 'tailgating';

export type GateFeedback =
  | { kind: FeedbackKind; side: GateSide }
  /** `95` — a beam blocked while the gate is at rest. No side. */
  | { kind: 'ir_blocked_standby' };

const FEEDBACK_BY_CODE: Record<number, GateFeedback> = {
  0x61: { kind: 'passed', side: 'left' },
  0x62: { kind: 'passed', side: 'right' },
  0x63: { kind: 'timeout', side: 'left' },
  0x64: { kind: 'timeout', side: 'right' },
  0x73: { kind: 'timeout_in_lane', side: 'left' },
  0x74: { kind: 'timeout_in_lane', side: 'right' },
  0x83: { kind: 'reverse', side: 'left' },
  0x84: { kind: 'reverse', side: 'right' },
  0x93: { kind: 'tailgating', side: 'left' },
  0x94: { kind: 'tailgating', side: 'right' },
  0x95: { kind: 'ir_blocked_standby' },
};

/** The byte-7 code of a feedback — for building test streams and for the log. */
export function feedbackCode(feedback: GateFeedback): number {
  for (const [code, value] of Object.entries(FEEDBACK_BY_CODE)) {
    if (value.kind !== feedback.kind) continue;
    if ('side' in value && 'side' in feedback && value.side !== feedback.side) continue;
    return Number(code);
  }
  throw new Error(`no GE-X2 code for ${JSON.stringify(feedback)}`);
}

/**
 * A board frame as the board would send it — `7E 80 00 id 00 00 code 00 00 01
 * [data] crc crc 7E`, the checksum computed as for a command. For tests and
 * for nothing else: the box never sends a board frame.
 */
export function encodeBoardFrame(
  machineId: number,
  code: number,
  data: readonly number[] = [],
): Uint8Array {
  const body = [
    GE_X2_FRAME_KIND,
    0x00,
    machineId & 0xff,
    0x00,
    0x00,
    code,
    GE_X2_FLAG_BOARD,
    0x00,
    0x01,
    ...data,
  ];
  const crc = crc16Xmodem(body);
  return Uint8Array.from([GE_X2_FRAME_START, ...body, crc >> 8, crc & 0xff, GE_X2_FRAME_START]);
}

// --- Parsing ------------------------------------------------------------------

export type GeX2Frame =
  /** §1 read-machine reply: byte 4 is the answering machine. */
  | { type: 'machine'; machineId: number }
  /** §1 acknowledgement of an open (`80`) or a close (`81`). */
  | { type: 'ack'; machineId: number; command: 'open' | 'close' }
  /** §2, pushed by the board. */
  | { type: 'feedback'; machineId: number; feedback: GateFeedback }
  /** A host command heard back — an RS485 adapter that echoes what it sends. */
  | { type: 'echo'; machineId: number; command: number }
  /** A well-framed board frame with a code the documents do not list. */
  | { type: 'board_unknown'; machineId: number; code: number }
  /** §3 answer — door or infrared, which the caller knows from what it asked. */
  | { type: 'status'; address: number; value: number }
  /** §4 / §5 answer. `value` is X1 high, X2 low. */
  | {
      type: 'setting';
      menu: 'L' | 'D';
      number: number;
      value: number;
      /** X3 in a reply: 00 succeeded, 01 a read was sent, 02 failed (§4). */
      status: 'ok' | 'read' | 'failed' | 'other';
    };

/** How many data bytes a `7E` frame carries, from its command byte and direction. */
function dataLength(code: number, flag: number): number | null {
  if (flag === GE_X2_FLAG_HOST) {
    if (code === CMD_READ_MACHINE) return 0;
    if (code === CMD_OPEN) return 2;
    if (code === CMD_CLOSE) return 1;
    return null;
  }
  if (code === CMD_READ_MACHINE) return 2;
  return 0;
}

function parseBoardFrame(frame: Uint8Array): GeX2Frame {
  const machineId = frame[3]!;
  const code = frame[6]!;
  const flag = frame[7]!;
  if (flag === GE_X2_FLAG_HOST) return { type: 'echo', machineId, command: code };
  if (code === CMD_READ_MACHINE) return { type: 'machine', machineId };
  if (code === CMD_OPEN) return { type: 'ack', machineId, command: 'open' };
  if (code === CMD_CLOSE) return { type: 'ack', machineId, command: 'close' };
  const feedback = FEEDBACK_BY_CODE[code];
  if (feedback) return { type: 'feedback', machineId, feedback };
  return { type: 'board_unknown', machineId, code };
}

function settingStatus(x3: number): 'ok' | 'read' | 'failed' | 'other' {
  if (x3 === 0x00) return 'ok';
  if (x3 === 0x01) return 'read';
  if (x3 === 0x02) return 'failed';
  return 'other';
}

export interface FrameScanner {
  /** Feed bytes as they arrive; returns every whole frame now readable. */
  push(bytes: Uint8Array): GeX2Frame[];
  /** Bytes buffered towards a frame not yet whole. */
  pending(): number;
  /** Forget a partial frame (the link calls this after a silence). */
  clear(): void;
  /** Bytes thrown away while resynchronising. Evidence of a noisy line. */
  discarded(): number;
}

/**
 * The receiving half: a byte stream in, frames out, resynchronising past
 * anything it cannot read. `statusAddress` is the address §3 answers carry
 * (the machine id, see `buildStatusQuery`).
 */
export function createFrameScanner(options: { statusAddress: number }): FrameScanner {
  let buffer: number[] = [];
  let dropped = 0;

  function drop(n = 1): void {
    buffer = buffer.slice(n);
    dropped += n;
  }

  function scan(): GeX2Frame[] {
    const frames: GeX2Frame[] = [];
    for (;;) {
      if (buffer.length === 0) return frames;
      const first = buffer[0]!;
      if (first === GE_X2_FRAME_START) {
        // A doubled leading 7E (§2), or the tail of the previous frame.
        if (buffer.length >= 2 && buffer[1] === GE_X2_FRAME_START) {
          buffer = buffer.slice(1);
          continue;
        }
        if (buffer.length < HEADER_LENGTH) return frames;
        if (buffer[1] !== GE_X2_FRAME_KIND) {
          drop();
          continue;
        }
        const extra = dataLength(buffer[6]!, buffer[7]!);
        if (extra === null) {
          drop();
          continue;
        }
        const length = HEADER_LENGTH + extra + 3;
        if (buffer.length < length) return frames;
        if (buffer[length - 1] !== GE_X2_FRAME_START) {
          drop();
          continue;
        }
        const frame = Uint8Array.from(buffer.slice(0, length));
        buffer = buffer.slice(length);
        frames.push(parseBoardFrame(frame));
        continue;
      }
      if (first === 0x55) {
        if (buffer.length < MENU_LENGTH) {
          // Only wait if what is here could still become a menu frame.
          if (buffer.length >= 2 && buffer[1] !== 0x01 && buffer[1] !== 0x02) drop();
          else return frames;
          continue;
        }
        const ok =
          (buffer[1] === 0x01 || buffer[1] === 0x02) && buffer[6] === 0xaa && buffer[7] === 0x55;
        if (!ok) {
          drop();
          continue;
        }
        frames.push({
          type: 'setting',
          menu: buffer[1] === 0x01 ? 'L' : 'D',
          number: buffer[2]!,
          value: (buffer[3]! << 8) | buffer[4]!,
          status: settingStatus(buffer[5]!),
        });
        buffer = buffer.slice(MENU_LENGTH);
        continue;
      }
      if (first === options.statusAddress) {
        if (buffer.length < 3) return frames;
        if (buffer[1] !== 0x03 || buffer[2] !== 0x02) {
          drop();
          continue;
        }
        if (buffer.length < 7) return frames;
        frames.push({
          type: 'status',
          address: first,
          value: (buffer[3]! << 8) | buffer[4]!,
        });
        buffer = buffer.slice(7);
        continue;
      }
      drop();
    }
  }

  return {
    push(bytes) {
      for (const b of bytes) buffer.push(b & 0xff);
      return scan();
    },
    pending: () => buffer.length,
    clear() {
      dropped += buffer.length;
      buffer = [];
    },
    discarded: () => dropped,
  };
}

/** Parse one whole buffer — every frame in it, in order. */
export function parseFrames(bytes: Uint8Array, statusAddress: number): GeX2Frame[] {
  return createFrameScanner({ statusAddress }).push(bytes);
}

/** `7E 80 00 01 …` — for a log line. */
export function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes as ArrayLike<number>, (b) =>
    (b & 0xff).toString(16).toUpperCase().padStart(2, '0'),
  ).join(' ');
}
