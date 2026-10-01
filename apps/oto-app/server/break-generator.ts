import { db } from "./db";
import { scheduleShiftRows, scheduleAssignments, scheduleShiftBreaks, scheduleWeekPlans } from "@shared/schema";
import { eq, and, asc, inArray, isNull, or, sql } from "drizzle-orm";

function parseTimeToMinutes(timeStr: string): number {
  const parts = timeStr.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function minutesToTimeStr(minutes: number): string {
  const normalizedMinutes = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(normalizedMinutes / 60);
  const m = normalizedMinutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export function autoBreakWindow(shiftRow: typeof scheduleShiftRows.$inferSelect, index: number) {
  const shiftStart = parseTimeToMinutes(shiftRow.startTime);
  let shiftEnd = parseTimeToMinutes(shiftRow.endTime);
  if (shiftEnd < shiftStart) shiftEnd += 1440;

  const breakStart = shiftStart + shiftRow.breakBaseOffsetMinutes + index * shiftRow.breakStaggerMinutes;
  const breakEnd = breakStart + shiftRow.breakDurationMinutes;
  // A rule that cannot fit the shift should not create an out-of-shift break.
  if (shiftRow.breakDurationMinutes <= 0 || breakStart < shiftStart || breakEnd > shiftEnd) return null;

  return {
    breakStartTime: minutesToTimeStr(breakStart),
    breakEndTime: minutesToTimeStr(breakEnd),
    breakDurationMinutes: shiftRow.breakDurationMinutes,
    hasConflict: false,
  };
}

export async function generateBreaksForShiftRow(shiftRowId: string, shiftDate: string): Promise<void> {
  const [shiftRow] = await db
    .select()
    .from(scheduleShiftRows)
    .where(eq(scheduleShiftRows.id, shiftRowId));

  if (!shiftRow) return;

  if (!shiftRow.breakEnabled) {
    await db
      .delete(scheduleShiftBreaks)
      .where(
        and(
          eq(scheduleShiftBreaks.shiftRowId, shiftRowId),
          eq(scheduleShiftBreaks.shiftDate, shiftDate),
          eq(scheduleShiftBreaks.source, "auto_rule")
        )
      );
    return;
  }

  const assignments = await db
    .select()
    .from(scheduleAssignments)
    .where(
      and(
        eq(scheduleAssignments.shiftRowId, shiftRowId),
        eq(scheduleAssignments.shiftDate, shiftDate)
      )
    )
    .orderBy(asc(scheduleAssignments.assignedAt), asc(scheduleAssignments.id));

  await db
    .delete(scheduleShiftBreaks)
    .where(
      and(
        eq(scheduleShiftBreaks.shiftRowId, shiftRowId),
        eq(scheduleShiftBreaks.shiftDate, shiftDate),
        eq(scheduleShiftBreaks.source, "auto_rule")
      )
    );

  const breakValues = assignments.flatMap((assignment, i) => {
    const window = autoBreakWindow(shiftRow, i);
    if (!window) return [];
    return [{
      tenantId: shiftRow.tenantId,
      branchId: shiftRow.branchId,
      shiftRowId: shiftRowId,
      shiftDate: shiftDate,
      employeeId: assignment.employeeId,
      casualWorkerId: assignment.casualWorkerId,
      assignmentId: assignment.id,
      ...window,
      source: "auto_rule" as const,
    }];
  });

  if (breakValues.length > 0) {
    await db.insert(scheduleShiftBreaks).values(breakValues);
  }
}

export async function generateBreaksForWeekPlan(weekPlanId: string): Promise<void> {
  // Look up the week plan to get branchId and date range
  const [weekPlan] = await db.select().from(scheduleWeekPlans).where(eq(scheduleWeekPlans.id, weekPlanId));
  if (!weekPlan) return;

  const wpStart = typeof weekPlan.weekStartDate === 'string' ? weekPlan.weekStartDate : (weekPlan.weekStartDate as Date).toISOString().split('T')[0];
  const wpEnd = new Date(wpStart);
  wpEnd.setDate(wpEnd.getDate() + 6);
  const wpEndStr = wpEnd.toISOString().split('T')[0];

  const shiftRows = await db
    .select()
    .from(scheduleShiftRows)
    .where(and(
      eq(scheduleShiftRows.branchId, weekPlan.branchId),
      or(isNull(scheduleShiftRows.activeFromDate), sql`${scheduleShiftRows.activeFromDate} <= ${wpEndStr}::date`),
      or(isNull(scheduleShiftRows.activeUntilDate), sql`${scheduleShiftRows.activeUntilDate} >= ${wpStart}::date`),
    ));

  if (shiftRows.length === 0) return;

  const shiftRowIds = shiftRows.map(r => r.id);

  const allAssignments = await db
    .select()
    .from(scheduleAssignments)
    .where(inArray(scheduleAssignments.shiftRowId, shiftRowIds))
    .orderBy(asc(scheduleAssignments.assignedAt), asc(scheduleAssignments.id));

  const shiftRowMap = new Map(shiftRows.map(r => [r.id, r]));

  await db
    .delete(scheduleShiftBreaks)
    .where(
      and(
        inArray(scheduleShiftBreaks.shiftRowId, shiftRowIds),
        eq(scheduleShiftBreaks.source, "auto_rule")
      )
    );

  const groupedAssignments = new Map<string, typeof allAssignments>();
  for (const a of allAssignments) {
    const key = `${a.shiftRowId}|${a.shiftDate}`;
    if (!groupedAssignments.has(key)) groupedAssignments.set(key, []);
    groupedAssignments.get(key)!.push(a);
  }

  const allBreakValues: any[] = [];

  for (const [key, assignments] of groupedAssignments) {
    const [shiftRowId] = key.split("|");
    const shiftDate = key.substring(shiftRowId.length + 1);
    const shiftRow = shiftRowMap.get(shiftRowId);
    if (!shiftRow || !shiftRow.breakEnabled) continue;

    for (let i = 0; i < assignments.length; i++) {
      const assignment = assignments[i];
      const window = autoBreakWindow(shiftRow, i);
      if (!window) continue;

      allBreakValues.push({
        tenantId: shiftRow.tenantId,
        branchId: shiftRow.branchId,
        shiftRowId: shiftRowId,
        shiftDate: shiftDate,
        employeeId: assignment.employeeId,
        casualWorkerId: assignment.casualWorkerId,
        assignmentId: assignment.id,
        ...window,
        source: "auto_rule" as const,
      });
    }
  }

  if (allBreakValues.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < allBreakValues.length; i += BATCH_SIZE) {
      const batch = allBreakValues.slice(i, i + BATCH_SIZE);
      await db.insert(scheduleShiftBreaks).values(batch);
    }
  }
}

export async function generateAllBreaksForTenant(tenantId: string, branchId?: string): Promise<{ shiftRowsProcessed: number; datesProcessed: number; breaksGenerated: number }> {
  const conditions = [
    eq(scheduleShiftRows.tenantId, tenantId),
    eq(scheduleShiftRows.breakEnabled, true),
  ];
  if (branchId) conditions.push(eq(scheduleShiftRows.branchId, branchId));

  const shiftRows = await db
    .select()
    .from(scheduleShiftRows)
    .where(and(...conditions));

  if (shiftRows.length === 0) return { shiftRowsProcessed: 0, datesProcessed: 0, breaksGenerated: 0 };

  const shiftRowIds = shiftRows.map(r => r.id);
  const shiftRowMap = new Map(shiftRows.map(r => [r.id, r]));

  const allAssignments = await db
    .select()
    .from(scheduleAssignments)
    .where(inArray(scheduleAssignments.shiftRowId, shiftRowIds))
    .orderBy(asc(scheduleAssignments.assignedAt), asc(scheduleAssignments.id));

  await db
    .delete(scheduleShiftBreaks)
    .where(
      and(
        inArray(scheduleShiftBreaks.shiftRowId, shiftRowIds),
        eq(scheduleShiftBreaks.source, "auto_rule")
      )
    );

  const groupedAssignments = new Map<string, typeof allAssignments>();
  for (const a of allAssignments) {
    const key = `${a.shiftRowId}|${a.shiftDate}`;
    if (!groupedAssignments.has(key)) groupedAssignments.set(key, []);
    groupedAssignments.get(key)!.push(a);
  }

  const allBreakValues: any[] = [];

  for (const [key, assignments] of groupedAssignments) {
    const [shiftRowId] = key.split("|");
    const shiftDate = key.substring(shiftRowId.length + 1);
    const shiftRow = shiftRowMap.get(shiftRowId);
    if (!shiftRow) continue;

    for (let i = 0; i < assignments.length; i++) {
      const assignment = assignments[i];
      const window = autoBreakWindow(shiftRow, i);
      if (!window) continue;

      allBreakValues.push({
        tenantId: shiftRow.tenantId,
        branchId: shiftRow.branchId,
        shiftRowId: shiftRowId,
        shiftDate: shiftDate,
        employeeId: assignment.employeeId,
        casualWorkerId: assignment.casualWorkerId,
        assignmentId: assignment.id,
        ...window,
        source: "auto_rule" as const,
      });
    }
  }

  if (allBreakValues.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < allBreakValues.length; i += BATCH_SIZE) {
      const batch = allBreakValues.slice(i, i + BATCH_SIZE);
      await db.insert(scheduleShiftBreaks).values(batch);
    }
  }

  return {
    shiftRowsProcessed: shiftRows.length,
    datesProcessed: groupedAssignments.size,
    breaksGenerated: allBreakValues.length,
  };
}
