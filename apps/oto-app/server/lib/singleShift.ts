import { and, asc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import {
  branches,
  departments,
  employees,
  roles,
  scheduleAssignments,
  scheduleShiftBreaks,
  scheduleShiftRows,
  singleShiftInvitations,
  users,
  type Employee,
  type SingleShiftInvitation,
} from "@shared/schema";
import {
  SINGLE_SHIFT_REFUSALS,
  singleShiftPayLabel,
  singleShiftWayWords,
  validCasualDayRate,
  type SingleShiftKioskView,
  type SingleShiftPayWay,
} from "@shared/singleShift";
import { db } from "../db";
import { storage } from "../storage";
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
 *    the shift's branch) put a FORMER employee on a shift: a profile whose
 *    employment has ended by today, by the kiosk's own measure
 *    (`employmentEndedOn`). A current employee is refused in words: they are
 *    scheduled as usual. Each invitation is one shift.
 *  - The shift is an ordinary schedule assignment, made with every check the
 *    schedule makes for anybody (department, role, transfer, leave, the same
 *    shift twice, overlapping shifts), except the two that refuse an ended
 *    employment, and on no past date (the schedule's own rule). This row
 *    beside it is the invitation: the day, the branch, and how it is paid.
 *  - How it is paid. By default on the old contract; the manager may switch the
 *    shift to a casual day rate and type it (whole baht a day, as the casual
 *    workers page takes a casual worker's rate), and switch back, until the
 *    day has passed (the schedule's "no change on a past date"). Each choice is
 *    written to the activity log with who and which way, never the figure
 *    (`single_shift_invited`, `single_shift_pay_changed`).
 *  - What the shift is worth is payroll's (SCRUM-1055): the run of the month
 *    it is worked pays an old-contract shift as its own "Single shift" line
 *    (payroll/world.ts, engine/company-calculations.ts); a casual day rate is
 *    not paid there (company payroll has no pay for casual workers) and the
 *    month's payroll names it, with every shift it cannot pay.
 *  - The kiosk (`singleShiftOpenOn`): the person clocks in and out at the
 *    shift's branch on its day, as anybody employed that day does, and from
 *    the next day the kiosk refuses them again by itself. The login stays in
 *    pay only.
 *  - What they see of the schedule (SCRUM-1055, R7, `singleShiftsShownAtKiosk`):
 *    that day's shift, on the kiosk's answer to their own clock-in and
 *    clock-out there; nothing else of the schedule, and nothing in pay only.
 */

export type { SingleShiftPayWay };

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

/**
 * What the kiosk shows the former employee about their shift (SCRUM-1055, R7:
 * they "also see their schedule for that day"). Their login is in pay only
 * and reaches no schedule (lib/payOnlyAccess.ts), and is left so: the one
 * door already open to them is the kiosk at the shift's branch on its day,
 * so the shift is shown there, in the answer to their own clock-in and
 * clock-out (routes.ts, the phone and face clock doors).
 *
 * Read only for a profile whose employment has ended (the kiosk's own
 * measure): a current employee's clock is answered as before, with nothing
 * more read. Only the shifts of the pair that opened the kiosk
 * (`singleShiftOpenOn`): the invitation and its assignment, still naming this
 * person and today, at this branch. Each with its times, its name in the
 * schedule, department, role, branch and this person's own breaks; never how
 * it is paid, nobody else's shift, no other day. Undefined when there is none.
 */
export async function singleShiftsShownAtKiosk(
  profile: Pick<Employee, "id" | "status" | "employmentState" | "lastWorkingDay">,
  branchId: string,
  now: Date = new Date(),
): Promise<SingleShiftKioskView[] | undefined> {
  const today = bangkokToday(now);
  if (!employmentEndedOn(profile, today)) return undefined;
  const rows = await db.select({
    assignmentId: scheduleAssignments.id,
    startTime: scheduleShiftRows.startTime,
    endTime: scheduleShiftRows.endTime,
    label: scheduleShiftRows.label,
    department: departments.name,
    role: roles.name,
    branchName: branches.name,
    breakStartTime: scheduleShiftBreaks.breakStartTime,
    breakEndTime: scheduleShiftBreaks.breakEndTime,
  })
    .from(singleShiftInvitations)
    .innerJoin(scheduleAssignments, and(
      eq(scheduleAssignments.id, singleShiftInvitations.assignmentId),
      eq(scheduleAssignments.employeeId, singleShiftInvitations.employeeId),
      eq(scheduleAssignments.shiftDate, singleShiftInvitations.shiftDate),
    ))
    .innerJoin(scheduleShiftRows, eq(scheduleShiftRows.id, scheduleAssignments.shiftRowId))
    .innerJoin(branches, eq(branches.id, singleShiftInvitations.branchId))
    .leftJoin(departments, eq(departments.id, scheduleShiftRows.departmentId))
    .leftJoin(roles, eq(roles.id, scheduleAssignments.roleId))
    .leftJoin(scheduleShiftBreaks, and(
      eq(scheduleShiftBreaks.assignmentId, scheduleAssignments.id),
      eq(scheduleShiftBreaks.shiftDate, singleShiftInvitations.shiftDate),
    ))
    .where(and(
      eq(singleShiftInvitations.employeeId, profile.id),
      eq(singleShiftInvitations.branchId, branchId),
      eq(singleShiftInvitations.shiftDate, today),
    ))
    .orderBy(asc(scheduleShiftRows.startTime), asc(scheduleAssignments.id), asc(scheduleShiftBreaks.breakStartTime));
  if (!rows.length) return undefined;
  const hhmm = (t: string) => t.slice(0, 5);
  const shown = new Map<string, SingleShiftKioskView>();
  for (const row of rows) {
    let view = shown.get(row.assignmentId);
    if (!view) {
      view = {
        shiftDate: today,
        startTime: hhmm(row.startTime),
        endTime: hhmm(row.endTime),
        label: row.label ?? null,
        department: row.department ?? null,
        role: row.role ?? null,
        branchName: row.branchName,
        breaks: [],
      };
      shown.set(row.assignmentId, view);
    }
    if (row.breakStartTime && row.breakEndTime) view.breaks.push({ startTime: hhmm(row.breakStartTime), endTime: hhmm(row.breakEndTime) });
  }
  return Array.from(shown.values());
}

export interface FormerEmployeeView {
  id: string;
  name: string;
  lastWorkingDay: string | null;
}

/** The branch's former employees, by name: the people the dialog offers for a single shift there. */
export async function formerEmployeesOf(tenantId: string, branchId: string, now: Date = new Date()): Promise<FormerEmployeeView[]> {
  const today = bangkokToday(now);
  const rows = await db.select().from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.branchId, branchId)))
    .orderBy(asc(employees.nickname), asc(employees.fullName));
  return rows.filter((profile) => employmentEndedOn(profile, today)).map((p) => ({
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

/** The activity log's words: who, which day, which way; never the figure. */
const auditSummary = (name: string, day: string, way: SingleShiftPayWay) =>
  `${name}: single shift on ${day}, ${singleShiftWayWords(way)}`;

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
  // Every check the schedule makes for anybody, but the two that refuse an ended employment.
  const fit = await storage.canAssignEmployeeToShift(employee.id, shiftRow.id, shiftDate, { singleShiftInvitation: true }, input.tenantId);
  if (!fit.ok) throw new SingleShiftRefusal(400, fit.message || "Cannot assign employee to shift", fit.reasonCode);
  const weekPlan = await storage.getOrCreateWeekPlan(shiftRow.branchId, mondayOf(shiftDate), input.actorId, input.tenantId);
  const name = getEmployeeDisplayName(employee);

  return db.transaction(async (tx) => {
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
      summaryText: auditSummary(name, shiftDate, input.way),
      metadataJson: JSON.stringify({
        invitationId: invitation.id, assignmentId: assignment.id, shiftRowId: shiftRow.id, shiftDate, payWay: input.way,
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
      summaryText: auditSummary(person ? getEmployeeDisplayName(person) : "A former employee", String(before.shiftDate), input.way),
      metadataJson: JSON.stringify({
        invitationId: before.id, shiftDate: String(before.shiftDate),
        from: { payWay: before.payBasis }, to: { payWay: input.way },
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
  invitedBy: string | null;
  invitedAt: string;
  changedBy: string | null;
  changedAt: string;
}

const day = (value: string | Date) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

/** The branch's single shifts between two days, each still on the schedule. */
export async function singleShiftsOf(tenantId: string, branchId: string, from: string, to: string): Promise<SingleShiftView[]> {
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
