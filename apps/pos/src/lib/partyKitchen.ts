import {
  PARTY_NOT_ON_TILL_MENU,
  partyAdultsNoteMark,
  type PartyKitchenPlan,
  type PartyPlanBarItem,
  type PartyPlanMenuItem,
} from '@oto/shared';
import type { PartyBooking } from '@/types';

/**
 * SCRUM-906 — THE WHOLE KITCHEN PLAN ON THE PARTY PAGE (the owner's decisions
 * of 12 November): every line of the BEO's kitchen plan with the marks the
 * kitchen slip prints beside it, the bar's lines, and the cake as the BEO's
 * cake choice says it. One place for the words, so the desk page and the
 * phone page say the same thing as the slip.
 */

/** How often an open party page reads the plan again, besides on focus. */
export const PARTY_PLAN_REFRESH_MS = 60_000;

/** A food line as the party page names it: the dish, the chosen option, its note, and the slip's marks. */
export function partyMenuLineLabel(m: PartyPlanMenuItem): string {
  const marks = [
    m.chosenOption ? m.chosenOption : null,
    // SCRUM-967: the line's note ("no sauce"), as the bar's label carries its own.
    m.note?.trim() || null,
    // SCRUM-829: a line the BEO marks as the kids' only, the adults' own, or the adults' with another note.
    m.audience === 'kids' ? 'kids only' : m.audience === 'adults' ? 'adults' : null,
    m.adultsNote === undefined ? null : partyAdultsNoteMark(m.adultsNote),
    // SCRUM-906: typed by hand, or a code the till no longer sells (decision 1).
    m.onTillMenu === false && !(m.choiceGroup && !m.chosenOption) ? PARTY_NOT_ON_TILL_MENU : null,
  ].filter((x): x is string => !!x);
  return [m.name, ...marks].join(' · ');
}

/** A bar line as the party page names it: the drink, its note, and whether the till sells it. */
export function partyBarLineLabel(b: PartyPlanBarItem): string {
  const marks = [b.note?.trim() || null, b.onTillMenu === false ? PARTY_NOT_ON_TILL_MENU : null].filter(
    (x): x is string => !!x,
  );
  return [b.name, ...marks].join(' · ');
}

/** The cake in the till's own words (the prototype's `kitchen.cake`), from the BEO's cake choice. */
export function partyCakeOf(kitchen: Pick<PartyKitchenPlan, 'cake'>): PartyBooking['kitchen']['cake'] {
  const cake = kitchen.cake;
  if (!cake) return { type: 'none' };
  return {
    type: cake.type,
    qty: cake.qty,
    ...(cake.time ? { time: cake.time } : {}),
    ...(cake.note ? { note: cake.note } : {}),
  };
}

/** The cake row's heading, as the party page has always worded it. */
export function partyCakeLabel(cake: PartyBooking['kitchen']['cake']): string {
  return cake.type === 'none'
    ? 'No cake'
    : cake.type === 'own'
      ? 'Customer brings their own'
      : `Our cake${cake.qty ? ` ×${cake.qty}` : ''}`;
}
