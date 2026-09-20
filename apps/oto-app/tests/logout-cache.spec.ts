// seed: full
import { test, expect } from "@playwright/test";
import { login, createStaffWithLogin, loginAsStaff } from "./helpers";

test("logging out clears cached data from previous session", async ({ browser }) => {
  test.setTimeout(60000);
  const adminContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const staffPage = await staffContext.newPage();

  try {
    // Create a staff user via admin
    await login(adminPage);
    const { email, tempPassword, finalPassword } = await createStaffWithLogin(adminPage);

    // Staff logs in and changes temp password
    await loginAsStaff(staffPage, email, tempPassword, finalPassword);

    // Staff should NOT see "Setup" in the nav — that's admin-only
    await expect(staffPage.getByText("Setup").first()).not.toBeVisible({ timeout: 3000 });

    // Log in as admin in the staff context (same browser, reuse SPA session)
    await staffPage.locator("header button").filter({ has: staffPage.locator("span.relative") }).first().click();
    await staffPage.getByText("Logout").click();
    await staffPage.getByTestId('button-toggle-login-mode').waitFor({ timeout: 5000 });
    await login(staffPage);

    // Admin SHOULD see "Setup"
    await expect(staffPage.getByText("Setup").first()).toBeVisible({ timeout: 3000 });

    // Log out admin, log back in as staff
    await staffPage.locator("header button").filter({ has: staffPage.locator("span.relative") }).first().click();
    await staffPage.getByText("Logout").click();
    await staffPage.getByTestId('button-toggle-login-mode').waitFor({ timeout: 5000 });
    await login(staffPage, { email, password: finalPassword });

    // Staff should NOT see "Setup" — previous admin session data must be cleared
    await expect(staffPage.getByText("Setup").first()).not.toBeVisible({ timeout: 3000 });
  } finally {
    await adminContext.close();
    await staffContext.close();
  }
});
