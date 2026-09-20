// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "setup");

test("can create a contract template and assign it to a branch", async ({ page }) => {
  await login(page);

  // Navigate to Templates (via All Branches context)
  await page.getByTestId("branch-selector-trigger").click();
  await page.getByTestId("branch-option-all-all").click();
  await page.waitForTimeout(500);

  await page.goto("http://localhost:5000/templates");
  await expect(page.getByText("Template Library")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "templates-empty.png") });

  // Click + New Template
  await page.getByRole("link", { name: "New Template" }).click();
  await expect(page.getByText("Create a new contract template")).toBeVisible({ timeout: 10000 });

  // Fill template name
  const tmplName = `Employment Contract ${testId()}`;
  await page.locator("input[placeholder*='Standard Employment']").fill(tmplName);

  // Type in TipTap editor
  const editor = page.locator(".tiptap.ProseMirror");
  await editor.click();
  await page.keyboard.type("This is an employment contract between the Company and the Employee.");

  await page.screenshot({ path: path.join(imgDir, "create-template.png") });

  // Scroll down and submit
  await page.getByRole("button", { name: "Create Template" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Create Template" }).click();

  // Should redirect to /templates and show the new template
  await expect(page).toHaveURL(/\/templates$/, { timeout: 10000 });
  await expect(page.locator("table", { hasText: tmplName })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "template-created.png") });

  // Assign template to Bangkok via ... menu
  const row = page.locator("tr", { hasText: tmplName });
  await row.locator("button:has(svg.lucide-ellipsis)").click();
  await page.getByRole("menuitem", { name: "Manage Branch Assignments" }).click();

  // Dialog opens — check the Bangkok checkbox
  await expect(page.getByRole("heading", { name: "Manage Branch Assignments" })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(500);
  await page.getByLabel("Bangkok").check();
  await page.screenshot({ path: path.join(imgDir, "assign-template.png") });

  // Save assignments
  await page.getByTestId("button-save-assignments").click();
  await page.locator("[role='dialog']").waitFor({ state: "hidden" });

  // Verify branch assignment shows in the table
  await expect(row.getByText("Bangkok")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "template-assigned.png") });
});
