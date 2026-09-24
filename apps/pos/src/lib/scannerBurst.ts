import { useEffect, useRef } from 'react';

/**
 * S2-10b (SCRUM-207) — A USB SCANNER PLUGGED INTO THE COMPUTER RUNNING THE TILL.
 *
 * The park's Zebra scanner is a keyboard as far as the computer is concerned:
 * it types the code it read, as fast as the host takes it, and then Enter
 * (DEVICE_INVENTORY §2 row 1: USB HID keyboard, Suffix 1 = 7013 "Enter"). On
 * the box it is read with an exclusive grab and reaches the till through the
 * station channel; plugged straight into a laptop — the owner's bench, and any
 * counter without a box — its keystrokes land on the page. This file tells
 * those keystrokes from a person typing and hands the till the code.
 *
 * THE RULE is the box's own (`HidBurstReader`, packages/box-agent/src/
 * scan-input.ts), with the same numbers, because it is the same scanner:
 *
 *  1. PACE. The characters of one scan arrive less than `gapMs` (50 ms) apart —
 *     the scanner's keystroke delay is 0, 20 or 40 ms. A longer gap ends the
 *     burst that was open, and the late key starts a new one. A person does not
 *     type ten characters with every gap under 50 ms.
 *  2. TERMINATOR. Enter, itself within `gapMs` of the last character, commits
 *     the burst. An Enter after a pause is a person pressing Enter.
 *  3. LENGTH. A committed burst shorter than `minLength` is discarded, and so is
 *     one longer than `maxLength` (something leaning on a key).
 *  4. NOT A SHORTCUT. A key pressed with Ctrl, Alt or Meta ends the burst.
 *     Shift and every other key a scanner does not type as a character are
 *     ignored: the scanner holds Shift for a capital letter.
 *
 * WHERE IT LISTENS: only when no field has focus. A field that has focus gets
 * the keys as it always did — the promo box, the Redeem voucher box, a phone
 * number — and the till's own entry decides what they mean there. So a scan can
 * never be split between a field and this listener.
 *
 * The state machine is pure — keys and times in, codes out — so it can be
 * driven key by key; the hook below is the few lines that feed it the page's
 * `keydown` events. `apps/pos` has no unit-test runner: the machine is proved in
 * the browser, by typing a code at scanner speed and at a person's.
 */

export interface BurstKey {
  /** The DOM key name: `B`, `7`, `Enter`, `Shift`. */
  key: string;
  /** Milliseconds on a monotonic clock; only differences are read. */
  at: number;
  /** Ctrl, Alt or Meta held — a shortcut, never a scan. */
  withCommand?: boolean;
}

export interface ScannerBurstOptions {
  gapMs?: number;
  minLength?: number;
  maxLength?: number;
}

/** 0, 20 or 40 ms per character on the scanner, and room above the slowest. */
export const SCANNER_BURST_GAP_MS = 50;
/** A booth code is ten or eleven characters; nothing shorter is worth reading. */
export const SCANNER_BURST_MIN_LENGTH = 6;
export const SCANNER_BURST_MAX_LENGTH = 64;

const PRINTABLE = /^[\x20-\x7e]$/;

export interface ScannerBurst {
  /**
   * One key. Returns the code a committed burst read, or null. `consumed` is
   * true when the key was the Enter that ended a scan — the caller keeps it
   * from doing anything else, such as pressing a button that has focus.
   */
  push(event: BurstKey): { code: string | null; consumed: boolean };
  /** Forget whatever is buffered — focus moved into a field, the page hid. */
  reset(): void;
}

export function createScannerBurst(options: ScannerBurstOptions = {}): ScannerBurst {
  const gapMs = options.gapMs ?? SCANNER_BURST_GAP_MS;
  const minLength = options.minLength ?? SCANNER_BURST_MIN_LENGTH;
  const maxLength = options.maxLength ?? SCANNER_BURST_MAX_LENGTH;
  let buffer = '';
  let lastAt = 0;

  const none = { code: null, consumed: false } as const;

  return {
    push({ key, at, withCommand }) {
      // Rule 1: a slow key ends whatever burst was open before it is read.
      if (buffer.length > 0 && at - lastAt > gapMs) buffer = '';
      // Rule 4: a shortcut is somebody at the keyboard.
      if (withCommand) {
        buffer = '';
        return none;
      }
      if (key === 'Enter') {
        const code = buffer;
        buffer = '';
        // Rule 2 is rule 1 applied to the Enter: a late Enter found the buffer
        // already emptied above. Rule 3 decides the rest.
        if (code.length < minLength) return none;
        lastAt = at;
        return { code, consumed: true };
      }
      if (!PRINTABLE.test(key)) return none;
      if (buffer.length >= maxLength) {
        buffer = '';
        lastAt = at;
        return none;
      }
      buffer += key;
      lastAt = at;
      return none;
    },
    reset() {
      buffer = '';
    },
  };
}

/** Is a field — somewhere the keys are typed into — the thing that has focus? */
function fieldHasFocus(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : document.activeElement;
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Hear a USB scanner typing into this page while no field has focus.
 *
 * `accept` says which codes are this page's — the till takes a voucher code
 * and nothing else, so a bottle's barcode scanned at the ticket counter is
 * left alone rather than looked up as a wrong voucher. An accepted code's
 * Enter is stopped, so it cannot also press the button that happens to have
 * focus; every other key goes on to the page untouched.
 *
 * `onCode` and `accept` are read through refs, so a page may pass fresh
 * closures on every render without the listener being re-attached.
 */
export function useScannerBurst(
  onCode: (code: string) => void,
  options: { enabled?: boolean; accept?: (code: string) => boolean } = {},
): void {
  const handler = useRef(onCode);
  const accept = useRef(options.accept);
  useEffect(() => {
    handler.current = onCode;
    accept.current = options.accept;
  });
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const burst = createScannerBurst();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (fieldHasFocus(event.target)) {
        burst.reset();
        return;
      }
      const { code, consumed } = burst.push({
        key: event.key,
        at: event.timeStamp,
        withCommand: event.ctrlKey || event.altKey || event.metaKey,
      });
      if (!consumed || code === null) return;
      if (accept.current && !accept.current(code)) return;
      event.preventDefault();
      event.stopPropagation();
      handler.current(code);
    };
    const onHidden = () => burst.reset();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onHidden);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onHidden);
    };
  }, [enabled]);
}
