/**
 * A rota row always has a shift group (S2-17b round 5, plan section 4, Q2 and
 * H15).
 *
 * `schedule_shift_rows.shift_group_id` is NOT NULL, here and in production
 * (`shared/schema.ts`, the baseline migration), and its foreign key refuses
 * deleting a group that still has rows. The app's routes did not say so: a row
 * created without a group, a row edited or dragged to "Ungrouped", and a group
 * deleted without saying where its rows go each reached the database with a
 * null group and came back as a bare 500 — the first time a manager tried to
 * add a shift on a branch with no groups yet, among them (the casual-worker
 * walkthrough of 1 October, `docs/qa/oto-app-lift/casual-workers.md`).
 *
 * Q2's default keeps the database's rule — a row needs a group — and puts it
 * in words at every door that would leave a row without one, before anything
 * is written. Nothing else about grouping changes: a row with a group, a move
 * between groups and a group deleted into another group all work as before.
 * Whether ungrouped rows should be allowed is Q2's open alternative (a
 * nullable column, and the booth roster skipping ungrouped rows).
 */

/** What a door answers when it would leave a rota row with no shift group. Nothing is written. */
export const SHIFT_GROUP_REQUIRED = {
  reason: "shift_group_required",
  message: "Choose a shift group first",
} as const;

/** What deleting a group that still has rows answers when it is not told where the rows go. */
export const SHIFT_GROUP_DELETE_NEEDS_TARGET = {
  reason: "shift_group_required",
  message: "Choose a shift group first: this group still has shifts, so pick the group to move them to.",
} as const;

/** True when a request's shift group would leave the row with none (absent, null or empty). */
export function noShiftGroup(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}
