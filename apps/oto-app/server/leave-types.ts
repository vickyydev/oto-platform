import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import {
  branches,
  employeeLeaveBalanceOpenings,
  employeeLeaveOverrides,
  employeeTimeOff,
  employees,
  leavePolicies,
  leaveTypes,
  scheduleAssignments,
  sickLeavePolicies,
  type InsertLeaveType,
  type LeaveType,
} from "@shared/schema";

/**
 * Flexible leave types (SCRUM-560, the October Replit port R3; upstream
 * `server/leave-types.ts`). Each park group (tenant) keeps its own catalogue of
 * leave types, per-employee overrides of a type's yearly rules, and the
 * opening balances frozen for the people it already had when its catalogue
 * was made; one balance engine works every type out from those.
 *
 * Adapted to our fences: every read and write takes the caller's park group
 * and touches nothing of another's — an employee, a type, an override and an
 * opening are each looked up in that park group, so another park group's is
 * the same answer as one that does not exist. Upstream's start-up seed picked
 * any park group's company-wide policy and read every park group's settings
 * through MAX(); ours is migration 0018's two functions, fenced to one park
 * group, and the lazy start below calls the same functions, so the migration
 * and the app work the numbers ONE way.
 *
 * The lazy start is idempotent and cheap once done: it makes only the
 * built-in types a park group lacks, and freezes openings only for people
 * made before the park group's catalogue who have none — so it is safe to run
 * again after a production restore, and a later hire never gets an opening.
 */

/** The built-in codes, in the order the seed makes them. */
export const BUILTIN_LEAVE_CODES = ["ANNUAL", "BUSINESS", "SICK", "CHANGE_DAY_OFF", "UNPAID", "TRAINING", "OTHER"] as const;

function validDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(`${value}`.slice(0, 10) + "T00:00:00.000Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMonthsClamped(date: Date, months: number): Date {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const targetMonth = result.getUTCMonth() + months;
  result.setUTCMonth(targetMonth);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return result;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWorkday(date: Date, weeklyOffDays: number[]): boolean {
  return !weeklyOffDays.includes(date.getUTCDay());
}

/**
 * A park group's catalogue, made where it is missing, and the openings of the
 * people who predate it. Runs migration 0018's functions; both leave what is
 * already there alone.
 */
export async function ensureTenantLeaveTypes(tenantId: string): Promise<void> {
  const existing = await db.select({ code: leaveTypes.code }).from(leaveTypes).where(eq(leaveTypes.tenantId, tenantId));
  const codes = new Set(existing.map((row) => row.code.toUpperCase()));
  if (!BUILTIN_LEAVE_CODES.every((code) => codes.has(code))) {
    await db.execute(sql`select seed_tenant_leave_types(${tenantId}::uuid)`);
  }
  // Only when someone made before the catalogue still lacks an opening.
  const [pending] = await db.select({ employeeId: employees.id })
    .from(employees)
    .innerJoin(leaveTypes, and(
      eq(leaveTypes.tenantId, employees.tenantId),
      sql`upper(${leaveTypes.code}) IN ('ANNUAL', 'BUSINESS', 'SICK', 'CHANGE_DAY_OFF')`,
    ))
    .leftJoin(employeeLeaveBalanceOpenings, and(
      eq(employeeLeaveBalanceOpenings.employeeId, employees.id),
      eq(employeeLeaveBalanceOpenings.leaveTypeId, leaveTypes.id),
    ))
    .where(and(
      eq(employees.tenantId, tenantId),
      sql`${employeeLeaveBalanceOpenings.id} IS NULL`,
      sql`${employees.createdAt} < (
        SELECT MIN(builtin.created_at) FROM leave_types builtin
         WHERE builtin.tenant_id = ${tenantId}::uuid
           AND upper(builtin.code) IN ('ANNUAL', 'BUSINESS', 'SICK', 'CHANGE_DAY_OFF', 'UNPAID', 'TRAINING', 'OTHER')
      )`,
    ))
    .limit(1);
  if (pending) {
    await db.execute(sql`select snapshot_leave_balance_openings(${tenantId}::uuid)`);
  }
}

export async function listTenantLeaveTypes(tenantId: string): Promise<LeaveType[]> {
  await ensureTenantLeaveTypes(tenantId);
  return db.select().from(leaveTypes).where(eq(leaveTypes.tenantId, tenantId)).orderBy(asc(leaveTypes.name));
}

/** The park group's type of this id, or nothing: another park group's is the same as none. */
export async function getTenantLeaveType(tenantId: string, id: string): Promise<LeaveType | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  await ensureTenantLeaveTypes(tenantId);
  const [type] = await db.select().from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.tenantId, tenantId))).limit(1);
  return type;
}

export async function getTenantLeaveTypeByCode(tenantId: string, code: string): Promise<LeaveType | undefined> {
  await ensureTenantLeaveTypes(tenantId);
  const [type] = await db.select().from(leaveTypes)
    .where(and(eq(leaveTypes.tenantId, tenantId), sql`upper(${leaveTypes.code}) = upper(${code})`)).limit(1);
  return type;
}

export async function createTenantLeaveType(tenantId: string, input: Omit<InsertLeaveType, "tenantId">): Promise<LeaveType> {
  await ensureTenantLeaveTypes(tenantId);
  const [type] = await db.insert(leaveTypes).values({ ...input, tenantId }).returning();
  return type;
}

type LeaveTypeChanges = Partial<Pick<InsertLeaveType,
  "name" | "isActive" | "accrualMethod" | "annualDays" | "waitingMonths" | "prorateByStartDate" | "daysWorkedRequired" | "daysOffEarned">>;

export async function updateTenantLeaveType(tenantId: string, id: string, input: LeaveTypeChanges): Promise<LeaveType | undefined> {
  await ensureTenantLeaveTypes(tenantId);
  // Only the type's own fields: a code never changes (time-off rows store it).
  const changes: LeaveTypeChanges = {};
  for (const key of ["name", "isActive", "accrualMethod", "annualDays", "waitingMonths", "prorateByStartDate", "daysWorkedRequired", "daysOffEarned"] as const) {
    if (input[key] !== undefined) (changes as Record<string, unknown>)[key] = input[key];
  }
  const [type] = await db.update(leaveTypes).set({ ...changes, updatedAt: new Date() })
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.tenantId, tenantId))).returning();
  return type;
}

export async function listEmployeeLeaveOverrides(tenantId: string, employeeId: string) {
  return db.select({
    leaveTypeId: employeeLeaveOverrides.leaveTypeId,
    annualDays: employeeLeaveOverrides.annualDays,
    accrualStartDate: employeeLeaveOverrides.accrualStartDate,
    waitingMonths: employeeLeaveOverrides.waitingMonths,
  }).from(employeeLeaveOverrides)
    .where(and(eq(employeeLeaveOverrides.tenantId, tenantId), eq(employeeLeaveOverrides.employeeId, employeeId)));
}

/**
 * Save an employee's override of a type. Both the employee and the type must
 * be the park group's own (upstream checked neither here); otherwise nothing
 * is written and the answer is `undefined`, which a route gives as a 404.
 */
export async function upsertEmployeeLeaveOverride(
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  values: { annualDays?: number | null; accrualStartDate?: string | null; waitingMonths?: number | null },
) {
  const [employee] = await db.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.id, employeeId), eq(employees.tenantId, tenantId))).limit(1);
  const type = await getTenantLeaveType(tenantId, leaveTypeId);
  if (!employee || !type) return undefined;
  const [existing] = await db.select().from(employeeLeaveOverrides).where(and(
    eq(employeeLeaveOverrides.tenantId, tenantId),
    eq(employeeLeaveOverrides.employeeId, employeeId),
    eq(employeeLeaveOverrides.leaveTypeId, leaveTypeId),
  )).limit(1);
  const annualDays = values.annualDays === undefined ? existing?.annualDays ?? null : values.annualDays;
  const accrualStartDate = values.accrualStartDate === undefined ? existing?.accrualStartDate ?? null : values.accrualStartDate;
  const waitingMonths = values.waitingMonths === undefined ? existing?.waitingMonths ?? null : values.waitingMonths;
  const [record] = await db.insert(employeeLeaveOverrides).values({
    tenantId, employeeId, leaveTypeId,
    annualDays,
    accrualStartDate,
    waitingMonths,
  }).onConflictDoUpdate({
    target: [employeeLeaveOverrides.employeeId, employeeLeaveOverrides.leaveTypeId],
    set: {
      annualDays,
      accrualStartDate,
      waitingMonths,
      updatedAt: new Date(),
    },
    // The unique key is (employee, type), both already the park group's.
    setWhere: eq(employeeLeaveOverrides.tenantId, tenantId),
  }).returning({
    leaveTypeId: employeeLeaveOverrides.leaveTypeId,
    annualDays: employeeLeaveOverrides.annualDays,
    accrualStartDate: employeeLeaveOverrides.accrualStartDate,
    waitingMonths: employeeLeaveOverrides.waitingMonths,
  });
  return record;
}

export async function deleteEmployeeLeaveOverride(tenantId: string, employeeId: string, leaveTypeId: string): Promise<void> {
  await db.delete(employeeLeaveOverrides).where(and(
    eq(employeeLeaveOverrides.tenantId, tenantId),
    eq(employeeLeaveOverrides.employeeId, employeeId),
    eq(employeeLeaveOverrides.leaveTypeId, leaveTypeId),
  ));
}

export type DynamicLeaveBalance = {
  leaveTypeId: string;
  code: string;
  name: string;
  earned: number;
  used: number;
  balance: number;
  canClaim: boolean;
  isActive: boolean;
};

/**
 * Every type's balance for one of the park group's employees in a calendar
 * year (upstream's engine, as it is): a YEARLY type accrues its days by
 * completed months from the later of the waiting period's end and 1 January
 * (a fraction of the running month too when prorated); a WORKDAYS type earns
 * its days off per days worked from the waiting period's end; usage counts
 * the workdays (the employee's weekly days off excluded) of the type's
 * time-off. A person with an opening carries it and adds only what accrues
 * and is taken after it. `null` for an employee not in the park group.
 */
export async function employeeDynamicLeaveBalances(
  employeeId: string,
  tenantId: string,
  year: number,
): Promise<{ year: number; balances: DynamicLeaveBalance[] } | null> {
  const [employee] = await db.select().from(employees)
    .where(and(eq(employees.id, employeeId), eq(employees.tenantId, tenantId))).limit(1);
  if (!employee) return null;

  const types = await listTenantLeaveTypes(tenantId);
  const overrides = await listEmployeeLeaveOverrides(tenantId, employeeId);
  const overrideByType = new Map(overrides.map((item) => [item.leaveTypeId, item]));
  const [branchDayOffPolicy] = employee.branchId
    ? await db.select({
      daysWorkedRequired: leavePolicies.daysWorkedRequired,
      daysOffEarned: leavePolicies.daysOffEarned,
    }).from(leavePolicies)
      .innerJoin(branches, eq(leavePolicies.branchId, branches.id))
      .where(and(
        eq(branches.id, employee.branchId),
        eq(branches.tenantId, tenantId),
        eq(leavePolicies.tenantId, tenantId),
        eq(leavePolicies.isActive, true),
      ))
      .orderBy(desc(leavePolicies.effectiveFrom), desc(leavePolicies.createdAt)).limit(1)
    : [];
  const branchSickPolicy = employee.branchId
    ? (await db.select({
      annualSickLeaveDays: sickLeavePolicies.annualSickLeaveDays,
      proRateByStartDate: sickLeavePolicies.proRateByStartDate,
    }).from(sickLeavePolicies)
      .innerJoin(branches, eq(sickLeavePolicies.branchId, branches.id))
      .where(and(
        eq(sickLeavePolicies.tenantId, tenantId),
        eq(sickLeavePolicies.branchId, employee.branchId),
        eq(branches.tenantId, tenantId),
        eq(sickLeavePolicies.isActive, true),
      ))
      .orderBy(desc(sickLeavePolicies.updatedAt), desc(sickLeavePolicies.createdAt)).limit(1))[0]
    : undefined;
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const today = new Date();
  const balanceEnd = year < today.getUTCFullYear()
    ? new Date(Date.UTC(year, 11, 31))
    : year > today.getUTCFullYear()
      ? new Date(Date.UTC(year, 0, 1))
      : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const timeOffRows = await db.select().from(employeeTimeOff)
    .where(and(eq(employeeTimeOff.employeeId, employeeId), eq(employeeTimeOff.tenantId, tenantId)));
  const assignments = await db.select({
    shiftDate: scheduleAssignments.shiftDate,
    assignedAt: scheduleAssignments.assignedAt,
  }).from(scheduleAssignments)
    .where(and(eq(scheduleAssignments.employeeId, employeeId), eq(scheduleAssignments.tenantId, tenantId)));
  const openings = await db.select().from(employeeLeaveBalanceOpenings)
    .where(and(
      eq(employeeLeaveBalanceOpenings.tenantId, tenantId),
      eq(employeeLeaveBalanceOpenings.employeeId, employeeId),
    ));
  const openingByType = new Map(openings.map((opening) => [opening.leaveTypeId, opening]));
  const startDate = validDate(employee.startDate);

  const balances = types.map((type): DynamicLeaveBalance => {
    const override = overrideByType.get(type.id);
    const annualDays = override?.annualDays
      ?? (type.code.toUpperCase() === "SICK" ? branchSickPolicy?.annualSickLeaveDays ?? type.annualDays : type.annualDays);
    const prorateByStartDate = type.code.toUpperCase() === "SICK"
      ? branchSickPolicy?.proRateByStartDate ?? type.prorateByStartDate
      : type.prorateByStartDate;
    const daysWorkedRequired = type.code.toUpperCase() === "CHANGE_DAY_OFF"
      ? branchDayOffPolicy?.daysWorkedRequired ?? type.daysWorkedRequired
      : type.daysWorkedRequired;
    const daysOffEarned = type.code.toUpperCase() === "CHANGE_DAY_OFF"
      ? branchDayOffPolicy?.daysOffEarned ?? type.daysOffEarned
      : type.daysOffEarned;
    const waitingMonths = override?.waitingMonths ?? type.waitingMonths;
    const accrualStart = validDate(override?.accrualStartDate) ?? startDate;
    const eligibilityDate = accrualStart ? addMonthsClamped(accrualStart, waitingMonths) : null;
    const canClaim = type.accrualMethod === "NONE" || (!!eligibilityDate && eligibilityDate <= today);
    const opening = openingByType.get(type.id);
    const snapshotDate = opening ? validDate(opening.snapshotAt) : null;
    const snapshotYear = snapshotDate?.getUTCFullYear();
    const useOpening = !!opening && !!snapshotDate && (
      type.accrualMethod === "WORKDAYS" ? year >= (snapshotYear ?? year) : year === snapshotYear
    );
    const earnedThrough = (cutoff: Date): number => {
      if (type.accrualMethod === "YEARLY" && accrualStart && eligibilityDate && cutoff >= startOfYear && eligibilityDate <= cutoff) {
        const earningStart = eligibilityDate > startOfYear ? eligibilityDate : startOfYear;
        let completedMonths = 0;
        let cursor = earningStart;
        while (addMonthsClamped(cursor, 1) <= cutoff && completedMonths < 12) {
          cursor = addMonthsClamped(cursor, 1);
          completedMonths += 1;
        }
        let earnedMonths = completedMonths;
        if (prorateByStartDate && completedMonths < 12 && cursor < cutoff) {
          const nextAccrualDate = addMonthsClamped(cursor, 1);
          const elapsedDays = Math.max(0, (cutoff.getTime() - cursor.getTime()) / 86400000);
          const periodDays = Math.max(1, (nextAccrualDate.getTime() - cursor.getTime()) / 86400000);
          earnedMonths += Math.min(1, elapsedDays / periodDays);
        }
        return Math.floor((annualDays * earnedMonths / 12) * 100) / 100;
      }
      if (type.accrualMethod === "WORKDAYS" && daysWorkedRequired > 0 && daysOffEarned > 0) {
        if (!eligibilityDate) return 0;
        const worked = new Set(assignments
          .filter((item) => `${item.shiftDate}`.slice(0, 10) <= dateKey(cutoff)
            && `${item.shiftDate}`.slice(0, 10) >= dateKey(eligibilityDate)
            && (!useOpening || !snapshotDate || item.assignedAt <= opening!.snapshotAt))
          .map((item) => `${item.shiftDate}`.slice(0, 10))).size;
        const newWorked = useOpening && snapshotDate
          ? new Set(assignments
            .filter((item) => `${item.shiftDate}`.slice(0, 10) <= dateKey(cutoff)
              && `${item.shiftDate}`.slice(0, 10) >= dateKey(eligibilityDate)
              && item.assignedAt > opening!.snapshotAt)
            .map((item) => `${item.shiftDate}`.slice(0, 10))).size
          : 0;
        const baselineWorked = useOpening && snapshotDate
          ? new Set(assignments
            .filter((item) => item.assignedAt <= opening!.snapshotAt
              && `${item.shiftDate}`.slice(0, 10) >= dateKey(eligibilityDate))
            .map((item) => `${item.shiftDate}`.slice(0, 10))).size
          : 0;
        const cumulativeWorked = useOpening ? baselineWorked + newWorked : worked;
        const totalEarned = Math.floor(cumulativeWorked / daysWorkedRequired) * daysOffEarned;
        const priorEarned = useOpening ? Math.floor(baselineWorked / daysWorkedRequired) * daysOffEarned : 0;
        return totalEarned - priorEarned;
      }
      return 0;
    };

    const calculateUsed = (cutoff: Date): number => {
      let used = 0;
      for (const row of timeOffRows) {
        if (row.type.toUpperCase() !== type.code.toUpperCase()) continue;
        if (useOpening && opening && row.createdAt <= opening.snapshotAt) continue;
        const begin = validDate(row.startDate);
        const finish = validDate(row.endDate);
        if (!begin || !finish) continue;
        const workdayType = type.accrualMethod === "WORKDAYS";
        const rangeStart = workdayType
          ? (eligibilityDate && begin < eligibilityDate ? eligibilityDate : begin)
          : (begin > startOfYear ? begin : startOfYear);
        const rangeEnd = finish < cutoff ? finish : cutoff;
        if (rangeStart > rangeEnd) continue;
        let days = 0;
        const weeklyOffDays = employee.weeklyOffDays ?? [];
        for (const day = new Date(rangeStart); day <= rangeEnd; day.setUTCDate(day.getUTCDate() + 1)) {
          if (isWorkday(day, weeklyOffDays)) days += 1;
        }
        used += row.isHalfDay ? 0.5 : days;
      }
      return used;
    };

    let earned = earnedThrough(balanceEnd);
    const used = calculateUsed(balanceEnd);
    if (useOpening && opening && snapshotDate && snapshotDate < balanceEnd) {
      if (type.code.toUpperCase() === "SICK" && year === snapshotYear) {
        // The legacy sick opening already contains the year's entitlement
        // net of prior usage; don't accrue that same entitlement again.
        earned = opening.openingBalance;
      } else {
        const accruedAtSnapshot = earnedThrough(snapshotDate);
        earned = opening.openingBalance + Math.max(0, earned - accruedAtSnapshot);
      }
    } else if (useOpening && opening && snapshotDate && snapshotDate >= balanceEnd) {
      earned = opening.openingBalance;
    }
    // With an opening, the snapshot already holds all prior usage (future
    // requests entered before cutover included): only newer requests count.
    return {
      leaveTypeId: type.id,
      code: type.code,
      name: type.name,
      earned,
      used,
      balance: earned - used,
      canClaim,
      isActive: type.isActive,
    };
  });
  return { year, balances };
}
