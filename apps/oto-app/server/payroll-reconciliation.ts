import { db } from "./db";
import {
  timeEvents,
  scheduleAssignments,
  scheduleShiftRows,
  employees,
  payrollDayReconciliations,
  payrollExceptions,
} from "@shared/schema";
import { and, eq, gte, lte, inArray } from "drizzle-orm";
import { storage } from "./storage";

export interface ReconciliationConfig {
  payrollRunId: string;
  startDate: string;
  endDate: string;
  branchIds: string[];
  overtimeThresholdMinutes: number;
  lateThresholdMinutes: number;
}

interface ShiftSchedule {
  shiftDate: string;
  employeeId: string;
  branchId: string;
  shiftRowId: string;
  startTime: string;
  endTime: string;
  scheduledMinutes: number;
  departmentId: string;
  isBorrowed: boolean;
}

interface WorkSession {
  employeeId: string;
  branchId: string;
  date: string;
  clockInTime: Date | null;
  clockOutTime: Date | null;
  workedMinutes: number;
  isOpenSession: boolean;
  events: Array<{ type: string; time: Date }>;
}

interface ReconciliationResult {
  reconciliationsCreated: number;
  exceptionsCreated: number;
  errors: string[];
}

type ReconciliationStatus = "MATCHED" | "VARIANCE" | "MISSING_CLOCK" | "UNSCHEDULED";

export async function runPayrollReconciliation(
  config: ReconciliationConfig
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    reconciliationsCreated: 0,
    exceptionsCreated: 0,
    errors: [],
  };

  try {
    const schedules = await getScheduledShifts(
      config.branchIds,
      config.startDate,
      config.endDate
    );
    const sessions = await getWorkSessions(
      config.branchIds,
      config.startDate,
      config.endDate
    );
    const scheduleMap = buildScheduleMap(schedules);
    const sessionMap = buildSessionMap(sessions);
    const allEmployeeIds = Array.from(new Set([
      ...schedules.map((s) => s.employeeId),
      ...sessions.map((s) => s.employeeId),
    ]));
    const allDates = getDateRange(config.startDate, config.endDate);
    for (const employeeId of allEmployeeIds) {
      for (const date of allDates) {
        const key = `${employeeId}_${date}`;
        const schedules = scheduleMap.get(key) || [];
        const sessions = sessionMap.get(key) || [];
        if (schedules.length === 0 && sessions.length === 0) continue;
        const branchId = schedules[0]?.branchId || sessions[0]?.branchId;
        if (!branchId) continue;
        const totalScheduledMinutes = schedules.reduce((sum, s) => sum + s.scheduledMinutes, 0);
        const totalActualMinutes = sessions.reduce((sum, s) => sum + s.workedMinutes, 0);
        const hasOpenSession = sessions.some(s => s.isOpenSession);
        const aggregatedSchedule = schedules.length > 0 ? {
          ...schedules[0],
          scheduledMinutes: totalScheduledMinutes,
          shiftCount: schedules.length,
        } : undefined;
        const aggregatedSession = sessions.length > 0 ? {
          ...sessions[0],
          workedMinutes: totalActualMinutes,
          isOpenSession: hasOpenSession,
          sessionCount: sessions.length,
        } : undefined;
        const reconciliation = await createReconciliation(
          config.payrollRunId,
          employeeId,
          branchId,
          date,
          aggregatedSchedule,
          aggregatedSession,
          config
        );
        if (reconciliation) {
          result.reconciliationsCreated++;
          const exceptions = await generateExceptions(
            config.payrollRunId,
            employeeId,
            branchId,
            date,
            aggregatedSchedule,
            aggregatedSession,
            config
          );
          result.exceptionsCreated += exceptions.length;
        }
      }
    }
  } catch (error: any) {
    result.errors.push(error.message || "Unknown error");
  }

  return result;
}

async function getScheduledShifts(
  branchIds: string[],
  startDate: string,
  endDate: string
): Promise<ShiftSchedule[]> {
  if (!branchIds.length) return [];
  const assignments = await db
    .select({
      shiftDate: scheduleAssignments.shiftDate,
      employeeId: scheduleAssignments.employeeId,
      shiftRowId: scheduleAssignments.shiftRowId,
      startTime: scheduleShiftRows.startTime,
      endTime: scheduleShiftRows.endTime,
      departmentId: scheduleShiftRows.departmentId,
      branchId: scheduleShiftRows.branchId,
      isBorrowed: scheduleAssignments.isBorrowed,
    })
    .from(scheduleAssignments)
    .innerJoin(
      scheduleShiftRows,
      eq(scheduleAssignments.shiftRowId, scheduleShiftRows.id)
    )
    .where(
      and(
        inArray(scheduleShiftRows.branchId, branchIds),
        gte(scheduleAssignments.shiftDate, startDate),
        lte(scheduleAssignments.shiftDate, endDate)
      )
    );

  return assignments.map((a) => ({
    shiftDate: a.shiftDate,
    employeeId: a.employeeId,
    branchId: a.branchId,
    shiftRowId: a.shiftRowId,
    startTime: a.startTime,
    endTime: a.endTime,
    scheduledMinutes: calculateShiftMinutes(a.startTime, a.endTime),
    departmentId: a.departmentId,
    isBorrowed: a.isBorrowed,
  }));
}

async function getWorkSessions(
  branchIds: string[],
  startDate: string,
  endDate: string
): Promise<WorkSession[]> {
  if (!branchIds.length) return [];
  const startDateTime = new Date(`${startDate}T00:00:00`);
  const endDateTime = new Date(`${endDate}T23:59:59`);
  const events = await db
    .select()
    .from(timeEvents)
    .where(
      and(
        inArray(timeEvents.branchId, branchIds),
        gte(timeEvents.eventTime, startDateTime),
        lte(timeEvents.eventTime, endDateTime)
      )
    )
    .orderBy(timeEvents.employeeId, timeEvents.eventTime);

  const sessionsArray: WorkSession[] = [];
  const eventsByEmployeeDate = new Map<string, Array<{ type: string; time: Date; branchId: string }>>();
  for (const event of events) {
    const dateStr = event.eventTime.toISOString().split("T")[0];
    const key = `${event.employeeId}_${dateStr}`;
    if (!eventsByEmployeeDate.has(key)) {
      eventsByEmployeeDate.set(key, []);
    }
    eventsByEmployeeDate.get(key)!.push({
      type: event.eventType,
      time: event.eventTime,
      branchId: event.branchId,
    });
  }
  for (const [key, dayEvents] of eventsByEmployeeDate) {
    const [employeeId, date] = key.split("_");
    const branchId = dayEvents[0]?.branchId || "";
    let currentIn: Date | null = null;
    let totalWorkedMinutes = 0;
    let sessionCount = 0;
    let hasOpenSession = false;
    const sortedEvents = dayEvents.sort((a, b) => a.time.getTime() - b.time.getTime());
    for (const evt of sortedEvents) {
      if (evt.type === "IN") {
        currentIn = evt.time;
      } else if (evt.type === "OUT" && currentIn) {
        const minutes = Math.floor((evt.time.getTime() - currentIn.getTime()) / 60000);
        totalWorkedMinutes += minutes;
        sessionCount++;
        currentIn = null;
      }
    }
    if (currentIn !== null) {
      hasOpenSession = true;
    }
    sessionsArray.push({
      employeeId,
      branchId,
      date,
      clockInTime: sortedEvents.find(e => e.type === "IN")?.time || null,
      clockOutTime: sortedEvents.filter(e => e.type === "OUT").pop()?.time || null,
      workedMinutes: totalWorkedMinutes,
      isOpenSession: hasOpenSession,
      events: sortedEvents.map(e => ({ type: e.type, time: e.time })),
    });
  }

  return sessionsArray;
}

function buildScheduleMap(schedules: ShiftSchedule[]): Map<string, ShiftSchedule[]> {
  const map = new Map<string, ShiftSchedule[]>();
  for (const s of schedules) {
    const key = `${s.employeeId}_${s.shiftDate}`;
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(s);
  }
  return map;
}

function buildSessionMap(sessions: WorkSession[]): Map<string, WorkSession[]> {
  const map = new Map<string, WorkSession[]>();
  for (const s of sessions) {
    const key = `${s.employeeId}_${s.date}`;
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(s);
  }
  return map;
}

function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function calculateShiftMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let startMins = sh * 60 + sm;
  let endMins = eh * 60 + em;
  if (endMins <= startMins) {
    endMins += 24 * 60;
  }
  return endMins - startMins;
}

async function createReconciliation(
  payrollRunId: string,
  employeeId: string,
  branchId: string,
  workDate: string,
  schedule: ShiftSchedule | undefined,
  session: WorkSession | undefined,
  config: ReconciliationConfig
): Promise<any> {
  const scheduledMinutes = schedule?.scheduledMinutes || 0;
  const actualMinutes = session?.workedMinutes || 0;
  const varianceMinutes = actualMinutes - scheduledMinutes;
  const overtimeMinutes = varianceMinutes > config.overtimeThresholdMinutes
    ? varianceMinutes - config.overtimeThresholdMinutes
    : 0;
  let status: ReconciliationStatus = "MATCHED";
  if (!schedule && session) {
    status = "UNSCHEDULED";
  } else if (schedule && !session) {
    status = "MISSING_CLOCK";
  } else if (session?.isOpenSession) {
    status = "MISSING_CLOCK";
  } else if (Math.abs(varianceMinutes) > config.lateThresholdMinutes) {
    status = "VARIANCE";
  }

  return await storage.createPayrollDayReconciliation({
    payrollRunId,
    employeeId,
    branchId,
    workDate,
    scheduledMinutes,
    actualMinutes,
    varianceMinutes,
    overtimeMinutes,
    scheduledPay: "0",
    actualPay: "0",
    varianceAmount: "0",
    flags: {
      status,
      isOpenSession: session?.isOpenSession || false,
      schedule: schedule || null,
      session: session ? { clockIn: session.clockInTime, clockOut: session.clockOutTime } : null,
    },
  });
}

async function generateExceptions(
  payrollRunId: string,
  employeeId: string,
  branchId: string,
  workDate: string,
  schedule: ShiftSchedule | undefined,
  session: WorkSession | undefined,
  config: ReconciliationConfig
): Promise<any[]> {
  const exceptions: any[] = [];
  if (schedule && !session) {
    const exception = await storage.createPayrollException({
      payrollRunId,
      employeeId,
      branchId,
      workDate,
      exceptionType: "MISSING_PUNCH",
      severity: "BLOCKER",
      message: `No clock events found for scheduled shift on ${workDate}`,
      details: { scheduledMinutes: schedule.scheduledMinutes, type: "NO_CLOCK_IN" },
      status: "OPEN",
    });
    exceptions.push(exception);
  }
  if (session?.isOpenSession) {
    const exception = await storage.createPayrollException({
      payrollRunId,
      employeeId,
      branchId,
      workDate,
      exceptionType: "MISSING_PUNCH",
      severity: "WARNING",
      message: `Open work session (missing clock-out) on ${workDate}`,
      details: { clockInTime: session.clockInTime, type: "NO_CLOCK_OUT" },
      status: "OPEN",
    });
    exceptions.push(exception);
  }
  if (schedule && session && !session.isOpenSession) {
    if (session.clockInTime) {
      const scheduledStart = parseTimeToMinutes(schedule.startTime);
      const actualStart = session.clockInTime.getHours() * 60 + session.clockInTime.getMinutes();
      const lateMinutes = actualStart - scheduledStart;
      if (lateMinutes > config.lateThresholdMinutes) {
        const exception = await storage.createPayrollException({
          payrollRunId,
          employeeId,
          branchId,
          workDate,
          exceptionType: "VARIANCE_OVER_THRESHOLD",
          severity: "INFO",
          message: `Late arrival: ${lateMinutes} minutes late on ${workDate}`,
          details: { lateMinutes, scheduledStart, actualStart, type: "LATE_ARRIVAL" },
          status: "OPEN",
        });
        exceptions.push(exception);
      }
    }
    const overtimeMinutes = session.workedMinutes - schedule.scheduledMinutes;
    if (overtimeMinutes > config.overtimeThresholdMinutes) {
      const exception = await storage.createPayrollException({
        payrollRunId,
        employeeId,
        branchId,
        workDate,
        exceptionType: "OT_REQUIRES_APPROVAL",
        severity: "INFO",
        message: `Overtime: ${overtimeMinutes} extra minutes on ${workDate}`,
        details: { overtimeMinutes, scheduledMinutes: schedule.scheduledMinutes, actualMinutes: session.workedMinutes },
        status: "OPEN",
      });
      exceptions.push(exception);
    }
  }
  if (!schedule && session && session.workedMinutes > 0) {
    const exception = await storage.createPayrollException({
      payrollRunId,
      employeeId,
      branchId,
      workDate,
      exceptionType: "MANUAL_OVERRIDE_REQUIRED",
      severity: "WARNING",
      message: `Unscheduled work: ${session.workedMinutes} minutes on ${workDate}`,
      details: { workedMinutes: session.workedMinutes, type: "UNSCHEDULED" },
      status: "OPEN",
    });
    exceptions.push(exception);
  }

  return exceptions;
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export async function getReconciliationSummary(payrollRunId: string) {
  const reconciliations = await db
    .select()
    .from(payrollDayReconciliations)
    .where(eq(payrollDayReconciliations.payrollRunId, payrollRunId));

  const exceptions = await storage.getPayrollExceptions(payrollRunId);
  const totalScheduledMinutes = reconciliations.reduce(
    (sum, r) => sum + (r.scheduledMinutes || 0),
    0
  );
  const totalActualMinutes = reconciliations.reduce(
    (sum, r) => sum + (r.actualMinutes || 0),
    0
  );
  const totalOvertimeMinutes = reconciliations.reduce(
    (sum, r) => sum + (r.overtimeMinutes || 0),
    0
  );
  const totalVarianceMinutes = reconciliations.reduce(
    (sum, r) => sum + (r.varianceMinutes || 0),
    0
  );
  const statusCounts = {
    MATCHED: 0,
    VARIANCE: 0,
    MISSING_CLOCK: 0,
    UNSCHEDULED: 0,
  };
  for (const r of reconciliations) {
    const flags = r.flags as any;
    const status = flags?.status;
    if (status && statusCounts.hasOwnProperty(status)) {
      statusCounts[status as keyof typeof statusCounts]++;
    }
  }
  const exceptionsBySeverity = {
    INFO: exceptions.filter((e) => e.severity === "INFO").length,
    WARNING: exceptions.filter((e) => e.severity === "WARNING").length,
    BLOCKER: exceptions.filter((e) => e.severity === "BLOCKER").length,
  };
  const pendingBlockers = exceptions.filter(
    (e) => e.severity === "BLOCKER" && e.status === "OPEN"
  ).length;

  return {
    totalDays: reconciliations.length,
    totalScheduledMinutes,
    totalActualMinutes,
    totalOvertimeMinutes,
    totalVarianceMinutes,
    statusCounts,
    totalExceptions: exceptions.length,
    exceptionsBySeverity,
    pendingBlockers,
    canFinalize: pendingBlockers === 0,
  };
}
