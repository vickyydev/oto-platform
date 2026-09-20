// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "hr");

test("finalize + signing link does not fire twice causing version conflict", async ({ page }) => {
  test.setTimeout(60000);
  await login(page);

  // Navigate to HR → Bangkok → Employees
  await page.getByRole("button", { name: "HR" }).click();
  await expect(page.getByTestId("text-dashboard-title")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("section-toggle-hr-operations").click();
  await page.getByTestId("nav-employees").click();
  await expect(page.getByTestId("text-employees-title")).toBeVisible({ timeout: 10000 });

  // Create a new employee via UI
  await page.getByRole("link", { name: "Add" }).first().click();
  await expect(page.getByRole("heading", { name: "Add Employee" })).toBeVisible({ timeout: 10000 });

  await page.locator("input[name='fullName']").fill("Version Test Employee");
  await page.locator("input[name='nickname']").fill("VTE");
  await page.locator("input[name='email']").fill("vte@example.com");
  await page.locator("input[name='phone']").fill("+66812345678");
  await page.locator("input[name='defaultMergeData.positionTitle']").fill("Tester");
  await page.locator("input[placeholder*='50,000']").fill("30000");

  await page.getByTestId("select-employee-branch").click();
  await page.getByRole("option", { name: "Bangkok" }).click();

  await page.getByTestId("input-start-date").click();
  await page.locator("table button").filter({ hasText: "1" }).first().click();

  await page.getByTestId("button-section-save").first().click();
  await expect(page).toHaveURL(/\/employees$/, { timeout: 10000 });

  // Open the new employee's page
  await page.getByRole("link", { name: "Version Test Employee" }).click();
  await expect(page.getByText("Onboarding Progress")).toBeVisible({ timeout: 10000 });

  // Track all calls to /api/contracts/generate
  const generateCalls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/contracts/generate") && req.method() === "POST") {
      generateCalls.push(req.postData() || "");
    }
  });

  // Go to contract wizard via onboarding stepper
  await page.getByTestId("button-generate-contract").click();
  await expect(page.getByTestId("text-wizard-title")).toBeVisible({ timeout: 10000 });

  // Step 1: select template
  await page.getByTestId("select-template").click();
  await page.getByRole("option").first().click();
  await page.getByTestId("button-next-step1").click();

  // Step 2: no edits, proceed
  await expect(page.getByText("Step 2: Review Employee Details")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("button-next-step2").click();

  // Step 3: preview
  await expect(page.getByText("Step 3: Contract Details")).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: /Preview/i }).click();

  // Step 4: finalize + signing link
  await expect(page.getByText("Step 4: Preview & Finalize")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("button-finalize-signing").scrollIntoViewIfNeeded();
  await page.getByTestId("button-finalize-signing").click();

  // Should succeed and redirect — no version conflict error
  await expect(page).toHaveURL(/\/contracts\/[a-f0-9-]+$/, { timeout: 15000 });
  await expect(page.getByText("modified by another user")).not.toBeVisible();

  // Crucially: /api/contracts/generate should have been called exactly once
  expect(generateCalls.length).toBe(1);

  await page.screenshot({ path: path.join(imgDir, "contract-version-conflict-fixed.png") });
});
