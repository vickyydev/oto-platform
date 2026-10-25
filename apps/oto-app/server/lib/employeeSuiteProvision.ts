import { createHash } from "node:crypto";
import type { Express, Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { accessPolicies, branches, employeeActionReceipts, employees, operators, people, tenants, userBranchAccess, users, type Employee } from "@shared/schema";
import { grantedRoleFor, isAdminRole } from "../../shared/permissions";
import { requireAuth } from "../auth";
import { canUserAccessBranch, requireManager } from "../auth-middleware";
import { db } from "../db";
import { legacyLoginEnabled } from "../middleware/platformSignOn";
import { storage, type DbExecutor } from "../storage";
import { unusablePassword } from "../suite-sign-in-routes";
import { provisionSuiteSignIn, readPhone, suiteProvisionConfig, SUITE_PROVISION_UNCONFIGURED } from "./suiteSignIn";

const bodySchema = z.object({
  actionId: z.string().uuid().transform(value => value.toLowerCase()), phone: z.string(), email: z.string().optional(),
  accessLevel: z.enum(["STAFF", "MANAGER", "ADMIN"]).nullish(),
  branchScope: z.enum(["SELECTED", "ALL"]).optional(), branchIds: z.array(z.string()).optional(),
  enableCoreModule: z.boolean().optional(), enableHrModule: z.boolean().optional(),
  enableStudioModule: z.boolean().optional(), enableEventsModule: z.boolean().optional(),
  enableOpsModule: z.boolean().optional(), enableSetupModule: z.boolean().optional(),
}).strict();
const preparedSchema = z.object({
  phase: z.enum(["prepared", "completed"]), personId: z.string(), userId: z.string(), accessPolicyId: z.string(),
  request: bodySchema,
});
const responseSchema = z.object({
  success: z.literal(true), personId: z.string(), userId: z.string(), accessPolicyId: z.string(),
  accountId: z.string(), phone: z.string(), temporaryPassword: z.string().nullable(),
  replayed: z.boolean(), platformManaged: z.boolean(),
});
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
type Refusal = { status: number; message: string };
const refuse = (status: number, message: string): Refusal => ({ status, message });
const payloadHashFor = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const modulesFor = (body: z.infer<typeof bodySchema>) => ({
  core: body.enableCoreModule ?? true, hr: body.enableHrModule ?? (body.accessLevel === "MANAGER" || body.accessLevel === "ADMIN"),
  studio: body.enableStudioModule ?? false, events: body.enableEventsModule ?? false,
  ops: body.enableOpsModule ?? false, setup: body.enableSetupModule ?? false,
});
const sameIds = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

async function reservedGraphMatches(tx: DbExecutor, employee: Employee, prepared: z.infer<typeof preparedSchema>,
  tenantId: string, phoneE164: string, operatorId: string | null, selected: string[]): Promise<boolean> {
  const [user] = await tx.select().from(users).where(eq(users.id, prepared.userId));
  const [policy] = await tx.select().from(accessPolicies).where(eq(accessPolicies.id, prepared.accessPolicyId));
  const [person] = await tx.select().from(people).where(eq(people.id, prepared.personId));
  const seats = await tx.select().from(userBranchAccess).where(eq(userBranchAccess.userId, prepared.userId));
  const carriers = await tx.select({ tenantId: employees.tenantId }).from(employees).where(eq(employees.personId, prepared.personId));
  const body = prepared.request;
  const expectedScope = body.branchScope ?? "SELECTED";
  const seatsMatch = expectedScope === "ALL"
    ? seats.length === 1 && seats[0].tenantId === tenantId && seats[0].branchId === null && seats[0].accessScope === "all_branches"
    : seats.every(row => row.tenantId === tenantId && row.accessScope === "selected_branches" && row.branchId !== null)
      && sameIds(seats.map(row => row.branchId!), selected);
  return !!user?.isActive && !!person && (!person.tenantId || person.tenantId === tenantId)
    && carriers.every(row => row.tenantId === tenantId) && employee.userId === user.id && employee.personId === prepared.personId
    && policy?.tenantId === tenantId && policy.personId === employee.personId && policy.coreUserId === user.id
    && policy.accessLevel === (body.accessLevel ?? "STAFF") && policy.branchScope === expectedScope
    && sameIds(policy.branchIds ?? [], selected) && payloadHashFor(policy.modules) === payloadHashFor(modulesFor(body))
    && user.phoneE164 === phoneE164 && user.operatorId === operatorId && seatsMatch;
}

/** The local graph and private reservation commit together. The platform call
 * happens afterwards, so an uncertain answer can retry the same user and key. */
export function registerEmployeeSuiteProvision(app: Express, options: {
  userManagementTenant: (req: Request) => Promise<string | undefined>;
  committed: (employeeId: string) => void;
}): void {
  app.get("/api/employees/:id/login-provisioning", requireAuth, requireManager, async (req, res, next) => {
    if (legacyLoginEnabled()) return next();
    res.setHeader("Cache-Control", "no-store");
    try {
      const actor = req.userWithAccess;
      const tenantId = await options.userManagementTenant(req);
      if (!actor || !req.user || !tenantId) return res.status(403).json({ message: "Park context is required" });
      const pending = await db.transaction(async tx => {
        const [employee] = await tx.select().from(employees)
          .where(and(eq(employees.id, req.params.id), eq(employees.tenantId, tenantId))).for("share");
        if (!employee) return refuse(404, "Employee not found");
        if (!canUserAccessBranch(actor, employee.branchId)) return refuse(403, "Access denied to this employee");
        const receipts = await tx.select().from(employeeActionReceipts).where(and(
          eq(employeeActionReceipts.employeeId, employee.id), eq(employeeActionReceipts.tenantId, tenantId),
          eq(employeeActionReceipts.action, "suite-enable-login"), eq(employeeActionReceipts.responseStatus, 202),
        )).limit(2);
        if (!receipts.length) return null;
        if (receipts.length !== 1) return refuse(409, "Employee has conflicting login reservations");
        const receipt = receipts[0];
        if (receipt.actorId !== actor.id) return refuse(403, "Only the original administrator can resume this login request");
        const prepared = preparedSchema.safeParse(receipt.responseBody.result);
        if (!prepared.success || prepared.data.phase !== "prepared") throw new Error("Employee login reservation could not be read");
        const body = prepared.data.request;
        if (body.actionId !== receipt.id || payloadHashFor(body) !== receipt.payloadHash) throw new Error("Employee login request binding changed");
        const role = grantedRoleFor(actor.role, body.accessLevel);
        if (!role || (body.branchScope === "ALL" && (!isAdminRole(actor.role) || !actor.hasAllBranchesAccess))) {
          return refuse(403, "You can no longer grant the reserved login access");
        }
        const selected = receipt.responseBody.branchIds;
        const selectedRows = selected.length ? await tx.select({ id: branches.id }).from(branches)
          .where(and(eq(branches.tenantId, tenantId), inArray(branches.id, selected))) : [];
        if (selectedRows.length !== selected.length || (!actor.hasAllBranchesAccess && selected.some(id => !actor.allowedBranchIds.includes(id)))) {
          return refuse(403, "You can only grant branches you have access to");
        }
        const [branch] = employee.branchId ? await tx.select().from(branches)
          .where(and(eq(branches.id, employee.branchId), eq(branches.tenantId, tenantId))) : [];
        if (employee.branchId && !branch) return refuse(403, "Employee branch is not available");
        const operatorId = role === "operator_admin" ? actor.operatorId : branch?.operatorId ?? null;
        if (role === "operator_admin" && !operatorId) return refuse(403, "Your login can no longer grant ADMIN");
        if (operatorId) {
          const [operator] = await tx.select({ id: operators.id }).from(operators)
            .where(and(eq(operators.id, operatorId), eq(operators.tenantId, tenantId)));
          if (!operator) return refuse(403, "Employee operator is not available");
        }
        const phone = readPhone(body.phone);
        if (!phone?.ok || !await reservedGraphMatches(tx, employee, prepared.data, tenantId, phone.phoneE164, operatorId, selected)) {
          return refuse(409, "The reserved employee login has changed; review its links before retrying");
        }
        return { ...prepared.data, actionId: receipt.id };
      });
      if (pending && "status" in pending) return res.status(pending.status).json({ message: pending.message });
      return res.json(pending);
    } catch (error) { next(error); }
  });

  app.post("/api/employees/:id/enable-login", requireAuth, requireManager, async (req, res, next) => {
    if (legacyLoginEnabled()) return next();
    res.setHeader("Cache-Control", "no-store");
    try {
      const actor = req.userWithAccess;
      const tenantId = await options.userManagementTenant(req);
      if (!actor || !req.user || !tenantId) return res.status(403).json({ message: "Park context is required" });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid login request" });
      const body = parsed.data;
      const config = suiteProvisionConfig();
      if (!config) return res.status(503).json({ code: "UNCONFIGURED", message: SUITE_PROVISION_UNCONFIGURED });
      const phone = readPhone(body.phone);
      if (!phone?.ok) return res.status(400).json({ message: phone && !phone.ok ? phone.message : "A phone number is needed for launcher sign-in" });
      const role = grantedRoleFor(actor.role, body.accessLevel);
      if (!role) return res.status(403).json({ message: "Only administrators can grant ADMIN access level" });
      if (body.branchScope === "ALL" && (!isAdminRole(actor.role) || !actor.hasAllBranchesAccess)) {
        return res.status(403).json({ message: "Only administrators with access to all branches can grant all branches" });
      }
      const grantedOperatorId = role === "operator_admin" ? actor.operatorId : null;
      if (role === "operator_admin" && !grantedOperatorId) {
        return res.status(403).json({ message: "Your login has no operator, so it cannot grant ADMIN. Ask a global admin." });
      }
      const payloadHash = payloadHashFor(body);
      // Computed before opening the transaction; no usable local password exists.
      const password = await unusablePassword();
      const reservation = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(633, hashtext(${body.actionId}))`);
        const [employee] = await tx.select().from(employees)
          .where(and(eq(employees.id, req.params.id), eq(employees.tenantId, tenantId))).for("update");
        if (!employee) return refuse(404, "Employee not found");
        if (!canUserAccessBranch(actor, employee.branchId)) return refuse(403, "Access denied to this employee");
        const selected = [...new Set(body.branchScope === "ALL" ? [] : body.branchIds ?? (employee.branchId ? [employee.branchId] : []))];
        const branchRows = selected.length ? await tx.select().from(branches)
          .where(and(eq(branches.tenantId, tenantId), inArray(branches.id, selected))).for("share") : [];
        if (branchRows.length !== selected.length) return refuse(403, "Selected branches are not available");
        if (!actor.hasAllBranchesAccess && selected.some(id => !actor.allowedBranchIds.includes(id))) {
          return refuse(403, "You can only grant branches you have access to");
        }
        const [employeeBranch] = employee.branchId ? await tx.select().from(branches)
          .where(and(eq(branches.id, employee.branchId), eq(branches.tenantId, tenantId))).for("share") : [];
        if (employee.branchId && !employeeBranch) return refuse(403, "Employee branch is not available");
        const operatorId = grantedOperatorId ?? employeeBranch?.operatorId ?? null;
        if (operatorId) {
          const [operator] = await tx.select({ id: operators.id }).from(operators)
            .where(and(eq(operators.id, operatorId), eq(operators.tenantId, tenantId))).for("share");
          if (!operator) return refuse(403, "Employee operator is not available");
        }
        const [receipt] = await tx.select().from(employeeActionReceipts).where(eq(employeeActionReceipts.id, body.actionId));
        if (receipt) {
          if (receipt.tenantId !== tenantId || receipt.employeeId !== employee.id || receipt.actorId !== actor.id
            || receipt.action !== "suite-enable-login" || receipt.payloadHash !== payloadHash) {
            return refuse(409, "Request ID already belongs to another action");
          }
          const prepared = preparedSchema.safeParse(receipt.responseBody.result);
          if (!prepared.success) throw new Error("Employee login reservation could not be read");
          if (payloadHashFor(prepared.data.request) !== payloadHash || !sameIds(receipt.responseBody.branchIds, selected)
            || !await reservedGraphMatches(tx, employee, prepared.data, tenantId, phone.phoneE164, operatorId, selected)) {
            return refuse(409, "The reserved employee login has changed; review its links before retrying");
          }
          return prepared.data;
        }
        if (employee.userId) return refuse(409, "Employee already has a login account");
        const loginEmail = body.email || employee.email;
        if (!loginEmail) return refuse(400, "Email is required for login access");
        const [duplicate] = await tx.select({ id: users.id }).from(users)
          .where(sql`lower(${users.email}) = lower(${loginEmail})`);
        if (duplicate) return refuse(409, "A user with this email already exists");
        const [phoneHolder] = await tx.select({ id: users.id }).from(users).where(eq(users.phoneE164, phone.phoneE164));
        if (phoneHolder) return refuse(409, "Another user here already has that phone number");
        let [person] = await tx.select().from(people)
          .where(employee.personId ? eq(people.id, employee.personId) : eq(people.email, loginEmail)).for("update");
        if (employee.personId && !person) return refuse(409, "Employee person link is unavailable");
        if (person) {
          const carriers = await tx.select({ tenantId: employees.tenantId }).from(employees).where(eq(employees.personId, person.id));
          const policies = await tx.select().from(accessPolicies).where(eq(accessPolicies.personId, person.id));
          const anchors = new Set([person.tenantId, ...carriers.map(row => row.tenantId), ...policies.map(row => row.tenantId)].filter(Boolean));
          if (!anchors.size) {
            const knownTenants = await tx.select({ id: tenants.id }).from(tenants).limit(2);
            if (knownTenants.length === 1) anchors.add(knownTenants[0].id);
          }
          if (anchors.size !== 1 || !anchors.has(tenantId)) return refuse(409, "Person belongs to another or unresolved park group");
          // A different email on an existing person must not conceal a login.
          const [personUser] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${person.email})`);
          if (personUser) return refuse(409, "This person already has a login account");
          if (policies[0]) {
            if (employee.personId) return refuse(400, "This employee already has an access policy configured");
            const [linked] = policies[0].coreUserId ? await tx.select({ id: users.id }).from(users).where(eq(users.id, policies[0].coreUserId)) : [];
            if (linked) return refuse(409, "This person already has a login account");
            await tx.delete(accessPolicies).where(eq(accessPolicies.id, policies[0].id));
          }
        } else {
          [person] = await tx.insert(people).values({ tenantId, fullName: employee.fullName,
            preferredName: null, email: loginEmail, personType: "EMPLOYEE",
            phoneNumber: phone.phoneNumber, phoneE164: phone.phoneE164 }).returning();
        }
        const [user] = await tx.insert(users).values({ email: loginEmail, password, fullName: employee.fullName,
          role, operatorId, isActive: true, mustChangePassword: false, createdBy: actor.id,
          phoneNumber: phone.phoneNumber, phoneE164: phone.phoneE164 }).returning();
        await storage.createActivityLog({ tenantId, employeeId: employee.id, activityType: "user_permissions_updated",
          createdBy: actor.id, summaryText: "Prepared employee launcher sign-in; platform confirmation pending",
          metadataJson: JSON.stringify({ actionId: body.actionId, userId: user.id, phase: "prepared" }) }, tx);
        if (body.branchScope === "ALL") {
          await tx.insert(userBranchAccess).values({ tenantId, userId: user.id, branchId: null, accessScope: "all_branches" });
        } else if (selected.length) {
          await tx.insert(userBranchAccess).values(selected.map(branchId => ({ tenantId, userId: user.id, branchId, accessScope: "selected_branches" as const })));
        }
        const [policy] = await tx.insert(accessPolicies).values({ tenantId, personId: person.id,
          accessLevel: body.accessLevel ?? "STAFF", modules: modulesFor(body), branchScope: body.branchScope ?? "SELECTED", branchIds: selected,
          coreUserId: user.id, coreAccountEnabled: false, provisioningStatus: "NOT_STARTED" }).returning();
        await tx.update(employees).set({ personId: person.id, userId: user.id, updatedAt: new Date() }).where(eq(employees.id, employee.id));
        const prepared = { phase: "prepared" as const, personId: person.id, userId: user.id, accessPolicyId: policy.id, request: body };
        await tx.insert(employeeActionReceipts).values({ id: body.actionId, tenantId, employeeId: employee.id, actorId: actor.id,
          action: "suite-enable-login", payloadHash, responseStatus: 202, responseBody: { result: prepared, branchIds: selected } });
        return prepared;
      });
      if ("status" in reservation) return res.status(reservation.status).json({ message: reservation.message });
      const result = await provisionSuiteSignIn(config, { actionId: body.actionId, appUserId: reservation.userId,
        phone: phone.phoneE164, actorAppUserId: actor.id }, req.requestId);
      if (!result.ok) return res.status(result.status).json({ code: result.code, message: result.message });
      // Only identifiers and status are durable; the temporary password is never a receipt.
      await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(633, hashtext(${body.actionId}))`);
        const [receipt] = await tx.select().from(employeeActionReceipts).where(eq(employeeActionReceipts.id, body.actionId));
        if (!receipt || receipt.payloadHash !== payloadHash || receipt.actorId !== actor.id) throw new Error("Employee login reservation changed");
        if (receipt.responseStatus !== 200) {
          await tx.update(employeeActionReceipts).set({ responseStatus: 200, responseBody: {
            result: { ...reservation, phase: "completed", accountId: result.accountId }, branchIds: receipt.responseBody.branchIds,
          } }).where(eq(employeeActionReceipts.id, body.actionId));
          await storage.createActivityLog({ tenantId, employeeId: req.params.id, activityType: "user_permissions_updated",
            createdBy: actor.id, summaryText: "Confirmed employee launcher sign-in",
            metadataJson: JSON.stringify({ actionId: body.actionId, userId: reservation.userId, phase: "completed" }) }, tx);
        }
      });
      options.committed(req.params.id);
      return res.json(responseSchema.parse({ success: true, personId: reservation.personId, userId: reservation.userId,
        accessPolicyId: reservation.accessPolicyId, accountId: result.accountId, phone: result.phone,
        temporaryPassword: result.temporaryPassword, replayed: result.replayed, platformManaged: result.platformManaged }));
    } catch (error) { next(error); }
  });
}
