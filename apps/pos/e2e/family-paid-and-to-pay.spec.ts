import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * SCRUM-741 — A FAMILY WITH A CHILD PAID ONLINE AND A SIBLING ADDED AT THE DOOR.
 *
 * A real booking through the booking site's own routes, paid through the
 * simulator, and a sibling added to that family's registration as the till's
 * Add sibling adds one. The board then says which child is paid and which is
 * still to pay, and names each child's Check in: the paid child's opens the
 * booking, the sibling's takes the sibling, and only the sibling, to the till.
 * On a phone the family screen says the same.
 *
 * Runs on the isolated harness with the simulated gateway switched on by name:
 * `PAYMENTS_SIMULATOR=on pnpm --filter @oto/pos e2e e2e/family-paid-and-to-pay.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const BRANCH_CODE = 'hkt-central';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(150_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
  test.skip(process.env.PAYMENTS_SIMULATOR !== 'on', 'Set PAYMENTS_SIMULATOR=on: the family pays through the simulated gateway');
}

const bangkokToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
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
      phone: '0897301741',
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
  if (await picker.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
  }
}

/** The sibling joins the waiting family through the route the till's Add sibling uses. */
async function addSibling(page: Page, parentName: string, name: string): Promise<void> {
  const answer = await page.evaluate(async ({ parentName, name }) => {
    // A UUIDv7, as the till mints one for a new stay.
    const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
    const random = crypto.getRandomValues(new Uint8Array(10));
    const tail = Array.from(random, (b) => hex(b, 2)).join('');
    const ms = hex(Date.now(), 12);
    const variant = hex((random[2]! & 0x3f) | 0x80, 2);
    const checkinId = `${ms.slice(0, 8)}-${ms.slice(8)}-7${tail.slice(0, 3)}-${variant}${tail.slice(6, 8)}-${tail.slice(8, 20)}`;
    const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
    const list = await (await fetch(`/api/checkin/registrations?branchId=${me.branch.id}`, { credentials: 'same-origin' })).json();
    const reg = list.registrations.find((r: { guardianName: string }) => r.guardianName === parentName);
    if (!reg) return { status: 0, body: 'no waiting registration for the family' };
    const res = await fetch(`/api/checkin/registrations/${reg.id}/children`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'idempotency-key': `s741-sibling-${checkinId}` },
      body: JSON.stringify({ children: [{ checkinId, name, ageYears: 5, service: 'drop_off' }] }),
    });
    return { status: res.status, body: (await res.text()).slice(0, 400) };
  }, { parentName, name });
  expect(answer.status, answer.body).toBe(200);
}

test.describe.configure({ mode: 'serial' });

const parent = `ZZ TEST Khun Ying ${Date.now().toString(36).slice(-4)}`;
const paidChild = 'ZZ TEST Bua';
const sibling = 'ZZ TEST Nok';

/** The family's card on the board, found by the parent's name and its paid child's named press. */
async function openFamilyCard(page: Page) {
  await page.getByRole('button', { name: 'Check-in', exact: true }).click();
  await page.getByPlaceholder('Search child, parent or phone…').fill(parent);
  const card = page
    .locator('[class*="bg-card"]')
    .filter({ hasText: parent })
    .filter({ has: page.getByRole('button', { name: `Check in ${paidChild}`, exact: true }) })
    .last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

test('the board says which child is paid and which is to pay, and names each Check in', async ({ page, request }) => {
  requireFixture();
  const booking = await paidBooking(request, parent, { childName: paidChild, ageYears: 6 });

  await signIn(page);
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 30_000 });
  await addSibling(page, parent, sibling);

  const card = await openFamilyCard(page);
  await expect(card.getByText(`Booked & paid · ${paidChild}`, { exact: true })).toBeVisible();
  await expect(card.getByText(`To pay · ${sibling}`, { exact: true })).toBeVisible();
  await expect(card.getByText('Booked & paid · no payment needed')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: `Check in ${sibling}`, exact: true })).toBeVisible();
  await shot(page, 's741-01-desktop-board-paid-and-to-pay');

  // The paid child's press: the booking, as SCRUM-730 made it.
  await card.getByRole('button', { name: `Check in ${paidChild}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(booking.reference)).toBeVisible({ timeout: 20_000 });
  await shot(page, 's741-02-desktop-paid-child-opens-the-booking');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the phone's family screen says the same, with each Check In named", async ({ page }) => {
    requireFixture();
    await signIn(page);
    await page.getByRole('link', { name: 'Check-in' }).click();
    await page.getByRole('button', { name: new RegExp(parent) }).click();
    await expect(page.getByText(`Booked & paid · ${paidChild}`, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`To pay · ${sibling}`, { exact: true })).toBeVisible();
    await expect(page.getByText('Booked & paid · no payment needed')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check In', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Check In ${sibling}`, exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: `Check In ${paidChild}`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Check In ${sibling}`, exact: true })).toBeVisible();
    await shot(page, 's741-03-phone-family-paid-and-to-pay');
  });
});

test("the sibling's Check in takes the sibling, and only the sibling, to the till", async ({ page }) => {
  requireFixture();
  await signIn(page);
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 30_000 });
  const card = await openFamilyCard(page);
  await card.getByRole('button', { name: `Check in ${sibling}`, exact: true }).click();
  const order = page.getByRole('heading', { name: 'Current Order' }).locator('../..');
  await expect(order.getByText(sibling, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(order.getByText(paidChild)).toHaveCount(0);
  await shot(page, 's741-04-desktop-sibling-goes-to-the-till');
});
