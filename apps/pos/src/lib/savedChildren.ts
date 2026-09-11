import type { SavedChild } from '@/types';
import type { SavedChildInput } from '@/mockApi';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { ageFromDob } from '@/lib/childDob';

// Pure mapping seam between a member's SavedChild profiles and the per-visit
// SupervisedSlot draft. Keeps the pre-fill / save-back logic out of the page
// components so the Till door flow and the Book flow share ONE implementation.
//
// PRIVACY: the photo is deliberately NOT part of this mapping — it is always
// re-taken on the slot each visit and never written to a SavedChild.

// Pre-fill a slot from a saved child: copies the reusable fields and links the
// slot back to the saved child (savedChildId) so capture UPDATES it rather than
// adding a duplicate. The photo is intentionally cleared — re-taken every visit.
export function slotPatchFromSavedChild(child: SavedChild): Partial<SupervisedSlot> {
  // When a DOB is on file the age is RE-DERIVED against today, so a child saved
  // last visit pre-fills with their current age (and current supervision band) —
  // never the stale snapshot. Legacy records without a DOB fall back to childAge.
  const derivedAge = child.dateOfBirth ? ageFromDob(child.dateOfBirth) : null;
  return {
    savedChildId: child.id,
    name: child.childName,
    dateOfBirth: child.dateOfBirth,
    age: String(derivedAge ?? child.childAge),
    allergiesMedical: child.allergiesMedical ?? '',
    foodRestrictions: child.foodRestrictions ?? child.dietary ?? '',
    childPhotoUrl: undefined,
  };
}

// Build the saved-child input from a captured slot (everything except the photo).
// The DOB rides along so age stays derivable on the next visit.
export function savedChildInputFromSlot(
  slot: SupervisedSlot,
  age: number,
): SavedChildInput {
  return {
    childName: slot.name.trim(),
    childAge: age,
    dateOfBirth: slot.dateOfBirth,
    allergiesMedical: slot.allergiesMedical || undefined,
    foodRestrictions: slot.foodRestrictions || undefined,
  };
}

// Auto-assign saved children to the available slots in order (slot[i] <- saved[i])
// as the initial pre-fill. Slots beyond the saved-children count stay blank (new
// children); saved children beyond the slot count are simply not pre-filled here
// (the review UI still lists them so the parent can swap one in). Returns a NEW
// array of slots; never mutates the input.
export function prefillSlots(
  slots: SupervisedSlot[],
  savedChildren: SavedChild[],
): SupervisedSlot[] {
  return slots.map((slot, i) => {
    const child = savedChildren[i];
    return child ? { ...slot, ...slotPatchFromSavedChild(child) } : slot;
  });
}
