import { useEffect, useState } from 'react';
import { STATION_DISPLAY_THEMES, type StationDisplayTheme } from '@oto/shared';
import { readDisplayTheme, rememberDisplayTheme } from '@/api/display';

/**
 * SCRUM-929 — THE DISPLAY THEME, ON THE TILL AND ON A PAIRED DISPLAY.
 *
 * The till's Theme > Display switch is the look of this till's customer
 * screen: the customer half it draws itself, and since this ticket a separate
 * display paired to its station. The switch still lives in this page's memory
 * (no browser storage on the till, per the app's rules); what is new is that
 * a press is also published, through the station document, to the box, which
 * keeps it, and to the paired display, which remembers it in its own browser.
 *
 * Only a PRESS is published. The till starts light on every load and a sign-in
 * restores a person's last choice, but neither is somebody telling the display
 * anything: published, they would flip a paired display to light at every
 * reload. Until somebody presses Display on this till, the switch shows what
 * the paired display shows instead (`adopt`), so the first press changes it.
 */
export type DisplayTheme = StationDisplayTheme;

let customerTheme: DisplayTheme = 'light';
let pressed = false;
const listeners = new Set<() => void>();

function set(next: DisplayTheme, press: boolean): void {
  if (next === customerTheme && press === pressed) return;
  customerTheme = next;
  pressed = press;
  for (const listener of listeners) listener();
}

export function isDisplayTheme(value: unknown): value is DisplayTheme {
  return typeof value === 'string' && (STATION_DISPLAY_THEMES as readonly string[]).includes(value);
}

/** The till's one Display theme, shared by every screen that draws or publishes a customer screen. */
export const customerDisplayTheme = {
  get: (): DisplayTheme => customerTheme,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** Set without a press: the sign-in restoring a choice. A paired display keeps its own look. */
  restore(next: DisplayTheme): void { set(next, false); },
  /** Display pressed on this till: its own customer half and a paired display take it. */
  choose(next: DisplayTheme): void { set(next, true); },
  /**
   * What the paired display shows, as its box holds it (or dark, for a display
   * the box has never told), before anybody has pressed Display on this till.
   * After a press the till's own choice stands and is what it publishes.
   */
  adopt(theme: DisplayTheme | null): void {
    if (!pressed && theme) set(theme, false);
  },
  /** What this till tells a paired display: its theme once Display was pressed here, else nothing. */
  toTell: (): DisplayTheme | null => (pressed ? customerTheme : null),
};

/**
 * The separate display's side: the look its till last told it, applied from
 * the first render (before the first document arrives) and remembered beside
 * its pairing, so a reload or a restarted browser keeps it. Dark for a display
 * that was never told; a document that says nothing (`null`, or a box from
 * before the field) leaves the remembered look as it is.
 */
export function useDisplayTheme(told: unknown): DisplayTheme {
  const [theme, setTheme] = useState<DisplayTheme>(() => readDisplayTheme() ?? 'dark');
  useEffect(() => {
    if (!isDisplayTheme(told)) return;
    rememberDisplayTheme(told);
    setTheme(told);
  }, [told]);
  return theme;
}
