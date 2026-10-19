// seed: none of its own — it reads a deployment that already has a payroll
// role and a staff account on the platform, a paying company, and at least
// one locked month (staging after the R4 proof). Not run in CI.
//
// SCRUM-572 (payroll R7, the UI cutover), the smoke walk of PLAN §9 R7:
// launcher sign-in -> the OTO App tile -> the payroll hub -> month-end ->
// "Check the month" (the preview) -> history; then the same as staff, who
// land on their own payslips and reach no payroll page. Every old payroll
// address must redirect, never 404. It runs at phone width as well, with no
// sideways page scroll on the hub, month-end, history and My Payslips.
//
// Usage, from apps/oto-app (the launcher and the OTO App both running):
//   LAUNCHER_URL=https://… OTO_APP_URL=https://… \
//   PAYROLL_PHONE=… PAYROLL_PASSWORD=… STAFF_PHONE=… STAFF_PASSWORD=… \
//   npx playwright test tests/payroll-cutover.spec.ts
// Without those variables every test is skipped.
import { expect, test, type Page } from "@playwright/test";

const LAUNCHER_URL = process.env.LAUNCHER_URL;
const OTO_APP_URL = process.env.OTO_APP_URL;
const PAYROLL = { phone: process.env.PAYROLL_PHONE, password: process.env.PAYROLL_PASSWORD };
const STAFF = { phone: process.env.STAFF_PHONE, password: process.env.STAFF_PASSWORD };

test.skip(!LAUNCHER_URL || !OTO_APP_URL, "LAUNCHER_URL and OTO_APP_URL name the deployment to walk");

/** Sign in once at the launcher and open the OTO App from its tile (the hand-off token rides in the fragment). */
async function launcherSignIn(page: Page, who: { phone?: string; password?: string }) {
  test.skip(!who.phone || !who.password, "no credentials for this role");
  await page.goto(LAUNCHER_URL!);
  await page.locator('input[type="tel"]').fill(who.phone!);
  await page.locator('input[type="password"]').fill(who.password!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Open OTO App" }).click();
  await page.waitForURL((url) => url.origin === new URL(OTO_APP_URL!).origin, { timeout: 30_000 });
  // The app exchanges the hand-off for its own session and leaves the fragment.
  await expect.poll(async () => (await page.request.get(`${OTO_APP_URL}/api/user`)).status(), { timeout: 20_000 }).toBe(200);
}

const app = (path: string) => `${OTO_APP_URL}${path}`;
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("a payroll role: hub -> month-end -> preview -> history", async ({ page }) => {
  await launcherSignIn(page, PAYROLL);

  await page.goto(app("/payroll"));
  await expect(page.getByTestId("page-payroll-hub")).toBeVisible();
  for (const card of ["run", "people", "history", "downloads", "documents", "setup"]) await expect(page.getByTestId(`hub-card-${card}`)).toBeVisible();
  // The sidebar's Payroll section lists the hub's pages and none of the old ones.
  const toggle = page.getByTestId("section-toggle-payroll");
  if (!(await page.getByTestId("nav-run-payroll").isVisible())) await toggle.click();
  await expect(page.getByTestId("nav-run-payroll")).toBeVisible();
  await expect(page.getByTestId("nav-my-payslips")).toBeVisible();
  for (const old of ["nav-payroll-overview", "nav-periods", "nav-statutory-rules"]) await expect(page.getByTestId(old)).toHaveCount(0);

  await page.getByTestId("hub-card-run").click();
  await expect(page.getByTestId("page-payroll-month-end")).toBeVisible();
  await page.getByRole("tab", { name: "Check the month" }).click();
  // Either the calculated month or the plain words saying why it cannot be calculated yet.
  await expect(page.getByTestId("preview-matrix").or(page.getByText("The month cannot be calculated yet")).or(page.getByText(/No one is paid by this company/))).toBeVisible({ timeout: 20_000 });

  await page.goto(app("/payroll/history"));
  await expect(page.getByTestId("page-payroll-history")).toBeVisible();
  const months = page.getByTestId("history-list").getByRole("button");
  if (await months.count()) {
    await months.first().click();
    await expect(page.getByTestId("history-version")).toBeVisible();
    await expect(page.getByTestId("history-payslips")).toBeVisible();
  }
});

test("a payroll role: every old payroll address redirects to its new home", async ({ page }) => {
  await launcherSignIn(page, PAYROLL);
  const homes: [string, RegExp][] = [
    ["/payroll/periods", /\/payroll\/history$/],
    ["/payroll/periods/old-period", /\/payroll\/history$/],
    ["/payroll/runs/old-run", /\/payroll\/month-end$/],
    ["/payroll/runs/old-run/exceptions", /\/payroll\/month-end\?tab=preview$/],
    ["/payroll/runs/old-run/exceptions/old-exception", /\/payroll\/month-end\?tab=preview$/],
    ["/payroll/runs/old-run/employees", /\/payroll\/people$/],
    ["/payroll/runs/old-run/exports", /\/payroll\/history$/],
    ["/payroll/statutory-rules", /\/payroll\/setup\?tab=statutory$/],
    ["/my-payslips", /\/payroll\/me\/payslips$/],
  ];
  for (const [from, to] of homes) {
    await page.goto(app(from));
    await expect(page, from).toHaveURL(to);
    await expect(page.getByText("404")).toHaveCount(0);
  }
});

test("staff: /payroll is their own payslips, and no payroll page is reachable", async ({ page }) => {
  await launcherSignIn(page, STAFF);
  await page.goto(app("/payroll"));
  await expect(page).toHaveURL(/\/payroll\/me\/payslips$/);
  await expect(page.getByTestId("page-my-payslips")).toBeVisible();
  const toggle = page.getByTestId("section-toggle-payroll");
  if (!(await page.getByTestId("nav-my-payslips").isVisible())) await toggle.click();
  await expect(page.getByTestId("nav-my-payslips")).toBeVisible();
  await expect(page.getByTestId("nav-run-payroll")).toHaveCount(0);
  await page.goto(app("/payroll/runs/old-run"));
  await expect(page).toHaveURL(/\/payroll\/me\/payslips$/);
  await page.goto(app("/payroll/month-end"));
  await expect(page.getByTestId("page-payroll-month-end")).toHaveCount(0);
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the hub, month-end tabs, history and My Payslips never scroll sideways", async ({ page }) => {
    await launcherSignIn(page, PAYROLL);
    for (const [path, id] of [["/payroll", "page-payroll-hub"], ["/payroll/history", "page-payroll-history"], ["/payroll/me/payslips", "page-my-payslips"]] as const) {
      await page.goto(app(path));
      await expect(page.getByTestId(id)).toBeVisible();
      expect(await noSidewaysScroll(page), path).toBe(true);
    }
    await page.goto(app("/payroll/month-end"));
    await expect(page.getByTestId("page-payroll-month-end")).toBeVisible();
    for (const tab of ["1. Attendance", "2. Inputs", "3. One-off adjustments", "Leave, OT bank & exits", "Check the month", "Confirm & lock"]) {
      await page.getByRole("tab", { name: tab }).click();
      expect(await noSidewaysScroll(page), tab).toBe(true);
    }
  });
});
