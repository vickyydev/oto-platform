import { expect, test, type Page } from '@playwright/test';

/**
 * SCRUM-960 — A PART-PAID FOOD ORDER NO LONGER HOLDS THE TILL.
 *
 * On the real till's F&B counter a guest order of French Fries is charged and
 * only ฿30 of it is taken in cash. The payment screen then holds the header's
 * tabs and Back (money was taken here), and offers the ticket till's "Save as
 * partly paid". Its dialog says what becomes of the order; confirmed, the
 * counter starts afresh, the header's tabs work again, and the platform still
 * holds the order part-paid (tendering, with its balance): nothing was voided
 * or refunded.
 *
 * Runs on the isolated harness as the seeded owner:
 * `pnpm --filter @oto/pos e2e e2e/item-part-paid-exit.spec.ts`.
 */

const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';

test.use({ trace: 'off', video: 'off', screenshot: 'off', viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(ADMIN_PHONE.replace(/^\+66/, ''));
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect
    .poll(async () => (await picker.isVisible()) || (await page.getByText('Membership Check', { exact: true }).isVisible()), {
      timeout: 30_000,
    })
    .toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 30_000 });
}

test('Save as partly paid leaves the food order part-paid and frees the counter', async ({ page, baseURL }) => {
  test.skip(!ADMIN_PHONE || !ADMIN_PASSWORD, 'Set POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD (an owner account)');
  await signIn(page);

  await page.goto('/order-station');
  await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  await page.getByPlaceholder('Search dish…').fill('French Fries');
  await page.getByRole('button', { name: /French Fries/ }).first().click();
  // The seeded fries carry their options: added plain.
  await page.getByRole('dialog').getByRole('button', { name: /^Add to order/ }).click();
  await page.getByRole('button', { name: /^Charge ฿/ }).click();
  for (const digit of ['7', '8']) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: /^Continue to Payment/ }).click();

  // Before anything is paid there is nothing to save, and Back works.
  // The tender's tile ("Cash / Collect ฿90 in cash"), not the header's Cash action.
  await page.getByRole('button', { name: /^Cash\s*Collect/ }).click();
  await expect(page.getByRole('button', { name: 'Save as partly paid' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();

  // ฿30 of it in cash.
  await page.getByRole('button', { name: 'Partial payment', exact: true }).click();
  await page.getByLabel('Payment amount', { exact: true }).fill('30.00');
  await page.getByLabel('Cash received', { exact: true }).fill('30.00');
  const partial = page.waitForResponse((res) => /\/api\/sales\/[^/]+\/finalise$/.test(new URL(res.url()).pathname)
    && res.request().method() === 'POST' && res.status() === 200);
  await page.getByRole('button', { name: 'Record cash', exact: true }).click();
  const answer = await partial;
  const saleId = new URL(answer.url()).pathname.split('/')[3]!;
  const part = (await answer.json()) as { sale: { status: string }; outstandingSatang: number };
  expect(part.sale.status).toBe('tendering');
  const balanceSatang = part.outstandingSatang;
  expect(balanceSatang).toBeGreaterThan(0);

  // The hold that protects money taken here: Back shut, the header's tabs inert.
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  expect(await page.locator('[inert] nav').count()).toBe(1);

  // The way out, and what its dialog says.
  await page.getByRole('button', { name: 'Save as partly paid' }).click();
  const dialog = page.getByTestId('item-part-paid-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`฿30 paid, balance ฿${balanceSatang / 100}.`);
  await expect(dialog).toContainText('History lists it as Partly paid with its balance');
  await dialog.getByRole('button', { name: 'Save as partly paid' }).click();

  // The counter starts afresh and the header's tabs work again.
  await expect(page.getByRole('button', { name: /No wristband.*continue as guest/ })).toBeVisible({ timeout: 20_000 });
  expect(await page.locator('[inert] nav').count()).toBe(0);
  await page.getByRole('button', { name: 'Tickets', exact: true }).click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });

  // The platform still holds the order part-paid: nothing voided, nothing refunded.
  const read = await page.request.get(`/api/sales/${saleId}`, { headers: { origin: baseURL! } });
  expect(read.status(), await read.text()).toBe(200);
  expect(await read.json()).toMatchObject({ sale: { id: saleId, status: 'tendering' } });
});
