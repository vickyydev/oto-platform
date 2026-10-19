/**
 * The company payroll's configuration and profile shapes (SCRUM-567, R2), and
 * the prototype's own checks on them, shared by the server and the screens.
 *
 * Ported from the prototype (imports/oto-app/client/src/lib/payroll-prototype/
 * payroll-profile.ts, staff-profile.ts and model.ts) with the plan's type
 * changes: a branch id is our branch id (a string), a role is a string, and a
 * paying entity or account id is our row id. The checks keep the prototype's
 * words.
 *
 * The profile types and checks are the engine's own (server/payroll/engine/
 * payroll-profile.ts): R3 (SCRUM-568) pointed them there, so one copy of the
 * prototype's rules judges a profile everywhere. The configuration types stay
 * here: they are this app's API shapes (ids, archive dates, pay day), which
 * the world loader (server/payroll/world.ts) maps onto the engine's world.
 */
import { canPerformAction, type PermissionRole } from "./permissions";
import { canViewHrSalary } from "./hr-salary-permission";

// ─── Permissions ─────────────────────────────────────────────────────────────

export const HR_MANAGE_PAYROLL_ACTION = "hr.manage_payroll";

/**
 * Who may change payroll setup and profiles: `hr.manage_payroll`, an
 * admin-only action, so admin, operator_admin and global_admin (plan §7).
 * Decided by the permission engine on the effective role, like
 * canViewHrSalary, never by a raw role string.
 */
export function canManagePayroll(role: string | null | undefined): boolean {
  if (!role || !canViewHrSalary(role)) return false;
  return canPerformAction(
    { userId: "", role: role as PermissionRole, homeBranchId: null, overrides: [] },
    HR_MANAGE_PAYROLL_ACTION,
    "hr",
  ).allowed;
}

export const PAYROLL_CONFIRM_ACTION = "payroll.confirm";
export const PAYROLL_LOCK_ACTION = "payroll.lock";

const payrollAction = (role: string | null | undefined, action: string) => {
  if (!role || !canViewHrSalary(role)) return false;
  return canPerformAction({ userId: "", role: role as PermissionRole, homeBranchId: null, overrides: [] }, action, "hr").allowed;
};

/** GM confirmation (SCRUM-569; owner ruling 2026-10-20): admin, operator_admin, global_admin. */
export function canConfirmPayroll(role: string | null | undefined): boolean {
  return payrollAction(role, PAYROLL_CONFIRM_ACTION);
}

/** Owner lock, reopen and mark paid (SCRUM-569; owner ruling 2026-10-20): operator_admin and global_admin only. */
export function canLockPayroll(role: string | null | undefined): boolean {
  return payrollAction(role, PAYROLL_LOCK_ACTION);
}

/** Proposing draft profiles from HR data reads every employee's pay once: global_admin (plan §9 R2). */
export function canDraftPayrollProfiles(role: string | null | undefined): boolean {
  return role === "global_admin" && canManagePayroll(role);
}

// ─── Configuration ───────────────────────────────────────────────────────────

export type CountryCode = "TH" | "MY";
export type BankFileFormat = "SCB" | "KBANK" | "BBL" | "GENERIC";
export const BANK_FILE_FORMATS: BankFileFormat[] = ["SCB", "KBANK", "BBL", "GENERIC"];
/** The literal cost centre for work outside the branches (prototype CostCentre). */
export const OWNER_NON_OPERATIONAL = "owner-non-operational";
export const OWNER_NON_OPERATIONAL_LABEL = "Owner – non-operational";

export interface PayingEntity {
  id: string; name: string; country: CountryCode; taxId?: string; ssoEmployerNumber?: string;
  operatorId: string | null; defaultPayDay: number; archivedAt: string | null;
}
export interface BankDetails { bank: string; accountNumber: string; accountName: string; bankCode?: string; mobile?: string; email?: string }
export interface PayingAccount extends BankDetails {
  id: string; entityId: string; label: string; fileFormat: BankFileFormat;
  debitAccount?: string; feeAccount?: string; scbProduct?: "PAY" | "SPN"; archivedAt: string | null;
}

/** The prototype's BranchDetails, with our ids. `approvalChain` is always GM then Owner. */
export interface BranchDetails {
  ssoBranchNumber?: string;
  payingEntityId?: string;
  defaultPayingAccountId?: string;
  name: string;
  legalEntity: string;
  employerNumber: string;
  taxId: string;
  address: string;
  country: CountryCode;
  currency: "THB" | "MYR";
  timezone: string;
  payDate: "last" | number;
  payrollBank: string;
  approvalChain: ["GM", "Owner"];
}
export interface DatedBranchDetails {
  id: string; effectiveFrom: string; details: BranchDetails; foodAllowanceDefault: number | null;
  reason: string; who: string; at: string;
}

export interface TaxBracket { from: number; to: number | null; rate: number }
export interface ComponentFlags { taxable: boolean; socialSecurity: boolean; ewfWage?: boolean; ewfReason?: string }
export interface FixedAllowance extends ComponentFlags { id: string; name: string; amount: number }
export interface OvertimePolicy {
  handlingMode: "pay-only" | "time-off-only" | "employee-chooses" | "manager-decides";
  requirePreapprovalOrSchedule: boolean;
  minimumBlockMinutes: number;
  roundingMinutes: number;
  bankConversionRate: number;
  bankMaximumHours: number;
  bankExpiryMonths: number;
  bankExpiryAction: "payout" | "forfeit";
  bankUseUnit: "hours" | "half-days";
  monthlyCapHours: number;
  positionOverrides?: Record<string, Partial<Omit<OvertimePolicy, "positionOverrides">>>;
}
/** The prototype's StatutoryRules (model.ts), stored as is in a company-v1 rule set. */
export interface StatutoryRules {
  effectiveFrom: string;
  country: CountryCode;
  thSso: { wageCap: number; employeeRate: number; employerRate: number; wholeBahtRounding: "half-up" };
  thPit: { brackets: TaxBracket[]; employmentExpenseRate: number; employmentExpenseCap: number; personalAllowance: number };
  my: Record<string, number | boolean | TaxBracket[]>;
  serviceCharge: {
    rate: number; revenueStreams: string[]; payoutLagMonths: number; allocation: string; minimumDays: number;
    probationRequired: boolean; includeCasuals: boolean; roleWeights: Record<string, number>; customPercentByStaffId: Record<string, number>;
  };
  lunchByRole: Record<string, number>;
  overtimeMultipliers: { regular: number; restDay: number; publicHoliday: number };
  overtimePolicy?: OvertimePolicy;
  overtimeEligibilityByRole: Record<string, boolean>;
  hourlyBase: { monthlySalaryDays: number; monthlyHoursPerDay: number; casualDayHours: number };
  calendarProration: { method: "actual-calendar-days" | "fixed-divisor"; divisor: number };
  allowances: FixedAllowance[];
  componentFlags: Record<string, ComponentFlags>;
}
export interface RuleSetVersion {
  id: string; country: CountryCode; branchId: string | null; effectiveFrom: string; rules: StatutoryRules;
  name: string; reason: string; who: string; at: string;
}

export type DeductionIssue = "late" | "early-departure" | "missed-punch" | "no-show" | "break-overrun";
export interface DeductionRule {
  id: string; name: string; enabled: boolean; issue: DeductionIssue;
  freeOccurrences: number | null; freeMinutes: number | null;
  method: "fixed" | "per-minute" | "percent"; amount: number;
  source: "service-charge" | "salary"; cap: number | null;
  roles: string[]; jobTitles?: string[]; includeStaffIds: string[]; excludeStaffIds: string[];
}
export interface DeductionListVersion {
  id: string; scope: "company" | "branch"; branchId: string | null; effectiveFrom: string;
  rules: DeductionRule[]; reason: string; who: string; at: string;
}

export interface EwfSettings {
  employeeRate: number; employerRate: number; headcountThreshold: number;
  providentFundAvailable: boolean; voluntaryBelowThreshold: boolean;
}
export interface EwfSettingsVersion { id: string; entityId: string; effectiveFrom: string; settings: EwfSettings; reason: string; who: string; at: string }
export interface EwfRemittance { id: string; entityId: string; month: string; amountPaid: number; paidOn: string | null; reason: string; who: string; at: string }
export interface RevenueStream { id: string; key: string; label: string; archivedAt: string | null }

/**
 * The rulebook's Thai attendance tariffs (rulebook §6; the prototype's
 * createDefaultDeductionRules("TH"), without the prototype's demo role list:
 * no role or job title is assigned, so a rule charges nobody until an
 * administrator picks the job titles it applies to). Offered in the deductions
 * editor as a starting list; nothing is charged from it until an administrator
 * saves it with a date and a reason.
 */
export function rulebookThaiDeductionRules(): DeductionRule[] {
  const open = { roles: [] as string[], jobTitles: [] as string[], includeStaffIds: [] as string[], excludeStaffIds: [] as string[] };
  return [
    ...(["late", "early-departure"] as const).map((issue) => ({
      id: issue, name: issue === "late" ? "Late arrival" : "Early departure", enabled: true, issue,
      freeOccurrences: 3, freeMinutes: 30, method: "fixed" as const, amount: 100,
      source: "service-charge" as const, cap: 1000, ...open,
    })),
    { id: "no-show", name: "No-show", enabled: true, issue: "no-show", freeOccurrences: 0, freeMinutes: null,
      method: "fixed", amount: 300, source: "service-charge", cap: null, ...open },
    { id: "missed-punch", name: "Missed punch", enabled: true, issue: "missed-punch", freeOccurrences: 2, freeMinutes: null,
      method: "fixed", amount: 50, source: "service-charge", cap: null, ...open },
  ];
}

/** The rulebook's welfare fund rates (rulebook §7). The start date is never assumed. */
export const RULEBOOK_EWF_SETTINGS: EwfSettings = {
  employeeRate: 0.0025, employerRate: 0.0025, headcountThreshold: 10,
  providentFundAvailable: false, voluntaryBelowThreshold: false,
};

// ─── Profiles ────────────────────────────────────────────────────────────────

/**
 * THE R2 SEAM, CLOSED IN R3 (SCRUM-568). The profile types and checks below
 * ARE the engine's (server/payroll/engine/payroll-profile.ts, ported from the
 * prototype): the types are re-exported and the checks call the engine's
 * functions on a world built from this park group's setup, so the screens,
 * the profile save and the month-end engine judge a profile with one copy of
 * the prototype's words. Casual workers are outside this payroll (owner,
 * 2026-10-20); there is no casual worker type.
 */
export type {
  AllocationLine, AllocationVersion, EmployeePayrollProfile, PaymentMethod, SalaryAdvanceProfile, SeparatePayment, WorkerType,
} from "../server/payroll/engine/payroll-profile";
import {
  WORKER_DEFAULTS as ENGINE_WORKER_DEFAULTS,
  allocationAt as engineAllocationAt,
  profileReviewWarnings as engineProfileReviewWarnings,
  resolvePayingAccount as engineResolvePayingAccount,
  validatePayrollProfile as engineValidatePayrollProfile,
  type AllocationLine, type AllocationVersion, type EmployeePayrollProfile, type WorkerType,
} from "../server/payroll/engine/payroll-profile";
import type { PayrollWorld } from "../server/payroll/engine/model";

export const WORKER_DEFAULTS = ENGINE_WORKER_DEFAULTS;

export const WORKER_LABELS: Record<WorkerType, string> = {
  monthly: "Monthly", "day-rate": "Day rate", contractor: "Contractor", "owner-household": "Owner household",
};

/** What the profile checks need to know about this park group's setup. */
export interface ProfileCheckContext {
  /** Branches with payroll details, by id: their country and their dated default paying account. */
  branches: Record<string, { country: CountryCode; detailsHistory: { effectiveFrom: string; defaultPayingAccountId?: string }[] }>;
  entities: PayingEntity[];
  accounts: PayingAccount[];
}

/** The engine's view of a check context: the branches' first-version country and dated defaults, the entities and accounts. */
function checkWorld(ctx: ProfileCheckContext, staff: { id: string; name: string; profile: EmployeePayrollProfile }[] = []): PayrollWorld {
  const branches = Object.fromEntries(Object.entries(ctx.branches).map(([id, branch]) => [id, {
    id, staff: [],
    detailsHistory: branch.detailsHistory.map((v) => ({ effectiveFrom: v.effectiveFrom, details: { country: branch.country, defaultPayingAccountId: v.defaultPayingAccountId } })),
  }]));
  const world = { schemaVersion: 14, branches, payingEntities: ctx.entities, payingAccounts: ctx.accounts } as unknown as PayrollWorld;
  if (staff.length) {
    const holder = { id: "", staff: staff.map((s) => ({ id: s.id, name: s.name, payrollProfile: s.profile })) };
    (world.branches as Record<string, unknown>)[""] = holder;
  }
  return world;
}

export function allocationAt(profile: Pick<EmployeePayrollProfile, "allocations">, date: string): AllocationVersion | null {
  return engineAllocationAt(profile as EmployeePayrollProfile, date);
}

export function resolvePayingAccount(ctx: ProfileCheckContext, line: AllocationLine, date: string): PayingAccount | undefined {
  const found = engineResolvePayingAccount(checkWorld(ctx), line, date);
  return found ? ctx.accounts.find((account) => account.id === found.id) : undefined;
}

/** The prototype's validatePayrollProfile — the engine's own — against this park group's setup. */
export function validatePayrollProfile(profile: EmployeePayrollProfile, ctx: ProfileCheckContext): string[] {
  return engineValidatePayrollProfile(profile, checkWorld(ctx));
}

/** The prototype's profileReviewWarnings (the engine's); `others` are the park group's other profiles. */
export function profileReviewWarnings(profile: EmployeePayrollProfile | null, employeeId: string,
  others: { employeeId: string; name: string; profile: EmployeePayrollProfile }[]): string[] {
  if (!profile) return ["No payroll profile yet."];
  const ctx: ProfileCheckContext = { branches: {}, entities: [], accounts: [] };
  const world = checkWorld(ctx, others.filter((o) => o.employeeId !== employeeId).map((o) => ({ id: o.employeeId, name: o.name, profile: o.profile })));
  return engineProfileReviewWarnings(world, { id: employeeId, name: "", payrollProfile: profile } as Parameters<typeof engineProfileReviewWarnings>[1]);
}

export interface PayrollReadiness { ready: boolean; checks: { key: string; label: string; ok: boolean }[]; status: string }

/** The prototype's getPayrollReadiness (staff-profile.ts). */
export function getPayrollReadiness(profile: EmployeePayrollProfile, asOf: string, branchCountry: string = "TH"): PayrollReadiness {
  const allocation = allocationAt(profile, asOf);
  const bankRequired = profile.paymentMethod !== "cash";
  const checks = [
    { key: "tax", label: "Tax ID", ok: !!profile.taxId.trim() },
    { key: "bank", label: bankRequired ? "Bank account" : "Bank account — cash payment", ok: !bankRequired ||
      !!(profile.bankDetails.bank.trim() && profile.bankDetails.accountNumber.trim() && profile.bankDetails.accountName.trim()) },
    { key: "sso", label: profile.ssoEligible && branchCountry !== "MY" ? "SSO number" : "SSO number — not required",
      ok: !(profile.ssoEligible && branchCountry !== "MY") || !!profile.ssoNumber.trim() },
    { key: "split", label: "Work split totals 100%", ok: !!allocation && allocation.lines.length > 0 &&
      allocation.lines.every((line) => Number.isFinite(line.percent) && line.percent > 0) &&
      Math.abs(allocation.lines.reduce((sum, line) => sum + line.percent, 0) - 100) < 0.001 },
    { key: "payee", label: profile.paymentMethod === "third-party" ? "Paid to someone else — review required" : "Paid directly",
      ok: profile.paymentMethod !== "third-party" },
  ];
  const ready = checks.every((check) => check.ok);
  const status = profile.paymentMethod === "third-party" ? "Paid to someone else" :
    !checks[0].ok ? "Missing tax ID" : !checks[1].ok ? "No bank account" :
      !checks[2].ok ? "Missing SSO number" : !checks[3].ok ? "Check work split" : "Ready";
  return { ready, checks, status };
}

// ─── API shapes ──────────────────────────────────────────────────────────────

export interface PayrollSetupBranch {
  id: string; name: string; timezone: string;
  detailsHistory: DatedBranchDetails[];
}
export interface PayrollSetupChange {
  id: string; kind: "profile" | "profile-draft" | "setup"; subject: string; subjectId: string | null;
  reason: string; who: string; at: string; oldValue: unknown; newValue: unknown;
}
export interface PayrollSetupView {
  entities: PayingEntity[];
  accounts: PayingAccount[];
  branches: PayrollSetupBranch[];
  ruleSets: RuleSetVersion[];
  deductionLists: DeductionListVersion[];
  ewfSettings: EwfSettingsVersion[];
  ewfRemittances: EwfRemittance[];
  revenueStreams: RevenueStream[];
  canManage: boolean;
}

/** One proposal read from HR data: never applied until a payroll role saves it. */
export interface ProfileSuggestion { field: string; label: string; value: string | number | null; source: string }

export interface PayrollRosterRow {
  employeeId: string; name: string; branchId: string | null; branchName: string | null; department: string | null;
  employmentState: string; hasProfile: boolean; reviewState: "needs-review" | "reviewed" | null;
  workerType: WorkerType | null; jobTitle: string; payLine: string | null;
  homeBranchId: string | null; allocationBadge: string | null; lines: AllocationLine[];
  readiness: PayrollReadiness | null; warnings: string[]; validationErrors: number;
}
export interface PayrollRosterView { asOf: string; rows: PayrollRosterRow[]; branches: { id: string; name: string }[]; canManage: boolean; canDraft: boolean }

export interface PayrollProfileView {
  employee: { id: string; name: string; branchId: string | null; branchName: string | null; employmentState: string; startDate: string | null };
  profile: EmployeePayrollProfile | null;
  reviewState: "needs-review" | "reviewed" | null;
  revision: number;
  suggestions: ProfileSuggestion[];
  validationErrors: string[];
  warnings: string[];
  readiness: PayrollReadiness | null;
  changes: PayrollSetupChange[];
  canManage: boolean;
}
