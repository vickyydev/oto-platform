import type { BranchId, PayrollWorld } from "./model";

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type BranchTimeParts = {
  date: string;
  minutes: number;
};

function branchTimeZone(data: PayrollWorld, branchId: BranchId, date: string): string | null {
  const branch = data.branches[branchId];
  if (!branch) return null;
  const details = [...branch.detailsHistory]
    .filter((version) => version.effectiveFrom <= date.slice(0, 7))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .at(-1)?.details;
  if (!details) return null;
  if (details.country === "TH") return "Asia/Bangkok";
  if (details.country === "MY") return "Asia/Kuala_Lumpur";
  return null;
}

function parseIssueInstant(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (calendarDay.getUTCFullYear() !== year || calendarDay.getUTCMonth() + 1 !== month ||
      calendarDay.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function branchLocalParts(instant: number, timeZone: string): BranchTimeParts | null {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
    .map((part) => [part.type, part.value]));
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const second = Number(parts.second ?? 0);
  const millisecond = Number(parts.fractionalSecond ?? 0);
  return {
    date: `${year}-${month}-${day}`,
    minutes: hour * 60 + minute + second / 60 + millisecond / 60_000,
  };
}

function clockMinutes(value: string | null): number | null {
  if (!value) return null;
  const match = CLOCK_TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3] ?? 0) / 60 : null;
}

export function branchBusinessPeriodAt(
  data: PayrollWorld,
  branchId: BranchId,
  value: string,
): { date: string; month: string; instant: number } | null {
  const instant = parseIssueInstant(value);
  const zone = instant === null ? null : branchTimeZone(data, branchId, value);
  const local = instant === null || !zone ? null : branchLocalParts(instant, zone);
  return local && instant !== null
    ? { date: local.date, month: local.date.slice(0, 7), instant }
    : null;
}

/**
 * Returns staff who were rostered for the shift and had clocked in at the
 * voucher issue instant. An open shift is valid; when a clock-out exists it
 * must not be before issue. Attendance clock values are branch-local HH:mm.
 */
export function eligibleBoothStaffAtIssue(
  data: PayrollWorld,
  branchId: BranchId,
  issuedAt: string,
): string[] {
  const issueInstant = parseIssueInstant(issuedAt);
  const timeZone = issueInstant === null ? null : branchTimeZone(data, branchId, issuedAt);
  if (issueInstant === null || !timeZone) return [];
  const issueLocal = branchLocalParts(issueInstant, timeZone);
  if (!issueLocal) return [];

  const branch = data.branches[branchId];
  const rostered = new Set((data.boothRoster ?? [])
    .filter((duty) => duty.branchId === branchId)
    .flatMap((duty) => duty.staffIds.map((staffId) => `${duty.date}:${staffId}`)));
  const eligible = new Set<string>();
  for (const day of data.attendance ?? []) {
    if (day.branchId !== branchId || !rostered.has(`${day.date}:${day.staffId}`)) continue;
    const clockIn = clockMinutes(day.effectiveClockIn ?? day.actualClockIn);
    if (clockIn === null) continue;
    const actualOrCorrectedOut = day.effectiveClockOut ?? day.actualClockOut;
    const clockOut = clockMinutes(actualOrCorrectedOut);
    const localDateStart = new Date(`${issueLocal.date}T00:00:00Z`).getTime();
    const attendanceDateStart = new Date(`${day.date}T00:00:00Z`).getTime();
    const issueDayOffset = Math.round((localDateStart - attendanceDateStart) / DAY_MS);
    if (issueDayOffset < 0 || issueDayOffset > 1) continue;
    const issueMinutes = issueLocal.minutes + issueDayOffset * 1440;
    const shiftEnd = clockOut === null ? null : clockOut + (clockOut < clockIn ? 1440 : 0);
    if (issueMinutes + 1e-8 < clockIn || (shiftEnd !== null && issueMinutes > shiftEnd + 1e-8)) continue;
    if (!branch.staff.some((staff) => staff.id === day.staffId)) continue;
    eligible.add(day.staffId);
  }
  return Array.from(eligible).sort();
}

export function isStrictIsoInstant(value: string): boolean {
  return parseIssueInstant(value) !== null;
}