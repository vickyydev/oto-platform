import { expect, request as playwrightRequest, test, type Page } from '@playwright/test';
import { walkInByPhone } from './walk-in';

/**
 * THE LUCKY WHEEL VOUCHER AT THE TICKET TILL — the closing audit's till findings
 * (docs/progress/plans/booth/AUDIT-CLOSING-2026-09-25.md):
 *
 *   C1   a voucher on a sale rung up and then left is offered back — the
 *        refusal shows the unpaid sale and voids it only when staff press
 *        "Void that unpaid sale and use the voucher here";
 *   M12  a second screen at the same till never voids the first screen's sale
 *        by itself, while that screen is taking cash for it;
 *   L38  a sale that owes nothing asks for no payment method;
 *   C2   a voucher that is itself the gift — a free item, or a hand-over prize —
 *        is a sale on its own.
 *
 * Runs on the isolated harness, which owns the database and hands over the
 * two accounts it re-keyed (SCRUM-369, `e2e/run.mjs`):
 * `pnpm --filter @oto/pos e2e e2e/voucher.spec.ts`.
 *
 * WHERE THE VOUCHERS COME FROM (SCRUM-782). Every test issues its own, as the
 * owner, through the routes the Console's voucher types and voucher campaigns
 * pages use: a ZZ TEST voucher type (`POST /voucher-definitions`, made once
 * per database), a ZZ TEST campaign of that type at the park
 * (`POST /voucher-campaigns`), and the campaign's codes
 * (`GET /voucher-campaigns/:id/codes`). A campaign code is a voucher like a
 * booth slip's — issued, unheld, used once — so nothing is read from the
 * environment or put into the database by hand, and a run can be repeated on
 * the same database.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const BRANCH_CODE = 'hkt-central';
const STATION = /Reception Till 1/;

// Passwords are typed into the page; no trace, film or picture keeps them.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
  test.skip(!ADMIN_PHONE || !ADMIN_PASSWORD, 'Set POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD (an owner account)');
}

/** Money off a ticket order — the booth's "150 THB Voucher", under a test name. */
const MONEY_OFF = {
  code: 'zz-test-e2e-150-off',
  nameEn: 'ZZ TEST 150 THB Voucher',
  kind: 'discount',
  valueType: 'amount',
  valueSatang: 15_000,
  costSatang: 15_000,
  expiryDays: 14,
} as const;
/** A prize staff hand over: it takes nothing off a bill and is a sale on its own. */
const HAND_OVER = {
  code: 'zz-test-e2e-hand-over',
  nameEn: 'ZZ TEST Hand-over Prize',
  kind: 'manual',
  valueType: 'none',
  costSatang: 0,
  expiryDays: 14,
} as const;

/** `quantity` fresh voucher codes of a ZZ TEST type, issued at the park as the owner. */
async function issueVouchers(
  baseURL: string,
  type: typeof MONEY_OFF | typeof HAND_OVER,
  quantity: number,
): Promise<string[]> {
  const admin = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const key = () => `s782-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const signedIn = await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    const listed = await admin.get('/api/branches');
    expect(listed.status(), await listed.text()).toBe(200);
    const branch = ((await listed.json()) as { branches: Array<{ id: string; code: string }> }).branches.find(
      (b) => b.code === BRANCH_CODE,
    )!;

    // The type is made once: its code is the operator's for good, so a second
    // test — or a repeated run — finds the one already there.
    const types = await admin.get('/api/voucher-definitions');
    expect(types.status(), await types.text()).toBe(200);
    let definition = ((await types.json()) as { definitions: Array<{ id: string; code: string }> }).definitions.find(
      (d) => d.code === type.code,
    );
    if (!definition) {
      const created = await admin.post('/api/voucher-definitions', { data: type, headers: { 'idempotency-key': key() } });
      expect(created.status(), await created.text()).toBe(201);
      definition = ((await created.json()) as { definition: { id: string; code: string } }).definition;
    }

    const minted = await admin.post('/api/voucher-campaigns', {
      data: { definitionId: definition.id, branchId: branch.id, name: `ZZ TEST e2e ${type.code}`, quantity },
      headers: { 'idempotency-key': key() },
    });
    expect(minted.status(), await minted.text()).toBe(200);
    const campaign = ((await minted.json()) as { campaign: { id: string } }).campaign;
    // The answer never carries the codes; the campaign's download does.
    const download = await admin.get(`/api/voucher-campaigns/${campaign.id}/codes`);
    expect(download.status(), await download.text()).toBe(200);
    const [header, ...rows] = (await download.text()).trim().split('\n');
    expect(header).toBe('code,status,expires_at');
    const codes = rows.map((row) => row.split(',')[0]!.trim());
    expect(codes).toHaveLength(quantity);
    for (const row of rows) expect(row.split(',')[1]).toBe('issued');
    return codes;
  } finally {
    await admin.dispose();
  }
}

/** The till, from wherever this page stands after sign-in: the station picker or the till itself. */
async function atTheTill(page: Page): Promise<void> {
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const landed = page.getByText('Membership Check', { exact: true });
  await expect
    .poll(async () => (await picker.isVisible()) || (await landed.isVisible()), { timeout: 30_000 })
    .toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: STATION }).first().click();
  await expect(landed).toBeVisible({ timeout: 30_000 });
}

/** Sign in on the lock screen this page shows. `phone` is the national number: the field supplies +66. */
async function signIn(page: Page, phone: string, password: string): Promise<void> {
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(phone);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await atTheTill(page);
}

/**
 * A walk-in at the tourist rate, with one "1 Hour Play" line open on its
 * Configure screen when `ticket` is set. Continue is NOT pressed: since
 * SCRUM-762 the number given at the start goes with the sale, so Continue
 * rings the order up at once, and a voucher goes on before that press.
 */
async function walkIn(page: Page, { ticket }: { ticket: boolean }): Promise<void> {
  await walkInByPhone(page, '812076203');
  await page.getByRole('heading', { name: 'Tourist' }).click();
  if (!ticket) return;
  await page.getByRole('heading', { name: '1 Hour Play' }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
}

async function typeVoucher(page: Page, code: string): Promise<void> {
  const field = page.getByLabel('Redeem voucher');
  await field.fill(code);
  await field.press('Enter');
}

interface RungUp {
  id: string;
  status: string;
}

/**
 * Pay, to the payment screen, with the sale the platform answered the press
 * with. That answer and the screen replace two things this helper used to
 * wait for: the display's Done, which a walk-in no longer meets (SCRUM-762 —
 * the number was given at the start), and the line "This order is recorded,
 * unpaid.", which SCRUM-206 (0468c38c7) took off the payment screen. Rung up
 * and not closed is now read from the platform: the sale is `tendering`.
 */
async function pay(page: Page): Promise<RungUp> {
  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  await expect(payButton).toBeEnabled({ timeout: 20_000 });
  const written = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await payButton.click();
  const response = await written;
  expect(response.status(), await response.text()).toBe(200);
  const { sale } = (await response.json()) as { sale: RungUp };
  expect(sale.status).toBe('tendering');
  await expect(page.getByTestId('payment-step')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible();
  return sale;
}

/**
 * Choose Cash. A method tile takes no press while the platform is still
 * pricing the voucher onto the order, so the choice waits for that price —
 * and then for the cash panel, which says the press was taken.
 */
async function chooseCash(page: Page): Promise<void> {
  await expect(page.getByText('Waiting for the voucher price...')).toHaveCount(0);
  await page.getByRole('heading', { name: 'Cash', exact: true }).click();
  await expect(page.locator('#payment-cash-received')).toBeVisible();
}

async function payCash(page: Page): Promise<void> {
  await chooseCash(page);
  await page.getByRole('button', { name: 'Confirm Payment Received', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({ timeout: 20_000 });
}

/** A sale as the platform holds it now. */
async function statusOf(page: Page, saleId: string): Promise<string> {
  const res = await page.request.get(`/api/sales/${saleId}`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { sale: { status: string } }).sale.status;
}

/**
 * HOW THE SALE IS "LEFT" TODAY. This test used to press the padlock and
 * unlock onto an empty till. Since then a staff lock draws over the till and
 * keeps its sale (ce0358ad3, SCRUM-206; pinned by SCRUM-407, 0d8e13b13), and
 * an unpaid sale the same account rang up at the same till is put straight
 * back on its payment screen when the till opens again (SCRUM-693,
 * d9cfb04da) — so neither the padlock nor a reload meets the refusal any
 * more. Who does meet it is the next person at the till: reception rings the
 * sale up, signs out and hands the till over mid-payment, and the owner
 * serves the family when they come back with the same slip.
 */
test('C1 — a voucher left on an unpaid sale is voided by choice and used on a new sale', async ({ page, baseURL }) => {
  requireFixture();
  const [code] = await issueVouchers(baseURL!, MONEY_OFF, 1);
  await page.goto('/');
  await signIn(page, PHONE, PASSWORD);

  // Rung up with the voucher, then the till is handed over, mid-payment.
  await walkIn(page, { ticket: true });
  await typeVoucher(page, code!);
  await expect(page.getByTestId('voucher-card')).toBeVisible({ timeout: 15_000 });
  const left = await pay(page);
  await page.getByLabel('Lock screen').click();
  await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Sign out and hand over the till/ }).click();
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
  await signIn(page, ADMIN_PHONE.replace(/^\+66/, ''), ADMIN_PASSWORD);

  // The family's next sale: the slip is refused, and the unpaid sale is offered.
  await walkIn(page, { ticket: true });
  await typeVoucher(page, code!);
  const refusal = page.getByTestId('voucher-refusal');
  await expect(refusal).toContainText('pay or void that sale first', { timeout: 15_000 });
  // Inside the refusal: the till lists the same sale again in its own
  // left-unpaid notice (SCRUM-407), which this test never presses.
  await expect(refusal.getByTestId('rung-up-sale')).toContainText('Unpaid sale');
  // Nothing is voided until staff choose it.
  await expect(page.getByTestId('voucher-card')).toBeHidden();
  expect(await statusOf(page, left.id)).toBe('tendering');
  await page.getByRole('button', { name: 'Void that unpaid sale and use the voucher here' }).click();
  await expect(page.getByTestId('voucher-card')).toBeVisible({ timeout: 15_000 });
  await expect(refusal).toBeHidden();
  expect(await statusOf(page, left.id)).toBe('voided');

  const sold = await pay(page);
  expect(sold.id).not.toBe(left.id);
  await payCash(page);
  await expect(page.getByTestId('voucher-used')).toContainText(code!);
  expect(await statusOf(page, sold.id)).toBe('finalised');

  // Used once: the slip is refused on the next sale.
  await page.getByRole('button', { name: 'Start New Sale' }).click();
  await walkIn(page, { ticket: true });
  await typeVoucher(page, code!);
  await expect(page.getByTestId('voucher-refusal')).toContainText('Already redeemed', {
    timeout: 15_000,
  });
});

test("M12 — a second screen at the same till never voids the first screen's sale by itself", async ({
  context,
  baseURL,
}) => {
  requireFixture();
  const [code] = await issueVouchers(baseURL!, MONEY_OFF, 1);
  // Two screens of one session at one till.
  const first = await context.newPage();
  await first.goto('/');
  await signIn(first, PHONE, PASSWORD);
  const second = await context.newPage();
  await second.goto('/');
  await atTheTill(second);

  // The second screen holds the voucher; the first takes it over, rings it up
  // and has cash chosen when the second presses Pay.
  await walkIn(second, { ticket: true });
  await typeVoucher(second, code!);
  await expect(second.getByTestId('voucher-card')).toBeVisible({ timeout: 15_000 });
  await walkIn(first, { ticket: true });
  await typeVoucher(first, code!);
  await expect(first.getByTestId('voucher-card')).toBeVisible({ timeout: 15_000 });
  const taking = await pay(first);
  await chooseCash(first);

  await second.getByRole('button', { name: /^Pay ฿/ }).click();
  await expect(second.getByText('This sale has not been saved.')).toBeVisible({ timeout: 15_000 });
  // The order changes on the second screen. Once the platform has priced the
  // corrected order the till tries to ring it up, and the voucher cannot
  // follow: the first screen's sale is shown with the offer, not voided.
  await second.getByRole('button', { name: 'Add one Kids' }).first().click();
  const offer = second.getByTestId('voucher-refusal').getByTestId('rung-up-sale');
  await expect(offer).toBeVisible({ timeout: 15_000 });
  expect(await statusOf(second, taking.id)).toBe('tendering');
  // And it confirms cash — the press that used to void the other screen's
  // sale. The voucher is asked for again, refused again, and nothing is voided.
  await chooseCash(second);
  const askedAgain = second.waitForResponse(
    (r) => /^\/api\/sales\/[^/]+\/vouchers$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await second.getByRole('button', { name: 'Confirm Payment Received', exact: true }).click();
  expect((await askedAgain).status()).toBe(409);
  await expect(second.getByText('Resolve the voucher before taking payment.')).toBeVisible({ timeout: 15_000 });
  await expect(offer).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Payment Successful' })).toHaveCount(0);
  expect(await statusOf(second, taking.id)).toBe('tendering');

  // The first screen's cash sale closes as it would have without the second.
  await first.getByRole('button', { name: 'Confirm Payment Received', exact: true }).click();
  await expect(first.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({ timeout: 20_000 });
  await expect(first.getByTestId('voucher-used')).toContainText(code!);
  expect(await statusOf(first, taking.id)).toBe('finalised');
});

test('L38 and C2 — a gift voucher on its own is a ฿0 sale that asks for no payment method', async ({
  page,
  baseURL,
}) => {
  requireFixture();
  const [code] = await issueVouchers(baseURL!, HAND_OVER, 1);
  await page.goto('/');
  await signIn(page, PHONE, PASSWORD);
  await walkIn(page, { ticket: false });
  await typeVoucher(page, code!);
  await expect(page.getByTestId('voucher-free-item')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Pay ฿0' })).toBeEnabled({ timeout: 15_000 });
  const gift = await pay(page);

  // No method to choose, and the display asks for no money.
  await expect(page.getByTestId('no-payment-needed')).toBeVisible();
  await expect(page.getByText('Select Payment Method')).toBeHidden();
  await expect(page.getByTestId('customer-nothing-to-pay')).toBeVisible();
  await page.getByRole('button', { name: 'Complete Sale' }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('voucher-used')).toContainText('Hand over');
  await expect(page.getByTestId('voucher-used')).toContainText(code!);
  expect(await statusOf(page, gift.id)).toBe('finalised');
});
