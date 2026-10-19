import type { BranchId } from "./model";
import type { BankDetails, CostCentre, PaymentMethod, PayingAccount } from "./payroll-profile";

export const DISCOUNTS = ["owner-complimentary", "free-coffee", "staff-discount", "free-ice-cream"] as const;
export type Discount = typeof DISCOUNTS[number];
export interface RevenueCell { amount: number; vat: number; serviceCharge: number }
export interface CompanyRevenue { streams: Record<string, RevenueCell>; discounts: Partial<Record<Discount, number>> }
export interface RevenueBase { branches: BranchId[]; streams: string[]; addBack: Discount[] }
export interface ServicePolicy {
  effectiveFrom: string; percent: number;
  basis: "calendar" | "worked" | "equal" | "role-weight";
  excluded: "remove" | "retain"; streams: string[]; addBack: Discount[];
  roleWeights: Record<string, number>;
  groups?: ServiceShareGroup[];
  exceptions?: ServicePersonException[];
  version?: number; reason?: string; who?: string; at?: string; superseded?: boolean;
}
export interface ServiceShareGroup {
  id: string; name: string; selection: "everyone" | "department" | "job-title" | "people";
  values: string[]; percent: number; basis: ServicePolicy["basis"];
  /** These streams reserve their own part of the branch pool before the remainder is shared. */
  streams?: string[];
}
export interface ServicePersonException { staffId: string; kind: "exclude" | "fixed" | "weight"; value: number }
export type CompanyIncentiveKind = "revenue" | "team-days" | "unit-pool" | "unit" | "kpi" | "guarantee" | "manual";
export interface CompanyIncentive {
  id: string; name: string; kind: CompanyIncentiveKind; staffIds: string[];
  base: RevenueBase; rate: number; inputKey: string;
  target: number | null; cap: number | null; effectiveFrom: string; effectiveTo: string | null;
  kpiOperator: "lt" | "lte" | "gte" | "gt"; kpiTarget: number;
  enabled?: boolean;
  partMonth?: "prorate" | "full";
}
export interface IncentiveAssignment {
  id: string; ruleId: string; staffId: string | null; jobTitle?: string; branches?: BranchId[];
  effectiveFrom: string; effectiveTo: string | null; personalRate?: number; excluded?: boolean;
  who: string; reason: string; at: string;
  superseded?: boolean;
}
export interface IncentiveRuleVersion {
  ruleId: string; version: number; terms: CompanyIncentive; effectiveFrom: string; effectiveTo: string | null;
  who: string; reason: string; at: string; superseded?: boolean;
}
export interface RewardTrace {
  version: number; rule: CompanyIncentive; assignment: IncentiveAssignment;
  from: string; to: string;
  dates?: string[];
}
export interface StaffMonthInput {
  /** Contractor invoices may withhold on the fixed fee only, excluding SC; default is all earnings. */
  pnd3Basis?: "all-earnings" | "fee-only";
  daysWorked?: number; units: Record<string, number>; kpis: Record<string, number>;
  bonuses: Record<string, { amount: number; reason: string }>;
}
export interface CompanyMonthInputs {
  revenue: Partial<Record<BranchId, CompanyRevenue>>; staff: Record<string, StaffMonthInput>;
  counts: Record<string, number>;
  sources?: Record<string, CompanyInputSource>;
}
export type CompanySourceKind = "POS" | "Attendance" | "Vouchers" | "CRM" | "Manual" | "Overridden";
export interface CompanyInputSource {
  kind: Exclude<CompanySourceKind, "Overridden">; original: number; current: number;
  syncedAt: string; who?: string; reason?: string; at?: string;
  overridden?: boolean;
}
export interface CompanySourceEvidence { tag: CompanySourceKind; explanation: string; key?: string; original?: number; current?: number; reason?: string }
export interface CompanyAudit { at: string; who: string; action: string; reason: string }
export interface AttendanceReview { action: "confirm" | "override" | "excuse"; reason: string; who: string; at: string; clockIn?: string; clockOut?: string }
export interface CompanyOverride { staffId: string; entityId: string; component: string; amount: number; reason: string }
export interface CompanyManual { id: string; staffId: string; amount: number; kind: "bonus" | "deduction"; reason: string }
export interface CompanyDraft {
  entityId: string; month: string; version: number;
  payDate?: string;
  stage: "attendance" | "inputs" | "overview" | "approvals" | "outputs";
  status: "draft" | "gm-confirmed" | "locked" | "paid";
  attendance: Record<string, AttendanceReview>; overrides: CompanyOverride[]; manual: CompanyManual[];
  thirdPartyApprovals?: Record<string, { signature: string; reason: string; who: string; at: string }>;
  audit: CompanyAudit[]; approvedSignature?: string; gmActor?: string; ownerActor?: string;
}
export interface CompanyPayrollDocument {
  version: 1; servicePolicies: Partial<Record<BranchId, ServicePolicy[]>>;
  incentives: CompanyIncentive[]; months: Record<string, CompanyMonthInputs>;
  runs: Record<string, CompanyDraft>; snapshots: CompanySnapshot[]; audit: CompanyAudit[];
  rewardsVersion?: 1; incentiveAssignments?: IncentiveAssignment[]; incentiveVersions?: IncentiveRuleVersion[];
}
export interface MoneyAllocation {
  costCentre: CostCentre; entityId: string; payingAccountId: string | null; amount: number;
}
export interface CompanyPayLine {
  id: string; component: string; label: string; category: "earning" | "deduction" | "employer";
  amount: number; formula: string; inputs: string[]; sourceMonth: string;
  allocations: MoneyAllocation[]; taxable: boolean; ssoWage: boolean;
  registeredBranchId?: BranchId; remittingEntityId?: string; overridden?: boolean;
  rewardTrace?: RewardTrace;
  sources?: CompanySourceEvidence[];
}
export interface PersonCost {
  costCentre: CostCentre; entityId: string; gross: number; deductions: number; net: number; employer: number; totalCost: number;
}
export interface CompanyPayment {
  staffId: string; person: string; entityId: string; payingAccountId: string | null;
  method: PaymentMethod; bank: BankDetails; reason: string; amount: number;
  batch: "same-bank" | "other-bank" | "cash";
}
export interface CompanyPerson {
  id: string; name: string; jobTitle: string; entityId: string; homeBranchId: BranchId; currency: "THB" | "MYR";
  workerType: string; taxId: string; ssoNumber: string; joinedOn: string; lastWorkingDay: string | null;
  notes: string; allocationBadge: string; daysWorked: number; employedDays: number;
  department?: string;
  prorationDivisor?: number;
  ewfFiling?: { dateOfBirth?: string; nationality?: string; passportNumber?: string; leavingReason?: string; title?: string; givenName?: string; surname?: string };
  lines: CompanyPayLine[]; gross: number; deductions: number; net: number; employer: number; totalCost: number;
  components: Record<string, number>; costs: PersonCost[]; payments: CompanyPayment[];
  warnings: string[]; ytd: { gross: number; deductions: number; net: number; months: string[] };
}
export interface ServiceDistribution {
  branchId: BranchId; earningMonth: string; revenueBase: number; percent: number; pool: number;
  basis: ServicePolicy["basis"]; denominator: number; dayRate: number; paid: number; retained: number;
  people: { staffId: string; name: string; units: number; eligible: boolean; amount: number }[];
  groups?: { id: string; name: string; pool: number; denominator: number; dayRate: number; paid: number; retained: number; basis: ServicePolicy["basis"] }[];
  details?: Record<string, string>;
}
export interface IncentiveAward { ruleId: string; name: string; staffId: string; amount: number; formula: string; targetMet: boolean; base: number; units: number; rewardTrace?: RewardTrace }
export interface PayrollException {
  id: string; staffId?: string; branchId?: BranchId; entityId?: string; severity: "warning" | "blocking" | "info"; kind: string; message: string;
}
export interface CompanySummary { gross: number; deductions: number; net: number; employer: number; totalCost: number }
export interface CompanyResult {
  entityId: string; name: string; month: string; currency: "THB" | "MYR"; people: CompanyPerson[];
  totals: CompanySummary; payments: CompanyPayment[]; exceptions: PayrollException[];
}
export interface CompanyCalculation {
  month: string; entities: CompanyResult[]; service: ServiceDistribution[]; incentives: IncentiveAward[];
  exceptions: PayrollException[]; signature: string;
}
export interface BankOutput { account: PayingAccount; filename: string; csv: string; amount: number; transfers: CompanyPayment[] }
export interface CompanyDownloadFile {
  group: "Bank files" | "Social security (SSO)" | "Welfare fund (EWF)" | "Tax (PND.1/PND.3)" | "Payslips" | "Reports";
  filename: string; mime: string; encoding: "utf8" | "base64"; content: string;
  rows: number; total: number; preview: { headers: string[]; rows: (string | number)[][] }; note?: string;
}
export interface CompanyOutputs {
  banks: BankOutput[]; cashHtml: string; cashAmount: number; reports: Record<string, string>;
  payslips: Record<string, string>; net: number; bankAmount: number; difference: number; note: string;
  downloadFiles?: CompanyDownloadFile[]; uploadIssues?: string[];
  uploadBankAmount?: number; uploadDifference?: number;
}
export interface CompanySnapshot {
  entityId: string; month: string; version: number; lockedAt: string; lockedBy: string; gmActor: string;
  result: CompanyResult; calculation: CompanyCalculation; outputs: CompanyOutputs; audit: CompanyAudit[];
  rewardConfig?: Pick<CompanyPayrollDocument, "incentiveAssignments" | "incentiveVersions" | "servicePolicies">;
  inputSnapshot?: Record<string, CompanyMonthInputs>;
}
