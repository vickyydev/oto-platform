// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "setup");

test("can create a department and assign it to a branch", async ({ page }) => {
  await login(page);

  // Navigate to Setup → Departments
  await page.getByRole("button", { name: "Setup" }).click();
  await page.getByRole("link", { name: "Departments" }).click();
  await expect(page.getByRole("heading", { name: "Departments", exact: true })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "departments-empty.png") });

  // Open create dialog
  const deptName = `Dept-${testId()}`;
  await page.getByRole("button", { name: "Add Department" }).click();
  await page.getByLabel("Department Name").fill(deptName);
  // Assign to Bangkok branch
  await page.getByRole("checkbox", { name: "Bangkok" }).check();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(imgDir, "create-department.png") });

  // Create
  await page.getByRole("button", { name: "Create" }).click();
  await page.locator("[role='dialog']").waitFor({ state: "hidden", timeout: 5000 });

  // Verify department card appears
  const card = page.locator("[data-testid^='department-card-']", { hasText: deptName });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card.getByText("0 employees")).toBeVisible();
  await page.screenshot({ path: path.join(imgDir, "department-created.png") });
});
