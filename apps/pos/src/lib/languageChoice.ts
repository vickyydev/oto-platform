import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * SCRUM-763 — THE GUEST CHOOSES THEIR LANGUAGE FIRST.
 *
 * Suggested by the tester and agreed by the owner on 30 October: the customer
 * display opens a sale on a choice of the five languages, before the phone
 * number, so that every screen after it — the phone number's safety line
 * included — reads in the guest's language. The small language button stays on
 * the later screens to change it again.
 *
 * Once per customer, never between steps. The choice opens again only when a
 * new customer's first screen arrives:
 *
 *   - a screen that knows its sale (`saleKey`) asks once in each sale, and
 *     only on the sale's first screen. The till's own customer half knows its
 *     sale; a paired display is told it on the first screen's prompt (the
 *     till's `saleKey`, `useHeldSaleKey`). A completed, cancelled or held sale
 *     starts the next one with a new name (`resetSale`), even when the screen
 *     never left the first screen. Where the screen has been in between does
 *     not matter: the phone till goes back to its first screen inside one sale
 *     (Back from tickets to tier), and a display that loses and finds its
 *     session comes back to it too, and neither is a new guest;
 *   - a screen that does not know its sale (a paired display behind an older
 *     till or box, whose first screen carries no name) takes a return to the
 *     first screen from any other as the next guest.
 *
 * Moving on from the first screen and on through the sale keeps the choice;
 * staying on the first screen keeps it too, so a guest who chose and is typing
 * their number is never asked again.
 */
export interface LanguageChoiceState {
  /** The guest at this screen chose their language. */
  chosen: boolean;
  /** The screen has been somewhere other than the first screen since that choice; read only where the sale is unknown. */
  leftStart: boolean;
  /** The sale the choice was made in, where the screen knows it. */
  saleKey: string | null;
}

export const languageChoiceStart = (saleKey: string | null = null): LanguageChoiceState => ({
  chosen: false,
  leftStart: false,
  saleKey,
});

/** The guest pressed their language: kept for the rest of this sale. */
export const languageChoiceMade = (saleKey: string | null = null): LanguageChoiceState => ({
  chosen: true,
  leftStart: false,
  saleKey,
});

/** Whether the first screen asks for the language now. Read while drawing, so a new customer never sees the old one's screen. */
export function languageChoiceOpen(state: LanguageChoiceState, atStart: boolean, saleKey: string | null = null): boolean {
  if (!atStart) return false;
  if (state.saleKey !== saleKey) return true;
  return !state.chosen || (saleKey === null && state.leftStart);
}

/** The state after the screen settles on `atStart` in sale `saleKey`; the same object when nothing changed. */
export function settleLanguageChoice(state: LanguageChoiceState, atStart: boolean, saleKey: string | null = null): LanguageChoiceState {
  const current = state.saleKey === saleKey ? state : languageChoiceStart(saleKey);
  // A known sale asks once: where the screen goes inside it changes nothing.
  if (saleKey !== null) return current;
  if (!atStart) return current.leftStart ? current : { ...current, leftStart: true };
  return current.leftStart ? languageChoiceStart(saleKey) : current;
}

/**
 * The customer screen's language gate. `atStart` is true while the screen shows
 * the sale's first screen (the phone-number step); `saleKey` names the sale
 * where the screen knows it. `open` asks for the language; `choose` records the
 * guest's choice for the rest of their visit.
 */
export function useLanguageChoice(atStart: boolean, saleKey: string | null = null): { open: boolean; choose: () => void } {
  const [state, setState] = useState<LanguageChoiceState>(() => languageChoiceStart(saleKey));
  useEffect(() => {
    setState((previous) => settleLanguageChoice(previous, atStart, saleKey));
  }, [atStart, saleKey]);
  const choose = useCallback(() => setState(languageChoiceMade(saleKey)), [saleKey]);
  return { open: languageChoiceOpen(state, atStart, saleKey), choose };
}

/**
 * A paired display's sale, as the till names it. The name rides only on the
 * first screen's prompt (`saleKey` in `ticketDisplayPresentation`); the later
 * screens carry none, so the display keeps the one it last read there. A first
 * screen with no name is an older till's or an older box's: the display then
 * knows no sale, and the stage rule stands.
 */
export function heldSaleKey(held: string | null, atStart: boolean, named: string | null | undefined): string | null {
  return atStart ? named ?? null : held;
}

/** `heldSaleKey` kept for the life of the screen, and current on the very render a new first screen arrives. */
export function useHeldSaleKey(atStart: boolean, named: string | null | undefined): string | null {
  const held = useRef<string | null>(null);
  held.current = heldSaleKey(held.current, atStart, named);
  return held.current;
}
