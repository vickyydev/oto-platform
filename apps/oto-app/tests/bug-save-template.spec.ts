// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";

function nextMonday(offsetWeeks = 0) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysToMonday = (8 - today.getDay()) % 7 || 7;
  today.setDate(today.getDate() + daysToMonday + offsetWeeks * 7);
  return today.toISOString().slice(0, 10);
}

test.describe("Save template bugs", () => {
  test("saving a shift-group template on a week with no DB week plan succeeds", async ({ page }) => {
    await login(page);
    const result = await page.evaluate(async ({ suffix, weekStartDate }) => {
      const branches = await fetch("/api/branches", { credentials: "include" }).then((r) => r.json());
      const branch = branches.find((b: { name: string }) => b.name === "Bangkok") ?? branches[0];
      const group = await fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, name: `NoPlanGroup-${suffix}` }),
      }).then((r) => r.json());
      await fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, shiftGroupId: group.id, label: `NoPlanShift-${suffix}`, startTime: "09:00", endTime: "17:00", staffRequired: 1 }),
      });
      const res = await fetch("/api/schedule/templates/save-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, weekStartDate, shiftGroupId: group.id, name: `ShiftGroupTmpl-${suffix}` }),
      });
      return { status: res.status, body: await res.json() };
    }, { suffix: testId(), weekStartDate: nextMonday(20) });

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.id).toBeTruthy();
  });

  test("saving a dept template for a department with assignments succeeds", async ({ page }) => {
    await login(page);
    const result = await page.evaluate(async ({ suffix, weekStartDate }) => {
      const branches = await fetch("/api/branches", { credentials: "include" }).then((r) => r.json());
      const departments = await fetch("/api/departments", { credentials: "include" }).then((r) => r.json());
      const branch = branches.find((b: { name: string }) => b.name === "Bangkok") ?? branches[0];
      const department = departments.find((d: { name: string }) => d.name === "Front Desk") ?? departments[0];
      const group = await fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, name: `DeptGroup-${suffix}` }),
      }).then((r) => r.json());
      const row = await fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, shiftGroupId: group.id, departmentId: department.id, label: `DeptShift-${suffix}`, startTime: "09:00", endTime: "17:00", staffRequired: 1 }),
      }).then((r) => r.json());
      const employee = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ fullName: `Dept Employee ${suffix}`, nickname: `DE${suffix}`, email: `dept-${suffix}@example.com`, branchId: branch.id, primaryDepartmentId: department.id, status: "active", employmentState: "ACTIVE" }),
      }).then((r) => r.json());
      await fetch("/api/schedule/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, weekStartDate, shiftRowId: row.id, shiftDate: weekStartDate, employeeId: employee.id, assigneeType: "employee" }),
      });
      const res = await fetch("/api/schedule/templates/save-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, weekStartDate, departmentId: department.id, name: `DeptTmpl-${suffix}` }),
      });
      return { status: res.status, body: await res.json() };
    }, { suffix: testId(), weekStartDate: nextMonday(21) });

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.id).toBeTruthy();
  });
});
