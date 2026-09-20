// seed: full
import { test, expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { coreEvents } from "../server/db/coreSchema";
import { login } from "./helpers";

async function openSeededCamp(page: Page) {
  const [camp] = await db
    .select({ id: coreEvents.id })
    .from(coreEvents)
    .where(eq(coreEvents.title, "Manual Test Camp - Today"))
    .limit(1);
  expect(camp, "Full seed must provide the manual-test camp").toBeTruthy();

  await login(page);
  await page.goto(`/studio/events/camp/${camp.id}`);
  await expect(page.getByRole("heading", { name: "Manual Test Camp - Today" })).toBeVisible();
}

test("camp detail shows seeded attendance history", async ({ page }) => {
  await openSeededCamp(page);

  const history = page.getByText("Attendance History").locator("..").locator("..");
  const historicalRow = history
    .locator("tr")
    .filter({ hasText: "Manual Test Camper One" })
    .filter({ hasText: "Prepaid" });
  await expect(historicalRow).toBeVisible();
  await expect(historicalRow).toContainText("Manual Test Parent One");
  await expect(historicalRow).toContainText("Manual Test Grandparent");
  await expect(historicalRow).toContainText("Left");
});

test("manager can edit a camp attendance record", async ({ page }) => {
  await openSeededCamp(page);

  const attendanceHistory = page.getByText("Attendance History").locator("..").locator("..");
  const attendanceRow = attendanceHistory
    .locator("tr")
    .filter({ hasText: "Manual Test Camper One" })
    .filter({ hasText: "Prepaid" });
  await attendanceRow.locator("button").click();

  const dialog = page.getByRole("dialog", { name: "Edit Attendance" });
  await expect(dialog).toBeVisible();
  await dialog.locator("textarea").fill("Parent confirmed collection details.");
  await dialog.getByRole("button", { name: "Save Changes" }).click();

  await expect(page.getByText("Attendance updated", { exact: true })).toBeVisible();
  await attendanceRow.getByRole("button").click();
  await expect(dialog.locator("textarea")).toHaveValue("Parent confirmed collection details.");
});

test("manager can add a future camp attendance day", async ({ page }) => {
  await openSeededCamp(page);

  const registrationRow = page.locator("tr", { hasText: "Manual Test Camper One" }).last();
  await registrationRow.getByRole("button", { name: "Edit" }).click();

  const sheet = page.getByRole("dialog", { name: "Child Profile" });
  await expect(sheet).toBeVisible();
  const attendanceDates = sheet.getByRole("heading", { name: "Attendance Dates" }).locator("..");
  const availableDay = attendanceDates
    .locator("button:not([disabled])")
    .filter({ hasText: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/ })
    .first();
  await availableDay.click();
  await attendanceDates.getByRole("button", { name: "Save Attendance" }).click();

  await expect(page.getByText("Attendance days updated", { exact: true })).toBeVisible();
});
