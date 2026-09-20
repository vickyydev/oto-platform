// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Regression test: When a task is created using the legacy single-field
 * assignment paths (assignedRoleId, assignedDepartmentId, assignedEmployeeId),
 * a matching row must also be inserted into the task_assignments table.
 *
 * Bug: POST /api/core/tasks inserts into task_assignments only when
 * body.assignments[] is explicitly provided. If a task is created with just
 * assignedRoleId set (and no assignments array), task_assignments remains empty.
 * Because isTaskVisibleToEmployee() short-circuits on task_assignments once any
 * rows exist there, this creates inconsistency. Worse: tasks with a populated
 * assignedRoleId but empty task_assignments are invisible to staff who have that
 * role, because the function returns false when task_assignments is empty and no
 * other visibility criteria match.
 *
 * Demonstration:
 *   - Create a task with assignedRoleId set but NO assignments[] body field
 *   - Fetch the task via the API
 *   - Assert: task.assignments contains an entry of type "role"
 *   → With the bug the assertion FAILS (assignments is empty)
 *   → After the fix the assertion PASSES (legacy field was mirrored)
 */

test("creating a task with assignedRoleId mirrors it into task_assignments", async ({
  page,
}) => {
  await login(page);

  // ── 1. Get a role to assign ───────────────────────────────────────────────
  const roles = await page.evaluate(() =>
    fetch("/api/roles").then((r) => r.json())
  );
  expect(roles.length, "Need at least one role").toBeGreaterThan(0);
  const role = roles[0];

  const branches = await page.evaluate(() =>
    fetch("/api/branches").then((r) => r.json())
  );
  const branchId: string = branches[0].id;

  // ── 2. Create task using the legacy assignedRoleId field ──────────────────
  //    Deliberately do NOT include an "assignments" array — this is the path
  //    that currently fails to populate task_assignments.
  const marker = `ROLE_MIRROR_TASK_${Date.now()}`;
  const dueAt = new Date(Date.now() + 2 * 86_400_000).toISOString().split("T")[0];

  const task = await page.evaluate(
    ([bid, title, due, rid]: string[]) =>
      fetch("/api/core/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          branchIds: [bid],
          recurrence: "once",
          dueAt: due,
          assignedRoleId: rid,
          // NOTE: no "assignments" field — tests the legacy path
        }),
      }).then((r) => r.json()),
    [branchId, marker, dueAt, role.id]
  );
  expect(task.id, "Task should be created").toBeTruthy();
  expect(task.assignedRoleId, "assignedRoleId should be set on task").toBe(role.id);

  // ── 3. Fetch the task back and check its task_assignments entries ──────────
  const fetched = await page.evaluate(
    ([tid, branchId_]: string[]) =>
      fetch(`/api/core/tasks?branchId=${branchId_}`)
        .then((r) => r.json())
        .then((tasks: { id: string; assignments: { assignmentType: string; assignmentId: string }[] }[]) =>
          tasks.find((t) => t.id === tid)
        ),
    [task.id, branchId]
  );
  expect(fetched, "Task should be fetchable").toBeTruthy();

  // ── 4. task.assignments must include a "role" entry for the assignedRoleId ─
  const roleEntry = fetched!.assignments.find(
    (a) => a.assignmentType === "role" && a.assignmentId === role.id
  );

  expect(
    roleEntry,
    `task.assignments should include { assignmentType: "role", assignmentId: "${role.id}" } ` +
      `because the task was created with assignedRoleId set. ` +
      `Without the fix, legacy single-field assignments are not mirrored to task_assignments, ` +
      `making tasks invisible to staff who hold that role. ` +
      `Actual assignments: ${JSON.stringify(fetched!.assignments)}`
  ).toBeDefined();
});
