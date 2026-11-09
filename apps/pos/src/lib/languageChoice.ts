import { useCallback, useEffect, useState } from 'react';

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
 *   - the sale changed (`saleKey`): the till's own customer half knows its sale,
 *     and a completed, cancelled or held sale starts the next one
 *     (`resetSale`), the same moment the display goes back to its first screen;
 *   - or the screen came back to the first screen from any other: a paired
 *     display is told the till's stage and not its sale, and on the ticket till
 *     the phone-number step is only ever the first screen of a sale.
 *
 * Moving on from the first screen and on through the sale keeps the choice;
 * staying on the first screen keeps it too, so a guest who chose and is typing
 * their number is never asked again.
 */
export interface LanguageChoiceState {
  /** The guest at this screen chose their language. */
  chosen: boolean;
  /** The screen has been somewhere other than the first screen since that choice. */
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
  return atStart && (!state.chosen || state.leftStart || state.saleKey !== saleKey);
}

/** The state after the screen settles on `atStart` in sale `saleKey`; the same object when nothing changed. */
export function settleLanguageChoice(state: LanguageChoiceState, atStart: boolean, saleKey: string | null = null): LanguageChoiceState {
  const current = state.saleKey === saleKey ? state : languageChoiceStart(saleKey);
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
