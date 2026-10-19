// The September golden fixture, ported from the payroll prototype
// (imports/oto-app/client/src/lib/payroll-prototype/september-golden-fixture.ts).
// The people, inputs, rules and run lines are the prototype's, verbatim. Two
// things change, neither moving a number:
//   - The prototype started from its whole browser seed (`createSeedData()`)
//     and emptied it. That seed does not exist here, so the world it left
//     behind is built directly: the two Thai branches' details, lifecycle and
//     leave policy as the seed had them, the Thai rules template
//     (engine/defaults.ts `countryRulesTemplate`, seeds.ts:259-336) with the
//     fixture's own overrides (allowances [], SSO 5%/5%/฿17,500,
//     `deductionRules: []`), and the paying entity with its two SCB accounts.
//     The legacy-only collections (revenue, booth roster and vouchers, role
//     incentive defaults) are passed empty, as the world loader will pass them
//     (plan §2).
//   - The fictional Malaysian branch is dropped (plan §4). It only carried zero
//     revenue and an unused service policy (prototype :78-86).
import { makePayrollProfile, WORKER_DEFAULTS, type AllocationLine, type WorkerType } from "../engine/payroll-profile";
import { newCompanyDraft } from "../engine/company-workflow";
import { countryRulesTemplate } from "../engine/defaults";
import type { BranchDetails, BranchId, BranchRecord, LeavePolicy, PayrollWorld, StaffMember } from "../engine/model";
import type { CompanyIncentive, CompanyPayrollDocument, CompanyRevenue } from "../engine/company-model";

export const GOLDEN_MONTH = "2026-09";
export const GOLDEN_ENTITY = "tt-concept";
export const GOLDEN_NANNY_DAYS = [18, 21, 12, 19, 18, 18, 18];
const C: BranchId = "hkt-central", H: BranchId = "hkt-chalong";

/** The Thai leave policy the prototype seed carried on both branches; payroll reads only the types' names and paid flags. */
const THAI_LEAVE_POLICY: LeavePolicy = {
  country: "TH",
  types: [
    { id: "annual", name: "Annual leave", paid: true, annualEntitlement: 8, accrualMethod: "monthly", prorateJoiners: true, waitingMonths: 6, carryForwardCap: 5, carryExpiryMonths: 3, allowNegative: false, paidOutOnExit: true },
    { id: "sick", name: "Sick leave", paid: true, annualEntitlement: 30, accrualMethod: "upfront", prorateJoiners: false, waitingMonths: 0, carryForwardCap: 0, carryExpiryMonths: null, allowNegative: false, paidOutOnExit: false, prorateByDefault: false, certificateAfterConsecutiveDays: 3 },
    { id: "business", name: "Business leave", paid: true, annualEntitlement: 3, accrualMethod: "upfront", prorateJoiners: true, waitingMonths: 0, carryForwardCap: 0, carryExpiryMonths: null, allowNegative: false, paidOutOnExit: false },
    { id: "days-off", name: "Days Off", paid: true, annualEntitlement: 0, accrualMethod: "confirmed-days", prorateJoiners: false, waitingMonths: 0, carryForwardCap: 0, carryExpiryMonths: null, allowNegative: false, paidOutOnExit: false },
    { id: "unpaid", name: "Unpaid leave", paid: false, annualEntitlement: 0, accrualMethod: "upfront", prorateJoiners: false, waitingMonths: 0, carryForwardCap: 0, carryExpiryMonths: null, allowNegative: true, paidOutOnExit: false },
    { id: "training", name: "Training", paid: true, annualEntitlement: 0, accrualMethod: "upfront", prorateJoiners: false, waitingMonths: 0, carryForwardCap: 0, carryExpiryMonths: null, allowNegative: true, paidOutOnExit: false },
    { id: "other", name: "Other", paid: true, annualEntitlement: 0, accrualMethod: "upfront", prorateJoiners: false, waitingMonths: 0, carryForwardCap: 0, carryExpiryMonths: null, allowNegative: true, paidOutOnExit: false },
  ],
  publicHolidays: ["2026-01-01", "2026-02-12", "2026-04-06", "2026-04-13", "2026-04-14", "2026-04-15", "2026-05-01", "2026-05-04", "2026-06-03", "2026-07-28", "2026-08-12", "2026-10-13", "2026-12-05"],
  daysOff: { earnedDays: 2, workedDays: 5 },
};

const details = (name: string, address: string, defaultPayingAccountId: string, ssoBranchNumber: string): BranchDetails => ({
  name, legalEntity: "T&T Concept Co., Ltd.", employerNumber: "8320990001", taxId: "TH-DEMO-TT-001", address,
  country: "TH", currency: "THB", timezone: "Asia/Bangkok", payDate: "last", payrollBank: "SCB · fictional account",
  approvalChain: ["GM", "Owner"], payingEntityId: GOLDEN_ENTITY, defaultPayingAccountId, ssoBranchNumber,
});

function branch(id: BranchId, branchDetails: BranchDetails, openedOn: string): BranchRecord {
  const rules = countryRulesTemplate("TH", "2025-01");
  return {
    id, staff: [],
    detailsHistory: [{ effectiveFrom: "2025-01", details: branchDetails }],
    lifecycleHistory: [{ effectiveFrom: "2025-01", openedOn, closedOn: null }],
    rulesHistory: [{ ...rules, allowances: [], thSso: { ...rules.thSso, employeeRate: .05, employerRate: .05, wageCap: 17500 } }],
    incentiveRules: [], deductionRules: [], employeeIncentivePlans: [], roleIncentiveDefaults: [],
    voucherSettings: { method: "percent", value: 0.05 },
    leavePolicyHistory: [{ effectiveFrom: "2025-01-01", policy: structuredClone(THAI_LEAVE_POLICY), reason: "Initial country defaults", who: "System seed", when: "2026-01-01T00:00:00.000Z" }],
  };
}

/** The world the prototype's emptied seed left behind, for the two Thai branches. */
export function goldenBaseWorld(): PayrollWorld {
  const account = (id: string, label: string, accountNumber: string) => ({
    id, entityId: GOLDEN_ENTITY, label, bank: "SCB", accountNumber, accountName: "T&T Concept Co., Ltd. — DEMO",
    fileFormat: "SCB" as const, bankCode: "014", debitAccount: accountNumber, feeAccount: accountNumber, scbProduct: "PAY" as const,
  });
  return {
    schemaVersion: 14,
    branches: {
      [C]: branch(C, details("HKT Central", "Central Phuket, Wichit, Phuket 83000, Thailand", "tt-central-scb", "830002"), "2018-06-01"),
      [H]: branch(H, details("HKT Chalong", "Chalong, Mueang Phuket, Phuket 83130, Thailand", "tt-chalong-scb", "830001"), "2019-03-01"),
    },
    costCentreNames: { [C]: "Central", [H]: "Chalong" },
    payingEntities: [{ id: GOLDEN_ENTITY, name: "T&T Concept Co., Ltd.", country: "TH", taxId: "TH-DEMO-TT-001", ssoEmployerNumber: "8320990001" }],
    payingAccounts: [account("tt-central-scb", "Central payroll · DEMO", "9901000001"), account("tt-chalong-scb", "Chalong payroll · DEMO", "9901000002")],
    revenue: [], attendance: [], changelog: [], manualFigures: [], runDrafts: {}, runAudits: [], runSnapshots: [], runOutputStatuses: [],
    boothRoster: [], boothVouchers: [], incentiveChanges: [], statutoryDocuments: [], statutoryAudits: [],
    leaveLedger: [], otBankBookings: [], leavePolicyChanges: [], leaveOffboarding: [], leaveNegativeDecisions: [],
    ewfSettings: [], ewfChanges: [], ewfRemittances: [], ewfOffboardingChecklists: [],
  };
}

/** Fresh, isolated fictional people. Nothing is read from or written to a database. */
export function buildSeptemberGoldenFixture() {
  const data = goldenBaseWorld();
  const doc: CompanyPayrollDocument = { version: 1, servicePolicies: {}, incentives: [], months: {}, runs: {}, snapshots: [], audit: [] };
  data.companyPayroll = doc;
  const line = (branch: AllocationLine["costCentre"], percent: number): AllocationLine =>
    ({ costCentre: branch, percent, entityId: GOLDEN_ENTITY, payingAccountId: branch === H ? "tt-chalong-scb" : "tt-central-scb" });
  const shared = [line(C, 70), line(H, 30)];
  function person(id: string, name: string, home: BranchId, salary: number, sc = true, food = false, type: WorkerType = "monthly") {
    const s: StaffMember = { id, name: `Fictional ${name}`, employeeNumber: `GOLD-${id}`, taxId: `DEMO-TAX-${id}`,
      role: "Floor Attendant", employmentType: "local", nationality: "Thai", monthlySalary: salary, dayRate: null,
      joinedOn: "2024-01-01", leftOn: null, probationEndsOn: "2024-04-01", scheduledDaysPerWeek: 5,
      otEligible: false, serviceChargeEligible: sc, serviceRoleWeight: 1, ewfMembership: null };
    const p = makePayrollProfile(s, home, GOLDEN_ENTITY, 60);
    Object.assign(p, WORKER_DEFAULTS[type], { workerType: type, jobTitle: name, monthlySalary: type === "contractor" ? 0 : salary,
      fixedFee: type === "contractor" ? salary : 0, pnd1Eligible: false, serviceChargeEligible: sc,
      foodAllowanceEligible: food, foodAllowancePerDay: 60, otEligible: false,
      bankDetails: { bank: "SCB", accountNumber: `DEMO-GOLD-${id}`, accountName: s.name },
      advances: [], separatePayments: [], studentLoanMonthly: 0, notes: "Isolated September golden-test fixture." });
    p.allocations[0].lines = [line(home, 100)];
    s.payrollProfile = p; data.branches[home].staff.push(s);
    return s;
  }
  const gm = person("gold-gm", "Mali / GM", C, 70000);
  gm.payrollProfile!.allocations[0].lines = structuredClone(shared);
  gm.payrollProfile!.pnd1Eligible = true;
  gm.payrollProfile!.advances = [{ id: "gold-advance", principal: 5000, outstandingBalance: 5000,
    repaymentMode: "one-off", instalments: 1, monthlyRepayment: 5000, startsOn: "2026-09-01" }];
  person("gold-ops-c", "Niran / Central Ops", C, 38000);
  person("gold-ops-h", "Kanda / Chalong Ops", H, 38000);
  const event = person("gold-event", "Lina / Events", H, 40000);
  event.payrollProfile!.allocations[0].lines = structuredClone(shared);
  GOLDEN_NANNY_DAYS.forEach((_, i) => person(`gold-nanny-${i + 1}`, `Nanny ${i + 1}`, C, 16000, false, true));
  person("gold-regular-c", "Suda / Central regular", C, 24000, true, true);
  person("gold-regular-h", "Dara / Chalong regular", H, 22000, true, true);
  person("gold-low", "Anan / Low earner", C, 14000, false);
  const chef = person("gold-chef", "Som / Contractor chef", H, 100000, true, false, "contractor");
  chef.payrollProfile!.allocations[0].lines = structuredClone(shared);
  person("gold-loan", "Pran / Student loan", C, 22000).payrollProfile!.studentLoanMonthly = 886;
  const ads = person("gold-ads", "Orchid / Ads agency", C, 60000, false, false, "contractor");
  Object.assign(ads.payrollProfile!, { paymentMethod: "cash", cashHandlingFeePercent: 7, pnd3WithholdingPercent: 0 });
  ads.payrollProfile!.allocations[0].lines = structuredClone(shared);

  // User supplied branch denominators, not the complete earning-month roster.
  // Complete them with explicit fictional prior-month leavers; no invented current salary.
  function prior(id: string, home: BranchId, percent = 100) {
    const s = person(id, `August roster ${id}`, home, 0);
    Object.assign(s.payrollProfile!, { lastWorkingDay: "2026-08-31", ssoEligible: false, pnd1Eligible: false });
    s.leftOn = "2026-08-31";
    if (percent !== 100) s.payrollProfile!.allocations[0].lines = [line(home, percent), line("owner-non-operational", 100 - percent)];
  }
  for (let i = 1; i <= 27; i++) prior(`gold-prior-c-${i}`, C);
  prior("gold-prior-c-fraction", C, 30);
  for (let i = 1; i <= 10; i++) prior(`gold-prior-h-${i}`, H);

  const input = (values: Record<string, number>): CompanyRevenue =>
    ({ streams: Object.fromEntries(Object.entries(values).map(([key, amount]) => [key, { amount, vat: 0, serviceCharge: 0 }])), discounts: {} });
  doc.months["2026-08"] = { revenue: { [C]: input({ "sc-pool": 97277.01 }), [H]: input({ "sc-pool": 40237.06 }) }, staff: {}, counts: {} };
  doc.months[GOLDEN_MONTH] = { revenue: {
    [C]: input({ net: 3724034.38, birthday: 441918.62, "nanny-pool": 19690.82 }),
    [H]: input({ net: 993561.12, birthday: 0, "nanny-pool": 0 }),
  }, staff: {}, counts: {} };
  for (const b of [C, H]) doc.servicePolicies[b] = [{
    effectiveFrom: "2024-01-01", percent: 100, basis: "calendar", excluded: b === C ? "retain" : "remove",
    streams: ["sc-pool"], addBack: [], roleWeights: {},
  }];
  const staffInput = (id: string, daysWorked: number) =>
    doc.months[GOLDEN_MONTH].staff[id] = { daysWorked, units: {}, kpis: {}, bonuses: {} };
  GOLDEN_NANNY_DAYS.forEach((days, i) => staffInput(`gold-nanny-${i + 1}`, days));
  staffInput("gold-regular-c", 19); staffInput("gold-regular-h", 15);
  doc.months[GOLDEN_MONTH].staff["gold-chef"] = { units: {}, kpis: {}, bonuses: {}, pnd3Basis: "fee-only" };
  function rule(id: string, name: string, staffIds: string[], branches: BranchId[], streams: string[], rate: number, target: number | null, kind: CompanyIncentive["kind"] = "revenue") {
    doc.incentives.push({ id, name, staffIds, kind, base: { branches, streams, addBack: [] }, rate, target,
      cap: null, effectiveFrom: "2024-01-01", effectiveTo: null, inputKey: "", kpiOperator: "lt", kpiTarget: 0 });
  }
  rule("gold-gm-share", "GM combined revenue", [gm.id], [C, H], ["net"], .4, 4500000);
  rule("gold-ops-c-share", "Central operations revenue", ["gold-ops-c"], [C], ["net"], .2, 3500000);
  rule("gold-ops-h-share", "Chalong operations revenue", ["gold-ops-h"], [H], ["net"], .2, 1000000);
  rule("gold-birthdays", "Birthday revenue", [event.id], [C, H], ["birthday"], 2, null);
  rule("gold-nanny-pool", "Supplied nanny team pool", GOLDEN_NANNY_DAYS.map((_, i) => `gold-nanny-${i + 1}`), [C, H], ["nanny-pool"], 100, null, "team-days");
  const run = newCompanyDraft(GOLDEN_ENTITY, GOLDEN_MONTH);
  run.overrides = [{ staffId: gm.id, entityId: GOLDEN_ENTITY, component: "pnd1", amount: 3200, reason: "Supplied September golden-test manual PND.1 input." }];
  run.manual = [{ id: "gold-bonus-c", staffId: "gold-regular-c", amount: 2064.52, kind: "bonus", reason: "Supplied Central September manual bonus." },
    { id: "gold-bonus-h", staffId: "gold-regular-h", amount: 2000, kind: "bonus", reason: "Supplied Chalong September manual bonus." }];
  doc.runs[`${GOLDEN_ENTITY}:${GOLDEN_MONTH}`] = run;
  return { data, doc };
}
