import type { Express, RequestHandler } from "express";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { accessPolicies, departments, employees, people } from "../shared/schema";
import type { db } from "./db";

type Database = Pick<typeof db, "select">;
export type FixDepartmentMember = { id: string; name: string; initials: string };

/** The existing department roster used on Fix reports, held to its park. */
export async function readFixDepartmentMembers(database: Database, tenantId: string, departmentIds: string[]) {
  const members = new Map<string, FixDepartmentMember[]>();
  if (!departmentIds.length) return members;
  const employeeRows = await database
    .select({ deptId: employees.primaryDepartmentId, fullName: employees.fullName, userId: employees.userId })
    .from(employees)
    .innerJoin(departments, eq(departments.id, employees.primaryDepartmentId))
    .where(and(inArray(departments.id, departmentIds), eq(departments.tenantId, tenantId),
      eq(employees.tenantId, tenantId), isNotNull(employees.userId)));
  const advisorRows = await database
    .select({ deptId: people.departmentId, fullName: people.fullName })
    .from(people)
    .innerJoin(accessPolicies, eq(accessPolicies.personId, people.id))
    .innerJoin(departments, eq(departments.id, people.departmentId))
    .where(and(inArray(departments.id, departmentIds), eq(departments.tenantId, tenantId),
      eq(accessPolicies.tenantId, tenantId), eq(people.tenantId, tenantId)));
  for (const row of employeeRows) {
    if (!row.deptId) continue;
    const name = row.fullName || "Staff";
    const list = members.get(row.deptId) || [];
    list.push({ id: row.userId || name, name, initials: initials(name) });
    members.set(row.deptId, list);
  }
  for (const row of advisorRows) {
    if (!row.deptId) continue;
    const name = row.fullName || "Advisor";
    const list = members.get(row.deptId) || [];
    if (!list.some(member => member.name === name)) {
      list.push({ id: name, name, initials: initials(name) });
    }
    members.set(row.deptId, list);
  }
  return members;
}

function initials(name: string) {
  return name.split(" ").map(part => part[0]).slice(0, 2).join("").toUpperCase();
}

export function registerFixRecipientPreview(app: Express, database: Database, requireAuth: RequestHandler) {
  app.get("/api/settings/fix-department/recipients", requireAuth, async (req, res, next) => {
    try {
      const user = req.user as { role?: string; hasAllBranchesAccess?: boolean } | undefined;
      if (!user || (!user.hasAllBranchesAccess && user.role !== "admin")) {
        return res.status(403).json({ message: "Admin access required" });
      }
      const tenantId = req.userWithAccess?.tenantId;
      if (!tenantId) return res.status(403).json({ message: "Park access required" });
      const departmentId = req.query.departmentId;
      if (typeof departmentId !== "string" || departmentId.length > 200) {
        return res.status(400).json({ message: "Choose a department to preview" });
      }
      if (!departmentId) return res.json({ department: null, members: [], count: 0 });
      const [department] = await database.select({ id: departments.id, name: departments.name })
        .from(departments).where(and(eq(departments.id, departmentId), eq(departments.tenantId, tenantId))).limit(1);
      if (!department) return res.status(404).json({ message: "Department not found" });
      const members = (await readFixDepartmentMembers(database, tenantId, [departmentId])).get(departmentId) || [];
      res.json({ department, members, count: members.length });
    } catch (error) {
      next(error);
    }
  });
}
