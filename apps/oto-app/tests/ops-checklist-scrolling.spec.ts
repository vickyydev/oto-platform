// seed: full
import { expect, test, type Locator, type Page } from "@playwright/test";
import { login } from "./helpers";

const viewports = [
  { name: "phone portrait", width: 390, height: 844 },
  { name: "phone landscape", width: 844, height: 390 },
  { name: "iPad portrait", width: 768, height: 1024 },
  { name: "iPad landscape", width: 1024, height: 768 },
];

async function extendContent(locator: Locator, itemSelector: string) {
  await locator.evaluate((container, selector) => {
    const source = container.querySelector(selector);
    if (!source) throw new Error(`No checklist item found for ${selector}`);

    for (let index = 0; index < 24; index += 1) {
      const clone = source.cloneNode(true) as HTMLElement;
      clone.setAttribute("data-scroll-regression-item", String(index));
      container.appendChild(clone);
    }
  }, itemSelector);
}

async function expectLastItemReachable(page: Page) {
  const scrollContainer = page.getByTestId("ops-scroll-container");
  const lastItem = page.locator("[data-scroll-regression-item]").last();

  await expect.poll(() => scrollContainer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
    touchAction: getComputedStyle(element).touchAction,
  }))).toMatchObject({
    overflowY: "auto",
    touchAction: "pan-y",
  });

  const dimensions = await scrollContainer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await scrollContainer.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(lastItem).toBeInViewport();
}

test.describe("Ops checklist responsive scrolling", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const viewport of viewports) {
    test(`${viewport.name} reaches the end of Work and List of Checklists`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/ops");
      await expect(page.getByTestId("tab-ops-checklists")).toBeVisible();
      await page.getByTestId("tab-ops-checklists").click();

      const dashboard = page.getByTestId("checklist-work-dashboard");
      await expect(dashboard).toBeVisible();
      const firstColumnCards = dashboard.getByTestId("checklist-column-pending").locator("[data-testid^='cl-card-']");
      const cardSelector = await firstColumnCards.count() > 0
        ? "[data-testid^='cl-card-']"
        : "section";
      await extendContent(dashboard, cardSelector);
      await expectLastItemReachable(page);

      await page.getByTestId("button-checklists-view-templates").click();
      const templatesView = page.getByTestId("checklist-templates-view");
      await expect(templatesView).toBeVisible();
      await extendContent(templatesView, "[data-testid^='card-ops-checklist-']");
      await expectLastItemReachable(page);

      await expect(page.getByTestId("tabs-ops-segments")).toHaveCSS("overflow-x", "auto");
      const pageWidth = await page.locator("html").evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(pageWidth.scrollWidth).toBe(pageWidth.clientWidth);
    });
  }
});