// seed: full
import { test, expect, type Page } from "@playwright/test";
import { pool } from "../server/db";
import { runMidnightTaskGeneration } from "../server/scheduled-jobs";
import { login, createStaffWithLogin, loginAsStaff } from "./helpers";

async function queryDB(query: string, values: unknown[] = []): Promise<string> {
  const result = await pool.query(query, values);
  const first = Object.values(result.rows[0] ?? {})[0];
  return first == null ? "" : String(first);
}

const uid = () => Math.random().toString(36).slice(2, 8);

/** Get current day-of-month in the branch's timezone, matching the server's generation logic. */
async function branchDayOfMonth(): Promise<number> {
  const tz = await queryDB("SELECT timezone FROM branches LIMIT 1");
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(new Date()),
    10,
  );
}

async function loginAdmin(page: Page) {
  await login(page);
  await page.goto("about:blank");
}

async function getBranchId(): Promise<string> {
  return queryDB("SELECT id FROM branches LIMIT 1");
}

test.describe("Recurring task bugs", () => {
  test("creating a monthly task generates an instance for today", async ({ page }) => {
    await loginAdmin(page);
    const title = `Monthly create ${uid()}`;
    const branchId = await getBranchId();
    const dayOfMonth = await branchDayOfMonth();

    const res = await page.request.post("/api/core/tasks", {
      data: {
        branchIds: [branchId],
        title,
        recurrence: "monthly",
        monthlyDay: dayOfMonth,
        preferredDueTime: "18:00",
      },
    });
    expect(res.ok()).toBeTruthy();

    const count = await queryDB(
      "SELECT count(*) FROM tasks WHERE title = $1 AND is_recurring_definition = false", [title],
    );
    expect(Number(count)).toBe(1);
  });

  test("creating an assigned task generates an instance with the assignment", async ({ page }) => {
    await loginAdmin(page);
    const title = `Assigned create ${uid()}`;
    const branchId = await getBranchId();
    const employeeId = await queryDB("SELECT id FROM employees LIMIT 1");

    const res = await page.request.post("/api/core/tasks", {
      data: {
        branchIds: [branchId],
        title,
        recurrence: "daily",
        preferredDueTime: "18:00",
        assignments: [{ assignmentType: "employee", assignmentId: employeeId }],
      },
    });
    expect(res.ok()).toBeTruthy();

    const defId = await queryDB(
      "SELECT id FROM tasks WHERE title = $1 AND is_recurring_definition = true", [title],
    );
    const defAssignment = await queryDB(
      "SELECT assignment_id FROM task_assignments WHERE task_id = $1", [defId],
    );
    expect(defAssignment).toBe(employeeId);

    const instanceId = await queryDB(
      "SELECT id FROM tasks WHERE title = $1 AND is_recurring_definition = false", [title],
    );
    expect(instanceId).toBeTruthy();
    const instanceAssignment = await queryDB(
      "SELECT assignment_id FROM task_assignments WHERE task_id = $1", [instanceId],
    );
    expect(instanceAssignment).toBe(employeeId);
  });

  test("midnight job generates instance for monthly task", async ({ page }) => {
    await loginAdmin(page);
    const title = `Monthly midnight ${uid()}`;
    const branchId = await getBranchId();
    const dayOfMonth = await branchDayOfMonth();

    const res = await page.request.post("/api/core/tasks", {
      data: {
        branchIds: [branchId],
        title,
        recurrence: "monthly",
        monthlyDay: dayOfMonth,
        preferredDueTime: "18:00",
      },
    });
    expect(res.ok()).toBeTruthy();

    await queryDB(
      "DELETE FROM tasks WHERE title = $1 AND is_recurring_definition = false", [title],
    );

    await runMidnightTaskGeneration();

    const count = await queryDB(
      "SELECT count(*) FROM tasks WHERE title = $1 AND is_recurring_definition = false", [title],
    );
    expect(Number(count)).toBe(1);
  });

  test("midnight job copies assignments to generated instance", async ({ page }) => {
    await loginAdmin(page);
    const title = `Assigned midnight ${uid()}`;
    const branchId = await getBranchId();
    const employeeId = await queryDB("SELECT id FROM employees LIMIT 1");

    const res = await page.request.post("/api/core/tasks", {
      data: {
        branchIds: [branchId],
        title,
        recurrence: "daily",
        preferredDueTime: "18:00",
        assignments: [{ assignmentType: "employee", assignmentId: employeeId }],
      },
    });
    expect(res.ok()).toBeTruthy();

    const defId = await queryDB(
      "SELECT id FROM tasks WHERE title = $1 AND is_recurring_definition = true", [title],
    );
    const defAssignment = await queryDB(
      "SELECT assignment_id FROM task_assignments WHERE task_id = $1", [defId],
    );
    expect(defAssignment).toBe(employeeId);

    await queryDB(
      "DELETE FROM task_assignments WHERE task_id IN (SELECT id FROM tasks WHERE title = $1 AND is_recurring_definition = false)", [title],
    );
    await queryDB(
      "DELETE FROM tasks WHERE title = $1 AND is_recurring_definition = false", [title],
    );

    await runMidnightTaskGeneration();

    const instanceId = await queryDB(
      "SELECT id FROM tasks WHERE title = $1 AND is_recurring_definition = false", [title],
    );
    expect(instanceId).toBeTruthy();
    const instanceAssignment = await queryDB(
      "SELECT assignment_id FROM task_assignments WHERE task_id = $1", [instanceId],
    );
    expect(instanceAssignment).toBe(employeeId);
  });

  test("task assigned to one employee is not visible to another", async ({ browser }) => {
    test.setTimeout(90000);
    const adminContext = await browser.newContext();
    const staffContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const staffPage = await staffContext.newPage();

    try {
      await login(adminPage);

      // Create two staff users
      const staffA = await createStaffWithLogin(adminPage);
      const staffB = await createStaffWithLogin(adminPage);

      // Get employee ID for staff A
      const staffAEmployeeId = await queryDB(
        "SELECT id FROM employees WHERE email = $1", [staffA.email],
      );

      // Create a daily task assigned to staff A
      const title = `Visibility ${uid()}`;
      const branchId = await getBranchId();
      const res = await adminPage.request.post("/api/core/tasks", {
        data: {
          branchIds: [branchId],
          title,
          recurrence: "daily",
          preferredDueTime: "18:00",
          assignments: [{ assignmentType: "employee", assignmentId: staffAEmployeeId }],
        },
      });
      expect(res.ok()).toBeTruthy();

      // Delete creation-generated instance, run midnight job
      await queryDB(
        "DELETE FROM task_assignments WHERE task_id IN (SELECT id FROM tasks WHERE title = $1 AND is_recurring_definition = false)", [title],
      );
      await queryDB(
        "DELETE FROM tasks WHERE title = $1 AND is_recurring_definition = false", [title],
      );
      await runMidnightTaskGeneration();

      // Log in as staff B and check they can't see the task
      await loginAsStaff(staffPage, staffB.email, staffB.tempPassword, staffB.finalPassword);
      const todayRes = await staffPage.request.get("/api/tasks/today");
      expect(todayRes.ok()).toBeTruthy();
      const todayTasks = await todayRes.json();
      const titles = (todayTasks as Array<{ title: string }>).map((task) => task.title);
      expect(titles).not.toContain(title);
    } finally {
      await adminContext.close();
      await staffContext.close();
    }
  });

});
