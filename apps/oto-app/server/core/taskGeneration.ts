import { db } from "../db";
import { tasks, taskAssignments } from "../db/coreSchema";
import { eq, and } from "drizzle-orm";
import { format, startOfDay, getDay, getDate, getDaysInMonth, addMonths } from "date-fns";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Is this definition's instance for this date made already?
 *
 * Looked up by the date the instance was made FOR (`generated_for_date`, which
 * both inserts below fill with the same `dateStr`), the way the template
 * generator looks up its own (`compat/studioTasksCompat.ts`).
 *
 * It used to look for an instance DUE inside `startOfDay(targetDate)` to
 * `endOfDay(targetDate)`. The batch passes a date shifted +7 hours in a UTC
 * process, so that window ran from 07:00 to 06:59 Bangkok: an instance due
 * before 07:00 (`${dateStr}T06:30:00+07:00`, the previous UTC day) was never
 * found, and every second batch of one date made it again. In-process the
 * batch ran once a night and it never showed; the platform's runner runs a
 * date's batch again after a failure or a timed-out call, and on the day of
 * the switch (S2-17b round 3 review, F2 — a duplicate row, fixed as a
 * data-reliability fault).
 */
async function instanceMadeFor(tenantId: string, definitionId: string, dateStr: string): Promise<boolean> {
  const existing = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      eq(tasks.tenantId, tenantId),
      eq(tasks.parentTaskId, definitionId),
      eq(tasks.generatedForDate, dateStr),
    ))
    .limit(1);
  return existing.length > 0;
}

function shouldGenerateForDate(
  recurrence: string,
  weeklyDays: string[] | null,
  monthlyDay: number | null,
  targetDate: Date,
): boolean {
  if (recurrence === "daily") return true;

  if (recurrence === "weekly") {
    const dayName = DAY_NAMES[getDay(targetDate)];
    return (weeklyDays || []).includes(dayName);
  }

  if (recurrence === "monthly" && monthlyDay) {
    const currentDay = getDate(targetDate);
    const daysInMonth = getDaysInMonth(targetDate);

    if (monthlyDay <= daysInMonth) {
      return currentDay === monthlyDay;
    }
    // Overflow: e.g. 31st in a 30-day month → generate on 1st of next month
    if (currentDay === 1) {
      const prevMonth = addMonths(targetDate, -1);
      return monthlyDay > getDaysInMonth(prevMonth);
    }
  }

  return false;
}

/**
 * Generate task instances from recurring definitions for a given tenant and date.
 * Handles daily, weekly, and monthly recurrence.
 * Copies task_assignments rows from the definition to each generated instance.
 */
export async function generateTaskInstances(
  tenantId: string,
  targetDate: Date,
): Promise<number> {
  const dateStr = format(targetDate, "yyyy-MM-dd");

  const definitions = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.isRecurringDefinition, true)));

  let generated = 0;

  for (const def of definitions) {
    if (!shouldGenerateForDate(
      def.recurrence,
      def.weeklyDays as string[] | null,
      def.monthlyDay,
      targetDate,
    )) continue;

    // Don't generate instances before the definition's start or due date
    const defStartDate = def.startAt ? startOfDay(new Date(def.startAt)) : null;
    const defDueDate = def.dueAt ? startOfDay(new Date(def.dueAt)) : null;
    const earliestDate = defStartDate || defDueDate;
    if (earliestDate && startOfDay(targetDate) < earliestDate) continue;

    if (await instanceMadeFor(tenantId, def.id, dateStr)) continue;

    const dueTime = def.preferredDueTime || "18:00";
    const dueAt = new Date(`${dateStr}T${dueTime}:00+07:00`);

    const [instance] = await db
      .insert(tasks)
      .values({
        tenantId,
        branchId: def.branchId,
        departmentId: def.departmentId,
        title: def.title,
        description: def.description,
        status: "pending",
        priority: def.priority,
        recurrence: "once",
        dueAt,
        assignedTo: def.assignedTo,
        assignedEmployeeId: def.assignedEmployeeId,
        assignedRoleId: def.assignedRoleId,
        assignedDepartmentId: def.assignedDepartmentId,
        requiresPhotoEvidence: def.requiresPhotoEvidence,
        requiresResponses: def.requiresResponses,
        referencePhotoUrl: def.referencePhotoUrl,
        isRecurringDefinition: false,
        parentTaskId: def.id,
        generatedForDate: dateStr,
        createdBy: def.createdBy,
      })
      .returning();

    // Copy task_assignments from definition to instance
    const defAssignments = await db
      .select()
      .from(taskAssignments)
      .where(eq(taskAssignments.taskId, def.id));

    for (const a of defAssignments) {
      await db.insert(taskAssignments).values({
        tenantId,
        taskId: instance.id,
        assignmentType: a.assignmentType,
        assignmentId: a.assignmentId,
      });
    }

    generated++;
  }

  return generated;
}

/**
 * Generate instances for a single recurring definition for today.
 * Used when a recurring task is first created, so the user sees today's instance immediately.
 */
export async function generateInstanceForDefinition(
  tenantId: string,
  definitionId: string,
  targetDate: Date,
): Promise<void> {
  const dateStr = format(targetDate, "yyyy-MM-dd");

  const [def] = await db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.id, definitionId),
      eq(tasks.tenantId, tenantId),
      eq(tasks.isRecurringDefinition, true),
    ));

  if (!def) return;

  if (!shouldGenerateForDate(
    def.recurrence,
    def.weeklyDays as string[] | null,
    def.monthlyDay,
    targetDate,
  )) return;

  // Don't generate instances before the definition's start or due date
  const defStartDate = def.startAt ? startOfDay(new Date(def.startAt)) : null;
  const defDueDate = def.dueAt ? startOfDay(new Date(def.dueAt)) : null;
  const earliestDate = defStartDate || defDueDate;
  if (earliestDate && startOfDay(targetDate) < earliestDate) return;

  if (await instanceMadeFor(tenantId, def.id, dateStr)) return;

  const dueTime = def.preferredDueTime || "18:00";
  const dueAt = new Date(`${dateStr}T${dueTime}:00+07:00`);

  const [instance] = await db
    .insert(tasks)
    .values({
      tenantId,
      branchId: def.branchId,
      departmentId: def.departmentId,
      title: def.title,
      description: def.description,
      status: "pending",
      priority: def.priority,
      recurrence: "once",
      dueAt,
      assignedTo: def.assignedTo,
      assignedEmployeeId: def.assignedEmployeeId,
      assignedRoleId: def.assignedRoleId,
      assignedDepartmentId: def.assignedDepartmentId,
      requiresPhotoEvidence: def.requiresPhotoEvidence,
      requiresResponses: def.requiresResponses,
      referencePhotoUrl: def.referencePhotoUrl,
      isRecurringDefinition: false,
      parentTaskId: def.id,
      generatedForDate: dateStr,
      createdBy: def.createdBy,
    })
    .returning();

  const defAssignments = await db
    .select()
    .from(taskAssignments)
    .where(eq(taskAssignments.taskId, def.id));

  for (const a of defAssignments) {
    await db.insert(taskAssignments).values({
      tenantId,
      taskId: instance.id,
      assignmentType: a.assignmentType,
      assignmentId: a.assignmentId,
    });
  }
}
