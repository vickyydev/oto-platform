import type { StationSessionStage } from '@oto/shared';

/**
 * THE PHONE TILL ON A PAIRED CUSTOMER DISPLAY (SCRUM-686).
 *
 * The counter till (`pages/Till.tsx`) derives the display's stage from its
 * wizard step and publishes it through `useTicketDisplay`. The phone till
 * (`components/mobile/MobileTill.tsx`) runs the same sale on its own steps,
 * so a display paired to the station needs those steps said in the counter's
 * numbering — one presentation shape, one publisher, read by one display.
 *
 * Counter step → stage, as `customerStage` in `pages/Till.tsx` has it:
 *   1 identify · 2 tier (welcome) · 3 tickets (order / welcome) ·
 *   4 contact (input) · 5 payment · 6 thank-you · 7 supervision (input).
 *
 * The phone has no child-review step (the counter's 8) and keeps its consent
 * capture on the phone itself, so step 7 is published with no prompt and the
 * display falls back to "follow the staff screen" for it — nothing invented.
 */

export type PhoneTillStep =
  | 'tier'
  | 'tickets'
  | 'configure'
  | 'dropoff-config'
  | 'supervision'
  | 'review'
  | 'payment'
  | 'done';

/** Which customer-facing content the phone's hand-to-customer overlay shows. */
export type PhoneHandoffMode = 'input' | 'consent' | 'qr' | null;

export interface PhoneTillStagePoint {
  step: PhoneTillStep;
  handoffMode: PhoneHandoffMode;
  /** Something is on the cart. */
  hasLines: boolean;
  /** A member is on the sale: the display's identify prompt has nothing to ask. */
  hasMember: boolean;
  /** The visitor answered the identify prompt this sale (found, not found or skipped). */
  identifyAnswered: boolean;
}

export interface PhoneTillDisplayStage {
  stage: StationSessionStage;
  step: number;
}

/** The counter's stage and step for where the phone till is. */
export function phoneTillDisplayStage(point: PhoneTillStagePoint): PhoneTillDisplayStage {
  if (point.step === 'done') return { stage: 'thankyou', step: 6 };
  if (point.step === 'payment') return { stage: 'payment', step: 5 };
  if (point.handoffMode === 'input') return { stage: 'input', step: 4 };
  if (point.step === 'supervision' || point.handoffMode === 'consent') return { stage: 'input', step: 7 };
  if (point.step === 'tier' && !point.hasMember && !point.hasLines && !point.identifyAnswered) {
    return { stage: 'identify', step: 1 };
  }
  return { stage: point.hasLines ? 'order' : 'welcome', step: point.step === 'tier' ? 2 : 3 };
}

/**
 * Whether the phone draws its own customer screens (the hand-to-customer
 * overlay) — the counter's `inlineDisplay` rule (`pages/Till.tsx`), without
 * its show/hide preference: a separate display that is connected, can show
 * this stage and has no connection fault takes the customer's part.
 */
export function phoneTillInlineDisplay(linked: { connected: readonly unknown[]; supported: boolean; error: string | null }): boolean {
  return !linked.connected.length || !linked.supported || !!linked.error;
}
