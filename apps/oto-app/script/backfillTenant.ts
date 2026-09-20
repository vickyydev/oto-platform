import { db, pool } from "../server/db";
import { 
  tenants, 
  DEFAULT_TENANT_SLUG,
  branches,
  departments,
  employees,
  roles,
  scheduleTemplates,
  scheduleTemplateRows,
  scheduleTemplateRowRoles,
  scheduleWeekPlans,
  scheduleShiftRows,
  scheduleShiftRowRoles,
  scheduleAssignments,
  shifts,
  shiftRequiredRoles,
  timeEvents,
  employeeTimeOff,
  employeePresence,
  userBranchAccess,
  accessPolicies,
} from "../shared/schema";
import { eq, isNull, count } from "drizzle-orm";
import { assertDevEnv } from "../server/config/env";

assertDevEnv();

async function ensureDefaultTenant(): Promise<string> {
  const existing = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);

  if (existing.length > 0) {
    console.log(`Default tenant already exists: ${existing[0].id}`);
    return existing[0].id;
  }

  const [newTenant] = await db
    .insert(tenants)
    .values({
      name: "OTO Default",
      slug: DEFAULT_TENANT_SLUG,
    })
    .returning();

  console.log(`Created default tenant: ${newTenant.id}`);
  return newTenant.id;
}

type BackfillResult = {
  beforeCount: number;
  afterCount: number;
  error?: string;
};

async function backfillBranches(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(branches).where(isNull(branches.tenantId));
    await db.update(branches).set({ tenantId }).where(isNull(branches.tenantId));
    const [after] = await db.select({ count: count() }).from(branches).where(isNull(branches.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillDepartments(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(departments).where(isNull(departments.tenantId));
    await db.update(departments).set({ tenantId }).where(isNull(departments.tenantId));
    const [after] = await db.select({ count: count() }).from(departments).where(isNull(departments.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillEmployees(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(employees).where(isNull(employees.tenantId));
    await db.update(employees).set({ tenantId }).where(isNull(employees.tenantId));
    const [after] = await db.select({ count: count() }).from(employees).where(isNull(employees.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillRoles(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(roles).where(isNull(roles.tenantId));
    await db.update(roles).set({ tenantId }).where(isNull(roles.tenantId));
    const [after] = await db.select({ count: count() }).from(roles).where(isNull(roles.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillScheduleTemplates(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(scheduleTemplates).where(isNull(scheduleTemplates.tenantId));
    await db.update(scheduleTemplates).set({ tenantId }).where(isNull(scheduleTemplates.tenantId));
    const [after] = await db.select({ count: count() }).from(scheduleTemplates).where(isNull(scheduleTemplates.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillScheduleTemplateRows(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(scheduleTemplateRows).where(isNull(scheduleTemplateRows.tenantId));
    await db.update(scheduleTemplateRows).set({ tenantId }).where(isNull(scheduleTemplateRows.tenantId));
    const [after] = await db.select({ count: count() }).from(scheduleTemplateRows).where(isNull(scheduleTemplateRows.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillScheduleTemplateRowRoles(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(scheduleTemplateRowRoles).where(isNull(scheduleTemplateRowRoles.tenantId));
    await db.update(scheduleTemplateRowRoles).set({ tenantId }).where(isNull(scheduleTemplateRowRoles.tenantId));
    const [after] = await db.select({ count: count() }).from(scheduleTemplateRowRoles).where(isNull(scheduleTemplateRowRoles.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillScheduleWeekPlans(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(scheduleWeekPlans).where(isNull(scheduleWeekPlans.tenantId));
    await db.update(scheduleWeekPlans).set({ tenantId }).where(isNull(scheduleWeekPlans.tenantId));
    const [after] = await db.select({ count: count() }).from(scheduleWeekPlans).where(isNull(scheduleWeekPlans.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillScheduleShiftRows(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(scheduleShiftRows).where(isNull(scheduleShiftRows.tenantId));
    await db.update(scheduleShiftRows).set({ tenantId }).where(isNull(scheduleShiftRows.tenantId));
    const [after] = await db.select({ count: count() }).from(scheduleShiftRows).where(isNull(scheduleShiftRows.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillScheduleShiftRowRoles(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(scheduleShiftRowRoles).where(isNull(scheduleShiftRowRoles.tenantId));
    await db.update(scheduleShiftRowRoles).set({ tenantId }).where(isNull(scheduleShiftRowRoles.tenantId));
    const [after] = await db.select({ count: count() }).from(scheduleShiftRowRoles).where(isNull(scheduleShiftRowRoles.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillScheduleAssignments(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(scheduleAssignments).where(isNull(scheduleAssignments.tenantId));
    await db.update(scheduleAssignments).set({ tenantId }).where(isNull(scheduleAssignments.tenantId));
    const [after] = await db.select({ count: count() }).from(scheduleAssignments).where(isNull(scheduleAssignments.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillShifts(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(shifts).where(isNull(shifts.tenantId));
    await db.update(shifts).set({ tenantId }).where(isNull(shifts.tenantId));
    const [after] = await db.select({ count: count() }).from(shifts).where(isNull(shifts.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillShiftRequiredRoles(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(shiftRequiredRoles).where(isNull(shiftRequiredRoles.tenantId));
    await db.update(shiftRequiredRoles).set({ tenantId }).where(isNull(shiftRequiredRoles.tenantId));
    const [after] = await db.select({ count: count() }).from(shiftRequiredRoles).where(isNull(shiftRequiredRoles.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillTimeEvents(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(timeEvents).where(isNull(timeEvents.tenantId));
    await db.update(timeEvents).set({ tenantId }).where(isNull(timeEvents.tenantId));
    const [after] = await db.select({ count: count() }).from(timeEvents).where(isNull(timeEvents.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillEmployeeTimeOff(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(employeeTimeOff).where(isNull(employeeTimeOff.tenantId));
    await db.update(employeeTimeOff).set({ tenantId }).where(isNull(employeeTimeOff.tenantId));
    const [after] = await db.select({ count: count() }).from(employeeTimeOff).where(isNull(employeeTimeOff.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillEmployeePresence(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(employeePresence).where(isNull(employeePresence.tenantId));
    await db.update(employeePresence).set({ tenantId }).where(isNull(employeePresence.tenantId));
    const [after] = await db.select({ count: count() }).from(employeePresence).where(isNull(employeePresence.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillUserBranchAccess(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(userBranchAccess).where(isNull(userBranchAccess.tenantId));
    await db.update(userBranchAccess).set({ tenantId }).where(isNull(userBranchAccess.tenantId));
    const [after] = await db.select({ count: count() }).from(userBranchAccess).where(isNull(userBranchAccess.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function backfillAccessPolicies(tenantId: string): Promise<BackfillResult> {
  try {
    const [before] = await db.select({ count: count() }).from(accessPolicies).where(isNull(accessPolicies.tenantId));
    await db.update(accessPolicies).set({ tenantId }).where(isNull(accessPolicies.tenantId));
    const [after] = await db.select({ count: count() }).from(accessPolicies).where(isNull(accessPolicies.tenantId));
    return { beforeCount: before?.count ?? 0, afterCount: after?.count ?? 0 };
  } catch (e: any) { return { beforeCount: 0, afterCount: 0, error: e.message }; }
}

async function main() {
  console.log("=== Tenant Backfill Script ===");
  console.log(`Environment: ${process.env.APP_ENV}`);
  console.log("");

  const defaultTenantId = await ensureDefaultTenant();
  console.log(`Using default tenant ID: ${defaultTenantId}`);
  console.log("");

  console.log("Backfilling tables...");
  console.log("-".repeat(60));

  const tableBackfills = [
    { name: "branches", fn: backfillBranches },
    { name: "departments", fn: backfillDepartments },
    { name: "employees", fn: backfillEmployees },
    { name: "roles", fn: backfillRoles },
    { name: "schedule_templates", fn: backfillScheduleTemplates },
    { name: "schedule_template_rows", fn: backfillScheduleTemplateRows },
    { name: "schedule_template_row_roles", fn: backfillScheduleTemplateRowRoles },
    { name: "schedule_week_plans", fn: backfillScheduleWeekPlans },
    { name: "schedule_shift_rows", fn: backfillScheduleShiftRows },
    { name: "schedule_shift_row_roles", fn: backfillScheduleShiftRowRoles },
    { name: "schedule_assignments", fn: backfillScheduleAssignments },
    { name: "shifts", fn: backfillShifts },
    { name: "shift_required_roles", fn: backfillShiftRequiredRoles },
    { name: "time_events", fn: backfillTimeEvents },
    { name: "employee_time_off", fn: backfillEmployeeTimeOff },
    { name: "employee_presence", fn: backfillEmployeePresence },
    { name: "user_branch_access", fn: backfillUserBranchAccess },
    { name: "access_policies", fn: backfillAccessPolicies },
  ];

  let totalUpdated = 0;
  let hasRemainingNull = false;
  let hasErrors = false;

  for (const { name, fn } of tableBackfills) {
    const result = await fn(defaultTenantId);
    
    if (result.error) {
      if (result.error.includes("does not exist")) {
        console.log(`  ${name.padEnd(30)} SKIPPED (table/column missing)`);
      } else {
        console.error(`  ${name.padEnd(30)} ERROR: ${result.error}`);
        hasErrors = true;
      }
    } else {
      const updated = result.beforeCount - result.afterCount;
      totalUpdated += updated;
      
      if (result.afterCount > 0) {
        console.log(`  ${name.padEnd(30)} WARN: ${updated} updated, ${result.afterCount} still NULL`);
        hasRemainingNull = true;
      } else {
        console.log(`  ${name.padEnd(30)} OK: ${updated} rows updated`);
      }
    }
  }

  console.log("-".repeat(60));
  console.log(`Total rows updated: ${totalUpdated}`);
  console.log("");

  if (hasErrors) {
    console.error("FAILED: Errors occurred during backfill!");
    await pool.end();
    process.exit(1);
  }

  if (hasRemainingNull) {
    console.error("FAILED: Some rows still have NULL tenant_id values!");
    console.error("Cannot safely apply NOT NULL constraint.");
    await pool.end();
    process.exit(1);
  }

  console.log("SUCCESS: All rows have been backfilled with tenant_id.");
  console.log("It is now safe to apply NOT NULL constraints.");

  await pool.end();
  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  pool.end();
  process.exit(1);
});
