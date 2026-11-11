// THE REPLY BOX (SCRUM-837), the pure side: how tall the composer's box is
// for what it holds, and which key sends. The box itself is in
// `components/Composer.tsx`; these are here so a test can hold them to the
// rules without a layout.
//
// A reply is read before it is sent — a long one too (a dictated reply runs
// to several lines). The box is one line when empty, grows a line at a time
// with its words to `COMPOSER_MAX_ROWS`, and scrolls from there.

/** The height of one line of the reply box, in px; the box sets this as its line height. */
export const COMPOSER_LINE_PX = 20;

/** The lines the reply box grows to before it scrolls. */
export const COMPOSER_MAX_ROWS = 5;

/**
 * The box's height for the height its words need (the element's
 * `scrollHeight` once its own height is let go): never under one line, never
 * over the cap, and scrolling only past the cap. A browser that cannot
 * measure (0, NaN) gets the one line.
 */
export function composerBox(
  contentPx: number,
  linePx: number = COMPOSER_LINE_PX,
  maxRows: number = COMPOSER_MAX_ROWS,
): { heightPx: number; scrolls: boolean } {
  const needed = Number.isFinite(contentPx) ? contentPx : 0;
  const cap = linePx * maxRows;
  return { heightPx: Math.max(linePx, Math.min(cap, Math.ceil(needed))), scrolls: needed > cap };
}

/**
 * Enter sends, as it did in the one-line box; Shift+Enter makes a new line.
 * An Enter that only confirms an input method's word (composing) sends
 * nothing.
 */
export function sendsOnKey(e: { key: string; shiftKey: boolean; composing?: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey && e.composing !== true;
}
