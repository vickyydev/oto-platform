// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "setup");

test("can create an operator from Platform Admin", async ({ page }) => {
  await login(page);

  // Navigate to HR
  await page.getByRole("button", { name: "HR" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });

  // Switch to All Branches (Operators requires it)
  const branchSelector = page.getByTestId("branch-selector-trigger");
  if (await branchSelector.isVisible({ timeout: 2000 }).catch(() => false)) {
    await branchSelector.click();
    const allBranches = page.getByTestId("branch-option-all-all");
    await allBranches.waitFor({ state: "visible", timeout: 3000 });
    await allBranches.click();
    await page.waitForTimeout(500);
  }

  // Expand Platform Admin and go to Operators
  await page.getByText("Platform Admin").click();
  await page.getByRole("link", { name: "Operators" }).click();
  await expect(page.getByText("Manage operators")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "operators-empty.png") });

  // Create an operator
  const opName = `TestOp-${testId()}`;
  await page.getByRole("button", { name: "Add Operator" }).click();
  await page.getByLabel("Operator Name").fill(opName);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(imgDir, "create-operator.png") });
  await page.getByRole("button", { name: "Create" }).click();

  // Verify operator card appears with correct details
  const card = page.locator("[data-testid^='card-operator-']", { hasText: opName });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card.getByText("active")).toBeVisible();
  await expect(card.getByText("0 branches")).toBeVisible();
  await expect(card.getByText("0 users")).toBeVisible();
  await page.locator("[role='dialog']").waitFor({ state: "hidden", timeout: 5000 });
  await page.screenshot({ path: path.join(imgDir, "operator-created.png") });
});
