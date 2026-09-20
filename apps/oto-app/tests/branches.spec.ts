// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "setup");

test("can create a branch from Branches page", async ({ page }) => {
  await login(page);

  // Navigate to Setup → Branches
  await page.getByRole("button", { name: "Setup" }).click();
  await page.getByText("Branches").click();
  await expect(page.getByText("Manage company branches")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "branches-empty.png") });

  // Open create dialog
  const branchName = `Branch-${testId()}`;
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Branch Name").fill(branchName);
  const address = `${branchName} Street`;
  await page.getByLabel("Address").fill(address);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(imgDir, "create-branch.png") });

  // Create
  await page.getByRole("button", { name: "Create Branch" }).click();
  await page.locator("[role='dialog']").waitFor({ state: "hidden", timeout: 5000 });

  // Verify branch appears in table
  await expect(page.getByRole("cell", { name: branchName, exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("cell", { name: address })).toBeVisible();
  await page.screenshot({ path: path.join(imgDir, "branch-created.png") });

  // Assign branch to operator via Edit Operator dialog
  // Switch to All Branches first (branch auto-selected after creation)
  const branchSelector = page.getByTestId("branch-selector-trigger");
  await branchSelector.click();
  await page.getByTestId("branch-option-all-all").click();
  await page.waitForTimeout(500);

  // Navigate to HR → Platform Admin → Operators
  await page.getByRole("button", { name: "HR" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });
  await page.getByText("Platform Admin").click();
  await page.getByRole("link", { name: "Operators" }).click();
  await expect(page.getByText("Manage operators")).toBeVisible({ timeout: 10000 });

  // Edit the first operator card (minimal seed calls it "Default"; full seed calls it "Oto")
  const card = page.locator("[data-testid^='card-operator-']").first();
  await card.getByRole("button", { name: "Edit" }).click();
  await page.locator("[role='dialog']").waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(500);

  // Check the new branch in Assign Branches
  await page.getByLabel(branchName).check();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(imgDir, "assign-branch.png") });

  // Save
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.locator("[role='dialog']").waitFor({ state: "hidden", timeout: 5000 });

  // Verify operator card now shows the branch
  await expect(card.getByText(branchName)).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "branch-assigned.png") });
});
