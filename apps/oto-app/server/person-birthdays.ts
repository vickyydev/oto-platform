import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { accessPolicies, branches, employees, people, users } from "@shared/schema";
import { birthdayDateInYear } from "../shared/birthday";

export async function findBirthdayEmployee(userId: string, email: string, tenantId?: string) {
  if (!tenantId) return null;
  const tenant = eq(employees.tenantId, tenantId);
  const direct = await db.select().from(employees)
    .where(and(tenant, eq(employees.userId, userId))).limit(2);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null;

  const policyMatches = await db.select({ employee: employees }).from(employees)
    .innerJoin(accessPolicies, eq(accessPolicies.personId, employees.personId))
    .where(and(tenant, eq(accessPolicies.tenantId, tenantId), eq(accessPolicies.coreUserId, userId)))
    .limit(2);
  if (policyMatches.length === 1) return policyMatches[0].employee;
  if (policyMatches.length > 1) return null;

  // Legacy linkage: only an unambiguous email within this tenant may match.
  const matches = await db.select().from(employees)
    .where(and(tenant, sql`lower(${employees.email}) = lower(${email})`)).limit(2);
  return matches.length === 1 ? matches[0] : null;
}

export interface PersonBirthday {
  id: string;
  personId: string;
  name: string;
  date: string;
  branchId: string | null;
  kind: "person_birthday";
  title: string;
}

export function projectBirthdayOccurrences(
  records: Array<{ identity: string; name: string; month: number | null; day: number | null; branchIds: string[] }>,
  visible: Set<string>, start: string, end: string,
): PersonBirthday[] {
  const result: PersonBirthday[] = [];
  const seen = new Set<string>();
  const years = Array.from({ length: Number(end.slice(0, 4)) - Number(start.slice(0, 4)) + 1 },
    (_, i) => Number(start.slice(0, 4)) + i);
  for (const { identity, name, month, day, branchIds } of records) {
    if (!month || !day) continue;
    const branchId = branchIds.find(id => visible.has(id));
    if (!branchId) continue;
    for (const year of years) {
      const date = birthdayDateInYear(month, day, year);
      if (date < start || date > end) continue;
      const id = `person-birthday:${identity}:${date}`;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ id, personId: identity, name, date, branchId,
        kind: "person_birthday", title: `🎉 ${name}’s Birthday` });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

export async function getPersonBirthdays({
  tenantId, allowedBranchIds, branchId, start, end,
}: {
  tenantId: string; allowedBranchIds: string[] | null;
  branchId?: string; start: string; end: string;
}): Promise<PersonBirthday[]> {
  const availableBranches = await db.select({ id: branches.id }).from(branches)
    .where(eq(branches.tenantId, tenantId));
  const visible = new Set(availableBranches.map(b => b.id)
    .filter(id => (allowedBranchIds === null || allowedBranchIds.includes(id)) && (!branchId || branchId === id)));
  if (!visible.size) return [];
  const records: Array<{ identity: string; name: string; month: number | null; day: number | null; branchIds: string[] }> = [];

  const staff = await db.select({ employee: employees, person: people, account: users })
    .from(employees)
    .leftJoin(people, eq(people.id, employees.personId))
    .leftJoin(users, eq(users.id, employees.userId))
    .where(and(eq(employees.tenantId, tenantId), eq(employees.status, "active"),
      eq(employees.employmentState, "ACTIVE")));
  for (const { employee, person, account } of staff) {
    if (!employee.branchId || (person && !person.isActive) || (account && !account.isActive)) continue;
    if (!account && employee.email) {
      const legacyAccounts = await db.select({ isActive: users.isActive }).from(users)
        .where(sql`lower(${users.email}) = lower(${employee.email})`).limit(1);
      if (legacyAccounts[0] && !legacyAccounts[0].isActive) continue;
    }
    records.push({ identity: person?.id ?? `employee:${employee.id}`, name: employee.nickname || employee.fullName,
      month: employee.birthdayMonth, day: employee.birthdayDay, branchIds: [employee.branchId] });
  }

  const advisors = await db.select({ person: people, policy: accessPolicies })
    .from(people)
    .innerJoin(accessPolicies, eq(accessPolicies.personId, people.id))
    .where(and(eq(accessPolicies.tenantId, tenantId), eq(people.personType, "ADVISOR"),
      eq(people.isActive, true)));
  for (const { person, policy } of advisors) {
    // Explicit account link takes precedence. Email is only a fallback for
    // legacy policies, and must identify exactly one active account.
    const explicit = policy.coreUserId
      ? await db.select().from(users).where(eq(users.id, policy.coreUserId)).limit(1)
      : [];
    const candidates = explicit.length ? explicit : await db.select().from(users)
      .where(sql`lower(${users.email}) = lower(${person.email})`).limit(2);
    if (candidates.length !== 1 || !candidates[0].isActive) continue;
    const account = candidates[0];
    const ids = policy.branchScope === "ALL"
      ? availableBranches.map(b => b.id) : policy.branchIds ?? [];
    records.push({ identity: person.id, name: person.preferredName || account.preferredName || person.fullName,
      month: account.birthdayMonth, day: account.birthdayDay, branchIds: ids });
  }
  return projectBirthdayOccurrences(records, visible, start, end);
}