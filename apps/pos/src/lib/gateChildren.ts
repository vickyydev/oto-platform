import type { ApiChild } from '@/api/platform';
import { apiChildToSavedChild } from '@/api/mappers';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import { ageFromDob } from '@/lib/childDob';
import type { Member, SavedChild } from '@/types';

/**
 * THE "CHILDREN PLAYING ALONE" GATE'S WRITES TO THE GUARDIAN'S PROFILE.
 *
 * SCRUM-233 put the gate's children on the member API — the same
 * `POST /members/:id/children` / `PATCH` the membership check makes, both
 * audited server-side. SCRUM-871 and SCRUM-872 make those writes converge:
 * however many times Continue is pressed, and whether the guardian was on the
 * sale from the start or first learned at the form, the profile holds each
 * child once.
 *
 *   - One child id per slot, minted once per gate by the till (`childIdFor`)
 *     and sent on every create, so a retry after a lost answer replays the
 *     record the platform already wrote instead of inserting another.
 *   - A slot not linked to a saved child is matched to the guardian's saved
 *     child with the same name and the same date of birth (or age) first,
 *     and corrected rather than added — never a guess when two could match.
 *   - Each child written goes back onto the guardian in hand (`onSaved`,
 *     named by the guardian's id) and onto the local copy the loop keeps, so
 *     the next slot and the next press see it.
 *
 * A failure part-way through a group throws and leaves the children already
 * written standing: they are records on the member, each one audited, and the
 * retry finds them by their slot's `savedChildId` (or their minted id) and
 * corrects them rather than entering them twice.
 */

/** A supervised slot with its age on the visit date, as `slotAge` reads it. */
export interface GateChildSlot {
  slot: SupervisedSlot;
  age: number;
}

/**
 * THE CHILD RECORD THE GATE SAVES (SCRUM-233).
 *
 * The membership check's child form writes to the member API: a record with
 * an audit row, visible to every till and to the admin. The prototype's gate
 * pushed the same fields into the browser's copy of the member, where they
 * were gone on the next reload. Nothing on either screen said which one you
 * were on.
 *
 * Only what the gate actually captures is sent: a name, an age (a real date
 * of birth when the picker was used), the allergy/medical line and the
 * dietary restriction. The medical ALERT is deliberately not sent — the gate
 * has no switch for it, and the API raises it from the allergy text, which is
 * the answer the counter wants when nobody chose otherwise (see
 * ChildDetailsFields, where the switch exists and is therefore sent).
 */
export const gateChildBody = (slot: SupervisedSlot, age: number): Record<string, unknown> => ({
  name: slot.name.trim(),
  dateOfBirth: slot.dateOfBirth ?? null,
  ageYears: age,
  allergies: slot.allergiesMedical.trim() || null,
  foodRestrictions: slot.foodRestrictions.trim() || null,
});

/**
 * What actually changed against the saved record — or null when nothing did.
 *
 * Only changed fields go in, for the reason `childDetailsPatch` gives: a
 * PATCH that names a field sets it, so re-sending the whole slot would
 * overwrite the medical notes and the staff notes this gate cannot even
 * show, and would fill the audit row's before/after with fields nobody
 * touched.
 */
export const gateChildPatch = (
  slot: SupervisedSlot,
  age: number,
  saved: SavedChild,
): Record<string, unknown> | null => {
  const patch: Record<string, unknown> = {};
  const name = slot.name.trim();
  if (name && name !== saved.childName.trim()) patch.name = name;
  if ((slot.dateOfBirth ?? '') !== (saved.dateOfBirth ?? '')) {
    patch.dateOfBirth = slot.dateOfBirth ?? null;
    patch.ageYears = age;
  } else if (age !== saved.childAge) {
    patch.ageYears = age;
  }
  const allergies = slot.allergiesMedical.trim();
  if (allergies !== (saved.allergiesMedical ?? '').trim()) patch.allergies = allergies || null;
  // The slot's dietary box is pre-filled from food restrictions FALLING BACK
  // to the dietary line (slotPatchFromSavedChild), so it is compared against
  // the same fallback — otherwise every confirm of an untouched child would
  // write a copy of their dietary line into their food restrictions.
  const food = slot.foodRestrictions.trim();
  if (food !== (saved.foodRestrictions ?? saved.dietary ?? '').trim()) {
    patch.foodRestrictions = food || null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
};

const nameKey = (name: string): string => name.trim().toLowerCase();

/**
 * SCRUM-872 — the patch for a typed slot MATCHED to a saved child by name,
 * which never clears anything.
 *
 * `gateChildPatch` reads a blank field as a deliberate clear, which is right
 * for a slot the saved-children review pre-filled from the record: staff saw
 * the allergy and removed it. A slot matched by name and age was never
 * pre-filled — the parent typed the child afresh, and a box left blank says
 * nothing about the record. Clearing it would take a child's allergy (and
 * with it the API's medical alert) off the profile of a child being left in
 * the park's care. So only what the slot ADDS goes in: a date of birth the
 * slot has and the record lacks or differs on, an allergy or a food
 * restriction the slot has that differs from the record's. The name matched
 * already (trimmed, case-insensitive) and is never rewritten for its casing.
 *
 * Whether a typed allergy should replace the saved one (as here, through the
 * existing update path) or be added to it is an owner question.
 */
export const gateChildMergePatch = (
  slot: SupervisedSlot,
  age: number,
  saved: SavedChild,
): Record<string, unknown> | null => {
  const patch: Record<string, unknown> = {};
  const name = slot.name.trim();
  if (name && nameKey(name) !== nameKey(saved.childName)) patch.name = name;
  if (slot.dateOfBirth) {
    if (slot.dateOfBirth !== saved.dateOfBirth) {
      patch.dateOfBirth = slot.dateOfBirth;
      patch.ageYears = age;
    }
  } else if (!saved.dateOfBirth && age !== saved.childAge) {
    patch.ageYears = age;
  }
  const allergies = slot.allergiesMedical.trim();
  if (allergies && allergies !== (saved.allergiesMedical ?? '').trim()) patch.allergies = allergies;
  const food = slot.foodRestrictions.trim();
  if (food && food !== (saved.foodRestrictions ?? saved.dietary ?? '').trim()) patch.foodRestrictions = food;
  return Object.keys(patch).length > 0 ? patch : null;
};

/** The member with this child on it: replaced when it is already there, appended when not. */
export function withSavedChild<M extends Pick<Member, 'savedChildren'>>(guardian: M, child: SavedChild): M {
  const children = guardian.savedChildren ?? [];
  return {
    ...guardian,
    savedChildren: children.some((c) => c.id === child.id)
      ? children.map((c) => (c.id === child.id ? child : c))
      : [...children, child],
  };
}

/** Why a slot that looked like a saved child was entered as new instead. */
export type GateMatchReason = 'several_saved' | 'several_slots';

export interface GateMatch {
  /** The saved child each unlinked slot is the one match for, by slot id. */
  matched: Map<string, SavedChild>;
  /** Slots that could have matched but where a guess would have been needed. */
  unmatched: { slotId: string; name: string; reason: GateMatchReason }[];
}

/**
 * SCRUM-872 — which saved child a typed child IS.
 *
 * The saved-children review (step 8) links a slot to a saved child before the
 * gate opens, but only for a member on the sale when the gate opens. A
 * guardian the form's number finds afterwards (the step-1 lookup failed, or
 * the family typed a different, known number — SCRUM-863) has saved children
 * nothing linked. So, for a slot with no `savedChildId`: the saved child with
 * the same name (trimmed, case-insensitive) and the same date of birth when
 * both have one, otherwise the same age today. A saved child another slot is
 * linked to is not offered. Two saved children that both match, or two slots
 * that match the same saved child: no guess — those slots are entered as new,
 * and said.
 */
export function matchSlotsToSavedChildren(
  slots: readonly GateChildSlot[],
  savedChildren: readonly SavedChild[],
  asOf: Date = new Date(),
): GateMatch {
  const linked = new Set(slots.map(({ slot }) => slot.savedChildId).filter((id): id is string => !!id));
  const candidates = savedChildren.filter((c) => !linked.has(c.id));
  const fits = (slot: SupervisedSlot, age: number, saved: SavedChild): boolean => {
    if (!slot.name.trim() || nameKey(slot.name) !== nameKey(saved.childName)) return false;
    if (slot.dateOfBirth && saved.dateOfBirth) return slot.dateOfBirth === saved.dateOfBirth;
    const savedAge = saved.dateOfBirth ? ageFromDob(saved.dateOfBirth, asOf) : saved.childAge;
    return savedAge === age;
  };

  const matched = new Map<string, SavedChild>();
  const unmatched: GateMatch['unmatched'] = [];
  const single = new Map<string, { slot: SupervisedSlot; saved: SavedChild }>();
  for (const { slot, age } of slots) {
    if (slot.savedChildId) continue;
    const fitting = candidates.filter((c) => fits(slot, age, c));
    if (fitting.length === 0) continue;
    if (fitting.length > 1) {
      unmatched.push({ slotId: slot.id, name: slot.name.trim(), reason: 'several_saved' });
      continue;
    }
    single.set(slot.id, { slot, saved: fitting[0]! });
  }
  const claims = new Map<string, number>();
  for (const { saved } of single.values()) claims.set(saved.id, (claims.get(saved.id) ?? 0) + 1);
  for (const [slotId, { slot, saved }] of single) {
    if ((claims.get(saved.id) ?? 0) > 1) {
      unmatched.push({ slotId, name: slot.name.trim(), reason: 'several_slots' });
    } else {
      matched.set(slotId, saved);
    }
  }
  return { matched, unmatched };
}

export interface SaveGateChildrenInput {
  /** The member the children belong to: on the sale, or found or created from the form's number. */
  guardian: Member;
  /** The supervised slots with an age, in the order the gate shows them. */
  slots: readonly GateChildSlot[];
  /** The visit date the ages are read on (tests pass one). */
  asOf?: Date;
  /** One stable child id per slot, minted once per gate and re-sent on every press. */
  childIdFor: (slotId: string) => string;
  /**
   * The slots this gate matched to a saved child by name (slot id → saved
   * child id), held by the till for the life of the gate and filled by the
   * loop. `onSaved` links a matched slot like any other, so on a retry it
   * looks pre-filled; this keeps it on the never-clearing merge patch, which
   * a blank box typed afresh needs on every press, not only the first.
   */
  matchedSlots: Map<string, string>;
  addChild: (memberId: string, body: Record<string, unknown>, id: string) => Promise<{ child: ApiChild }>;
  updateChild: (childId: string, patch: Record<string, unknown>) => Promise<{ child: ApiChild }>;
  /**
   * A child the API has answered with, one at a time: the till puts it on the
   * member in hand (named by `guardianId`, never whatever its state holds)
   * and links the slot to it, so a failure on the NEXT child leaves this one
   * found on the retry.
   */
  onSaved: (slotId: string, child: SavedChild, guardianId: string) => void;
}

export interface SaveGateChildrenResult {
  /** The guardian with every child written on it. */
  guardian: Member;
  /** The saved record each slot became, for the registration. */
  childIdBySlot: Map<string, string>;
  /** The same ids in slot order, for the visit. */
  confirmedChildIds: string[];
  unmatched: GateMatch['unmatched'];
}

/**
 * The gate's loop: each supervised child saved to the guardian's profile
 * exactly once. Throws on the first failure, with everything written so far
 * already handed back through `onSaved`.
 */
export async function saveGateChildren(input: SaveGateChildrenInput): Promise<SaveGateChildrenResult> {
  let guardian = input.guardian;
  const { matched, unmatched } = matchSlotsToSavedChildren(input.slots, guardian.savedChildren ?? [], input.asOf);
  const childIdBySlot = new Map<string, string>();
  const confirmedChildIds: string[] = [];
  for (const { slot, age } of input.slots) {
    const byName = matched.get(slot.id);
    if (byName) input.matchedSlots.set(slot.id, byName.id);
    const linkedId = slot.savedChildId ?? byName?.id;
    const saved = linkedId ? guardian.savedChildren?.find((c) => c.id === linkedId) : undefined;
    let child: SavedChild;
    if (linkedId && saved) {
      const patch =
        input.matchedSlots.get(slot.id) === linkedId
          ? gateChildMergePatch(slot, age, saved)
          : gateChildPatch(slot, age, saved);
      child = patch ? apiChildToSavedChild((await input.updateChild(linkedId, patch)).child) : saved;
    } else {
      // The photo is deliberately NOT saved (re-taken each visit). The same
      // id again answers with the record as it was first written — so what
      // the slot says now is applied to it, as it is to a linked child.
      const created = apiChildToSavedChild(
        (await input.addChild(guardian.id, gateChildBody(slot, age), input.childIdFor(slot.id))).child,
      );
      const patch = gateChildPatch(slot, age, created);
      child = patch ? apiChildToSavedChild((await input.updateChild(created.id, patch)).child) : created;
    }
    guardian = withSavedChild(guardian, child);
    input.onSaved(slot.id, child, guardian.id);
    confirmedChildIds.push(child.id);
    childIdBySlot.set(slot.id, child.id);
  }
  return { guardian, childIdBySlot, confirmedChildIds, unmatched };
}
