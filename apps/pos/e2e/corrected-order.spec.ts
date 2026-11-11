import { expect, test, type Locator, type Page } from '@playwright/test';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-865 — A CORRECTED ORDER AFTER PAY REPLACES THE FIRST ONE.
 *
 * The ordinary slip at the counter: the Thai rate is confirmed, a ticket is
 * rung up, the family changes their mind on the payment screen, staff press
 * Back, change the children, press Pay again and take the cash. Before this
 * the first sale stayed on the platform unpaid, holding the approval, so the
 * second Pay was refused "already been used on a sale" with no way forward
 * but Cancel; after a reload the orphan came back on the next customer's
 * payment screen; History kept an Unpaid row.
 *
 * Now the till voids the first sale ("Order changed at the till after Pay")
 * before the corrected cart is rung up, the void gives the approval back, and
 * the corrected sale is priced and closed at the Thai rate. This walks that
 * on the real till against the isolated harness (`e2e/run.mjs`):
 * `pnpm --filter @oto/pos e2e e2e/corrected-order.spec.ts`.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const STATION = /Reception Till 1/;

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
}

interface LedgerSale {
  id: string;
  status: string;
  receiptNumber: string | null;
  customerTier: string;
  totals: { grossSatang: number };
}

/** "฿1,240" as the Pay button says it, in satang. */
const satangOf = (baht: string): number => Math.round(Number(baht.replace(/,/g, '')) * 100);

async function signIn(page: Page, landed: Locator): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect
    .poll(async () => (await picker.isVisible()) || (await landed.isVisible()), { timeout: 30_000 })
    .toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: STATION }).first().click();
  await expect(landed).toBeVisible({ timeout: 30_000 });
}

/** The figure on the order's Pay button — what the press is about to record. */
async function amountOnPay(page: Page): Promise<string> {
  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  await expect(payButton).toBeEnabled({ timeout: 20_000 });
  return ((await payButton.textContent()) ?? '').replace(/^Pay ฿/, '').trim();
}

/** Press Pay, and read the sale the platform answered that press with. */
async function ringUp(page: Page): Promise<LedgerSale> {
  const written = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: /^Pay ฿/ }).click();
  const response = await written;
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { sale: LedgerSale }).sale;
}

async function readSale(page: Page, id: string): Promise<LedgerSale> {
  const res = await page.request.get(`/api/sales/${id}`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { sale: LedgerSale }).sale;
}

async function listSales(page: Page): Promise<LedgerSale[]> {
  const res = await page.request.get('/api/sales?limit=50');
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { sales: LedgerSale[] }).sales;
}

async function expectPaymentScreen(page: Page): Promise<void> {
  await expect(page.getByTestId('payment-step')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible();
  await expect(page.getByText('This sale has not been saved.')).toHaveCount(0);
}

async function payCash(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Payment Received', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({ timeout: 20_000 });
}

test('Thai confirm → Pay → Back → change kids → Pay → cash: sold at the Thai rate, nothing left unpaid', async ({ page }) => {
  requireFixture();
  await signIn(page, page.getByText('Membership Check', { exact: true }));
  const before = new Set((await listSales(page)).map((s) => s.id));

  // A walk-in, confirmed Thai by hand (SCRUM-772): the two-button modal.
  await walkInByPhone(page, '812076209');
  await page.getByRole('heading', { name: 'Thai', exact: true }).click();
  const approved = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sales/tier-approvals' && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: 'Confirm Thai rate', exact: true }).click();
  expect((await approved).status()).toBe(200);

  await page.getByRole('heading', { name: '2 Hours Play' }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });

  // Pay: a rate verified for a walk-in needs a name before it can be saved to
  // a profile, so the details step opens (SCRUM-762) and the family types a
  // nickname on their display; Done rings the first sale up at the Thai rate.
  const firstDue = await amountOnPay(page);
  await page.getByRole('button', { name: /^Pay ฿/ }).click();
  await expect(page.getByRole('heading', { name: 'Customer Details', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('e.g. Mama, John').last().fill('ZZ TEST corrected order');
  const firstWritten = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await page.getByTestId('input-done').click();
  const firstResponse = await firstWritten;
  expect(firstResponse.status(), await firstResponse.text()).toBe(200);
  const first = ((await firstResponse.json()) as { sale: LedgerSale }).sale;
  expect(first.status).toBe('tendering');
  expect(first.customerTier).toBe('thai');
  await expectPaymentScreen(page);

  // Back to the details, Back to the order, one more child.
  await page.getByTestId('payment-step').getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customer Details', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customer Details', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add one Kids', exact: true }).first().click();
  await expect.poll(() => amountOnPay(page), { timeout: 20_000 }).not.toBe(firstDue);
  const correctedDue = await amountOnPay(page);

  // Pay again: the first sale is voided before the corrected one is rung up,
  // and the corrected one is priced at the Thai rate on the same approval.
  const voided = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/sales/${first.id}/void` && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  const second = await ringUp(page);
  expect((await voided).status()).toBe(200);
  expect(second.id).not.toBe(first.id);
  expect(second.status).toBe('tendering');
  expect(second.customerTier).toBe('thai');
  expect(second.totals.grossSatang).toBe(satangOf(correctedDue));
  await expectPaymentScreen(page);
  await expect(page.getByText('The discounted rate has gone')).toHaveCount(0);

  await payCash(page);

  const closed = await readSale(page, second.id);
  expect(closed.status).toBe('finalised');
  expect(closed.receiptNumber).toBeTruthy();
  expect(closed.customerTier).toBe('thai');
  expect((await readSale(page, first.id)).status).toBe('voided');
  const added = (await listSales(page)).filter((s) => !before.has(s.id));
  expect(added.map((s) => s.status).sort()).toEqual(['finalised', 'voided']);

  // History: the sold receipt is there, and no row says Unpaid.
  await page.getByRole('button', { name: 'Start New Sale' }).click();
  await page.getByRole('button', { name: 'History', exact: true }).first().click();
  await expect(page.getByText(closed.receiptNumber!, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Unpaid', { exact: true })).toHaveCount(0);
});
