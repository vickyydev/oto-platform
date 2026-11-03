/**
 * The checklist editor's branch wording and arithmetic (SCRUM-659, the owner's
 * ruling of 3 November 2026). Kept apart from the page so the rules can be read
 * and checked on their own.
 */

export type BranchBound = { branchId?: string | null; branchIds?: string[] | null };
export type NamedBranch = { id: string; name: string };
export type AddedBranchChoice = "copy" | "share";

/**
 * The branches a checklist runs at: its list, else its one branch. None means
 * every branch. A new checklist stores only its one branch and an empty list,
 * so an empty list here is not "no branches"; the server reads it the same way.
 */
export function checklistBranchIds(checklist: BranchBound): string[] {
  if (checklist.branchIds?.length) return checklist.branchIds;
  return checklist.branchId ? [checklist.branchId] : [];
}

/** Whether two branch lists name the same branches, in any order. */
export function sameBranches(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Which selected branches are new to this checklist. A checklist with no branch
 * already runs everywhere, so picking a branch on it narrows it rather than adds
 * to it: nothing is "added", and that edit stays as it is today.
 */
export function addedBranchIds(originalBranchIds: string[], selectedBranchIds: string[]): string[] {
  if (originalBranchIds.length === 0) return [];
  return selectedBranchIds.filter((id) => !originalBranchIds.includes(id));
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function nameOf(branches: NamedBranch[], id: string): string | undefined {
  return branches.find((branch) => branch.id === id)?.name;
}

/**
 * The note on a shared checklist. It names the other branches the person may
 * see, and only counts the rest. `visibleBranches` is what the person's own
 * branch list holds; "other" is other than the branch they are working in, when
 * the checklist is at that branch.
 *
 * A checklist on no branch always says so, however few branches the person has:
 * a manager with one branch cannot see the others, and their save still reaches
 * them. `selectedBranchIds` is what the save would send; picking a branch on such
 * a checklist takes it off the rest, as it always has.
 */
export function sharedChecklistNote({
  originalBranchIds,
  selectedBranchIds,
  visibleBranches,
  activeBranchId,
}: {
  originalBranchIds: string[];
  selectedBranchIds: string[];
  visibleBranches: NamedBranch[];
  activeBranchId: string | null;
}): string | null {
  if (originalBranchIds.length === 0) {
    return selectedBranchIds.length > 0
      ? "This is shared with all branches. Saving with a branch selected takes it off every other branch."
      : "This is shared with all branches. Changes apply to every branch.";
  }
  if (originalBranchIds.length === 1) return null;

  const others = activeBranchId && originalBranchIds.includes(activeBranchId)
    ? originalBranchIds.filter((id) => id !== activeBranchId)
    : originalBranchIds;
  const named = others.map((id) => nameOf(visibleBranches, id)).filter((name): name is string => !!name);
  const unnamed = others.length - named.length;
  const parts = [
    ...named,
    ...(unnamed > 0 ? [unnamed === 1 ? "1 other branch" : `${unnamed} other branches`] : []),
  ];
  const scope = originalBranchIds.length === 2 ? "both branches" : `all ${originalBranchIds.length} branches`;
  return `This is shared with ${joinNames(parts)}. Changes apply to ${scope}.`;
}

/**
 * The required question when a branch is added while editing. The two answers
 * the owner named are the wording for the common case. When the edit also takes
 * the checklist off every branch it was on, "share" is not what that answer
 * does, so it says what it does: the same thing an edit does today, a move.
 */
export function addedBranchQuestion({
  added,
  selectedBranchIds,
  originalBranchIds,
  branches,
}: {
  added: string[];
  selectedBranchIds: string[];
  originalBranchIds: string[];
  branches: NamedBranch[];
}): { question: string; copyLabel: string; copyHint: string; shareLabel: string; shareHint: string } {
  const names = joinNames(added.map((id) => nameOf(branches, id) ?? "This branch"));
  const keepsAny = selectedBranchIds.some((id) => originalBranchIds.includes(id));
  const originalNames = originalBranchIds.map((id) => nameOf(branches, id));
  const original = originalNames.every(Boolean) ? joinNames(originalNames as string[]) : "its current branches";
  return {
    question: `How should ${names} be added?`,
    copyLabel: added.length === 1 ? "Make a separate copy for this branch" : "Make a separate copy for each new branch",
    copyHint: keepsAny
      ? "Each copy starts with a clean history and is edited on its own. This checklist keeps who it is assigned to and takes the rest of your changes."
      : `Each copy starts with a clean history and is edited on its own. This checklist stays at ${original}, keeps who it is assigned to and takes the rest of your changes.`,
    shareLabel: !keepsAny
      ? added.length === 1
        ? `Move this checklist to ${names}`
        : "Move this one checklist to these branches"
      : selectedBranchIds.length === 2
        ? "Share one checklist across both"
        : "Share one checklist across all of them",
    shareHint: !keepsAny
      ? "It stays one checklist, at the new branches only."
      : "It stays one checklist, and any change to it applies to every branch.",
  };
}

/** What ticking "Save as a new checklist" will do, in the words of the create path. */
export function saveAsNewSummary({
  selectedBranchIds,
  branches,
  canReachAllBranches,
}: {
  selectedBranchIds: string[];
  branches: NamedBranch[];
  canReachAllBranches: boolean;
}): string {
  const made = selectedBranchIds.length === 0
    ? canReachAllBranches
      ? "Creates one new checklist for all branches."
      : "Creates one new checklist for your branch."
    : selectedBranchIds.length === 1
      ? `Creates one new checklist for ${nameOf(branches, selectedBranchIds[0]) ?? "this branch"}.`
      : `Creates ${selectedBranchIds.length} new checklists, one for each selected branch.`;
  return `${made} The original stays exactly as it is, and its past runs stay with it.`;
}
