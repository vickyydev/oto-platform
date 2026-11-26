/**
 * HOW A REPLY IS LAID OUT ON THE READER'S SCREEN (SCRUM-68) — measured at the
 * park's two gates on 26 November 2026:
 *
 *  - The screen is a narrow column (about 14 to 17 characters a line, about 17
 *    lines) that breaks a line wherever the text does, so one fact goes on a
 *    line. Thai, the baht sign and line breaks all show as sent.
 *  - The reader app shows a refusal as a Java error: its own
 *    "java.lang.Exception: " in front of our text and a stack trace after it.
 *    Our reply cannot remove either. A refusal therefore starts on a fresh
 *    line under a heading and ends in blank lines, so the trace falls below
 *    the screen's last line and only the app's first two short lines remain.
 *
 * The decision's own message (`GATE_MESSAGES`, `gateScreenMessage`) stays one
 * line with " · " between its parts. That is what the box logs, journals and
 * tests. It is laid out here, at the wire, only for the reader.
 */

import type { GateDirection } from './config';

/** The first line of every approval. */
export const READER_BRAND_LINE = 'OTO PLAY PARK';

/** The heading of every refusal, under the reader app's own error line. */
export const READER_REFUSAL_HEADING = 'ATTENTION';

/** A dashed line. A line of box-drawing strokes showed as one short dash on the reader. */
const RULE = '— — — — —';

/**
 * Blank lines after a refusal. The reader shows about 17 lines; the shortest
 * refusal uses 7 of them, so 14 more put the stack trace out of sight.
 */
export const READER_REFUSAL_PADDING_LINES = 14;

/**
 * Coloured symbols in front of the lines. The gate's Android draws them in
 * colour by itself; switch off if a reader shows empty boxes instead.
 */
export const READER_ICONS = true;

const icon = (symbol: string, text: string): string => (READER_ICONS ? `${symbol} ${text}` : text);

/**
 * One part of the decision's message as its line on the screen. A guest who
 * is let out reads the end of their play time as the time to be back by.
 */
function partLine(part: string, leaving: boolean): string {
  if (part === 'Adult' || part === 'Kid') return icon('👤', part);
  if (part.startsWith('until ')) {
    return icon('⏰', leaving ? part.replace(/^until /, 'come back before ') : part);
  }
  if (part.endsWith(' left')) return icon('⏳', part);
  if (part.startsWith('time ended')) return icon('⏰', part.replace(/^time /, ''));
  if (part.startsWith('Credit ')) return icon('💰', part);
  return icon('🎟', part);
}

/**
 * The reply's `message` as the reader shows it. `message` is the decision's
 * one-line text: "English / Thai · part · part".
 */
export function readerScreen(
  code: '0' | '1',
  message: string,
  direction: GateDirection | null,
): string {
  const [lead = '', ...parts] = message
    .split(' · ')
    .map((p) => p.trim())
    .filter(Boolean);
  const [english = '', ...otherLanguages] = lead
    .split(' / ')
    .map((p) => p.trim())
    .filter(Boolean);
  const details = parts.map((part) => partLine(part, code === '1' && direction === 'exit'));
  const below = details.length ? [RULE, ...details] : [];
  if (code === '1') {
    const heading = icon(direction === 'exit' ? '👋' : '✅', english.toUpperCase());
    return [READER_BRAND_LINE, heading, ...otherLanguages, ...below].join('\n');
  }
  return (
    ['', '', icon('⚠️', READER_REFUSAL_HEADING), RULE, english, ...otherLanguages, ...below].join('\n') +
    '\n'.repeat(READER_REFUSAL_PADDING_LINES)
  );
}
