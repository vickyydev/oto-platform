/**
 * The world loader (SCRUM-568, the company payroll's R3; plan §2): builds the
 * engine's input — the prototype's browser aggregate, `PayrollWorld` here —
 * for ONE park group (tenant) and ONE payroll month from the database, with
 * the month's `CompanyPayrollDocument` assembled beside it. Every pure engine
 * function then runs with its signature and body intact. Reads only; a fixed
 * number of queries whatever the head count (plan §10).
 *
 * The seams it closes:
 *   - R1 SEAM 1 (calculations.ts:183). The engine reads only
 *     `branch.rulesHistory`. The company-v1 rule sets are stored as company
 *     defaults (branch null) and branch exceptions; they are FLATTENED here
 *     into each branch's history the way the prototype materialised them
 *     (foundation.ts `scopedPayRules`): a branch with no exception follows the
 *     company versions of its country; a branch with exceptions follows the
 *     company versions dated before its first exception, then its own — a
 *     company change after that no longer reaches it (the prototype's
 *     `branchPayRuleExceptions`). Deduction lists likewise: the branch's
 *     latest list effective by the first of the month, else the company's,
 *     else none (the engine's `deductionRules` is undated).
 *   - R1 SEAM 2 (run-calculations.ts:815). The legacy month-end throws
 *     without a branch `leavePolicyHistory`. The policy is built from the
 *     LIVE SCRUM-560 leave-types catalogue (server/leave-types.ts, reused, not
 *     duplicated): each type by its code and name; `paid` is false for the
 *     UNPAID code only (the catalogue has no paid flag; the prototype's Thai
 *     policy has exactly one unpaid type); public holidays from the park
 *     group's calendar; Days Off from CHANGE_DAY_OFF. Payroll reads only the
 *     names and paid flags; balances stay SCRUM-560's.
 *   - Job titles are free text, so the rules' `overtimeEligibilityByRole`
 *     gets every title in the world as `true`: the company engine already
 *     sets every listed role to true "so legacy role defaults must not veto"
 *     the profile's own OT decision (company-calculations.ts:55); a title
 *     missing from that map would otherwise veto it silently.
 *
 * Who is in the world: every payroll profile whose employment overlaps the
 * service-charge earning month or the payroll month, placed in the branch of
 * its allocation's home at month end (the roster branch). A profile that
 * cannot be placed — no joining date, no allocation by month end, a home
 * branch without payroll details or rules — is left out and LISTED in
 * `excluded`, so nobody silently goes unpaid.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import {
  branches,
  employeeTimeOff,
  employees,
  leavePolicies,
  payrollBranchDetailsVersions,
  payrollEwfRemittances,
  payrollEwfSettingsVersions,
  payrollIncentiveAssignments,
  payrollIncentiveRuleVersions,
  payrollIncentiveRules,
  payrollLeaveValuations,
  payrollMonthInputs,
  payrollMonthRuns,
  payrollOffboarding,
  payrollOtBankBookings,
  payrollPayingAccounts,
  payrollPayingEntities,
  payrollProfileAdvances,
  payrollProfileAllocations,
  payrollProfileSeparatePayments,
  payrollProfiles,
  payrollRuleLists,
  payrollRunAttendanceReviews,
  payrollRunManualLines,
  payrollRunOverrides,
  payrollRunOvertimeDecisions,
  payrollRunSnapshots,
  payrollRunThirdPartyApprovals,
  payrollRunVersions,
  payrollServicePolicies,
  publicHolidays,
  statutoryRuleSets,
} from "@shared/schema";
import { db } from "../db";
import { getEmployeeDisplayName } from "../lib/employeeDisplayName";
import { listTenantLeaveTypes } from "../leave-types";
import { profileOut } from "./profiles";
import { ensureTenantPayrollRuleSets } from "./setup";
import { loadAttendanceFeed, type FeedAttendanceDay } from "./attendance";
import { ENGINE_REVISION } from "./engine/revision";
import { allocationAt } from "./engine/payroll-profile";
import { monthDays, previousMonth } from "./engine/company-math";
import type {
  BranchDetails, BranchRecord, DeductionRule, EwfRemittance, EwfSettings, EwfSettingsVersion, LeaveLedgerEntry, LeaveOffboardingRecord,
  LeavePolicy, LeavePolicyVersion, OtBankBooking, OvertimeDecision, PayrollWorld, RunDraft, StaffMember, StatutoryRules,
} from "./engine/model";
import type {
  AttendanceReview, CompanyDraft, CompanyIncentive, CompanyMonthInputs, CompanyPayrollDocument, CompanyResult, CompanySnapshot, IncentiveAssignment, IncentiveRuleVersion, ServicePolicy,
} from "./engine/company-model";
import type { EmployeePayrollProfile, PayingAccount, PayingEntity } from "./engine/payroll-profile";

export type { PayrollWorld, BranchRecord, StaffMember, AttendanceDay, StatutoryRules } from "./engine/model";
export type { CompanyPayrollDocument, CompanyCalculation, CompanyResult, CompanyPerson } from "./engine/company-model";
export type { EmployeePayrollProfile, PayingEntity, PayingAccount } from "./engine/payroll-profile";
export type { PayrollClock } from "./engine/clock";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const iso = (value: Date | string | null | undefined) => value == null ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const num = (value: string | number | null | undefined) => value == null ? 0 : Number(value);
/**
 * A stored date as the engine compares it. The engine compares dated
 * versions with a MONTH ("2026-09") in some places and with a DATE in others;
 * a version that starts on the 1st is written as its month, which both
 * comparisons read as "from the first of that month". Any other start stays a
 * date: it applies to day comparisons from that day and to month comparisons
 * from the next month, as the stored date says.
 */
export const engineFrom = (date: string) => date.endsWith("-01") ? date.slice(0, 7) : date;

export interface ExcludedPerson { employeeId: string; name: string; reason: string }
export interface RunRef { runId: string; versionId: string; version: number; status: string; payDate: string; stage?: string; approvedSignature?: string | null; reopenReason?: string | null }
export interface LoadedWorld {
  tenantId: string;
  month: string;
  world: PayrollWorld;
  doc: CompanyPayrollDocument;
  /** Profiles that overlap the month but cannot be paid by this preview, and why. */
  excluded: ExcludedPerson[];
  /** Plain-language notes about the feeds (skipped valuations, branches without details). */
  notes: string[];
  runs: Map<string, RunRef>;
  attendance: FeedAttendanceDay[];
  queries: number;
}

export class WorldRefusal extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The Thai leave policy the engine reads, from SCRUM-560's live catalogue (seam 2). */
export function leavePolicyFromCatalogue(country: "TH" | "MY", types: { code: string; name: string; isActive: boolean; accrualMethod: string; annualDays: number; waitingMonths: number; daysWorkedRequired: number; daysOffEarned: number }[],
  holidays: string[], dayOff: { daysWorkedRequired: number; daysOffEarned: number } | null): LeavePolicy {
  const change = types.find((t) => t.code.toUpperCase() === "CHANGE_DAY_OFF");
  return {
    country,
    types: types.map((t) => ({
      id: t.code.toUpperCase(), name: t.name, paid: t.code.toUpperCase() !== "UNPAID",
      annualEntitlement: t.annualDays,
      accrualMethod: t.accrualMethod === "WORKDAYS" ? "confirmed-days" : t.accrualMethod === "NONE" ? "upfront" : "monthly",
      prorateJoiners: false, waitingMonths: t.waitingMonths, carryForwardCap: 0, carryExpiryMonths: null,
      allowNegative: t.code.toUpperCase() === "UNPAID", paidOutOnExit: t.code.toUpperCase() === "ANNUAL",
    })),
    publicHolidays: [...holidays].sort(),
    daysOff: {
      earnedDays: dayOff?.daysOffEarned ?? change?.daysOffEarned ?? 0,
      workedDays: dayOff?.daysWorkedRequired ?? change?.daysWorkedRequired ?? 0,
    },
  };
}

/** Seam 1: company defaults and branch exceptions flattened into one branch's rules history. */
export function flattenRulesHistory(country: string, rows: { branchId: string | null; country: string; effectiveFrom: string; rules: StatutoryRules }[], branchId: string): StatutoryRules[] {
  const company = rows.filter((r) => r.branchId === null && r.country === country);
  const own = rows.filter((r) => r.branchId === branchId);
  const firstOwn = own.map((r) => r.effectiveFrom).sort()[0];
  const chosen = firstOwn ? [...company.filter((r) => r.effectiveFrom < firstOwn), ...own] : company;
  return chosen.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .map((r) => ({ ...structuredClone(r.rules), effectiveFrom: r.effectiveFrom.slice(0, 7), country: r.country as StatutoryRules["country"] }));
}

/** Seam 1, deductions: the branch's latest list effective by the 1st of the month, else the company's, else none. */
export function deductionRulesFor(lists: { branchId: string | null; effectiveFrom: string; rules: DeductionRule[] }[], branchId: string, month: string): DeductionRule[] {
  const by = `${month}-01`;
  const latest = (items: typeof lists) => items.filter((l) => l.effectiveFrom <= by).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
  return structuredClone((latest(lists.filter((l) => l.branchId === branchId)) ?? latest(lists.filter((l) => l.branchId === null)))?.rules ?? []);
}

/** A stored CompanyMonthInputs, or the empty one the prototype starts from. */
export const emptyMonthInputs = (): CompanyMonthInputs => ({ revenue: {}, staff: {}, counts: {} });

/** Today in the park's timezone. */
export function parkToday(timeZone = "Asia/Bangkok"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function loadPayrollWorld(tenantId: string, month: string, options: { today?: string } = {}): Promise<LoadedWorld> {
  if (!MONTH.test(month)) throw new WorldRefusal(400, "Choose a payroll month (YYYY-MM).");
  const prev = previousMonth(month);
  const monthEnd = `${month}-${String(monthDays(month)).padStart(2, "0")}`;
  const windowFrom = `${prev}-01`;
  let queries = 0;
  const q = <T>(p: Promise<T>) => { queries++; return p; };
  // The park group's Thai rule set is made on first use (R2's lazy seed), as the setup read does.
  await ensureTenantPayrollRuleSets(tenantId);
  queries++;

  const [branchRows, detailRows, entityRows, accountRows, ruleRows, listRows, ewfRows, remitRows, profileRows,
    holidayRows, inputRows, policyRows, ruleDefRows, versionRows, assignmentRows, runRows, bookingRows, valuationRows, offboardingRows, leaveTypes, dayOffRows, snapshotRows] = await Promise.all([
    q(db.select({ id: branches.id, name: branches.name, timezone: branches.timezone }).from(branches).where(eq(branches.tenantId, tenantId)).orderBy(asc(branches.id))),
    q(db.select().from(payrollBranchDetailsVersions).where(eq(payrollBranchDetailsVersions.tenantId, tenantId)).orderBy(asc(payrollBranchDetailsVersions.effectiveFrom))),
    q(db.select().from(payrollPayingEntities).where(eq(payrollPayingEntities.tenantId, tenantId)).orderBy(asc(payrollPayingEntities.id))),
    q(db.select().from(payrollPayingAccounts).where(eq(payrollPayingAccounts.tenantId, tenantId)).orderBy(asc(payrollPayingAccounts.id))),
    q(db.select().from(statutoryRuleSets).where(and(eq(statutoryRuleSets.tenantId, tenantId), eq(statutoryRuleSets.ruleFormat, "company-v1")))),
    q(db.select().from(payrollRuleLists).where(and(eq(payrollRuleLists.tenantId, tenantId), eq(payrollRuleLists.kind, "deduction")))),
    q(db.select().from(payrollEwfSettingsVersions).where(eq(payrollEwfSettingsVersions.tenantId, tenantId)).orderBy(asc(payrollEwfSettingsVersions.effectiveFrom))),
    q(db.select().from(payrollEwfRemittances).where(eq(payrollEwfRemittances.tenantId, tenantId)).orderBy(asc(payrollEwfRemittances.month))),
    q(db.select({ profile: payrollProfiles, employee: employees }).from(payrollProfiles)
      .innerJoin(employees, and(eq(employees.id, payrollProfiles.employeeId), eq(employees.tenantId, tenantId)))
      .where(eq(payrollProfiles.tenantId, tenantId)).orderBy(asc(payrollProfiles.employeeId))),
    q(db.select({ date: publicHolidays.date }).from(publicHolidays).where(and(eq(publicHolidays.tenantId, tenantId), eq(publicHolidays.isActive, true)))),
    q(db.select().from(payrollMonthInputs).where(and(eq(payrollMonthInputs.tenantId, tenantId), inArray(payrollMonthInputs.month, [prev, month])))),
    q(db.select().from(payrollServicePolicies).where(eq(payrollServicePolicies.tenantId, tenantId)).orderBy(asc(payrollServicePolicies.branchId), asc(payrollServicePolicies.version))),
    q(db.select().from(payrollIncentiveRules).where(eq(payrollIncentiveRules.tenantId, tenantId)).orderBy(asc(payrollIncentiveRules.id))),
    q(db.select().from(payrollIncentiveRuleVersions).where(eq(payrollIncentiveRuleVersions.tenantId, tenantId)).orderBy(asc(payrollIncentiveRuleVersions.ruleId), asc(payrollIncentiveRuleVersions.version))),
    q(db.select().from(payrollIncentiveAssignments).where(eq(payrollIncentiveAssignments.tenantId, tenantId)).orderBy(asc(payrollIncentiveAssignments.ruleId), asc(payrollIncentiveAssignments.assignmentKey))),
    q(db.select({ run: payrollMonthRuns, version: payrollRunVersions }).from(payrollMonthRuns)
      .innerJoin(payrollRunVersions, and(eq(payrollRunVersions.tenantId, tenantId), eq(payrollRunVersions.runId, payrollMonthRuns.id), eq(payrollRunVersions.version, payrollMonthRuns.currentVersion)))
      .where(and(eq(payrollMonthRuns.tenantId, tenantId), eq(payrollMonthRuns.month, month)))),
    q(db.select().from(payrollOtBankBookings).where(eq(payrollOtBankBookings.tenantId, tenantId)).orderBy(asc(payrollOtBankBookings.date), asc(payrollOtBankBookings.id))),
    q(db.select({ valuation: payrollLeaveValuations, timeOffId: employeeTimeOff.id }).from(payrollLeaveValuations)
      .leftJoin(employeeTimeOff, and(eq(employeeTimeOff.id, payrollLeaveValuations.employeeTimeOffId), eq(employeeTimeOff.tenantId, tenantId)))
      .where(eq(payrollLeaveValuations.tenantId, tenantId)).orderBy(asc(payrollLeaveValuations.startsOn), asc(payrollLeaveValuations.id))),
    q(db.select().from(payrollOffboarding).where(eq(payrollOffboarding.tenantId, tenantId)).orderBy(asc(payrollOffboarding.employeeId))),
    (queries++, listTenantLeaveTypes(tenantId)),
    q(db.select({ branchId: leavePolicies.branchId, daysWorkedRequired: leavePolicies.daysWorkedRequired, daysOffEarned: leavePolicies.daysOffEarned, effectiveFrom: leavePolicies.effectiveFrom })
      .from(leavePolicies).where(and(eq(leavePolicies.tenantId, tenantId), eq(leavePolicies.isActive, true)))),
    // R4: every locked version of an EARLIER month (advances repaid, YTD, the
    // signature's history). The result only: the rest of a snapshot stays frozen in its row.
    q(db.select({ entityId: payrollRunSnapshots.entityId, month: payrollRunSnapshots.month, version: payrollRunSnapshots.version, result: payrollRunSnapshots.result,
      lockedAt: payrollRunSnapshots.lockedAt, lockedByName: payrollRunSnapshots.lockedByName, gmActor: payrollRunSnapshots.gmActor })
      .from(payrollRunSnapshots).where(and(eq(payrollRunSnapshots.tenantId, tenantId), lt(payrollRunSnapshots.month, month)))
      .orderBy(asc(payrollRunSnapshots.month), asc(payrollRunSnapshots.entityId), asc(payrollRunSnapshots.version))),
  ]);

  const versionIds = runRows.map((r) => r.version.id);
  const [reviewRows, overrideRows, manualRows, overtimeRows, approvalRows] = versionIds.length ? await Promise.all([
    q(db.select().from(payrollRunAttendanceReviews).where(and(eq(payrollRunAttendanceReviews.tenantId, tenantId), inArray(payrollRunAttendanceReviews.runVersionId, versionIds))).orderBy(asc(payrollRunAttendanceReviews.attendanceDayKey))),
    q(db.select().from(payrollRunOverrides).where(and(eq(payrollRunOverrides.tenantId, tenantId), inArray(payrollRunOverrides.runVersionId, versionIds))).orderBy(asc(payrollRunOverrides.createdAt), asc(payrollRunOverrides.id))),
    q(db.select().from(payrollRunManualLines).where(and(eq(payrollRunManualLines.tenantId, tenantId), inArray(payrollRunManualLines.runVersionId, versionIds))).orderBy(asc(payrollRunManualLines.createdAt), asc(payrollRunManualLines.id))),
    q(db.select().from(payrollRunOvertimeDecisions).where(and(eq(payrollRunOvertimeDecisions.tenantId, tenantId), inArray(payrollRunOvertimeDecisions.runVersionId, versionIds))).orderBy(asc(payrollRunOvertimeDecisions.attendanceDayKey), asc(payrollRunOvertimeDecisions.exceptionIndex))),
    q(db.select().from(payrollRunThirdPartyApprovals).where(and(eq(payrollRunThirdPartyApprovals.tenantId, tenantId), inArray(payrollRunThirdPartyApprovals.runVersionId, versionIds))).orderBy(asc(payrollRunThirdPartyApprovals.employeeId))),
  ]) : [[], [], [], [], []];

  const profileIds = profileRows.map((r) => r.profile.id);
  const [allocRows, advanceRows, paymentRows] = profileIds.length ? await Promise.all([
    q(db.select().from(payrollProfileAllocations).where(and(eq(payrollProfileAllocations.tenantId, tenantId), inArray(payrollProfileAllocations.profileId, profileIds)))),
    q(db.select().from(payrollProfileAdvances).where(and(eq(payrollProfileAdvances.tenantId, tenantId), inArray(payrollProfileAdvances.profileId, profileIds))).orderBy(asc(payrollProfileAdvances.createdAt), asc(payrollProfileAdvances.id))),
    q(db.select().from(payrollProfileSeparatePayments).where(and(eq(payrollProfileSeparatePayments.tenantId, tenantId), inArray(payrollProfileSeparatePayments.profileId, profileIds))).orderBy(asc(payrollProfileSeparatePayments.createdAt), asc(payrollProfileSeparatePayments.id))),
  ]) : [[], [], []];

  const notes: string[] = [];
  const excluded: ExcludedPerson[] = [];
  const holidays = holidayRows.map((h) => iso(h.date));
  const names = new Map(branchRows.map((b) => [b.id, b.name]));
  const rules = ruleRows.map((r) => ({ branchId: r.branchId, country: r.countryCode, effectiveFrom: iso(r.effectiveFrom), rules: r.rules as StatutoryRules }));
  const lists = listRows.map((l) => ({ branchId: l.branchId, effectiveFrom: iso(l.effectiveFrom), rules: l.rules as DeductionRule[] }));
  const jobTitles = Array.from(new Set(profileRows.map((r) => r.profile.jobTitle.trim()).filter(Boolean))).sort();

  // ── Branches: those with payroll details and rules effective for the month ──
  const world: PayrollWorld = {
    schemaVersion: 14, branches: {},
    payingEntities: entityRows.filter((e) => !e.archivedAt).map((e): PayingEntity => ({
      id: e.id, name: e.name, country: e.country, ...(e.taxId ? { taxId: e.taxId } : {}), ...(e.ssoEmployerNumber ? { ssoEmployerNumber: e.ssoEmployerNumber } : {}),
    })),
    payingAccounts: accountRows.filter((a) => !a.archivedAt).map((a): PayingAccount => ({
      id: a.id, entityId: a.entityId, label: a.label, bank: a.bank, accountNumber: a.accountNumber, accountName: a.accountName, fileFormat: a.fileFormat,
      ...(a.bankCode ? { bankCode: a.bankCode } : {}), ...(a.debitAccount ? { debitAccount: a.debitAccount } : {}),
      ...(a.feeAccount ? { feeAccount: a.feeAccount } : {}), ...(a.scbProduct ? { scbProduct: a.scbProduct } : {}),
    })),
    costCentreNames: Object.fromEntries(branchRows.map((b) => [b.id, b.name])),
    revenue: [], attendance: [], changelog: [], manualFigures: [], runDrafts: {}, runAudits: [], runSnapshots: [], runOutputStatuses: [],
    boothRoster: [], boothVouchers: [], incentiveChanges: [], statutoryDocuments: [], statutoryAudits: [],
    leaveLedger: [], otBankBookings: [], leavePolicyChanges: [], leaveOffboarding: [], leaveNegativeDecisions: [],
    ewfSettings: ewfRows.map((v): EwfSettingsVersion => ({ entityId: v.entityId, effectiveFrom: iso(v.effectiveFrom), settings: v.settings as EwfSettings, reason: v.reason, who: v.createdBy ?? "", when: v.createdAt.toISOString() })),
    ewfChanges: [],
    ewfRemittances: remitRows.map((r): EwfRemittance => ({ entityId: r.entityId, month: r.month, amountPaid: num(r.amountPaid), paidOn: r.paidOn ? iso(r.paidOn) : null, reason: r.reason, who: r.createdBy ?? "", when: r.updatedAt.toISOString() })),
    ewfOffboardingChecklists: [],
  };
  for (const branch of branchRows) {
    const versions = detailRows.filter((v) => v.branchId === branch.id);
    if (!versions.length) continue;
    const detailsHistory = versions.map((v) => ({
      effectiveFrom: engineFrom(iso(v.effectiveFrom)),
      details: { ...(v.details as BranchDetails), ...(v.payingEntityId ? { payingEntityId: v.payingEntityId } : {}), ...(v.defaultPayingAccountId ? { defaultPayingAccountId: v.defaultPayingAccountId } : {}) } as BranchDetails,
    }));
    const current = detailsHistory.filter((d) => d.effectiveFrom <= month).at(-1);
    if (!current) { notes.push(`${branch.name}: its payroll details start after ${month}, so it is not in this month.`); continue; }
    const country = current.details.country;
    const rulesHistory = flattenRulesHistory(country, rules, branch.id).map((r) => ({
      ...r, overtimeEligibilityByRole: { ...r.overtimeEligibilityByRole, ...Object.fromEntries(jobTitles.filter((t) => !(t in r.overtimeEligibilityByRole)).map((t) => [t, true])) },
    }));
    if (!rulesHistory.some((r) => r.effectiveFrom <= month)) { notes.push(`${branch.name}: no ${country} pay rules are effective for ${month}.`); continue; }
    const dayOff = dayOffRows.filter((d) => d.branchId === branch.id).sort((a, b) => iso(a.effectiveFrom).localeCompare(iso(b.effectiveFrom))).at(-1) ?? null;
    const leavePolicy = leavePolicyFromCatalogue(country, leaveTypes.filter((t) => t.isActive), holidays, dayOff);
    const leavePolicyHistory: LeavePolicyVersion[] = [{ effectiveFrom: "1970-01-01", policy: leavePolicy, reason: "The park group's leave types (SCRUM-560)", who: "Leave types", when: "1970-01-01T00:00:00.000Z" }];
    world.branches[branch.id] = {
      id: branch.id, staff: [], detailsHistory, lifecycleHistory: [{ effectiveFrom: detailsHistory[0].effectiveFrom.slice(0, 7), openedOn: iso(versions[0].effectiveFrom), closedOn: null }],
      rulesHistory, incentiveRules: [], deductionRules: deductionRulesFor(lists, branch.id, month), employeeIncentivePlans: [], roleIncentiveDefaults: [],
      voucherSettings: { method: "percent", value: 0 }, leavePolicyHistory,
    } satisfies BranchRecord;
  }

  // ── People ──
  const roster = new Map<string, string>();
  for (const { profile: row, employee } of profileRows) {
    const p = profileOut(row, allocRows, advanceRows, paymentRows) as EmployeePayrollProfile;
    const name = getEmployeeDisplayName(employee);
    if (!p.joinedOn) { excluded.push({ employeeId: employee.id, name, reason: "No joining date on the payroll profile." }); continue; }
    if (p.joinedOn > monthEnd || (p.lastWorkingDay && p.lastWorkingDay < windowFrom)) continue;
    const anchor = p.lastWorkingDay && p.lastWorkingDay.startsWith(month) ? p.lastWorkingDay : monthEnd;
    const home = allocationAt(p, anchor)?.homeBranchId;
    if (!home) { excluded.push({ employeeId: employee.id, name, reason: `No allocation is effective on ${anchor}.` }); continue; }
    const branch = world.branches[home];
    if (!branch) { excluded.push({ employeeId: employee.id, name, reason: `Home branch ${names.get(home) ?? home} has no payroll details or rules for ${month}.` }); continue; }
    const weeklyOff = employee.weeklyOffDays ?? [];
    const staff: StaffMember = {
      id: employee.id, employeeNumber: employee.id, taxId: p.taxId, name, role: p.jobTitle,
      employmentType: "local", nationality: p.nationality ?? employee.nationality ?? "",
      monthlySalary: p.workerType === "day-rate" ? null : p.workerType === "contractor" ? p.fixedFee : p.monthlySalary,
      dayRate: p.workerType === "day-rate" ? p.dayRate : null,
      joinedOn: p.joinedOn, leftOn: p.lastWorkingDay, probationEndsOn: p.joinedOn,
      scheduledDaysPerWeek: Math.max(1, 7 - weeklyOff.length), otEligible: p.otEligible, serviceChargeEligible: p.serviceChargeEligible,
      serviceRoleWeight: 1, ewfMembership: null, statutoryIds: p.ssoNumber ? { ssoNumber: p.ssoNumber } : {},
      ...(p.department ? { department: p.department } : {}), payrollProfile: p,
    };
    branch.staff.push(staff);
    roster.set(employee.id, home);
  }
  const people = profileRows.filter((r) => roster.has(r.employee.id)).map((r) => ({
    id: r.employee.id, rosterBranchId: roster.get(r.employee.id)!, weeklyOffDays: r.employee.weeklyOffDays ?? [],
  }));

  // ── Attendance (two months: the service-charge earning month and this one) ──
  const timezones = new Map(branchRows.map((b) => [b.id, b.timezone]));
  const feed = await loadAttendanceFeed(tenantId, people, { from: windowFrom, to: monthEnd, today: options.today ?? parkToday(), timezones, defaultTimezone: "Asia/Bangkok" });
  queries += feed.queries;
  world.attendance = feed.days.map(({ workedAtBranchId: _shown, ...day }) => day);

  // ── Leave valuations, OT bookings, offboarding (payroll's own feeds) ──
  for (const { valuation: v, timeOffId } of valuationRows) {
    if (v.reversedAt || !roster.has(v.employeeId)) continue;
    if (v.source === "time-off" && !timeOffId) {
      notes.push(`A valued ${v.leaveTypeCode} leave of ${v.startsOn} no longer exists in HR time off; it is left out.`);
      continue;
    }
    const branchId = roster.get(v.employeeId)!, days = num(v.days), rate = num(v.dailyRate);
    const common = { branchId, staffId: v.employeeId, typeId: v.leaveTypeCode.toUpperCase(), source: (v.source === "exit" ? "offboarding" : "request") as LeaveLedgerEntry["source"],
      reason: v.reason, actor: v.decidedByName, createdAt: v.createdAt.toISOString(), rate, taxable: v.taxable, socialSecurity: v.socialSecurity, decidedBy: v.decidedByName };
    if (v.kind === "payout") {
      world.leaveLedger.push({ ...common, entryId: v.id, date: iso(v.startsOn), days: -days, kind: "Paid out" });
    } else {
      const dates = (v.dates ?? []).filter(Boolean);
      for (const date of dates) world.leaveLedger.push({ ...common, entryId: `${v.id}:${date}`, date, days: -(days / dates.length), kind: "Used", paidLeave: false });
    }
  }
  world.otBankBookings = bookingRows.filter((b) => roster.has(b.employeeId)).map((b): OtBankBooking => ({
    id: b.id, branchId: roster.get(b.employeeId)!, staffId: b.employeeId, date: iso(b.date), hours: num(b.hours), reason: b.reason, createdBy: b.actorName, createdAt: b.createdAt.toISOString(),
  }));
  world.leaveOffboarding = offboardingRows.filter((o) => roster.has(o.employeeId)).map((o): LeaveOffboardingRecord => ({
    branchId: roster.get(o.employeeId)!, staffId: o.employeeId, resignationDate: iso(o.resignationDate), lastWorkingDate: iso(o.lastWorkingDate),
    reason: o.reason, recordedBy: o.actorName, recordedAt: o.updatedAt.toISOString(),
  }));

  // ── The month's company document ──
  const servicePolicies: CompanyPayrollDocument["servicePolicies"] = {};
  for (const row of policyRows) {
    const policy: ServicePolicy = { ...(row.policy as ServicePolicy), effectiveFrom: iso(row.effectiveFrom), version: row.version, reason: row.reason, who: row.actorName, at: row.createdAt.toISOString(), ...(row.superseded ? { superseded: true } : {}) };
    (servicePolicies[row.branchId] ??= []).push(policy);
  }
  const incentiveVersions: IncentiveRuleVersion[] = versionRows.map((v) => ({
    ruleId: v.ruleId, version: v.version, terms: v.terms as CompanyIncentive, effectiveFrom: iso(v.effectiveFrom), effectiveTo: v.effectiveTo ? iso(v.effectiveTo) : null,
    who: v.actorName, reason: v.reason, at: v.at.toISOString(), ...(v.superseded ? { superseded: true } : {}),
  }));
  const incentiveAssignments: IncentiveAssignment[] = assignmentRows.map((a) => ({
    id: a.assignmentKey, ruleId: a.ruleId, staffId: a.employeeId ?? null,
    ...(a.jobTitle ? { jobTitle: a.jobTitle } : {}), ...(a.branches ? { branches: a.branches } : {}),
    effectiveFrom: iso(a.effectiveFrom), effectiveTo: a.effectiveTo ? iso(a.effectiveTo) : null,
    ...(a.personalRate != null ? { personalRate: num(a.personalRate) } : {}), ...(a.excluded ? { excluded: true } : {}),
    who: a.actorName, reason: a.reason, at: a.at.toISOString(), ...(a.superseded ? { superseded: true } : {}),
  }));
  const months: CompanyPayrollDocument["months"] = {};
  for (const row of inputRows) months[row.month] = structuredClone(row.inputs as CompanyMonthInputs);
  const runs: CompanyPayrollDocument["runs"] = {};
  const runRefs = new Map<string, RunRef>();
  for (const { run, version } of runRows) {
    const attendance: Record<string, AttendanceReview> = {};
    for (const r of reviewRows.filter((x) => x.runVersionId === version.id)) {
      attendance[r.attendanceDayKey] = { action: r.action, reason: r.reason, who: r.actorName, at: r.updatedAt.toISOString(),
        ...(r.clockIn ? { clockIn: r.clockIn } : {}), ...(r.clockOut ? { clockOut: r.clockOut } : {}) };
    }
    const draft: CompanyDraft = {
      entityId: run.entityId, month, version: version.version, payDate: iso(run.payDate),
      stage: version.stage as CompanyDraft["stage"], status: (version.status === "superseded" ? "draft" : version.status) as CompanyDraft["status"],
      attendance,
      overrides: overrideRows.filter((o) => o.runVersionId === version.id).map((o) => ({ staffId: o.employeeId, entityId: o.entityId, component: o.component, amount: num(o.amount), reason: o.reason })),
      manual: manualRows.filter((m) => m.runVersionId === version.id).map((m) => ({ id: m.id, staffId: m.employeeId, amount: num(m.amount), kind: m.kind, reason: m.reason })),
      thirdPartyApprovals: Object.fromEntries(approvalRows.filter((a) => a.runVersionId === version.id).map((a) => [a.employeeId,
        { signature: a.signature, reason: a.reason, who: a.actorName, at: a.updatedAt.toISOString() }])),
      audit: [],
      ...(version.approvedSignature ? { approvedSignature: version.approvedSignature } : {}),
    };
    runs[`${run.entityId}:${month}`] = draft;
    // The older per-branch draft is where the engine reads overtime decisions
    // (company-calculations.ts:72, run-calculations.ts:772): one per roster
    // branch and month, as the prototype kept them (data.runDrafts).
    for (const o of overtimeRows.filter((x) => x.runVersionId === version.id)) {
      const branchId = roster.get(o.employeeId);
      if (!branchId) continue;
      const legacy = (world.runDrafts[`${branchId}:${month}`] ??= { overtimeDecisions: [] } as unknown as RunDraft);
      (legacy.overtimeDecisions ??= []).push({ attendanceId: o.attendanceDayKey, exceptionIndex: o.exceptionIndex, outcome: o.outcome, reason: o.reason,
        resolvedBy: o.actorName, resolvedAt: o.createdAt.toISOString(), ...(o.employeeChoiceConfirmed ? { employeeChoiceConfirmed: true } : {}) } satisfies OvertimeDecision);
    }
    runRefs.set(run.entityId, { runId: run.id, versionId: version.id, version: version.version, status: version.status, payDate: iso(run.payDate),
      stage: version.stage, approvedSignature: version.approvedSignature, reopenReason: version.reopenReason });
  }
  const doc: CompanyPayrollDocument = {
    version: 1, rewardsVersion: 1, servicePolicies,
    incentives: ruleDefRows.map((r) => ({ ...(r.terms as CompanyIncentive), staffIds: (r.terms as Partial<CompanyIncentive>).staffIds ?? [], id: r.id, enabled: r.enabled })),
    incentiveVersions, incentiveAssignments, months, runs,
    // R4: earlier months' locked versions, as the prototype's doc.snapshots.
    // The engine reads their results only (advances repaid, YTD; it keeps the
    // latest version of each entity and month itself); the rest stays frozen
    // in payroll_run_snapshots and is never needed to calculate a later month.
    snapshots: snapshotRows.map((s) => ({ entityId: s.entityId, month: s.month, version: s.version, lockedAt: s.lockedAt.toISOString(), lockedBy: s.lockedByName,
      gmActor: s.gmActor, result: s.result as CompanyResult } as CompanySnapshot)),
    audit: [],
  };
  world.companyPayroll = doc;
  return { tenantId, month, world, doc, excluded, notes, runs: runRefs, attendance: feed.days, queries };
}

/** Canonical JSON: keys sorted; arrays of rows sorted by id/key (plan §1). */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(norm);
      const sortKey = (x: unknown) => x && typeof x === "object" && !Array.isArray(x)
        ? String((x as Record<string, unknown>).id ?? (x as Record<string, unknown>).entryId ?? (x as Record<string, unknown>).key ?? "") : "";
      return items.every((x) => sortKey(x)) ? [...items].sort((a, b) => sortKey(a).localeCompare(sortKey(b))) : items;
    }
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/**
 * The server's source signature (plan §1): sha256 over canonical JSON of
 * everything the engine saw for this month, plus ENGINE_REVISION. No number
 * depends on it; R4's GM confirm stores it and Owner lock recomputes it.
 */
export function sourceSignature(loaded: Pick<LoadedWorld, "world" | "doc" | "month">, engineRevision: string = ENGINE_REVISION): string {
  const { world, doc, month } = loaded;
  const prev = previousMonth(month);
  const source = {
    engine: engineRevision,
    branches: Object.values(world.branches).map((b) => ({ id: b.id, staff: b.staff, details: b.detailsHistory, rules: b.rulesHistory, deductions: b.deductionRules, leave: b.leavePolicyHistory })),
    entities: world.payingEntities, accounts: world.payingAccounts, ewf: world.ewfSettings, remittances: world.ewfRemittances,
    leaveLedger: world.leaveLedger, otBankBookings: world.otBankBookings, offboarding: world.leaveOffboarding,
    attendance: world.attendance.filter((d) => d.date.startsWith(month) || d.date.startsWith(prev)),
    policies: doc.servicePolicies, incentives: doc.incentives, versions: doc.incentiveVersions, assignments: doc.incentiveAssignments,
    months: [doc.months[month] ?? null, doc.months[prev] ?? null],
    runs: Object.values(doc.runs).map((r) => ({ id: `${r.entityId}:${r.month}`, payDate: r.payDate, attendance: r.attendance, overrides: r.overrides, manual: r.manual, thirdPartyApprovals: r.thirdPartyApprovals })),
    overtimeDecisions: Object.entries(world.runDrafts).filter(([key]) => key.endsWith(`:${month}`))
      .map(([key, r]) => ({ id: key, decisions: (r.overtimeDecisions ?? []).map((d) => ({ ...d, id: `${d.attendanceId}:${d.exceptionIndex}` })) })),
    history: doc.snapshots.filter((s) => s.month < month).map((s) => ({ id: `${s.entityId}:${s.month}:${s.version}`,
      people: s.result.people.map((p) => ({ id: p.id, gross: p.gross, deductions: p.deductions, net: p.net })) })),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(source)).digest("hex")}`;
}

