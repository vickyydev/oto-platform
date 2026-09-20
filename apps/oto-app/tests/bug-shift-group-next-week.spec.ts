// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";

/** Regression test: Shift rows should be visible in all weeks regardless of whether a week plan exists. */

test.describe("Shift row visibility across weeks", () => {
  test("should show shift rows in future weeks without week plans", async ({ page }) => {
    await login(page);
    await page.evaluate(() => localStorage.setItem("theme", "light"));

    const shiftLabel = `Visibility Test Shift ${testId()}`;
    await page.evaluate(async (label) => {
      const branches = await fetch("/api/branches", { credentials: "include" }).then((r) => r.json());
      const branch = branches.find((b: { name: string }) => b.name === "Bangkok") ?? branches[0];
      const group = await fetch("/api/schedule/shift-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, name: `${label} Group` }),
      }).then((r) => r.json());
      await fetch("/api/schedule/shift-rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: branch.id, shiftGroupId: group.id, label, startTime: "09:00", endTime: "17:00", staffRequired: 1 }),
      });
    }, shiftLabel);

    await page.goto("/scheduling");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("button-view-shifts").click();

    await expect(page.getByTestId(/^button-edit-shift-row-/).filter({ hasText: shiftLabel })).toBeVisible({ timeout: 10000 });

    await page.getByTestId("button-nav-next").click();
    await expect(page.getByTestId(/^button-edit-shift-row-/).filter({ hasText: shiftLabel })).toBeVisible({ timeout: 10000 });

    await expect(page.locator('button[data-testid^="button-add-assignment-"]').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=No shift groups yet")).not.toBeVisible();
  });
});
