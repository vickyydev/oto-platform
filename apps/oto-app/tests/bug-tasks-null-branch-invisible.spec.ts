// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Creating a task from the Ops page requires a concrete branch selection.
 *
 * Regression: when the global branch selector was set to All Branches and the
 * task dialog had no explicit branch assignment, the create flow silently fell
 * back to branches[0]. That could create a todo in Bangkok even though the
 * user had not selected a branch.
 */

test("creating a todo from All Branches requires selecting a branch", async ({
  page,
}) => {
  await login(page);

  // Ensure the page context is All Branches / no concrete branch selected.
  await page.getByTestId("branch-selector-trigger").click();
  await page.getByTestId("branch-option-all-all").click();

  await page.goto("/ops");
  await page.waitForLoadState("networkidle");

  await page.getByTestId("button-ops-new").click();

  await expect(
    page.getByText("A branch must be selected to create a todo", { exact: true })
  ).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("dialog-create-task")).not.toBeVisible();
});
