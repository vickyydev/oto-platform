import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-859 — THE CUSTOMER'S PAYMENT SCREEN SHOWS THE FULL ORDER.
 *
 * The owner (8 and 12 November): "The customer-facing payment screen should
 * show the full order details, not just the final amount." A ticket sale and
 * an F&B order, each walked to the payment step on the split view: the
 * customer half lists the order's lines and its total beside "Please pay" or
 * "Amount to pay", and beside the QR with its timer once one is shown. The
 * amount is the figure the staff half charges.
 *
 * Runs on the isolated harness with the simulated gateway for the QR:
 * `PAYMENTS_SIMULATOR=on pnpm --filter @oto/pos e2e e2e/payment-order-lines.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
  test.skip(process.env.PAYMENTS_SIMULATOR !== 'on', 'Set PAYMENTS_SIMULATOR=on: the QR comes from the simulated gateway');
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
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

/** Step one of the order panel's steppers to `target`. */
async function stepTo(panel: Locator, label: 'Kids' | 'Adults', target: number): Promise<void> {
  const add = panel.getByRole('button', { name: `Add one ${label}` }).first();
  const remove = panel.getByRole('button', { name: `Remove one ${label}` }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 6; i += 1) {
    const now = Number(await value.textContent());
    if (now === target) return;
    await (now < target ? add : remove).click();
  }
  await expect(value).toHaveText(String(target));
}

/** The customer half's payment frame: its lines, its total row and its amount block. */
function customerPayment(page: Page) {
  const frame = page.getByTestId('customer-payment');
  return {
    frame,
    lines: frame.getByTestId('payment-order-lines'),
    summary: frame.getByTestId('payment-order-summary'),
    amount: frame.getByTestId('payment-amount'),
  };
}

/** The amount block, the first line and the total row are all on the screen at once: nothing is pushed off. */
async function allOnScreen(customer: ReturnType<typeof customerPayment>): Promise<void> {
  await expect(customer.amount).toBeInViewport();
  await expect(customer.summary).toBeInViewport();
  await expect(customer.lines.locator('> *').first()).toBeInViewport();
}

/** The staff half's QR is shown, cancelled, and the sale closed with cash. */
async function showQr(page: Page, customer: ReturnType<typeof customerPayment>): Promise<void> {
  await page.getByRole('button', { name: 'Show payment QR', exact: true }).click();
  await expect(customer.amount.getByTestId('payment-qr')).toBeVisible({ timeout: 20_000 });
  await expect(customer.amount.getByTestId('payment-qr-countdown')).toBeVisible();
  await expect(customer.amount.getByRole('heading', { name: 'Scan to Pay', exact: true })).toBeVisible();
  await expect(customer.amount.getByTestId('payment-qr')).toBeInViewport();
}

test.describe.configure({ mode: 'serial' });

test('ticket sale: the customer half lists the order beside "Please pay", then beside the QR', async ({ page }) => {
  requireFixture();
  await signIn(page);
  await walkInByPhone(page, '812076859');
  await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await page.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
  const order = page.getByRole('heading', { name: 'Current Order' }).locator('../..');
  await stepTo(order, 'Kids', 2);
  await stepTo(order, 'Adults', 1);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  await expect(payButton).toBeEnabled({ timeout: 20_000 });
  const due = ((await payButton.textContent()) ?? '').replace(/^Pay ฿/, '').replace(/,/g, '').trim();
  await payButton.click();
  // A walk-in hands the display over for a phone number; Done hands it back.
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible().catch(() => false)) await done.click();
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 15_000 });

  // Cash: "Please pay" the charged amount, with the order's lines and total beside it.
  await page.getByRole('heading', { name: 'Cash', exact: true }).click();
  const customer = customerPayment(page);
  await expect(customer.frame).toBeVisible({ timeout: 15_000 });
  await expect(customer.lines.getByText('1 Hour Play', { exact: true })).toBeVisible();
  await expect(customer.lines.getByText(/^Kids/)).toBeVisible();
  await expect(customer.summary.getByText('Total', { exact: true })).toBeVisible();
  await expect(customer.summary.getByText(`฿${Number(due)}`, { exact: true })).toBeVisible();
  await expect(customer.amount.getByText('Please pay', { exact: true })).toBeVisible();
  await expect(customer.amount.getByText(`฿${Number(due).toFixed(2)}`, { exact: true })).toBeVisible();
  await expect(customer.amount.getByText(/^Paying by/)).toBeVisible();
  await allOnScreen(customer);
  await shot(page, 'split-ticket-cash');

  // QR: the code and its timer, the order still beside them.
  await page.getByRole('heading', { name: /QR|PromptPay/ }).first().click();
  await showQr(page, customer);
  await expect(customer.amount.getByText(`฿${Number(due).toFixed(2)}`, { exact: true })).toBeVisible();
  await expect(customer.lines.getByText('1 Hour Play', { exact: true })).toBeVisible();
  await allOnScreen(customer);
  await shot(page, 'split-ticket-qr');

  // Back out of the QR; cash closes the sale.
  await page.getByTestId('payment-cancel-qr').click();
  await expect(page.getByRole('heading', { name: 'Select Payment Method' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('heading', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({ timeout: 20_000 });
});

test('F&B order: the customer half lists the order beside "Amount to pay", then beside the QR', async ({ page }) => {
  requireFixture();
  await signIn(page);
  await page.getByRole('button', { name: 'F&B', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scan Wristband', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
  await page.getByPlaceholder('Search dish…').fill('French Fries');
  await page.getByRole('button', { name: /French Fries/ }).click();
  const options = page.getByRole('dialog');
  await options.getByRole('button', { name: /Cheese sauce/ }).click();
  await options.getByRole('button', { name: 'Add one French Fries', exact: true }).click();
  await options.getByPlaceholder('e.g. no pickles, extra crispy').fill('ZZ TEST no salt');
  await options.getByRole('button', { name: /^Add to order/ }).click();
  const charge = page.getByRole('button', { name: /^Charge ฿/ });
  await expect(charge).toBeEnabled({ timeout: 20_000 });
  const total = ((await charge.textContent()) ?? '').replace(/^Charge ฿/, '').replace(/,/g, '').trim();
  await charge.click();
  const pickup = page.getByRole('dialog', { name: 'Pick-up Code', exact: true });
  await pickup.getByRole('button', { name: '8', exact: true }).click();
  await pickup.getByRole('button', { name: '5', exact: true }).click();
  await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();

  // Cash: "Amount to pay" with the order's lines, options, note and total beside it.
  await page.getByRole('button', { name: /^Cash / }).click();
  const customer = customerPayment(page);
  await expect(customer.frame).toBeVisible({ timeout: 15_000 });
  await expect(customer.lines.getByTestId('fnb-display-line')).toHaveCount(1);
  await expect(customer.lines.getByText('French Fries', { exact: true })).toBeVisible();
  await expect(customer.lines.getByText('Cheese sauce', { exact: true })).toBeVisible();
  await expect(customer.lines.getByText('ZZ TEST no salt', { exact: true })).toBeVisible();
  await expect(customer.summary.getByText('Total', { exact: true })).toBeVisible();
  await expect(customer.summary.getByText(`฿${Number(total)}`, { exact: true })).toBeVisible();
  await expect(customer.amount.getByText('Amount to pay', { exact: true })).toBeVisible();
  await expect(customer.amount.getByText(`฿${Number(total)}`, { exact: true })).toBeVisible();
  await allOnScreen(customer);
  await shot(page, 'split-fnb-cash');

  // QR: the code and its timer, the order still beside them.
  await page.getByRole('button', { name: /Customer scans to pay/ }).click();
  await showQr(page, customer);
  await expect(customer.amount.getByText(`฿${Number(total)}`, { exact: true })).toBeVisible();
  await expect(customer.lines.getByText('French Fries', { exact: true })).toBeVisible();
  await allOnScreen(customer);
  await shot(page, 'split-fnb-qr');

  // Back out of the QR; cash closes the order.
  await page.getByTestId('payment-cancel-qr').click();
  await page.getByRole('button', { name: /^Cash / }).click();
  await page.getByLabel('Cash received', { exact: true }).fill((Number(total) + 10).toFixed(2));
  await page.getByRole('button', { name: 'Record cash', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Order Confirmed', exact: true })).toBeVisible({ timeout: 20_000 });
});
