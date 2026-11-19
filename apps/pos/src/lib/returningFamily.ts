import type { CartLine, Member, SavedChild, SupervisionPolicy } from '@/types';
import { slotAge, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { prefillSlots } from '@/lib/savedChildren';
import { resolveGroupRequirements } from '@/lib/supervision';

/**
 * SCRUM-1018 — A RETURNING FAMILY IN THREE STEPS (the owner's answers of 19
 * November, docs/progress/plans/dropoff-beo-20261119/ANSWERS.md §2): the
 * phone number, the saved children with ticks, the three agreements, pay.
 * Nothing typed twice. The till's rules for it, pure, so the till and its
 * tests read one copy.
 */

/**
 * The saved children staff ticked as visiting at the membership check
 * (`VisitChildrenModal`), in the saved list's order. Null when the check was
 * skipped ("Skip for now"): the gate then fills its places as it always has.
 */
export function visitingChildren(saved: readonly SavedChild[], ticked: readonly string[] | null): SavedChild[] | null {
  if (ticked === null) return null;
  const chosen = new Set(ticked);
  return saved.filter((child) => chosen.has(child.id));
}

export interface GatePrefill {
  slots: SupervisedSlot[];
  /** Places already confirmed: a ticked child staff confirmed at the membership check. */
  confirmedIds: string[];
  /** The saved-children review (step 8) is still needed: a place is empty or not yet confirmed. */
  review: boolean;
}

/**
 * THE TICKED CHILDREN DECIDE. The gate's places are filled from the children
 * staff ticked as visiting, in order, instead of the saved list in its order
 * (which put saved child 1, 2, 3 in places 1, 2, 3 whoever came). A ticked
 * child was confirmed by staff at the check (each edit saved and audited, the
 * visit opened), so its place starts confirmed and the family is not asked
 * "still correct?" again. When every place is a ticked child the review is
 * skipped and the form follows; a place left for a new child (more kids on
 * the ticket than ticked) still opens the review, as before. Unticking a child
 * asks no reason (as today). With no saved children there is no review (a
 * first visit), and with the check skipped the review runs as it always did.
 */
export function prefillGate(
  slots: readonly SupervisedSlot[],
  saved: readonly SavedChild[],
  ticked: readonly string[] | null,
): GatePrefill {
  if (saved.length === 0) return { slots: [...slots], confirmedIds: [], review: false };
  const visiting = visitingChildren(saved, ticked);
  if (visiting === null) return { slots: prefillSlots([...slots], [...saved]), confirmedIds: [], review: true };
  const filled = prefillSlots([...slots], visiting);
  const confirmedIds = filled
    .filter((slot) => {
      const age = slotAge(slot);
      return !!slot.savedChildId && slot.name.trim().length > 0 && age !== null && age <= 17;
    })
    .map((slot) => slot.id);
  return { slots: filled, confirmedIds, review: filled.some((slot) => !confirmedIds.includes(slot.id)) };
}

/**
 * The kids on a ticket line staff pick for this family: as many as they
 * ticked as visiting, on the first line that carries children; one, as
 * before, on any later line, with no ticks, or with the check skipped.
 */
export function ticketKidsDefault(lines: readonly Pick<CartLine, 'kids'>[], ticked: readonly string[] | null): number {
  if (!ticked || ticked.length === 0) return 1;
  if (lines.some((line) => line.kids > 0)) return 1;
  return ticked.length;
}

/**
 * The parent's name on the drop-off and nanny forms, from the family's
 * profile: a member the membership check found, by the name the till knows
 * them by. Null for a first visit (no member, or one created on this sale:
 * that family's form keeps every step it has today) and for a profile with no
 * name, where the form asks for it as before. Staff can still correct it on
 * the till (Private child details).
 */
export function profileGuardianName(member: Pick<Member, 'id' | 'nickname'> | null, createdMemberId: string | null): string | null {
  if (!member || member.id === createdMemberId) return null;
  const name = member.nickname.trim().slice(0, 100);
  return name || null;
}

/**
 * AFTER A WAIVER (the owner's answer of 19 November). When staff waive a
 * younger child's supervision because an older sibling covers them, that
 * sibling plays on a normal ticket: no free drop-off form for them, and the
 * till goes on to payment. The waiver rule itself is unchanged: the covering
 * sibling is, as it always was, the oldest OTHER child old enough to act as
 * guardian (`siblingWaiver.guardianMinAge`), and only a child waived down from
 * a real requirement is covered. Answers each waived child's covering slot.
 */
export function waiverCovers<Slot extends Pick<SupervisedSlot, 'id' | 'age' | 'dateOfBirth' | 'waived'>>(
  slots: readonly Slot[],
  policy: SupervisionPolicy,
): Map<string, Slot> {
  const aged = slots.flatMap((slot) => {
    const age = slotAge(slot);
    return age === null ? [] : [{ id: slot.id, age }];
  });
  const requirement = new Map(resolveGroupRequirements(aged, policy).map((item) => [item.id, item.requirement]));
  const covers = new Map<string, Slot>();
  for (const slot of slots) {
    if (!slot.waived || (requirement.get(slot.id) ?? 'none') === 'none') continue;
    const covering = slots
      .filter((other) => other.id !== slot.id && (slotAge(other) ?? -1) >= policy.siblingWaiver.guardianMinAge)
      .sort((a, b) => (slotAge(b) ?? 0) - (slotAge(a) ?? 0))[0];
    if (covering) covers.set(slot.id, covering);
  }
  return covers;
}

/**
 * The till's gate registers every child playing alone through the full
 * drop-off flow, free for one who needs no supervision (`optIn`). A sibling
 * covering a waived child is the exception: a plain ticket. Run after every
 * change of the gate's children, so the opt-in follows the waivers.
 */
export function withCoveringSiblingsPlain<Slot extends Pick<SupervisedSlot, 'id' | 'age' | 'dateOfBirth' | 'waived' | 'optIn'>>(
  slots: readonly Slot[],
  policy: SupervisionPolicy,
): Slot[] {
  const covering = new Set([...waiverCovers(slots, policy).values()].map((slot) => slot.id));
  return slots.map((slot) => {
    const optIn = !covering.has(slot.id);
    return slot.optIn === optIn ? slot : { ...slot, optIn };
  });
}

/** The last visit's photo of a saved child, as the till found it. */
export type LastPhotoState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'found'; checkinId: string; fileId: string; takenAt: string; url: string };

/**
 * THE PHOTO IS STAFF'S TO DECIDE (the owner's answer of 19 November). A saved
 * child whose last visit's photo is still kept: staff see it on the till with
 * "Still matches" or "Take a new one", and the family is not asked for a photo
 * meanwhile (`awaits`), nor once staff reuse it (`reused`). After "Take a new
 * one", or for a child with no earlier photo, the photo is taken as today.
 * Only the answer given for the child now in the place counts.
 */
export function slotPhotoState(
  slot: Pick<SupervisedSlot, 'savedChildId' | 'childPhotoUrl' | 'lastPhotoChoice'>,
  lastPhotos: Readonly<Record<string, LastPhotoState>>,
): 'awaits' | 'reused' | 'today' {
  const childId = slot.savedChildId;
  if (!childId) return 'today';
  const choice = slot.lastPhotoChoice?.childId === childId ? slot.lastPhotoChoice.choice : null;
  if (slot.childPhotoUrl?.startsWith('data:')) return 'today';
  if (choice === 'matches' && slot.childPhotoUrl) return 'reused';
  if (choice === 'new' || slot.childPhotoUrl) return 'today';
  const last = lastPhotos[childId];
  return last?.status === 'loading' || last?.status === 'found' ? 'awaits' : 'today';
}

/** The earlier stay whose photo this child's new stay reuses, when staff said it still matches. */
export function photoReuseFor(
  slot: Pick<SupervisedSlot, 'childPhotoUrl' | 'lastPhotoChoice'>,
  childId: string | undefined,
): string | null {
  const choice = slot.lastPhotoChoice;
  if (!childId || !choice || choice.choice !== 'matches' || choice.childId !== childId) return null;
  if (!slot.childPhotoUrl || slot.childPhotoUrl.startsWith('data:')) return null;
  return choice.fromCheckinId;
}

/**
 * A returning family's form is the agreements alone: the parent's name from
 * their profile, and every child on it from their saved profile. A new child
 * on the form, or a first visit, keeps the three steps.
 */
export function agreementsOnlyForm(input: { guardianFromProfile: boolean; slots: readonly Pick<SupervisedSlot, 'savedChildId'>[] }): boolean {
  return input.guardianFromProfile && input.slots.length > 0 && input.slots.every((slot) => !!slot.savedChildId);
}
