import { useEffect, useRef } from 'react';
import {
  SCANNER_BURST_MAX_LENGTH_TILL,
  SCANNER_BURST_MIN_LENGTH,
  bandShortCode,
  isBandCodeShape,
  isWalletQrCode,
  normaliseBandCode,
  normaliseWalletKeyValue,
  parseBandShortCode,
} from '@oto/shared';
import { looksLikeBookingQr } from '@/api/bookings';
import type { TabScan } from '@/lib/scanChannel';
import { looksLikeVoucherCode } from '@/lib/tillVoucher';

/**
 * SCRUM-766 — ONE SCANNER LISTENER FOR THE WHOLE TILL.
 *
 * With the scanner's cradle in the iPad, the scanner is a keyboard: it types
 * the code it read and then Enter (docs/ops/BOX_QUICKSTART.md, "the iPad
 * wedge"). A wristband used to be caught only by the wristband box, so a scan
 * made with the box not selected went nowhere. This listener sits at the
 * staff app's shell (`PageScanShell` in App.tsx), hears scanner-paced input
 * anywhere on the page, says what the code is and hands it to the screen on
 * show, which does with it what it already does with the same code read by
 * the counter box (SCRUM-731):
 *
 *   - a wristband or a credit voucher's QR: F&B and the shop open its tab on
 *     their first screen, through the wristband box, as a typed code does;
 *     History opens its orders (or ticks it on an open Add time); the ticket
 *     till says where it opens. Each screen's `tab` route.
 *   - a Lucky Wheel voucher and a booking QR: the ticket till and F&B, as the
 *     page listener they had did (S2-10b, S2-12). Their `voucher` and
 *     `booking` routes.
 *   - anything else (a retail barcode, a code of no known shape): nothing. The
 *     till has no product lookup of its own; a barcode reaches the shop through
 *     the counter box.
 *
 * THE PACE RULE is the wristband box's (SCRUM-790, `ScanWristband`): at least
 * `SCANNER_BURST_MIN_LENGTH` characters in a row, each within
 * `SCAN_PACE_GAP_MS` of the one before, ended by an Enter in that time or by
 * `SCAN_PACE_QUIET_MS` with nothing more. A slower key ends the run and drops
 * it. Ctrl, Alt or Meta is a shortcut, and an editing key (Backspace, Tab, an
 * arrow) is a person at the keys: both end the run. A paste made with no field
 * selected is a whole code, as a paste into the wristband box is.
 *
 * WHERE FOCUS IS decides who acts, so a code is never acted on twice:
 *
 *   - a field that reads codes itself — the wristband box, History's bracelet
 *     box and its search box, Add time's bracelet field, a held sale's name —
 *     carries `data-reads-scans`. The listener leaves it alone entirely.
 *   - any other field. Keys typed by hand are that field's. A wristband typed
 *     into it at a scanner's pace is the scanner's: the screen takes it, the
 *     field is put back as it was before the scan, and the scanner's Enter does
 *     not submit the field's form. A voucher or a booking QR stays the field's,
 *     as it always was (the promo box, Redeem voucher).
 *   - no field: every route.
 *
 * The rules are pure (`createPageScanner`, `classifyScannedCode`,
 * `planPageScan`) so they can be driven key by key; `usePageScanShell` is the
 * few lines that feed them the page's events.
 */

/** A scanner's characters arrive this close together; a person's do not (SCRUM-790). */
export const SCAN_PACE_GAP_MS = 80;
/** This long with nothing more ends a scanner-paced code that came with no Enter (SCRUM-790). */
export const SCAN_PACE_QUIET_MS = 150;
/** The longest run the till takes off the page's keyboard. */
export const SCAN_PACE_MAX_LENGTH = SCANNER_BURST_MAX_LENGTH_TILL;
/** The attribute a field that reads codes itself carries. */
export const READS_SCANS_ATTRIBUTE = 'data-reads-scans';

/** Where the keys were going: nowhere, into a field, or into a field that reads codes itself. */
export type ScanFocus = 'none' | 'field' | 'own';

export interface PageScanKey {
  /** The DOM key name: `B`, `7`, `Enter`, `Shift`. */
  key: string;
  /** Milliseconds on a monotonic clock; only differences are read. */
  at: number;
  /** Ctrl, Alt or Meta held. */
  withCommand?: boolean;
  focus: ScanFocus;
}

/** A code the pace rule read, and where focus was while it arrived. */
export interface PageScanCommit {
  code: string;
  focus: 'none' | 'field';
  /** Ended by the scanner's Enter, which the caller keeps from doing anything else once a screen takes it. */
  byEnter: boolean;
}

export interface PageScanStep {
  commit: PageScanCommit | null;
  /** This key began a run: the caller notes the field as it stood, to put it back. */
  started: boolean;
  /** Wait this long for the quiet that ends the run, or null for no wait. */
  settleInMs: number | null;
}

const PRINTABLE = /^[\x20-\x7e]$/;
/** Keys a scanner presses on the way to a character, which neither add to a run nor end it. */
const PASS_THROUGH = new Set(['Shift', 'CapsLock']);

export interface PageScanner {
  push(key: PageScanKey): PageScanStep;
  /** The quiet after the last key: the run as a code, when it was long enough. */
  settle(): PageScanCommit | null;
  reset(): void;
}

export function createPageScanner(): PageScanner {
  let buffer = '';
  let lastAt = 0;
  let focus: 'none' | 'field' = 'none';
  const idle: PageScanStep = { commit: null, started: false, settleInMs: null };
  const clear = () => {
    buffer = '';
  };
  const waiting = (): PageScanStep => ({
    commit: null,
    started: false,
    settleInMs: buffer.length >= SCANNER_BURST_MIN_LENGTH ? SCAN_PACE_QUIET_MS : null,
  });

  return {
    push({ key, at, withCommand, focus: where }) {
      if (where === 'own') {
        clear();
        return idle;
      }
      // A slow key ends whatever run was open before it is read.
      if (buffer.length > 0 && at - lastAt > SCAN_PACE_GAP_MS) clear();
      if (withCommand) {
        clear();
        return idle;
      }
      if (key === 'Enter') {
        const code = buffer;
        clear();
        if (code.length < SCANNER_BURST_MIN_LENGTH) return idle;
        return { commit: { code, focus, byEnter: true }, started: false, settleInMs: null };
      }
      if (PASS_THROUGH.has(key)) return waiting();
      if (!PRINTABLE.test(key)) {
        clear();
        return idle;
      }
      // Focus that moved mid-run starts a new one where it went.
      if (buffer.length > 0 && where !== focus) clear();
      if (buffer.length >= SCAN_PACE_MAX_LENGTH) {
        // Something leaning on a key: nothing it typed is a code.
        clear();
        lastAt = at;
        return idle;
      }
      const started = buffer.length === 0;
      if (started) focus = where;
      buffer += key;
      lastAt = at;
      return { ...waiting(), started };
    },
    settle() {
      const code = buffer;
      clear();
      return code.length >= SCANNER_BURST_MIN_LENGTH ? { code, focus, byEnter: false } : null;
    },
    reset: clear,
  };
}

// --- What a code is -----------------------------------------------------------

export type ScannedCodeKind = 'band' | 'wallet' | 'voucher' | 'booking';

/**
 * What a code read off the page's keyboard is, by its shape, with the shared
 * shape tests the rest of the till uses: a booking QR (`BK1:`), a band's signed
 * code or the short code printed under it (as History's box reads them), a
 * credit voucher's `QR-…`, a Lucky Wheel voucher. A printed band wins over the
 * voucher shape a four- or five-character prefix can take once its dash is
 * gone (SCRUM-746). Null for anything else.
 */
export function classifyScannedCode(raw: string): ScannedCodeKind | null {
  const code = raw.trim();
  if (!code) return null;
  if (looksLikeBookingQr(code)) return 'booking';
  if (isBandCodeShape(code) || parseBandShortCode(code)) return 'band';
  if (isWalletQrCode(code)) return 'wallet';
  if (looksLikeVoucherCode(code)) return 'voucher';
  return null;
}

/**
 * A wristband or a credit voucher read off the page's keyboard, as the screens
 * read the counter box's (`readTabScan`): `key` is what a person would type,
 * the short code printed under a band's QR, so every sentence a screen says
 * names the band the way the box's scan does and never prints the signed code.
 * `code` is the code as the scanner read it, handed to the wristband box and
 * History's lookup exactly as if it had been typed there.
 */
export function tabScanOfScannedCode(raw: string): TabScan | null {
  const code = raw.trim();
  if (isBandCodeShape(code)) {
    const signed = normaliseBandCode(code);
    return { ok: true, what: 'band', key: bandShortCode(signed) ?? signed, code: signed };
  }
  const short = parseBandShortCode(code);
  if (short) {
    const printed = `${short.prefix}-${short.tail}`;
    return { ok: true, what: 'band', key: printed, code: printed };
  }
  if (isWalletQrCode(code)) return { ok: true, what: 'wallet', key: normaliseWalletKeyValue('voucher_qr', code) };
  return null;
}

// --- Who takes it ---------------------------------------------------------------

/** What the screen on show does with each kind of code. A kind it leaves out is not its. */
export interface PageScanRoute {
  /** A wristband or a credit voucher's QR. */
  tab?: (scan: TabScan) => void;
  /** A Lucky Wheel voucher's code, as read. */
  voucher?: (code: string) => void;
  /** A booking QR, as read. */
  booking?: (code: string) => void;
}

/**
 * The one thing to do with a code, or null when nobody on screen takes it: a
 * wristband or a credit voucher for the screen's `tab` route from anywhere but
 * a field that reads codes itself (which never reaches here); a voucher or a
 * booking QR only with no field selected, as before.
 */
export function planPageScan(commit: PageScanCommit, route: PageScanRoute | null): (() => void) | null {
  if (!route) return null;
  const kind = classifyScannedCode(commit.code);
  if (kind === 'band' || kind === 'wallet') {
    const scan = tabScanOfScannedCode(commit.code);
    const take = route.tab;
    return scan && take ? () => take(scan) : null;
  }
  if (commit.focus !== 'none') return null;
  if (kind === 'voucher' && route.voucher) {
    const take = route.voucher;
    return () => take(commit.code);
  }
  if (kind === 'booking' && route.booking) {
    const take = route.booking;
    return () => take(commit.code);
  }
  return null;
}

/** The routes of the screens on show, newest last. In practice there is one. */
const routes: Array<{ read: () => PageScanRoute }> = [];

/** Put a screen's routes in place; the returned function takes them away. */
export function registerPageScanRoute(read: () => PageScanRoute): () => void {
  const entry = { read };
  routes.push(entry);
  return () => {
    const at = routes.indexOf(entry);
    if (at >= 0) routes.splice(at, 1);
  };
}

/** The routes of the screen on show, or null when no screen takes scans. */
export function currentPageScanRoute(): PageScanRoute | null {
  const entry = routes[routes.length - 1];
  return entry ? entry.read() : null;
}

/**
 * A screen's routes, for as long as it is on show and `enabled` (a locked
 * station takes nothing). Read through a ref, so a screen hands in fresh
 * closures on every render — its stage, its sale — without re-registering.
 */
export function usePageScanRoute(route: PageScanRoute, enabled: boolean): void {
  const latest = useRef(route);
  latest.current = route;
  useEffect(() => {
    if (!enabled) return;
    return registerPageScanRoute(() => latest.current);
  }, [enabled]);
}

// --- The page's events ----------------------------------------------------------

/** The few parts of an element read here, so the rules run on a stand-in too. */
interface ScanElement {
  tagName: string;
  isContentEditable?: boolean;
  value?: unknown;
  type?: unknown;
  isConnected?: boolean;
  closest?: (selector: string) => unknown;
  dispatchEvent?: (event: Event) => boolean;
}

function asElement(value: unknown): ScanElement | null {
  return value !== null && typeof value === 'object' && typeof (value as { tagName?: unknown }).tagName === 'string'
    ? (value as ScanElement)
    : null;
}

/** Where the keys are going: the event's target, or what has focus. */
export function scanFocusOf(target: EventTarget | null): ScanFocus {
  const element = asElement(target) ?? asElement(typeof document === 'undefined' ? null : document.activeElement);
  if (!element) return 'none';
  if (typeof element.closest === 'function' && element.closest(`[${READS_SCANS_ATTRIBUTE}]`)) return 'own';
  if (element.isContentEditable) return 'field';
  const tag = element.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ? 'field' : 'none';
}

const TEXTLESS_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color']);

/** A field holding text, as it stood before a run began, so a scan can put it back. */
interface FieldBefore {
  element: ScanElement;
  value: string;
}

function fieldBefore(target: EventTarget | null): FieldBefore | null {
  const element = asElement(target) ?? asElement(typeof document === 'undefined' ? null : document.activeElement);
  if (!element || typeof element.value !== 'string') return null;
  const tag = element.tagName.toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return null;
  if (tag === 'INPUT' && typeof element.type === 'string' && TEXTLESS_INPUTS.has(element.type)) return null;
  return { element, value: element.value };
}

/**
 * Put a field back as it was before the scan typed into it. The prototype's
 * own setter, then an `input` event, so a React field's state follows: React
 * watches its fields' value through a setter of its own on the element.
 */
function putBack(before: FieldBefore): void {
  const { element, value } = before;
  if (element.isConnected === false || element.value === value) return;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent?.(new Event('input', { bubbles: true }));
}

/**
 * Hear the scanner anywhere on the staff app. Mounted once, at the shell; it
 * does nothing on a screen that took no route (`usePageScanRoute`).
 */
export function usePageScanShell(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const scanner = createPageScanner();
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let before: FieldBefore | null = null;
    const stopWaiting = () => {
      if (quiet) clearTimeout(quiet);
      quiet = null;
    };

    /** Hand a code to the screen on show. True when it took it. */
    const deliver = (commit: PageScanCommit): boolean => {
      const field = before;
      before = null;
      const take = planPageScan(commit, currentPageScanRoute());
      if (!take) return false;
      if (commit.focus === 'field' && field) putBack(field);
      take();
      return true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const focus = scanFocusOf(event.target);
      const step = scanner.push({
        key: event.key,
        at: event.timeStamp,
        withCommand: event.ctrlKey || event.altKey || event.metaKey,
        focus,
      });
      if (step.started) before = focus === 'field' ? fieldBefore(event.target) : null;
      stopWaiting();
      if (step.commit) {
        if (deliver(step.commit)) {
          // The scanner's Enter, once a screen took the code: it must not also
          // submit a field's form or press the button that has focus.
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (step.settleInMs !== null) {
        quiet = setTimeout(() => {
          quiet = null;
          const commit = scanner.settle();
          if (commit) deliver(commit);
        }, step.settleInMs);
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      if (scanFocusOf(event.target) !== 'none') return;
      const text = event.clipboardData?.getData('text') ?? '';
      if (!text.trim()) return;
      scanner.reset();
      stopWaiting();
      before = null;
      if (deliver({ code: text.trim(), focus: 'none', byEnter: false })) event.preventDefault();
    };

    const onHidden = () => {
      scanner.reset();
      stopWaiting();
      before = null;
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('blur', onHidden);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('paste', onPaste, true);
      window.removeEventListener('blur', onHidden);
      onHidden();
    };
  }, []);
}
