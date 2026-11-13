import { useSyncExternalStore } from 'react';
import { getSaleOpen, subscribeSaleOpen } from '@/pwa/openSale';

/**
 * SCRUM-977 — WHICH TILL A DEVICE SHOWS: THE PHONE'S OR THE DESK'S, DECIDED IN
 * ONE PLACE.
 *
 * The prototype chooses its phone shell by the window's width alone: under 768
 * pixels (its `MOBILE_BREAKPOINT`, `hooks/use-mobile.tsx`) its `AuthGate`
 * draws `MobileShell`, otherwise the iPad router. Its own shell says a phone
 * turned on its side keeps that layout ("Landscape rotation keeps the portrait
 * single-column layout intact", `components/mobile/MobileShell.tsx`), but a
 * phone that is 768 or more wide on its side (a 390 by 844 phone is 844 wide)
 * crossed the width and became the desk till, and the switch unmounted the
 * sale and the family's form under it.
 *
 * THE RULE, for the choice of till only:
 *
 *   1. A window under 768 pixels wide shows the phone till, as the prototype's
 *      does: a phone held upright, a desk window made narrow.
 *   2. So does a device whose SCREEN's shorter side is under 600 pixels and
 *      whose main pointer is a finger (`pointer: coarse`): a phone, however it
 *      is held. Every phone is under 500 on its shorter side; the smallest
 *      tablets are 600 and over (an iPad mini is 744, an iPad 768 to 834), so
 *      a tablet keeps the till it shows today (desk at 768 wide and over, the
 *      phone till under it); a laptop's pointer is a mouse or a touchpad
 *      (`pointer: fine`), so even a small one with a 512-pixel screen, or one
 *      with a touch screen beside its touchpad, is never taken for a phone.
 *   3. Once a till is showing and a selling surface holds something open (a
 *      cart, a held or rung-up payment, a phone number typed, the family's
 *      form handed over, a display in use: `setSaleOpen`, `pwa/openSale.ts`),
 *      a resize or a turn never swaps it for the other till. The choice is
 *      made again when nothing is open: a desk window dragged under 768 with
 *      nothing open shows the phone till, as today.
 *
 * The other readers of the prototype's hook keep it: `pages/StationSetup.tsx`
 * (its own small-screen tweaks) and `components/ui/sidebar.tsx`.
 */
export type TillKind = 'phone' | 'desk';

/** The prototype's breakpoint: a window narrower than this shows the phone till. */
export const PHONE_TILL_WIDTH = 768;
/** A finger-driven screen whose shorter side is under this is a phone, held either way. */
export const PHONE_SHORT_SIDE = 600;

export interface TillSurroundings {
  /** The window's width in CSS pixels (`innerWidth`). */
  viewportWidth: number;
  /** The screen's two sides in CSS pixels (`screen.width`, `screen.height`): they swap, or not, as the device turns. */
  screenWidth: number;
  screenHeight: number;
  /** The main pointer is a finger (`(pointer: coarse)`). */
  coarsePointer: boolean;
}

/** The till this device and window call for, with nothing open (rules 1 and 2). */
export function measuredTill(at: TillSurroundings): TillKind {
  if (at.viewportWidth < PHONE_TILL_WIDTH) return 'phone';
  const shorter = Math.min(at.screenWidth || Number.POSITIVE_INFINITY, at.screenHeight || Number.POSITIVE_INFINITY);
  return at.coarsePointer && shorter < PHONE_SHORT_SIDE ? 'phone' : 'desk';
}

/** The till to show next: the one showing while something is open on it (rule 3), else the measured one. */
export function nextTill(showing: TillKind | null, measured: TillKind, somethingOpen: boolean): TillKind {
  return showing !== null && somethingOpen ? showing : measured;
}

function surroundings(): TillSurroundings {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return {
    viewportWidth: window.innerWidth,
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
    coarsePointer: coarse,
  };
}

let showing: TillKind | null = null;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

function decide(): void {
  const next = nextTill(showing, measuredTill(surroundings()), getSaleOpen());
  if (next === showing) return;
  showing = next;
  for (const listener of listeners) listener();
}

function watch(): () => void {
  window.addEventListener('resize', decide);
  window.addEventListener('orientationchange', decide);
  const pointer = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
  pointer?.addEventListener?.('change', decide);
  // Something closing (a sale finished, a form returned) may let the measured till show.
  const stopSale = subscribeSaleOpen(decide);
  return () => {
    window.removeEventListener('resize', decide);
    window.removeEventListener('orientationchange', decide);
    pointer?.removeEventListener?.('change', decide);
    stopSale();
  };
}

export function getTillChoice(): TillKind {
  if (typeof window === 'undefined') return 'desk';
  if (showing === null) showing = measuredTill(surroundings());
  return showing;
}

export function subscribeTillChoice(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === 'undefined') return () => { listeners.delete(listener); };
  if (!stopWatching) stopWatching = watch();
  // The first reader measures; a resize between its read and this is caught up now.
  getTillChoice();
  decide();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatching) { stopWatching(); stopWatching = null; }
  };
}

/** Which till this device shows now (see the rule above). */
export function useTillChoice(): TillKind {
  return useSyncExternalStore(subscribeTillChoice, getTillChoice, () => 'desk');
}

/** Tests only: forget the till showing, so the next reader measures afresh. */
export function resetTillChoiceForTests(): void {
  showing = null;
  if (listeners.size === 0 && stopWatching) { stopWatching(); stopWatching = null; }
}
