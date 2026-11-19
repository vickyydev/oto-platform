import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
  beoAssignmentTargets,
  beoBarPlans,
  beoEntertainmentItems,
  beoKitchenPlans,
  beoSetupPlans,
  beoTimelineItems,
  coreEvents,
  departments,
  employees,
  roles,
  users,
} from "@shared/schema";
import { beoTimedMadeSteps, buildBeoTimeline, type BeoTimeline, type BeoTimelineActivity, type BeoTimelineSource } from "@shared/beoTimeline";
import { activityPersonWords, type ActivityPerson } from "@shared/beoActivityPeople";
import { db } from "../db";

/** The event's fields the timeline reads. */
export interface BeoTimelineEvent {
  id: string;
  tenantId: string;
  startTime: string | null;
  endTime: string | null;
  suppressedTimelineSources: string[] | null;
}

/** SCRUM-1032: a stored target's kind as the screens name it (shared/beoActivityPeople.ts). */
const PERSON_TYPE_OF = { USER: "user", ROLE: "role", DEPARTMENT: "department", EMPLOYEE: "employee" } as const;

type StoredTarget = typeof beoAssignmentTargets.$inferSelect;

/** The id a stored target names, by its kind. */
const namedIdOf = (t: StoredTarget): string | null =>
  t.targetType === "USER" ? t.userId : t.targetType === "ROLE" ? t.roleId : t.targetType === "DEPARTMENT" ? t.departmentId : t.employeeId;

/**
 * SCRUM-1027, SCRUM-1032: the people of the given activities, each as the screens and the print read
 * them (shared/beoActivityPeople.ts), by activity id. First the one person an older activity names
 * by its `assignment_target_id` (marked `kept`: it stays as it was), then the targets the activity
 * owns (`entertainment_item_id`), in their order. A person, a role or a department of the event's
 * park group, each named by id whatever their employment now (a member of staff who has left stays
 * named on the party they were put on); a role with its number. A target whose name cannot be read
 * is left out, as before. The party's hosts are never put on an activity: only what it names itself.
 */
export async function activityPeopleOf(
  tenantId: string,
  acts: ReadonlyArray<{ id: string; assignmentTargetId: string | null }>,
): Promise<Map<string, ActivityPerson[]>> {
  const people = new Map<string, ActivityPerson[]>(acts.map((a) => [a.id, []]));
  if (acts.length === 0) return people;
  const keptIds = [...new Set(acts.map((a) => a.assignmentTargetId).filter((id): id is string => !!id))];
  const actIds = acts.map((a) => a.id);
  const whose = keptIds.length
    ? or(inArray(beoAssignmentTargets.id, keptIds), inArray(beoAssignmentTargets.entertainmentItemId, actIds))
    : inArray(beoAssignmentTargets.entertainmentItemId, actIds);
  const targets = await db.select().from(beoAssignmentTargets)
    .where(and(eq(beoAssignmentTargets.tenantId, tenantId), whose))
    .orderBy(asc(beoAssignmentTargets.sortOrder), asc(beoAssignmentTargets.createdAt));
  const idsOf = (type: StoredTarget["targetType"]) => [...new Set(targets.filter((t) => t.targetType === type).map(namedIdOf).filter((id): id is string => !!id))];
  const userIds = idsOf("USER");
  const roleIds = idsOf("ROLE");
  const departmentIds = idsOf("DEPARTMENT");
  const employeeIds = idsOf("EMPLOYEE");
  const userNames = new Map(
    (userIds.length ? await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, userIds)) : [])
      .map((u) => [u.id, u.name] as const),
  );
  const roleNames = new Map(
    (roleIds.length ? await db.select({ id: roles.id, name: roles.name }).from(roles).where(and(inArray(roles.id, roleIds), eq(roles.tenantId, tenantId))) : [])
      .map((r) => [r.id, r.name] as const),
  );
  const departmentNames = new Map(
    (departmentIds.length ? await db.select({ id: departments.id, name: departments.name }).from(departments).where(and(inArray(departments.id, departmentIds), eq(departments.tenantId, tenantId))) : [])
      .map((d) => [d.id, d.name] as const),
  );
  // The staff list's own name for a member of staff, as the BEO prints the party's hosts.
  const employeeNames = new Map(
    (employeeIds.length
      ? await db.select({ id: employees.id, nickname: employees.nickname, fullName: employees.fullName }).from(employees).where(and(inArray(employees.id, employeeIds), eq(employees.tenantId, tenantId)))
      : [])
      .map((e) => [e.id, e.nickname?.trim() || e.fullName] as const),
  );
  const nameOf = (t: StoredTarget): string => {
    const id = namedIdOf(t) ?? "";
    const name = t.targetType === "USER" ? userNames.get(id)
      : t.targetType === "ROLE" ? roleNames.get(id)
      : t.targetType === "DEPARTMENT" ? departmentNames.get(id)
      : employeeNames.get(id);
    return name?.trim() ?? "";
  };
  const personOf = (t: StoredTarget, kept: boolean): ActivityPerson | null => {
    const label = nameOf(t);
    const id = namedIdOf(t);
    if (!label || !id) return null;
    return {
      type: PERSON_TYPE_OF[t.targetType],
      id,
      targetId: t.id,
      label,
      count: t.targetType === "ROLE" && typeof t.headCount === "number" ? t.headCount : null,
      ...(kept ? { kept: true } : {}),
    };
  };
  for (const act of acts) {
    const list = people.get(act.id)!;
    const kept = act.assignmentTargetId ? targets.find((t) => t.id === act.assignmentTargetId) : undefined;
    const keptPerson = kept ? personOf(kept, true) : null;
    if (keptPerson) list.push(keptPerson);
    for (const t of targets) {
      if (t.entertainmentItemId !== act.id || t.id === act.assignmentTargetId) continue;
      const person = personOf(t, false);
      if (person) list.push(person);
    }
  }
  return people;
}

/**
 * SCRUM-1028, SCRUM-1032: the event's activities as stored (its `beo_entertainment_items`, in their
 * order), each with its own people and its note: what the timeline reads, and what the Staff BEO's
 * Entertainment part prints.
 */
export async function beoActivitiesOf(
  tenantId: string,
  acts: ReadonlyArray<{ id: string; customName: string | null; startTime: string | null; assignmentTargetId: string | null; notes?: string | null }>,
): Promise<BeoTimelineActivity[]> {
  const people = await activityPeopleOf(tenantId, acts);
  return acts.map((a) => {
    const said = (people.get(a.id) ?? []).map(activityPersonWords);
    return {
      id: a.id,
      customName: a.customName,
      startTime: a.startTime,
      person: said.length ? said.join(", ") : null,
      people: said,
      notes: a.notes ?? null,
    };
  });
}

/**
 * SCRUM-1027: the stored BEO as the timeline reads it. `rows` adds the stored timeline rows (the
 * typed steps, and the automatic rows' ticks); `people` adds each activity's own person. The
 * generator that stores the automatic rows asks for neither.
 */
export async function beoTimelineSourceOf(
  event: BeoTimelineEvent,
  want: { rows?: boolean; people?: boolean } = {},
): Promise<BeoTimelineSource> {
  const [setupPlan] = await db.select().from(beoSetupPlans).where(eq(beoSetupPlans.eventId, event.id));
  const [kitchenPlan] = await db.select().from(beoKitchenPlans).where(eq(beoKitchenPlans.eventId, event.id));
  const [barPlan] = await db.select().from(beoBarPlans).where(eq(beoBarPlans.eventId, event.id));
  const acts = await db.select().from(beoEntertainmentItems)
    .where(eq(beoEntertainmentItems.eventId, event.id))
    .orderBy(asc(beoEntertainmentItems.sortOrder));
  const rows = want.rows
    ? await db.select().from(beoTimelineItems)
      .where(eq(beoTimelineItems.eventId, event.id))
      .orderBy(asc(beoTimelineItems.sortOrder))
    : [];
  return {
    startTime: event.startTime,
    endTime: event.endTime,
    suppressedSources: event.suppressedTimelineSources ?? [],
    setupPlan: setupPlan ?? null,
    kitchenPlan: kitchenPlan ?? null,
    barPlan: barPlan ?? null,
    activities: want.people
      ? await beoActivitiesOf(event.tenantId, acts)
      : acts.map((a) => ({ id: a.id, customName: a.customName, startTime: a.startTime, person: null, people: [] })),
    rows: rows.map((r) => ({
      id: r.id,
      label: r.label,
      offsetFromStartMinutes: r.offsetFromStartMinutes,
      isSystemGenerated: r.isSystemGenerated,
      sourceKey: r.sourceKey,
      isCompleted: r.isCompleted,
      assignedToType: r.assignedToType,
      sortOrder: r.sortOrder,
    })),
  };
}

/** SCRUM-1027: the party's one timeline, as every reader shows it (shared/beoTimeline.ts). */
export async function readBeoTimeline(event: BeoTimelineEvent): Promise<BeoTimeline> {
  return buildBeoTimeline(await beoTimelineSourceOf(event, { rows: true, people: true }));
}

/** A step the system makes, as its stored automatic row holds it. */
export interface MadeStepRow {
  label: string;
  offsetMinutes: number;
  assignedToType: string;
}

/**
 * SCRUM-1027: the stored automatic rows the timeline's timed steps make, by source key: each
 * step's words, its minutes from the party's start (from 14:00 for a party with no start, as the
 * rows have always been held) and its role. The generator stores these on every Save of the BEO
 * (`generateTimelineFromBeo` in server/beo-routes.ts); SCRUM-1050's first tick on the Day-of view
 * stores one of them the same way (`tickMadeStep`).
 */
export function madeStepRowsOf(startTime: string | null, src: BeoTimelineSource): Map<string, MadeStepRow> {
  const startTimeParts = startTime?.split(":").map(Number) || [14, 0];
  const startTotalMin = startTimeParts[0] * 60 + startTimeParts[1];
  const rows = new Map<string, MadeStepRow>();
  for (const step of beoTimedMadeSteps(src)) {
    const offsetMinutes = step.clock.minute - startTotalMin;
    if (Number.isNaN(offsetMinutes)) continue;
    rows.set(step.key, { label: step.label, offsetMinutes, assignedToType: step.assignedToType });
  }
  return rows;
}

type StoredTimelineRow = typeof beoTimelineItems.$inferSelect;

/**
 * SCRUM-1050: an automatic step ticked on the Day-of view before the BEO's next Save stored its
 * row. The row is stored now exactly as the generator stores it (its source key, words, minutes
 * from the start and role), ticked done by this person; the generator's next run finds it by its
 * source key, keeps the tick and stores no second row. A step already stored is ticked done (a
 * tick already there stays as it is). Null when the timeline makes no such step with a time, or
 * staff removed it from the timeline.
 */
export async function tickMadeStep(
  event: BeoTimelineEvent,
  key: string,
  userId: string,
): Promise<StoredTimelineRow | null> {
  if ((event.suppressedTimelineSources ?? []).includes(key)) return null;
  const made = madeStepRowsOf(event.startTime, await beoTimelineSourceOf(event)).get(key);
  if (!made) return null;
  return db.transaction(async (tx) => {
    // The event's row is held: two first ticks of the same step store one row.
    await tx.select({ id: coreEvents.id }).from(coreEvents).where(eq(coreEvents.id, event.id)).for("update");
    const [stored] = await tx.select().from(beoTimelineItems).where(and(
      eq(beoTimelineItems.eventId, event.id),
      eq(beoTimelineItems.isSystemGenerated, true),
      eq(beoTimelineItems.sourceKey, key),
    ));
    const now = new Date();
    if (stored) {
      if (stored.isCompleted) return stored;
      const [ticked] = await tx.update(beoTimelineItems)
        .set({ isCompleted: true, completedAt: now, completedByUserId: userId, updatedAt: now })
        .where(eq(beoTimelineItems.id, stored.id))
        .returning();
      return ticked ?? null;
    }
    const [row] = await tx.insert(beoTimelineItems).values({
      eventId: event.id,
      label: made.label,
      offsetFromStartMinutes: made.offsetMinutes,
      assignedToType: made.assignedToType as StoredTimelineRow["assignedToType"],
      isSystemGenerated: true,
      sourceKey: key,
      sortOrder: 0,
      isCompleted: true,
      completedAt: now,
      completedByUserId: userId,
    }).returning();
    return row ?? null;
  });
}
