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
 *     the returning family's review. The screen locks for those.
 *   - Some go again by themselves and never hold the family's form: the form's
 *     live `fill` (SCRUM-857, SCRUM-874, SCRUM-943), a language the family
 *     chose (SCRUM-963), and, since SCRUM-975, a child's `photo` named to the
 *     till. The display is the family's own screen: it is in their language
 *     the moment they choose it, and the box only has to be told. A choice
 *     made while the line was down used to lock the whole form behind a Retry
 *     bar that nothing but a press of Retry lifted, and a photo whose answer
 *     was lost raised that bar over the form though the form names its photos
 *     again by itself (`PHOTO_RESEND_MS`).
 *
 * `goesAgainByItself` names the second kind; the lock, the bar and the resend
 * in `Display.tsx` read it.
 *
 * SCRUM-975 — EVERY KEPT ANSWER GOES AGAIN WHEN THE BOX IS HEARD FROM AGAIN.
 * "Ask the team" pressed while the display was cut off stayed out until
 * somebody found Retry. The locked answers keep their lock while they are out,
 * and are sent again by themselves, as they were, the moment the line returns
 * (`sentAgainWhenBack`): Done, Ask the team and the agreements' acknowledge on
 * the form, the first screen's number, the details screen's Done and the
 * returning family's review. Sending one twice is safe: it goes under the same
 * action id, and the box takes an answer it already holds under that id as
 * the same answer (`station-session.ts`, the identify, child review and
 * consent answers), and refuses one the till has already moved past (its
 * prompt has a new request id), which the display then lets go.
 */
export function goesAgainByItself(intent: Pick<StationIntent, 'type' | 'payload'> | null | undefined): boolean {
  if (!intent) return false;
  if (intent.type === 'display.set_language') return true;
  const action = (intent.payload as { action?: unknown } | undefined)?.action;
  return intent.type === 'display.consent' && (action === 'fill' || action === 'photo');
}

/** The display's answers that are sent again by themselves once the box is heard from again (SCRUM-975). */
const SENT_AGAIN_WHEN_BACK: readonly string[] = [
  'display.consent', 'display.set_language', 'display.identify', 'display.contact_done', 'display.child_review',
];

/** Whether a kept answer goes again by itself when the line returns: every one the display sends. */
export function sentAgainWhenBack(intent: Pick<StationIntent, 'type'> | null | undefined): boolean {
  return !!intent && SENT_AGAIN_WHEN_BACK.includes(intent.type);
}
