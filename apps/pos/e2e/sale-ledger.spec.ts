import { expect, test, type Locator, type Page } from '@playwright/test';
import { walkInByPhone } from './walk-in';

/**
 * PAY RECORDS THE SALE; THE TENDER CLOSES IT — S2-09a (SCRUM-203).
 *
 * The one thing a unit check cannot prove: that the two presses on the
 * prototype's approved payment screen are wired to the platform's two calls.
 * This walks a walk-in ticket sale on the real till and looks at the ledger
 * BETWEEN the presses — the sale has to be there, unpaid and unnumbered, before
 * anybody confirms the money.
 *
 * Runs on the isolated harness, which owns the database and hands over the
 * reception account it re-keyed (SCRUM-369, `e2e/run.mjs`):
 * `pnpm --filter @oto/pos e2e e2e/sale-ledger.spec.ts`.
 *
 * WHICH PRESS IS "PAY". Entering the payment screen is the Pay press, and
 * since SCRUM-762 (the phone number is asked once, at the start) a walk-in
 * reaches it from either button with nothing in between: the order panel's
 * Pay, or Continue on the ticket being configured. The first test presses Pay
 * and the second Continue, and each waits for the platform's answer to THAT
 * press before it reads anything.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const STATION = /Reception Till 1/;

// The password is typed into the page; no trace, film or picture keeps it.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(150_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
}

interface LedgerSale {
  id: string;
  status: string;
  receiptNumber: string | null;
  totals: { grossSatang: number };
}
interface LedgerLine {
  label: string;
  quantity: number;
  grossSatang: number;
}
interface LedgerRead {
  sale: LedgerSale;
  lines: LedgerLine[];
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

/** The counter till opens on the membership check. */
const signInAtTheCounter = (page: Page): Promise<void> =>
  signIn(page, page.getByText('Membership Check', { exact: true }));

/** The figure on the order's Pay button — what the press is about to record. */
async function amountOnPay(page: Page): Promise<string> {
  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  await expect(payButton).toBeEnabled({ timeout: 20_000 });
  return ((await payButton.textContent()) ?? '').replace(/^Pay ฿/, '').trim();
}

/**
 * Press the button that rings the order up, and read the sale the platform
 * answered that press with. The wait is hung before the press, so the answer
 * is this press's and never an earlier one.
 */
async function ringUpWith(page: Page, press: Locator): Promise<LedgerSale> {
  const written = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await press.click();
  const response = await written;
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { sale: LedgerSale }).sale;
}

async function readSale(page: Page, id: string): Promise<LedgerRead> {
  const res = await page.request.get(`/api/sales/${id}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as LedgerRead;
}

async function listSales(page: Page): Promise<LedgerSale[]> {
  const res = await page.request.get('/api/sales?limit=50');
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { sales: LedgerSale[] }).sales;
}

/** The ledger's lines as [label, quantity], and that they add up to the sale's total. */
function expectLines(read: LedgerRead, lines: Array<[string, number]>): void {
  expect(read.lines.map((l) => [l.label, l.quantity])).toEqual(expect.arrayContaining(lines));
  expect(read.lines.reduce((sum, l) => sum + l.grossSatang, 0)).toBe(read.sale.totals.grossSatang);
}

/**
 * THE SALE AS THE LEDGER HOLDS IT BETWEEN THE PRESSES: listed, unpaid, with no
 * receipt number, at the figure the till showed, with the order's lines.
 */
async function expectRecordedUnpaid(
  page: Page,
  id: string,
  due: string,
  lines: Array<[string, number]>,
): Promise<LedgerRead> {
  const listed = (await listSales(page)).find((s) => s.id === id);
  expect(listed, 'the sale the press rang up is in the ledger').toBeTruthy();
  expect(listed!.status).toBe('tendering');
  expect(listed!.receiptNumber).toBeNull();
  expect(listed!.totals.grossSatang).toBe(satangOf(due));
  const read = await readSale(page, id);
  expect(read.sale.status).toBe('tendering');
  expectLines(read, lines);
  return read;
}

/**
 * THE PAYMENT SCREEN, WITH THE SALE ON THE PLATFORM AND THE MONEY NOT.
 *
 * This used to be read off a quiet line, "This order is recorded, unpaid.".
 * SCRUM-206 (0468c38c7, real tender collection) took that line off the payment
 * screen: its notice slot now speaks only when a write has failed. What says
 * "recorded, not paid" today is the screen itself — the payment step with its
 * amount due and no failure panel on it — over a sale the platform holds as
 * `tendering`, which every caller reads from the ledger next.
 */
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

/** Void a sale through the route the till's Cancel calls, as the signed-in account. */
async function voidSale(page: Page, id: string): Promise<void> {
  const status = await page.evaluate(async (saleId) => {
    const res = await fetch(`/api/sales/${saleId}/void`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': `s782-void-${saleId}` },
      body: JSON.stringify({ reason: 'ZZ TEST end-to-end clean-up' }),
    });
    return res.status;
  }, id);
  expect(status).toBe(200);
  expect((await readSale(page, id)).sale.status).toBe('voided');
}

test('Pay records the sale unpaid; Confirm Payment Received closes it', async ({ page }) => {
  requireFixture();
  await signInAtTheCounter(page);

  // A walk-in: no member, tourist rate, one kid and one adult.
  await walkInByPhone(page, '812076201');
  await page.getByRole('heading', { name: 'Tourist' }).click();
  await page.getByRole('heading', { name: '1 Hour Play' }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });

  // The order panel's own figure — what Pay is about to record.
  const due = await amountOnPay(page);
  const rungUp = await ringUpWith(page, page.getByRole('button', { name: /^Pay ฿/ }));
  expect(rungUp.status).toBe('tendering');

  // THE PAYMENT SCREEN. The sale is already on the platform, not yet paid for.
  await expectPaymentScreen(page);

  // Read the ledger while the money is still on the counter.
  const open = await expectRecordedUnpaid(page, rungUp.id, due, [
    ['Kids', 1],
    ['Adults', 1],
  ]);

  // The tender.
  await payCash(page);
  // One price, wherever a person reads one: the confirmation line shows the
  // figure the platform charged, not a second computation of it.
  await expect(page.getByText(`฿${due}`, { exact: false }).first()).toBeVisible();

  const closed = await readSale(page, rungUp.id);
  expect(closed.sale.status).toBe('finalised');
  expect(closed.sale.receiptNumber).toBeTruthy();
  expect(closed.sale.totals.grossSatang).toBe(open.sale.totals.grossSatang);
  expectLines(closed, [
    ['Kids', 1],
    ['Adults', 1],
  ]);
});

/**
 * A CORRECTED ORDER IS A DIFFERENT SALE — and an unchanged one is not.
 *
 * The order panel stays live on the payment screen, so the cart can change
 * after Pay has recorded it. Before this, the till kept one sale number for
 * ever and the corrected cart was refused as a duplicate at every press: the
 * only way out was Cancel, discarding the order in front of the visitor.
 *
 * The other half of the fix — an UNCHANGED cart keeps its number — is the test
 * above: the sale read off the ledger after Pay is the same sale the tender
 * closes, so pressing Confirm mints nothing.
 */
test('a corrected order is sold as its own sale', async ({ page }) => {
  requireFixture();
  await signInAtTheCounter(page);
  const before = new Set((await listSales(page)).map((s) => s.id));

  await walkInByPhone(page, '812076202');
  await page.getByRole('heading', { name: 'Tourist' }).click();
  await page.getByRole('heading', { name: '2 Hours Play' }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });

  // Rung up from the ticket's own Continue this time: the other way in.
  const firstDue = await amountOnPay(page);
  const first = await ringUpWith(page, page.getByRole('button', { name: 'Continue', exact: true }));
  await expectPaymentScreen(page);
  await expectRecordedUnpaid(page, first.id, firstDue, [
    ['Kids', 1],
    ['Adults', 1],
  ]);

  // The visitor adds an adult while the money is still on the counter.
  await page.getByRole('button', { name: 'Add one Adults' }).first().click();
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible();
  await expect.poll(() => amountOnPay(page), { timeout: 20_000 }).not.toBe(firstDue);
  const correctedDue = await amountOnPay(page);

  await payCash(page);

  const added = (await listSales(page)).filter((s) => !before.has(s.id));
  const sold = added.find((s) => s.status === 'finalised');
  const abandoned = added.find((s) => s.status === 'tendering');
  expect(added).toHaveLength(2);
  // What the visitor paid is the corrected cart; the first is left recorded and
  // unpaid, which is what an order rung up and not paid for is (voiding it is
  // S2-11).
  expect(sold?.totals.grossSatang).toBe(satangOf(correctedDue));
  expect(abandoned?.totals.grossSatang).toBe(satangOf(firstDue));
  expect(abandoned?.id).toBe(first.id);
  expectLines(await readSale(page, sold!.id), [
    ['Kids', 1],
    ['Adults', 2],
  ]);

  // Nothing of this test stays open at the station: the counter till goes
  // straight back to an unpaid sale its own account left there (SCRUM-407),
  // which would put the next sign-in on this order's payment screen.
  await voidSale(page, first.id);
});

/**
 * THE HANDHELD TILL, on the same seam.
 *
 * Under 768px the POS renders `MobileShell` instead of the counter till, and
 * its sale path is its own code. It is the till reception actually carries
 * around the park, so it gets the same two presses and the same assertion
 * between them rather than a note saying it ought to behave the same.
 */
test.describe('the handheld till', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Pay records the sale unpaid; Confirm closes it', async ({ page }) => {
    requireFixture();
    // The handheld opens on the customer types, with no membership check.
    const tourist = page.getByRole('heading', { name: 'Tourist', exact: true });
    await signIn(page, tourist);

    await tourist.click();
    await page.getByRole('heading', { name: 'Full Day Pass' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    // SCRUM-762 — the visitor's number is required before a sale. The handheld
    // hands the phone over for it ("Customer is ready"), the visitor types it
    // on the keypad and presses Done, and the order comes back for Pay.
    await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
    for (const digit of '812076208') {
      await page.getByRole('button', { name: digit, exact: true }).last().click();
    }
    await page.getByTestId('input-done').click();

    const due = await amountOnPay(page);
    const rungUp = await ringUpWith(page, page.getByRole('button', { name: /^Pay ฿/ }));
    expect(rungUp.status).toBe('tendering');

    await expectPaymentScreen(page);
    await expectRecordedUnpaid(page, rungUp.id, due, [
      ['Kids', 1],
      ['Adults', 1],
    ]);

    await payCash(page);

    const closed = await readSale(page, rungUp.id);
    expect(closed.sale.status).toBe('finalised');
    expect(closed.sale.receiptNumber).toBeTruthy();
  });
});
