import { newId, type FamilyOnlineChild } from '@oto/shared';
import { slotAge, type SupervisedSlot } from '@/components/till/SupervisionGate';

/**
 * SCRUM-1011 — WHAT THE BOOKING SITE SENDS TO SAVE A RETURNING FAMILY'S
 * CHANGES TO THEIR RECORD (the owner's ruling of 18 and 19 November).
 *
 * Pure, so the page (`pages/Book.tsx`) and its tests read one rule:
 *   - the family pass a passed code check answered is sent only while it is
 *     live (with a minute's margin for the trip), so a pass that has run out
 *     is never the reason a booking is refused;
 *   - every child on the booking that is named and aged is sent: a child that
 *     came from the record by its `savedChildId`, a child the family adds by
 *     an id this page mints once per place (so a second confirm is the same
 *     child, not a second one);
 *   - the booking's supervised lines name the saved child each place is, only
 *     with a live pass (the platform refuses an id without one).
 */

export interface FamilyPass {
  pass: string;
  expiresAt: string;
}

/** A minute's margin: a pass that runs out on the way is treated as gone. */
const PASS_MARGIN_MS = 60_000;

/** The pass to send, or null when there is none or it has run out. */
export function livePass(pass: FamilyPass | null, now: number = Date.now()): string | null {
  if (!pass) return null;
  const ends = Date.parse(pass.expiresAt);
  return Number.isFinite(ends) && ends - PASS_MARGIN_MS > now ? pass.pass : null;
}

/** The oldest age a supervised child is booked at online (the platform's own ceiling). */
const MAX_ONLINE_CHILD_AGE = 17;

/**
 * The children to save at the parent's confirm, and the ids minted for the new
 * ones (by place). `minted` is the page's own record of ids it already minted:
 * a place keeps its id across confirms until it is pointed at another child.
 */
export function familySaveChildren(
  slots: readonly SupervisedSlot[],
  minted: Readonly<Record<string, string>>,
  mint: () => string = newId,
): { children: FamilyOnlineChild[]; minted: Record<string, string> } {
  const next: Record<string, string> = { ...minted };
  const children: FamilyOnlineChild[] = [];
  for (const slot of slots) {
    const name = slot.name.trim();
    const age = slotAge(slot);
    if (!name || age === null || age > MAX_ONLINE_CHILD_AGE) continue;
    const details = {
      name,
      dateOfBirth: slot.dateOfBirth ?? null,
      ageYears: age,
      allergies: slot.allergiesMedical ?? '',
      foodRestrictions: slot.foodRestrictions ?? '',
    };
    if (slot.savedChildId) {
      children.push({ savedChildId: slot.savedChildId, ...details });
      continue;
    }
    const id = next[slot.id] ?? mint();
    next[slot.id] = id;
    children.push({ newChildId: id, ...details });
  }
  return { children, minted: next };
}

/**
 * After a confirm the platform holds the new children: each place that added
 * one now names it, as a place pre-filled from the record does.
 */
export function linkSavedChildren(
  slots: readonly SupervisedSlot[],
  minted: Readonly<Record<string, string>>,
  saved: ReadonlySet<string>,
): Array<{ slotId: string; savedChildId: string }> {
  return slots.flatMap((slot) => {
    const id = minted[slot.id];
    return !slot.savedChildId && id && saved.has(id) ? [{ slotId: slot.id, savedChildId: id }] : [];
  });
}

/** The saved child a supervised booking line names, when the page holds a live pass. */
export function bookingLineSavedChildId(
  slot: Pick<SupervisedSlot, 'savedChildId'> | undefined,
  pass: string | null,
): { savedChildId: string } | Record<string, never> {
  return pass && slot?.savedChildId ? { savedChildId: slot.savedChildId } : {};
}
