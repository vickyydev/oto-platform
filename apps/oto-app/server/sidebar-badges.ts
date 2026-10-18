import { and, asc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  attentionItems, branches, employees, payrollExceptions, payrollPeriods, payrollRuns,
  scheduleAssignments, scheduleShiftRows, timeAdjustments, timeEvents, timekeepingIssues,
  type UserWithBranchAccess,
} from "@shared/schema";
import { db } from "./db";
import { getAllowedOperatorAndBranchIds } from "./auth-middleware";
import { createDateTimeInTimezone, getLocalDateString, getMidnightInTimezone } from "./timezone-utils";

export interface SidebarBadges { needsAction: number; todaysAttendance: number }

// Counts are computed only over branches the current user may access. CSV
// branchIds is an optional UI selection; requested IDs are always intersected
// with the server-derived scope. needsAction counts open, branch-bound attention
// items. todaysAttendance counts distinct branch/person/local-day/category flags:
// late, early leave, missed punch, no-show, pending time adjustment, and open
// overtime approval. Attendance flags use time_events and the review's 5-minute
// late/no-show grace. Early leave uses a symmetric >5-minute-before-scheduled-end
// threshold (the review has no distinct early-leave threshold). Missed punch
// follows the review's MISSING_IN derivation (OUT without a preceding IN); a
// normal open session is not counted as a missed punch. Derived attendance
// anomalies are live event/schedule calculations, not persisted/resolution-aware
// flags. Repeated records are deduplicated by category/day, and a no-show replaces
// a missing-clock-in flag for that same person/day.

// Returns null when the caller has no park group to count in.
export async function computeSidebarBadges(
  user: UserWithBranchAccess,
  rawBranchIds: unknown,
): Promise<SidebarBadges | null> {
  const scope = await getAllowedOperatorAndBranchIds(user);
  const tenantId = user.tenantId;
  if (!tenantId) return null;
  const tenantBranches = await db.select({
    id: branches.id,
    timezone: branches.timezone,
  }).from(branches).where(eq(branches.tenantId, tenantId));
  const allowedIds = new Set(tenantBranches
    .filter((branch) => scope.branchIds === null || scope.branchIds.includes(branch.id))
    .map((branch) => branch.id));

  let selectedIds = Array.from(allowedIds);
  if (rawBranchIds !== undefined) {
    const raw = Array.isArray(rawBranchIds) ? rawBranchIds.join(",") : String(rawBranchIds);
    const requested = new Set(raw.split(",").map((id) => id.trim()).filter(Boolean));
    selectedIds = Array.from(allowedIds).filter((id) => requested.has(id));
  }
  if (selectedIds.length === 0) return { needsAction: 0, todaysAttendance: 0 };

  const now = new Date();
  const selectedBranches = tenantBranches.filter((branch) => selectedIds.includes(branch.id));
  const todayByBranch = new Map(selectedBranches
    .map((branch) => [branch.id, getLocalDateString(now, branch.timezone || "Asia/Bangkok")]));
  const todayDates = Array.from(new Set(todayByBranch.values()));
  const timeWindows = selectedBranches.map((branch) => {
    const date = todayByBranch.get(branch.id)!;
    const timezone = branch.timezone || "Asia/Bangkok";
    return {
      branchId: branch.id,
      date,
      start: getMidnightInTimezone(date, timezone),
      end: createDateTimeInTimezone(date, "23:59:59", timezone),
    };
  });
  const [needsActionResult, pendingRequests, overtimeRows, eventRows, assignments, openIssues] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(attentionItems)
      .innerJoin(branches, eq(branches.id, attentionItems.branchId))
      .where(and(
        eq(branches.tenantId, tenantId),
        inArray(attentionItems.branchId, selectedIds),
        eq(attentionItems.status, "open"),
      )),
    db.select({
      branchId: timeAdjustments.branchId,
      employeeId: timeAdjustments.employeeId,
      workDate: timeAdjustments.workDate,
    }).from(timeAdjustments).where(and(
      eq(timeAdjustments.tenantId, tenantId),
      inArray(timeAdjustments.branchId, selectedIds),
      inArray(timeAdjustments.workDate, todayDates),
      eq(timeAdjustments.approvalStatus, "PENDING"),
    )),
    db.select({
      branchId: payrollExceptions.branchId,
      employeeId: payrollExceptions.employeeId,
      workDate: payrollExceptions.workDate,
    }).from(payrollExceptions)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payrollExceptions.payrollRunId))
      .innerJoin(payrollPeriods, eq(payrollPeriods.id, payrollRuns.payrollPeriodId))
      .where(and(
        eq(payrollPeriods.tenantId, tenantId),
        inArray(payrollExceptions.branchId, selectedIds),
        inArray(payrollExceptions.workDate, todayDates),
        eq(payrollExceptions.exceptionType, "OT_REQUIRES_APPROVAL"),
        eq(payrollExceptions.status, "OPEN"),
      )),
    db.select({
      branchId: timeEvents.branchId,
      employeeId: timeEvents.employeeId,
      eventType: timeEvents.eventType,
      eventTime: timeEvents.eventTime,
    }).from(timeEvents).where(and(
      eq(timeEvents.tenantId, tenantId),
      inArray(timeEvents.branchId, selectedIds),
      or(...timeWindows.map((window) => and(
        eq(timeEvents.branchId, window.branchId),
        gte(timeEvents.eventTime, window.start),
        lte(timeEvents.eventTime, window.end),
      ))),
    )).orderBy(asc(timeEvents.eventTime)),
    db.select({
      branchId: scheduleShiftRows.branchId,
      employeeId: scheduleAssignments.employeeId,
      shiftDate: scheduleAssignments.shiftDate,
      startTime: scheduleShiftRows.startTime,
      endTime: scheduleShiftRows.endTime,
    }).from(scheduleAssignments)
      .innerJoin(scheduleShiftRows, eq(scheduleShiftRows.id, scheduleAssignments.shiftRowId))
      .innerJoin(employees, eq(employees.id, scheduleAssignments.employeeId))
      .where(and(
        eq(scheduleAssignments.tenantId, tenantId),
        eq(scheduleShiftRows.tenantId, tenantId),
        inArray(scheduleShiftRows.branchId, selectedIds),
        inArray(scheduleAssignments.shiftDate, todayDates),
        eq(employees.status, "active"),
        isNotNull(scheduleAssignments.employeeId),
      )),
    db.select({
      branchId: timekeepingIssues.branchId,
      employeeId: timekeepingIssues.employeeId,
      issueDate: timekeepingIssues.issueDate,
      issueType: timekeepingIssues.issueType,
    }).from(timekeepingIssues).where(and(
      eq(timekeepingIssues.tenantId, tenantId),
      inArray(timekeepingIssues.branchId, selectedIds),
      inArray(timekeepingIssues.issueDate, todayDates),
      eq(timekeepingIssues.status, "OPEN"),
      inArray(timekeepingIssues.issueType, ["MISSING_CLOCK_IN", "MISSING_CLOCK_OUT"]),
    )),
  ]);
  const attendanceKeys = new Set<string>();
  for (const issue of openIssues) {
    if (todayByBranch.get(issue.branchId) === issue.issueDate) {
      attendanceKeys.add(`missedPunch:${issue.branchId}:${issue.employeeId}:${issue.issueDate}`);
    }
  }
  for (const request of pendingRequests) {
    if (todayByBranch.get(request.branchId) === request.workDate) {
      attendanceKeys.add(`clockRequest:${request.branchId}:${request.employeeId}:${request.workDate}`);
    }
  }
  for (const exception of overtimeRows) {
    if (exception.branchId && exception.workDate && todayByBranch.get(exception.branchId) === exception.workDate) {
      attendanceKeys.add(`overtime:${exception.branchId}:${exception.employeeId}:${exception.workDate}`);
    }
  }

  const eventsByBranchEmployee = new Map<string, typeof eventRows>();
  const employeeIdsByBranch = new Map<string, Set<string>>();
  for (const event of eventRows) {
    const key = `${event.branchId}:${event.employeeId}`;
    const grouped = eventsByBranchEmployee.get(key) || [];
    grouped.push(event);
    eventsByBranchEmployee.set(key, grouped);
    const branchEmployees = employeeIdsByBranch.get(event.branchId) || new Set<string>();
    branchEmployees.add(event.employeeId);
    employeeIdsByBranch.set(event.branchId, branchEmployees);
  }
  const scheduleByBranchEmployee = new Map<string, typeof assignments[number]>();
  for (const assignment of assignments) {
    if (!assignment.employeeId || todayByBranch.get(assignment.branchId) !== assignment.shiftDate) continue;
    const key = `${assignment.branchId}:${assignment.employeeId}`;
    if (!scheduleByBranchEmployee.has(key)) scheduleByBranchEmployee.set(key, assignment);
    const branchEmployees = employeeIdsByBranch.get(assignment.branchId) || new Set<string>();
    branchEmployees.add(assignment.employeeId);
    employeeIdsByBranch.set(assignment.branchId, branchEmployees);
  }
  for (const branch of selectedBranches) {
    const date = todayByBranch.get(branch.id)!;
    const timezone = branch.timezone || "Asia/Bangkok";
    const branchEmployeeIds = employeeIdsByBranch.get(branch.id) || new Set<string>();
    for (const employeeId of Array.from(branchEmployeeIds)) {
      const key = `${branch.id}:${employeeId}`;
      const dayEvents = eventsByBranchEmployee.get(key) || [];
      let hasOpenIn = false;
      let hasMissingIn = false;
      let firstInTime: Date | null = null;
      let lastOutTime: Date | null = null;
      for (const event of dayEvents) {
        if (event.eventType === "IN") {
          firstInTime ||= event.eventTime;
          if (!hasOpenIn) hasOpenIn = true;
        } else {
          if (hasOpenIn) hasOpenIn = false;
          else hasMissingIn = true;
          lastOutTime = event.eventTime;
        }
      }
      const assignment = scheduleByBranchEmployee.get(key);
      if (hasMissingIn) attendanceKeys.add(`missedPunch:${branch.id}:${employeeId}:${date}`);
      if (assignment && firstInTime) {
        const scheduledStart = createDateTimeInTimezone(date, assignment.startTime, timezone);
        const lateMinutes = Math.floor((firstInTime.getTime() - scheduledStart.getTime()) / 60000);
        if (lateMinutes > 5) attendanceKeys.add(`late:${branch.id}:${employeeId}:${date}`);
        const scheduledEnd = createDateTimeInTimezone(date, assignment.endTime, timezone);
        if (scheduledEnd <= scheduledStart) scheduledEnd.setTime(scheduledEnd.getTime() + 24 * 60 * 60 * 1000);
        if (lastOutTime && !hasOpenIn) {
          const earlyMinutes = Math.floor((scheduledEnd.getTime() - lastOutTime.getTime()) / 60000);
          if (now >= scheduledEnd && earlyMinutes > 5) attendanceKeys.add(`earlyLeave:${branch.id}:${employeeId}:${date}`);
        }
        if (hasOpenIn && now.getTime() > scheduledEnd.getTime() + 30 * 60 * 1000) {
          attendanceKeys.add(`missedPunch:${branch.id}:${employeeId}:${date}`);
        }
      } else if (assignment && !eventsByBranchEmployee.has(key)) {
        const scheduledStart = createDateTimeInTimezone(date, assignment.startTime, timezone);
        const graceEnd = new Date(scheduledStart.getTime() + 5 * 60 * 1000);
        if (now > graceEnd) attendanceKeys.add(`noShow:${branch.id}:${employeeId}:${date}`);
      }
    }
  }
  return { needsAction: Number(needsActionResult[0]?.count || 0), todaysAttendance: attendanceKeys.size };
}
