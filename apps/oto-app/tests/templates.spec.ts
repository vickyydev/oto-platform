// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";

test("created template appears in list after redirect", async ({ page }) => {
  await login(page);

  // Navigate to Templates page
  await page.goto("http://localhost:5000/templates");
  await expect(page.getByText("Template Library")).toBeVisible({ timeout: 10000 });

  // Click + New Template
  await page.getByRole("link", { name: "New Template" }).click();
  await expect(page.getByText("New Template")).toBeVisible({ timeout: 10000 });

  // Fill template name
  const tmplName = `Contract-${testId()}`;
  await page.locator("input[placeholder*='Standard Employment']").fill(tmplName);

  // Type in TipTap editor
  const editor = page.locator(".tiptap.ProseMirror");
  await editor.click();
  await page.keyboard.type("Test contract body.");

  // Submit
  await page.getByRole("button", { name: "Create Template" }).click();

  // Should redirect to /templates and show the new template
  await expect(page).toHaveURL(/\/templates$/, { timeout: 10000 });
  await expect(page.locator("table", { hasText: tmplName })).toBeVisible({ timeout: 10000 });
});
