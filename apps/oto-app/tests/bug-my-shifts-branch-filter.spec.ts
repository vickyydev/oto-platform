// seed: full
import { test, expect } from "@playwright/test";
import { db } from "../server/db";
import { branches, employees, scheduleAssignments, scheduleShiftRows, userBranchAccess, users } from "../shared/schema";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { login } from "./helpers";

async function findSeededStaffShift() {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      employeeId: employees.id,
      employeeName: employees.fullName,
      employeeNickname: employees.nickname,
      shiftDate: scheduleAssignments.shiftDate,
      shiftBranchId: branches.id,
      shiftBranchName: branches.name,
    })
    .from(users)
    .innerJoin(employees, eq(employees.userId, users.id))
    .innerJoin(userBranchAccess, eq(userBranchAccess.userId, users.id))
    .innerJoin(scheduleAssignments, eq(scheduleAssignments.employeeId, employees.id))
    .innerJoin(scheduleShiftRows, eq(scheduleShiftRows.id, scheduleAssignments.shiftRowId))
    .innerJoin(branches, eq(branches.id, scheduleShiftRows.branchId))
    .where(and(
      eq(users.role, "staff"),
      eq(userBranchAccess.accessScope, "all_branches"),
      isNotNull(scheduleAssignments.employeeId),
      sql`extract(isodow from ${scheduleAssignments.shiftDate}) between 1 and 6`,
    ))
    .limit(1);

  expect(row, "Full seed should include a staff user linked to an employee with shifts").toBeTruthy();

  const [otherBranch] = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(ne(branches.id, row.shiftBranchId))
    .limit(1);

  expect(otherBranch, "Full seed should include a second branch").toBeTruthy();

  return { ...row, otherBranchId: otherBranch.id };
}

test("My Shifts shows the employee's shifts even when another branch is selected", async ({ page }) => {
  const seeded = await findSeededStaffShift();

  await login(page, { email: seeded.email, password: "Password123!" });

  const result = await page.evaluate(
    async ({ branchId, from, to }) => {
      const res = await fetch(
        `/api/rota?scope=me&branchId=${branchId}&from=${from}&to=${to}`,
        { credentials: "include" },
      );
      return { status: res.status, body: await res.json() };
    },
    { branchId: seeded.otherBranchId, from: seeded.shiftDate, to: seeded.shiftDate },
  );

  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        date: seeded.shiftDate,
        branchName: seeded.shiftBranchName,
        employeeName: seeded.employeeNickname || seeded.employeeName,
        employeeId: seeded.employeeId,
      }),
    ]),
  );
});
