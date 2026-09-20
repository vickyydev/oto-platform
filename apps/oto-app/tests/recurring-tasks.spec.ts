// seed: full
import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { login, users, createStaffWithLogin, loginAsStaff } from "./helpers";

function queryDB(sql: string): string {
  return execSync(
    `kubectl --context docker-desktop exec deploy/postgres -- psql -U oto -d oto_dev -tAc "${sql}"`,
    { encoding: "utf-8" },
  ).trim();
}

function runMidnightJob(): string {
  return execSync(
    `kubectl --context docker-desktop exec deploy/oto-app -- npx tsx -e "
      import { runMidnightTaskGeneration } from './server/scheduled-jobs';
      runMidnightTaskGeneration().then(() => process.exit(0));
    "`,
    { encoding: "utf-8", timeout: 30000 },
  ).trim();
}

const uid = () => Math.random().toString(36).slice(2, 8);

/** Get current day-of-month in the branch's timezone, matching the server's generation logic. */
function branchDayOfMonth(): number {
  const tz = queryDB("SELECT timezone FROM branches LIMIT 1");
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(new Date()),
    10,
  );
}

async function loginAdmin(page: Page) {
  await login(page);
  await page.goto("about:blank");
}

function getBranchId(): string {
  return queryDB("SELECT id FROM branches LIMIT 1");
}

test.describe("Recurring task bugs", () => {
  test("creating a monthly task generates an instance for today", async ({ page }) => {
    await loginAdmin(page);
    const title = `Monthly create ${uid()}`;
    const branchId = getBranchId();
    const dayOfMonth = branchDayOfMonth();

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

    const count = queryDB(
      `SELECT count(*) FROM tasks WHERE title = '${title}' AND is_recurring_definition = false`,
    );
    expect(Number(count)).toBe(1);
  });

  test("creating an assigned task generates an instance with the assignment", async ({ page }) => {
    await loginAdmin(page);
    const title = `Assigned create ${uid()}`;
    const branchId = getBranchId();
    const employeeId = queryDB("SELECT id FROM employees LIMIT 1");

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

    const defId = queryDB(
      `SELECT id FROM tasks WHERE title = '${title}' AND is_recurring_definition = true`,
    );
    const defAssignment = queryDB(
      `SELECT assignment_id FROM task_assignments WHERE task_id = '${defId}'`,
    );
    expect(defAssignment).toBe(employeeId);

    const instanceId = queryDB(
      `SELECT id FROM tasks WHERE title = '${title}' AND is_recurring_definition = false`,
    );
    expect(instanceId).toBeTruthy();
    const instanceAssignment = queryDB(
      `SELECT assignment_id FROM task_assignments WHERE task_id = '${instanceId}'`,
    );
    expect(instanceAssignment).toBe(employeeId);
  });

  test("midnight job generates instance for monthly task", async ({ page }) => {
    await loginAdmin(page);
    const title = `Monthly midnight ${uid()}`;
    const branchId = getBranchId();
    const dayOfMonth = branchDayOfMonth();

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

    queryDB(
      `DELETE FROM tasks WHERE title = '${title}' AND is_recurring_definition = false`,
    );

    runMidnightJob();

    const count = queryDB(
      `SELECT count(*) FROM tasks WHERE title = '${title}' AND is_recurring_definition = false`,
    );
    expect(Number(count)).toBe(1);
  });

  test("midnight job copies assignments to generated instance", async ({ page }) => {
    await loginAdmin(page);
    const title = `Assigned midnight ${uid()}`;
    const branchId = getBranchId();
    const employeeId = queryDB("SELECT id FROM employees LIMIT 1");

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

    const defId = queryDB(
      `SELECT id FROM tasks WHERE title = '${title}' AND is_recurring_definition = true`,
    );
    const defAssignment = queryDB(
      `SELECT assignment_id FROM task_assignments WHERE task_id = '${defId}'`,
    );
    expect(defAssignment).toBe(employeeId);

    queryDB(
      `DELETE FROM task_assignments WHERE task_id IN (SELECT id FROM tasks WHERE title = '${title}' AND is_recurring_definition = false)`,
    );
    queryDB(
      `DELETE FROM tasks WHERE title = '${title}' AND is_recurring_definition = false`,
    );

    runMidnightJob();

    const instanceId = queryDB(
      `SELECT id FROM tasks WHERE title = '${title}' AND is_recurring_definition = false`,
    );
    expect(instanceId).toBeTruthy();
    const instanceAssignment = queryDB(
      `SELECT assignment_id FROM task_assignments WHERE task_id = '${instanceId}'`,
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
      const staffAEmployeeId = queryDB(
        `SELECT id FROM employees WHERE email = '${staffA.email}'`,
      );

      // Create a daily task assigned to staff A
      const title = `Visibility ${uid()}`;
      const branchId = getBranchId();
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
      queryDB(
        `DELETE FROM task_assignments WHERE task_id IN (SELECT id FROM tasks WHERE title = '${title}' AND is_recurring_definition = false)`,
      );
      queryDB(
        `DELETE FROM tasks WHERE title = '${title}' AND is_recurring_definition = false`,
      );
      runMidnightJob();

      // Log in as staff B and check they can't see the task
      await loginAsStaff(staffPage, staffB.email, staffB.tempPassword, staffB.finalPassword);
      const todayRes = await staffPage.request.get("/api/tasks/today");
      expect(todayRes.ok()).toBeTruthy();
      const todayTasks = await todayRes.json();
      const titles = todayTasks.map((t: any) => t.title);
      expect(titles).not.toContain(title);
    } finally {
      await adminContext.close();
      await staffContext.close();
    }
  });

});
