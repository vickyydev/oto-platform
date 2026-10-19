/**
 * Payroll's own feeds (SCRUM-568, the company payroll's R3; plan §3): OT-bank
 * bookings, the payroll half of leave (frozen valuations) and offboarding
 * dates.
 *
 * Leave. SCRUM-560's engine stays the only balance engine; payroll adds only
 * the money side. An unpaid-leave time off (the UNPAID type) is valued by a
 * payroll role: its workdays (the employee's weekly days off excluded, a half
 * day as 0.5 — SCRUM-560's own counting) at a daily rate FROZEN when it is
 * valued: the profile's day rate for a day-rate worker, else the monthly
 * salary (a contractor's fee) ÷ 30 — the prototype's rule (context.tsx:3170,
 * leave-engine.ts:377), applied to the profile. An exit payout is days × the
 * same frozen rate, taxable and not an SSO wage (rulebook §6). A valuation is
 * reversed with a reason, never deleted; negative balances never deduct.
 *
 * OT bank. Bookings are stored and checked by the prototype's own rule
 * (calculateOtBankBalance on the world). Owner ruling 2026-10-20 (plan, open
 * decision 3): company runs do NOT credit the bank — the connection is a
 * matter for the park — so every balance is 0 and a booking is refused with
 * the prototype's words; the screen says plainly why.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  employeeTimeOff,
  employees,
  payrollLeaveValuations,
  payrollOffboarding,
  payrollOtBankBookings,
  payrollProfiles,
} from "@shared/schema";
import type { FeedsView, LeaveValuationView, OffboardingView, OtBookingView, UnvaluedLeaveView } from "@shared/payroll-month";
import { db } from "../db";
import { listTenantLeaveTypes } from "../leave-types";
import { PayrollRefusal, isIsoDate, recordChange, requireReason, type PayrollActor } from "./setup";
import { engineRefusal, payrollPeople, requireMonth } from "./inputs";
import { profileOut } from "./profiles";
import { loadPayrollWorld } from "./world";
import { calculateOtBankBalance, overtimePolicyForRole } from "./engine/ot-bank";
import { effectiveRulesForMonth } from "./engine/calculations";
import { monthDays } from "./engine/company-math";
import type { EmployeePayrollProfile } from "./engine/payroll-profile";

const iso = (v: Date | string | null | undefined) => v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const num = (v: string | number | null | undefined) => v == null ? 0 : Number(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The prototype's frozen daily rate (context.tsx:3170: `staff.dayRate ?? monthlySalary / 30`), from the profile. */
export function frozenDailyRate(p: Pick<EmployeePayrollProfile, "workerType" | "dayRate" | "monthlySalary" | "fixedFee">): number {
  if (p.workerType === "day-rate") return p.dayRate;
  return (p.workerType === "contractor" ? p.fixedFee : p.monthlySalary) / 30;
}

/** SCRUM-560's counting: the workdays of a time off (weekly days off excluded), a half day as 0.5. */
export function leaveWorkdays(start: string, end: string, weeklyOffDays: number[], halfDay: boolean): { dates: string[]; days: number } {
  const dates: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400000) {
    const d = new Date(t);
    if (!weeklyOffDays.includes(d.getUTCDay())) dates.push(d.toISOString().slice(0, 10));
  }
  if (halfDay) return { dates: dates.slice(0, 1), days: dates.length ? 0.5 : 0 };
  return { dates, days: dates.length };
}

async function profileFor(tenantId: string, employeeId: string) {
  const [row] = await db.select({ profile: payrollProfiles, employee: employees }).from(payrollProfiles)
    .innerJoin(employees, and(eq(employees.id, payrollProfiles.employeeId), eq(employees.tenantId, tenantId)))
    .where(and(eq(payrollProfiles.tenantId, tenantId), eq(payrollProfiles.employeeId, employeeId))).limit(1);
  if (!row) throw new PayrollRefusal(404, "Payroll profile not found");
  return { profile: profileOut(row.profile, [], [], []), employee: row.employee };
}

export async function loadFeedsView(tenantId: string, monthValue: string): Promise<Omit<FeedsView, "canManage">> {
  const month = requireMonth(monthValue);
  const start = `${month}-01`, end = `${month}-${String(monthDays(month)).padStart(2, "0")}`;
  const [people, bookings, valuations, offboarding, timeOff, types, loaded] = await Promise.all([
    payrollPeople(tenantId, end),
    db.select().from(payrollOtBankBookings).where(eq(payrollOtBankBookings.tenantId, tenantId)).orderBy(asc(payrollOtBankBookings.date)),
    db.select({ v: payrollLeaveValuations, timeOffId: employeeTimeOff.id }).from(payrollLeaveValuations)
      .leftJoin(employeeTimeOff, and(eq(employeeTimeOff.id, payrollLeaveValuations.employeeTimeOffId), eq(employeeTimeOff.tenantId, tenantId)))
      .where(eq(payrollLeaveValuations.tenantId, tenantId)).orderBy(asc(payrollLeaveValuations.startsOn)),
    db.select().from(payrollOffboarding).where(eq(payrollOffboarding.tenantId, tenantId)).orderBy(asc(payrollOffboarding.lastWorkingDate)),
    db.select().from(employeeTimeOff).where(and(eq(employeeTimeOff.tenantId, tenantId),
      sql`upper(${employeeTimeOff.type}) = 'UNPAID'`, sql`${employeeTimeOff.startDate} <= ${`${end}T23:59:59Z`}::timestamp`, sql`${employeeTimeOff.endDate} >= ${`${start}T00:00:00Z`}::timestamp`)),
    listTenantLeaveTypes(tenantId),
    loadPayrollWorld(tenantId, month).catch(() => null),
  ]);
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const inPayroll = new Set(people.map((p) => p.id));
  const valued = new Set(valuations.filter((x) => !x.v.reversedAt && x.v.employeeTimeOffId).map((x) => x.v.employeeTimeOffId));
  const otBank = loaded ? Object.values(loaded.world.branches).flatMap((b) => b.staff.map((s) => {
    const balance = calculateOtBankBalance(loaded.world, b.id, s.id, end);
    return { employeeId: s.id, name: s.name, availableHours: balance.availableHours, earnedHours: balance.earnedHours, usedHours: balance.usedHours };
  })) : [];
  return {
    month, people,
    bookings: bookings.map((b): OtBookingView => ({
      id: b.id, employeeId: b.employeeId, name: nameOf.get(b.employeeId) ?? b.employeeId, date: iso(b.date), hours: num(b.hours), reason: b.reason, who: b.actorName, at: b.createdAt.toISOString(),
    })),
    valuations: valuations.map(({ v, timeOffId }): LeaveValuationView => ({
      id: v.id, employeeId: v.employeeId, name: nameOf.get(v.employeeId) ?? v.employeeId, kind: v.kind, source: v.source, leaveTypeCode: v.leaveTypeCode,
      startsOn: iso(v.startsOn), endsOn: iso(v.endsOn), days: num(v.days), dailyRate: num(v.dailyRate), amount: Math.round(num(v.days) * num(v.dailyRate) * 100) / 100,
      taxable: v.taxable, socialSecurity: v.socialSecurity, reason: v.reason, who: v.decidedByName, at: v.createdAt.toISOString(),
      reversedAt: v.reversedAt ? v.reversedAt.toISOString() : null, reversalReason: v.reversalReason, sourceMissing: v.source === "time-off" && !timeOffId,
    })),
    unvalued: timeOff.filter((t) => inPayroll.has(t.employeeId) && !valued.has(t.id)).map((t): UnvaluedLeaveView => ({
      timeOffId: t.id, employeeId: t.employeeId, name: nameOf.get(t.employeeId) ?? t.employeeId, type: t.type,
      startsOn: iso(t.startDate), endsOn: iso(t.endDate), halfDay: t.isHalfDay,
    })),
    offboarding: offboarding.map((o): OffboardingView => ({
      employeeId: o.employeeId, name: nameOf.get(o.employeeId) ?? o.employeeId, resignationDate: iso(o.resignationDate), lastWorkingDate: iso(o.lastWorkingDate),
      reason: o.reason, who: o.actorName, at: o.updatedAt.toISOString(),
    })),
    otBank, otBankCreditsFromRuns: false,
    leaveTypes: types.filter((t) => t.isActive).map((t) => ({ code: t.code.toUpperCase(), name: t.name, paid: t.code.toUpperCase() !== "UNPAID" })),
  };
}

/** The prototype's `bookOtTimeOff` checks (context.tsx:2408-2445), against the stored world. */
export async function bookOtTimeOff(tenantId: string, actor: PayrollActor, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  if (!isIsoDate(body.date)) throw new PayrollRefusal(400, "OT bank time-off date must use a valid YYYY-MM-DD date.");
  if (!finite(body.hours) || body.hours <= 0) throw new PayrollRefusal(400, "OT bank time-off hours must be finite and greater than zero.");
  const employeeId = String(body.employeeId ?? ""), date = body.date as string, hours = Math.round(body.hours * 10000) / 10000;
  await profileFor(tenantId, employeeId);
  const loaded = await loadPayrollWorld(tenantId, date.slice(0, 7)).catch(engineRefusal);
  const branch = Object.values(loaded.world.branches).find((b) => b.staff.some((s) => s.id === employeeId));
  const staff = branch?.staff.find((s) => s.id === employeeId);
  if (!branch || !staff) throw new PayrollRefusal(400, `Unknown OT bank employee ${employeeId} in this month's payroll.`);
  const rules = effectiveRulesForMonth(branch, date.slice(0, 7));
  const policy = overtimePolicyForRole(rules.overtimePolicy, staff.role);
  if (policy.bankUseUnit === "half-days" && Math.abs(hours / 4 - Math.round(hours / 4)) > 0.0001) {
    throw new PayrollRefusal(400, "This OT bank uses half-day booking units; time off must be booked in four-hour increments.");
  }
  const before = calculateOtBankBalance(loaded.world, branch.id, employeeId, date);
  if (hours > before.availableHours + 0.0001) {
    throw new PayrollRefusal(409, `OT bank booking exceeds available time: ${before.availableHours.toFixed(2)}h available, ${hours.toFixed(2)}h requested.`);
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(payrollOtBankBookings).values({ tenantId, employeeId, branchId: branch.id, date, hours: String(hours), reason, createdBy: actor.userId, actorName: actor.name }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "ot-bank-booking", subjectId: row.id, reason, oldValue: null, newValue: { employeeId, date, hours } });
    return { id: row.id, beforeHours: before.availableHours, afterHours: before.availableHours - hours };
  });
}

/**
 * Values one unpaid time off, or records an exit payout:
 *   { kind: "unpaid", timeOffId, reason }
 *   { kind: "payout", employeeId, leaveTypeCode, date, days, reason }
 */
export async function recordLeaveValuation(tenantId: string, actor: PayrollActor, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  if (body.kind === "unpaid") {
    const timeOffId = String(body.timeOffId ?? "");
    const [timeOff] = await db.select().from(employeeTimeOff).where(and(eq(employeeTimeOff.tenantId, tenantId), eq(employeeTimeOff.id, timeOffId))).limit(1);
    if (!timeOff) throw new PayrollRefusal(404, "Time off not found");
    if (timeOff.type.toUpperCase() !== "UNPAID") throw new PayrollRefusal(400, "Only unpaid leave is valued by payroll; paid leave is paid as normal salary.");
    const { profile: p, employee } = await profileFor(tenantId, timeOff.employeeId);
    const { dates, days } = leaveWorkdays(iso(timeOff.startDate), iso(timeOff.endDate), employee.weeklyOffDays ?? [], timeOff.isHalfDay);
    if (!days) throw new PayrollRefusal(400, "This time off has no workdays to value.");
    const rate = frozenDailyRate(p);
    return db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: payrollLeaveValuations.id }).from(payrollLeaveValuations).where(and(eq(payrollLeaveValuations.tenantId, tenantId),
        eq(payrollLeaveValuations.employeeTimeOffId, timeOff.id), sql`${payrollLeaveValuations.reversedAt} IS NULL`)).limit(1);
      if (existing) throw new PayrollRefusal(409, "This time off is already valued. Reverse it first to value it again.");
      const [row] = await tx.insert(payrollLeaveValuations).values({
        tenantId, employeeId: timeOff.employeeId, kind: "unpaid", source: "time-off", employeeTimeOffId: timeOff.id, leaveTypeCode: "UNPAID",
        startsOn: iso(timeOff.startDate), endsOn: iso(timeOff.endDate), dates, days: String(days), dailyRate: String(rate),
        taxable: true, socialSecurity: true, reason, decidedBy: actor.userId, decidedByName: actor.name,
      }).returning();
      await recordChange(tx, tenantId, actor, { kind: "setup", subject: "leave-valuation", subjectId: row.id, reason, oldValue: null, newValue: { kind: "unpaid", timeOffId, days, rate } });
      return { id: row.id, days, dailyRate: rate, amount: Math.round(days * rate * 100) / 100 };
    });
  }
  if (body.kind === "payout") {
    const employeeId = String(body.employeeId ?? "");
    const code = typeof body.leaveTypeCode === "string" ? body.leaveTypeCode.toUpperCase() : "";
    if (!isIsoDate(body.date)) throw new PayrollRefusal(400, "Choose the payout date.");
    if (!finite(body.days) || body.days <= 0) throw new PayrollRefusal(400, "Enter the days paid out (more than zero).");
    const types = await listTenantLeaveTypes(tenantId);
    const type = types.find((t) => t.code.toUpperCase() === code);
    if (!type || code === "UNPAID") throw new PayrollRefusal(400, "Choose a paid leave type.");
    const { profile: p } = await profileFor(tenantId, employeeId);
    const rate = frozenDailyRate(p), date = body.date as string, days = body.days;
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(payrollLeaveValuations).values({
        tenantId, employeeId, kind: "payout", source: "exit", leaveTypeCode: code, startsOn: date, endsOn: date, dates: [date],
        days: String(days), dailyRate: String(rate), taxable: true, socialSecurity: false, reason, decidedBy: actor.userId, decidedByName: actor.name,
      }).returning();
      await recordChange(tx, tenantId, actor, { kind: "setup", subject: "leave-valuation", subjectId: row.id, reason, oldValue: null, newValue: { kind: "payout", employeeId, code, date, days, rate } });
      return { id: row.id, days, dailyRate: rate, amount: Math.round(days * rate * 100) / 100 };
    });
  }
  throw new PayrollRefusal(400, "Choose unpaid leave or an exit payout.");
}

export async function reverseLeaveValuation(tenantId: string, actor: PayrollActor, id: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(payrollLeaveValuations)
      .where(and(eq(payrollLeaveValuations.tenantId, tenantId), sql`${payrollLeaveValuations.id}::text = ${id}`)).limit(1).for("update");
    if (!row) throw new PayrollRefusal(404, "Leave valuation not found");
    if (row.reversedAt) throw new PayrollRefusal(409, "This valuation is already reversed.");
    await tx.update(payrollLeaveValuations).set({ reversedAt: new Date(), reversedBy: actor.userId, reversalReason: reason })
      .where(and(eq(payrollLeaveValuations.tenantId, tenantId), eq(payrollLeaveValuations.id, row.id)));
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "leave-valuation", subjectId: row.id, reason, oldValue: { reversed: false }, newValue: { reversed: true } });
    return { id: row.id, reversed: true };
  });
}

export async function saveOffboarding(tenantId: string, actor: PayrollActor, employeeId: string, body: Record<string, unknown>) {
  const reason = requireReason(body.reason);
  if (!isIsoDate(body.resignationDate) || !isIsoDate(body.lastWorkingDate)) throw new PayrollRefusal(400, "Enter the resignation and last working dates.");
  if ((body.lastWorkingDate as string) < (body.resignationDate as string)) throw new PayrollRefusal(400, "The last working date cannot be before the resignation date.");
  await profileFor(tenantId, employeeId);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(payrollOffboarding).where(and(eq(payrollOffboarding.tenantId, tenantId), eq(payrollOffboarding.employeeId, employeeId))).limit(1).for("update");
    const values = { resignationDate: body.resignationDate as string, lastWorkingDate: body.lastWorkingDate as string, reason, recordedBy: actor.userId, actorName: actor.name };
    const [row] = before
      ? await tx.update(payrollOffboarding).set({ ...values, updatedAt: new Date() }).where(and(eq(payrollOffboarding.tenantId, tenantId), eq(payrollOffboarding.id, before.id))).returning()
      : await tx.insert(payrollOffboarding).values({ tenantId, employeeId, ...values }).returning();
    await recordChange(tx, tenantId, actor, { kind: "setup", subject: "offboarding", subjectId: employeeId, reason,
      oldValue: before ? { resignationDate: iso(before.resignationDate), lastWorkingDate: iso(before.lastWorkingDate) } : null,
      newValue: { resignationDate: iso(row.resignationDate), lastWorkingDate: iso(row.lastWorkingDate) } });
    return { employeeId, resignationDate: iso(row.resignationDate), lastWorkingDate: iso(row.lastWorkingDate) };
  });
}
