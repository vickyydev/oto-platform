/**
 * The company payroll's month-end shapes (SCRUM-568, R3): month inputs,
 * rewards setup, the payroll feeds (OT bank, leave valuations, offboarding)
 * and the read-only preview, as the routes return them and the screens read
 * them. The engine's own types are re-exported (type-only: nothing of the
 * engine is bundled into the client).
 */
export type {
  CompanyCalculation, CompanyIncentive, CompanyIncentiveKind, CompanyInputSource, CompanyMonthInputs, CompanyPerson, CompanyRevenue,
  CompanyResult, CompanySourceKind, IncentiveAssignment, IncentiveRuleVersion, PayrollException, RevenueCell, ServicePolicy, StaffMonthInput,
} from "../server/payroll/engine/company-model";
export type { AttendanceDay, AttendanceException } from "../server/payroll/engine/model";
import type {
  CompanyCalculation, CompanyIncentive, CompanyMonthInputs, CompanyResult, IncentiveAssignment, IncentiveRuleVersion, ServicePolicy,
} from "../server/payroll/engine/company-model";
import type { AttendanceDay } from "../server/payroll/engine/model";
import type { RevenueStream } from "./payroll-config";

/** The prototype's discount add-backs (company-model DISCOUNTS). */
export const PAYROLL_DISCOUNTS = ["owner-complimentary", "free-coffee", "staff-discount", "free-ice-cream"] as const;
export const PAYROLL_DISCOUNT_LABELS: Record<typeof PAYROLL_DISCOUNTS[number], string> = {
  "owner-complimentary": "Owner complimentary", "free-coffee": "Free coffee", "staff-discount": "Staff discount", "free-ice-cream": "Free ice cream",
};

export interface PayrollBranchRef { id: string; name: string }
export interface PayrollPersonRef { id: string; name: string; jobTitle: string; homeBranchId: string | null; workerType: string }
export interface MonthInputChange { id: string; key: string; priorValue: unknown; newValue: unknown; sourceKind: string; reason: string; who: string; at: string }

export interface MonthInputsView {
  month: string; previousMonth: string;
  inputs: CompanyMonthInputs | null; previous: CompanyMonthInputs | null; revision: number;
  streams: RevenueStream[]; branches: PayrollBranchRef[]; people: PayrollPersonRef[];
  manualRules: { id: string; name: string }[];
  /** A locked or paid run that this month's inputs feed (this month, or next month's service charge). */
  locked: string[];
  changes: MonthInputChange[];
  canManage: boolean;
}

export interface RewardsView {
  branches: PayrollBranchRef[]; streams: RevenueStream[]; people: PayrollPersonRef[];
  policies: Record<string, ServicePolicy[]>;
  rules: CompanyIncentive[]; versions: IncentiveRuleVersion[]; assignments: IncentiveAssignment[];
  canManage: boolean;
}

export interface OtBookingView { id: string; employeeId: string; name: string; date: string; hours: number; reason: string; who: string; at: string }
export interface LeaveValuationView {
  id: string; employeeId: string; name: string; kind: "unpaid" | "payout"; source: "time-off" | "exit"; leaveTypeCode: string;
  startsOn: string; endsOn: string; days: number; dailyRate: number; amount: number; taxable: boolean; socialSecurity: boolean;
  reason: string; who: string; at: string; reversedAt: string | null; reversalReason: string | null; sourceMissing: boolean;
}
export interface UnvaluedLeaveView { timeOffId: string; employeeId: string; name: string; type: string; startsOn: string; endsOn: string; halfDay: boolean }
export interface OffboardingView { employeeId: string; name: string; resignationDate: string; lastWorkingDate: string; reason: string; who: string; at: string }
export interface OtBankRow { employeeId: string; name: string; availableHours: number; earnedHours: number; usedHours: number }
export interface FeedsView {
  month: string; people: PayrollPersonRef[];
  bookings: OtBookingView[]; valuations: LeaveValuationView[]; unvalued: UnvaluedLeaveView[]; offboarding: OffboardingView[];
  otBank: OtBankRow[];
  /** Owner ruling 2026-10-20 (plan, open decision 3): company runs do not credit the OT bank. */
  otBankCreditsFromRuns: false;
  leaveTypes: { code: string; name: string; paid: boolean }[];
  canManage: boolean;
}

/** Who did a lifecycle step and when. */
export interface RunStepView { name: string; at: string }
export interface RunView {
  runId: string; versionId: string; version: number; status: string; payDate: string;
  /** R4 (SCRUM-569): the lifecycle of the current version. */
  stage?: string; approvedSignature?: string | null; reopenReason?: string | null;
  gm?: RunStepView | null; owner?: RunStepView | null; paid?: RunStepView | null;
  snapshotId?: string | null;
}
export interface ExcludedPersonView { employeeId: string; name: string; reason: string }

/** One row of the run audit (append-only). */
export interface RunAuditEntryView {
  id: string; version: number; action: string; subject: string | null; subjectId: string | null; reason: string;
  oldValue: unknown; newValue: unknown; who: string; at: string;
}
/** An overtime decision (Pay / Bank / Reject) on one occurrence of a fed attendance day. */
export interface OvertimeDecisionView {
  dayKey: string; employeeId: string; name: string; exceptionIndex: number; outcome: "Pay" | "Bank" | "Reject";
  employeeChoiceConfirmed: boolean; reason: string; who: string; at: string;
}
/** A payment to someone else, approved for the payment details it was approved with. */
export interface ThirdPartyApprovalView { employeeId: string; name: string; reason: string; who: string; at: string; current: boolean }
export interface RunVersionView {
  versionId: string; version: number; status: string; reopenReason: string | null; createdAt: string;
  gm: RunStepView | null; owner: RunStepView | null; paid: RunStepView | null; snapshotId: string | null;
}

export interface MonthEndView {
  entity: { id: string; name: string; defaultPayDay: number };
  month: string; run: RunView | null;
  attendance: (AttendanceDay & { workedAtBranchId: string | null; name: string; review: { action: string; reason: string; who: string; at: string; clockIn?: string; clockOut?: string } | null })[];
  manual: { id: string; employeeId: string; name: string; kind: "bonus" | "deduction"; amount: number; reason: string; who: string; at: string }[];
  overrides: { id: string; employeeId: string; name: string; component: string; amount: number; reason: string; who: string; at: string }[];
  /** R4: the current version's overtime decisions and third-party approvals, every version, and the run audit. */
  overtime: OvertimeDecisionView[];
  thirdParty: ThirdPartyApprovalView[];
  versions: RunVersionView[];
  audit: RunAuditEntryView[];
  people: PayrollPersonRef[];
  excluded: ExcludedPersonView[]; notes: string[];
  canManage: boolean;
  /** GM confirmation (payroll.confirm) and the Owner's lock, reopen and paid (payroll.lock). */
  canConfirm: boolean; canLock: boolean;
}

export interface PreviewView {
  month: string; entityId: string;
  calculation: CompanyCalculation; result: CompanyResult | null;
  /** The server's sha256 source signature (plan §1); the engine's own FNV one stays in calculation.signature. */
  signature: string;
  excluded: ExcludedPersonView[]; notes: string[]; run: RunView | null;
  timing: { loadMs: number; calculateMs: number; queries: number };
  /** R4: branch ids to names, for every text the engine wrote with a branch id in it. */
  branchNames: Record<string, string>;
  /** True when the current version is locked or paid: this is the frozen snapshot, not a live calculation. */
  frozen: boolean;
  /** GM confirmed, but the sources changed since (signature mismatch): the GM must confirm again. */
  stale: boolean;
  /** The prototype's "problems still open" count of the check & fix step. */
  openProblems: number;
}

/** What a lock froze of the outputs: the prototype's CompanyOutputs without file bodies (those are payroll_output_files rows). */
export interface OutputsManifest {
  banks: { account: { id: string; label: string; bank: string; fileFormat: string }; filename: string; amount: number; transfers: CompanyResult["payments"] }[];
  cashAmount: number; net: number; bankAmount: number; difference: number; note: string;
  uploadIssues: string[]; uploadBankAmount: number; uploadDifference: number;
  reports: string[]; payslips: string[];
}
export interface OutputFileView {
  id: string; group: string; filename: string; mime: string; employeeId: string | null; name: string | null;
  bytes: number; rows: number; total: number; sha256: string;
}
export interface PayrollHistoryRow {
  snapshotId: string; entityId: string; entityName: string; month: string; version: number; status: string;
  lockedAt: string; lockedBy: string; gmActor: string; people: number;
  totals: { gross: number; deductions: number; net: number; employer: number; totalCost: number };
}
export interface PayrollHistoryVersionView extends PayrollHistoryRow {
  result: CompanyResult; manifest: OutputsManifest; audit: RunAuditEntryView[]; files: OutputFileView[];
  sourceSignature: string; engineRevision: string;
}
export interface MyPayslipRow {
  fileId: string; entityName: string; month: string; version: number; status: string; net: number; lockedAt: string;
}
export interface MyPayslipsView {
  employee: { id: string; name: string } | null;
  payslips: MyPayslipRow[];
}
