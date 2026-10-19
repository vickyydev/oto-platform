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
 * THE R1 SEAM. The engine port (server/payroll/engine, a parallel lane) ports
 * payroll-profile.ts and model.ts whole. Nothing here imports from it, and it
 * imports nothing from here. When both have landed, the world loader (R3) maps
 * these stored shapes onto the engine's `PayrollWorld`, and the duplicated
 * checks below are pointed at the engine's copy in that commit.
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

/** Casual workers are outside this payroll (owner, 2026-10-20); there is no casual worker type. */
export type WorkerType = "monthly" | "day-rate" | "contractor" | "owner-household";
export type PaymentMethod = "bank-transfer" | "cash" | "third-party";
export interface AllocationLine { costCentre: string; percent: number; entityId: string; payingAccountId: string | null }
export interface AllocationVersion { effectiveFrom: string; homeBranchId: string; lines: AllocationLine[] }
export interface SalaryAdvanceProfile {
  id: string; principal: number; outstandingBalance: number; repaymentMode: "one-off" | "instalments";
  instalments: number; monthlyRepayment: number; startsOn: string;
}
export interface SeparatePayment { id: string; description: string; amount: number; withholdingPercent: number }
export interface EmployeePayrollProfile {
  linkedEmployeeId?: string | null;
  department?: string;
  workerType: WorkerType; jobTitle: string; monthlySalary: number; dayRate: number; fixedFee: number;
  joinedOn: string; lastWorkingDay: string | null; taxId: string; ssoNumber: string;
  ssoTitle?: string; givenName?: string; surname?: string;
  dateOfBirth?: string; nationality?: string; passportNumber?: string; leavingReason?: string;
  foodAllowanceEligible: boolean; foodAllowancePerDay: number; ssoEligible: boolean;
  pnd1Eligible: boolean; serviceChargeEligible: boolean; otEligible: boolean;
  pnd3WithholdingPercent: number; cashHandlingFeePercent: number;
  paymentMethod: PaymentMethod; bankDetails: BankDetails; thirdPartyReason: string;
  allocations: AllocationVersion[]; studentLoanMonthly: number; advances: SalaryAdvanceProfile[];
  separatePayments: SeparatePayment[]; notes: string;
}

export const WORKER_DEFAULTS = {
  monthly: { ssoEligible: true, pnd1Eligible: true, foodAllowanceEligible: true, serviceChargeEligible: true, otEligible: true, pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0 },
  "day-rate": { ssoEligible: false, pnd1Eligible: true, foodAllowanceEligible: true, serviceChargeEligible: false, otEligible: true, pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0 },
  contractor: { ssoEligible: false, pnd1Eligible: false, foodAllowanceEligible: false, serviceChargeEligible: false, otEligible: false, pnd3WithholdingPercent: 3, cashHandlingFeePercent: 0 },
  "owner-household": { ssoEligible: true, pnd1Eligible: true, foodAllowanceEligible: false, serviceChargeEligible: false, otEligible: false, pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0 },
} satisfies Record<WorkerType, object>;

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

export function allocationAt(profile: Pick<EmployeePayrollProfile, "allocations">, date: string): AllocationVersion | null {
  return [...profile.allocations].filter((item) => item.effectiveFrom <= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

export function resolvePayingAccount(ctx: ProfileCheckContext, line: AllocationLine, date: string): PayingAccount | undefined {
  const defaultId = line.costCentre === OWNER_NON_OPERATIONAL ? undefined
    : [...(ctx.branches[line.costCentre]?.detailsHistory ?? [])].filter((item) => item.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.defaultPayingAccountId;
  return ctx.accounts.find((account) => account.id === (line.payingAccountId ?? defaultId) && account.entityId === line.entityId);
}

const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const nonNegative = (value: number) => Number.isFinite(value) && value >= 0;

/** The prototype's validatePayrollProfile, word for word, against this park group's setup. */
export function validatePayrollProfile(profile: EmployeePayrollProfile, ctx: ProfileCheckContext): string[] {
  const errors: string[] = [];
  const branchCountry = (id: string) => ctx.branches[id]?.country;
  if (profile.linkedEmployeeId != null && (typeof profile.linkedEmployeeId !== "string" || !profile.linkedEmployeeId.trim())) {
    errors.push("The HR employee link must be a non-empty employee ID.");
  }
  if (!(profile.workerType in WORKER_DEFAULTS)) errors.push("Choose a valid worker type.");
  if (!profile.jobTitle.trim()) errors.push("Job title is required.");
  if (!validDate(profile.joinedOn) || (profile.lastWorkingDay !== null &&
    (!validDate(profile.lastWorkingDay) || profile.lastWorkingDay < profile.joinedOn))) errors.push("Employment dates are invalid.");
  if (profile.dateOfBirth && (!validDate(profile.dateOfBirth) || profile.dateOfBirth > profile.joinedOn)) errors.push("Enter a valid date of birth before employment started.");
  for (const key of ["monthlySalary", "dayRate", "fixedFee", "foodAllowancePerDay", "studentLoanMonthly"] as const) {
    if (!nonNegative(profile[key])) errors.push(`${key} must be a non-negative amount.`);
  }
  for (const key of ["pnd3WithholdingPercent", "cashHandlingFeePercent"] as const) {
    if (!nonNegative(profile[key]) || profile[key] > 100) errors.push(`${key} must be between 0 and 100%.`);
  }
  for (const key of ["foodAllowanceEligible", "ssoEligible", "pnd1Eligible", "serviceChargeEligible", "otEligible"] as const) {
    if (typeof profile[key] !== "boolean") errors.push(`${key} must be a yes/no flag.`);
  }
  if (!["bank-transfer", "cash", "third-party"].includes(profile.paymentMethod)) errors.push("Invalid payment method.");
  if (profile.paymentMethod !== "cash" && (!profile.bankDetails.bank.trim() ||
    !profile.bankDetails.accountNumber.trim() || !profile.bankDetails.accountName.trim())) errors.push("Transfer bank, account number and account name are required.");
  if (profile.paymentMethod === "third-party" && !profile.thirdPartyReason.trim()) errors.push("A third-party transfer reason is mandatory.");
  if (!profile.allocations.length) errors.push("At least one allocation version is required.");
  if (new Set(profile.allocations.map((item) => item.effectiveFrom)).size !== profile.allocations.length) errors.push("Allocation effective dates must be unique.");
  for (const version of profile.allocations) {
    if (!validDate(version.effectiveFrom) || !(version.homeBranchId in ctx.branches)) errors.push("Allocation date/home branch is invalid.");
    if (!version.lines.length || Math.abs(version.lines.reduce((sum, item) => sum + item.percent, 0) - 100) > 0.001) errors.push(`Allocation on ${version.effectiveFrom} must total 100%.`);
    const seen = new Set<string>();
    for (const line of version.lines) {
      if ((line.costCentre !== OWNER_NON_OPERATIONAL && !(line.costCentre in ctx.branches)) ||
        !Number.isFinite(line.percent) || line.percent <= 0 || line.percent > 100) errors.push("Allocation cost centre/percentage is invalid.");
      const entity = ctx.entities.find((item) => item.id === line.entityId);
      if (!entity) errors.push("Choose an entity for every allocation line.");
      if (entity && ctx.branches[version.homeBranchId] &&
        entity.country !== branchCountry(version.homeBranchId)) errors.push("Allocation entity must use the registered branch's country.");
      if (line.costCentre !== OWNER_NON_OPERATIONAL && ctx.branches[line.costCentre] &&
        branchCountry(line.costCentre) !== entity?.country) errors.push("Cross-country cost allocation is not supported.");
      const key = `${line.costCentre}:${line.entityId}`;
      if (seen.has(key)) errors.push("Duplicate allocation cost centre/entity.");
      seen.add(key);
      if ((line.payingAccountId || ctx.accounts.length) &&
        (line.costCentre === OWNER_NON_OPERATIONAL
          ? !ctx.accounts.some((account) => account.id === line.payingAccountId && account.entityId === line.entityId)
          : !resolvePayingAccount(ctx, line, version.effectiveFrom))) errors.push("Allocation paying account must belong to its entity; choose an override if the branch default does not.");
    }
  }
  if (new Set(profile.advances.map((item) => item.id)).size !== profile.advances.length ||
    new Set(profile.separatePayments.map((item) => item.id)).size !== profile.separatePayments.length) errors.push("Recurring item IDs must be unique.");
  for (const advance of profile.advances) {
    if (!advance.id || !nonNegative(advance.principal) || !nonNegative(advance.outstandingBalance) ||
      advance.outstandingBalance > advance.principal || !["one-off", "instalments"].includes(advance.repaymentMode) ||
      !Number.isInteger(advance.instalments) || advance.instalments < 1 ||
      !nonNegative(advance.monthlyRepayment) || !validDate(advance.startsOn)) errors.push("Salary advance amounts, repayment schedule or start date are invalid.");
  }
  for (const payment of profile.separatePayments) {
    if (!payment.id || !payment.description.trim() || !nonNegative(payment.amount) ||
      !nonNegative(payment.withholdingPercent) || payment.withholdingPercent > 100) errors.push("Separate payment description, amount or withholding is invalid.");
  }
  return Array.from(new Set(errors));
}

/** The prototype's profileReviewWarnings; `others` are the park group's other profiles. */
export function profileReviewWarnings(profile: EmployeePayrollProfile | null, employeeId: string,
  others: { employeeId: string; name: string; profile: EmployeePayrollProfile }[]): string[] {
  if (!profile) return ["No payroll profile yet."];
  const warnings: string[] = [];
  if (profile.paymentMethod === "third-party") warnings.push(`Third-party transfer: ${profile.thirdPartyReason || "REASON MISSING"}`);
  if (!profile.taxId.trim()) warnings.push("Missing tax ID");
  if (profile.paymentMethod !== "cash") {
    if (!profile.bankDetails.accountNumber.trim()) warnings.push("Missing bank account");
    else {
      const number = profile.bankDetails.accountNumber.replace(/[\s-]/g, "");
      const duplicates = others.filter((other) =>
        other.employeeId !== employeeId && other.profile.paymentMethod !== "cash" &&
        other.profile.bankDetails.bank.toLowerCase() === profile.bankDetails.bank.toLowerCase() &&
        other.profile.bankDetails.accountNumber.replace(/[\s-]/g, "") === number);
      if (duplicates.length) warnings.push(`Duplicate bank account with ${duplicates.map((item) => item.name).join(", ")}`);
    }
  }
  return warnings;
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
