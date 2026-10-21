import { format } from "date-fns";

// The camp days a parent may pick on the public sign-up form. Days staff
// cancelled are never offered (staff see and restore them in the studio).
// `open` is every day not cancelled; `available` also leaves out the days this
// child is already registered for (the add-dates form), each day once.
export function campDaysForParents(campDays: Date[], cancelledDays: unknown, registeredDates: string[] = []) {
  const cancelled = Array.isArray(cancelledDays) ? cancelledDays : [];
  const open = campDays.filter(day => !cancelled.includes(format(day, "yyyy-MM-dd")));
  const available = open.filter(day => !registeredDates.includes(format(day, "yyyy-MM-dd")));
  return { open, available };
}
