// seed: full
import { test, expect } from "@playwright/test";
import { login, testId } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "hr");

test("can create a login for an employee", async ({ page }) => {
  const suffix = testId();
  const fullName = `Login Test ${suffix}`;

  await login(page);

  // Navigate to HR → Bangkok → Employees
  await page.getByRole("button", { name: "HR" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("branch-selector-trigger").click();
  await page.locator("[data-testid^='branch-option-branch-']", { hasText: "Bangkok" }).click();
  await page.waitForTimeout(500);
  await page.getByTestId("section-toggle-hr-operations").click();
  await page.getByTestId("nav-employees").click();
  await expect(page.getByTestId("text-employees-title")).toBeVisible({ timeout: 10000 });

  // Create a fresh employee
  await page.getByRole("link", { name: "Add" }).first().click();
  await expect(page.getByRole("heading", { name: "Add Employee" })).toBeVisible({ timeout: 10000 });
  await page.locator("input[name='fullName']").fill(fullName);
  await page.locator("input[name='nickname']").fill(`L${suffix}`);
  await page.locator("input[name='email']").fill(`login-${suffix}@example.com`);
  await page.locator("input[name='phone']").fill(`+66800${suffix}`);
  await page.locator("input[name='defaultMergeData.positionTitle']").fill("Tester");
  await page.locator("label:has-text('Branch') >> .. >> button").first().click();
  await page.getByRole("option", { name: "Bangkok" }).click();
  await page.locator("label:has-text('Department') >> .. >> button").first().click();
  await page.getByRole("option", { name: "Front Desk" }).click();
  await page.locator("input[placeholder*='50,000']").fill("20000");
  await page.locator("label:has-text('Start Date') >> .. >> button").first().scrollIntoViewIfNeeded();
  await page.locator("label:has-text('Start Date') >> .. >> button").first().click();
  await page.locator("table button:has-text('1')").first().click();
  await page.getByTestId("button-section-save").first().click();

  // Wait for redirect to employee list, then click through to profile
  const row = page.locator("tr", { hasText: fullName });
  await expect(row).toBeVisible({ timeout: 10000 });
  await page.getByRole("link", { name: fullName }).click();
  await expect(page.getByText("Onboarding Progress")).toBeVisible({ timeout: 10000 });

  // Scroll to Access & Login section and expand it
  const accessSection = page.getByTestId("collapsible-access-login");
  await accessSection.scrollIntoViewIfNeeded();
  await accessSection.getByText("Access & Login").click();
  await expect(page.getByTestId("button-enable-login")).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: path.join(imgDir, "access-no-login.png") });

  // Click Create Login
  await page.getByTestId("button-enable-login").click();
  await expect(page.getByText("Enable Login Access")).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(imgDir, "enable-login-step1.png") });

  // Step 1: Keep defaults (Staff, Today module), click Next
  await page.getByRole("button", { name: "Next" }).click();

  // Step 2: Set password
  await expect(page.getByText("Set temporary password")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("input-temp-password").fill("staffpass123");
  await page.screenshot({ path: path.join(imgDir, "enable-login-step2.png") });

  // Click Create Login (in dialog, not in onboarding stepper)
  await page.locator("[role='dialog']").getByTestId("button-create-login").click();

  // Step 3: Success
  await expect(page.locator("span", { hasText: "Login access created" })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "enable-login-done.png") });

  // Close dialog
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator("[role='dialog']").waitFor({ state: "hidden" });

  // Verify employee.userId was set (the new auth path sets userId directly)
  const empData = await page.evaluate(async (name) => {
    const res = await fetch("/api/employees");
    const data = await res.json();
    const emp = data.find((e: any) => e.fullName === name);
    return { userId: emp?.userId };
  }, fullName);
  expect(empData.userId).toBeTruthy();

  // Verify Access & Login section now shows the configured access state
  await accessSection.scrollIntoViewIfNeeded();
  await expect(accessSection.getByText("STAFF", { exact: true }).first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("button-enable-login")).not.toBeVisible();
  await page.screenshot({ path: path.join(imgDir, "access-login-created.png") });
});
