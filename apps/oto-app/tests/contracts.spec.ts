// seed: full
import { test, expect } from "@playwright/test";
import { login } from "./helpers";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(__dirname, "..", "test-results", "screenshots", "hr");

test("can create a contract, send signing link, and sign it", async ({ page }) => {
  test.setTimeout(60000);
  await login(page);

  const employeeName = `Contract Test ${Date.now()}`;
  await page.evaluate(async (name) => {
    const branches = await fetch("/api/branches", { credentials: "include" }).then((r) => r.json());
    const departments = await fetch("/api/departments", { credentials: "include" }).then((r) => r.json());
    const branch = branches.find((b: { name: string }) => b.name === "Bangkok") ?? branches[0];
    const department = departments.find((d: { name: string }) => d.name === "Front Desk") ?? departments[0];
    const res = await fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        fullName: name,
        nickname: name.split(" ").slice(-1)[0],
        email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@example.com`,
        branchId: branch.id,
        primaryDepartmentId: department?.id,
        status: "active",
        employmentState: "ACTIVE",
      }),
    });
    if (!res.ok) throw new Error(await res.text());
  }, employeeName);

  // Navigate to HR
  await page.getByRole("button", { name: "HR" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });

  // Select Bangkok branch
  await page.getByTestId("branch-selector-trigger").click();
  await page.locator("[data-testid^='branch-option-branch-']", { hasText: "Bangkok" }).click();
  await page.waitForTimeout(500);

  await page.getByTestId("section-toggle-hr-operations").click();
  await page.getByTestId("nav-employees").click();
  await expect(page.getByTestId("text-employees-title")).toBeVisible({ timeout: 10000 });

  await page.getByRole("link", { name: employeeName }).click();
  await expect(page.getByText(employeeName)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("Onboarding Progress")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "employee-onboarding.png") });

  // Click Create Contract button (in the warning banner)
  await page.getByRole("button", { name: "Create Contract" }).first().click();
  await expect(page.getByTestId("text-wizard-title")).toBeVisible({ timeout: 10000 });

  // Step 1: Select Employee & Template
  await expect(page.getByText("Step 1: Select Employee & Template")).toBeVisible();

  // Select employee
  await page.getByTestId("select-employee").click();
  await page.getByRole("option", { name: employeeName }).click();

  // Select template
  await page.getByTestId("select-template").click();
  await page.getByRole("option").first().click();

  await page.screenshot({ path: path.join(imgDir, "contract-step1.png") });
  await page.getByTestId("button-next-step1").click();

  // Step 2: Review Employee Details
  await expect(page.getByText("Step 2: Review Employee Details")).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: path.join(imgDir, "contract-step2.png") });
  await page.getByTestId("button-next-step2").click();

  // Step 3: Contract Details
  await expect(page.getByText("Step 3: Contract Details")).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: path.join(imgDir, "contract-step3.png") });

  // Click Preview & Continue (next step button for step 3)
  await page.getByRole("button", { name: /Preview/i }).click();

  // Step 4: Preview & Finalize
  await expect(page.getByText("Step 4: Preview & Finalize")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "contract-step4.png") });

  // Click Finalize + Signing Link
  await page.getByTestId("button-finalize-signing").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.getByTestId("button-finalize-signing").click();

  // Wait for redirect to contract detail page (success) or error toast
  await expect(page).toHaveURL(/\/contracts\/[a-f0-9-]+$/, { timeout: 15000 });

  // Get the signing token from the database
  const signingToken = await page.evaluate(async () => {
    const res = await fetch("/api/contracts");
    const data = await res.json();
    return data[0]?.signingToken;
  });
  expect(signingToken).toBeTruthy();

  // Navigate to signing page (public, no auth needed)
  await page.goto(`http://localhost:5000/sign/${signingToken}`);
  await expect(page.getByRole("heading", { name: "Employment Contract", exact: true }).first()).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(imgDir, "signing-page.png") });

  // Scroll down to signature area and draw
  const canvas = page.locator("canvas");
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas not found");
  await page.mouse.move(box.x + 50, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 60, { steps: 10 });
  await page.mouse.move(box.x + 200, box.y + 100, { steps: 10 });
  await page.mouse.move(box.x + 250, box.y + 70, { steps: 10 });
  await page.mouse.up();

  // Check the agreement checkbox
  await page.getByTestId("checkbox-agree").check();

  await page.screenshot({ path: path.join(imgDir, "signing-ready.png") });

  // Sign the contract
  await page.getByTestId("button-sign-contract").click();

  // Wait for success — signed contracts show a download button
  await expect(page.getByTestId("button-download-signed-pdf")).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: path.join(imgDir, "contract-signed.png") });

  // Navigate back to employee profile and verify onboarding progress
  await page.goto("http://localhost:5000");
  // Already logged in — signing page doesn't clear session
  await page.getByRole("button", { name: "HR" }).click();
  await page.waitForTimeout(500);
  await page.getByTestId("branch-selector-trigger").click();
  await page.locator("[data-testid^='branch-option-branch-']", { hasText: "Bangkok" }).click();
  await page.waitForTimeout(500);
  // Expand HR Operations if collapsed
  const empNav = page.getByTestId("nav-employees");
  if (!(await empNav.isVisible())) {
    await page.getByTestId("section-toggle-hr-operations").click();
  }
  await empNav.click();
  await expect(page.getByTestId("text-employees-title")).toBeVisible({ timeout: 10000 });
  await page.getByRole("link", { name: employeeName }).click();
  await expect(page.getByText("Onboarding Progress")).toBeVisible({ timeout: 10000 });

  // Contract Signed step should now be complete
  await expect(page.getByText("Contract Signed").first()).toBeVisible();
  await page.screenshot({ path: path.join(imgDir, "onboarding-contract-done.png") });
});
