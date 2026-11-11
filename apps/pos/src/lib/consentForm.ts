import { normalizePhone, type ConsentAction, type FilledConsentSlot } from '@oto/shared';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import type { ContactChannel } from '@/types';

/**
 * SCRUM-764 — A STEP OF THE DROP-OFF OR NANNY FORM, AS THE TILL TAKES IT IN.
 *
 * The family fills the form on the customer screen and each step arrives at
 * the till; this is what that step changes on the till's own copy of each
 * child, so the staff gate and the private details show it. Only children on
 * this form are touched. A child from the family's saved profile keeps the care
 * notes the profile holds: those are changed with staff, never from the public
 * screen. Nothing staff decide — the photo, the food choice, a waiver — is in
 * a filled step at all.
 */
export function consentSlotPatches(
  slots: readonly SupervisedSlot[],
  filled: readonly FilledConsentSlot[],
): { id: string; patch: Partial<SupervisedSlot> }[] {
  return filled.flatMap((child) => {
    const slot = slots.find((item) => item.id === child.id);
    if (!slot) return [];
    const patch: Partial<SupervisedSlot> = {
      name: child.name,
      dateOfBirth: child.dateOfBirth ?? undefined,
      age: child.ageYears === null ? '' : String(child.ageYears),
      ...(slot.savedChildId ? {} : { allergiesMedical: child.allergiesMedical, foodRestrictions: child.foodRestrictions }),
    };
    return [{ id: slot.id, patch }];
  });
}

/**
 * SCRUM-863 — the parent's number as the form sends it and the till keeps it:
 * the stored form when it reads as a number, what was typed when it does not
 * yet. The display and the till both use this, so the form the till publishes
 * back is the one the family's screen is waiting for.
 */
export function consentFormPhone(typed: string): string {
  const trimmed = typed.trim();
  return (normalizePhone(trimmed) ?? trimmed).slice(0, 32);
}

/**
 * The till's side of the form, as `takeConsentAction` changes it. The setters
 * are the till's own state; `answered` moves the customer screen on to a new
 * request (`TicketDisplayState.answerRevision`).
 */
export interface ConsentFormTill {
  /** The till's copy of each child, for a filled step's patches. */
  slots: readonly SupervisedSlot[];
  /** The parent's number the till holds for the registration: the one given at the start, until it is changed. */
  guardianPhone: string;
  /** The form as it is shown now, which a `done` marks finished. */
  signature: string;
  updateSlot: (id: string, patch: Partial<SupervisedSlot>) => void;
  setGuardianName: (name: string) => void;
  setGuardianPhone: (phone: string) => void;
  /** SCRUM-863 — the channel the check-in confirmation goes to, as the family chose it on the form. */
  setContactChannel: (channel: ContactChannel) => void;
  setConsentAcknowledged: (value: boolean) => void;
  setAcknowledgedConfirmationIds: (ids: string[]) => void;
  setCompletedSignature: (signature: string | null) => void;
  askedForHelp: () => void;
  answered: () => void;
}

/**
 * SCRUM-764 — AN ANSWER FROM THE FAMILY'S FORM, TAKEN IN BY THE TILL.
 *
 * The station keeps an answer on the customer's screen until the till
 * publishes the form under a new request, and the screen stays still while it
 * does ("please wait for the team"). A step that changes nothing on the till —
 * Back then Continue, the same date of birth chosen again — leaves the form as
 * it was, so nothing would republish it and the family's screen would wait for
 * ever. Every answer taken therefore ends with `answered`, which moves the
 * screen on to a new request whether or not the form changed.
 *
 * The caller has already checked the answer belongs to this form
 * (`consentActionAllowed`). The agreement ticks come only from here: staff's
 * copy of the form shows them and cannot change them while the family has it.
 */
export function takeConsentAction(action: ConsentAction, till: ConsentFormTill): void {
  if (action.action === 'staff_help') till.askedForHelp();
  else if (action.action === 'acknowledge') {
    till.setGuardianName(action.guardianName);
    till.setConsentAcknowledged(action.consentAcknowledged);
    till.setAcknowledgedConfirmationIds(action.acknowledgedConfirmationIds);
    till.setCompletedSignature(null);
  } else if (action.action === 'fill') {
    for (const { id, patch } of consentSlotPatches(till.slots, action.slots)) till.updateSlot(id, patch);
    till.setGuardianName(action.guardianName);
    // SCRUM-863 — the family confirms or changes their number and channel on
    // the form, and what they send is what the registration keeps: the stored
    // form of a number that reads as one, otherwise as typed, exactly as the
    // till's own copy of the form holds it (the registration refuses a number
    // that cannot be one). The customer's own number on the sale is not
    // touched. An older display sends a number only when none was given at the
    // start and never a channel: a step without either changes neither.
    if (action.guardianPhone !== undefined) {
      const phone = consentFormPhone(action.guardianPhone);
      if (phone !== till.guardianPhone.trim()) till.setGuardianPhone(phone);
    }
    if (action.contactChannel !== undefined) till.setContactChannel(action.contactChannel);
    till.setConsentAcknowledged(action.consentAcknowledged);
    till.setAcknowledgedConfirmationIds(action.acknowledgedConfirmationIds);
    till.setCompletedSignature(null);
  } else till.setCompletedSignature(till.signature);
  till.answered();
}

/**
 * SCRUM-764 — MAY STAFF TICK THE AGREEMENTS ON THEIR COPY OF THE FORM?
 *
 * Not while the family has the form on their own screen: the ticks are theirs,
 * and the till shows each one as ticked or not. When a display is paired but
 * cannot take the form — the till is working through the counter box with the
 * internet down, or the price is still being worked out — the family has no
 * screen to tick on, and staff go through the agreements with them on the till
 * as they did before the form moved to the display. Without that, nobody could
 * tick, and the child could not be registered until the connection came back.
 */
export function staffTicksAgreements(input: {
  /** The till is publishing the form to the paired display. */
  formPublished: boolean;
  displayConnected: boolean;
  displaySupported: boolean;
  displayError: boolean;
}): boolean {
  return !(input.formPublished && input.displayConnected && input.displaySupported && !input.displayError);
}
