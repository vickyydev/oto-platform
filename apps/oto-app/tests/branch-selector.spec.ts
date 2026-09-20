// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";

test("can switch to All Branches after creating a branch", async ({ page }) => {
  await login(page);

  // Navigate to HR
  await page.getByRole("button", { name: "HR" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });

  // Switch to All Branches if branch auto-selected
  const branchSel = page.getByTestId("branch-selector-trigger");
  if (await branchSel.isVisible({ timeout: 2000 }).catch(() => false)) {
    await branchSel.click();
    const allBtn = page.getByTestId("branch-option-all-all");
    if (await allBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await allBtn.click();
      await page.waitForTimeout(500);
    }
  }

  // Expand Platform Admin and go to Operators
  await page.getByText("Platform Admin").click();
  await page.getByRole("link", { name: "Operators" }).click();
  await expect(page.getByText("Manage operators")).toBeVisible({ timeout: 10000 });

  // Create an operator
  const opName = `TestOp-${testId()}`;
  await page.getByRole("button", { name: "Add Operator" }).click();
  await page.getByLabel("Operator Name").fill(opName);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(opName)).toBeVisible({ timeout: 10000 });

  // Navigate to Setup → Branches
  await page.getByRole("button", { name: "Setup" }).click();
  await page.getByRole("link", { name: "Branches" }).click();
  await expect(page.getByRole("heading", { name: "Branches", exact: true })).toBeVisible({ timeout: 10000 });

  // Create a branch
  const branchName = `TestBranch-${testId()}`;
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Branch Name").fill(branchName);
  await page.getByLabel("Address").fill("1 Test Street");
  await page.getByRole("button", { name: "Create Branch" }).click();

  // Branch selector should be visible (showing some branch)
  const selector = page.getByTestId("branch-selector-trigger");
  await expect(selector).toBeVisible({ timeout: 5000 });

  // Open the branch selector and click "All Branches"
  await selector.click();
  await page.getByTestId("branch-option-all-all").click();
  await page.waitForTimeout(500);

  // The selector should show "All Branches"
  await expect(selector).toContainText("All Branches", { timeout: 5000 });
});
