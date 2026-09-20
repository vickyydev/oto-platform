// seed: full
import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { login, createStaffWithLogin, loginAsStaff } from "./helpers";

/**
 * Bug #16: User accounts not deactivated on departure.
 *
 * When an employee's lastWorkingDay passes, their user account should be
 * deactivated so they can no longer log in.
 */

function runSQL(sql: string) {
  execSync(
    `kubectl --context docker-desktop exec deploy/postgres -- psql -U oto -d oto_dev -c "${sql.replace(/"/g, '\\"')}"`,
  );
}

function queryDB(sql: string): string {
  return execSync(
    `kubectl --context docker-desktop exec deploy/postgres -- psql -U oto -d oto_dev -tAc "${sql}"`,
    { encoding: "utf-8" },
  ).trim();
}

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

async function goToEmployeeProfile(page: Page, fullName: string) {
  await page.getByRole("button", { name: "HR" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("branch-selector-trigger").click();
  await page.locator("[data-testid^='branch-option-branch-']", { hasText: "Bangkok" }).click();
  await page.waitForTimeout(500);

  const empNav = page.getByTestId("nav-employees");
  if (!(await empNav.isVisible())) {
    await page.getByTestId("section-toggle-hr-operations").click();
  }
  await empNav.click();
  await expect(page.getByTestId("text-employees-title")).toBeVisible({ timeout: 10000 });

  await page.waitForLoadState("networkidle");
  const empLink = page.getByRole("link", { name: fullName }).first();
  const count = await empLink.count();
  if (count === 0) {
    throw new Error(`Employee "${fullName}" not found in employee list`);
  }
  await empLink.click();
  await expect(page.getByText("Update employee information")).toBeVisible({ timeout: 10000 });
}

async function offboardEmployee(page: Page, lastWorkingDay: Date) {
  await page.getByRole("button", { name: "Offboard" }).click();

  await page.locator("[data-testid='select-reason-code']").click();
  await page.getByRole("option", { name: "Personal reasons" }).click();

  await page.getByTestId("input-last-working-day").click();

  const targetMonth = lastWorkingDay.toLocaleString("en-US", { month: "long" });
  const targetYear = lastWorkingDay.getFullYear();
  const targetDay = lastWorkingDay.getDate();

  const calendarCaption = page.locator(".rdp-caption_label, [class*='caption']");
  const currentCaption = await calendarCaption.textContent();

  if (currentCaption && !currentCaption.includes(`${targetMonth} ${targetYear}`)) {
    const targetTime = lastWorkingDay.getTime();
    const now = new Date();
    if (targetTime < now.getTime()) {
      await page
        .locator("button[name='previous-month'], [aria-label*='previous'], .rdp-nav_button_previous")
        .click();
    } else {
      await page
        .locator("button[name='next-month'], [aria-label*='next'], .rdp-nav_button_next")
        .click();
    }
  }

  await page
    .locator("button:not(.day-outside)")
    .filter({ hasText: new RegExp(`^${targetDay}$`) })
    .first()
    .click();

  await page.getByTestId("button-submit-offboarding").click();
  await page.getByRole("button", { name: "Skip Letter" }).click({ timeout: 10000 });
  await page.getByTestId("button-done").click({ timeout: 10000 });
}

test.describe.serial("departed employee deactivation", () => {
  test("scheduled task deactivates departed employee account", async ({ browser }) => {
    test.setTimeout(90000);
    const adminContext = await browser.newContext();
    const staffContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const staffPage = await staffContext.newPage();

    try {
      await login(adminPage);
      const { fullName, email, tempPassword, finalPassword } = await createStaffWithLogin(adminPage);

      // Staff logs in and changes temp password
      await loginAsStaff(staffPage, email, tempPassword, finalPassword);

      // Navigate to employee profile and offboard with last working day = tomorrow
      await goToEmployeeProfile(adminPage, fullName);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      await offboardEmployee(adminPage, tomorrow);

      // Verify staff can still log in (departure hasn't passed)
      const beforeStatus = await staffPage.evaluate(async () => {
        const res = await fetch("/api/user", { cache: "no-store" });
        return res.status;
      });
      expect(beforeStatus).toBe(200);

      // Move departure date to yesterday via SQL
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      runSQL(
        `UPDATE employees SET last_working_day = '${isoDate(yesterday)}' WHERE email = '${email}'`,
      );

      // Trigger the deactivation job
      const body = await adminPage.evaluate(async () => {
        const res = await fetch("/api/admin/run-departed-deactivation", { method: "POST" });
        if (!res.ok) throw new Error(`Deactivation job failed: ${res.status}`);
        return res.json();
      });
      expect(body.deactivated).toBeGreaterThanOrEqual(1);

      // Staff should now be blocked
      const afterStatus = await staffPage.evaluate(async () => {
        const res = await fetch("/api/user", { cache: "no-store" });
        return res.status;
      });
      expect(afterStatus).toBe(401);
    } finally {
      await adminContext.close();
      await staffContext.close();
    }
  });

  test("setting departure date to yesterday immediately blocks login", async ({ browser }) => {
    test.setTimeout(90000);
    const adminContext = await browser.newContext();
    const staffContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const staffPage = await staffContext.newPage();

    try {
      await login(adminPage);
      const { fullName, email, tempPassword, finalPassword } = await createStaffWithLogin(adminPage);

      // Staff logs in and changes temp password
      await loginAsStaff(staffPage, email, tempPassword, finalPassword);

      // Navigate to employee profile and offboard with last working day = yesterday
      await goToEmployeeProfile(adminPage, fullName);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      await offboardEmployee(adminPage, yesterday);

      // Staff should be immediately blocked
      const status = await staffPage.evaluate(async () => {
        const res = await fetch("/api/user", { cache: "no-store" });
        return res.status;
      });
      expect(status).toBe(401);
    } finally {
      await adminContext.close();
      await staffContext.close();
    }
  });
});
