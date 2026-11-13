import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// SCRUM-801/800 — real mobile sale, void, reload and measured payment controls.
// Only the disposable database provided by e2e/run.mjs is allowed here.
test.use({ viewport: { width: 375, height: 812 }, trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

/**
 * SCRUM-849 — WHERE THE TWO PICTURES OF THE PAYMENT STEP GO.
 *
 * A run keeps them in Playwright's own output folder for the test
 * (`test-results/`, which is not committed), so running this check changes no
 * file in the repository. `POS_E2E_SHOTS` names a folder to keep them in
 * instead, as it does for the other checks here — that is how a proof folder
 * under docs/qa is filled, on purpose and by name.
 */
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
async function picture(testInfo: TestInfo, name: string): Promise<string> {
  if (!SHOTS) return testInfo.outputPath(name);
  await mkdir(SHOTS, { recursive: true });
  return resolve(SHOTS, name);
}

async function signIn(page: Page) {
  expect(Boolean(process.env.POS_E2E_DATABASE_URL), 'use the isolated e2e runner').toBe(true);
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(process.env.POS_E2E_PHONE!);
  await page.locator('input[type="password"]').first().fill(process.env.POS_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: /Reception Till 1/ }).click();
  await expect(page.getByRole('heading', { name: 'Tourist', exact: true })).toBeVisible();
}

async function ringUp(page: Page) {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await page.getByText('1 Hour Play', { exact: true }).click();
  await page.getByRole('button', { name: 'Add one Kids', exact: true }).click();
  await page.getByRole('button', { name: 'Add one Adults', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
  for (const digit of '898010001') await page.getByRole('button', { name: digit, exact: true }).last().click();
  await page.getByTestId('input-done').click();
  const written = page.waitForResponse(r => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^Pay ฿/ }).click();
  const response = await written;
  expect(response.status()).toBe(200);
  const { sale } = await response.json();
  expect(sale.status).toBe('tendering');
  return sale.id as string;
}

async function fits(page: Page) {
  const panel = page.getByTestId('payment-step');
  await expect(panel).toBeVisible();
  // Wait for the entrance animation before reading real pixel positions.
  await expect.poll(() => panel.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
  const measurements = await panel.evaluate(el => {
    const controls = [el, ...el.querySelectorAll('button, input, h2, h3')];
    return controls.map(node => {
      const box = node.getBoundingClientRect();
      return { label: node.tagName, left: box.left, right: box.right, width: box.width, scroll: node.scrollWidth, client: node.clientWidth };
    });
  });
  for (const box of measurements) {
    expect(box.left, `${box.label} left`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${box.label} right`).toBeLessThanOrEqual(375);
    expect(box.scroll, `${box.label} content`).toBeLessThanOrEqual(box.client + 1);
  }
  return panel;
}

test('375 px payment fits; Pay → Back → Cancel voids the sale and reload leaves none', async ({ page }, testInfo) => {
  try {
    await signIn(page);
    const saleId = await ringUp(page);
    await page.getByRole('heading', { name: 'Cash', exact: true }).click();
    const panel = await fits(page);
    await expect(panel.getByRole('button', { name: 'Confirm Payment Received', exact: true })).toBeEnabled();
    for (const close of await page.locator('[toast-close]').all()) await close.click();
    await panel.getByRole('heading', { name: 'Amount Due' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: await picture(testInfo, 'phone-payment-375.png'), mask: [page.locator('input[type="password"]')] });
    await panel.getByRole('button', { name: 'Confirm Payment Received', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: await picture(testInfo, 'phone-payment-actions-375.png'), mask: [page.locator('input[type="password"]')] });
    // Back must void the rung-up charge before the cart can be edited.
    const voided = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${saleId}/void`);
    await panel.getByRole('button', { name: 'Back', exact: true }).click();
    expect((await voided).status()).toBe(200);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    const read = await page.request.get(`/api/sales/${saleId}`);
    expect(read.status()).toBe(200);
    expect((await read.json()).sale.status).toBe('voided');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Tourist', exact: true })).toBeVisible();
    await expect(page.getByTestId('payment-step')).toHaveCount(0);
    // The desktop resumer reads the same platform sale; a void must never return.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
    await expect(page.getByTestId('payment-step')).toHaveCount(0);
  } finally {
    await page.request.post('/api/auth/sign-out');
    expect((await page.request.get('/api/me')).status()).toBe(401);
  }
});

test('a refused phone Back keeps the payment and offers the refusal', async ({ page }) => {
  try {
    await signIn(page);
    const saleId = await ringUp(page);
    await page.route(`**/api/sales/${saleId}/void`, route => route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SALE_HAS_PAYMENTS', message: 'Money has been taken for this sale' } }) }));
    const panel = page.getByTestId('payment-step');
    const refused = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${saleId}/void`);
    await panel.getByRole('button', { name: 'Back', exact: true }).click();
    expect((await refused).status()).toBe(409);
    await expect(page.getByText('Money has been taken for this sale', { exact: true })).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Amount Due', exact: true })).toBeVisible();
    const retained = await page.request.get(`/api/sales/${saleId}`);
    expect((await retained.json()).sale.status).toBe('tendering');
    await page.unroute(`**/api/sales/${saleId}/void`);
    const voided = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sales/${saleId}/void`);
    await panel.getByRole('button', { name: 'Back', exact: true }).click();
    expect((await voided).status()).toBe(200);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Tourist', exact: true })).toBeVisible();
  } finally {
    await page.request.post('/api/auth/sign-out');
    expect((await page.request.get('/api/me')).status()).toBe(401);
  }
});
