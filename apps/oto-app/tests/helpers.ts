import { type Page, expect } from "@playwright/test";
import users from "../fixtures/users.json" with { type: "json" };

export { users };

export const testId = () => Math.random().toString(36).slice(2, 8);

export async function login(page: Page, creds = users.admin) {
  await page.goto("/");
  // The login page defaults to phone mode; switch to email for test credentials.
  // Wait for the toggle before checking visibility; otherwise a slow render can
  // leave the helper trying to fill the email input while the phone form is
  // still displayed.
  const toggle = page.getByTestId("button-toggle-login-mode");
  if (await toggle.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) {
    const toggleText = await toggle.innerText();
    if (toggleText.includes("email")) {
      await toggle.click();
    }
  }
  await expect(page.getByTestId("input-login-email")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("input-login-email").fill(creds.email);
  await page.getByTestId("input-login-password").fill(creds.password);
  await page.click('button:has-text("Sign in")');
  const result = await Promise.race([
    page.waitForURL("**/today**", { timeout: 10000 }).then(() => "ok" as const),
    page.getByText("Invalid credentials").first()
      .waitFor({ timeout: 10000 }).then(() => "error" as const),
  ]);
  if (result === "error") {
    throw new Error(`Login failed for ${creds.email}`);
  }

  // Keep tests deterministic when the full seed is shared across the suite and
  // earlier tests create additional branches. Admin tests should start from the
  // seeded Bangkok branch instead of whichever branch happens to sort first.
  await page.evaluate(async () => {
    const user = await fetch("/api/user", { credentials: "include" }).then((r) => r.json()).catch(() => null);
    if (!["admin", "global_admin", "operator_admin"].includes(user?.role)) return;
    const branches = await fetch("/api/branches", { credentials: "include" }).then((r) => r.json()).catch(() => []);
    const bangkok = branches.find((b: { name: string }) => b.name === "Bangkok");
    if (bangkok?.id) localStorage.setItem("oto_active_branch_id", bangkok.id);
  });
}

/** Create an employee with login via UI. Returns credentials. */
export async function createStaffWithLogin(adminPage: Page) {
  const suffix = testId();
  const fullName = `Staff Test ${suffix}`;
  const email = `staff-${suffix}@example.com`;
  const tempPassword = "testpass123";
  const finalPassword = "newpass456";

  // Navigate to HR → Bangkok → Employees → Add
  await adminPage.getByRole("button", { name: "HR" }).click();
  await expect(adminPage.getByText("Welcome back")).toBeVisible({ timeout: 10000 });
  await adminPage.getByTestId("branch-selector-trigger").click();
  await adminPage.locator("[data-testid^='branch-option-branch-']", { hasText: "Bangkok" }).click();
  await adminPage.waitForTimeout(500);

  const empNav = adminPage.getByTestId("nav-employees");
  if (!(await empNav.isVisible())) {
    await adminPage.getByTestId("section-toggle-hr-operations").click();
  }
  await empNav.click();
  await expect(adminPage.getByTestId("text-employees-title")).toBeVisible({ timeout: 10000 });

  await adminPage.getByRole("link", { name: "Add" }).first().click();
  await expect(adminPage.getByRole("heading", { name: "Add Employee" })).toBeVisible({ timeout: 10000 });

  await adminPage.locator("input[name='fullName']").fill(fullName);
  await adminPage.locator("input[name='nickname']").fill(`S${suffix}`);
  await adminPage.locator("input[name='email']").fill(email);
  await adminPage.locator("input[name='phone']").fill(`+66800${suffix}`);
  await adminPage.locator("input[name='defaultMergeData.positionTitle']").fill("Tester");
  await adminPage.locator("label:has-text('Branch') >> .. >> button").first().click();
  await adminPage.getByRole("option", { name: "Bangkok" }).click();
  await adminPage.locator("label:has-text('Department') >> .. >> button").first().click();
  await adminPage.getByRole("option", { name: "Front Desk" }).click();
  await adminPage.locator("input[placeholder*='50,000']").fill("20000");
  await adminPage.locator("label:has-text('Start Date') >> .. >> button").first().scrollIntoViewIfNeeded();
  await adminPage.locator("label:has-text('Start Date') >> .. >> button").first().click();
  await adminPage.locator("table button:has-text('1')").first().click();
  await adminPage.getByTestId("button-section-save").first().click();

  const row = adminPage.locator("tr", { hasText: fullName });
  await expect(row).toBeVisible({ timeout: 10000 });

  await adminPage.getByRole("link", { name: fullName }).click();
  await expect(adminPage.getByText("Onboarding Progress")).toBeVisible({ timeout: 10000 });

  const accessSection = adminPage.getByTestId("collapsible-access-login");
  await accessSection.scrollIntoViewIfNeeded();
  await accessSection.getByText("Access & Login").click();
  await expect(adminPage.getByTestId("button-enable-login")).toBeVisible({ timeout: 5000 });
  await adminPage.getByTestId("button-enable-login").click();
  await expect(adminPage.getByText("Enable Login Access")).toBeVisible({ timeout: 5000 });

  await adminPage.getByRole("button", { name: "Next" }).click();
  await expect(adminPage.getByText("Set temporary password")).toBeVisible({ timeout: 5000 });
  await adminPage.getByTestId("input-temp-password").fill(tempPassword);
  await adminPage.locator("[role='dialog']").getByTestId("button-create-login").click();

  await expect(adminPage.locator("span", { hasText: "Login access created" })).toBeVisible({ timeout: 10000 });
  await adminPage.getByRole("button", { name: "Done" }).click();
  await adminPage.locator("[role='dialog']").waitFor({ state: "hidden" });

  return { fullName, email, tempPassword, finalPassword };
}

/** Login as staff, handle mustChangePassword redirect. */
export async function loginAsStaff(
  page: Page,
  email: string,
  tempPassword: string,
  finalPassword: string,
) {
  await page.goto("/");
  const toggle = page.getByTestId("button-toggle-login-mode");
  if (await toggle.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) {
    const toggleText = await toggle.innerText();
    if (toggleText.includes("email")) {
      await toggle.click();
    }
  }
  await expect(page.getByTestId("input-login-email")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("input-login-email").fill(email);
  await page.getByTestId("input-login-password").fill(tempPassword);
  await page.click('button:has-text("Sign in")');

  await expect(page.getByTestId("input-current-password")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("input-current-password").fill(tempPassword);
  await page.getByTestId("input-new-password").fill(finalPassword);
  await page.getByTestId("input-confirm-password").fill(finalPassword);
  await page.getByTestId("button-change-password").click();

  await page.waitForURL("**/today**", { timeout: 10000 });
}
