import { expect, test, type Page } from '@playwright/test';

/**
 * SCRUM-877 — A PART-PAID FOOD SALE IS REFUNDED WHOLE FROM HISTORY.
 *
 * A French Fries order is rung up at the F&B counter on the platform and
 * only ฿30 of it is taken in cash before the guest leaves: the sale stays
 * open with money on it. On the real till's History screen the sale offers
 * Refund for exactly what was taken (never Void), the refund dialog is held
 * to the whole sale, and the confirmed refund closes the sale as void with
 * the ฿30 going back as cash — after which End of Day no longer lists it as
 * part-paid.
 *
 * Runs on the isolated harness as the seeded owner, who may refund without a
 * manager's approval: `pnpm --filter @oto/pos e2e e2e/history-part-paid-refund.spec.ts`.
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

const key = () => `s877-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const uuid = () => crypto.randomUUID();

/** A French Fries order at this station with only part of it paid in cash. */
async function partPaidFoodSale(page: Page, baseURL: string): Promise<{ saleId: string; branchId: string; date: string }> {
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
    data: { id: saleId, stationId, channel: 'fnb', pickupCode: '77', items: [{ id: uuid(), productId: fries!.id, quantity: 1 }] },
  });
  expect(created.status(), await created.text()).toBe(200);
  const createdBody = (await created.json()) as { sale: { businessDate: string; totals: { grossSatang: number } } };
  expect(createdBody.sale.totals.grossSatang).toBeGreaterThan(TAKEN_SATANG);
  const part = await page.request.post(`/api/sales/${saleId}/finalise`, {
    headers: { ...headers, 'idempotency-key': key() },
    data: { method: 'cash', kind: 'cash', amountSatang: TAKEN_SATANG, tenderedSatang: TAKEN_SATANG, actionId: uuid() },
  });
  expect(part.status(), await part.text()).toBe(200);
  expect(((await part.json()) as { finalised: boolean }).finalised).toBe(false);
  return { saleId, branchId, date: createdBody.sale.businessDate };
}

async function partPaidRows(page: Page, baseURL: string, branchId: string, date: string): Promise<string[]> {
  const res = await page.request.get(`/api/branches/${branchId}/end-of-day?date=${date}`, { headers: { origin: baseURL } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { openSales?: { rows: Array<{ saleId: string; kind: string }> } };
  return (body.openSales?.rows ?? []).filter((r) => r.kind === 'part_paid').map((r) => r.saleId);
}

test('a part-paid food sale offers Refund in History, whole only, and the refund closes it', async ({ page, baseURL }) => {
  test.skip(!ADMIN_PHONE || !ADMIN_PASSWORD, 'Set POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD (an owner account)');
  await signIn(page);
  const { saleId, branchId, date } = await partPaidFoodSale(page, baseURL!);
  expect(await partPaidRows(page, baseURL!, branchId, date)).toContain(saleId);

  await page.goto('/history');
  await expect(page.getByLabel('Search transactions')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button').filter({ hasText: 'No receipt number' }).first().click();

  const refundButton = page.getByTestId('refund-sale');
  await expect(refundButton).toBeVisible({ timeout: 20_000 });
  await expect(refundButton).toBeEnabled();
  await expect(refundButton).toHaveText(/Refund \(฿30 left\)/);
  await expect(page.getByTestId('refund-part-paid-note')).toBeVisible();
  await expect(page.getByTestId('void-sale')).toHaveCount(0);

  await refundButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('refund-whole-only')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'By item', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Amount', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Service recovery', exact: true }).click();

  const sent = page.waitForResponse(
    (res) => res.url().includes(`/api/sales/${saleId}/refunds`) && res.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Refund ฿30', exact: true }).click();
  const answer = await sent;
  expect(answer.status(), await answer.text()).toBe(200);
  const body = (await answer.json()) as {
    refund: { amountSatang: number; tenderAllocation: Array<{ route: string; amountSatang: number }> };
    sale: { status: string };
  };
  expect(body.refund.amountSatang).toBe(TAKEN_SATANG);
  expect(body.refund.tenderAllocation).toEqual([expect.objectContaining({ route: 'cash', amountSatang: TAKEN_SATANG })]);
  expect(body.sale.status).toBe('voided');
  expect(JSON.parse(answer.request().postData() ?? '{}')).toMatchObject({ mode: 'whole' });

  expect(await partPaidRows(page, baseURL!, branchId, date)).not.toContain(saleId);
});
