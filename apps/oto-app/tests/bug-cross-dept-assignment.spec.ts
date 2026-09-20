// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: canAssignEmployeeToShift must reject an assignment where
 * the employee's department does not match the shift row's department.
 *
 * Bug: canAssignEmployeeToShift only checks roles (and only when the shift row
 * has required roles set). It has no department check at all. A shift row with
 * departmentId = B and NO required roles will accept any active employee,
 * including one whose primaryDepartmentId = A. This means:
 *   - Direct POST /api/schedule/assignments succeeds for a wrong-dept employee
 *   - A template built from such a cross-dept assignment will perpetuate it
 *     every time it is applied, even though getEligibleEmployeesForShiftRow
 *     (the UI layer) now correctly filters by department.
 *
 * This is the remaining gap in the original Bug 1 fix ("Employees with a single
 * role or department are assigned shifts in other roles or departments: this is
 * about shift templates"). The eligible-employee UI filter was fixed, but the
 * validation layer used by direct assignment and template apply was not.
 *
 * Demonstration:
 *   - Employee E has primaryDepartmentId = Dept A
 *   - Shift row S has departmentId = Dept B, with NO required roles
 *   - POST /api/schedule/assignments for E on S
 *   - Assert: the response is a 400 error (DEPT_MISMATCH)
 *   → With the bug present the assertion FAILS (201 is returned — dept not checked)
 *   → After the fix the assertion PASSES (400 DEPT_MISMATCH is returned)
 */

test("assigning an employee to a shift in a different department is rejected", async ({
  page,
}) => {
  await login(page);

  // ── 1. Get two different departments ─────────────────────────────────────
  const branches = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json())
  );
  const branchId: string = branches[0].id;

  const departments = await page.evaluate(() =>
    fetch("/api/departments").then((r) => r.json())
  );
  expect(departments.length).toBeGreaterThanOrEqual(2);
  const deptA = departments[0];
  const deptB = departments[1];

  const ts = Date.now();

  // ── 2. Create employee in Dept A ──────────────────────────────────────────
  const employee = await page.evaluate(
    ([bid, did, ts_]: string[]) =>
      fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: `CrossDept ${ts_}`,
          nickname: `CD${ts_}`,
          email: `cross-dept-${ts_}@example.com`,
          branchId: bid,
          primaryDepartmentId: did,
          status: "active",
          employmentState: "ACTIVE",
        }),
      }).then((r) => r.json()),
    [branchId, deptA.id, String(ts)]
  );
  expect(employee.id).toBeTruthy();
  expect(employee.primaryDepartmentId).toBe(deptA.id);

  // ── 3. Create shift group and shift row for Dept B — no required roles ────
  //    No roleIds are set, so the existing role check is skipped entirely.
  //    Only a department check would block this assignment.
  const group = await page.evaluate(
    ([bid, name]: string[]) =>
      fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, name }),
      }).then((r) => r.json()),
    [branchId, `CrossDept-${ts}`]
  );

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
          label: "CrossDept Shift",
          staffRequired: 1,
          // No roleIds — shift row has no role requirements
        }),
      }).then((r) => r.json()),
    [branchId, group.id]
  );
  expect(shiftRow.id).toBeTruthy();

  // Set the shift row's departmentId to Dept B via data-admin
  const updated = await page.evaluate(
    ([id, deptId]: string[]) =>
      fetch(`/api/data-admin/schedule-shift-rows/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: deptId }),
      }).then((r) => r.json()),
    [shiftRow.id, deptB.id]
  );
  expect(updated.departmentId).toBe(deptB.id);

  // ── 4. Attempt to assign the Dept A employee to the Dept B shift ──────────
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const shiftDate = futureDate.toISOString().split("T")[0];

  const response = await page.evaluate(
    ([bid, srId, empId, sd]: string[]) => {
      const today = new Date();
      const daysToMonday = (8 - today.getDay()) % 7 || 7;
      const monday = new Date(today);
      monday.setDate(today.getDate() + daysToMonday);
      const weekStart = monday.toISOString().split("T")[0];

      return fetch("/api/schedule/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          weekStartDate: weekStart,
          shiftRowId: srId,
          shiftDate: sd,
          employeeId: empId,
          assigneeType: "employee",
          isBorrowed: false,
        }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    },
    [branchId, shiftRow.id, employee.id, shiftDate]
  );

  // ── 5. The assignment must be rejected ────────────────────────────────────
  expect(
    response.status,
    `Assigning employee from Dept "${deptA.name}" to a shift in Dept "${deptB.name}" ` +
      `should be rejected with HTTP 400 (DEPT_MISMATCH). ` +
      `Got HTTP ${response.status}: ${JSON.stringify(response.body)}. ` +
      `canAssignEmployeeToShift has no department check — it only checks roles, ` +
      `and only when the shift row has required roles. A shift with no roles accepts ` +
      `any employee regardless of department.`
  ).toBe(400);

  expect(response.body.reasonCode).toBe("DEPT_MISMATCH");
});
