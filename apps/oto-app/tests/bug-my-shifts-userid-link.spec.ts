// seed: full
import { test, expect } from "@playwright/test";
import { db } from "../server/db";
import { branches, employees, scheduleAssignments, scheduleShiftRows, users } from "../shared/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { login } from "./helpers";

async function findSeededStaffWithShifts() {
  const [row] = await db
    .select({
      email: users.email,
      employeeId: employees.id,
      branchId: branches.id,
      shiftDate: scheduleAssignments.shiftDate,
    })
    .from(users)
    .innerJoin(employees, eq(employees.userId, users.id))
    .innerJoin(scheduleAssignments, eq(scheduleAssignments.employeeId, employees.id))
    .innerJoin(scheduleShiftRows, eq(scheduleShiftRows.id, scheduleAssignments.shiftRowId))
    .innerJoin(branches, eq(branches.id, scheduleShiftRows.branchId))
    .where(and(
      eq(users.role, "staff"),
      isNotNull(scheduleAssignments.employeeId),
      sql`extract(isodow from ${scheduleAssignments.shiftDate}) between 1 and 6`,
    ))
    .limit(1);

  expect(row, "Full seed should include a staff user linked by userId with at least one shift").toBeTruthy();
  return row;
}

test("employee linked by userId can see their My Shifts rota", async ({ page }) => {
  const seeded = await findSeededStaffWithShifts();

  await login(page, { email: seeded.email, password: "Password123!" });

  const myTimeOff = await page.evaluate(async () => {
    const res = await fetch("/api/my-time-off?dateFrom=2026-04-20&dateTo=2026-04-24", {
      credentials: "include",
    });
    return { status: res.status, body: await res.json() };
  });

  expect(myTimeOff.status, JSON.stringify(myTimeOff.body)).toBe(200);
  expect(myTimeOff.body.employeeId).toBe(seeded.employeeId);

  const myShifts = await page.evaluate(async ({ branchId, shiftDate }) => {
    const res = await fetch(
      `/api/rota?scope=me&branchId=${branchId}&from=${shiftDate}&to=${shiftDate}`,
      { credentials: "include" },
    );
    return { status: res.status, body: await res.json() };
  }, seeded);

  expect(myShifts.status, JSON.stringify(myShifts.body)).toBe(200);
  expect(myShifts.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        date: seeded.shiftDate,
        employeeId: seeded.employeeId,
      }),
    ]),
  );
  expect(myShifts.body.every((shift: { employeeId: string }) => shift.employeeId === seeded.employeeId)).toBe(true);
});
