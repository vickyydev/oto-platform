// SCRUM-1036 — the order of employees in Scheduling's employee view and on
// the Employees page. One comparator draws both lists and works out a drag,
// so the order saved is the order the manager saw, on either screen.

export type OrderedEmployee = {
  id: string;
  displayOrder?: number | null;
};

/**
 * Shown order: displayOrder, as both screens have always drawn it. Staff who
 * share a place (every employee saved before places were kept) stay in the
 * order the server sends them (newest first, `getEmployeesWithAccess`): the
 * sort is stable, so ties read exactly as they did before this repair.
 */
export function compareEmployeeOrder(a: OrderedEmployee, b: OrderedEmployee): number {
  return (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
}

export function sortEmployeesForDisplay<T extends OrderedEmployee>(list: T[]): T[] {
  return [...list].sort(compareEmployeeOrder);
}

/**
 * The ids to save after dragging `activeId` onto `overId` in the view the
 * manager is looking at. `department` is every employee of the department, in
 * the order the server sent them (the order the screen's own list was made
 * from); `shownIds` are those in view (a search may hide some). The dragged
 * person takes the place of the one dropped on, in the shown order; employees
 * not in view keep their places relative to each other and to the shown
 * slots they held. Returns null when nothing moves.
 */
export function orderAfterDrag(
  department: OrderedEmployee[],
  shownIds: string[],
  activeId: string,
  overId: string,
): string[] | null {
  const full = sortEmployeesForDisplay(department).map((e) => e.id);
  const shownSet = new Set(shownIds);
  const shown = full.filter((id) => shownSet.has(id));
  const from = shown.indexOf(activeId);
  const to = shown.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return null;
  const moved = [...shown];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  let next = 0;
  return full.map((id) => (shownSet.has(id) ? moved[next++] : id));
}
