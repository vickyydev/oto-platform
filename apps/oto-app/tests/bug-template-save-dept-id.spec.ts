// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: When saving a department-scoped schedule template, every
 * template row must have its departmentId set to the requested department —
 * not whatever departmentId happened to be on the source shift row.
 *
 * Bug: saveWeekAsTemplate writes `departmentId: row.departmentId` for each
 * template row. The POST /api/schedule/shift-rows endpoint always sets
 * departmentId = null on new rows, so a template saved for "Dept A" produces
 * template rows with departmentId = null rather than Dept A.
 *
 * Demonstration:
 *   - Create shift row (departmentId = null by default from the API)
 *   - Assign employee from Dept A to that shift
 *   - Save as a department template scoped to Dept A
 *   - GET the saved template
 *   - Assert: every template row has departmentId == Dept A's id
 *   → With the bug the assertion FAILS (rows have departmentId = null)
 *   → After the fix the assertion PASSES (rows inherit the requested department)
 */

test("department template rows are tagged with the requested departmentId, not the shift row's original value", async ({
  page,
}) => {
  await login(page);

  // ── 1. Setup ──────────────────────────────────────────────────────────────
  const branches = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json())
  );
  const branch = branches.find((b: { name: string }) => b.name === "Bangkok");
  expect(branch, "Seeded Bangkok branch should exist").toBeTruthy();
  const branchId: string = branch.id;

  const departments = await page.evaluate(() =>
    fetch("/api/departments").then((r) => r.json())
  );
  const dept = departments.find((d: { name: string }) => d.name === "Front Desk");
  expect(dept, "Seeded Front Desk department should exist").toBeTruthy();

  const ts = Date.now();

  // ── 2. Create an employee in that department ───────────────────────────────
  const employee = await page.evaluate(
    ([bid, did, ts_]: string[]) =>
      fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: `DeptTmpl ${ts_}`,
          nickname: `DT${ts_}`,
          email: `dept-tmpl-${ts_}@example.com`,
          branchId: bid,
          primaryDepartmentId: did,
          status: "active",
          employmentState: "ACTIVE",
        }),
      }).then((r) => r.json()),
    [branchId, dept.id, String(ts)]
  );
  expect(employee.id, "Employee should be created").toBeTruthy();

  // ── 3. Create shift group and shift row ───────────────────────────────────
  //    Note: POST /api/schedule/shift-rows always sets departmentId = null.
  //    This is exactly the scenario that triggers the bug.
  const group = await page.evaluate(
    ([bid, name]: string[]) =>
      fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, name }),
      }).then((r) => r.json()),
    [branchId, `DeptTmpl-${ts}`]
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
          label: "DeptTmpl Shift",
          staffRequired: 1,
        }),
      }).then((r) => r.json()),
    [branchId, group.id]
  );
  expect(shiftRow.id).toBeTruthy();

  // Confirm the shift row has no department (the POST API always sets null)
  expect(
    shiftRow.departmentId,
    "Shift row departmentId should be null — that is the bug precondition"
  ).toBeNull();

  // ── 4. Assign the employee to the shift row ───────────────────────────────
  const today = new Date();
  const daysToMonday = (8 - today.getDay()) % 7 || 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysToMonday);
  const weekStart = monday.toISOString().split("T")[0];
  const shiftDate = weekStart;

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
    [branchId, weekStart, shiftRow.id, employee.id, shiftDate]
  );
  expect(assignment.id).toBeTruthy();

  // ── 5. Save as a department template scoped to dept ───────────────────────
  const template = await page.evaluate(
    ([bid, wsd, did, name]: string[]) =>
      fetch("/api/schedule/templates/save-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          weekStartDate: wsd,
          departmentId: did,
          name,
        }),
      }).then((r) => r.json()),
    [branchId, weekStart, dept.id, `DeptTmpl ${ts}`]
  );
  expect(template.id, "Template should be saved").toBeTruthy();

  // ── 6. GET the saved template and inspect the rows' departmentId ──────────
  const savedTemplate = await page.evaluate(
    (tid: string) =>
      fetch(`/api/schedule/templates/${tid}`).then((r) => r.json()),
    template.id
  );

  expect(
    savedTemplate.rows,
    "Template should have rows"
  ).toBeDefined();
  expect(savedTemplate.rows.length).toBeGreaterThan(0);

  // ── 7. Every row must have departmentId = dept.id ─────────────────────────
  const wrongRows = savedTemplate.rows.filter(
    (r: { departmentId: string | null }) => r.departmentId !== dept.id
  );

  expect(
    wrongRows.map((r: { departmentId: string | null }) => r.departmentId),
    `All template rows must have departmentId = "${dept.id}" ("${dept.name}"). ` +
      `Found rows with wrong departmentId: ` +
      JSON.stringify(wrongRows.map((r: { departmentId: string | null }) => r.departmentId)) +
      `. The bug is in saveWeekAsTemplate which writes row.departmentId (null for new rows) ` +
      `instead of the requested departmentId parameter.`
  ).toHaveLength(0);
});
