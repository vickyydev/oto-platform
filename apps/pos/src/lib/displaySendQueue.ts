import type { StationIntent } from '@oto/shared';

/**
 * SCRUM-963 — THE PAIRED DISPLAY'S ONE ANSWER OUT AT A TIME (`pages/Display.tsx`).
 *
 * The display sends one answer to its box at a time, and keeps it (`pending`)
 * when the reply never came, so a resend is the same answer under the same
 * action id. What that kept answer means for the family depends on what it is:
 *
 *   - Some answers wait on the till before the family may go on: Done and
 *     "Ask the team" on the form, and every answer of the first screen and of
 *     the returning family's review. The screen locks for those, and a Retry
 *     is offered when the reply was lost.
 *   - Two go again by themselves and never hold the family's form: the form's
 *     live `fill` (SCRUM-857, SCRUM-874, SCRUM-943), and, since this ticket, a
 *     language the family chose. The display is the family's own screen: it is
 *     in their language the moment they choose it, and the box only has to be
 *     told. A choice made while the line was down used to lock the whole form
 *     behind a Retry bar that nothing but a press of Retry lifted.
 *
 * `goesAgainByItself` names the second kind; the lock and the resend in
 * `Display.tsx` read it.
 */
export function goesAgainByItself(intent: Pick<StationIntent, 'type' | 'payload'> | null | undefined): boolean {
  if (!intent) return false;
  if (intent.type === 'display.set_language') return true;
  return intent.type === 'display.consent' && (intent.payload as { action?: unknown } | undefined)?.action === 'fill';
}
