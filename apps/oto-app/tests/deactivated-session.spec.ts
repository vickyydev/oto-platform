// seed: full
import { test, expect } from "@playwright/test";
import { login, createStaffWithLogin, loginAsStaff } from "./helpers";

async function deactivateUserViaUI(adminPage: import("@playwright/test").Page, email: string) {
  // Navigate to User Management
  await adminPage.getByRole("button", { name: "HR" }).click();
  await expect(adminPage.getByText("Welcome back")).toBeVisible({ timeout: 10000 });

  await adminPage.getByTestId("branch-selector-trigger").click();
  await adminPage.getByTestId("branch-option-all-all").click();
  await adminPage.waitForTimeout(500);

  await adminPage.getByText("Platform Admin").click();
  await adminPage.getByRole("link", { name: "User Management" }).click();
  await expect(adminPage.getByText("Manage user accounts")).toBeVisible({ timeout: 10000 });

  // Find the user row and deactivate
  const row = adminPage.locator("tr", { hasText: email });
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.locator("button").filter({ has: adminPage.locator("svg") }).last().click();
  await adminPage.getByRole("menuitem", { name: /deactivate/i }).click();
  await adminPage.waitForTimeout(1000);
}

test.describe("deactivated user session", () => {
  test("deactivated user is rejected by GET /api/user", async ({ browser }) => {
    test.setTimeout(60000);
    const adminContext = await browser.newContext();
    const staffContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const staffPage = await staffContext.newPage();

    try {
      await login(adminPage);
      const { email, tempPassword, finalPassword } = await createStaffWithLogin(adminPage);

      // Staff logs in and changes temp password
      await loginAsStaff(staffPage, email, tempPassword, finalPassword);

      // Verify staff session works
      const beforeStatus = await staffPage.evaluate(async () => {
        const res = await fetch("/api/user");
        return res.status;
      });
      expect(beforeStatus).toBe(200);

      // Admin deactivates staff
      await deactivateUserViaUI(adminPage, email);

      // Staff calls GET /api/user — should be rejected
      const afterStatus = await staffPage.evaluate(async () => {
        const res = await fetch("/api/user");
        return res.status;
      });
      expect(afterStatus).toBe(401);
    } finally {
      await adminContext.close();
      await staffContext.close();
    }
  });

});
