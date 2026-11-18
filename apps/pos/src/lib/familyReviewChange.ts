import { DISPLAY_CHILD_MAX_AGE, childReviewAge, type ChildReviewAction } from '@oto/shared';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import type { SavedChild } from '@/types';

/**
 * SCRUM-1014 — WHO IS SAVED, CHANGED BY THE FAMILY ON THE PAIRED DISPLAY.
 *
 * The owner's ruling of 19 November (SCRUM-497, point 22): the parent adds
 * and removes children on the customer display, as the prototype's customer
 * screen lets them (`SavedChildrenReview.tsx`, Till.tsx `handleMarkNew`,
 * `handleRemoveSaved`). Three of the display's answers say so, and this is
 * what the till makes of each, read against the places and the family's
 * saved children it holds now — or null, when the answer no longer fits
 * them (the place moved on, the child is no longer the one in it):
 *
 *   - "+ A new child" (`select` with no choice): the place is emptied for a
 *     new child, as the prototype's `handleMarkNew` empties it.
 *   - "Remove from saved" (`remove`): the saved child comes off the family's
 *     record — archived, never deleted — and the place is emptied the same
 *     way, as the prototype's `handleRemoveSaved` does. The till carries the
 *     archive out (`childrenApi.archive`, the display named as the source).
 *   - a new child's name and age (`new_child`), up to 12 as the till's own
 *     picker offers: held in an empty place, and saved to the family's record
 *     with the visit's other children when the drop-off form is written.
 *
 * Allergies and medical notes are never on these answers: the display does
 * not show them, and a new child's are asked on the next screen.
 */
export type FamilyReviewChange =
  | { kind: 'mark_new'; slotId: string }
  | { kind: 'remove'; slotId: string; child: SavedChild }
  | { kind: 'name_new'; slotId: string; patch: Pick<SupervisedSlot, 'name' | 'dateOfBirth' | 'age'> };

export function familyReviewChange(
  action: ChildReviewAction,
  held: { slots: readonly Pick<SupervisedSlot, 'id' | 'savedChildId'>[]; savedChildren: readonly SavedChild[]; referenceDate: string },
): FamilyReviewChange | null {
  if (action.action !== 'select' && action.action !== 'remove' && action.action !== 'new_child') return null;
  const slot = held.slots.find((item) => item.id === action.slotId);
  if (!slot) return null;
  if (action.action === 'select') return action.choiceId === null ? { kind: 'mark_new', slotId: slot.id } : null;
  if (action.action === 'remove') {
    const child = slot.savedChildId === action.savedChildId
      ? held.savedChildren.find((item) => item.id === action.savedChildId) : undefined;
    return child ? { kind: 'remove', slotId: slot.id, child } : null;
  }
  const name = action.name.trim();
  if (slot.savedChildId || !name || action.ageYears > DISPLAY_CHILD_MAX_AGE
    || action.dateOfBirth !== null && childReviewAge(action.dateOfBirth, held.referenceDate) !== action.ageYears) return null;
  return { kind: 'name_new', slotId: slot.id,
    patch: { name, dateOfBirth: action.dateOfBirth ?? undefined, age: String(action.ageYears) } };
}

/** What the cashier is told above the review when the family made the change on the display. */
export function familyReviewChangeLine(change: FamilyReviewChange): string | null {
  if (change.kind === 'remove') return `The family removed ${change.child.childName} from their saved children on the customer display.`;
  if (change.kind === 'name_new') return `The family added a new child on the customer display: ${change.patch.name}, ${change.patch.age}.`;
  return null;
}
