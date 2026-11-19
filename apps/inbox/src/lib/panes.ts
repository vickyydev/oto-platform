// THE PANES AND THE DIVIDER BETWEEN THEM (SCRUM-1045): how wide the list is
// beside the chat. From 768 px the two sit side by side, the list the
// narrower: about 36 % of the room by default, never under 264 px and, by
// default, never over 380 px; the chat takes the rest and never less than
// 360 px. Between them a divider a person can drag; the width chosen is
// remembered per browser and per layout, and clamped again whenever the room
// changes (a rotated tablet, a resized window). When the room cannot give both
// panes their minimum, the Inbox shows one pane at a time, as on a phone.
//
// Plain arithmetic, apart from the two storage helpers, so the tests pin it.

/** Below this window width the Inbox is a phone: one pane at a time. */
export const SPLIT_FROM = 768;
/** From this window width the views column stands left of the list. */
export const RAIL_FROM = 1024;
/** The views column's width: "Birthdays & Events" whole beside its count. */
export const RAIL_WIDTH = 224;
export const LIST_MIN = 264;
export const CHAT_MIN = 360;
/** The default never goes past this; a drag may, up to `LIST_MAX`. */
export const LIST_DEFAULT_MAX = 380;
/** However wide the screen, a list wider than this is no help to anyone. */
export const LIST_MAX = 560;
export const LIST_SHARE = 0.36;
/** The chat's right panel (the customer and the next step), from 1280 px. */
export const PANEL_WIDTH = 300;
/** One arrow press moves the divider this far. */
export const KEY_STEP = 16;

/** The two layouts that have a divider; each remembers its own width. */
export type SplitLayout = 'tablet' | 'desktop';
export type PaneLayout = 'phone' | SplitLayout;

export function layoutFor(windowWidth: number): PaneLayout {
  return windowWidth < SPLIT_FROM ? 'phone' : windowWidth < RAIL_FROM ? 'tablet' : 'desktop';
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Room for the list and the chat together: the work area less the views column. */
export function roomFor(workWidth: number, layout: PaneLayout): number {
  return Math.max(0, workWidth - (layout === 'desktop' ? RAIL_WIDTH : 0));
}

/** Both panes fit at their minimums. */
export function canSplit(layout: PaneLayout, room: number): layout is SplitLayout {
  return layout !== 'phone' && room >= LIST_MIN + CHAT_MIN;
}

/** The widest the list may be dragged in this room: the chat keeps its 360 px. */
export function listMax(room: number): number {
  return Math.max(LIST_MIN, Math.min(LIST_MAX, room - CHAT_MIN));
}

/**
 * The list's width when nobody chose one: about 36 % of the room the list
 * and the conversation share, 264 to 380 px. `aside` is the chat's own right
 * panel where it shows (300 px from 1280 px): the share is taken without it,
 * so the conversation beside the panel is not the one that pays for it.
 */
export function listDefault(room: number, aside = 0): number {
  return clamp(Math.round(Math.max(0, room - aside) * LIST_SHARE), LIST_MIN, Math.min(LIST_DEFAULT_MAX, listMax(room)));
}

/** A chosen width, kept inside this room's limits; none chosen is the default. */
export function listWidth(chosen: number | null, room: number, aside = 0): number {
  if (chosen === null || !Number.isFinite(chosen)) return listDefault(room, aside);
  return clamp(Math.round(chosen), LIST_MIN, listMax(room));
}

/**
 * Where a key press moves the divider: Left and Right by 16 px, Home and End
 * to the limits, Enter back to the default. Any other key: null, untouched.
 */
export function keyedWidth(key: string, current: number, room: number): number | 'default' | null {
  switch (key) {
    case 'ArrowLeft':
      return listWidth(current - KEY_STEP, room);
    case 'ArrowRight':
      return listWidth(current + KEY_STEP, room);
    case 'Home':
      return LIST_MIN;
    case 'End':
      return listMax(room);
    case 'Enter':
      return 'default';
    default:
      return null;
  }
}

const KEY = (layout: SplitLayout) => `oto.inbox.listWidth.${layout}`;

/** The width this browser chose for this layout, or null; a refused storage reads as none. */
export function readListWidth(layout: SplitLayout): number | null {
  try {
    const raw = localStorage.getItem(KEY(layout));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Remember a width for this layout (null forgets it: back to the default). Per browser only. */
export function writeListWidth(layout: SplitLayout, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(KEY(layout));
    else localStorage.setItem(KEY(layout), String(Math.round(width)));
  } catch {
    // A refused storage keeps the width for this visit only.
  }
}
