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

test.describe("Schedule template application", () => {
  test("should apply templates with employee assignments to future weeks", async ({ page }) => {
    await login(page);
    const result = await page.evaluate(async ({ suffix, sourceWeek, targetWeek }) => {
      const branches = await fetch("/api/branches", { credentials: "include" }).then((r) => r.json());
      const branch = branches.find((b: { name: string }) => b.name === "Bangkok") ?? branches[0];
      const group = await fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, name: `ApplyGroup-${suffix}` }),
      }).then((r) => r.json());
      const row = await fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, shiftGroupId: group.id, label: `ApplyShift-${suffix}`, startTime: "09:00", endTime: "17:00", staffRequired: 1 }),
      }).then((r) => r.json());
      const employee = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ fullName: `Apply Employee ${suffix}`, nickname: `AE${suffix}`, email: `apply-${suffix}@example.com`, branchId: branch.id, status: "active", employmentState: "ACTIVE" }),
      }).then((r) => r.json());
      await fetch("/api/schedule/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, weekStartDate: sourceWeek, shiftRowId: row.id, shiftDate: sourceWeek, employeeId: employee.id, assigneeType: "employee" }),
      });
      const template = await fetch("/api/schedule/templates/save-week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, weekStartDate: sourceWeek, shiftGroupId: group.id, name: `Assignment Test Template ${suffix}` }),
      }).then((r) => r.json());
      const apply = await fetch(`/api/schedule/templates/${template.id}/apply-safe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, weekStartDate: targetWeek }),
      });
      return { status: apply.status, body: await apply.json() };
    }, { suffix: testId(), sourceWeek: nextMonday(22), targetWeek: nextMonday(23) });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.success).toBe(true);
  });
});
