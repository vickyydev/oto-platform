/**
 * SCRUM-857 / SCRUM-875 — THE FAMILY'S DONE ON THE DROP-OFF AND NANNY FORM.
 *
 * The owner's ruling of 8 November: "The flow no longer needs staff
 * verification. Once the customer has filled in all the information, passed
 * all checks and clicked Done, they proceed to the next step without
 * receptionist confirmation." So the family's Done is what writes the
 * registration and moves the sale on, on the till's own customer half and on
 * a paired display alike, through the same gate the staff's "Continue to
 * payment" runs.
 *
 * Two pure pieces live here, so the till, its customer half and the display
 * all decide the same way:
 *
 * - `consentMissing` — what is still missing before Done can be pressed, in
 *   the order the form asks for it, so the family's screen can say so in a
 *   short line (SCRUM-875) instead of a Done that is simply grey.
 * - `familyDoneDecision` — whether a Done that reached the till is honoured:
 *   only for the sale and the form it was pressed on, only while the till is
 *   still on that form, and only when every check passes. Anything else
 *   leaves the till where it is; the family's screen is shown the form again,
 *   or whatever the till has moved on to.
 */

/** One thing still missing before the family can press Done, in the form's order. */
export type ConsentMissing = 'children' | 'guardian_name' | 'consent' | 'confirmations' | 'contact' | 'photo';

export interface ConsentFinishInput {
  /** Every child on the form: named and aged, or not yet. */
  children: readonly { name: string; ageYears: number | null }[];
  /** A child needs supervision, so a registration will be written and the consent is asked. */
  consentRequired: boolean;
  guardianName: string;
  consentAcknowledged: boolean;
  confirmations: readonly { required: boolean; acknowledged: boolean }[];
  /**
   * The number confirmation (SCRUM-857 part 1), when the form asks it: given
   * for the number and channel on the form, and whether the number can take
   * messages at all. Absent on a form that does not ask.
   */
  contact?: { confirmed: boolean; problem: 'empty' | 'invalid' | null };
  /** Every child who needs supervision has their photo with the guardian. */
  photosTaken: boolean;
}

/** What still stands between the family and Done, in the order the form asks for it; empty when nothing does. */
export function consentMissing(input: ConsentFinishInput): ConsentMissing[] {
  const missing: ConsentMissing[] = [];
  if (!input.children.every((child) => child.name.trim().length > 0 && child.ageYears !== null)) missing.push('children');
  if (input.consentRequired && !input.guardianName.trim()) missing.push('guardian_name');
  if (input.consentRequired && !input.consentAcknowledged) missing.push('consent');
  if (!input.confirmations.every((item) => !item.required || item.acknowledged)) missing.push('confirmations');
  if (input.consentRequired && input.contact && (input.contact.problem !== null || !input.contact.confirmed)) missing.push('contact');
  if (input.consentRequired && !input.photosTaken) missing.push('photo');
  return missing;
}

/** The dictionary key of each missing item, as the family's screen names it. */
export const CONSENT_MISSING_KEY: Record<ConsentMissing, string> = {
  children: 'superviseConsent.missingChildren',
  guardian_name: 'superviseConsent.missingGuardianName',
  consent: 'superviseConsent.missingConsent',
  confirmations: 'superviseConsent.missingConfirmations',
  contact: 'superviseConsent.missingContact',
  photo: 'superviseConsent.missingPhoto',
};

/**
 * The short line under the form: "Still needed before Done: …", each item in
 * the family's language. Null when nothing is missing.
 */
export function consentMissingLine(
  t: (key: string, vars?: Record<string, string | number>) => string,
  missing: readonly ConsentMissing[],
  channel: string,
): string | null {
  if (missing.length === 0) return null;
  const list = missing.map((item) => t(CONSENT_MISSING_KEY[item], { channel })).join(' · ');
  return t('superviseConsent.stillNeeded', { list });
}

export interface FamilyDoneInput {
  /** The till is on the drop-off and nanny form (the supervision step). */
  onForm: boolean;
  /** The Done names the sale, the family and the form revision the till shows now. */
  sameForm: boolean;
  /** The gate is already writing (a Done or a staff Continue before this one). */
  saving: boolean;
  /** Every check the staff's Continue makes passes on the till's own copy of the form. */
  ready: boolean;
}

/**
 * `move_on` — write the registration and move to what follows, as the staff's
 * Continue would. `ignore` — a Done for a sale, a family or a form the till
 * is no longer on (staff went back, the sale was abandoned, another started,
 * the form changed after it was pressed): nothing is written and the till is
 * not moved. `wait` — the right form, but a check the till makes is not met
 * (or a write is already running): the form is kept finished on the family's
 * screen and staff finish it on the till, as before.
 */
export function familyDoneDecision(input: FamilyDoneInput): 'move_on' | 'ignore' | 'wait' {
  if (!input.onForm || !input.sameForm) return 'ignore';
  if (input.saving || !input.ready) return 'wait';
  return 'move_on';
}
