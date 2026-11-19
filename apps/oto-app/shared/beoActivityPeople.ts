/**
 * THE PEOPLE ON AN ACTIVITY (SCRUM-1032).
 *
 * The owner's decision of 19 November: each activity of Entertainment & Program has a name, a
 * time, notes, and its people: staff by name, one or several, or a role with a number ("1 host",
 * "2 animators") filled in with names later. This is the BEO's record only: nothing is sent to
 * scheduling, payroll or any chat.
 *
 * How an activity holds a person: an ASSIGNMENT TARGET (`beo_assignment_targets`), the app's own
 * record of "who": a person, a role or a department of the park group. Before this an activity
 * named at most one, by `beo_entertainment_items.assignment_target_id` (no screen wrote it). Now
 * an activity also owns targets of its own (`beo_assignment_targets.entertainment_item_id`, app
 * migration 0055), in their order, so it names several; a target may be a member of staff
 * (EMPLOYEE, the park's staff list the BEO's other pickers use), and a role target may carry its
 * number (`head_count`). The person an older activity names by `assignment_target_id` stays its
 * first person, as it was, until staff change the activity's people.
 *
 * Every name is read at the time it is shown, by id and whatever the person's employment: a
 * member of staff who has left stays named on the party they were put on.
 */

/** What a person on an activity is: a member of staff (the staff list), a login, a role, a department. */
export const ACTIVITY_PERSON_TYPES = ["employee", "user", "role", "department"] as const;
export type ActivityPersonType = (typeof ACTIVITY_PERSON_TYPES)[number];

/** The most people one activity names, and the largest number a role may carry (as the cake's count). */
export const ACTIVITY_PEOPLE_MAX = 20;
export const ACTIVITY_ROLE_COUNT_MAX = 99;

/** The longest note the editor's box takes for an activity (its own column, `beo_entertainment_items.notes`). */
export const ACTIVITY_NOTE_MAX = 500;

/**
 * One person on an activity as the screens read it (`GET …/beo/entertainment-items`, each item's
 * `people`): its kind, the id it names, its name as stored now, and a role's number. `kept` marks
 * the person an older activity named before (its `assignment_target_id`).
 */
export interface ActivityPerson {
  type: ActivityPersonType;
  /** The id the person is named by: the staff list's, the login's, the role's or the department's. */
  id: string;
  /** The stored target (`beo_assignment_targets.id`): what `kept` sends back for the person of before. */
  targetId: string;
  label: string;
  count: number | null;
  kept?: boolean;
}

/**
 * One person as the editor sends an activity's people (`PUT …/entertainment-items/:id/people`):
 * a member of staff, a login, a role with its number, a department; or `kept`, the person the
 * activity named before, left as it is.
 */
export type ActivityPersonEntry =
  | { type: ActivityPersonType; id: string; count?: number | null }
  | { type: "kept"; id: string };

const isPersonType = (value: unknown): value is ActivityPersonType =>
  typeof value === "string" && (ACTIVITY_PERSON_TYPES as readonly string[]).includes(value);

/**
 * A person in one line, as every reader prints it: the name; a role with its number "2 × Animator"
 * (the number first, as the brief's drawing reads "1 host"; the role's own name, never made plural).
 */
export function activityPersonWords(person: { label: string; type?: string; count?: number | null }): string {
  const name = person.label.trim();
  const count = person.type === "role" && typeof person.count === "number" && person.count > 0 ? person.count : null;
  return count !== null ? `${count} × ${name}` : name;
}

/** An activity's people in one line, in their order: "Nok, Ploy", "2 × Animator, Nok". Nobody: "". */
export function activityPeopleWords(people: readonly { label: string; type?: string; count?: number | null }[] | null | undefined): string {
  return (people ?? []).filter((p) => p.label.trim()).map(activityPersonWords).join(", ");
}

/** The entries of a people body that can be stored, or why not, in staff words. */
export function activityPeopleOfBody(body: unknown): { ok: true; people: ActivityPersonEntry[] } | { ok: false; reason: string } {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).people : undefined;
  if (!Array.isArray(raw)) return { ok: false, reason: "The activity's people must be a list." };
  if (raw.length > ACTIVITY_PEOPLE_MAX) return { ok: false, reason: `An activity names at most ${ACTIVITY_PEOPLE_MAX} people.` };
  const people: ActivityPersonEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const e = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const id = typeof e?.id === "string" ? e.id.trim() : "";
    if (!e || !id || id.length > 100) return { ok: false, reason: "Each person on an activity must name who it is." };
    if (e.type === "kept") {
      if (seen.has(`kept:${id}`)) continue;
      seen.add(`kept:${id}`);
      people.push({ type: "kept", id });
      continue;
    }
    if (!isPersonType(e.type)) return { ok: false, reason: "A person on an activity is a member of staff or a role." };
    let count: number | null = null;
    if (e.type === "role") {
      if (e.count !== undefined && e.count !== null) {
        if (typeof e.count !== "number" || !Number.isInteger(e.count) || e.count < 1 || e.count > ACTIVITY_ROLE_COUNT_MAX) {
          return { ok: false, reason: `A role's number must be a whole number from 1 to ${ACTIVITY_ROLE_COUNT_MAX}.` };
        }
        count = e.count;
      }
    } else if (e.count !== undefined && e.count !== null) {
      return { ok: false, reason: "Only a role carries a number; a person is named once." };
    }
    if (seen.has(`${e.type}:${id}`)) return { ok: false, reason: "The same person or role is named twice on one activity." };
    seen.add(`${e.type}:${id}`);
    people.push({ type: e.type, id, count });
  }
  return { ok: true, people };
}
