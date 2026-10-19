/**
 * The company payroll's routes (SCRUM-567 onward; plan §7 and §9). R3 (SCRUM-568)
 * adds month inputs, rewards setup, the payroll feeds and the month-end draft
 * with its read-only preview.
 *
 * Every route here is behind `hr.view_salary` (managers and staff get 403 on
 * all of them), writes need `hr.manage_payroll`, and the HR-data draft action
 * is global_admin's. Each is fenced by its own `parkGroupOnly` and every query
 * filters by `parkGroupOf(res)`: a row of another park group is a 404. This
 * module does not rely on the old `app.use('/api/payroll', …)` middleware in
 * server/routes.ts and is registered before it.
 *
 * Each registration names its permission key in the `payroll("…")` call on
 * the same line; the API census (apps/api/test/s217b-r7-payroll-cross-review
 * .test.ts) reads this file and pins the list, in order, with those keys.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { canViewHrSalary } from "@shared/hr-salary-permission";
import { canDraftPayrollProfiles, canManagePayroll } from "@shared/payroll-config";
import { parkGroupOf, parkGroupOnly, type CallerParkGroup } from "../lib/routeFences";
import {
  PayrollRefusal,
  archiveAccount,
  archiveEntity,
  createAccount,
  createEntity,
  createRevenueStream,
  listSetupChanges,
  loadSetup,
  saveBranchDetails,
  saveDeductionList,
  saveEwfRemittance,
  saveEwfSettings,
  saveRuleSet,
  updateAccount,
  updateEntity,
  updateRevenueStream,
  type PayrollActor,
} from "./setup";
import { draftProfiles, loadProfileView, loadRoster, saveProfile } from "./profiles";
import { loadMonthInputsView, overrideMonthInput, saveBranchRevenue, saveStaffMonthInput } from "./inputs";
import { loadRewardsView, saveIncentive, saveServicePolicy } from "./rewards";
import { bookOtTimeOff, loadFeedsView, recordLeaveValuation, reverseLeaveValuation, saveOffboarding } from "./feeds";
import { addManualLine, addOverride, loadMonthEnd, previewMonth, recordReview, removeManualLine, removeOverride, startRun } from "./month-end";

export type PayrollPermission = "hr.view_salary" | "hr.manage_payroll" | "payroll.draft_profiles";

interface PayrollRouteDependencies {
  requireAuth: RequestHandler;
  /** The app's strict park-group rule (userManagementTenant in server/routes.ts). */
  callerParkGroup: CallerParkGroup;
}

const roleOf = (req: Request) => req.userWithAccess?.role ?? req.user?.role;

/** The permission a route needs, decided by the permission engine on the effective role. */
export function payrollAllows(permission: PayrollPermission, role: string | null | undefined): boolean {
  if (!canViewHrSalary(role)) return false;
  if (permission === "hr.view_salary") return true;
  if (permission === "hr.manage_payroll") return canManagePayroll(role);
  return canDraftPayrollProfiles(role);
}

function payroll(permission: PayrollPermission): RequestHandler {
  return (req, res, next) => {
    if (!payrollAllows(permission, roleOf(req))) {
      res.status(403).json({ message: `Payroll is for payroll roles only (${permission} required).` });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

const actorOf = (req: Request): PayrollActor => {
  const user = req.user as { id: string; fullName?: string | null; email?: string | null };
  return { userId: user.id, name: user.fullName?.trim() || user.email || user.id };
};

/** Today in the park's timezone (plan §8: month pickers ask the server, not the browser). */
export function payrollToday(timeZone = "Asia/Bangkok"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const asOfOf = (req: Request) => {
  const asOf = typeof req.query.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : null;
  return asOf ?? payrollToday();
};

type Handler = (req: Request, res: Response) => Promise<unknown>;
const answer = (status: number, work: Handler): RequestHandler => async (req, res, next: NextFunction) => {
  try {
    const body = await work(req, res);
    res.status(status).json(body);
  } catch (error) {
    if (error instanceof PayrollRefusal) {
      res.status(error.status).json({ message: error.message, ...(error.errors ? { errors: error.errors } : {}) });
      return;
    }
    next(error);
  }
};
const body = (req: Request) => (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

export function registerPayrollRoutes(app: Express, { requireAuth, callerParkGroup }: PayrollRouteDependencies): void {
  const fence = parkGroupOnly(callerParkGroup);
  const role = (req: Request) => roleOf(req);

  // ── Setup ──
  app.get("/api/payroll/setup", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req, res) =>
    ({ ...(await loadSetup(parkGroupOf(res))), canManage: canManagePayroll(role(req)) })));
  app.get("/api/payroll/setup/changes", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req, res) =>
    listSetupChanges(parkGroupOf(res), Number(req.query.limit) || 100)));
  app.post("/api/payroll/setup/entities", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    createEntity(parkGroupOf(res), actorOf(req), body(req))));
  app.patch("/api/payroll/setup/entities/:id", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    updateEntity(parkGroupOf(res), actorOf(req), req.params.id, body(req))));
  app.post("/api/payroll/setup/entities/:id/archive", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    archiveEntity(parkGroupOf(res), actorOf(req), req.params.id, body(req))));
  app.post("/api/payroll/setup/accounts", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    createAccount(parkGroupOf(res), actorOf(req), body(req))));
  app.patch("/api/payroll/setup/accounts/:id", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    updateAccount(parkGroupOf(res), actorOf(req), req.params.id, body(req))));
  app.post("/api/payroll/setup/accounts/:id/archive", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    archiveAccount(parkGroupOf(res), actorOf(req), req.params.id, body(req))));
  app.post("/api/payroll/setup/branches/:branchId/details", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveBranchDetails(parkGroupOf(res), actorOf(req), req.params.branchId, body(req))));
  app.post("/api/payroll/setup/rule-sets", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveRuleSet(parkGroupOf(res), actorOf(req), body(req))));
  app.post("/api/payroll/setup/deduction-lists", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveDeductionList(parkGroupOf(res), actorOf(req), body(req))));
  app.post("/api/payroll/setup/ewf-settings", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveEwfSettings(parkGroupOf(res), actorOf(req), body(req))));
  app.put("/api/payroll/setup/ewf-remittances", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveEwfRemittance(parkGroupOf(res), actorOf(req), body(req))));
  app.post("/api/payroll/setup/revenue-streams", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    createRevenueStream(parkGroupOf(res), actorOf(req), body(req))));
  app.patch("/api/payroll/setup/revenue-streams/:id", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    updateRevenueStream(parkGroupOf(res), actorOf(req), req.params.id, body(req))));

  // ── Profiles ──
  app.get("/api/payroll/profiles", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req, res) =>
    ({ ...(await loadRoster(parkGroupOf(res), asOfOf(req))), canManage: canManagePayroll(role(req)), canDraft: canDraftPayrollProfiles(role(req)) })));
  app.post("/api/payroll/profiles/drafts", requireAuth, payroll("payroll.draft_profiles"), fence, answer(200, (req, res) =>
    draftProfiles(parkGroupOf(res), actorOf(req), body(req))));
  app.get("/api/payroll/profiles/:employeeId", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req, res) =>
    ({ ...(await loadProfileView(parkGroupOf(res), req.params.employeeId, asOfOf(req))), canManage: canManagePayroll(role(req)) })));
  app.put("/api/payroll/profiles/:employeeId", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveProfile(parkGroupOf(res), actorOf(req), req.params.employeeId, body(req))));

  // ── Month inputs (R3) ──
  app.get("/api/payroll/inputs/:month", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req, res) =>
    ({ ...(await loadMonthInputsView(parkGroupOf(res), req.params.month)), canManage: canManagePayroll(role(req)) })));
  app.put("/api/payroll/inputs/:month/revenue/:branchId", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveBranchRevenue(parkGroupOf(res), actorOf(req), req.params.month, req.params.branchId, body(req))));
  app.post("/api/payroll/inputs/:month/override", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    overrideMonthInput(parkGroupOf(res), actorOf(req), req.params.month, body(req))));
  app.put("/api/payroll/inputs/:month/people/:employeeId", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveStaffMonthInput(parkGroupOf(res), actorOf(req), req.params.month, req.params.employeeId, body(req))));

  // ── Rewards setup (R3) ──
  app.get("/api/payroll/setup/rewards", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req, res) =>
    ({ ...(await loadRewardsView(parkGroupOf(res))), canManage: canManagePayroll(role(req)) })));
  app.post("/api/payroll/setup/rewards/service-policies/:branchId", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveServicePolicy(parkGroupOf(res), actorOf(req), req.params.branchId, body(req))));
  app.post("/api/payroll/setup/rewards/incentives", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveIncentive(parkGroupOf(res), actorOf(req), body(req))));

  // ── Feeds: OT bank, leave valuations, offboarding (R3) ──
  app.get("/api/payroll/feeds/:month", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req, res) =>
    ({ ...(await loadFeedsView(parkGroupOf(res), req.params.month)), canManage: canManagePayroll(role(req)) })));
  app.post("/api/payroll/feeds/ot-bookings", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    bookOtTimeOff(parkGroupOf(res), actorOf(req), body(req))));
  app.post("/api/payroll/feeds/leave-valuations", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    recordLeaveValuation(parkGroupOf(res), actorOf(req), body(req))));
  app.post("/api/payroll/feeds/leave-valuations/:id/reverse", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    reverseLeaveValuation(parkGroupOf(res), actorOf(req), req.params.id, body(req))));
  app.put("/api/payroll/feeds/offboarding/:employeeId", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    saveOffboarding(parkGroupOf(res), actorOf(req), req.params.employeeId, body(req))));

  // ── Month-end draft and preview (R3; the lifecycle is R4's) ──
  app.get("/api/payroll/month-end/:entityId/:month", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req, res) =>
    ({ ...(await loadMonthEnd(parkGroupOf(res), req.params.entityId, req.params.month)), canManage: canManagePayroll(role(req)) })));
  app.post("/api/payroll/month-end/:entityId/:month/run", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    startRun(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, body(req))));
  app.put("/api/payroll/month-end/:entityId/:month/attendance/:dayKey", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    recordReview(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, req.params.dayKey, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/manual", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    addManualLine(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/manual/:id/remove", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    removeManualLine(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, req.params.id, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/overrides", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    addOverride(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/overrides/:id/remove", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    removeOverride(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, req.params.id, body(req))));
  app.get("/api/payroll/month-end/:entityId/:month/preview", requireAuth, payroll("hr.view_salary"), fence, answer(200, (req, res) =>
    previewMonth(parkGroupOf(res), req.params.entityId, req.params.month)));
}
