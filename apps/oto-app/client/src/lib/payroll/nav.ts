/**
 * The company payroll's navigation (SCRUM-572, R7): one table read by the hub
 * page, the sidebar, the router's redirects and tests/payroll-cutover.check.ts,
 * so the three never disagree about where a payroll screen lives or who sees it.
 *
 * Who sees what (PLAN §7 Permissions): payroll roles (`hr.view_salary`, which
 * is admin, operator_admin and global_admin) see every hub entry; every other
 * signed-in employee, managers included, sees their own locked payslips only.
 * Managers keep timekeeping approval and see no pay figures.
 *
 * Pure: no React, no icons, nothing that needs a browser.
 */
import { canViewHrSalary } from "@shared/hr-salary-permission";

export const PAYROLL_PATHS = {
  hub: "/payroll",
  run: "/payroll/month-end",
  setup: "/payroll/setup",
  rewards: "/payroll/setup/rewards",
  people: "/payroll/people",
  history: "/payroll/history",
  /** R5 (outputs and downloads) registers this page; until it lands the link 404s. */
  downloads: "/payroll/downloads",
  /** R6 (statutory documents) registers this page; until it lands the link 404s. */
  documents: "/payroll/statutory",
  myPayslips: "/payroll/me/payslips",
} as const;

export type PayrollEntryId = "hub" | "run" | "people" | "history" | "downloads" | "documents" | "setup" | "myPayslips";

export interface PayrollEntry {
  id: PayrollEntryId;
  title: string;
  /** The hub card's one line. */
  description: string;
  url: string;
  /** Payroll roles only (hr.view_salary). The rest is every signed-in employee's own. */
  payrollRole: boolean;
  /** Active only on its own address (the hub would otherwise light up under every payroll page). */
  exact?: boolean;
  /** The round whose lane registers the page, while it is still to land. */
  landsWith?: "R5" | "R6";
}

/** In the prototype hub's order: run the month, look back, then the set-up behind it. */
export const PAYROLL_ENTRIES: readonly PayrollEntry[] = [
  { id: "hub", title: "Payroll", description: "Where the month stands and every payroll page.", url: PAYROLL_PATHS.hub, payrollRole: true, exact: true },
  { id: "run", title: "Run Payroll", description: "Attendance, the month's numbers, check the month, then GM confirm and Owner lock.", url: PAYROLL_PATHS.run, payrollRole: true },
  { id: "people", title: "Payroll Profiles", description: "One profile per person: job, branch split, pay method, extras and deductions.", url: PAYROLL_PATHS.people, payrollRole: true },
  { id: "history", title: "History & Payslips", description: "Every locked month as it was frozen, with each person's payslip.", url: PAYROLL_PATHS.history, payrollRole: true },
  { id: "downloads", title: "Downloads", description: "Bank, SSO, welfare-fund and report files of a locked month.", url: PAYROLL_PATHS.downloads, payrollRole: true, landsWith: "R5" },
  { id: "documents", title: "Statutory Documents", description: "PND.1, PND.1ก, 50 ทวิ, SSO and welfare-fund documents with their deadlines.", url: PAYROLL_PATHS.documents, payrollRole: true, landsWith: "R6" },
  { id: "setup", title: "Payroll Setup", description: "Companies, bank accounts, branch details, rates, deductions, service charge and incentives.", url: PAYROLL_PATHS.setup, payrollRole: true },
  { id: "myPayslips", title: "My Payslips", description: "Your own payslip for every locked month.", url: PAYROLL_PATHS.myPayslips, payrollRole: false },
];

/** The sidebar's Payroll section for a role. */
export function payrollMenuFor(role: string | null | undefined): PayrollEntry[] {
  if (!role) return [];
  const payroll = canViewHrSalary(role);
  return PAYROLL_ENTRIES.filter((entry) => payroll || !entry.payrollRole);
}

/** The hub's cards: every payroll-role entry but the hub itself. */
export const PAYROLL_HUB_CARDS: readonly PayrollEntry[] = PAYROLL_ENTRIES.filter((entry) => entry.payrollRole && entry.id !== "hub");

/**
 * The pre-R7 payroll screens (PLAN §7 "Old pages"), each address sent to its
 * new home so no bookmark or old link is ever dead. The old /api/payroll
 * routes stay until R8; only the screens are gone. Old run and period ids
 * mean nothing to the company payroll, so they are dropped; an old
 * employee id is the same employees.id the profiles use.
 */
export interface PayrollRedirect {
  from: string;
  /** The old screen's name, for the report and the check. */
  was: string;
  to: (params: Record<string, string | undefined>) => string;
}

export const OLD_PAYROLL_REDIRECTS: readonly PayrollRedirect[] = [
  { from: "/payroll/periods", was: "payroll-periods", to: () => PAYROLL_PATHS.history },
  { from: "/payroll/periods/:periodId", was: "payroll-period-detail", to: () => PAYROLL_PATHS.history },
  { from: "/payroll/runs/:runId", was: "payroll-run-detail", to: () => PAYROLL_PATHS.run },
  { from: "/payroll/runs/:runId/exceptions", was: "payroll-exceptions", to: () => `${PAYROLL_PATHS.run}?tab=preview` },
  { from: "/payroll/runs/:runId/exceptions/:exceptionId", was: "payroll-exception-detail", to: () => `${PAYROLL_PATHS.run}?tab=preview` },
  { from: "/payroll/runs/:runId/employees", was: "payroll-employees", to: () => PAYROLL_PATHS.people },
  { from: "/payroll/runs/:runId/employees/:employeeId", was: "payroll-employee-detail", to: (p) => p.employeeId ? `${PAYROLL_PATHS.people}/${encodeURIComponent(p.employeeId)}` : PAYROLL_PATHS.people },
  { from: "/payroll/runs/:runId/exports", was: "payroll-exports", to: () => PAYROLL_PATHS.history },
  { from: "/payroll/statutory-rules", was: "payroll-statutory-rules", to: () => `${PAYROLL_PATHS.setup}?tab=statutory` },
  { from: "/my-payslips", was: "my-payslips", to: () => PAYROLL_PATHS.myPayslips },
];

/**
 * Where an old address sends this person: its new home for a payroll role;
 * their own payslips for anyone else (the old overview and exception pages
 * were open to managers, who now have no payroll screen but their own slips).
 */
export function redirectTarget(redirect: PayrollRedirect, params: Record<string, string | undefined>, role: string | null | undefined): string {
  const target = redirect.to(params);
  return target === PAYROLL_PATHS.myPayslips || canViewHrSalary(role) ? target : PAYROLL_PATHS.myPayslips;
}
