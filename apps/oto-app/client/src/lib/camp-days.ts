import { eachDayOfInterval, format, isWeekend, parseISO } from "date-fns";

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

// SCRUM-655: the days the organiser leaves out while creating a camp - every
// Saturday and Sunday when "Skip weekends" is on, plus each day unticked in the
// panel's day list. They are saved as the camp's cancelled days (the list Cancel
// Day keeps), so the studio, the parents' form and attendance read them as before.
export function campCreationExcludedDays(start: string, end: string, skipWeekends: boolean, untickedDays: string[]) {
  if (!start || !end || end < start) return [];
  return eachDayOfInterval({ start: parseISO(start), end: parseISO(end) })
    .filter(day => (skipWeekends && isWeekend(day)) || untickedDays.includes(format(day, "yyyy-MM-dd")))
    .map(day => format(day, "yyyy-MM-dd"));
}
