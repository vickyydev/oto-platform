// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: duty blocks assigned to an employee on a shift should be
 * preserved when that week is saved as a shift-group template and the template
 * is applied to the following week.
 *
 * Bug: saveWeekAsTemplate captures shift-row assignments (employee ↔ day) but
 * completely ignores duty blocks.  applyTemplateAdditive recreates the
 * assignments but never recreates the duty blocks that were attached to them.
 *
 * Demonstration:
 *   1. Create a shift group + shift row (no role requirements).
 *   2. Create an employee and assign them to the Opening shift on Mon of week W.
 *   3. Add a duty block (e.g. "Cashier") to that assignment.
 *   4. Save week W as a shift-group template.
 *   5. Apply the template to week W+1.
 *   6. Confirm the employee is assigned on Mon of W+1  (already works).
 *   7. Confirm their duty block also exists on Mon of W+1.
 *   → With the bug present step 7 FAILS (no duty blocks in W+1).
 *   → After the fix step 7 PASSES.
 */

test("duty blocks are recreated when a shift-group template is applied to a new week", async ({
  page,
}) => {
  await login(page);

  const branchId = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json()).then((b) => b[0].id)
  );

  // Pick a future Monday (three weeks out) so assignments are never on past dates.
  const today = new Date();
  const daysToMonday = (8 - today.getDay()) % 7 || 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysToMonday + 14);
  const weekStart = monday.toISOString().split("T")[0];
  const shiftDate = weekStart;

  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  const nextWeekStart = nextMonday.toISOString().split("T")[0];

  const ts = Date.now();

  // ── 1. Create a fresh shift group and shift row (no role requirements) ────
  const shiftGroup = await page.evaluate(
    ([bid, name]: string[]) =>
      fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, name }),
      }).then((r) => r.json()),
    [branchId, `DutyTest-${ts}`]
  );
  expect(shiftGroup.id, "Shift group should be created").toBeTruthy();
  const shiftGroupId: string = shiftGroup.id;

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
          label: "DutyTest Shift",
          staffRequired: 1,
        }),
      }).then((r) => r.json()),
    [branchId, shiftGroupId]
  );
  expect(shiftRow.id, "Shift row should be created").toBeTruthy();
  const shiftRowId: string = shiftRow.id;

  // ── 2. Create a fresh employee ────────────────────────────────────────────
  const employee = await page.evaluate(
    ([bid, ts_]: string[]) =>
      fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: `DutyTest ${ts_}`,
          nickname: `DT${ts_}`,
          email: `dutytest-${ts_}@example.com`,
          branchId: bid,
          status: "active",
          employmentState: "ACTIVE",
        }),
      }).then((r) => r.json()),
    [branchId, String(ts)]
  );
  expect(employee.id, "Employee should be created").toBeTruthy();

  // ── 3. Assign the employee to the shift on Monday of week W ───────────────
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
    [branchId, weekStart, shiftRowId, employee.id, shiftDate]
  );
  expect(assignment.id, "Assignment should be created").toBeTruthy();

  // ── 4. Add a duty block to that assignment ────────────────────────────────
  const dutyTypes = await page.evaluate(() =>
    fetch("/api/duty-types").then((r) => r.json())
  );
  expect(dutyTypes.length, "Need at least one duty type").toBeGreaterThan(0);
  const dutyType = dutyTypes[0];

  const dutyBlock = await page.evaluate(
    ([bid, empId, asgId, dtId, dtName, date]: string[]) =>
      fetch("/api/duty-blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          date,
          employeeId: empId,
          assignmentId: asgId,
          dutyTypeId: dtId,
          dutyName: dtName,
          startTime: "09:00",
          endTime: "10:00",
        }),
      }).then((r) => r.json()),
    [branchId, employee.id, assignment.id, dutyType.id, dutyType.name, shiftDate]
  );
  expect(dutyBlock.id, "Duty block should be created").toBeTruthy();

  // Confirm it exists on week W
  const weekWDutyBlocks = await page.evaluate(
    ([bid, date]: string[]) =>
      fetch(`/api/duty-blocks?branchId=${bid}&date=${date}`).then((r) =>
        r.json()
      ),
    [branchId, shiftDate]
  );
  expect(
    weekWDutyBlocks.some((d: { id: string }) => d.id === dutyBlock.id),
    "Duty block should exist in week W"
  ).toBe(true);

  // ── 5. Save the week as a shift-group template ────────────────────────────
  const template = await page.evaluate(
    ([bid, wsd, sgId]: string[]) =>
      fetch("/api/schedule/templates/save-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          weekStartDate: wsd,
          shiftGroupId: sgId,
          name: "Duty Block Template Test",
        }),
      }).then((r) => r.json()),
    [branchId, weekStart, shiftGroupId]
  );
  expect(template.id, "Template should be saved").toBeTruthy();

  // ── 6. Apply the template to the following week ───────────────────────────
  const applyResult = await page.evaluate(
    ([tid, bid, wsd]: string[]) =>
      fetch(`/api/schedule/templates/${tid}/apply-safe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: bid, weekStartDate: wsd }),
      }).then((r) => r.json()),
    [template.id, branchId, nextWeekStart]
  );
  expect(
    applyResult.assignmentsApplied,
    "At least one assignment should be applied"
  ).toBeGreaterThan(0);

  // ── 7. Confirm the employee is assigned in week W+1 ───────────────────────
  const nextWeekData = await page.evaluate(
    ([bid, wsd]: string[]) =>
      fetch(`/api/schedule/week?branchId=${bid}&weekStartDate=${wsd}`).then(
        (r) => r.json()
      ),
    [branchId, nextWeekStart]
  );
  const nextRow = (
    nextWeekData.shiftRows as {
      id: string;
      shiftGroupId: string;
      assignments?: { id: string; employeeId: string; shiftDate: string }[];
    }[]
  ).find((r) => r.shiftGroupId === shiftGroupId);
  const nextAssignment = nextRow?.assignments?.find(
    (a) => a.employeeId === employee.id
  );
  expect(nextAssignment, "Employee should be assigned in week W+1").toBeTruthy();

  const nextShiftDate = nextAssignment!.shiftDate;

  // ── 8. Confirm the duty block was recreated in week W+1 ───────────────────
  const nextWeekDutyBlocks = await page.evaluate(
    ([bid, date]: string[]) =>
      fetch(`/api/duty-blocks?branchId=${bid}&date=${date}`).then((r) =>
        r.json()
      ),
    [branchId, nextShiftDate]
  );

  const dutyBlockRecreated = nextWeekDutyBlocks.some(
    (d: { employeeId: string; dutyTypeId: string }) =>
      d.employeeId === employee.id && d.dutyTypeId === dutyType.id
  );

  expect(
    dutyBlockRecreated,
    `Duty block "${dutyType.name}" for employee "${employee.nickname || employee.fullName}" ` +
      `should have been recreated on ${nextShiftDate} when the template was applied. ` +
      `saveWeekAsTemplate does not save duty blocks to the template, and applyTemplateAdditive ` +
      `does not recreate them — they are silently dropped.`
  ).toBe(true);
});
