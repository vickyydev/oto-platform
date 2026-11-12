import { expect, request as playwrightRequest, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chooseLanguageFirst, walkInByPhone } from './walk-in';

/**
 * SCRUM-883 — THE CUSTOMER SIDE SHOWS ONLY THE CREDIT THE PLATFORM GRANTED.
 *
 * The staging package, rebuilt on the seeded park: 1 Hour Play already prices
 * the Thai adult at ฿350 and pays adults their ticket back as credit; Admin
 * then bundles a free adult into the Thai rate, as staging has it. Siti, the
 * seeded verified Thai member, buys one child and one adult: the adult is
 * free, the platform grants no credit, and neither half of the till shows a
 * credit. A Tourist walk-in buying the same: the adult pays ฿350, the
 * platform grants ฿350, and both halves show it. The ticket's free items are
 * put back afterwards.
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/credit-follows-platform.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const BRANCH_CODE = 'hkt-central';
const TICKET = '1 Hour Play';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

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
      headers: { 'idempotency-key': `s883-${Date.now()}-${Math.random().toString(36).slice(2)}` },
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

/** One child and one adult on the ticket, paid in cash; the platform's read of the sale. */
async function payOneChildOneAdult(page: Page): Promise<{ lines: Array<{ kind: string; quantity: number; unitSatang: number }>; grants: Array<{ creditSatang: number; qrCode: string }> }> {
  await page.getByRole('heading', { name: TICKET }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
  await stepTo(page, 'Kids', 1);
  await stepTo(page, 'Adults', 1);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const payButton = page.getByRole('button', { name: /^Pay ฿/ });
  await expect(payButton).toBeEnabled({ timeout: 20_000 });
  await payButton.click();
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible().catch(() => false)) await done.click();
  await expect(page.getByRole('heading', { name: 'Amount Due' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('heading', { name: 'Cash' }).click();
  await page.getByRole('button', { name: 'Confirm Payment Received' }).click();
  await expect(page.getByRole('heading', { name: 'Payment Successful' })).toBeVisible({ timeout: 20_000 });
  // The staff half names the receipt once the platform's read of the sale has landed.
  await expect(page.getByText(/Receipt T\d+-/).first()).toBeVisible({ timeout: 20_000 });
  const listed = (await (await page.request.get('/api/sales?limit=5')).json()) as { sales: Array<{ id: string }> };
  return (await (await page.request.get(`/api/sales/${listed.sales[0]!.id}`)).json()) as {
    lines: Array<{ kind: string; quantity: number; unitSatang: number }>;
    grants: Array<{ creditSatang: number; qrCode: string }>;
  };
}

test('a free Thai adult earns no credit on either half; a paying Tourist adult earns ฿350 on both', async ({ page, baseURL }) => {
  requireFixture();
  const before = await saveFreebies(baseURL!, [{ id: 'zz-test-free-adult-thai', kind: 'adult', quantity: 1, tiers: ['thai'] }]);
  try {
    await signIn(page);

    // Siti, the seeded verified Thai member, on the customer half.
    await chooseLanguageFirst(page, 'en');
    for (const digit of '833333333') await page.getByRole('button', { name: digit, exact: true }).last().click();
    await page.getByRole('button', { name: 'Continue', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Select Customer Type', exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('heading', { name: 'Thai', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add to Sale', exact: true })).toBeVisible({ timeout: 15_000 });

    const thai = await payOneChildOneAdult(page);
    expect(thai.lines.filter((l) => l.kind === 'kids' || l.kind.startsWith('adults')).map((l) => [l.kind, l.quantity, l.unitSatang])).toEqual([
      ['kids', 1, expect.any(Number)],
      ['adults_free', 1, 0],
    ]);
    expect(thai.grants).toEqual([]);
    await shot(page, '01-thai-free-adult-thank-you');
    // Neither half shows a credit.
    await expect(page.getByText('Credit Grants', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Credit Grants to Print', { exact: true })).toHaveCount(0);
    await expect(page.getByText('฿350')).toHaveCount(0);

    await page.getByRole('button', { name: 'Start New Sale', exact: true }).click();
    await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });

    // A Tourist walk-in buying the same: the adult pays ฿350 and earns ฿350.
    await walkInByPhone(page, '812076883');
    await page.getByRole('heading', { name: 'Tourist' }).click();
    const tourist = await payOneChildOneAdult(page);
    expect(tourist.grants.map((g) => g.creditSatang)).toHaveLength(1);
    const earned = tourist.grants[0]!.creditSatang / 100;
    // ฿350 on a weekday, ฿500 at the weekend: the adult's own ticket back.
    expect([350, 500]).toContain(earned);
    await expect(page.getByText('Credit Grants', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`฿${earned}`, { exact: true })).toBeVisible();
    await shot(page, '02-tourist-paying-adult-thank-you');
  } finally {
    await saveFreebies(baseURL!, (before as unknown[] | null) ?? []);
  }
});
