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

export interface RunView { runId: string; versionId: string; version: number; status: string; payDate: string }
export interface ExcludedPersonView { employeeId: string; name: string; reason: string }
export interface MonthEndView {
  entity: { id: string; name: string; defaultPayDay: number };
  month: string; run: RunView | null;
  attendance: (AttendanceDay & { workedAtBranchId: string | null; name: string; review: { action: string; reason: string; who: string; at: string; clockIn?: string; clockOut?: string } | null })[];
  manual: { id: string; employeeId: string; name: string; kind: "bonus" | "deduction"; amount: number; reason: string; who: string; at: string }[];
  overrides: { id: string; employeeId: string; name: string; component: string; amount: number; reason: string; who: string; at: string }[];
  people: PayrollPersonRef[];
  excluded: ExcludedPersonView[]; notes: string[];
  canManage: boolean;
}

export interface PreviewView {
  month: string; entityId: string;
  calculation: CompanyCalculation; result: CompanyResult | null;
  /** The server's sha256 source signature (plan §1); the engine's own FNV one stays in calculation.signature. */
  signature: string;
  excluded: ExcludedPersonView[]; notes: string[]; run: RunView | null;
  timing: { loadMs: number; calculateMs: number; queries: number };
}
