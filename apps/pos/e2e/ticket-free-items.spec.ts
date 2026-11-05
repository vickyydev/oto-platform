import { expect, request as playwrightRequest, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * SCRUM-768 — THE FREE ITEMS SET ON A TICKET IN ADMIN ARE APPLIED AT THE TILL.
 *
 * Admin saves a free child and a free adult for Tourist on 2 Hours Play
 * through the route the admin app's ticket form saves with. A walk-in family
 * of two kids and two adults is then rung up at the till: the order panel says
 * one child and one adult are free, the customer display shows them at ฿0,
 * the platform takes that figure, and the sale is filed with the free units
 * as ฿0 lines. The ticket's free items are put back as they were afterwards.
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/ticket-free-items.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const BRANCH_CODE = 'hkt-central';
const TICKET = '2 Hours Play';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(150_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
  test.skip(!ADMIN_PHONE || !ADMIN_PASSWORD, 'Set POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD (an owner account)');
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

/** The ticket's free items, saved as the admin app's ticket form saves them; the earlier ones back. */
async function saveFreebies(baseURL: string, freebies: unknown[] | null): Promise<unknown> {
  const admin = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  try {
    const signedIn = await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    const listed = await admin.get('/api/branches');
    expect(listed.status(), await listed.text()).toBe(200);
    const branch = ((await listed.json()) as { branches: Array<{ id: string; code: string }> }).branches.find(
      (b) => b.code === BRANCH_CODE,
    )!;
    const packages = await admin.get(`/api/branches/${branch.id}/ticket-packages`);
    expect(packages.status(), await packages.text()).toBe(200);
    const body = (await packages.json()) as { packages?: Array<{ id: string; name: string; freebies: unknown }> } | Array<{ id: string; name: string; freebies: unknown }>;
    const rows = Array.isArray(body) ? body : (body.packages ?? []);
    const ticket = rows.find((p) => p.name === TICKET)!;
    const saved = await admin.patch(`/api/branches/${branch.id}/ticket-packages/${ticket.id}`, {
      data: { freebies },
      headers: { 'idempotency-key': `s768-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    return ticket.freebies ?? null;
  } finally {
    await admin.dispose();
  }
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
async function stepTo(page: Page, label: 'Kids' | 'Adults', target: number): Promise<void> {
  const add = page.getByRole('button', { name: `Add one ${label}` }).first();
  const remove = page.getByRole('button', { name: `Remove one ${label}` }).first();
  const value = add.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 6; i += 1) {
    const now = Number(await value.textContent());
    if (now === target) return;
    await (now < target ? add : remove).click();
  }
  await expect(value).toHaveText(String(target));
}

test('a ticket bundling a free child and a free adult is charged without them, and filed with them at ฿0', async ({ page, baseURL }) => {
  requireFixture();
  const before = await saveFreebies(baseURL!, [
    { id: 'zz-test-free-child', kind: 'child', quantity: 1, tiers: ['tourist'] },
    { id: 'zz-test-free-adult', kind: 'adult', quantity: 1, tiers: ['tourist'] },
  ]);
  try {
    await signIn(page);
    await page.getByRole('button', { name: 'Skip — walk-in (Tourist)' }).click();
    await page.getByRole('heading', { name: 'Tourist' }).click();
    await page.getByRole('heading', { name: TICKET }).click();
    await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
    await stepTo(page, 'Kids', 2);
    await stepTo(page, 'Adults', 2);

    // The order panel: one child and one adult free, the rest at the ticket's
    // price; the customer display beside it lists the free child and adult at ฿0.
    const order = page.getByRole('heading', { name: 'Current Order' }).locator('../..');
    await expect(order.getByText(/each · 1 free/)).toHaveCount(2);
    await expect(page.getByText('Kids (free)').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Adults (free)').first()).toBeVisible();
    await shot(page, '01-order-panel-and-display-free-items');

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const payButton = page.getByRole('button', { name: /^Pay ฿/ });
    await expect(payButton).toBeEnabled({ timeout: 20_000 });
    const due = ((await payButton.textContent()) ?? '').replace(/^Pay ฿/, '').trim();
    await payButton.click();
    // A walk-in hands the display over for a phone number; Done hands it back.
    const done = page.getByRole('button', { name: 'Done', exact: true });
    if (await done.isVisible().catch(() => false)) await done.click();
    await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 15_000 });
    await shot(page, '02-amount-due-free-items-figure');
    await page.getByRole('heading', { name: 'Cash' }).click();
    await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
    await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({ timeout: 20_000 });
    await shot(page, '03-paid-at-the-free-items-figure');

    // The ledger: the figure the till showed, and the free units filed at ฿0.
    const listed = (await (await page.request.get('/api/sales?limit=5')).json()) as { sales: Array<{ id: string }> };
    const read = (await (await page.request.get(`/api/sales/${listed.sales[0]!.id}`)).json()) as {
      sale: { status: string; totals: { grossSatang: number } };
      lines: Array<{ label: string; quantity: number; grossSatang: number }>;
    };
    expect(read.sale.status).toBe('finalised');
    expect(read.sale.totals.grossSatang).toBe(Math.round(Number(due) * 100));
    expect(read.lines.map((l) => [l.label, l.quantity, l.grossSatang])).toEqual(
      expect.arrayContaining([
        ['Kids (free)', 1, 0],
        ['Adults (free)', 1, 0],
      ]),
    );
  } finally {
    await saveFreebies(baseURL!, (before as unknown[] | null) ?? []);
  }
});
