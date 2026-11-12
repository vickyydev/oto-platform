import { expect, test, type Page } from '@playwright/test';

/**
 * SCRUM-890 / SCRUM-891 — A PART-PAID SALE IN HISTORY, BEFORE AND AFTER ITS REFUND.
 *
 * A French Fries order is rung up at the F&B counter on the platform and only
 * ฿30 of it is taken in cash. On the real till's History screen the sale's card
 * and its detail read "Partly paid" (never "Unpaid"), and the detail's figure
 * is the balance still to pay under "Balance due", not the order's gross. A
 * whole refund then closes it, and the platform's own read of the sale says
 * `refunded` exactly as the refund's answer does (SCRUM-891), the way a whole
 * refund of a fully paid sale reads.
 *
 * Runs on the isolated harness as the seeded owner, who may refund without a
 * manager's approval: `pnpm --filter @oto/pos e2e e2e/history-part-paid-balance.spec.ts`.
 */

const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const TAKEN_SATANG = 3_000;

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
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

const key = () => `s890-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const uuid = () => crypto.randomUUID();

/** A French Fries order at this station with only part of it paid in cash. */
async function partPaidFoodSale(page: Page, baseURL: string): Promise<{ saleId: string; grossSatang: number }> {
  const headers = { origin: baseURL };
  const me = await page.request.get('/api/me', { headers });
  expect(me.status(), await me.text()).toBe(200);
  const meBody = (await me.json()) as { branch: { id: string } | null; operatorContext: { stationId: string | null } };
  const branchId = meBody.branch!.id;
  const stationId = meBody.operatorContext.stationId!;
  expect(stationId, 'the till holds a station').toBeTruthy();
  const menu = await page.request.get(`/api/branches/${branchId}/menu`, { headers });
  expect(menu.status(), await menu.text()).toBe(200);
  const fries = ((await menu.json()) as { products: Array<{ id: string; code: string | null }> }).products.find(
    (p) => p.code === 'FB-FRIES',
  );
  expect(fries, 'the branch sells French Fries').toBeTruthy();
  const saleId = uuid();
  const created = await page.request.post('/api/sales', {
    headers: { ...headers, 'idempotency-key': key() },
    data: { id: saleId, stationId, channel: 'fnb', pickupCode: '78', items: [{ id: uuid(), productId: fries!.id, quantity: 1 }] },
  });
  expect(created.status(), await created.text()).toBe(200);
  const grossSatang = ((await created.json()) as { sale: { totals: { grossSatang: number } } }).sale.totals.grossSatang;
  expect(grossSatang).toBeGreaterThan(TAKEN_SATANG);
  const part = await page.request.post(`/api/sales/${saleId}/finalise`, {
    headers: { ...headers, 'idempotency-key': key() },
    data: { method: 'cash', kind: 'cash', amountSatang: TAKEN_SATANG, tenderedSatang: TAKEN_SATANG, actionId: uuid() },
  });
  expect(part.status(), await part.text()).toBe(200);
  expect(((await part.json()) as { finalised: boolean }).finalised).toBe(false);
  return { saleId, grossSatang };
}

test('a part-paid sale reads Partly paid with its balance in History, and refunded after its whole refund', async ({ page, baseURL }) => {
  test.skip(!ADMIN_PHONE || !ADMIN_PASSWORD, 'Set POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD (an owner account)');
  await signIn(page);
  const { saleId, grossSatang } = await partPaidFoodSale(page, baseURL!);
  const balance = `฿${(grossSatang - TAKEN_SATANG) / 100}`;

  await page.goto('/history');
  await expect(page.getByLabel('Search transactions')).toBeVisible({ timeout: 20_000 });
  // The card says what the sale is: partly paid, never unpaid.
  const card = page.getByRole('button').filter({ hasText: 'No receipt number' }).filter({ hasText: 'Partly paid' }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();

  // The detail: the badge, and the balance under "Balance due" in place of the gross.
  await expect(page.getByTestId('refund-sale')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Balance due', { exact: true })).toBeVisible();
  await expect(page.getByText('Amount due', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('sale-amount-shown')).toHaveText(balance);
  await expect(page.getByTestId('refund-sale')).toHaveText(/Refund \(฿30 left\)/);

  await page.getByTestId('refund-sale').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Service recovery', exact: true }).click();
  const sent = page.waitForResponse(
    (res) => res.url().includes(`/api/sales/${saleId}/refunds`) && res.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Refund ฿30', exact: true }).click();
  const answer = await sent;
  expect(answer.status(), await answer.text()).toBe(200);
  const body = (await answer.json()) as { refundStatus: string; sale: { status: string } };
  expect(body).toMatchObject({ refundStatus: 'refunded', sale: { status: 'voided' } });

  // The sale's own read agrees with the refund's answer: one status.
  const read = await page.request.get(`/api/sales/${saleId}`, { headers: { origin: baseURL! } });
  expect(read.status(), await read.text()).toBe(200);
  expect(await read.json()).toMatchObject({ refundStatus: 'refunded', refundableSatang: 0, sale: { status: 'voided' } });
});
