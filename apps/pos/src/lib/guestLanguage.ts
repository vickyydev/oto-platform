import { readGuestLanguage, type GuestLanguage } from '@oto/shared';
import type { SaleCartPayload } from '@/api/sales';

/**
 * SCRUM-1077 — THE LANGUAGE THE GUEST CHOSE, SAVED WITH THE SALE.
 *
 * The gate greets and refuses a band in the language its guest chose at the
 * till, so the sale carries that choice (`guestLanguage` on the cart, kept as
 * `pos.sale.guest_language`). Only a choice the guest made IN THIS SALE is
 * sent. The till's customer language is not that: it starts in English, the
 * staff account's own language is set on it at every sign-in and unlock
 * (`applyThemePrefs`), and it keeps the last guest's language into the next
 * sale. A sale where nobody chose sends nothing, and the gate then shows the
 * park's own list of languages, as before.
 *
 * Where the choice is known:
 *
 *   - the till's own customer half: the guest pressed a language on the sale's
 *     first screen (`CustomerLanguageChoice`). The language pressed is kept;
 *   - a paired customer display: it answered the sale's first screen (the
 *     number typed, or skipped on the phone till). A display shows that screen
 *     only after the guest has chosen their language in this sale
 *     (`useLanguageChoice` in `pages/Display.tsx`), and tells the station that
 *     language, so the station's language read with that answer is the guest's
 *     (`readDisplayAnswer`).
 *
 * Kept from that moment for the rest of the sale, so the cart the sale is rung
 * up with does not change under it. A new sale starts with none.
 */
export interface GuestLanguageChoice {
  /** The sale it was made in: the till's sale epoch. */
  sale: string;
  language: GuestLanguage;
}

/** The choice for a press made now, or null when what was read is not one of the five. */
export function guestLanguageChoice(sale: string, language: unknown): GuestLanguageChoice | null {
  const read = readGuestLanguage(language);
  return read ? { sale, language: read } : null;
}

/** The guest's language for this sale, or null when nobody chose in it. */
export function guestLanguageFor(choice: GuestLanguageChoice | null, sale: string): GuestLanguage | null {
  return choice && choice.sale === sale ? choice.language : null;
}

/** The cart with the guest's language on it; the same cart when nobody chose. */
export function withGuestLanguage(cart: SaleCartPayload, language: GuestLanguage | null): SaleCartPayload {
  return language ? { ...cart, guestLanguage: language } : cart;
}
