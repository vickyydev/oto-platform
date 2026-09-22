import { expect, test, type Page } from '@playwright/test';

/**
 * PAY RECORDS THE SALE; THE TENDER CLOSES IT — S2-09a (SCRUM-203).
 *
 * The one thing a unit check cannot prove: that the two presses on the
 * prototype's approved payment screen are wired to the platform's two calls.
 * This walks a walk-in ticket sale on the real till and looks at the ledger
 * BETWEEN the presses — the sale has to be there, unpaid and unnumbered, before
 * anybody confirms the money.
 *
 * It runs against the same stack as `smoke.spec.ts`: a seeded database, the api
 * on API_PORT, the till on the Vite proxy.
 */

async function pickStationIfAsked(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Which station are you on?' });
  const asked = await heading
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!asked) return;
  await page.getByRole('button', { name: /Reception Till 1|Counter/ }).first().click();
  await expect(heading).toBeHidden({ timeout: 15_000 });
}

test('Pay records the sale unpaid; Confirm Payment Received closes it', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill('0900000002');
  await page.locator('input[type="password"]').fill('reception1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await pickStationIfAsked(page);
  await expect(page.getByText('Membership Check')).toBeVisible({ timeout: 15_000 });

  // A walk-in: no member, tourist rate, one kid and one adult.
  await page.getByRole('button', { name: 'Skip — walk-in (Tourist)' }).click();
  await page.getByRole('heading', { name: 'Tourist' }).click();
  await page.getByRole('heading', { name: '1 Hour Play' }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  // The order panel's own figure — what Pay is about to record.
  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  await expect(payButton).toBeVisible();
  const payLabel = (await payButton.textContent()) ?? '';
  const due = payLabel.replace(/^Pay ฿/, '').trim();
  await payButton.click();

  // A walk-in hands the display over for a phone number; Done returns it.
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible().catch(() => false)) await done.click();

  // THE PAYMENT SCREEN. The sale is already on the platform, and the screen
  // says so — recorded, and not yet paid for.
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('This order is recorded, unpaid.')).toBeVisible({ timeout: 15_000 });

  // Read the ledger while the money is still on the counter.
  const beforeTender = await page.request.get(`/api/sales?limit=5`);
  expect(beforeTender.ok()).toBeTruthy();
  const openSales = (await beforeTender.json()) as {
    sales: { id: string; status: string; receiptNumber: string | null; totals: { grossSatang: number } }[];
  };
  const open = openSales.sales[0]!;
  expect(open.status).toBe('tendering');
  expect(open.receiptNumber).toBeNull();
  expect(open.totals.grossSatang).toBe(Math.round(Number(due) * 100));

  // The tender.
  await page.getByRole('heading', { name: 'Cash' }).click();
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({
    timeout: 20_000,
  });
  // One price, wherever a person reads one: the confirmation line shows the
  // figure the platform charged, not a second computation of it.
  await expect(page.getByText(`฿${due}`, { exact: false }).first()).toBeVisible();

  const afterTender = await page.request.get(`/api/sales/${open.id}`);
  const closed = (await afterTender.json()) as {
    sale: { status: string; receiptNumber: string | null; totals: { grossSatang: number } };
  };
  expect(closed.sale.status).toBe('finalised');
  expect(closed.sale.receiptNumber).toBeTruthy();
  expect(closed.sale.totals.grossSatang).toBe(open.totals.grossSatang);
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
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill('0900000002');
  await page.locator('input[type="password"]').fill('reception1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await pickStationIfAsked(page);
  await expect(page.getByText('Membership Check')).toBeVisible({ timeout: 15_000 });

  const listSales = async () => {
    const res = await page.request.get('/api/sales?limit=50');
    return ((await res.json()) as {
      sales: { id: string; status: string; totals: { grossSatang: number } }[];
    }).sales;
  };
  const before = new Set((await listSales()).map((s) => s.id));

  await page.getByRole('button', { name: 'Skip — walk-in (Tourist)' }).click();
  await page.getByRole('heading', { name: 'Tourist' }).click();
  await page.getByRole('heading', { name: '2 Hours Play' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  const firstDue = ((await payButton.textContent()) ?? '').replace(/^Pay ฿/, '').trim();
  await payButton.click();
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible().catch(() => false)) await done.click();
  await expect(page.getByText('This order is recorded, unpaid.')).toBeVisible({ timeout: 15_000 });

  // The visitor adds an adult while the money is still on the counter.
  await page.getByRole('button', { name: 'Add one Adults' }).first().click();
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible();
  const correctedDue = ((await page.getByRole('button', { name: /^Pay ฿/ }).textContent()) ?? '')
    .replace(/^Pay ฿/, '')
    .trim();
  expect(correctedDue).not.toBe(firstDue);

  await page.getByRole('heading', { name: 'Cash' }).click();
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({
    timeout: 20_000,
  });

  const added = (await listSales()).filter((s) => !before.has(s.id));
  const sold = added.find((s) => s.status === 'finalised');
  const abandoned = added.find((s) => s.status === 'tendering');
  expect(added).toHaveLength(2);
  // What the visitor paid is the corrected cart; the first is left recorded and
  // unpaid, which is what an order rung up and not paid for is (voiding it is
  // S2-11).
  expect(sold?.totals.grossSatang).toBe(Math.round(Number(correctedDue) * 100));
  expect(abandoned?.totals.grossSatang).toBe(Math.round(Number(firstDue) * 100));
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
    await page.goto('/');
    await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill('0900000002');
    await page.locator('input[type="password"]').fill('reception1234');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await pickStationIfAsked(page);

    await page.getByRole('heading', { name: 'Tourist' }).click();
    await page.getByRole('heading', { name: 'Full Day Pass' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    // The handheld hands the phone over for the visitor's details, then comes
    // back to the order for the Pay press.
    const ready = page.getByRole('button', { name: 'Customer is ready' });
    if (await ready.isVisible().catch(() => false)) await ready.click();
    const handedBack = page.getByRole('button', { name: 'Done', exact: true });
    if (await handedBack.isVisible().catch(() => false)) await handedBack.click();

    const payButton = page.getByRole('button', { name: /^Pay ฿/ });
    await expect(payButton).toBeVisible({ timeout: 15_000 });
    const due = ((await payButton.textContent()) ?? '').replace(/^Pay ฿/, '').trim();
    await payButton.click();

    await expect(page.getByText('This order is recorded, unpaid.')).toBeVisible({ timeout: 15_000 });
    const res = await page.request.get('/api/sales?limit=5');
    const open = ((await res.json()) as {
      sales: { id: string; status: string; receiptNumber: string | null; totals: { grossSatang: number } }[];
    }).sales[0]!;
    expect(open.status).toBe('tendering');
    expect(open.receiptNumber).toBeNull();
    expect(open.totals.grossSatang).toBe(Math.round(Number(due) * 100));

    await page.getByRole('heading', { name: 'Cash' }).click();
    await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
    await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({
      timeout: 20_000,
    });

    const after = await page.request.get(`/api/sales/${open.id}`);
    const closed = (await after.json()) as { sale: { status: string; receiptNumber: string | null } };
    expect(closed.sale.status).toBe('finalised');
    expect(closed.sale.receiptNumber).toBeTruthy();
  });
});
