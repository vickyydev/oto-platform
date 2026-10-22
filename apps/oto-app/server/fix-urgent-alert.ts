import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { accessPolicies, branches, employees, people, users } from "../shared/schema";
import { db } from "./db";
import { createFixReportUrgentNotification } from "./notification-service";

/**
 * SCRUM-656: the logins of a Fix Department's members, counted the three ways
 * the Fix module already counts a member (isUserFixDeptMember in routes.ts):
 * an employee record whose primary department it is, an advisor of that
 * department through their access policy's login, and an advisor matched to a
 * login by email. Held to the park group; deactivated logins are left out.
 */
export async function readFixDepartmentLogins(tenantId: string, departmentId: string): Promise<string[]> {
  const [employeeRows, advisorRows, emailRows] = await Promise.all([
    db.select({ userId: employees.userId }).from(employees).where(and(
      eq(employees.tenantId, tenantId),
      eq(employees.primaryDepartmentId, departmentId),
      isNotNull(employees.userId),
    )),
    db.select({ userId: accessPolicies.coreUserId }).from(people)
      .innerJoin(accessPolicies, eq(accessPolicies.personId, people.id))
      .where(and(
        eq(people.tenantId, tenantId),
        eq(accessPolicies.tenantId, tenantId),
        eq(people.departmentId, departmentId),
        isNotNull(accessPolicies.coreUserId),
      )),
    db.select({ userId: users.id }).from(people)
      .innerJoin(users, eq(users.email, people.email))
      .where(and(eq(people.tenantId, tenantId), eq(people.departmentId, departmentId))),
  ]);
  const ids = [...new Set([...employeeRows, ...advisorRows, ...emailRows]
    .map(row => row.userId)
    .filter((id): id is string => !!id))];
  if (!ids.length) return [];
  const active = await db.select({ id: users.id }).from(users)
    .where(and(inArray(users.id, ids), eq(users.isActive, true)));
  return active.map(row => row.id);
}

/**
 * SCRUM-656: a Fix report created with the highest priority ("urgent") tells
 * every member of the Fix Department it was assigned to, in the app's own
 * notification inbox. Never SMS or email. A failure here is logged and never
 * fails the report, which is already saved.
 */
export async function alertUrgentFixReport(report: {
  id: string;
  tenantId: string;
  branchId: string;
  title: string;
  priority: string;
  reportedBy: string;
  assignedDepartmentId: string | null;
}): Promise<void> {
  if (report.priority !== "urgent" || !report.assignedDepartmentId) return;
  try {
    const [branch] = await db.select({ name: branches.name }).from(branches)
      .where(and(eq(branches.id, report.branchId), eq(branches.tenantId, report.tenantId))).limit(1);
    const recipientUserIds = await readFixDepartmentLogins(report.tenantId, report.assignedDepartmentId);
    await createFixReportUrgentNotification({
      tenantId: report.tenantId,
      reportId: report.id,
      reportTitle: report.title,
      branchName: branch?.name || "a branch",
      authorUserId: report.reportedBy,
      recipientUserIds,
    });
  } catch (error) {
    console.error("[FixUrgentAlert] Failed to alert the Fix Department:", error);
  }
}
