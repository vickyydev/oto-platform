/**
 * The branches a Studio picker offers (SCRUM-749). `/api/studio/branches` lists
 * every branch of the park group, so a name on an older checklist, task or run
 * still reads, and says which ones the platform has archived. A picker leaves
 * those out: nothing new is set up at a park that has closed.
 *
 * A branch the record being edited already names stays in the picker, so it
 * can still be seen and taken off. Pass the record's saved branch ids, not the
 * live selection, or the branch would vanish the moment it is unticked.
 */

export type PickerBranch = { id: string; name: string; archived?: boolean };

export function pickerBranches<T extends PickerBranch>(branches: readonly T[], alreadyNamed: readonly string[] = []): T[] {
  return branches.filter((branch) => !branch.archived || alreadyNamed.includes(branch.id));
}
