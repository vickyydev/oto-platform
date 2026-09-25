import { expect, test, type Page } from '@playwright/test';

/**
 * THE LUCKY WHEEL VOUCHER AT THE TICKET TILL — the closing audit's till findings
 * (docs/progress/plans/booth/AUDIT-CLOSING-2026-09-25.md):
 *
 *   C1   a voucher on a sale rung up and then left (here: the padlock) is
 *        offered back — the refusal shows the unpaid sale and voids it only when
 *        staff press "Void that unpaid sale and use the voucher here";
 *   M12  a second screen at the same till never voids the first screen's sale
 *        by itself, while that screen is taking cash for it;
 *   L38  a sale that owes nothing asks for no payment method;
 *   C2   a voucher that is itself the gift — a free item, or a hand-over prize —
 *        is a sale on its own.
 *
 * WHAT IT NEEDS, from the environment and never written here:
 *
 *   POS_E2E_PHONE, POS_E2E_PASSWORD   a reception account that can void sales
 *                                     (`pos:sale:void`) at a till station;
 *   POS_E2E_VOUCHERS                  comma-separated codes of issued, unheld
 *                                     vouchers that take money off a ticket
 *                                     order (a "150 THB Voucher"): C1 uses one,
 *                                     M12 another;
 *   POS_E2E_GIFT_VOUCHERS             comma-separated codes of issued, unheld
 *                                     vouchers of a gift kind the ticket till
 *                                     hands over — a free ticket extra or shop
 *                                     item, or a hand-over prize.
 *
 * Codes come from a booth's slips, or from rows put into a local database. A
 * code is used up by a passing run, so each run takes fresh ones. A test whose
 * inputs are missing is skipped and says which. It runs against the same stack
 * as `smoke.spec.ts`: the api on API_PORT, the till on the Vite proxy.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const codesOf = (name: string): string[] =>
  (process.env[name] ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
const VOUCHERS = codesOf('POS_E2E_VOUCHERS');
const GIFTS = codesOf('POS_E2E_GIFT_VOUCHERS');
const SIGN_IN_MISSING = 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account) to run it';

async function pickStationIfAsked(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Which station are you on?' });
  const asked = await heading
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!asked) return;
  await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
  await expect(heading).toBeHidden({ timeout: 15_000 });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await pickStationIfAsked(page);
  await expect(page.getByText('Membership Check')).toBeVisible({ timeout: 15_000 });
}

/** A walk-in at the tourist rate, with one "1 Hour Play" line when `ticket` is set. */
async function walkIn(page: Page, { ticket }: { ticket: boolean }): Promise<void> {
  await page.getByRole('button', { name: 'Skip — walk-in (Tourist)' }).click();
  await page.getByRole('heading', { name: 'Tourist' }).click();
  if (!ticket) return;
  await page.getByRole('heading', { name: '1 Hour Play' }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

async function typeVoucher(page: Page, code: string): Promise<void> {
  const field = page.getByLabel('Redeem voucher');
  await field.fill(code);
  await field.press('Enter');
}

/** Pay, then the display's Done for a walk-in, to the payment screen. */
async function pay(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Pay ฿/ }).click();
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible({ timeout: 3_000 }).catch(() => false)) await done.click();
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('This order is recorded, unpaid.')).toBeVisible({ timeout: 15_000 });
}

async function payCash(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'Cash' }).click();
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({
    timeout: 20_000,
  });
}

test('C1 — a voucher left on an unpaid sale is voided by choice and used on a new sale', async ({
  page,
}) => {
  test.skip(!PHONE || !PASSWORD, SIGN_IN_MISSING);
  test.skip(VOUCHERS.length < 1, 'Set POS_E2E_VOUCHERS to one or more money-off voucher codes');
  const code = VOUCHERS[0]!;
  await signIn(page);

  // Rung up with the voucher, then the till is left: the padlock, mid-payment.
  await walkIn(page, { ticket: true });
  await typeVoucher(page, code);
  await expect(page.getByTestId('voucher-card')).toBeVisible({ timeout: 15_000 });
  await pay(page);
  await page.getByLabel('Lock screen').click();
  await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByText('Membership Check')).toBeVisible({ timeout: 15_000 });

  // The family's next sale: the slip is refused, and the unpaid sale is offered.
  await walkIn(page, { ticket: true });
  await typeVoucher(page, code);
  const refusal = page.getByTestId('voucher-refusal');
  await expect(refusal).toContainText('pay or void that sale first', { timeout: 15_000 });
  await expect(page.getByTestId('rung-up-sale')).toContainText('Unpaid sale');
  // Nothing is voided until staff choose it.
  await expect(page.getByTestId('voucher-card')).toBeHidden();
  await page.getByRole('button', { name: 'Void that unpaid sale and use the voucher here' }).click();
  await expect(page.getByTestId('voucher-card')).toBeVisible({ timeout: 15_000 });
  await expect(refusal).toBeHidden();

  await pay(page);
  await payCash(page);
  await expect(page.getByTestId('voucher-used')).toContainText(code);

  // Used once: the slip is refused on the next sale.
  await page.getByRole('button', { name: 'Start New Sale' }).click();
  await walkIn(page, { ticket: true });
  await typeVoucher(page, code);
  await expect(page.getByTestId('voucher-refusal')).toContainText('Already redeemed', {
    timeout: 15_000,
  });
});

test("M12 — a second screen at the same till never voids the first screen's sale by itself", async ({
  context,
}) => {
  test.skip(!PHONE || !PASSWORD, SIGN_IN_MISSING);
  test.skip(VOUCHERS.length < 2, 'Set POS_E2E_VOUCHERS to two or more money-off voucher codes');
  const code = VOUCHERS[1]!;
  // Two screens of one session at one till.
  const first = await context.newPage();
  await signIn(first);
  const second = await context.newPage();
  await second.goto('/');
  await pickStationIfAsked(second);
  await expect(second.getByText('Membership Check')).toBeVisible({ timeout: 15_000 });

  // The second screen holds the voucher; the first takes it over, rings it up
  // and has cash chosen when the second presses Pay.
  await walkIn(second, { ticket: true });
  await typeVoucher(second, code);
  await expect(second.getByTestId('voucher-card')).toBeVisible({ timeout: 15_000 });
  await walkIn(first, { ticket: true });
  await typeVoucher(first, code);
  await expect(first.getByTestId('voucher-card')).toBeVisible({ timeout: 15_000 });
  await pay(first);
  await first.getByRole('heading', { name: 'Cash' }).click();

  await second.getByRole('button', { name: /^Pay ฿/ }).click();
  const done = second.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible({ timeout: 3_000 }).catch(() => false)) await done.click();
  await expect(second.getByText('This sale has not been saved.')).toBeVisible({ timeout: 15_000 });
  // The order changes on the second screen, and it confirms cash: the first
  // screen's sale is shown with the offer, not voided.
  await second.getByRole('button', { name: 'Add one Kids' }).first().click();
  await second.getByRole('heading', { name: 'Cash' }).click();
  await second.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await expect(second.getByTestId('rung-up-sale')).toBeVisible({ timeout: 15_000 });

  // The first screen's cash sale closes as it would have without the second.
  await first.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await expect(first.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(first.getByTestId('voucher-used')).toContainText(code);
});

test('L38 and C2 — a gift voucher on its own is a ฿0 sale that asks for no payment method', async ({
  page,
}) => {
  test.skip(!PHONE || !PASSWORD, SIGN_IN_MISSING);
  test.skip(GIFTS.length < 1, 'Set POS_E2E_GIFT_VOUCHERS to a free-item or hand-over voucher code');
  const code = GIFTS[0]!;
  await signIn(page);
  await walkIn(page, { ticket: false });
  await typeVoucher(page, code);
  await expect(page.getByTestId('voucher-free-item')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Pay ฿0' })).toBeEnabled({ timeout: 15_000 });
  await pay(page);

  // No method to choose, and the display asks for no money.
  await expect(page.getByTestId('no-payment-needed')).toBeVisible();
  await expect(page.getByText('Select Payment Method')).toBeHidden();
  await expect(page.getByTestId('customer-nothing-to-pay')).toBeVisible();
  await page.getByRole('button', { name: 'Complete Sale' }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('voucher-used')).toContainText('Hand over');
});
