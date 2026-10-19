// The statutory and pay-rule template, ported from the payroll prototype's
// seeds (imports/oto-app/client/src/lib/payroll-prototype/seeds.ts:235-336,
// `THAI_DEFAULT_PIT_BRACKETS`, `MALAYSIA_DEFAULT_RESIDENT_PCB_BRACKETS` and
// `defaultRules`, here `countryRulesTemplate`), verbatim. Nothing seeds a
// database from it in R1; R2's Thai `company-v1` rule set is entered from it.
// The MY template stays because the `StatutoryRules` type keeps its `my`
// block (dormant: no MY row exists anywhere).
import type { CountryCode, StatutoryRules, TaxBracket } from "./model";
import { createDefaultOvertimePolicy } from "./ot-bank";

export const THAI_DEFAULT_PIT_BRACKETS: TaxBracket[] = [
  { from: 0, to: 150000, rate: 0 },
  { from: 150000, to: 300000, rate: 0.05 },
  { from: 300000, to: 500000, rate: 0.1 },
  { from: 500000, to: 750000, rate: 0.15 },
  { from: 750000, to: 1000000, rate: 0.2 },
  { from: 1000000, to: 2000000, rate: 0.25 },
  { from: 2000000, to: 5000000, rate: 0.3 },
  { from: 5000000, to: null, rate: 0.35 },
];

export const MALAYSIA_DEFAULT_RESIDENT_PCB_BRACKETS: TaxBracket[] = [
  { from: 0, to: 5000, rate: 0 },
  { from: 5000, to: 20000, rate: 0.01 },
  { from: 20000, to: 35000, rate: 0.03 },
  { from: 35000, to: 50000, rate: 0.06 },
  { from: 50000, to: 70000, rate: 0.11 },
  { from: 70000, to: 100000, rate: 0.19 },
  { from: 100000, to: 400000, rate: 0.25 },
  { from: 400000, to: 600000, rate: 0.26 },
  { from: 600000, to: 2000000, rate: 0.28 },
  { from: 2000000, to: null, rate: 0.3 },
];

export const countryRulesTemplate = (country: CountryCode, effectiveFrom = "2025-01"): StatutoryRules => ({
  effectiveFrom,
  country,
  thSso: { wageCap: 17500, employeeRate: 0.05, employerRate: 0.05, wholeBahtRounding: "half-up" },
  thPit: {
    brackets: structuredClone(THAI_DEFAULT_PIT_BRACKETS),
    employmentExpenseRate: 0.5,
    employmentExpenseCap: 100000,
    personalAllowance: 60000,
  },
  my: {
    epfLocalEmployeeRate: 0.11,
    epfEmployerThreshold: 5000,
    epfLocalEmployerRateAtOrBelow5000: 0.13,
    epfLocalEmployerRateAbove5000: 0.12,
    epfForeignEmployeeRate: 0.02,
    epfForeignEmployerRate: 0.02,
    socsoWageCap: 6000,
    socsoLocalEmployeeRate: 0.005,
    socsoLocalEmployerRate: 0.0175,
    socsoForeignEmployeeRate: 0,
    socsoForeignEmployerRate: 0.0125,
    eisWageCap: 6000,
    eisLocalEmployeeRate: 0.002,
    eisLocalEmployerRate: 0.002,
    hrdEmployerRate: 0.01,
    hrdEnabled: false,
    malaysianEmployeeHeadcount: country === "MY" ? 7 : 0,
    nonResidentPcbRate: 0.3,
    residentSelfRelief: 9000,
    residentPcbBrackets: structuredClone(MALAYSIA_DEFAULT_RESIDENT_PCB_BRACKETS),
  },
  serviceCharge: {
    rate: 0.05,
    revenueStreams: ["tickets", "eventsParties", "cafeFnb", "retail", "memberships"],
    payoutLagMonths: 1,
    allocation: "days",
    minimumDays: 1,
    probationRequired: false,
    includeCasuals: true,
    roleWeights: {},
    customPercentByStaffId: {},
  },
  lunchByRole: {
    "Floor Attendant": country === "TH" ? 60 : 10,
    Cashier: country === "TH" ? 60 : 10,
    "Events & Sales": country === "TH" ? 60 : 10,
    Supervisor: country === "TH" ? 60 : 10,
    "Branch Manager": country === "TH" ? 60 : 10,
    Casual: country === "TH" ? 60 : 10,
  },
  overtimeMultipliers: { regular: 1.5, restDay: 2, publicHoliday: 3 },
  overtimePolicy: createDefaultOvertimePolicy(),
  overtimeEligibilityByRole: {
    "Floor Attendant": true,
    Cashier: true,
    "Events & Sales": false,
    Supervisor: false,
    "Branch Manager": false,
    Casual: true,
  },
  hourlyBase: { monthlySalaryDays: 30, monthlyHoursPerDay: 8, casualDayHours: 8 },
  calendarProration: { method: "actual-calendar-days", divisor: 30 },
  allowances: [
    { id: "transport", name: "Transport allowance", amount: country === "TH" ? 1200 : 250, taxable: true, socialSecurity: true },
  ],
  componentFlags: {
    baseSalary: { taxable: true, socialSecurity: true, ewfWage: true, ewfReason: "Normal salary is illustrative normal-work wage." },
    serviceCharge: { taxable: true, socialSecurity: true, ewfWage: false, ewfReason: "Service charge classification requires accountant confirmation." },
    overtime: { taxable: true, socialSecurity: true, ewfWage: false, ewfReason: "Overtime is outside normal working hours." },
    lunch: { taxable: false, socialSecurity: false, ewfWage: false, ewfReason: "Welfare/meal benefit is excluded in this illustration." },
    paidLeave: { taxable: true, socialSecurity: true, ewfWage: true, ewfReason: "Paid leave is included as normal paid wages." },
    holidayPay: { taxable: true, socialSecurity: true, ewfWage: true, ewfReason: "Paid holidays are included as normal paid wages." },
    exitLeavePayout: { taxable: true, socialSecurity: false, ewfWage: false, ewfReason: "Unused-leave exit payout is a settlement; accountant review required." },
    boothVoucher: { taxable: true, socialSecurity: false, ewfWage: false, ewfReason: "Booth vouchers require accountant confirmation." },
    "allowance:transport": { taxable: true, socialSecurity: true, ewfWage: false, ewfReason: "Transport/expense allowance is excluded unless confirmed as fixed fuel/position pay." },
  },
});
