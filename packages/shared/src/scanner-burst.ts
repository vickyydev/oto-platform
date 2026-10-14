/**
 * SCRUM-421 — THE KEYBOARD-WEDGE SCANNER'S NUMBERS, in one place.
 *
 * The park's Zebra scanner types what it read and then Enter, and two readers
 * tell its keystrokes from a person's: the box's (`HidBurstReader`,
 * packages/box-agent/src/scan-input.ts) and the till's, for a scanner plugged
 * straight into the computer running it (apps/pos/src/lib/scannerBurst.ts).
 * It is the same scanner, so the numbers that describe it live here and both
 * readers take them.
 *
 * What the two readers do NOT share, and why:
 *
 *   - the longest burst. The box reads band and booth codes and the scanner's
 *     optional Code ID prefix off a dedicated device, and accepts up to
 *     `SCANNER_BURST_MAX_LENGTH_BOX`; the till listens to the page's own
 *     keyboard and closes earlier, at `SCANNER_BURST_MAX_LENGTH_TILL`, so a key
 *     held down on the counter is dropped sooner. Both are far above the
 *     longest code the park prints.
 *   - the quiet-gap close. The box closes a burst that never got its Enter
 *     after `SCANNER_BURST_QUIET_GAP_MS`; the till has no timer and simply lets
 *     the next key past `SCANNER_BURST_GAP_MS` start a new burst, which drops
 *     the unfinished one the same way.
 */

/** The scanner's keystroke delay is 0, 20 or 40 ms; 50 ms covers the slowest with room. */
export const SCANNER_BURST_GAP_MS = 50;
/** A booth code is ten or eleven characters; nothing shorter is worth reading. */
export const SCANNER_BURST_MIN_LENGTH = 6;
/** A burst that stops arriving without its terminator is closed after this long (box only). */
export const SCANNER_BURST_QUIET_GAP_MS = 500;
/** The longest burst the box accepts off its own scanner device. */
export const SCANNER_BURST_MAX_LENGTH_BOX = 128;
/** The longest burst the till accepts off the page's keyboard. */
export const SCANNER_BURST_MAX_LENGTH_TILL = 64;
