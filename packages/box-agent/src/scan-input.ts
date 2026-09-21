import type { ScanInput, ScanSource } from './scan';

/**
 * `ScanInput` sources (S2-06): how bytes off a piece of hardware become one
 * scan.
 *
 * Three ways in, one shape out. Each is a small state machine with no I/O in
 * it, which is the point: the part that is hard to get right — telling a
 * scanner from a person, telling a record's end from a pause — is the part a
 * test can drive character by character, and the part that opens a device file
 * is six lines around it.
 *
 * The device facts here are from DEVICE_INVENTORY §9.2, which is the Zebra
 * DS2278 Product Reference Guide and one measured write-up. They are not
 * guesses and they are not settings we chose: the Enter is parameter #235 with
 * Suffix 1 = 7013, the keystroke delay is 0 / 20 / 40 ms, and in plain USB CDC
 * mode there is by default no terminator on the wire at all.
 */

// --- The HID keyboard wedge -------------------------------------------------

/**
 * How a wedge scan is told from a person typing.
 *
 * A keyboard-wedge scanner is a keyboard. It types the code into whatever has
 * focus, as fast as the host will take it, and then types the suffix it was
 * programmed with — an Enter, by default. Nothing in the key events says
 * "scanner", so four rules together say it:
 *
 *  1. **Pace.** The characters of one scan arrive with gaps under
 *     `burstGapMs`. The scanner's own keystroke delay is 0, 20 or 40 ms per
 *     character, so 50 ms covers the slowest setting with room; a person
 *     typing a twelve-character code does not hold under 50 ms between every
 *     pair of keys. A longer gap ends the burst that was open.
 *  2. **Terminator.** A burst is committed by the suffix key, `Enter` by
 *     default. This is the rule that makes the whole thing crisp, and it is
 *     also the rule that is CONFIGURATION on the scanner rather than a
 *     property of it: a unit set back to "Data As Is" sends no suffix, and
 *     then only rule 3 finishes a scan.
 *  3. **Quiet gap.** A burst that stops arriving and never gets its
 *     terminator is closed after `burstTimeoutMs` (500 ms — the CDC
 *     observation, reused here because it is the same question). What happens
 *     to it is rule 4.
 *  4. **Length.** A committed burst shorter than `minLength` is DISCARDED, and
 *     so is one closed by the quiet gap with no terminator — it is reported as
 *     `partial` and nothing is delivered.
 *
 * **Why a partial burst is discarded rather than delivered.** Half a band code
 * is not a shorter band code: it resolves to nothing, or — the expensive case —
 * to something else. The person scans again, which costs a second; delivering
 * the fragment costs whatever the fragment happened to match. The fragment is
 * reported to the caller so the Box log drawer can show "a partial scan was
 * dropped", which is what turns "the scanner is broken" into "the scanner's
 * suffix is not set".
 *
 * **What happens when a scan arrives while a text field has focus.** On the
 * BOX — the arrangement DEVICE_INVENTORY D2 resolves to — nothing does,
 * because there is no focus: the agent reads the device node with an exclusive
 * evdev grab (`EVIOCGRAB`), so the keystrokes never reach a console, a browser
 * or a form. On the iPad fallback path, where a paired scanner really is
 * typing into a page, this same state machine runs on the page's `keydown`
 * events: the keys of a recognised burst are swallowed and the terminator's
 * default action is prevented, so the code does not land in the search box and
 * the form does not submit. A slow-typed sequence never becomes a burst, so an
 * ordinary person typing into the field is left alone. That is the whole
 * reason the machine is here rather than inside the evdev loop.
 */
export interface HidBurstOptions {
  /** Gap above which a burst ends, in milliseconds. */
  burstGapMs?: number;
  /** A burst with no terminator is closed after this and discarded. */
  burstTimeoutMs?: number;
  /** Shorter than this and a committed burst is discarded. */
  minLength?: number;
  maxLength?: number;
  /** The suffix key the scanner is programmed with. */
  terminatorKey?: string;
  /**
   * The physical button beside the counter, as a key name.
   *
   * **Never Enter**, and the constructor refuses it: Enter is the scanner's
   * suffix, so a button that sent Enter would be indistinguishable from the
   * end of a scan — and, on the iPad path, would submit whatever form has
   * focus. `buttonKeyProblem` below is the check, exported so the settings
   * form can refuse it before it is ever saved.
   */
  buttonKey?: string | null;
  source?: ScanSource;
}

export interface HidKeyEvent {
  /** A DOM-style key name: `a`, `7`, `Enter`, `F9`. */
  key: string;
  /** Milliseconds on any monotonic clock. The reader only takes differences. */
  at: number;
}

export type HidBurstEvent =
  | { kind: 'scan'; input: ScanInput; length: number }
  | { kind: 'button'; key: string; at: number }
  /** A burst that never got its terminator, or was too short to be a code. */
  | { kind: 'partial'; length: number; reason: 'timeout' | 'too_short'; at: number };

/** Why a key may not be used as the counter button. Null when it may. */
export function buttonKeyProblem(key: string): string | null {
  if (!key) return 'The button needs a key.';
  if (key === 'Enter' || key === 'NumpadEnter' || key === '\r' || key === '\n') {
    return 'Enter is the scanner’s suffix — a button sending Enter cannot be told from the end of a scan, and it submits whatever is on screen. Pick another key.';
  }
  if (key.length === 1) {
    return 'A printable key would be typed into a code mid-scan. Pick a function key or a modifier combination.';
  }
  return null;
}

const PRINTABLE = /^[\x20-\x7e]$/;

/**
 * The wedge state machine. Feed it key events; it emits scans, button presses
 * and dropped partials.
 *
 * It holds no timer of its own: `tick(now)` is what closes an abandoned burst,
 * and the caller — an evdev loop, a browser's `setInterval`, a test — decides
 * when that happens. A machine that started its own timers could not be driven
 * deterministically by a test, and the timing rules are the whole content.
 */
export class HidBurstReader {
  private readonly gapMs: number;
  private readonly timeoutMs: number;
  private readonly minLength: number;
  private readonly maxLength: number;
  private readonly terminator: string;
  private readonly button: string | null;
  private readonly source: ScanSource;

  private buffer = '';
  private lastAt = 0;

  constructor(options: HidBurstOptions = {}) {
    this.gapMs = options.burstGapMs ?? 50;
    this.timeoutMs = options.burstTimeoutMs ?? 500;
    this.minLength = options.minLength ?? 6;
    this.maxLength = options.maxLength ?? 128;
    this.terminator = options.terminatorKey ?? 'Enter';
    const button = options.buttonKey ?? null;
    if (button) {
      const problem = buttonKeyProblem(button);
      if (problem) throw new Error(problem);
    }
    this.button = button;
    this.source = options.source ?? 'box_hid';
  }

  /** True while characters of a possible scan are buffered. */
  get open(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * One key. Returns what it completed, or null.
   *
   * On the iPad path the caller swallows the key event whenever this returns
   * anything OR `open` is true afterwards — that is the whole of "the scan
   * does not land in the search box".
   */
  push(event: HidKeyEvent): HidBurstEvent | null {
    const { key, at } = event;
    let dropped: HidBurstEvent | null = null;

    // Rule 1: a slow key ends whatever burst was open before it is considered
    // on its own terms. The character that arrived late starts a new burst.
    if (this.buffer.length > 0 && at - this.lastAt > this.gapMs) {
      dropped = this.close('timeout', at);
    }

    if (key === this.terminator) {
      this.lastAt = at;
      const committed = this.commit(at);
      return committed ?? dropped;
    }

    if (this.button && key === this.button) {
      // A button press is only a press when nothing is mid-flight. Inside an
      // open burst — which is 50 ms wide, so this is a physical near
      // impossibility — the scan wins, because losing a scan is the expensive
      // half of the choice.
      if (this.buffer.length === 0) return { kind: 'button', key, at };
      return dropped;
    }

    if (!PRINTABLE.test(key)) {
      // Shift, arrow keys, anything else a keyboard sends and a scanner does
      // not. Ignored rather than treated as the end of a burst: on the iPad
      // path a stray modifier must not cost a scan.
      return dropped;
    }

    if (this.buffer.length >= this.maxLength) {
      // Longer than any code we print. Something is holding a key down.
      const over = this.close('too_short', at);
      this.lastAt = at;
      return over ?? dropped;
    }

    this.buffer += key;
    this.lastAt = at;
    return dropped;
  }

  /**
   * Close an abandoned burst. Called on a timer by whoever owns the clock —
   * this is rule 3, and without it a scanner with no suffix would hold its
   * last code for ever.
   */
  tick(now: number): HidBurstEvent | null {
    if (this.buffer.length === 0) return null;
    if (now - this.lastAt < this.timeoutMs) return null;
    return this.close('timeout', now);
  }

  /** Throw away whatever is buffered — a screen losing focus, a device reset. */
  reset(): void {
    this.buffer = '';
  }

  private commit(at: number): HidBurstEvent | null {
    const code = this.buffer;
    this.buffer = '';
    if (code.length === 0) {
      // A bare Enter with nothing in front of it. On the iPad path this is a
      // person submitting a form, and it must pass through untouched.
      return null;
    }
    if (code.length < this.minLength) {
      return { kind: 'partial', length: code.length, reason: 'too_short', at };
    }
    return {
      kind: 'scan',
      length: code.length,
      input: { code, source: this.source, scannedAt: new Date(at).toISOString() },
    };
  }

  private close(reason: 'timeout' | 'too_short', at: number): HidBurstEvent | null {
    const length = this.buffer.length;
    this.buffer = '';
    if (length === 0) return null;
    return { kind: 'partial', length, reason, at };
  }
}

// --- USB CDC serial ---------------------------------------------------------

/**
 * The DS2278 in USB CDC Host mode (`05E0:1701`, `/dev/ttyACM*`), which is what
 * DEVICE_INVENTORY §9.2 recommends putting on the box: clean byte records, a
 * stable `/dev/serial/by-id/…` name, one bar code to set.
 *
 * The wire has no length field and no header, and — measured on a unit of the
 * same firmware family — **no terminator at all** unless a suffix is
 * programmed. So a record ends at `\r`, `\n`, `\r\n`, or at half a second of
 * silence, and the reader accepts all four rather than betting on how the
 * park's unit is configured. Bytes are decoded as ASCII/UTF-8; a scanner set
 * to transmit its Symbol code ID prefixes `]C0` (Code 128) or `]Q1` (QR),
 * which `stripCodeId` removes so a handler never has to know.
 */
export interface SerialScanOptions {
  quietGapMs?: number;
  minLength?: number;
  maxLength?: number;
  /** Strip a leading Symbol code ID (`]C0`, `]Q1`, …) when the scanner sends one. */
  stripCodeId?: boolean;
  source?: ScanSource;
}

export class SerialScanReader {
  private readonly quietGapMs: number;
  private readonly minLength: number;
  private readonly maxLength: number;
  private readonly strip: boolean;
  private readonly source: ScanSource;
  private buffer = '';
  private lastAt = 0;

  constructor(options: SerialScanOptions = {}) {
    this.quietGapMs = options.quietGapMs ?? 500;
    this.minLength = options.minLength ?? 1;
    this.maxLength = options.maxLength ?? 4096;
    this.strip = options.stripCodeId ?? true;
    this.source = options.source ?? 'box_serial';
  }

  /** Feed a chunk off the device. Returns every complete record it finished. */
  push(chunk: string | Uint8Array, at: number): ScanInput[] {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.lastAt = at;
    this.buffer += text;
    const out: ScanInput[] = [];
    // Split on any of the three delimiters; the last piece stays buffered
    // because there is no telling whether it is complete.
    const parts = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = parts.pop() ?? '';
    for (const part of parts) {
      const record = this.finish(part, at);
      if (record) out.push(record);
    }
    if (this.buffer.length > this.maxLength) {
      // A device streaming without a delimiter. Drop rather than grow.
      this.buffer = '';
    }
    return out;
  }

  /** The quiet-gap rule: no delimiter, but nothing has arrived for half a second. */
  tick(now: number): ScanInput | null {
    if (this.buffer.length === 0) return null;
    if (now - this.lastAt < this.quietGapMs) return null;
    const pending = this.buffer;
    this.buffer = '';
    return this.finish(pending, now);
  }

  reset(): void {
    this.buffer = '';
  }

  private finish(raw: string, at: number): ScanInput | null {
    const code = this.strip ? stripCodeId(raw) : raw;
    if (code.length < this.minLength) return null;
    return { code, source: this.source, scannedAt: new Date(at).toISOString() };
  }
}

/** `]C0123…` → `123…`. A Symbol code ID is three characters, `]` then two. */
export function stripCodeId(raw: string): string {
  return /^\][A-Za-z][0-9A-Za-z]/.test(raw) ? raw.slice(3) : raw;
}

// --- The simulator ----------------------------------------------------------

/**
 * A scanner that is not there (S2-06).
 *
 * It is not a second implementation of the readers above — it DRIVES them,
 * which is the whole value: the Console types a code, the simulator turns it
 * into the key events or the byte record a DS2278 would produce, and the same
 * state machine that will read the real device decides what that was. A
 * simulator that called `deliver()` directly would prove the service works and
 * nothing about the rule that has to be right.
 *
 * `interCharDelayMs` reproduces the keystroke delay setting (0 / 20 / 40 ms);
 * `withSuffix: false` reproduces a unit set back to "Data As Is", where only
 * the quiet gap finishes a record.
 */
export interface SimulatedScanOptions {
  mode?: 'hid' | 'serial';
  /** 0, 20 or 40 on the real device. Anything above the burst gap is a person. */
  interCharDelayMs?: number;
  withSuffix?: boolean;
  /** `]C0` for Code 128, `]Q1` for QR, when "Transmit Code ID" is on. */
  codeId?: string | null;
  startAt?: number;
}

/** The key events a wedge scanner would produce for one code. */
export function simulateHidKeys(code: string, options: SimulatedScanOptions = {}): HidKeyEvent[] {
  const delay = options.interCharDelayMs ?? 0;
  let at = options.startAt ?? 0;
  const keys: HidKeyEvent[] = [];
  for (const ch of code) {
    keys.push({ key: ch, at });
    at += delay;
  }
  if (options.withSuffix ?? true) keys.push({ key: 'Enter', at });
  return keys;
}

/** The bytes a CDC scanner would produce for one code. */
export function simulateSerialRecord(code: string, options: SimulatedScanOptions = {}): string {
  const prefix = options.codeId ?? '';
  return `${prefix}${code}${(options.withSuffix ?? true) ? '\r' : ''}`;
}
