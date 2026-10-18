/**
 * Who may see and change an employee's pay (SCRUM-559, ported from the upstream
 * app's shared/hr-salary-permission.ts and adapted).
 *
 * Upstream decides on a bare list of role strings, two of which ("owner",
 * "payroll_admin") do not exist here. This app has a permission engine, so the
 * decision is that engine's: `hr.view_salary` is an admin-only action, which
 * canPerformAction allows to admin and global_admin (bypass) and operator_admin
 * (admin-only actions), and refuses to manager and staff. An advisor arrives
 * as its effective role (resolveAdvisorRole), and a raw "advisor" or any
 * unknown string falls to staff inside the engine.
 *
 * It keys off the authenticated effective role only — module overrides widen
 * or narrow modules, and no override can grant an admin-only action — so the
 * check needs no database read and the client can ask the same question of
 * the signed-in user.
 */
import { canPerformAction, type PermissionRole } from "./permissions";

export const HR_VIEW_SALARY_ACTION = "hr.view_salary";

/** The note shown where a pay field is withheld. */
export const HR_PAY_HIDDEN_NOTE = "Visible to payroll roles only";

export function canViewHrSalary(role: string | null | undefined): boolean {
  if (!role) return false;
  return canPerformAction(
    { userId: "", role: role as PermissionRole, homeBranchId: null, overrides: [] },
    HR_VIEW_SALARY_ACTION,
    "hr",
  ).allowed;
}

/** Compared lower-cased, wherever the key sits in the JSON. */
const PAY_KEYS = new Set([
  "salary", "salarythb", "monthlysalary", "basesalary", "monthlypay", "fixedfee",
  "dailyrate", "dayrate", "payrate", "hourlyrate", "oldsalary", "newsalary",
  "foodallowanceperday", "foodallowance", "incentiveclausetext", "incentiveclause",
  "oldincentiveclause", "newincentiveclause", "studentloanmonthly",
  "advances", "separatepayments", "grosspay", "netpay",
]);

export function isHrPayKey(key: string): boolean {
  return PAY_KEYS.has(key.toLowerCase());
}

/** Shape-preserving redaction for HR employee/list/change JSON, without mutating stored records. */
export function redactHrPay<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => redactHrPay(item)) as T;
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!PAY_KEYS.has(key.toLowerCase())) result[key] = redactHrPay(item);
  }
  // Salary/incentive change notes can repeat the amount in free text.
  if (/salary|incentive/i.test(String(result.changeType ?? ""))) {
    delete result.note;
    delete result.notes;
  }
  return result as T;
}

export function hrPayResponse<T>(value: T, role: string | null | undefined): T {
  return canViewHrSalary(role) ? value : redactHrPay(value);
}

/** A redacted form must not erase pay operands when it saves ordinary HR fields. */
export function preserveHrMergePay(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const preserved = Object.fromEntries(
    Object.entries(previous ?? {}).filter(([key]) => PAY_KEYS.has(key.toLowerCase()) && !(key in next)),
  );
  return { ...preserved, ...next };
}

export function containsHrPayFields(value: unknown): boolean {
  if (!value || typeof value !== "object" || value instanceof Date) return false;
  return Object.entries(value).some(([key, item]) => PAY_KEYS.has(key.toLowerCase()) || containsHrPayFields(item));
}
