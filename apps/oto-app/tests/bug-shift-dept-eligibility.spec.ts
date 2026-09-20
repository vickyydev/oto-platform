// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: Eligible employees for a shift row must be restricted
 * to the department the shift row belongs to.
 *
 * Bug: getEligibleEmployeesForShiftRow never filters by shiftRow.departmentId.
 * This means every active employee in the branch appears as eligible for every
 * shift, regardless of their department.
 *
 * Demonstration:
 *   - Create employee E in Department A
 *   - Create a shift row whose departmentId = Department B
 *   - Call eligible-employees for that shift row
 *   - Employee E (wrong department) must NOT appear in the result
 *   → With the bug present this assertion FAILS (E is returned)
 *   → After the fix this assertion PASSES (E is excluded)
 */

test("eligible employees for a shift row exclude employees from other departments", async ({
  page,
}) => {
  await login(page);

  // ── 1. Get the Bangkok branch ────────────────────────────────────────────
  const branches = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json())
  );
  expect(branches.length).toBeGreaterThan(0);
  const branchId: string = branches[0].id;

  // ── 2. Get two different departments ─────────────────────────────────────
  const departments = await page.evaluate(() =>
    fetch("/api/departments").then((r) => r.json())
  );
  expect(departments.length).toBeGreaterThanOrEqual(2);
  const deptA = departments[0]; // employee will belong to this dept
  const deptB = departments[1]; // shift row will belong to this dept
  expect(deptA.id).not.toBe(deptB.id);

  // ── 3. Create an employee whose primary department is Dept A ─────────────
  const empPayload = {
    fullName: `EligTest Employee ${Date.now()}`,
    nickname: `EligTest${Date.now()}`,
    email: `eligtest-${Date.now()}@example.com`,
    branchId,
    primaryDepartmentId: deptA.id,
    status: "active",
    employmentState: "ACTIVE",
  };
  const employee = await page.evaluate(
    (body) =>
      fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    empPayload
  );
  expect(employee.id, "Employee should be created").toBeTruthy();

  // ── 4. Create a shift group ───────────────────────────────────────────────
  const shiftGroup = await page.evaluate(
    ([bid, ts]: string[]) =>
      fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, name: `DeptTest-${ts}` }),
      }).then((r) => r.json()),
    [branchId, String(Date.now())]
  );
  expect(shiftGroup.id, "Shift group should be created").toBeTruthy();

  // ── 5. Create a shift row (departmentId starts as null) ───────────────────
  const shiftRow = await page.evaluate(
    ([bid, sgId]: string[]) =>
      fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          shiftGroupId: sgId,
          startTime: "09:00",
          endTime: "18:00",
          label: "DeptTest Shift",
          staffRequired: 1,
        }),
      }).then((r) => r.json()),
    [branchId, shiftGroup.id]
  );
  expect(shiftRow.id, "Shift row should be created").toBeTruthy();

  // ── 6. Set the shift row's departmentId to Dept B via data-admin ──────────
  //    (The normal shift-row PATCH API doesn't expose departmentId)
  const updated = await page.evaluate(
    ([id, deptId]: string[]) =>
      fetch(`/api/data-admin/schedule-shift-rows/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: deptId }),
      }).then((r) => r.json()),
    [shiftRow.id, deptB.id]
  );
  expect(
    updated.departmentId,
    "Shift row departmentId should be set to Dept B"
  ).toBe(deptB.id);

  // ── 7. Query eligible employees for the shift row (1 week from now) ───────
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const futureDateStr = futureDate.toISOString().split("T")[0];

  const eligible: { id: string; primaryDepartmentId: string | null }[] =
    await page.evaluate(
      ([rowId, date]: string[]) =>
        fetch(
          `/api/schedule/shift-rows/${rowId}/eligible-employees?date=${date}`
        ).then((r) => r.json()),
      [shiftRow.id, futureDateStr]
    );

  expect(Array.isArray(eligible)).toBe(true);

  // ── 8. The employee from Dept A must NOT appear in eligible list ──────────
  const employeeIds = eligible.map((e) => e.id);
  expect(
    employeeIds,
    `Employee from Dept A (${deptA.name}) must not be eligible for a Dept B (${deptB.name}) shift. Got IDs: ${employeeIds.join(", ")}`
  ).not.toContain(employee.id);

  // ── 9. Also verify: all returned employees have the correct department ─────
  const wrongDeptEmployees = eligible.filter(
    (e) => e.primaryDepartmentId !== deptB.id
  );
  expect(
    wrongDeptEmployees.map((e) => e.id),
    `All eligible employees should have primaryDepartmentId = Dept B. Wrong-dept employees: ${JSON.stringify(wrongDeptEmployees)}`
  ).toHaveLength(0);
});
