import { beoClockOf } from "./beoClock";

/**
 * A SERVING TIME PER DISH OR GROUP (SCRUM-1033).
 *
 * The operations brief: "a time per dish or group" for the kids' and the adults' menus and "a
 * time per drink or group" for the bar; the owner's answer of 19 November: on the BEO and its
 * print (and later on the till's kitchen and bar slips, SCRUM-1051). Each menu keeps its one
 * service time as today (the kids' and the adults' `kidsFoodTime`/`adultsFoodTime`, the bar's
 * `serviceTime`); a dish with no time of its own is served at it, as today.
 *
 * WHERE IT IS STORED: on the line itself, in the plan's own lists, two optional keys that a line
 * of before does not carry (no migration; nothing stored is rewritten):
 *   - `serviceTime`: the dish's own time, "HH:MM" on the park's clock (the editor's time box);
 *   - `serviceGroup`: a short name the dish is served under with others ("Dessert"). A group is
 *     the lines of one list with the same name (case and spacing aside), and its dishes share
 *     one time: a group's time is set once for all of them.
 * The lists: `beo_kitchen_plans.menus.kids[]` and `.adults[]` (the adults' own list), and
 * `beo_bar_plans.items[]`. The till reads the party's food through the app's view
 * `otoapp_v.event_packages` (app migration 0052: `kitchen_plan.lines` and `.bar_lines`, each
 * line built key by key), which names neither key: nothing of this reaches the till until its
 * slips are built to read it (SCRUM-1051, a later app migration of that view).
 *
 * Nothing is invented: a line with no time stored is served at its menu's time; a time that is
 * no clock time is none.
 */

/** The longest group name a Save stores. */
export const SERVING_GROUP_MAX = 60;

/** The two keys as a line may carry them. */
export interface ServingLine {
  serviceTime?: unknown;
  serviceGroup?: unknown;
  [key: string]: unknown;
}

/** A line's own serving: its time (HH:MM and minute of the day) and the group it is served under, if named. */
export interface LineServing {
  time: string;
  minute: number;
  group: string | null;
}

const groupNameOf = (value: unknown): string => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");
/** Two group names are the same group when they say the same, case and spacing aside. */
export const sameServingGroup = (a: unknown, b: unknown): boolean => {
  const x = groupNameOf(a).toLowerCase();
  return x !== "" && x === groupNameOf(b).toLowerCase();
};

/** The line's own time and group; null when it stores no time of its own (it is served at its menu's time). */
export function lineServingOf(line: ServingLine | null | undefined): LineServing | null {
  const clock = beoClockOf(line?.serviceTime);
  if (!clock) return null;
  const group = groupNameOf(line?.serviceGroup);
  return { time: clock.time, minute: clock.minute, group: group || null };
}

/**
 * What is printed and shown beside a dish: "13:00", or the group's name and time "Dessert · 13:00".
 * Nothing (null) for a dish served at its menu's time: no time of its own, or its own time the
 * menu's with no group named.
 */
export function lineServingTagOf(line: ServingLine | null | undefined, menuTime?: unknown): string | null {
  const own = lineServingOf(line);
  if (!own) return null;
  if (own.group) return `${own.group} · ${own.time}`;
  return beoClockOf(menuTime)?.minute === own.minute ? null : own.time;
}

/**
 * The serving times of one list other than its menu's own: each distinct time a line stores, in
 * clock order, with the names of the groups served then (in the order the list holds them). What
 * the timeline makes a food step of: a time equal to the menu's own makes none.
 */
export function servingTimesOf(lines: readonly ServingLine[], menuTime?: unknown): Array<{ time: string; minute: number; groups: string[] }> {
  const menu = beoClockOf(menuTime)?.minute;
  const at = new Map<number, { time: string; minute: number; groups: string[] }>();
  for (const line of lines) {
    const own = lineServingOf(line);
    if (!own || own.minute === menu) continue;
    const entry = at.get(own.minute) ?? { time: own.time, minute: own.minute, groups: [] };
    if (own.group && !entry.groups.some((g) => sameServingGroup(g, own.group))) entry.groups.push(own.group);
    at.set(own.minute, entry);
  }
  return [...at.values()].sort((a, b) => a.minute - b.minute);
}

/** The groups one list names, each once with its time, in the order the list first holds them. */
export function servingGroupsOf(lines: readonly ServingLine[]): Array<{ name: string; time: string }> {
  const groups: Array<{ name: string; time: string }> = [];
  for (const line of lines) {
    const own = lineServingOf(line);
    if (own?.group && !groups.some((g) => sameServingGroup(g.name, own.group))) groups.push({ name: own.group, time: own.time });
  }
  return groups;
}

/**
 * A line's own serving keys as the editor holds a line it read: only the keys the line stores, so a
 * line of before (none) is held, and saved, exactly as it was.
 */
export function servingKeysOf(line: ServingLine | null | undefined): { serviceTime?: string; serviceGroup?: string } {
  const own = lineServingOf(line);
  if (!own) return {};
  return own.group ? { serviceTime: own.time, serviceGroup: own.group } : { serviceTime: own.time };
}

/**
 * One line's serving set in the editor: a time ("" for none: served with the menu again, and out of
 * its group) and a group name ("" for none). A group's dishes share one time: every other line of
 * the list in the same group takes the new time. The other lines are returned as they were.
 */
export function withLineServing<T extends ServingLine>(lines: readonly T[], index: number, next: { time: string; group: string }): T[] {
  const clock = beoClockOf(next.time);
  const group = clock ? groupNameOf(next.group).slice(0, SERVING_GROUP_MAX) : "";
  return lines.map((line, i) => {
    if (i === index) {
      const { serviceTime: _t, serviceGroup: _g, ...rest } = line;
      if (!clock) return rest as T;
      return { ...rest, serviceTime: clock.time, ...(group ? { serviceGroup: group } : {}) } as T;
    }
    if (clock && group && sameServingGroup(line.serviceGroup, group) && lineServingOf(line)?.time !== clock.time) {
      return { ...line, serviceTime: clock.time };
    }
    return line;
  });
}

/**
 * Why a Save's dishes and drinks cannot be stored with their serving times, in staff words; null
 * when they can. A line's own time is a clock time; its group a short name, and only with a time.
 * A line with neither key (every line of before) is never refused.
 */
export function servingRefusal(lists: ReadonlyArray<readonly unknown[] | null | undefined>): string | null {
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const line = raw as ServingLine;
      const name = typeof line.itemName === "string" && line.itemName.trim() ? line.itemName.trim() : "A dish";
      const hasTime = line.serviceTime !== undefined && line.serviceTime !== null && line.serviceTime !== "";
      if (hasTime && !beoClockOf(line.serviceTime)) return `${name}: its serving time must be a time of day (HH:MM), or empty.`;
      const hasGroup = line.serviceGroup !== undefined && line.serviceGroup !== null && line.serviceGroup !== "";
      if (!hasGroup) continue;
      if (typeof line.serviceGroup !== "string" || line.serviceGroup.length > SERVING_GROUP_MAX) {
        return `${name}: its serving group must be a short name of at most ${SERVING_GROUP_MAX} characters.`;
      }
      if (!hasTime) return `${name}: a serving group needs its time.`;
    }
  }
  return null;
}
