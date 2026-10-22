// seed: none — every /api call is answered in the browser, so this runs
// against the client alone (e.g. `npx vite --port 5000` from apps/oto-app).
//
// SCRUM-655: the Create Camp Event panel lets the organiser leave out days
// while creating a camp — a "Skip weekends" toggle and a day list under the
// date pickers where a day can be unticked. The list follows the dates and the
// toggle as they change, wraps inside the panel at a laptop and a phone size,
// and the left-out days are posted as the camp's cancelled days (with no host).
import { expect, test, type Page } from "@playwright/test";

const viewports = [
  { name: "laptop", width: 1432, height: 781 },
  { name: "phone portrait", width: 390, height: 844 },
];

const adminUser = {
  id: "zz-test-admin",
  username: "zz-test-admin",
  email: "zz-test-admin@example.test",
  role: "admin",
  isActive: true,
  mustChangePassword: false,
  phoneVerified: true,
  branchAccess: [],
  hasAllBranchesAccess: true,
  allowedBranchIds: [],
  modules: {},
};

async function mockApi(page: Page, created: Record<string, unknown>[]) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/user") {
      await route.fulfill({ json: adminUser });
      return;
    }
    if (path === "/api/admin/events" && request.method() === "POST") {
      created.push(request.postDataJSON());
      await route.fulfill({ status: 201, json: { id: "zz-test-camp" } });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

const day = (page: Page, date: string) => page.getByTestId(`camp-day-${date}`);

async function pickEndDay(page: Page, dayOfMonth: string) {
  await page.getByTestId("input-camp-end-date").click();
  await page.locator(".rdp").getByRole("gridcell", { name: dayOfMonth, exact: true }).click();
  await expect(page.locator(".rdp")).toHaveCount(0);
}

for (const viewport of viewports) {
  test(`camp creation leaves out weekends and chosen days — ${viewport.name}`, async ({ page }) => {
    // Today is Friday 2 January 2099, so the camp starts on a Friday.
    await page.clock.setFixedTime(new Date("2099-01-02T12:00:00"));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const created: Record<string, unknown>[] = [];
    await mockApi(page, created);
    await page.goto("/studio/events/kanban");
    await page.getByTestId("button-create-event").click();
    await page.getByTestId("button-create-camp").click();
    const sheet = page.getByRole("dialog", { name: "Create Camp Event" });

    // Fri-Mon: four days, all open until the toggle is on.
    await pickEndDay(page, "5");
    await expect(page.getByTestId("camp-day-count")).toHaveText("4 of 4 days open");
    for (const date of ["2099-01-02", "2099-01-03", "2099-01-04", "2099-01-05"]) {
      await expect(day(page, date)).toHaveAttribute("aria-pressed", "true");
    }

    await page.getByTestId("switch-camp-skip-weekends").click();
    await expect(page.getByTestId("camp-day-count")).toHaveText("2 of 4 days open");
    for (const date of ["2099-01-03", "2099-01-04"]) {
      await expect(day(page, date)).toHaveAttribute("aria-pressed", "false");
      await expect(day(page, date)).toBeDisabled();
    }

    // The list follows a new end date: Tuesday joins, open.
    await pickEndDay(page, "6");
    await expect(page.getByTestId("camp-day-count")).toHaveText("3 of 5 days open");
    await expect(day(page, "2099-01-06")).toHaveAttribute("aria-pressed", "true");

    // Unticking a weekday leaves it out too, and its host row goes.
    await day(page, "2099-01-05").click();
    await expect(day(page, "2099-01-05")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("camp-day-count")).toHaveText("2 of 5 days open");
    await expect(sheet.getByText("Mon, 5 Jan")).toHaveCount(0);
    await expect(sheet.getByText("Sat, 3 Jan")).toHaveCount(0);
    await expect(sheet.getByText("Fri, 2 Jan")).toBeVisible();

    // The day list wraps inside the panel: every day fits, nothing scrolls sideways.
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox).not.toBeNull();
    for (const date of ["2099-01-02", "2099-01-03", "2099-01-04", "2099-01-05", "2099-01-06"]) {
      const box = await day(page, date).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(sheetBox!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(sheetBox!.x + sheetBox!.width);
    }
    const list = page.getByTestId("camp-day-exclusions");
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // A camp with every day left out cannot be created.
    await page.getByTestId("input-camp-title").fill("ZZ TEST camp");
    await day(page, "2099-01-02").click();
    await day(page, "2099-01-06").click();
    await expect(page.getByTestId("button-create-camp-event")).toBeDisabled();
    await day(page, "2099-01-02").click();
    await day(page, "2099-01-06").click();
    await expect(page.getByTestId("button-create-camp-event")).toBeEnabled();

    await page.getByTestId("button-create-camp-event").click();
    await expect.poll(() => created.length).toBe(1);
    expect(created[0]).toMatchObject({
      eventType: "camp",
      eventDate: "2099-01-02",
      campEndDate: "2099-01-06",
      campCancelledDays: ["2099-01-03", "2099-01-04", "2099-01-05"],
    });
  });
}
