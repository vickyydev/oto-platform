// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";

/**
 * Tests for scheduling features:
 * - Batch assignment endpoint
 * - Half-day leave conflict detection
 * - Shift template apply updates existing rows
 */

test.describe("Scheduling features", () => {
  test("batch assignment assigns multiple employees to a shift", async ({ page }) => {
    await login(page);
    
    // Get the Bangkok branch (ordered by createdAt DESC, so newly created branches
    // come first — find the seeded one by name to avoid picking a test-created branch)
    const branches = await page.evaluate(() => fetch("/api/branches").then(r => r.json()));
    const branchId = (branches.find((b: any) => b.name === "Bangkok") ?? branches[branches.length - 1]).id;
    
    const suffix = testId();
    const emp1 = await page.evaluate(([bid, sfx]: string[]) => fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: `Alice Batch ${sfx}`, nickname: "Alice", email: `alice-${sfx}@example.com`, branchId: bid, status: "active", employmentState: "ACTIVE" }),
    }).then(r => r.json()), [branchId, suffix]);

    const emp2 = await page.evaluate(([bid, sfx]: string[]) => fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: `Bob Batch ${sfx}`, nickname: "Bob", email: `bob-${sfx}@example.com`, branchId: bid, status: "active", employmentState: "ACTIVE" }),
    }).then(r => r.json()), [branchId, suffix]);

    // Create week plan and shift row
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(monday.getDate() - monday.getDay() + 1);
    const mondayStr = monday.toISOString().split("T")[0];
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    const weekPlan = await page.evaluate(([bid, mStr]: string[]) => 
      fetch(`/api/schedule/week?branchId=${bid}&weekStartDate=${mStr}`)
        .then(r => r.json())
        .then(plan => {
          if (plan?.id) return plan;
          return fetch("/api/schedule/week", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ branchId: bid, weekStartDate: mStr, status: "draft" }),
          }).then(r => r.json());
        }),
      [branchId, mondayStr]
    );

    // Fetch an existing shift group (shift_group_id is NOT NULL in the DB)
    const shiftGroups = await page.evaluate((bid: string) =>
      fetch(`/api/schedule/shift-groups?branchId=${bid}`).then(r => r.json()),
      branchId
    );
    const shiftGroupId = shiftGroups[0].id;

    const shiftRow = await page.evaluate(([wpId, bid, sgId]: string[]) =>
      fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekPlanId: wpId, branchId: bid, shiftGroupId: sgId, startTime: "09:00", endTime: "17:00", label: "Batch Test Shift" }),
      }).then(r => r.json()),
      [weekPlan.id, branchId, shiftGroupId]
    );

    // Batch assign both employees
    const batchResult = await page.evaluate(([wpId, srId, dateStr, e1, e2]: string[]) =>
      fetch("/api/schedule/assignments/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekPlanId: wpId, shiftRowId: srId, shiftDate: dateStr, employeeIds: [e1, e2] }),
      }).then(r => r.json()),
      [weekPlan.id, shiftRow.id, tomorrowStr, emp1.id, emp2.id]
    );

    expect(batchResult.assigned).toBe(2);
    expect(batchResult.failed).toBe(0);
  });

  test("half-day AM leave blocks morning shift but not afternoon shift", async ({ page }) => {
    await login(page);

    const branches = await page.evaluate(() => fetch("/api/branches").then(r => r.json()));
    const branchId = (branches.find((b: any) => b.name === "Bangkok") ?? branches[branches.length - 1]).id;

    const hdSuffix = testId();
    const emp = await page.evaluate(([bid, sfx]: string[]) => fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: `HalfDay Test ${sfx}`, nickname: "HD", email: `halfday-${sfx}@example.com`, branchId: bid, status: "active", employmentState: "ACTIVE" }),
    }).then(r => r.json()), [branchId, hdSuffix]);

    // Create half-day AM leave for tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    const leaveResult = await page.evaluate(([empId, bid, dateStr]: string[]) =>
      fetch("/api/time-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: empId,
          branchId: bid,
          timeOffType: "ANNUAL",
          startDate: dateStr,
          endDate: dateStr,
          isHalfDay: true,
          halfDayPeriod: "AM",
          notes: "Half day AM",
        }),
      }).then(async r => ({ status: r.status, body: await r.json() })),
      [emp.id, branchId, tomorrowStr]
    );
    expect(leaveResult.status).toBe(201);

    // Create week plan and two shift rows: morning (08:00-12:00) and afternoon (14:00-18:00)
    const monday = new Date(tomorrow);
    monday.setDate(monday.getDate() - monday.getDay() + 1);
    const mondayStr = monday.toISOString().split("T")[0];

    const weekPlan = await page.evaluate(([bid, mStr]: string[]) =>
      fetch(`/api/schedule/week?branchId=${bid}&weekStartDate=${mStr}`)
        .then(r => r.json())
        .then(plan => {
          if (plan?.id) return plan;
          return fetch("/api/schedule/week", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ branchId: bid, weekStartDate: mStr, status: "draft" }),
          }).then(r => r.json());
        }),
      [branchId, mondayStr]
    );

    const shiftGroupsHD = await page.evaluate((bid: string) =>
      fetch(`/api/schedule/shift-groups?branchId=${bid}`).then(r => r.json()),
      branchId
    );
    const sgId = shiftGroupsHD[0].id;

    const morningShift = await page.evaluate(([wpId, bid, sgId]: string[]) =>
      fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekPlanId: wpId, branchId: bid, shiftGroupId: sgId, startTime: "08:00", endTime: "12:00", label: "Morning" }),
      }).then(r => r.json()),
      [weekPlan.id, branchId, sgId]
    );

    const afternoonShift = await page.evaluate(([wpId, bid, sgId]: string[]) =>
      fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekPlanId: wpId, branchId: bid, shiftGroupId: sgId, startTime: "14:00", endTime: "18:00", label: "Afternoon" }),
      }).then(r => r.json()),
      [weekPlan.id, branchId, sgId]
    );

    // Try to assign morning shift — should be blocked by AM leave
    const morningResult = await page.evaluate(([wpId, srId, dateStr, empId]: string[]) =>
      fetch("/api/schedule/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekPlanId: wpId, shiftRowId: srId, shiftDate: dateStr, employeeId: empId, assigneeType: "employee" }),
      }).then(async r => ({ status: r.status, body: await r.json() })),
      [weekPlan.id, morningShift.id, tomorrowStr, emp.id]
    );

    expect(morningResult.status).toBe(400);
    expect(morningResult.body.reasonCode).toBe("ON_LEAVE");

    // Try to assign afternoon shift — should succeed (AM leave doesn't block PM)
    const afternoonResult = await page.evaluate(([wpId, srId, dateStr, empId]: string[]) =>
      fetch("/api/schedule/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekPlanId: wpId, shiftRowId: srId, shiftDate: dateStr, employeeId: empId, assigneeType: "employee" }),
      }).then(async r => ({ status: r.status, body: await r.json() })),
      [weekPlan.id, afternoonShift.id, tomorrowStr, emp.id]
    );

    expect(afternoonResult.status).toBe(201);
  });
});
