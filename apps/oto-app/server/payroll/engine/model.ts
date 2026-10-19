import type { CompanyPayrollDocument } from "./company-model";
import type { EmployeePayrollProfile, PayingEntity, PayingAccount, ProfileSetupAudit } from "./payroll-profile";

export type CountryCode = "TH" | "MY";
/** Our branch ids (the prototype named three fictional ones). */
export type BranchId = string;
/** A job role string (the prototype listed six fictional ones). */
export type StaffRole = string;
export type EmploymentType = "local" | "foreign";
export type AllocationMethod = "days" | "equal" | "role-weight" | "custom-percent";
export type ExceptionKind = "late" | "early-departure" | "missed-punch" | "no-show" | "break-overrun" | "overtime" | "holiday";
export type ExceptionResolution = "Approved" | "Excused" | "Corrected";
export type OvertimeHandlingMode = "pay-only" | "time-off-only" | "employee-chooses" | "manager-decides";
export type OvertimeOutcome = "Pay" | "Bank" | "Reject";
export type RunRole = "Payroll Admin" | "GM" | "Owner";
export type LeaveAdjustmentRole = RunRole | "Staff";
export type RunStage = "attendance-review" | "inputs" | "overview" | "approvals";
export type RunApproval = "in-progress" | "gm-approved" | "sent-back";
export type IncentiveBasis = "branch" | "gross-profit";
export type LeaveAccrualMethod = "upfront" | "monthly" | "confirmed-days" | "once";
export type LeaveLedgerKind = "Earned" | "Used" | "Adjusted" | "Paid out" | "Expired" | "Carried forward";
export type LeaveLedgerSource = "schedule" | "request" | "manual" | "offboarding" | "accrual";

/** Older saved runs use retired stage names; normalize them without touching other frozen inputs. */
export function normalizeRunStage(value: unknown): RunStage | null {
  if (value === "cutoff") return "attendance-review";
  if (value === "adjustments") return "overview";
  if (value === "attendance-review" || value === "inputs" || value === "overview" || value === "approvals") {
    return value;
  }
  return null;
}

export function runStageTitle(stage: RunStage): string {
  return stage === "attendance-review" ? "Attendance review"
    : stage === "inputs" ? "Inputs"
      : stage === "overview" ? "Overview" : "Approvals";
}

export interface LeaveTypePolicy {
  id: string;
  name: string;
  paid: boolean;
  annualEntitlement: number;
  accrualMethod: LeaveAccrualMethod;
  prorateJoiners: boolean;
  waitingMonths: number;
  carryForwardCap: number;
  carryExpiryMonths: number | null;
  allowNegative: boolean;
  paidOutOnExit: boolean;
  serviceBands?: Array<{ minimumYears: number; entitlement: number }>;
  prorateByDefault?: boolean;
  certificateAfterConsecutiveDays?: number;
  hospitalization?: boolean;
}

export interface LeavePolicy {
  country: CountryCode;
  types: LeaveTypePolicy[];
  publicHolidays: string[];
  daysOff: { earnedDays: number; workedDays: number };
}

export interface LeavePolicyVersion {
  effectiveFrom: string;
  policy: LeavePolicy;
  reason: string;
  who: string;
  when: string;
}

export interface LeavePolicyChange {
  id: string;
  branchId: BranchId;
  effectiveFrom: string;
  oldValue: LeavePolicy | null;
  newValue: LeavePolicy;
  reason: string;
  who: string;
  when: string;
}

export interface LeaveLedgerEntry {
  entryId: string;
  branchId: BranchId;
  staffId: string;
  typeId: string;
  date: string;
  days: number;
  kind: LeaveLedgerKind;
  source: LeaveLedgerSource;
  reason: string;
  actor: string;
  createdAt: string;
  linkedEntryId?: string;
  sourceKey?: string;
  expiresOn?: string;
  rate?: number;
  taxable?: boolean;
  socialSecurity?: boolean;
  decidedBy?: string;
  /** Captured when a Used event is posted; later policy edits cannot reclassify it. */
  paidLeave?: boolean;
  negativeDecisionId?: string;
}

export interface LeaveOffboardingRecord {
  branchId: BranchId;
  staffId: string;
  resignationDate: string;
  lastWorkingDate: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}
export type SaveLeaveOffboardingInput = Omit<LeaveOffboardingRecord, "recordedBy" | "recordedAt">;

export interface LeaveNegativeDecision {
  id?: string;
  branchId: BranchId;
  staffId: string;
  typeId: string;
  decision: "allow" | "deny";
  reason: string;
  decidedBy: string;
  decidedAt: string;
  /** Optional exact placement scope; unscoped decisions are audit-only and never authorize exceptions. */
  placementDate?: string;
  placementDays?: number;
}

export interface LeaveAdjustmentPermissionChange {
  role: LeaveAdjustmentRole;
  allowed: boolean;
  who: string;
  when: string;
}

export type LeaveExitPlanAction =
  | { kind: "use"; typeId: string; dates: string[]; days: number; reason: string }
  | { kind: "payout"; typeId: string; days: number; date: string; rate: number; taxable: boolean; socialSecurity: boolean; reason: string };

export interface FrozenLeaveRunInputs {
  signature: string;
  eventIds: string[];
  policyVersion: string;
  payouts: unknown[];
  unpaid: unknown[];
}

export interface LeaveBalance {
  branchId: BranchId;
  staffId: string;
  typeId: string;
  asOf: string;
  entitlement: number;
  used: number;
  scheduled: number;
  available: number;
  ledger: LeaveLedgerEntry[];
}

export interface EmployeeIncentivePlan {
  id: string;
  staffId: string;
  name: string;
  streams: StreamKey[];
  /** Decimal rate: 0.005 means 0.5%. */
  rate: number;
  basis: IncentiveBasis;
  /** Overall sums all branch streams; otherwise streams names the selected basis stream(s). */
  scope?: "stream" | "overall";
  targetGate: null | { streams: StreamKey[]; threshold: number };
  monthlyCap: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  proratePartMonth: boolean;
  taxable: boolean;
  socialSecurity: boolean;
  /** Role template used for the assignment; omitted for standalone plans. */
  sourceRoleDefaultId?: string;
  /** An employee-specific line takes precedence over its matching role template. */
  isOverride?: boolean;
}

export type RoleIncentiveDefault = Omit<EmployeeIncentivePlan, "staffId" | "sourceRoleDefaultId" | "isOverride"> & {
  role: StaffRole;
};

export interface BoothVoucherSettings {
  method: "percent" | "fixed";
  value: number;
}

export interface BoothDuty {
  branchId: BranchId;
  date: string;
  staffIds: string[];
}

export interface BoothVoucher {
  code: string;
  branchId: BranchId;
  issuedAt: string;
  prizeType: string;
  staffIds: string[];
  /** Exact immutable issue-time recipients; [] explicitly means legacy evidence is missing. */
  verifiedStaffIdsAtIssue?: string[];
  expiresAt: string;
  redeemedAt: string | null;
  redeemedSpend: number | null;
  splitPercentByStaffId: Record<string, number> | null;
}

export interface IncentiveChange {
  id: string;
  branchId: BranchId;
  entity: "plan" | "role-default" | "voucher" | "booth-setting";
  entityId: string;
  who: string;
  when: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
}

export type RunMutationAction =
  | { type: "set-stage"; stage: RunStage }
  | { type: "set-revenue"; stream: StreamKey; amount: number; reason: string }
  | { type: "set-cost-of-sales"; stream: StreamKey; amount: number; reason: string }
  | { type: "add-adjustment"; adjustment: ManualRunAdjustment }
  | { type: "remove-adjustment"; adjustmentId: string; reason: string }
  | { type: "set-line-override"; lineId: string; override: RunLineOverride }
  | { type: "resolve-exception"; attendanceId: string; exceptionIndex: number; resolution: ExceptionResolution; reason: string; effectiveClockIn?: string; effectiveClockOut?: string }
  | { type: "resolve-exceptions-bulk"; items: { attendanceId: string; exceptionIndex: number; resolution: ExceptionResolution }[]; reason: string }
  | { type: "resolve-overtime"; attendanceId: string; exceptionIndex: number; outcome: OvertimeOutcome; reason: string; employeeChoiceConfirmed?: boolean }
  | { type: "resolve-overtime-bulk"; items: { attendanceId: string; exceptionIndex: number; outcome: OvertimeOutcome; employeeChoiceConfirmed?: boolean }[]; reason: string };

export interface ManualRunAdjustment {
  id: string;
  staffId: string;
  kind: "earning" | "deduction";
  source: "salary" | "service-charge";
  amount: number;
  reason: string;
}

export interface RunLineOverride {
  amount: number;
  status: "changed" | "rejected" | "reinstated";
  reason: string;
}

export interface RunAudit {
  id: string;
  branchId: BranchId;
  month: string;
  version: number;
  who: string;
  role: RunRole;
  when: string;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
}

export interface RunOutputStatus {
  branchId: BranchId;
  month: string;
  version: number;
  status: "paid";
  who: string;
  role: RunRole;
  when: string;
}

export interface RunExceptionResolution {
  attendanceId: string;
  exceptionIndex: number;
  resolution: ExceptionResolution;
  reason: string;
  resolvedBy: string;
  resolvedAt: string;
  effectiveClockIn?: string;
  effectiveClockOut?: string;
}

export interface OvertimePolicy {
  handlingMode: OvertimeHandlingMode;
  requirePreapprovalOrSchedule: boolean;
  minimumBlockMinutes: number;
  roundingMinutes: number;
  bankConversionRate: number;
  bankMaximumHours: number;
  bankExpiryMonths: number;
  bankExpiryAction: "payout" | "forfeit";
  bankUseUnit: "hours" | "half-days";
  monthlyCapHours: number;
  positionOverrides?: Partial<Record<StaffRole, Partial<Omit<OvertimePolicy, "positionOverrides">>>>;
}

export interface OvertimeDecision {
  attendanceId: string;
  exceptionIndex: number;
  outcome: OvertimeOutcome;
  reason: string;
  resolvedBy: string;
  resolvedAt: string;
  employeeChoiceConfirmed?: boolean;
}

export interface OtBankBooking {
  id: string;
  branchId: BranchId;
  staffId: string;
  date: string;
  hours: number;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface OtBankLedgerEntry {
  id: string;
  branchId: BranchId;
  staffId: string;
  date: string;
  hours: number;
  kind: "Earned" | "Used" | "Expired" | "Paid out";
  reason: string;
  sourceKey: string;
  expiresOn?: string;
  rate?: number;
  amount?: number;
}

export interface OtBankBalance {
  availableHours: number;
  earnedHours: number;
  usedHours: number;
  expiredHours: number;
  payoutHours: number;
  entries: OtBankLedgerEntry[];
}

export interface RunDraft {
  branchId: BranchId;
  month: string;
  version: number;
  stage: RunStage;
  approval: RunApproval;
  revenueOverrides: Partial<Record<StreamKey, number>>;
  costOfSalesOverrides: Partial<Record<StreamKey, number>>;
  manualAdjustments: ManualRunAdjustment[];
  lineOverrides: Record<string, RunLineOverride>;
  exceptionResolutions: RunExceptionResolution[];
  /** Explicit per-occurrence overtime decisions; absent on legacy drafts. */
  overtimeDecisions?: OvertimeDecision[];
  /** Manual-figure overlays for a reopened frozen version; never writes source history. */
  snapshotManualFigures?: ManualFigure[];
  /** Exact leave-source signature accepted at GM approval; Owner locking rechecks it. */
  leaveApprovalSignature?: string;
  /** Changes to EWF rates/headcount/membership/classification require GM review again. */
  ewfApprovalSignature?: string;
}

/** Frozen payload is intentionally opaque to the shared-store contract. */
export interface RunSnapshot {
  branchId: BranchId;
  month: string;
  version: number;
  lockedAt: string;
  lockedBy: string;
  approval: "locked";
  calculations: unknown;
  details: BranchDetails;
  staff: StaffMember[];
  rules: StatutoryRules;
  incentiveRules: IncentiveRule[];
  deductionRules: DeductionRule[];
  inputs: {
    revenue: FrozenRevenueMonth | null;
    /** Archival-only payload for pre-v11 snapshots. New/reopened calculations must ignore it. */
    attributedSales?: AttributedSale[];
    attendance: AttendanceDay[];
    manualFigures: ManualFigure[];
    draft: RunDraft;
    /** Frozen earning-month source data used for lagged components on reopened archives. */
    supportingRevenue?: FrozenRevenueMonth[];
    supportingAttendance?: AttendanceDay[];
    /** EWF inputs captured only on newly locked runs. */
    ewfSettings?: EwfSettingsVersion[];
    ewfRemittances?: EwfRemittance[];
    ewfHeadcount?: number;
    /** Frozen OT-bank events available when this run was locked. */
    otBankInputs?: {
      bookings: OtBankBooking[];
      offboarding: LeaveOffboardingRecord[];
    };
  };
  audit: RunAudit[];
  /** Phase 3b fields are optional so existing frozen snapshots remain readable and unchanged. */
  employeeIncentivePlans?: EmployeeIncentivePlan[];
  roleIncentiveDefaults?: RoleIncentiveDefault[];
  voucherSettings?: BoothVoucherSettings;
  boothRoster?: BoothDuty[];
  boothVouchers?: BoothVoucher[];
  incentiveChanges?: IncentiveChange[];
  /** Frozen leave inputs are optional; legacy snapshots remain byte-for-byte unchanged. */
  leaveInputs?: FrozenLeaveRunInputs;
}

export interface StaffMember {
  department?: string;
  payrollProfile?: EmployeePayrollProfile;
  id: string;
  employeeNumber: string;
  taxId: string;
  /** Fictional demo identifiers; old snapshots are not retroactively edited. */
  statutoryIds?: {
    nationalId?: string;
    ssoNumber?: string;
    epfNumber?: string;
    socsoNumber?: string;
    taxNumber?: string;
    passport?: string;
  };
  name: string;
  role: StaffRole;
  employmentType: EmploymentType;
  nationality: string;
  taxResidency?: "resident" | "nonresident";
  monthlySalary: number | null;
  dayRate: number | null;
  joinedOn: string;
  leftOn: string | null;
  probationEndsOn: string;
  scheduledDaysPerWeek: number;
  otEligible: boolean;
  serviceChargeEligible: boolean;
  serviceRoleWeight: number;
  ewfMembership?: { membershipJoinDate: string | null; beneficiaryMeta: { fileName: string; date: string } | null } | null;
}

export interface EwfSettings {
  employeeRate: number;
  employerRate: number;
  headcountThreshold: number;
  providentFundAvailable: boolean;
  voluntaryBelowThreshold: boolean;
}

export interface EwfSettingsVersion {
  entityId: string;
  effectiveFrom: string;
  settings: EwfSettings;
  reason: string;
  who: string;
  when: string;
}

export interface EwfChange {
  id: string;
  entityId: string;
  staffId?: string;
  month?: string;
  kind: "settings" | "employee-membership" | "remittance" | "offboarding";
  effectiveFrom?: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  who: string;
  when: string;
}

export interface EwfRemittance {
  entityId: string;
  month: string;
  amountPaid: number;
  paidOn: string | null;
  reason: string;
  who: string;
  when: string;
}

export interface EwfOffboardingChecklist {
  branchId: BranchId;
  staffId: string;
  lastWorkingDate: string;
  finalContributionRemitted: boolean;
  terminationConfirmationIssued: boolean;
  reason: string;
  who: string;
  when: string;
}

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

export interface TaxBracket {
  from: number;
  /** null represents the final, unbounded bracket and serializes safely to localStorage. */
  to: number | null;
  rate: number;
}

export interface DatedBranchDetails {
  effectiveFrom: string;
  details: BranchDetails;
}

export interface BranchLifecycle {
  effectiveFrom: string;
  openedOn: string;
  closedOn: string | null;
}

export interface StatutoryDocument {
  id: string;
  branchId: BranchId;
  period: string;
  code: string;
  title: string;
  staffId?: string;
  sourceRuns: { branchId: BranchId; month: string; version: number }[];
  createdAt: string;
  createdBy: string;
  html: string;
  files: { name: string; content: string; mime: string }[];
  dueDate: string;
  provisional: boolean;
  coverage: { locked: string[]; missing: string[]; notApplicable: string[] };
  warnings: string[];
  filing?: { date: string; reference: string; when: string; who: string; role: RunRole };
}

export interface StatutoryAudit {
  id: string;
  documentId: string;
  action: string;
  when: string;
  who: string;
  role: RunRole;
}

export interface StatutoryOffer {
  code: string;
  title: string;
  period: string;
  branchId: BranchId;
  staffId?: string;
  dueDate: string;
  sourceRuns: { branchId: BranchId; month: string; version: number }[];
  provisional: boolean;
  coverage: { locked: string[]; missing: string[]; notApplicable: string[] };
  warnings: string[];
}

export interface RevenueMonth {
  branchId: BranchId;
  month: string;
  streams: {
    tickets: number;
    eventsParties: number;
    cafeFnb: number;
    retail: number;
    memberships: number;
  };
  costOfSales: Record<StreamKey, number>;
}

export type StreamKey = keyof RevenueMonth["streams"];

/** Old locked snapshots predate cost-of-sales inputs and remain immutable. */
export type FrozenRevenueMonth = Omit<RevenueMonth, "costOfSales"> & {
  costOfSales?: Record<StreamKey, number>;
};

export interface IncentiveRule {
  id: string;
  name: string;
  enabled: boolean;
  metric: "revenue" | "attendance-percent" | "days-worked" | "manual";
  source: "POS" | "manual";
  scope: "individual" | "role" | "branch";
  revenueStreams: StreamKey[];
  targetGate: null | { streams: StreamKey[]; threshold: number };
  reward: {
    type: "fixed" | "percent" | "tiered-percent" | "per-unit";
    amount: number;
    tiers: { upTo: number | null; rate: number }[];
    tierMode: "marginal" | "whole";
  };
  poolDistribution: "each" | "equal" | "days";
  proratePartMonth: boolean;
  roles: StaffRole[];
  includeStaffIds: string[];
  excludeStaffIds: string[];
  taxable: boolean;
  socialSecurity: boolean;
}

export interface DeductionRule {
  id: string;
  name: string;
  enabled: boolean;
  issue: "late" | "early-departure" | "missed-punch" | "no-show" | "break-overrun";
  freeOccurrences: number | null;
  freeMinutes: number | null;
  method: "fixed" | "per-minute" | "percent";
  amount: number;
  source: "service-charge" | "salary";
  cap: number | null;
  roles: StaffRole[];
  /** Actual profile job titles. When non-empty this replaces `roles` for matching; old role-only rules keep working. */
  jobTitles?: string[];
  includeStaffIds: string[];
  excludeStaffIds: string[];
}

export interface AttributedSale {
  branchId: BranchId;
  month: string;
  staffId: string;
  streams: Record<StreamKey, number>;
  membershipsSold: number;
}

export interface ManualFigure {
  branchId: BranchId;
  month: string;
  ruleId: string;
  staffId: string | null;
  value: number;
}

export interface AttendanceException {
  kind: ExceptionKind;
  resolution: ExceptionResolution | null;
  reason: string;
  rawClockIn: string | null;
  rawClockOut: string | null;
  /** Corrected times are the effective times used by calculations, in local HH:mm. */
  effectiveClockIn: string | null;
  effectiveClockOut: string | null;
  approvedBy: string;
  minutes?: number;
}

export interface AttendanceDay {
  id: string;
  branchId: BranchId;
  staffId: string;
  date: string;
  scheduled: boolean;
  dayOff: boolean;
  holiday: boolean;
  plannedClockIn: string | null;
  plannedClockOut: string | null;
  actualClockIn: string | null;
  actualClockOut: string | null;
  /** Final corrected clock times that payroll uses. */
  effectiveClockIn: string | null;
  effectiveClockOut: string | null;
  overtimeHours: number;
  /** Optional source evidence used by pre-approval policy; legacy attendance has neither flag. */
  overtimePreapproved?: boolean;
  overtimeScheduled?: boolean;
  exceptions: AttendanceException[];
}

/** Applies this run's audited decisions to calculation inputs without changing source attendance. */
export function applyRunAttendanceResolutions(
  attendance: AttendanceDay[],
  resolutions: RunExceptionResolution[],
): AttendanceDay[] {
  return attendance.map((day) => {
    const decisions = resolutions.filter((item) => item.attendanceId === day.id);
    if (decisions.length === 0) return day;
    const hasCorrection = decisions.some((item) => item.resolution === "Corrected");
    let effectiveClockIn = hasCorrection ? day.actualClockIn : day.effectiveClockIn;
    let effectiveClockOut = hasCorrection ? day.actualClockOut : day.effectiveClockOut;
    const exceptions = day.exceptions.map((exception, exceptionIndex) => {
      const decision = decisions.find((item) => item.exceptionIndex === exceptionIndex);
      if (!decision) return exception;
      if (decision.resolution === "Corrected") {
        const effectiveClockInForDecision = decision.effectiveClockIn ?? exception.rawClockIn ?? day.actualClockIn;
        const effectiveClockOutForDecision = decision.effectiveClockOut ?? exception.rawClockOut ?? day.actualClockOut;
        if (decision.effectiveClockIn !== undefined) effectiveClockIn = decision.effectiveClockIn;
        if (decision.effectiveClockOut !== undefined) effectiveClockOut = decision.effectiveClockOut;
        return {
          ...exception,
          resolution: decision.resolution,
          reason: decision.reason,
          approvedBy: decision.resolvedBy,
          effectiveClockIn: effectiveClockInForDecision,
          effectiveClockOut: effectiveClockOutForDecision,
        };
      }
      return {
        ...exception,
        resolution: decision.resolution,
        reason: decision.reason,
        approvedBy: decision.resolvedBy,
      };
    });
    return { ...day, effectiveClockIn, effectiveClockOut, exceptions };
  });
}

export interface ComponentFlags {
  taxable: boolean;
  socialSecurity: boolean;
  ewfWage?: boolean;
  ewfReason?: string;
}

export interface FixedAllowance extends ComponentFlags {
  id: string;
  name: string;
  amount: number;
}

export interface ServiceChargeRule {
  rate: number;
  revenueStreams: Array<keyof RevenueMonth["streams"]>;
  payoutLagMonths: number;
  allocation: AllocationMethod;
  minimumDays: number;
  probationRequired: boolean;
  includeCasuals: boolean;
  roleWeights: Partial<Record<StaffRole, number>>;
  customPercentByStaffId: Record<string, number>;
}

export interface StatutoryRules {
  effectiveFrom: string;
  country: CountryCode;
  thSso: {
    wageCap: number;
    employeeRate: number;
    employerRate: number;
    wholeBahtRounding: "half-up";
  };
  thPit: {
    brackets: TaxBracket[];
    employmentExpenseRate: number;
    employmentExpenseCap: number;
    personalAllowance: number;
  };
  my: {
    epfLocalEmployeeRate: number;
    epfEmployerThreshold: number;
    epfLocalEmployerRateAtOrBelow5000: number;
    epfLocalEmployerRateAbove5000: number;
    epfForeignEmployeeRate: number;
    epfForeignEmployerRate: number;
    socsoWageCap: number;
    socsoLocalEmployeeRate: number;
    socsoLocalEmployerRate: number;
    socsoForeignEmployeeRate: number;
    socsoForeignEmployerRate: number;
    eisWageCap: number;
    eisLocalEmployeeRate: number;
    eisLocalEmployerRate: number;
    hrdEmployerRate: number;
    hrdEnabled: boolean;
    malaysianEmployeeHeadcount: number;
    nonResidentPcbRate: number;
    residentSelfRelief: number;
    residentPcbBrackets: TaxBracket[];
  };
  serviceCharge: ServiceChargeRule;
  lunchByRole: Partial<Record<StaffRole, number>>;
  overtimeMultipliers: { regular: number; restDay: number; publicHoliday: number };
  /** Effective-dated branch policy. Absent only in legacy frozen snapshots, which default to Pay only. */
  overtimePolicy?: OvertimePolicy;
  overtimeEligibilityByRole: Record<StaffRole, boolean>;
  hourlyBase: {
    monthlySalaryDays: number;
    monthlyHoursPerDay: number;
    casualDayHours: number;
  };
  calendarProration: {
    method: "actual-calendar-days" | "fixed-divisor";
    divisor: number;
  };
  allowances: FixedAllowance[];
  componentFlags: Record<string, ComponentFlags>;
}

export interface RuleChange {
  id: string;
  branchId: BranchId;
  kind: "branch-details" | "statutory-pay-rules";
  effectiveFrom: string;
  who: "Prototype editor";
  timestamp: string;
  oldValue: BranchDetails | StatutoryRules;
  newValue: BranchDetails | StatutoryRules;
}

export interface BranchRecord {
  id: BranchId;
  staff: StaffMember[];
  detailsHistory: DatedBranchDetails[];
  lifecycleHistory: BranchLifecycle[];
  rulesHistory: StatutoryRules[];
  incentiveRules: IncentiveRule[];
  deductionRules: DeductionRule[];
  employeeIncentivePlans: EmployeeIncentivePlan[];
  roleIncentiveDefaults: RoleIncentiveDefault[];
  voucherSettings: BoothVoucherSettings;
  leavePolicyHistory: LeavePolicyVersion[];
}

export interface PayrollWorld {
  foundationVersion?: number;
  uploadSettingsVersion?: 1;
  ewfUploadVersion?: 1;
  demoPolicyVersion?: 1;
  runPracticeVersion?: number;
  companyPayRules?: Record<string, StatutoryRules[]>;
  companyDeductionRuleDefaults?: Record<string, DeductionRule[]>;
  branchPayRuleExceptions?: BranchId[];
  branchDeductionExceptions?: BranchId[];
  companyPayroll?: CompanyPayrollDocument;
  schemaVersion: 14;
  payingEntities?: PayingEntity[];
  payingAccounts?: PayingAccount[];
  profileSetupAudits?: ProfileSetupAudit[];
  branches: Record<BranchId, BranchRecord>;
  revenue: RevenueMonth[];
  attendance: AttendanceDay[];
  changelog: RuleChange[];
  manualFigures: ManualFigure[];
  runDrafts: Record<string, RunDraft>;
  runAudits: RunAudit[];
  runSnapshots: RunSnapshot[];
  runOutputStatuses: RunOutputStatus[];
  boothRoster: BoothDuty[];
  boothVouchers: BoothVoucher[];
  incentiveChanges: IncentiveChange[];
  statutoryDocuments: StatutoryDocument[];
  statutoryAudits: StatutoryAudit[];
  leaveLedger: LeaveLedgerEntry[];
  /** Missing roles use the defaults in leave-permissions; explicit values override them. */
  leaveAdjustmentPermissions?: Partial<Record<LeaveAdjustmentRole, boolean>>;
  leaveAdjustmentPermissionChanges?: LeaveAdjustmentPermissionChange[];
  otBankBookings?: OtBankBooking[];
  leavePolicyChanges: LeavePolicyChange[];
  leaveOffboarding: LeaveOffboardingRecord[];
  leaveNegativeDecisions: LeaveNegativeDecision[];
  ewfSettings: EwfSettingsVersion[];
  ewfChanges: EwfChange[];
  ewfRemittances: EwfRemittance[];
  ewfOffboardingChecklists: EwfOffboardingChecklist[];
  /** Ephemeral frozen-run override consumed by EWF recalculation, never persisted. */
  ewfHeadcountOverrides?: Record<string, number>;
  /**
   * Display names for cost centres (branch id -> branch name), loaded from
   * `branches.name`. Replaces the prototype's hard-coded branch-name maps
   * (company-outputs.ts:21, company-pay-explanation.ts:4-6). Display only:
   * no number reads it.
   */
  costCentreNames?: Record<string, string>;
}

export const PAYROLL_PROTOTYPE_SCHEMA_VERSION = 14 as const;

/**
 * A casual worker. The prototype tested the role string "Casual"
 * (calculations.ts:267, 419, 486; run-calculations.ts:447, 455, 870, 878);
 * a payroll profile's worker type is the real answer, and the role string
 * stays the fallback for a person without a profile.
 */
export function isCasualStaff(staff: StaffMember): boolean {
  return staff.payrollProfile ? staff.payrollProfile.workerType === "day-rate" : staff.role === "Casual";
}
