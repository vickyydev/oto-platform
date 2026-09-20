// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: recurring tasks assigned to a specific employee via the
 * new `assignments` API must be visible ONLY to that employee, not to everyone.
 *
 * Bug: GET /api/studio/scheduled-tasks returns the task rows but never calls
 * attachAssignmentsToTasks, so the response omits the `assignments` array.
 * The client-side isTaskMine() sees no assignments and all legacy assignment
 * fields as null, so it falls through to:
 *
 *   if (!assignedTo && !assignedEmployeeId && !assignedRoleId && !assignedDepartmentId)
 *     return true;  // visible to EVERYONE
 *
 * This makes every recurring task assigned via the new API appear as if it
 * were unassigned — it shows up for all users regardless of the "Just mine"
 * filter.
 *
 * Demonstration:
 *   1. Create a recurring daily task assigned to employee E via `assignments`.
 *   2. GET /api/studio/scheduled-tasks.
 *   3. Assert the returned task includes a non-empty `assignments` array.
 *   → With the bug the assertion FAILS (assignments is missing/empty).
 *   → After the fix the assertion PASSES.
 */

test("recurring task created with assignments API exposes assignments in /api/studio/scheduled-tasks", async ({
  page,
}) => {
  await login(page);

  const branchId = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json()).then((b) => b[0].id)
  );

  // ── 1. Find an employee to assign ────────────────────────────────────────
  const employees = await page.evaluate(
    (bid: string) =>
      fetch(`/api/employees?branchId=${bid}`).then((r) => r.json()),
    branchId
  );
  expect(employees.length, "Need at least one employee").toBeGreaterThan(0);
  const employee = employees[0];

  // ── 2. Create a recurring task assigned to that employee via assignments ──
  //    The create-task dialog sends `assignments` (new API), not the legacy
  //    `assignedEmployeeId` field.  This is what the UI actually does.
  const ts = Date.now();
  const created = await page.evaluate(
    ([bid, empId, title]: string[]) =>
      fetch("/api/core/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: bid,
          title,
          recurrence: "daily",
          preferredDueTime: "18:00",
          // Use the new assignments API — no legacy assignedEmployeeId
          assignments: [{ assignmentType: "employee", assignmentId: empId }],
        }),
      }).then((r) => r.json()),
    [branchId, employee.id, `Recurring Bug Test ${ts}`]
  );
  expect(created.id, "Task should be created").toBeTruthy();
  expect(created.isRecurringDefinition, "Task should be a recurring definition").toBe(true);

  // ── 3. Verify that the legacy assignment fields are null (pre-condition) ──
  //    If assignedEmployeeId were set, the client wouldn't exhibit the bug.
  expect(
    created.assignedEmployeeId,
    "assignedEmployeeId should be null when using assignments API — this is the bug pre-condition"
  ).toBeNull();

  // ── 4. Fetch /api/studio/scheduled-tasks (what the Ops Recurring tab uses) ─
  const scheduled = await page.evaluate(() =>
    fetch("/api/studio/scheduled-tasks").then((r) => r.json())
  );

  const ourTask = scheduled.find((t: { id: string }) => t.id === created.id);
  expect(ourTask, "Created recurring task should appear in /api/studio/scheduled-tasks").toBeTruthy();

  // ── 5. Assert that assignments are present ────────────────────────────────
  //    Without the fix, ourTask.assignments is undefined or empty because the
  //    endpoint never calls attachAssignmentsToTasks.  The client then treats
  //    the task as unassigned (visible to everyone).
  expect(
    ourTask.assignments,
    `GET /api/studio/scheduled-tasks must include an "assignments" array. ` +
      `Without it, isTaskMine() falls through to the "no assignee → visible to everyone" ` +
      `branch, making the recurring task appear for all users regardless of who it is ` +
      `assigned to. Fix: call attachAssignmentsToTasks() before responding.`
  ).toBeDefined();

  expect(
    (ourTask.assignments as { assignmentType: string; assignmentId: string }[]).length,
    "assignments array should be non-empty"
  ).toBeGreaterThan(0);

  const hasEmployeeAssignment = (
    ourTask.assignments as { assignmentType: string; assignmentId: string }[]
  ).some(
    (a) => a.assignmentType === "employee" && a.assignmentId === employee.id
  );

  expect(
    hasEmployeeAssignment,
    `The assignments array should contain an entry for employee ${employee.id} ` +
      `(${employee.nickname || employee.fullName}). ` +
      `The task was created with assignments:[{assignmentType:"employee",assignmentId:"${employee.id}"}] ` +
      `but the /api/studio/scheduled-tasks endpoint omits the assignments array entirely.`
  ).toBe(true);
});
