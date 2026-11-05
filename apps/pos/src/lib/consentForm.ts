import type { FilledConsentSlot } from '@oto/shared';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';

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
