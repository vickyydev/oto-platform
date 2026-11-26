/**
 * THE LANGUAGE THE GUEST CHOSE AT THE TILL (SCRUM-1077).
 *
 * The customer display opens a sale on a choice of its five languages
 * (SCRUM-763). The choice is saved with the sale (`pos.sale.guest_language`)
 * and travels with each of its bands to the gate box, so the gate greets and
 * refuses that guest in their language (`composeGuestGateScreen` in
 * `gate-messages.ts`).
 *
 * Only a choice the guest made in that sale is saved. A sale where nobody
 * chose, one rung up before this, and anything that is not one of the five
 * are kept as none (null), and the gate then shows the park's own list of
 * languages exactly as before.
 *
 * Wording only: nothing that decides whether a gate opens reads this.
 */

import { z } from 'zod';
import { SUPPORTED_LANGS, type SupportedLang } from './i18n/index';

/** The customer display's five languages, in its own order. */
export const GUEST_LANGUAGES = SUPPORTED_LANGS;
export type GuestLanguage = SupportedLang;

/** One of the five, for a request body that carries the guest's choice. */
export const GuestLanguageSchema = z.enum(GUEST_LANGUAGES);

/** Whether a value is one of the five. */
export function isGuestLanguage(value: unknown): value is GuestLanguage {
  return typeof value === 'string' && (GUEST_LANGUAGES as readonly string[]).includes(value);
}

/**
 * A value as the guest's language, or null: what the platform keeps when a
 * till or a box sends something that is not one of the five (an older
 * release, a typing slip). Never a reason to refuse a sale.
 */
export function readGuestLanguage(value: unknown): GuestLanguage | null {
  return isGuestLanguage(value) ? value : null;
}
