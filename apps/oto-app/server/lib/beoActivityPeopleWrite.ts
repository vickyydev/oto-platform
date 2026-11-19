import { and, eq, inArray } from "drizzle-orm";
import { beoAssignmentTargets, beoEntertainmentItems, departments, employees, roles, users } from "@shared/schema";
import type { ActivityPersonEntry, ActivityPersonType } from "@shared/beoActivityPeople";
import { db } from "../db";

type StoredItem = typeof beoEntertainmentItems.$inferSelect;

/** The stored kind of each person the screens name (`beo_assignment_target_type`). */
const TARGET_TYPE_OF = { employee: "EMPLOYEE", user: "USER", role: "ROLE", department: "DEPARTMENT" } as const;

/** Where a person on an activity may come from, as the caller's park group is checked. */
export interface ActivityPeopleScope {
  tenantId: string;
  /** The park group's operator: a login is one of its own (the BEO's staff list of logins reads it so). */
  operatorId: string | null;
}

/**
 * SCRUM-1032: an activity's people written, all of them, in the order given (shared/beoActivityPeople.ts),
 * under the activity's row lock so two changes in a row store the later one whole.
 *
 *   - Each person is checked to be of the event's park group: a member of the staff list, a role or a
 *     department of the park group, or a login of its operator (whatever their employment now: a member
 *     of staff who has left and was already on the activity is kept when it is saved again).
 *   - The activity's own targets are replaced by the people given, each a target of its own
 *     (`beo_assignment_targets.entertainment_item_id`, `sort_order`), a role with its number.
 *   - The one person an older activity names by `assignment_target_id` is kept as it is when the
 *     list says `kept` for it; otherwise the activity stops naming it (the target itself is left
 *     alone: it is the app's reusable record, and may be named elsewhere).
 *
 * Nothing else is written: no shift, no task, no message.
 */
export async function writeActivityPeople(
  scope: ActivityPeopleScope,
  eventId: string,
  itemId: string,
  entries: readonly ActivityPersonEntry[],
): Promise<{ ok: true; item: StoredItem } | { ok: false; status: number; reason: string }> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(beoEntertainmentItems)
      .where(and(
        eq(beoEntertainmentItems.id, itemId),
        eq(beoEntertainmentItems.eventId, eventId),
        eq(beoEntertainmentItems.tenantId, scope.tenantId),
      ))
      .for("update");
    if (!item) return { ok: false, status: 404, reason: "Entertainment item not found" };

    const keep = entries.some((e) => e.type === "kept" && e.id === item.assignmentTargetId);
    if (entries.some((e) => e.type === "kept" && e.id !== item.assignmentTargetId)) {
      return { ok: false, status: 400, reason: "The activity no longer names that person; open the BEO again." };
    }
    const named = entries.filter((e): e is Extract<ActivityPersonEntry, { type: ActivityPersonType }> => e.type !== "kept");
    const idsOf = (type: ActivityPersonType) => [...new Set(named.filter((e) => e.type === type).map((e) => e.id))];
    const found = async (type: ActivityPersonType, ids: string[]): Promise<Set<string>> => {
      if (ids.length === 0) return new Set();
      const rows = type === "employee"
        ? await tx.select({ id: employees.id }).from(employees).where(and(inArray(employees.id, ids), eq(employees.tenantId, scope.tenantId)))
        : type === "role"
          ? await tx.select({ id: roles.id }).from(roles).where(and(inArray(roles.id, ids), eq(roles.tenantId, scope.tenantId)))
          : type === "department"
            ? await tx.select({ id: departments.id }).from(departments).where(and(inArray(departments.id, ids), eq(departments.tenantId, scope.tenantId)))
            : scope.operatorId
              ? await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.operatorId, scope.operatorId)))
              : [];
      return new Set(rows.map((r) => r.id));
    };
    for (const type of ["employee", "user", "role", "department"] as const) {
      const ids = idsOf(type);
      const known = await found(type, ids);
      if (ids.some((id) => !known.has(id))) {
        return { ok: false, status: 400, reason: "Someone on this activity is not on the park's staff list." };
      }
    }

    await tx.delete(beoAssignmentTargets).where(eq(beoAssignmentTargets.entertainmentItemId, item.id));
    if (named.length > 0) {
      await tx.insert(beoAssignmentTargets).values(named.map((e, at) => ({
        tenantId: item.tenantId,
        targetType: TARGET_TYPE_OF[e.type],
        employeeId: e.type === "employee" ? e.id : null,
        userId: e.type === "user" ? e.id : null,
        roleId: e.type === "role" ? e.id : null,
        departmentId: e.type === "department" ? e.id : null,
        headCount: e.type === "role" ? (e.count ?? null) : null,
        entertainmentItemId: item.id,
        sortOrder: at,
      })));
    }
    const [updated] = await tx.update(beoEntertainmentItems)
      .set({ ...(keep ? {} : { assignmentTargetId: null }), updatedAt: new Date() })
      .where(eq(beoEntertainmentItems.id, item.id))
      .returning();
    return { ok: true, item: updated ?? item };
  });
}
