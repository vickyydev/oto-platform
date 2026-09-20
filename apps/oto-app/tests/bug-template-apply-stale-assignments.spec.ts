// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: applyTemplateAdditive must validate each stored assignment
 * before inserting it into the new week.
 *
 * Bug: the apply loop blindly pushes every scheduleTemplateAssignment into
 * scheduleAssignments without calling canAssignEmployeeToShift. If an employee's
 * last working day has since passed (or their role was removed, they became
 * inactive, etc.) the stale assignment is still recreated every time the template
 * is applied.
 *
 * Demonstration:
 *   - Employee E with role R is assigned to a shift requiring R; week saved as template.
 *   - E's lastWorkingDay is then set to yesterday (they have left).
 *   - Template is applied to a future week.
 *   - E must NOT appear in the new week's assignments.
 *   → With the bug present the assertion FAILS (E is assigned despite having left)
 *   → After the fix the assertion PASSES (canAssignEmployeeToShift rejects the stale entry)
 */

test("applyTemplateAdditive skips assignments for employees who are no longer eligible", async ({
  page,
}) => {
  await login(page);

  // ── 1. Setup: branch, role, shift group ───────────────────────────────────
  const branches = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json())
  );
  const branchId: string = branches[0].id;

  const roles = await page.evaluate(() =>
    fetch("/api/roles").then((r) => r.json())
  );
  expect(roles.length, "Need at least one role").toBeGreaterThan(0);
  const role = roles[0];

  const ts = Date.now();

  // ── 2. Create employee and assign the role ────────────────────────────────
  const employee = await page.evaluate(
    ([bid, ts_]: [string, string]) =>
      fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: `StaleAssign ${ts_}`,
          nickname: `SA${ts_}`,
          email: `stale-${ts_}@example.com`,
          branchId: bid,
          status: "active",
          employmentState: "ACTIVE",
        }),
      }).then((r) => r.json()),
    [branchId, String(ts)]
  );
  expect(employee.id, "Employee should be created").toBeTruthy();

  await page.evaluate(
    ([eid, rid]: string[]) =>
      fetch(`/api/employees/${eid}/roles`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleIds: [rid] }),
      }).then((r) => r.json()),
    [employee.id, role.id]
  );

  // ── 3. Create shift group and shift row requiring that role ───────────────
  const group = await page.evaluate(
    ([bid, name]: string[]) =>
      fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, name }),
      }).then((r) => r.json()),
    [branchId, `StaleApply-${ts}`]
  );

  const shiftRow = await page.evaluate(
    ([bid, sgId, rid]: string[]) =>
      fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          shiftGroupId: sgId,
          startTime: "09:00",
          endTime: "18:00",
          label: "StaleApply Shift",
          staffRequired: 1,
          roleIds: [rid],
        }),
      }).then((r) => r.json()),
    [branchId, group.id, role.id]
  );
  expect(shiftRow.id, "Shift row should be created").toBeTruthy();

  // ── 4. Assign employee to the shift row next Monday ────────────────────────
  // Find next Monday to stay in the future
  const today = new Date();
  const daysToMonday = (8 - today.getDay()) % 7 || 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysToMonday);
  const weekStartDate = monday.toISOString().split("T")[0];
  const shiftDate = monday.toISOString().split("T")[0];

  const assignment = await page.evaluate(
    ([bid, wsd, srId, empId, sd]: string[]) =>
      fetch("/api/schedule/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          weekStartDate: wsd,
          shiftRowId: srId,
          shiftDate: sd,
          employeeId: empId,
          assigneeType: "employee",
        }),
      }).then((r) => r.json()),
    [branchId, weekStartDate, shiftRow.id, employee.id, shiftDate]
  );
  expect(assignment.id, "Assignment should succeed").toBeTruthy();

  // ── 5. Save the week as a template ────────────────────────────────────────
  const template = await page.evaluate(
    ([bid, wsd, sgId, name]: string[]) =>
      fetch("/api/schedule/templates/save-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          weekStartDate: wsd,
          name,
          shiftGroupId: sgId,
        }),
      }).then((r) => r.json()),
    [branchId, weekStartDate, group.id, `StaleApply Template ${ts}`]
  );
  expect(template.id, "Template should be saved").toBeTruthy();

  // ── 6. Mark the employee as having left (lastWorkingDay = yesterday) ───────
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const patchResult = await page.evaluate(
    ([eid, lwd]: string[]) =>
      fetch(`/api/employees/${eid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastWorkingDay: lwd, employmentState: "LEFT" }),
      }).then((r) => r.json()),
    [employee.id, yesterdayStr]
  );
  expect(patchResult.id, "Employee patch should succeed").toBeTruthy();

  // ── 7. Apply the template to the week AFTER next ──────────────────────────
  const nextNextMonday = new Date(monday);
  nextNextMonday.setDate(monday.getDate() + 7);
  const nextWeekStart = nextNextMonday.toISOString().split("T")[0];

  const applyResult = await page.evaluate(
    ([tid, bid, wsd]: string[]) =>
      fetch(`/api/schedule/templates/${tid}/apply-safe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, weekStartDate: wsd }),
      }).then((r) => r.json()),
    [template.id, branchId, nextWeekStart]
  );

  // ── 8. Fetch assignments for the new week and verify E is absent ──────────
  const newWeekData = await page.evaluate(
    ([bid, wsd]: string[]) =>
      fetch(`/api/schedule/week?branchId=${bid}&weekStartDate=${wsd}`).then(
        (r) => r.json()
      ),
    [branchId, nextWeekStart]
  );

  const allAssignments: { employeeId: string | null }[] = (
    newWeekData.shiftRows ?? []
  ).flatMap((r: { assignments?: { employeeId: string | null }[] }) => r.assignments ?? []);

  const employeeWasAssigned = allAssignments.some(
    (a) => a.employeeId === employee.id
  );

  expect(
    employeeWasAssigned,
    `Employee whose lastWorkingDay was set to yesterday should NOT be assigned ` +
      `in a future week via template apply. The template apply loop does not call ` +
      `canAssignEmployeeToShift, so stale/invalid assignments are blindly recreated.`
  ).toBe(false);
});
