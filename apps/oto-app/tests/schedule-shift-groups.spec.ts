// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";

test("retiring a shift row removes it from future weeks", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("theme", "light"));
  const shiftLabel = `Retire Test ${testId()}`;
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

  // Switch to Shifts view
  await page.getByRole("button", { name: "Shifts" }).click();

  const shiftEditButton = page.getByTestId(/^button-edit-shift-row-/).filter({ hasText: shiftLabel }).first();
  await expect(shiftEditButton).toBeVisible({ timeout: 10000 });

  // Click the edit button for the shift row to open the edit dialog
  await shiftEditButton.click();
  await expect(page.getByTestId("button-delete-shift-row")).toBeVisible({ timeout: 5000 });

  // Delete (retire) the shift row
  await page.getByTestId("button-delete-shift-row").click();

  // A "Shift retired" toast should appear
  await expect(page.locator("li[role='status']").filter({ hasText: /shift retired/i })).toBeVisible({ timeout: 10000 });

  // Navigate to next week — the retired row must not appear there
  await page.getByTestId("button-nav-next").click();
  await page.waitForTimeout(1000);
  await expect(page.getByTestId(/^button-edit-shift-row-/).filter({ hasText: shiftLabel })).not.toBeVisible({ timeout: 10000 });
});

test("created shift group appears on scheduling page", async ({ page }) => {
  await login(page);

  // Navigate to scheduling page
  await page.goto("/scheduling");

  // Switch to Shifts tab
  await page.getByRole("button", { name: "Shifts" }).click();

  // Click "Add Shift Group" button (bottom of the groups list)
  await page.getByTestId("button-add-shift-group").click();

  // Fill in the group name
  const groupName = `TestGroup-${testId()}`;
  await page.locator("#shift-group-name").fill(groupName);

  // Submit
  await page.getByTestId("button-create-shift-group").click();

  // The shift group should be visible on the page
  await expect(page.getByText(groupName)).toBeVisible({ timeout: 10000 });
});
