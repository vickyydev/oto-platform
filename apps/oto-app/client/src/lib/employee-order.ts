// SCRUM-1036 — the order of employees in Scheduling's employee view.
// One comparator draws the list and works out a drag, so the order saved is
// the order the manager saw.

export type OrderedEmployee = {
  id: string;
  fullName: string;
  displayOrder?: number | null;
  createdAt?: string | Date | null;
};

function createdMs(e: OrderedEmployee): number {
  if (!e.createdAt) return 0;
  const t = new Date(e.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Shown order: displayOrder first; staff who share a place (every employee
 * saved before places were kept) fall back to earliest created, then name,
 * then id, so the list reads the same on every load.
 */
export function compareEmployeeOrder(a: OrderedEmployee, b: OrderedEmployee): number {
  const byPlace = (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
  if (byPlace !== 0) return byPlace;
  const byCreated = createdMs(a) - createdMs(b);
  if (byCreated !== 0) return byCreated;
  const byName = a.fullName.localeCompare(b.fullName);
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortEmployeesForDisplay<T extends OrderedEmployee>(list: T[]): T[] {
  return [...list].sort(compareEmployeeOrder);
}

/**
 * The ids to save after dragging `activeId` onto `overId` in the view the
 * manager is looking at. `department` is every employee of the department;
 * `shownIds` are those in view (a search may hide some). The dragged person
 * takes the place of the one dropped on, in the shown order; employees not in
 * view keep their places relative to each other and to the shown slots they
 * held. Returns null when nothing moves.
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
