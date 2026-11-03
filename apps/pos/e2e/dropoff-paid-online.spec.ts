import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * SCRUM-730 — A FAMILY WHO PAID ONLINE FOR DROP-OFF IS NEVER OFFERED A CHARGE.
 *
 * A real booking through the booking site's own routes, paid through the
 * simulator; then the board a person sees. "Check in" on that family opens the
 * booking's redeem dialog, not the till's tier step with a line to charge, and
 * once redeemed the board offers the payment-free check-in. The band itself
 * needs a camera for the visit photo, so `booking-paid-online-no-second-charge`
 * in the api's tests takes it from there.
 *
 * Runs on the isolated harness, with the simulated gateway switched on by name:
 * `PAYMENTS_SIMULATOR=on pnpm --filter @oto/pos e2e e2e/dropoff-paid-online.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const BRANCH_CODE = 'hkt-central';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(120_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
  test.skip(process.env.PAYMENTS_SIMULATOR !== 'on', 'Set PAYMENTS_SIMULATOR=on: the family pays through the simulated gateway');
}

const bangkokToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  // A dialog still fading is not what the person at the counter reads.
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function paidBooking(request: APIRequestContext, parentName: string, child: Record<string, unknown>) {
  const catalog = await (await request.get(`/api/public/branches/${BRANCH_CODE}/catalog`)).json();
  const pkg = catalog.packages.find((p: { name: string }) => p.name === '1 Hour Play');
  const required = catalog.supervision.policy.confirmations
    .filter((c: { required: boolean }) => c.required)
    .map((c: { id: string }) => c.id);
  const made = await request.post('/api/public/bookings', {
    data: {
      branchCode: BRANCH_CODE,
      phone: '0812345678',
      parentName,
      tier: 'thai',
      visitDate: bangkokToday(),
      consentAck: true,
      acknowledgedConfirmationIds: required,
      lines: [{ packageId: pkg.id, kids: 1, adults: 0, supervision: child }],
    },
  });
  expect(made.status(), await made.text()).toBe(200);
  const booking = (await made.json()) as { id: string; reference: string };
  const opened = await request.post(`/api/public/bookings/${booking.id}/checkout`, { data: { method: 'card' } });
  expect(opened.status(), await opened.text()).toBe(200);
  const { attemptId } = (await opened.json()) as { attemptId: string };
  const pressed = await request.post(`/api/webhooks/2c2p/hosted/${attemptId}`, { form: { action: 'pay' } });
  expect(pressed.status(), await pressed.text()).toBe(200);
  return booking;
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

const openBoard = (page: Page) => page.getByRole('button', { name: 'Check-in', exact: true }).click();
const familyCard = (page: Page, parentName: string) =>
  page.locator('div.rounded-xl, [class*="bg-card"]').filter({ hasText: parentName }).filter({ has: page.getByRole('button', { name: 'Check in', exact: true }) }).last();

test.describe.configure({ mode: 'serial' });

test('Check in on a paid online drop-off family opens the booking, and never a charge', async ({ page, request }) => {
  requireFixture();
  const parent = 'ZZ TEST Khun Mali';
  const booking = await paidBooking(request, parent, { childName: 'ZZ TEST Ploy', ageYears: 6, allergies: 'Peanuts' });

  await signIn(page);
  await openBoard(page);
  const card = familyCard(page, parent);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Booked & paid · no payment needed')).toBeVisible();
  await shot(page, '01-board-booked-and-paid');

  // The press: no tier step, no line, no payment. The booking's own dialog.
  await card.getByRole('button', { name: 'Check in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(booking.reference)).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole('button', { name: 'Confirm & Issue' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Pay ฿/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toHaveCount(0);
  await shot(page, '02-check-in-opens-the-booking');

  await dialog.getByRole('button', { name: 'Confirm & Issue' }).click();
  await expect(page.getByText('Check in drop-off child?')).toBeVisible({ timeout: 20_000 });
  await shot(page, '03-redeemed-no-payment');
  await page.getByRole('button', { name: 'Check in now', exact: true }).click();

  // Back on the board, the same family goes on with no payment.
  const after = familyCard(page, parent);
  await expect(after).toBeVisible({ timeout: 20_000 });
  await expect(after.getByText('Booked & paid · no payment needed')).toBeVisible();
  await after.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check in & issue band' })).toBeVisible({ timeout: 20_000 });
  await shot(page, '04-board-checks-in-with-no-payment');
});

test('Check in on a paid online nanny family opens the booking too, and is not refused as not paid', async ({ page, request }) => {
  requireFixture();
  const parent = 'ZZ TEST Khun Dao';
  const booking = await paidBooking(request, parent, { childName: 'ZZ TEST Tam', ageYears: 3, nannyStartTime: '23:30' });

  await signIn(page);
  await openBoard(page);
  const card = familyCard(page, parent);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Booked & paid · no payment needed')).toBeVisible();
  await shot(page, '05-nanny-board-booked-and-paid');

  await card.getByRole('button', { name: 'Check in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(booking.reference)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/has not been paid for yet/)).toHaveCount(0);
  await shot(page, '06-nanny-check-in-opens-the-booking');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Check In on a paid online family opens the booking on the phone till', async ({ page, request }) => {
    requireFixture();
    const parent = 'ZZ TEST Khun Fon';
    const booking = await paidBooking(request, parent, { childName: 'ZZ TEST Mint', ageYears: 6 });

    await page.goto('/');
    await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const picker = page.getByRole('heading', { name: 'Which station are you on?' });
    if (await picker.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
    }

    await page.getByRole('link', { name: 'Check-in' }).click();
    await page.getByRole('button', { name: new RegExp(parent) }).click();
    await expect(page.getByText('Booked & paid · no payment needed')).toBeVisible({ timeout: 20_000 });
    await shot(page, '07-phone-family-booked-and-paid');

    await page.getByRole('button', { name: 'Check In', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(booking.reference)).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('button', { name: 'Confirm & Issue' })).toBeVisible();
    await shot(page, '08-phone-check-in-opens-the-booking');
  });
});
