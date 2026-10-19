import type { BranchId, PayrollWorld, StaffMember } from "./model";

export type WorkerType = "monthly" | "day-rate" | "contractor" | "owner-household";
export type BankFileFormat = "SCB" | "KBANK" | "BBL" | "GENERIC";
export type PaymentMethod = "bank-transfer" | "cash" | "third-party";
export type CostCentre = BranchId | "owner-non-operational";
export interface BankDetails { bank: string; accountNumber: string; accountName: string; bankCode?: string; mobile?: string; email?: string }
export interface PayingEntity { id: string; name: string; country: "TH" | "MY"; taxId?: string; ssoEmployerNumber?: string }
export interface PayingAccount extends BankDetails {
  id: string; entityId: string; label: string; fileFormat: BankFileFormat;
  debitAccount?: string; feeAccount?: string; scbProduct?: "PAY" | "SPN"; valueDate?: string;
}
export interface AllocationLine {
  costCentre: CostCentre; percent: number; entityId: string; payingAccountId: string | null;
}
export interface AllocationVersion {
  effectiveFrom: string; homeBranchId: BranchId; lines: AllocationLine[];
}
export interface SalaryAdvanceProfile {
  id: string; principal: number; outstandingBalance: number; repaymentMode: "one-off" | "instalments";
  instalments: number; monthlyRepayment: number; startsOn: string;
}
export interface SeparatePayment {
  id: string; description: string; amount: number; withholdingPercent: number;
}
export interface EmployeePayrollProfile {
  /** Explicit HR employee identity in this browser only; never a name-based match. */
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
export interface ProfileSetupAudit {
  id: string; when: string; who: string; reason: string;
  kind: "profile" | "paying-accounts"; staffId?: string; oldValue: unknown; newValue: unknown;
}

export const WORKER_DEFAULTS = {
  monthly: { ssoEligible: true, pnd1Eligible: true, foodAllowanceEligible: true, serviceChargeEligible: true, otEligible: true, pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0 },
  "day-rate": { ssoEligible: false, pnd1Eligible: true, foodAllowanceEligible: true, serviceChargeEligible: false, otEligible: true, pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0 },
  contractor: { ssoEligible: false, pnd1Eligible: false, foodAllowanceEligible: false, serviceChargeEligible: false, otEligible: false, pnd3WithholdingPercent: 3, cashHandlingFeePercent: 0 },
  "owner-household": { ssoEligible: true, pnd1Eligible: true, foodAllowanceEligible: false, serviceChargeEligible: false, otEligible: false, pnd3WithholdingPercent: 0, cashHandlingFeePercent: 0 },
} satisfies Record<WorkerType, object>;

/**
 * A fresh profile for a person. The prototype chose the food allowance by
 * branch id (฿10 for the fictional KL branch, else ฿60; prototype :59); it is
 * now the branch payroll details' `food_allowance_default`, passed in.
 */
export function makePayrollProfile(staff: StaffMember, branchId: BranchId, entityId: string, foodAllowancePerDay: number): EmployeePayrollProfile {
  const workerType: WorkerType = staff.dayRate !== null ? "day-rate" : "monthly";
  return {
    workerType, jobTitle: staff.role, ...WORKER_DEFAULTS[workerType],
    monthlySalary: staff.monthlySalary ?? 0, dayRate: staff.dayRate ?? 0, fixedFee: 0,
    joinedOn: staff.joinedOn, lastWorkingDay: staff.leftOn, taxId: staff.taxId,
    ssoNumber: staff.statutoryIds?.ssoNumber ?? "", foodAllowancePerDay,
    serviceChargeEligible: staff.serviceChargeEligible, otEligible: staff.otEligible,
    paymentMethod: "bank-transfer", bankDetails: { bank: "", accountNumber: "", accountName: staff.name },
    thirdPartyReason: "", allocations: [{ effectiveFrom: "2025-01-01", homeBranchId: branchId,
      lines: [{ costCentre: branchId, percent: 100, entityId, payingAccountId: null }] }],
    studentLoanMonthly: 0, advances: [], separatePayments: [], notes: "",
  };
}

export function allocationAt(profile: EmployeePayrollProfile, date: string): AllocationVersion | null {
  return [...profile.allocations].filter((item) => item.effectiveFrom <= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

export function resolvePayingAccount(data: PayrollWorld, line: AllocationLine, date: string): PayingAccount | undefined {
  const defaultId = line.costCentre === "owner-non-operational" ? undefined
    : [...(data.branches[line.costCentre]?.detailsHistory ?? [])].filter((item) => item.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.details.defaultPayingAccountId;
  return data.payingAccounts?.find((account) => account.id === (line.payingAccountId ?? defaultId) && account.entityId === line.entityId);
}

const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const nonNegative = (value: number) => Number.isFinite(value) && value >= 0;
export function validatePayrollProfile(profile: EmployeePayrollProfile, data: PayrollWorld): string[] {
  const errors: string[] = [];
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
    if (!validDate(version.effectiveFrom) || !(version.homeBranchId in data.branches)) errors.push("Allocation date/home branch is invalid.");
    if (!version.lines.length || Math.abs(version.lines.reduce((sum, item) => sum + item.percent, 0) - 100) > 0.001) errors.push(`Allocation on ${version.effectiveFrom} must total 100%.`);
    const seen = new Set<string>();
    for (const line of version.lines) {
      if ((line.costCentre !== "owner-non-operational" && !(line.costCentre in data.branches)) ||
        !Number.isFinite(line.percent) || line.percent <= 0 || line.percent > 100) errors.push("Allocation cost centre/percentage is invalid.");
      const entity = data.payingEntities?.find((item) => item.id === line.entityId);
      if (!entity) errors.push("Choose an entity for every allocation line.");
      if (entity && data.branches[version.homeBranchId] &&
        entity.country !== data.branches[version.homeBranchId].detailsHistory[0].details.country) errors.push("Allocation entity must use the registered branch's country.");
      if (line.costCentre !== "owner-non-operational" && data.branches[line.costCentre] &&
        data.branches[line.costCentre].detailsHistory[0].details.country !== entity?.country) errors.push("Cross-country cost allocation is not supported.");
      const key = `${line.costCentre}:${line.entityId}`;
      if (seen.has(key)) errors.push("Duplicate allocation cost centre/entity.");
      seen.add(key);
      if ((line.payingAccountId || data.payingAccounts?.length) &&
        (line.costCentre === "owner-non-operational"
          ? !data.payingAccounts?.some((account) => account.id === line.payingAccountId && account.entityId === line.entityId)
          : !resolvePayingAccount(data, line, version.effectiveFrom))) errors.push("Allocation paying account must belong to its entity; choose an override if the branch default does not.");
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

export function profileReviewWarnings(data: PayrollWorld, staff: StaffMember): string[] {
  const profile = staff.payrollProfile;
  if (!profile) return ["Legacy profile — Phase 1 payroll settings have not been added."];
  const warnings: string[] = [];
  if (profile.paymentMethod === "third-party") warnings.push(`Third-party transfer: ${profile.thirdPartyReason || "REASON MISSING"}`);
  if (!profile.taxId.trim()) warnings.push("Missing tax ID");
  if (profile.paymentMethod !== "cash") {
    if (!profile.bankDetails.accountNumber.trim()) warnings.push("Missing bank account");
    else {
      const number = profile.bankDetails.accountNumber.replace(/[\s-]/g, "");
      const duplicates = Object.values(data.branches).flatMap((branch) => branch.staff).filter((other) =>
        other.id !== staff.id && other.payrollProfile?.paymentMethod !== "cash" &&
        other.payrollProfile?.bankDetails.bank.toLowerCase() === profile.bankDetails.bank.toLowerCase() &&
        other.payrollProfile?.bankDetails.accountNumber.replace(/[\s-]/g, "") === number);
      if (duplicates.length) warnings.push(`Duplicate bank account with ${duplicates.map((item) => item.name).join(", ")}`);
    }
  }
  return warnings;
}

export function validatePayingConfiguration(entities: PayingEntity[], accounts: PayingAccount[],
  defaults: Partial<Record<BranchId, string>>, data: PayrollWorld): string[] {
  const errors: string[] = [];
  if (!entities.length || new Set(entities.map((item) => item.id)).size !== entities.length) errors.push("Entities need unique IDs.");
  for (const entity of entities) {
    if (!entity.id.trim() || !entity.name.trim() || !["TH", "MY"].includes(entity.country)) errors.push("Entity ID, name and country are required.");
  }
  if (new Set(accounts.map((item) => item.id)).size !== accounts.length) errors.push("Account IDs must be unique.");
  for (const account of accounts) {
    if (!account.id.trim() || !account.label.trim() || !account.bank.trim() || !account.accountName.trim() ||
      !account.accountNumber.trim() || !entities.some((item) => item.id === account.entityId) ||
      !["SCB", "KBANK", "BBL", "GENERIC"].includes(account.fileFormat)) errors.push("Complete every paying account and assign its entity.");
  }
  for (const [branchId, id] of Object.entries(defaults)) {
    const branch = data.branches[branchId as BranchId];
    const account = accounts.find((item) => item.id === id);
    const latest = branch?.detailsHistory.slice().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.details;
    if (!branch || !account || account.entityId !== latest?.payingEntityId) errors.push("Each branch default account must belong to the branch's entity.");
  }
  return Array.from(new Set(errors));
}

export function isPhase1DataValid(data: PayrollWorld): boolean {
  try {
    if (!data.payingEntities || !data.payingAccounts || !Array.isArray(data.profileSetupAudits)) return false;
    const defaults = Object.fromEntries(Object.entries(data.branches).map(([id, branch]) =>
      [id, branch.detailsHistory.slice().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0].details.defaultPayingAccountId]));
    if (validatePayingConfiguration(data.payingEntities, data.payingAccounts, defaults, data).length) return false;
    return Object.values(data.branches).every((branch) => branch.staff.every((staff) =>
      !!staff.payrollProfile && validatePayrollProfile(staff.payrollProfile, data).length === 0));
  } catch {
    return false;
  }
}
