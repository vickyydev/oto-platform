import type { Express, Request, Response } from "express";
import { z } from "zod";
import { SINGLE_SHIFT_PAY_BASES } from "@shared/singleShift";
import { canViewHrSalary } from "@shared/hr-salary-permission";
import { requireAuth } from "./auth";
import { canUserAccessBranch, requireManager } from "./auth-middleware";
import { requireSchedulePark } from "./schedule-scope";
import { storage } from "./storage";
import { generateBreaksForShiftRow } from "./break-generator";
import {
  SingleShiftRefusal,
  changeSingleShiftPay,
  formerEmployeesOf,
  inviteToSingleShift,
  shiftRowFor,
  singleShiftsOf,
  validSingleShiftDay,
} from "./lib/singleShift";

/**
 * SCRUM-1038: a former employee invited to one shift, on the same profile and
 * without rehiring (the rules are in lib/singleShift.ts). The people who
 * schedule staff (`requireManager`, the shift's branch in their reach) use it:
 *
 *  - GET  /api/schedule/single-shift/former-employees?branchId= — the branch's
 *    former employees, the people who may be invited there;
 *  - GET  /api/schedule/single-shift/invitations?branchId=&startDate=&endDate=
 *    — the branch's single shifts in those days, each with how it is paid, and
 *    what it is worth for the payroll roles only;
 *  - POST /api/schedule/single-shift/invitations — { employeeId, shiftRowId,
 *    shiftDate, payWay: "old_contract" | "casual_day_rate", casualDayRate? };
 *  - PATCH /api/schedule/single-shift/invitations/:id — { payWay, casualDayRate? }:
 *    the shift switched to a casual day rate, or back to the old contract.
 *
 * The shift is removed as any shift is (DELETE /api/schedule/assignments/:id).
 */

const payWay = z.enum(SINGLE_SHIFT_PAY_BASES);
const inviteSchema = z.object({
  employeeId: z.string().min(1),
  shiftRowId: z.string().min(1),
  shiftDate: z.string().refine(validSingleShiftDay, "Use a valid YYYY-MM-DD date"),
  payWay: payWay.default("old_contract"),
  casualDayRate: z.number().nullable().optional(),
});
const changeSchema = z.object({
  payWay,
  casualDayRate: z.number().nullable().optional(),
});

function refuse(res: Response, error: unknown): boolean {
  if (!(error instanceof SingleShiftRefusal)) return false;
  res.status(error.status).json({ message: error.message, ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}) });
  return true;
}

const tenantOf = (req: Request) => req.userWithAccess!.tenantId!;
const reach = (req: Request) => (branchId: string) => canUserAccessBranch(req.userWithAccess!, branchId);
const seesPay = (req: Request) => canViewHrSalary(req.userWithAccess ?? req.user);

export function registerSingleShiftRoutes(app: Express): void {
  app.get("/api/schedule/single-shift/former-employees", requireAuth, requireManager, requireSchedulePark, async (req, res, next) => {
    try {
      const branchId = req.query.branchId;
      if (typeof branchId !== "string" || !branchId) return res.status(400).json({ message: "branchId is required" });
      if (!reach(req)(branchId)) return res.status(403).json({ message: "Access denied to this branch" });
      res.json(await formerEmployeesOf(tenantOf(req), branchId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/schedule/single-shift/invitations", requireAuth, requireManager, requireSchedulePark, async (req, res, next) => {
    try {
      const { branchId, startDate, endDate } = req.query;
      if (typeof branchId !== "string" || !branchId) return res.status(400).json({ message: "branchId is required" });
      if (!validSingleShiftDay(startDate) || !validSingleShiftDay(endDate) || startDate > endDate) {
        return res.status(400).json({ message: "Valid startDate and endDate are required" });
      }
      if (!reach(req)(branchId)) return res.status(403).json({ message: "Access denied to this branch" });
      res.set("Cache-Control", "private, no-store");
      res.json(await singleShiftsOf(tenantOf(req), branchId, startDate, endDate, seesPay(req)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/schedule/single-shift/invitations", requireAuth, requireManager, requireSchedulePark, async (req, res, next) => {
    try {
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid single shift", errors: parsed.error.errors });
      const tenantId = tenantOf(req);
      const shiftRow = await shiftRowFor(tenantId, parsed.data.shiftRowId);
      if (!shiftRow) return res.status(404).json({ message: "Shift row not found" });
      if (!reach(req)(shiftRow.branchId)) return res.status(403).json({ message: "Access denied to this branch" });
      const employee = await storage.getEmployeeInTenant(parsed.data.employeeId, tenantId);
      if (!employee) return res.status(404).json({ message: "Employee not found" });
      const invitation = await inviteToSingleShift({
        tenantId,
        actorId: req.user!.id,
        shiftRow,
        shiftDate: parsed.data.shiftDate,
        employee,
        way: parsed.data.payWay,
        casualDayRate: parsed.data.casualDayRate ?? null,
      });
      await generateBreaksForShiftRow(shiftRow.id, parsed.data.shiftDate, tenantId).catch((err) => console.error("[BREAKS] Generation error:", err));
      const [view] = (await singleShiftsOf(tenantId, shiftRow.branchId, parsed.data.shiftDate, parsed.data.shiftDate, seesPay(req)))
        .filter((s) => s.id === invitation.id);
      res.status(201).json(view);
    } catch (error) {
      if (!refuse(res, error)) next(error);
    }
  });

  app.patch("/api/schedule/single-shift/invitations/:id", requireAuth, requireManager, requireSchedulePark, async (req, res, next) => {
    try {
      const parsed = changeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid single shift pay", errors: parsed.error.errors });
      const tenantId = tenantOf(req);
      const after = await changeSingleShiftPay({
        tenantId,
        actorId: req.user!.id,
        invitationId: req.params.id,
        canReachBranch: reach(req),
        way: parsed.data.payWay,
        casualDayRate: parsed.data.casualDayRate ?? null,
      });
      const day = String(after.shiftDate).slice(0, 10);
      const [view] = (await singleShiftsOf(tenantId, after.branchId, day, day, seesPay(req))).filter((s) => s.id === after.id);
      res.json(view);
    } catch (error) {
      if (!refuse(res, error)) next(error);
    }
  });
}
