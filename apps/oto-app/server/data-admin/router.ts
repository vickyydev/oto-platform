import { Router, Request, Response } from "express";
import { db } from "../db";
import { count } from "drizzle-orm";
import { register, getAdmin, getAllAdmins, getAdminMap } from "./registry";
import tenantAdmin from "./models/tenant";
import operatorAdmin from "./models/operator";
import branchAdmin from "./models/branch";
import departmentAdmin from "./models/department";
import userAdmin from "./models/user";
import employeeAdmin from "./models/employee";
import personAdmin from "./models/person";
import roleAdmin from "./models/role";
import fileAdmin from "./models/file";
import templateAdmin from "./models/template";
import settingAdmin from "./models/setting";
import payslipAdmin from "./models/payslip";
import shiftAdmin from "./models/shift";
import userBranchAccessAdmin from "./models/userBranchAccess";
import timeEventAdmin from "./models/timeEvent";
import employeeRoleAdmin from "./models/employeeRole";
import publicHolidayAdmin from "./models/publicHoliday";
import scheduleShiftRowAdmin from "./models/scheduleShiftRow";
import scheduleAssignmentAdmin from "./models/scheduleAssignment";
import dutyBlockAdmin from "./models/dutyBlock";
import casualWorkerAdmin from "./models/casualWorker";
import employeeTimeOffAdmin from "./models/employeeTimeOff";
import scheduleWeekPlanAdmin from "./models/scheduleWeekPlan";
import shiftGroupAdmin from "./models/shiftGroup";
import payrollLineItemAdmin from "./models/payrollLineItem";
import payrollEmployeeSummaryAdmin from "./models/payrollEmployeeSummary";
import accessPolicyAdmin from "./models/accessPolicy";
import employeePresenceAdmin from "./models/employeePresence";
import payrollRunAdmin from "./models/payrollRun";
import kioskDeviceAdmin from "./models/kioskDevice";
import branchEventAdmin from "./models/branchEvent";
import departmentBranchAssignmentAdmin from "./models/departmentBranchAssignment";
import scheduleShiftRowRoleAdmin from "./models/scheduleShiftRowRole";
import scheduleShiftBreakAdmin from "./models/scheduleShiftBreak";
import payrollPeriodAdmin from "./models/payrollPeriod";
import payrollDayReconciliationAdmin from "./models/payrollDayReconciliation";
import templateAssignmentAdmin from "./models/templateAssignment";
import staffCostAllocationAdmin from "./models/staffCostAllocation";
import contractInstanceAdmin from "./models/contractInstance";
import activityLogAdmin from "./models/activityLog";
import attentionItemAdmin from "./models/attentionItem";
import enrollmentSessionAdmin from "./models/enrollmentSession";
import timeEntryAdmin from "./models/timeEntry";
import timekeepingIssueAdmin from "./models/timekeepingIssue";
import authOtpEventAdmin from "./models/authOtpEvent";
import shiftRequiredRoleAdmin from "./models/shiftRequiredRole";
import leavePolicyAdmin from "./models/leavePolicy";
import scheduleTemplateAdmin from "./models/scheduleTemplate";
import scheduleTemplateRowAdmin from "./models/scheduleTemplateRow";
import scheduleTemplateRowRoleAdmin from "./models/scheduleTemplateRowRole";
import scheduleAuditLogAdmin from "./models/scheduleAuditLog";
import payrollExceptionAdmin from "./models/payrollException";
import salaryAdvanceAdmin from "./models/salaryAdvance";
import salaryAdvanceRepaymentAdmin from "./models/salaryAdvanceRepayment";
import statutoryRuleSetAdmin from "./models/statutoryRuleSet";
import statutoryCalculationResultAdmin from "./models/statutoryCalculationResult";
import dutyTypeAdmin from "./models/dutyType";
import userModuleOverrideAdmin from "./models/userModuleOverride";
import kioskCodeAdmin from "./models/kioskCode";
import employeeChangeAdmin from "./models/employeeChange";
import policyDocumentAdmin from "./models/policyDocument";
import employeeDocumentAdmin from "./models/employeeDocument";
import employeeOffboardingAdmin from "./models/employeeOffboarding";
import employeeLetterAdmin from "./models/employeeLetter";
import assetCatalogAdmin from "./models/assetCatalog";
import employeeAssetAdmin from "./models/employeeAsset";
import offboardingChecklistAdmin from "./models/offboardingChecklist";
import kioskSessionAdmin from "./models/kioskSession";
import kioskAuthAttemptAdmin from "./models/kioskAuthAttempt";
import authRateLimitAdmin from "./models/authRateLimit";
import roleDepartmentMapAdmin from "./models/roleDepartmentMap";
import roleBranchAssignmentAdmin from "./models/roleBranchAssignment";
import coverageRuleAdmin from "./models/coverageRule";
import sickLeavePolicyAdmin from "./models/sickLeavePolicy";
import scheduleTemplateAssignmentAdmin from "./models/scheduleTemplateAssignment";
import scheduleTemplateTimeOffAdmin from "./models/scheduleTemplateTimeOff";
import employeePayrollProfileAdmin from "./models/employeePayrollProfile";
import timeAdjustmentAdmin from "./models/timeAdjustment";
import payrollExceptionApprovalAdmin from "./models/payrollExceptionApproval";
import payrollPolicySettingsAdmin from "./models/payrollPolicySettings";
import accessViewLogAdmin from "./models/accessViewLog";
import xeroSyncRunAdmin from "./models/xeroSyncRun";
import xeroTrackingCategoryAdmin from "./models/xeroTrackingCategory";
import xeroTrackingOptionAdmin from "./models/xeroTrackingOption";
import xeroReportRawAdmin from "./models/xeroReportRaw";
import plFactAdmin from "./models/plFact";
import cashTxnAdmin from "./models/cashTxn";
import cashDailyAdmin from "./models/cashDaily";

[
  tenantAdmin, operatorAdmin, branchAdmin, departmentAdmin, userAdmin, employeeAdmin, personAdmin,
  roleAdmin, fileAdmin, templateAdmin, settingAdmin, payslipAdmin, shiftAdmin, userBranchAccessAdmin,
  timeEventAdmin, employeeRoleAdmin, publicHolidayAdmin, scheduleShiftRowAdmin, scheduleAssignmentAdmin,
  dutyBlockAdmin, casualWorkerAdmin, employeeTimeOffAdmin, scheduleWeekPlanAdmin, shiftGroupAdmin,
  payrollLineItemAdmin, payrollEmployeeSummaryAdmin, accessPolicyAdmin, employeePresenceAdmin,
  payrollRunAdmin, kioskDeviceAdmin, branchEventAdmin, departmentBranchAssignmentAdmin,
  scheduleShiftRowRoleAdmin, scheduleShiftBreakAdmin, payrollPeriodAdmin, payrollDayReconciliationAdmin,
  templateAssignmentAdmin, staffCostAllocationAdmin, contractInstanceAdmin,
  activityLogAdmin, attentionItemAdmin, enrollmentSessionAdmin, timeEntryAdmin, timekeepingIssueAdmin,
  authOtpEventAdmin, shiftRequiredRoleAdmin, leavePolicyAdmin, scheduleTemplateAdmin,
  scheduleTemplateRowAdmin, scheduleTemplateRowRoleAdmin, scheduleAuditLogAdmin, payrollExceptionAdmin,
  salaryAdvanceAdmin, salaryAdvanceRepaymentAdmin, statutoryRuleSetAdmin, statutoryCalculationResultAdmin,
  dutyTypeAdmin, userModuleOverrideAdmin, kioskCodeAdmin, employeeChangeAdmin, policyDocumentAdmin,
  employeeDocumentAdmin, employeeOffboardingAdmin, employeeLetterAdmin, assetCatalogAdmin,
  employeeAssetAdmin, offboardingChecklistAdmin, kioskSessionAdmin, kioskAuthAttemptAdmin,
  authRateLimitAdmin, roleDepartmentMapAdmin, roleBranchAssignmentAdmin,
  coverageRuleAdmin, sickLeavePolicyAdmin, scheduleTemplateAssignmentAdmin, scheduleTemplateTimeOffAdmin,
  employeePayrollProfileAdmin, timeAdjustmentAdmin, payrollExceptionApprovalAdmin, payrollPolicySettingsAdmin,
  accessViewLogAdmin, xeroSyncRunAdmin, xeroTrackingCategoryAdmin, xeroTrackingOptionAdmin,
  xeroReportRawAdmin, plFactAdmin, cashTxnAdmin, cashDailyAdmin,
].forEach(register);

const router = Router();

function withoutUserPassword(admin: unknown, row: Record<string, unknown>): Record<string, unknown> {
  if (admin !== userAdmin) return row;
  const { password, ...safeRow } = row;
  void password;
  return safeRow;
}

// ─── GET /api/data-admin/models ──────────────────────────────────────────────
// Returns metadata + record count for every registered model.

router.get("/models", async (_req: Request, res: Response) => {
  try {
    const admins = getAllAdmins();
    const results = await Promise.all(
      admins.map(async (admin) => {
        const [total] = await db.select({ count: count() }).from(admin.table);
        return {
          ...admin.meta,
          count: Number(total?.count ?? 0),
        };
      }),
    );
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/data-admin/:model/options ──────────────────────────────────────
// Returns [{ id, label }] for FK dropdowns.  ?labelField=name

router.get("/:model/options", async (req: Request, res: Response) => {
  const admin = getAdmin(req.params.model);
  if (!admin) return res.status(404).json({ error: "Model not found" });

  const labelField = (req.query.labelField as string) || "name";
  try {
    const options = await admin.getOptions(labelField);
    res.json(options);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/data-admin/:model ──────────────────────────────────────────────
// Paginated list with optional search, filters, and ordering.
// Query params: page, pageSize, q, orderBy, + any column key for filtering.

router.get("/:model", async (req: Request, res: Response) => {
  const admin = getAdmin(req.params.model);
  if (!admin) return res.status(404).json({ error: "Model not found" });

  const SYSTEM_KEYS = new Set(["page", "pageSize", "q", "orderBy"]);

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 25));
  const search = (req.query.q as string) || undefined;
  const orderBy = (req.query.orderBy as string) || undefined;

  // Remaining query params are treated as column filters
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (!SYSTEM_KEYS.has(key) && typeof value === "string") {
      filters[key] = value;
    }
  }

  try {
    const result = await admin.getList({ page, pageSize, search, filters, orderBy });
    const allAdmins = getAdminMap();
    const enriched = await admin.enrichRows(result.rows, allAdmins);
    res.json({ ...result, rows: enriched.map(row => withoutUserPassword(admin, row)) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/data-admin/:model ─────────────────────────────────────────────

router.post("/:model", async (req: Request, res: Response) => {
  const admin = getAdmin(req.params.model);
  if (!admin) return res.status(404).json({ error: "Model not found" });

  try {
    const row = await admin.create(req.body);
    res.status(201).json(withoutUserPassword(admin, row));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── GET /api/data-admin/:model/:id ──────────────────────────────────────────

router.get("/:model/:id", async (req: Request, res: Response) => {
  const admin = getAdmin(req.params.model);
  if (!admin) return res.status(404).json({ error: "Model not found" });

  try {
    const row = await admin.getById(req.params.id);
    if (!row) return res.status(404).json({ error: "Record not found" });

    // Enrich with FK labels using both listDisplay and formFields
    const allAdmins = getAdminMap();
    const allFields = [
      ...admin.listDisplay,
      ...admin.formFields.filter(
        (f) => !admin.listDisplay.some((d) => d.key === f.key),
      ),
    ];
    const [enriched] = await admin.enrichRows([row], allAdmins, allFields);
    res.json(withoutUserPassword(admin, enriched));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/data-admin/:model/:id ──────────────────────────────────────────

router.put("/:model/:id", async (req: Request, res: Response) => {
  const admin = getAdmin(req.params.model);
  if (!admin) return res.status(404).json({ error: "Model not found" });

  try {
    const row = await admin.update(req.params.id, req.body);
    if (!row) return res.status(404).json({ error: "Record not found" });
    res.json(withoutUserPassword(admin, row));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── DELETE /api/data-admin/:model/:id ───────────────────────────────────────

router.delete("/:model/:id", async (req: Request, res: Response) => {
  const admin = getAdmin(req.params.model);
  if (!admin) return res.status(404).json({ error: "Model not found" });

  try {
    await admin.delete(req.params.id);
    res.status(204).send();
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
