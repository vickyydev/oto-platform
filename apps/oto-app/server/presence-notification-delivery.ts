import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { branches, employees, scheduleShiftRows, users } from "../shared/schema";
import { notifications, presenceNotificationDeliveries as deliveries } from "./db/coreSchema";
import type { db } from "./db";

type Database = Pick<typeof db, "select" | "insert" | "update" | "transaction">;
type Delivery = typeof deliveries.$inferSelect;
class PresenceAccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const requestSchema = z.object({
  requestKey: z.string().uuid(), employeeId: z.string().min(1).max(200),
  shiftRowId: z.string().min(1).max(200),
  shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  reason: z.literal("missing_clock_in"),
}).strict();

function publicDelivery(row: Delivery) {
  return { id: row.id, requestKey: row.requestKey, status: row.status,
    failureMessage: row.failureMessage, employeeId: row.employeeId,
    shiftRowId: row.shiftRowId, shiftDate: row.shiftDate, updatedAt: row.updatedAt };
}

export async function readPresenceDeliveries(database: Database, tenantId: string, employeeIds: string[], shiftDate: string, allowedBranchIds?: string[]) {
  if (!employeeIds.length || allowedBranchIds?.length === 0) return [];
  const rows = await database.select().from(deliveries).where(and(eq(deliveries.tenantId, tenantId),
    inArray(deliveries.employeeId, employeeIds), eq(deliveries.shiftDate, shiftDate), allowedBranchIds ? inArray(deliveries.branchId, allowedBranchIds) : undefined)).orderBy(desc(deliveries.createdAt), desc(deliveries.id));
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = `${row.employeeId}:${row.shiftRowId}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(publicDelivery);
}

export function registerPresenceNotificationDelivery(app: Express, database: Database,
  requireAuth: RequestHandler, requireManager: RequestHandler,
  managedUserTenant: (userId: string) => Promise<string | undefined>) {
  app.post("/api/timekeeping/live/ping", requireAuth, requireManager, async (req, res, next) => {
    try {
      const scope = req.userWithAccess;
      const tenantId = scope?.tenantId, actorId = req.user?.id;
      if (!scope || !tenantId || !actorId) return res.status(403).json({ message: "Park access required" });
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Choose a staff member and shift, with a valid delivery request" });
      const body = parsed.data;
      const [employee] = await database.select().from(employees).where(and(eq(employees.id, body.employeeId), eq(employees.tenantId, tenantId))).limit(1);
      const [shift] = await database.select({ branchId: scheduleShiftRows.branchId }).from(scheduleShiftRows)
        .innerJoin(branches, eq(branches.id, scheduleShiftRows.branchId))
        .where(and(eq(scheduleShiftRows.id, body.shiftRowId), eq(scheduleShiftRows.tenantId, tenantId), eq(branches.tenantId, tenantId))).limit(1);
      if (!employee || !shift) return res.status(404).json({ message: "Staff member or shift not found" });
      if (!scope.hasAllBranchesAccess && (!employee.branchId || !scope.allowedBranchIds.includes(employee.branchId) || !scope.allowedBranchIds.includes(shift.branchId))) {
        return res.status(403).json({ message: "Access denied to this branch" });
      }
      const requestHash = createHash("sha256").update(JSON.stringify([body.employeeId, body.shiftRowId, body.shiftDate, body.reason, shift.branchId])).digest("hex");
      // Commit Pending separately: an interrupted process leaves a durable retry.
      await database.insert(deliveries).values({ tenantId, requestKey: body.requestKey, requestHash,
        employeeId: employee.id, branchId: shift.branchId, shiftRowId: body.shiftRowId,
        shiftDate: body.shiftDate, createdBy: actorId }).onConflictDoNothing({ target: [deliveries.tenantId, deliveries.requestKey] });
      const [attempt] = await database.select().from(deliveries).where(and(eq(deliveries.tenantId, tenantId), eq(deliveries.requestKey, body.requestKey))).limit(1);
      if (attempt.requestHash !== requestHash) return res.status(409).json({ message: "This delivery request belongs to different details. Start a new ping." });
      // Resolve using the existing login placement before taking a transaction
      // connection; concurrent retries must not exhaust the shared pool.
      const recipientTenant = employee.userId ? await managedUserTenant(employee.userId) : undefined;
      let outcome: Delivery;
      try {
        outcome = await database.transaction(async tx => {
          // Hold current placement through inbox commit. A transfer waiting on this
          // employee happens after this action; one already committed is rechecked.
          const [current] = await tx.select({ userId: employees.userId, branchId: employees.branchId }).from(employees)
            .where(and(eq(employees.id, employee.id), eq(employees.tenantId, tenantId))).for("share");
          const [currentShift] = await tx.select({ branchId: scheduleShiftRows.branchId }).from(scheduleShiftRows)
            .where(and(eq(scheduleShiftRows.id, body.shiftRowId), eq(scheduleShiftRows.tenantId, tenantId))).for("share");
          const [currentBranch] = currentShift ? await tx.select({ id: branches.id }).from(branches)
            .where(and(eq(branches.id, currentShift.branchId), eq(branches.tenantId, tenantId))).for("share") : [];
          if (!current || !currentShift || !currentBranch) throw new PresenceAccessError(404, "Staff member or shift not found");
          if (!scope.hasAllBranchesAccess && (!current.branchId || !scope.allowedBranchIds.includes(current.branchId) || !scope.allowedBranchIds.includes(currentShift.branchId))) {
            throw new PresenceAccessError(403, "Access denied to this branch");
          }
          if (currentShift.branchId !== shift.branchId) throw new PresenceAccessError(409, "Shift details changed. Refresh before starting a new ping.");
          const [locked] = await tx.select().from(deliveries).where(and(eq(deliveries.id, attempt.id), eq(deliveries.tenantId, tenantId))).for("update");
          if (!locked) throw new PresenceAccessError(404, "Delivery request not found");
          if (locked.status === "Delivered") return locked;
          // Re-read the current login for a retry after staff access is connected.
          const [recipient] = current.userId ? await tx.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.id, current.userId)).for("share") : [];
          if (!recipient?.isActive || recipient.id !== employee.userId || recipientTenant !== tenantId) {
            const [failed] = await tx.update(deliveries).set({ status: "Failed", failureMessage: "Staff inbox is unavailable. Connect an active staff login in this park, then retry.", updatedAt: new Date() }).where(eq(deliveries.id, locked.id)).returning();
            return failed;
          }
          const [notification] = await tx.insert(notifications).values({ tenantId, recipientUserId: recipient.id,
            type: "timekeeping_ping", title: "Please check your clock-in",
            body: `Your manager has asked you to check your clock-in for ${body.shiftDate}. Please contact your manager if you need help.`,
            referenceType: "presence_delivery", referenceId: locked.id, actorUserId: locked.createdBy }).returning({ id: notifications.id });
          // Stored in the inbox means Delivered. Read/unread remains on notifications.
          const [delivered] = await tx.update(deliveries).set({ status: "Delivered", failureMessage: null,
            notificationId: notification.id, updatedAt: new Date() }).where(eq(deliveries.id, locked.id)).returning();
          return delivered;
        });
      } catch (error) {
        if (error instanceof PresenceAccessError) {
          await database.update(deliveries).set({ status: "Failed", failureMessage: "Staff or shift access changed. Refresh live timekeeping before retrying.", updatedAt: new Date() })
            .where(and(eq(deliveries.id, attempt.id), eq(deliveries.tenantId, tenantId), inArray(deliveries.status, ["Pending", "Failed"])));
          return res.status(error.status).json({ message: error.message });
        }
        // A competing successful retry must never be overwritten by a failure.
        await database.update(deliveries).set({ status: "Failed", failureMessage: "The staff inbox could not be updated. Retry this delivery.", updatedAt: new Date() })
          .where(and(eq(deliveries.id, attempt.id), inArray(deliveries.status, ["Pending", "Failed"])));
        [outcome] = await database.select().from(deliveries).where(eq(deliveries.id, attempt.id)).limit(1);
      }
      return res.json({ delivery: publicDelivery(outcome) });
    } catch (error) { next(error); }
  });

}
