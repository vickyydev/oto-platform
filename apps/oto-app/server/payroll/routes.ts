/**
 * The company payroll's routes (SCRUM-567 onward; plan §7 and §9). R3 (SCRUM-568)
 * adds month inputs, rewards setup, the payroll feeds and the month-end draft
 * with its read-only preview. R4 (SCRUM-569) adds the lifecycle (GM confirm,
 * Owner lock, paid, reopen), overtime decisions, third-party approvals, the
 * locked history with its files, and every employee's own payslips. R5
 * (SCRUM-570) adds the downloads of a locked version; every file download
 * stays the one history-files route, permission-checked and audited.
 *
 * R6 (SCRUM-571) adds the statutory documents: the offers and coverage per
 * branch and period, rendering, the frozen files, filing records and the EWF
 * surcharge estimate.
 *
 * Every route here is behind `hr.view_salary` (managers and staff get 403 on
 * all of them), writes need `hr.manage_payroll`, and the HR-data draft action
 * is global_admin's. GM confirm needs `payroll.confirm` (admin,
 * operator_admin, global_admin); Owner lock, reopen and mark paid need
 * `payroll.lock` (operator_admin, global_admin; owner ruling 2026-10-20).
 * The one exception to the salary floor is `payroll.own_payslips`: anyone
 * signed in, for the payslips of the employee linked to their own account. Each is fenced by its own `parkGroupOnly` and every query
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
import { canConfirmPayroll, canDraftPayrollProfiles, canLockPayroll, canManagePayroll } from "@shared/payroll-config";
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
import { approveThirdParty, confirmRun, lockRun, markPaid, recordOvertimeDecision, removeOvertimeDecision, reopenRun } from "./lifecycle";
import { listHistory, loadHistoryVersion, myPayslips, openHistoryFile, openMyPayslip, type ServedFile } from "./payslips";
import { ewfSurcharge, loadStatutoryView, openDocumentFile, recordFiling, renderDocument } from "./statutory";
import { loadDownloads } from "./outputs";

export type PayrollPermission = "hr.view_salary" | "hr.manage_payroll" | "payroll.draft_profiles" | "payroll.confirm" | "payroll.lock" | "payroll.own_payslips";

interface PayrollRouteDependencies {
  requireAuth: RequestHandler;
  /** The app's strict park-group rule (userManagementTenant in server/routes.ts). */
  callerParkGroup: CallerParkGroup;
}

const roleOf = (req: Request) => req.userWithAccess?.role ?? req.user?.role;

/** The permission a route needs, decided by the permission engine on the effective role. */
export function payrollAllows(permission: PayrollPermission, role: string | null | undefined): boolean {
  // Everyone signed in reaches their OWN payslips; the service shows nobody else's.
  if (permission === "payroll.own_payslips") return !!role;
  if (!canViewHrSalary(role)) return false;
  if (permission === "hr.view_salary") return true;
  if (permission === "hr.manage_payroll") return canManagePayroll(role);
  if (permission === "payroll.confirm") return canConfirmPayroll(role);
  if (permission === "payroll.lock") return canLockPayroll(role);
  return canDraftPayrollProfiles(role);
}

/** The refusal in plain words, naming the key. */
const REFUSALS: Partial<Record<PayrollPermission, string>> = {
  "payroll.confirm": "GM confirmation is for payroll managers only",
  "payroll.lock": "Only the Owner can lock, reopen or mark a payroll month paid",
};

function payroll(permission: PayrollPermission): RequestHandler {
  return (req, res, next) => {
    if (!payrollAllows(permission, roleOf(req))) {
      res.status(403).json({ message: `${REFUSALS[permission] ?? "Payroll is for payroll roles only"} (${permission} required).` });
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

/**
 * A frozen payroll file, sent as is: private, never cached, and HTML
 * sandboxed (no script, no network) so a payslip cannot act as a page of
 * the app. `?download=1` saves it instead of showing it.
 */
const sendFrozen = (work: (req: Request, res: Response) => Promise<ServedFile>): RequestHandler => async (req, res, next) => {
  try {
    const file = await work(req, res);
    res.setHeader("Content-Type", `${file.mime}${/^text\//.test(file.mime) ? "; charset=utf-8" : ""}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="${file.filename.replace(/[^\w.-]/g, "_")}"`);
    res.status(200).send(file.body);
  } catch (error) {
    if (error instanceof PayrollRefusal) { res.status(error.status).json({ message: error.message }); return; }
    next(error);
  }
};

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
    ({ ...(await loadMonthEnd(parkGroupOf(res), req.params.entityId, req.params.month)), canManage: canManagePayroll(role(req)),
      canConfirm: canConfirmPayroll(role(req)), canLock: canLockPayroll(role(req)) })));
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

  // ── Month-end lifecycle (R4): overtime decisions, third-party approvals, GM confirm, Owner lock, paid, reopen ──
  app.put("/api/payroll/month-end/:entityId/:month/overtime/:dayKey", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    recordOvertimeDecision(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, req.params.dayKey, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/overtime/:dayKey/remove", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    removeOvertimeDecision(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, req.params.dayKey, body(req))));
  app.put("/api/payroll/month-end/:entityId/:month/third-party/:employeeId", requireAuth, payroll("hr.manage_payroll"), fence, answer(200, (req, res) =>
    approveThirdParty(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, req.params.employeeId, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/confirm", requireAuth, payroll("payroll.confirm"), fence, answer(200, (req, res) =>
    confirmRun(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/lock", requireAuth, payroll("payroll.lock"), fence, answer(200, (req, res) =>
    lockRun(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/paid", requireAuth, payroll("payroll.lock"), fence, answer(200, (req, res) =>
    markPaid(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, body(req))));
  app.post("/api/payroll/month-end/:entityId/:month/reopen", requireAuth, payroll("payroll.lock"), fence, answer(200, (req, res) =>
    reopenRun(parkGroupOf(res), actorOf(req), req.params.entityId, req.params.month, body(req))));

  // ── Locked history and its files (R4): payroll roles; every file opened is audited ──
  app.get("/api/payroll/history", requireAuth, payroll("hr.view_salary"), fence, answer(200, (_req, res) =>
    listHistory(parkGroupOf(res))));
  app.get("/api/payroll/history/files/:fileId", requireAuth, payroll("hr.view_salary"), fence, sendFrozen((req, res) =>
    openHistoryFile(parkGroupOf(res), actorOf(req), req.params.fileId)));
  app.get("/api/payroll/history/:entityId/:month/:version", requireAuth, payroll("hr.view_salary"), fence, answer(200, (req, res) =>
    loadHistoryVersion(parkGroupOf(res), req.params.entityId, req.params.month, req.params.version)));

  // ── My payslips (R4): anyone signed in, their own locked payslips only ──
  app.get("/api/payroll/me/payslips", requireAuth, payroll("payroll.own_payslips"), fence, answer(200, (req, res) =>
    myPayslips(parkGroupOf(res), actorOf(req).userId)));
  app.get("/api/payroll/me/payslips/:fileId", requireAuth, payroll("payroll.own_payslips"), fence, sendFrozen((req, res) =>
    openMyPayslip(parkGroupOf(res), actorOf(req).userId, req.params.fileId)));

  // ── Statutory documents (R6): the prototype's document engine on the per-branch locked runs (none: owner decision 3) ──
  app.get("/api/payroll/statutory", requireAuth, payroll("hr.view_salary"), fence, answer(200, (req, res) =>
    loadStatutoryView(parkGroupOf(res), { branchId: req.query.branchId, period: req.query.period }, canManagePayroll(role(req)))));
  app.get("/api/payroll/statutory/ewf-surcharge", requireAuth, payroll("hr.view_salary"), fence, answer(200, async (req) =>
    ewfSurcharge({ dueDate: req.query.dueDate, asOfDate: req.query.asOfDate, principal: req.query.principal })));
  app.post("/api/payroll/statutory/documents", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    renderDocument(parkGroupOf(res), actorOf(req), body(req))));
  app.get("/api/payroll/statutory/documents/:id/files/:index", requireAuth, payroll("hr.view_salary"), fence, sendFrozen((req, res) =>
    openDocumentFile(parkGroupOf(res), actorOf(req), req.params.id, req.params.index, req.query.download === "1")));
  app.post("/api/payroll/statutory/filings", requireAuth, payroll("hr.manage_payroll"), fence, answer(201, (req, res) =>
    recordFiling(parkGroupOf(res), actorOf(req), body(req))));

  // ── Downloads of a locked version (R5): the stored files by group, the bundle and the reconciliation read from the stored bytes ──
  app.get("/api/payroll/history/:entityId/:month/:version/downloads", requireAuth, payroll("hr.view_salary"), fence, answer(200, (req, res) =>
    loadDownloads(parkGroupOf(res), req.params.entityId, req.params.month, req.params.version)));
}
