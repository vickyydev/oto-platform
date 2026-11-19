import { and, asc, eq, inArray } from "drizzle-orm";
import {
  beoAssignmentTargets,
  beoBarPlans,
  beoEntertainmentItems,
  beoKitchenPlans,
  beoSetupPlans,
  beoTimelineItems,
  departments,
  roles,
  users,
} from "@shared/schema";
import { buildBeoTimeline, type BeoTimeline, type BeoTimelineSource } from "@shared/beoTimeline";
import { db } from "../db";

/** The event's fields the timeline reads. */
export interface BeoTimelineEvent {
  id: string;
  tenantId: string;
  startTime: string | null;
  endTime: string | null;
  suppressedTimelineSources: string[] | null;
}

/**
 * SCRUM-1027: an activity's own person, as stored for it (`beo_entertainment_items.assignment_target_id`,
 * a person, a role or a department of the event's park group), by the activity's target id. The party's
 * hosts are never put on an activity: only what the activity itself names.
 */
async function activityPeopleOf(tenantId: string, targetIds: string[]): Promise<Map<string, string>> {
  const named = new Map<string, string>();
  if (targetIds.length === 0) return named;
  const targets = await db.select().from(beoAssignmentTargets)
    .where(and(inArray(beoAssignmentTargets.id, targetIds), eq(beoAssignmentTargets.tenantId, tenantId)));
  const userIds = targets.map((t) => t.userId).filter((id): id is string => !!id);
  const roleIds = targets.map((t) => t.roleId).filter((id): id is string => !!id);
  const departmentIds = targets.map((t) => t.departmentId).filter((id): id is string => !!id);
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
  for (const t of targets) {
    const name = t.targetType === "USER" ? userNames.get(t.userId ?? "")
      : t.targetType === "ROLE" ? roleNames.get(t.roleId ?? "")
      : departmentNames.get(t.departmentId ?? "");
    if (name?.trim()) named.set(t.id, name.trim());
  }
  return named;
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
  const people = want.people
    ? await activityPeopleOf(event.tenantId, [...new Set(acts.map((a) => a.assignmentTargetId).filter((id): id is string => !!id))])
    : new Map<string, string>();
  return {
    startTime: event.startTime,
    endTime: event.endTime,
    suppressedSources: event.suppressedTimelineSources ?? [],
    setupPlan: setupPlan ?? null,
    kitchenPlan: kitchenPlan ?? null,
    barPlan: barPlan ?? null,
    activities: acts.map((a) => ({
      id: a.id,
      customName: a.customName,
      startTime: a.startTime,
      person: a.assignmentTargetId ? people.get(a.assignmentTargetId) ?? null : null,
    })),
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
