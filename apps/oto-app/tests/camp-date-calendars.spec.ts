// seed: none — every /api call is answered in the browser, so this runs
// against the client alone (e.g. `npx vite --port 5000` from apps/oto-app).
//
// SCRUM-599: in the Create Camp Event panel the End Date calendar sat in the
// right half of a two-column row, wider than its column, and the panel clipped
// it — Friday and Saturday could not be seen or picked. Each date calendar must
// now open inside the panel, at a laptop and a phone size, with its Saturday
// column clickable.
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

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/user") {
      await route.fulfill({ json: adminUser });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

async function expectCalendarInsideSheet(page: Page, buttonTestId: string) {
  await page.getByTestId(buttonTestId).click();
  const sheet = page.getByRole("dialog", { name: "Create Camp Event" });
  const calendar = sheet.locator('.rdp');
  await expect(calendar).toBeVisible();

  const sheetBox = await sheet.boundingBox();
  const calendarBox = await calendar.boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(calendarBox).not.toBeNull();
  expect(calendarBox!.x).toBeGreaterThanOrEqual(sheetBox!.x);
  expect(calendarBox!.x + calendarBox!.width).toBeLessThanOrEqual(sheetBox!.x + sheetBox!.width);

  // The last day of the first full week (the Saturday column) must be the
  // element that actually receives a click at its centre — not clipped away.
  const saturday = calendar.locator("tbody tr").nth(1).locator("td").last().locator("button");
  const satBox = await saturday.boundingBox();
  expect(satBox).not.toBeNull();
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return Boolean(el?.closest('.rdp td:last-child'));
  }, { x: satBox!.x + satBox!.width / 2, y: satBox!.y + satBox!.height / 2 });
  expect(hit).toBe(true);
}

for (const viewport of viewports) {
  test(`camp date calendars fit the panel — ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockApi(page);
    await page.goto("/studio/events/kanban");
    await page.getByTestId("button-create-event").click();
    await page.getByTestId("button-create-camp").click();

    await expectCalendarInsideSheet(page, "input-camp-start-date");
    // Pick a date so the start calendar closes, then open the end calendar.
    await page.locator('.rdp tbody tr').nth(2).locator("td").first().locator("button").click();
    await expect(page.locator('.rdp')).toHaveCount(0);
    await expectCalendarInsideSheet(page, "input-camp-end-date");
  });
}
