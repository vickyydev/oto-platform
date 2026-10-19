/**
 * The attendance feed (SCRUM-568, the company payroll's R3; plan §3): our real
 * attendance turned into the prototype's `AttendanceDay[]` (engine/model.ts),
 * one row per person per branch-local day. The engine then applies its own
 * worked-day rule unchanged (company-math.workedDates): a worked day is any
 * day whose effective clock-in exists after corrections, and a run override's
 * clock-in wins.
 *
 * Where the numbers come from, as built:
 *   - Punches. `time_events` (IN/OUT) are the record of every clock, the normal
 *     kiosk flow and the exception flows alike (those also write their punches
 *     there "for compatibility"). A session opens on an IN and closes on the
 *     next OUT; it belongs to the branch-local date of its IN, so a shift that
 *     ends after midnight stays one day. actualClockIn = the first IN of the
 *     day, actualClockOut = the last OUT of the day's sessions (HH:mm, the
 *     punch branch's timezone).
 *   - Exception entries. `time_entries` exist only where a flow needed a
 *     manager's decision (missed clock-in, unscheduled work). APPROVED/LOCKED:
 *     the entry's clocks are the effective clocks. PENDING_APPROVAL, AUTO_FIXED
 *     or RAW (still waiting): no effective clock yet, the punches stay actual,
 *     and the day carries an open exception. REJECTED (and nothing approved
 *     that day): the claimed work is refused, so the day has NO clock — the
 *     compatibility punches that flow wrote are disregarded, which is the only
 *     way the engine can see "not worked" (it falls back to the actual clock).
 *   - A day with no entry: the punches are the effective clocks (normal
 *     punches need no approval).
 *   - Exceptions. Each `timekeeping_issues` row of the day: late, early
 *     departure, missed punch (missing/multiple in or out, unscheduled work),
 *     long shift as overtime. Resolution: RESOLVED -> Corrected for a missing
 *     punch (the clock was supplied), Approved otherwise; REJECTED -> Corrected
 *     with no clock; OPEN -> null (unresolved). Beside them, derived from the
 *     punches and the rota where no issue of that kind exists: an unpaired
 *     punch (missed punch), a clock-in after the planned start (late), a
 *     clock-out before the planned end (early departure), a rostered past day
 *     with no clock and no time off (no-show) — all unresolved, since no
 *     upstream review exists for them — and `overtime` when hours are above 0.
 *     An unresolved exception with no run review is a blocking "unconfirmed
 *     attendance" item (company-calculations.ts:372).
 *   - Overtime. Effective (else actual) clock-out minus the planned clock-out,
 *     on a rostered day, when positive; the policy's minimum block and
 *     rounding are the engine's (roundedOvertimeHours). The old engine's
 *     variance-based OT is not reused.
 *   - scheduled / planned clocks: the day's rota assignments (earliest start,
 *     latest end); dayOff: the employee's weekly off days; holiday: the park
 *     group's active public holidays.
 *   - branchId: the person's ROSTER branch for the month (allocation home
 *     branch at month end); where they actually clocked is kept as
 *     `workedAtBranchId` for display (plan §3).
 *
 * Run corrections and excuses are NOT applied here: they live against the run
 * version (payroll_run_attendance_reviews) and the engine applies them to its
 * own copy "without changing source attendance". Nothing here writes.
 */
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  employeeTimeOff,
  publicHolidays,
  scheduleAssignments,
  scheduleShiftRows,
  timeEntries,
  timeEvents,
  timekeepingIssues,
} from "@shared/schema";
import { db } from "../db";
import type { AttendanceDay, AttendanceException, ExceptionKind, ExceptionResolution } from "./engine/model";

export type FeedAttendanceDay = AttendanceDay & { workedAtBranchId: string | null };

export interface AttendancePerson { id: string; rosterBranchId: string; weeklyOffDays: number[] }

export interface AttendanceSources {
  events: { employeeId: string; branchId: string; eventType: string; eventTime: Date }[];
  entries: { id: string; employeeId: string; branchId: string; shiftDate: string; clockInAt: Date | null; clockOutAt: Date | null; status: string; updatedAt: Date }[];
  issues: { id: string; employeeId: string; branchId: string; issueDate: string; issueType: string; status: string; resolutionNote: string | null; createdAt: Date }[];
  assignments: { employeeId: string; shiftDate: string; startTime: string; endTime: string }[];
  holidays: string[];
  timeOff: { employeeId: string; startDate: Date; endDate: Date }[];
}

export interface AttendanceWindow {
  from: string; to: string; today: string;
  timezones: Map<string, string>; defaultTimezone: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(instant: Date, timeZone: string): { date: string; time: string } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(instant).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const dayOfWeek = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

const ISSUE_KINDS: Record<string, ExceptionKind> = {
  LATE_ARRIVAL: "late", EARLY_DEPARTURE: "early-departure",
  MISSING_CLOCK_IN: "missed-punch", MISSING_CLOCK_OUT: "missed-punch", MULTIPLE_IN: "missed-punch", MULTIPLE_OUT: "missed-punch",
  UNSCHEDULED_WORK: "missed-punch", LONG_SHIFT: "overtime",
};
const MISSING_PUNCH = new Set(["MISSING_CLOCK_IN", "MISSING_CLOCK_OUT"]);
const APPROVED = new Set(["APPROVED", "LOCKED"]);

/** Pure: sources in, `AttendanceDay[]` out. Exported for the feed check. */
export function buildAttendanceDays(people: AttendancePerson[], sources: AttendanceSources, window: AttendanceWindow): FeedAttendanceDay[] {
  const tz = (branchId: string | null | undefined) => (branchId && window.timezones.get(branchId)) || window.defaultTimezone;
  const inWindow = (date: string) => date >= window.from && date <= window.to;
  const key = (employeeId: string, date: string) => `${employeeId}:${date}`;
  const holidays = new Set(sources.holidays);
  type Acc = { firstIn: string | null; lastOut: string | null; branchId: string | null; unpaired: boolean };
  const punches = new Map<string, Acc>();
  const touched = new Set<string>();
  const acc = (k: string) => { let a = punches.get(k); if (!a) { a = { firstIn: null, lastOut: null, branchId: null, unpaired: false }; punches.set(k, a); } return a; };

  const byPerson = new Map<string, AttendanceSources["events"]>();
  for (const e of sources.events) {
    const list = byPerson.get(e.employeeId) ?? [];
    list.push(e); byPerson.set(e.employeeId, list);
  }
  for (const [employeeId, events] of Array.from(byPerson.entries())) {
    events.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
    let open: { date: string } | null = null;
    for (const e of events) {
      const local = localParts(e.eventTime, tz(e.branchId));
      if (e.eventType === "IN") {
        if (open) { acc(key(employeeId, open.date)).unpaired = true; continue; }
        open = { date: local.date };
        const a = acc(key(employeeId, local.date));
        if (a.firstIn === null || local.time < a.firstIn) a.firstIn = local.time;
        a.branchId ??= e.branchId;
        touched.add(key(employeeId, local.date));
      } else {
        const date = open?.date ?? local.date;
        const a = acc(key(employeeId, date));
        if (!open) a.unpaired = true;
        a.lastOut = local.time;
        a.branchId ??= e.branchId;
        touched.add(key(employeeId, date));
        open = null;
      }
    }
    if (open) acc(key(employeeId, open.date)).unpaired = true;
  }
  const entries = new Map<string, AttendanceSources["entries"]>();
  for (const e of sources.entries) {
    const k = key(e.employeeId, e.shiftDate);
    const list = entries.get(k) ?? []; list.push(e); entries.set(k, list); touched.add(k);
  }
  const issues = new Map<string, AttendanceSources["issues"]>();
  for (const i of sources.issues) {
    const k = key(i.employeeId, i.issueDate);
    const list = issues.get(k) ?? []; list.push(i); issues.set(k, list); touched.add(k);
  }
  const plans = new Map<string, { start: string; end: string }>();
  for (const a of sources.assignments) {
    const k = key(a.employeeId, a.shiftDate);
    const start = a.startTime.slice(0, 5), end = a.endTime.slice(0, 5);
    const old = plans.get(k);
    plans.set(k, old ? { start: start < old.start ? start : old.start, end: end > old.end ? end : old.end } : { start, end });
    touched.add(k);
  }
  const onTimeOff = (employeeId: string, date: string) => sources.timeOff.some((t) =>
    t.employeeId === employeeId && dateOnly(t.startDate) <= date && dateOnly(t.endDate) >= date);

  const out: FeedAttendanceDay[] = [];
  for (const person of people) {
    const dates = Array.from(touched).filter((k) => k.startsWith(`${person.id}:`)).map((k) => k.slice(person.id.length + 1))
      .filter(inWindow).sort();
    for (const date of dates) {
      const k = key(person.id, date);
      const p = punches.get(k);
      const dayEntries = (entries.get(k) ?? []).slice().sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      const approved = dayEntries.filter((e) => APPROVED.has(e.status)).at(-1);
      const pending = dayEntries.some((e) => !APPROVED.has(e.status) && e.status !== "REJECTED");
      const rejectedOnly = dayEntries.length > 0 && !approved && !pending;
      let actualIn = p?.firstIn ?? null, actualOut = p?.lastOut ?? null;
      let effectiveIn: string | null, effectiveOut: string | null;
      if (approved) {
        const zone = tz(approved.branchId);
        effectiveIn = approved.clockInAt ? localParts(approved.clockInAt, zone).time : actualIn;
        effectiveOut = approved.clockOutAt ? localParts(approved.clockOutAt, zone).time : actualOut;
      } else if (rejectedOnly) {
        actualIn = null; actualOut = null; effectiveIn = null; effectiveOut = null;
      } else if (pending) {
        effectiveIn = null; effectiveOut = null;
      } else {
        effectiveIn = actualIn; effectiveOut = actualOut;
      }
      const plan = plans.get(k) ?? null;
      const scheduled = !!plan;
      const clockIn = effectiveIn ?? actualIn, clockOut = effectiveOut ?? actualOut;
      let overtimeHours = 0;
      if (plan && clockOut) {
        let diff = minutes(clockOut) - minutes(plan.end);
        if (clockIn && minutes(clockOut) < minutes(clockIn)) diff += 1440;
        if (diff > 0) overtimeHours = Math.round(diff / 60 * 10000) / 10000;
      }
      const exceptions: AttendanceException[] = [];
      const base = (kind: ExceptionKind, resolution: ExceptionResolution | null, reason: string, extra: Partial<AttendanceException> = {}): AttendanceException => ({
        kind, resolution, reason, rawClockIn: actualIn, rawClockOut: actualOut,
        effectiveClockIn: effectiveIn, effectiveClockOut: effectiveOut, approvedBy: resolution ? "Timekeeping review" : "", ...extra,
      });
      const kinds = new Set<ExceptionKind>();
      for (const issue of (issues.get(k) ?? []).slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
        const kind = ISSUE_KINDS[issue.issueType];
        if (!kind) continue;
        const resolution: ExceptionResolution | null = issue.status === "OPEN" ? null
          : issue.status === "REJECTED" || MISSING_PUNCH.has(issue.issueType) ? "Corrected" : "Approved";
        const reason = issue.resolutionNote?.trim() || (issue.status === "REJECTED" ? "Rejected in timekeeping review" : issue.status === "OPEN" ? `Open timekeeping issue: ${issue.issueType}` : "Approved in timekeeping review");
        exceptions.push(base(kind, resolution, reason, issue.status === "REJECTED" ? { effectiveClockIn: null, effectiveClockOut: null } : {}));
        kinds.add(kind);
      }
      const past = date < window.today;
      if (!kinds.has("missed-punch") && p?.unpaired && past) exceptions.push(base("missed-punch", null, "A clock-in or clock-out has no pair"));
      if (plan && clockIn && !kinds.has("late") && minutes(clockIn) > minutes(plan.start)) {
        exceptions.push(base("late", null, `Clocked in ${clockIn}, rota start ${plan.start}`, { minutes: minutes(clockIn) - minutes(plan.start) }));
      }
      if (plan && clockOut && !kinds.has("early-departure") && overtimeHours === 0 && minutes(clockOut) < minutes(plan.end) && minutes(clockOut) >= (clockIn ? minutes(clockIn) : 0)) {
        exceptions.push(base("early-departure", null, `Clocked out ${clockOut}, rota end ${plan.end}`, { minutes: minutes(plan.end) - minutes(clockOut) }));
      }
      if (plan && !clockIn && !clockOut && past && !rejectedOnly && !kinds.size && !onTimeOff(person.id, date)) {
        exceptions.push(base("no-show", null, `Rostered ${plan.start}–${plan.end}; no clock recorded`));
      }
      if (overtimeHours > 0 && !kinds.has("overtime")) exceptions.push(base("overtime", null, `${overtimeHours}h after the rota end ${plan!.end}`));
      out.push({
        id: k, branchId: person.rosterBranchId, staffId: person.id, date,
        scheduled, dayOff: person.weeklyOffDays.includes(dayOfWeek(date)), holiday: holidays.has(date),
        plannedClockIn: plan?.start ?? null, plannedClockOut: plan?.end ?? null,
        actualClockIn: actualIn, actualClockOut: actualOut, effectiveClockIn: effectiveIn, effectiveClockOut: effectiveOut,
        overtimeHours, exceptions,
        workedAtBranchId: p?.branchId ?? approved?.branchId ?? dayEntries[0]?.branchId ?? null,
      });
    }
  }
  return out;
}

/**
 * Reads the sources for these people and dates in a FIXED number of queries
 * (six, whatever the head count: plan §10's size rule) and builds the days.
 */
export async function loadAttendanceFeed(tenantId: string, people: AttendancePerson[], window: AttendanceWindow): Promise<{ days: FeedAttendanceDay[]; queries: number }> {
  if (!people.length) return { days: [], queries: 0 };
  const ids = people.map((p) => p.id);
  // Punches a day either side, so a branch-local date at either edge is whole.
  const fromInstant = new Date(Date.parse(`${window.from}T00:00:00Z`) - 86400000);
  const toInstant = new Date(Date.parse(`${window.to}T00:00:00Z`) + 2 * 86400000);
  const [events, entries, issues, assignments, holidays, timeOff] = await Promise.all([
    db.select({ employeeId: timeEvents.employeeId, branchId: timeEvents.branchId, eventType: timeEvents.eventType, eventTime: timeEvents.eventTime })
      .from(timeEvents).where(and(eq(timeEvents.tenantId, tenantId), inArray(timeEvents.employeeId, ids),
        gte(timeEvents.eventTime, fromInstant), lte(timeEvents.eventTime, toInstant))),
    db.select({ id: timeEntries.id, employeeId: timeEntries.employeeId, branchId: timeEntries.branchId, shiftDate: timeEntries.shiftDate,
      clockInAt: timeEntries.clockInAt, clockOutAt: timeEntries.clockOutAt, status: timeEntries.status, updatedAt: timeEntries.updatedAt })
      .from(timeEntries).where(and(eq(timeEntries.tenantId, tenantId), inArray(timeEntries.employeeId, ids),
        gte(timeEntries.shiftDate, window.from), lte(timeEntries.shiftDate, window.to))),
    db.select({ id: timekeepingIssues.id, employeeId: timekeepingIssues.employeeId, branchId: timekeepingIssues.branchId, issueDate: timekeepingIssues.issueDate,
      issueType: timekeepingIssues.issueType, status: timekeepingIssues.status, resolutionNote: timekeepingIssues.resolutionNote, createdAt: timekeepingIssues.createdAt })
      .from(timekeepingIssues).where(and(eq(timekeepingIssues.tenantId, tenantId), inArray(timekeepingIssues.employeeId, ids),
        gte(timekeepingIssues.issueDate, window.from), lte(timekeepingIssues.issueDate, window.to))),
    db.select({ employeeId: scheduleAssignments.employeeId, shiftDate: scheduleAssignments.shiftDate, startTime: scheduleShiftRows.startTime, endTime: scheduleShiftRows.endTime })
      .from(scheduleAssignments)
      .innerJoin(scheduleShiftRows, and(eq(scheduleShiftRows.id, scheduleAssignments.shiftRowId), eq(scheduleShiftRows.tenantId, tenantId)))
      .where(and(eq(scheduleAssignments.tenantId, tenantId), inArray(scheduleAssignments.employeeId, ids),
        gte(scheduleAssignments.shiftDate, window.from), lte(scheduleAssignments.shiftDate, window.to)))
      .orderBy(asc(scheduleAssignments.shiftDate)),
    db.select({ date: publicHolidays.date }).from(publicHolidays).where(and(eq(publicHolidays.tenantId, tenantId), eq(publicHolidays.isActive, true),
      gte(publicHolidays.date, window.from), lte(publicHolidays.date, window.to))),
    db.select({ employeeId: employeeTimeOff.employeeId, startDate: employeeTimeOff.startDate, endDate: employeeTimeOff.endDate })
      .from(employeeTimeOff).where(and(eq(employeeTimeOff.tenantId, tenantId), inArray(employeeTimeOff.employeeId, ids),
        sql`${employeeTimeOff.startDate} <= ${`${window.to}T23:59:59Z`}::timestamp`, sql`${employeeTimeOff.endDate} >= ${`${window.from}T00:00:00Z`}::timestamp`)),
  ]);
  const days = buildAttendanceDays(people, {
    events, entries, issues,
    assignments: assignments.flatMap((a) => a.employeeId ? [{ employeeId: a.employeeId, shiftDate: String(a.shiftDate).slice(0, 10), startTime: String(a.startTime), endTime: String(a.endTime) }] : []),
    holidays: holidays.map((h) => String(h.date).slice(0, 10)),
    timeOff,
  }, window);
  return { days, queries: 6 };
}
