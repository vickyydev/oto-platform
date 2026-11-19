import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  employeeEngagements,
  employees,
  payrollProfiles,
  scheduleAssignments,
  scheduleShiftRows,
  singleShiftInvitations,
  users,
  type Employee,
  type SingleShiftInvitation,
} from "@shared/schema";
import {
  SINGLE_SHIFT_REFUSALS,
  singleShiftPayLabel,
  validCasualDayRate,
  bahtText,
  type SingleShiftPayWay,
} from "@shared/singleShift";
import { db } from "../db";
import { storage, type DbExecutor } from "../storage";
import { frozenDailyRate } from "../payroll/feeds";
import type { WorkerType } from "../payroll/engine/payroll-profile";
import { employmentEndedOn } from "./employmentEnded";
import { bangkokToday } from "./engagementDates";
import { getEmployeeDisplayName } from "./employeeDisplayName";

/**
 * A former employee invited to one shift (SCRUM-1038).
 *
 * The owner's answer (19 November 2026): a former employee invited to a single
 * shift is paid "on the old contract", "with an option to switch and work on
 * casual day rate as well". Rehiring is a different thing and stays Onboard
 * Again's (SCRUM-794); this changes nothing about the profile or its login.
 *
 *  - Who. The people who schedule staff today (`requireManager`, with access to
 *    the shift's branch) put a FORMER employee of that branch on one shift row
 *    on one day: a profile whose employment has ended by today, by the kiosk's
 *    own measure (`employmentEndedOn`), with no Onboard Again employment
 *    planned. A current employee is refused in words: they are scheduled as
 *    usual. One single shift per person per day; each invitation is one shift.
 *  - The shift is an ordinary schedule assignment, made with every check the
 *    schedule makes for anybody (department, role, leave, overlapping shifts),
 *    except the two that refuse an ended employment. This row beside it is the
 *    invitation: the day, the branch, and how the shift is paid.
 *  - How it is paid. By default on the old contract; the manager may switch the
 *    shift to a casual day rate and type it (whole baht a day, as a casual
 *    worker's rate is entered), and switch back. Each choice is written to the
 *    activity log with who and when (`single_shift_invited`,
 *    `single_shift_pay_changed`). A shift on a past day keeps its pay as it is.
 *  - What the shift is worth, `singleShiftPay`: on a casual day rate, the rate;
 *    on the old contract, one day of that contract as payroll already values a
 *    day of it (`frozenDailyRate`: the day rate of a day-rate profile, a monthly
 *    salary or fee ÷ 30), from the person's payroll profile. Shown to the
 *    payroll roles only (`canViewHrSalary`); a manager sees the way, not the
 *    salary. Company payroll does not take the shift yet: a profile whose last
 *    working day is before a month is not in that month at all (payroll/world.ts).
 *  - The kiosk (`singleShiftOpenOn`): the person clocks in and out at the
 *    shift's branch on its day, as anybody rostered does, and from the next day
 *    the kiosk refuses them again by itself. The login stays in pay only.
 */

export type { SingleShiftPayWay };

/** The pay terms of a contract this needs, as the payroll profile holds them. */
export interface OldContractTerms {
  workerType: WorkerType;
  dayRate: number;
  monthlySalary: number;
  fixedFee: number;
}

export interface SingleShiftPay {
  way: SingleShiftPayWay;
  /** Baht for the shift; null when the old contract's terms are not on file. */
  amount: number | null;
  /** How the amount is made, in words. */
  formula: string;
}

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * What one single shift is worth, both ways. Pure.
 *
 *  - casual day rate: the rate, for the one shift;
 *  - old contract: one day of the contract as payroll values a day of it
 *    (`frozenDailyRate`, the prototype's rule): a day-rate profile's day rate,
 *    a monthly salary ÷ 30, a contractor's fee ÷ 30.
 */
export function singleShiftPay(way: SingleShiftPayWay, casualDayRate: number | null, oldContract: OldContractTerms | null): SingleShiftPay {
  if (way === "casual_day_rate") {
    if (!validCasualDayRate(casualDayRate)) throw new Error("A casual day rate must be whole baht, more than zero.");
    return { way, amount: casualDayRate, formula: `Casual day rate ${bahtText(casualDayRate)} × 1 shift` };
  }
  if (!oldContract) {
    return { way, amount: null, formula: "No payroll profile: the old contract's pay terms are not on file" };
  }
  const amount = money(frozenDailyRate(oldContract));
  const formula = oldContract.workerType === "day-rate"
    ? `Day rate ${bahtText(oldContract.dayRate)} × 1 shift`
    : oldContract.workerType === "contractor"
      ? `Fixed fee ${bahtText(oldContract.fixedFee)} ÷ 30 × 1 shift`
      : `Monthly salary ${bahtText(oldContract.monthlySalary)} ÷ 30 × 1 shift`;
  return { way, amount, formula };
}

/** The Monday of a `YYYY-MM-DD` day, as the schedule's own week plans start. */
export function mondayOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  const dow = new Date(at).getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  return new Date(at + offset * 86_400_000).toISOString().slice(0, 10);
}

const validDay = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export { validDay as validSingleShiftDay };

/** Whether a profile has an Onboard Again employment planned (it is coming back, not a former employee). */
async function hasPlannedEngagement(employeeId: string): Promise<boolean> {
  const [row] = await db.select({ id: employeeEngagements.id }).from(employeeEngagements)
    .where(and(eq(employeeEngagements.employeeId, employeeId), eq(employeeEngagements.status, "planned"))).limit(1);
  return !!row;
}

/**
 * The kiosk's door (lib/kioskEmploymentEnded.ts): whether this profile has a
 * single shift on `day` at the branch — the invitation and its assignment
 * both still naming the person and the day. A shift the manager removed (its
 * assignment gone) or moved to someone else opens nothing.
 */
export async function singleShiftOpenOn(employeeId: string, branchId: string, day: string): Promise<boolean> {
  const [row] = await db.select({ id: singleShiftInvitations.id }).from(singleShiftInvitations)
    .innerJoin(scheduleAssignments, eq(scheduleAssignments.id, singleShiftInvitations.assignmentId))
    .where(and(
      eq(singleShiftInvitations.employeeId, employeeId),
      eq(singleShiftInvitations.branchId, branchId),
      eq(singleShiftInvitations.shiftDate, day),
      eq(scheduleAssignments.employeeId, employeeId),
      eq(scheduleAssignments.shiftDate, day),
    )).limit(1);
  return !!row;
}

export interface FormerEmployeeView {
  id: string;
  name: string;
  lastWorkingDay: string | null;
}

/** The branch's former employees, by name: the people who may be invited to a single shift there. */
export async function formerEmployeesOf(tenantId: string, branchId: string, now: Date = new Date()): Promise<FormerEmployeeView[]> {
  const today = bangkokToday(now);
  const rows = await db.select().from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.branchId, branchId)))
    .orderBy(asc(employees.nickname), asc(employees.fullName));
  const ended = rows.filter((profile) => employmentEndedOn(profile, today));
  if (!ended.length) return [];
  const planned = new Set((await db.select({ employeeId: employeeEngagements.employeeId }).from(employeeEngagements)
    .where(and(inArray(employeeEngagements.employeeId, ended.map((p) => p.id)), eq(employeeEngagements.status, "planned"))))
    .map((r) => r.employeeId));
  return ended.filter((p) => !planned.has(p.id)).map((p) => ({
    id: p.id,
    name: getEmployeeDisplayName(p),
    lastWorkingDay: p.lastWorkingDay ? new Date(p.lastWorkingDay).toISOString().slice(0, 10) : null,
  }));
}

export class SingleShiftRefusal extends Error {
  constructor(public status: number, message: string, public reasonCode?: string) {
    super(message);
  }
}

export interface InviteInput {
  tenantId: string;
  actorId: string;
  shiftRow: { id: string; branchId: string };
  shiftDate: string;
  employee: Employee;
  way: SingleShiftPayWay;
  casualDayRate: number | null;
  now?: Date;
}

/** Whether the person already has a single shift on the day, still on the schedule. */
async function singleShiftOn(exec: DbExecutor, employeeId: string, shiftDate: string): Promise<boolean> {
  const [row] = await exec.select({ id: singleShiftInvitations.id }).from(singleShiftInvitations)
    .innerJoin(scheduleAssignments, eq(scheduleAssignments.id, singleShiftInvitations.assignmentId))
    .where(and(eq(singleShiftInvitations.employeeId, employeeId), eq(singleShiftInvitations.shiftDate, shiftDate))).limit(1);
  return !!row;
}

const auditSummary = (name: string, day: string, way: SingleShiftPayWay, rate: number | null) =>
  `${name}: single shift on ${day}, ${singleShiftPayLabel(way, rate).toLowerCase()}`;

/**
 * Puts a former employee on one shift: the assignment, the invitation and the
 * activity entry in one transaction. Refusals are thrown as SingleShiftRefusal
 * in the screen's words.
 */
export async function inviteToSingleShift(input: InviteInput): Promise<SingleShiftInvitation & { assignmentId: string }> {
  const now = input.now ?? new Date();
  const today = bangkokToday(now);
  const { employee, shiftRow, shiftDate } = input;
  if (input.shiftDate < today) throw new SingleShiftRefusal(400, SINGLE_SHIFT_REFUSALS.pastDate);
  if (input.way === "casual_day_rate" ? !validCasualDayRate(input.casualDayRate) : input.casualDayRate != null) {
    throw new SingleShiftRefusal(400, SINGLE_SHIFT_REFUSALS.rate);
  }
  if (!employmentEndedOn(employee, today)) throw new SingleShiftRefusal(400, SINGLE_SHIFT_REFUSALS.notFormer, "NOT_FORMER_EMPLOYEE");
  if (await hasPlannedEngagement(employee.id)) throw new SingleShiftRefusal(400, SINGLE_SHIFT_REFUSALS.onboardAgain, "ONBOARD_AGAIN_PLANNED");
  if (employee.branchId !== shiftRow.branchId) {
    throw new SingleShiftRefusal(400, "This person was not employed at this shift's branch.", "BRANCH_MISMATCH");
  }
  if (await singleShiftOn(db, employee.id, shiftDate)) throw new SingleShiftRefusal(409, SINGLE_SHIFT_REFUSALS.sameDay, "ALREADY_INVITED");
  // Every check the schedule makes for anybody, but the two that refuse an ended employment.
  const fit = await storage.canAssignEmployeeToShift(employee.id, shiftRow.id, shiftDate, { singleShiftInvitation: true }, input.tenantId);
  if (!fit.ok) throw new SingleShiftRefusal(400, fit.message || "Cannot assign employee to shift", fit.reasonCode);
  const weekPlan = await storage.getOrCreateWeekPlan(shiftRow.branchId, mondayOf(shiftDate), input.actorId, input.tenantId);
  const name = getEmployeeDisplayName(employee);

  return db.transaction(async (tx) => {
    // One person's invitations are made one at a time, so two clicks cannot make two shifts on a day.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`single-shift:${employee.id}`}))`);
    if (await singleShiftOn(tx, employee.id, shiftDate)) throw new SingleShiftRefusal(409, SINGLE_SHIFT_REFUSALS.sameDay, "ALREADY_INVITED");
    const [assignment] = await tx.insert(scheduleAssignments).values({
      tenantId: input.tenantId,
      weekPlanId: weekPlan.id,
      shiftRowId: shiftRow.id,
      shiftDate,
      assigneeType: "employee",
      employeeId: employee.id,
      assignedBy: input.actorId,
      isBorrowed: false,
    }).returning();
    const [invitation] = await tx.insert(singleShiftInvitations).values({
      tenantId: input.tenantId,
      employeeId: employee.id,
      branchId: shiftRow.branchId,
      assignmentId: assignment.id,
      shiftRowId: shiftRow.id,
      shiftDate,
      payBasis: input.way,
      casualDayRate: input.way === "casual_day_rate" ? input.casualDayRate : null,
      createdBy: input.actorId,
      updatedBy: input.actorId,
    }).returning();
    await storage.createActivityLog({
      branchId: shiftRow.branchId,
      employeeId: employee.id,
      activityType: "single_shift_invited",
      summaryText: auditSummary(name, shiftDate, input.way, invitation.casualDayRate),
      metadataJson: JSON.stringify({
        invitationId: invitation.id, assignmentId: assignment.id, shiftRowId: shiftRow.id, shiftDate,
        payWay: input.way, casualDayRate: invitation.casualDayRate,
      }),
      createdBy: input.actorId,
      tenantId: input.tenantId,
    }, tx);
    return { ...invitation, assignmentId: assignment.id };
  });
}

/**
 * Switches a single shift between the old contract and a casual day rate, the
 * activity entry with it, in one transaction. Answers the invitation as it is
 * now; the same way and rate again writes nothing.
 */
export async function changeSingleShiftPay(input: {
  tenantId: string;
  actorId: string;
  invitationId: string;
  canReachBranch: (branchId: string) => boolean;
  way: SingleShiftPayWay;
  casualDayRate: number | null;
  now?: Date;
}): Promise<SingleShiftInvitation> {
  if (input.way === "casual_day_rate" ? !validCasualDayRate(input.casualDayRate) : input.casualDayRate != null) {
    throw new SingleShiftRefusal(400, SINGLE_SHIFT_REFUSALS.rate);
  }
  const today = bangkokToday(input.now ?? new Date());
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(singleShiftInvitations)
      .where(and(eq(singleShiftInvitations.id, input.invitationId), eq(singleShiftInvitations.tenantId, input.tenantId)))
      .limit(1).for("update");
    if (!before || !before.assignmentId || !input.canReachBranch(before.branchId)) {
      throw new SingleShiftRefusal(404, "Single shift not found");
    }
    const [person] = await tx.select().from(employees).where(eq(employees.id, before.employeeId)).limit(1);
    if (String(before.shiftDate) < today) throw new SingleShiftRefusal(400, SINGLE_SHIFT_REFUSALS.pastChange);
    const rate = input.way === "casual_day_rate" ? input.casualDayRate : null;
    if (before.payBasis === input.way && (before.casualDayRate ?? null) === rate) return before;
    const [after] = await tx.update(singleShiftInvitations)
      .set({ payBasis: input.way, casualDayRate: rate, updatedBy: input.actorId, updatedAt: new Date() })
      .where(eq(singleShiftInvitations.id, before.id)).returning();
    await storage.createActivityLog({
      branchId: before.branchId,
      employeeId: before.employeeId,
      activityType: "single_shift_pay_changed",
      summaryText: auditSummary(person ? getEmployeeDisplayName(person) : "A former employee", String(before.shiftDate), input.way, rate),
      metadataJson: JSON.stringify({
        invitationId: before.id, shiftDate: String(before.shiftDate),
        from: { payWay: before.payBasis, casualDayRate: before.casualDayRate },
        to: { payWay: input.way, casualDayRate: rate },
      }),
      createdBy: input.actorId,
      tenantId: input.tenantId,
    }, tx);
    return after;
  });
}

export interface SingleShiftView {
  id: string;
  assignmentId: string;
  employeeId: string;
  employeeName: string;
  branchId: string;
  shiftRowId: string | null;
  shiftDate: string;
  payWay: SingleShiftPayWay;
  casualDayRate: number | null;
  payLabel: string;
  /** What the shift is worth: for the payroll roles only, else absent. */
  pay?: SingleShiftPay;
  invitedBy: string | null;
  invitedAt: string;
  changedBy: string | null;
  changedAt: string;
}

const day = (value: string | Date) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

/**
 * The branch's single shifts between two days, each still on the schedule.
 * `withPay` (the payroll roles) adds what each is worth, from the person's
 * payroll profile.
 */
export async function singleShiftsOf(tenantId: string, branchId: string, from: string, to: string, withPay: boolean): Promise<SingleShiftView[]> {
  const rows = await db.select({ invitation: singleShiftInvitations, employee: employees })
    .from(singleShiftInvitations)
    .innerJoin(employees, eq(employees.id, singleShiftInvitations.employeeId))
    .innerJoin(scheduleAssignments, and(
      eq(scheduleAssignments.id, singleShiftInvitations.assignmentId),
      eq(scheduleAssignments.employeeId, singleShiftInvitations.employeeId),
      eq(scheduleAssignments.shiftDate, singleShiftInvitations.shiftDate),
    ))
    .where(and(
      eq(singleShiftInvitations.tenantId, tenantId),
      eq(singleShiftInvitations.branchId, branchId),
      gte(singleShiftInvitations.shiftDate, from),
      lte(singleShiftInvitations.shiftDate, to),
      isNotNull(singleShiftInvitations.assignmentId),
    ))
    .orderBy(asc(singleShiftInvitations.shiftDate), asc(singleShiftInvitations.createdAt));
  if (!rows.length) return [];
  const people = Array.from(new Set(rows.flatMap((r) => [r.invitation.createdBy, r.invitation.updatedBy]).filter((v): v is string => !!v)));
  const names = new Map((people.length
    ? await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, people))
    : []).map((u) => [u.id, u.fullName]));
  const terms = new Map<string, OldContractTerms>();
  if (withPay) {
    const profiles = await db.select().from(payrollProfiles).where(and(
      eq(payrollProfiles.tenantId, tenantId),
      inArray(payrollProfiles.employeeId, Array.from(new Set(rows.map((r) => r.invitation.employeeId)))),
    ));
    for (const p of profiles) {
      terms.set(p.employeeId, { workerType: p.workerType, dayRate: Number(p.dayRate), monthlySalary: Number(p.monthlySalary), fixedFee: Number(p.fixedFee) });
    }
  }
  return rows.map(({ invitation: i, employee }) => ({
    id: i.id,
    assignmentId: i.assignmentId!,
    employeeId: i.employeeId,
    employeeName: getEmployeeDisplayName(employee),
    branchId: i.branchId,
    shiftRowId: i.shiftRowId,
    shiftDate: day(i.shiftDate),
    payWay: i.payBasis,
    casualDayRate: i.casualDayRate,
    payLabel: singleShiftPayLabel(i.payBasis, i.casualDayRate),
    ...(withPay ? { pay: singleShiftPay(i.payBasis, i.casualDayRate, terms.get(i.employeeId) ?? null) } : {}),
    invitedBy: i.createdBy ? names.get(i.createdBy) ?? null : null,
    invitedAt: i.createdAt.toISOString(),
    changedBy: i.updatedBy ? names.get(i.updatedBy) ?? null : null,
    changedAt: i.updatedAt.toISOString(),
  }));
}

/** The shift row a single shift goes on, in the caller's park group. */
export async function shiftRowFor(tenantId: string, shiftRowId: string) {
  const [row] = await db.select({ id: scheduleShiftRows.id, branchId: scheduleShiftRows.branchId })
    .from(scheduleShiftRows).where(and(eq(scheduleShiftRows.id, shiftRowId), eq(scheduleShiftRows.tenantId, tenantId))).limit(1);
  return row;
}
