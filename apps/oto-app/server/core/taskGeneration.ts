import { db } from "../db";
import { tasks, taskAssignments } from "../db/coreSchema";
import { eq, and, gte, lt } from "drizzle-orm";
import { format, startOfDay, endOfDay, getDay, getDate, getDaysInMonth, addMonths } from "date-fns";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

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
  const dayStart = startOfDay(targetDate);
  const dayEnd = endOfDay(targetDate);

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

    const existing = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(
        eq(tasks.tenantId, tenantId),
        eq(tasks.parentTaskId, def.id),
        gte(tasks.dueAt, dayStart),
        lt(tasks.dueAt, dayEnd),
      ))
      .limit(1);

    if (existing.length > 0) continue;

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
  const dayStart = startOfDay(targetDate);
  const dayEnd = endOfDay(targetDate);

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

  const existing = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      eq(tasks.tenantId, tenantId),
      eq(tasks.parentTaskId, def.id),
      gte(tasks.dueAt, dayStart),
      lt(tasks.dueAt, dayEnd),
    ))
    .limit(1);

  if (existing.length > 0) return;

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
