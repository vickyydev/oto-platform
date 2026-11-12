import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chooseLanguageFirst } from './walk-in';

/**
 * SCRUM-885 — A MEMBER CREATED A MOMENT AGO IS NOT GREETED AS RETURNING.
 *
 * Seen in the SCRUM-858 staging proof (picture 01): a family registered at
 * the "New member?" box was told "Welcome back, … Great to see you again." on
 * the customer half. The prototype's welcome screen says that to a member the
 * membership check found, and "Welcome to Oto" with "Thailand's happiest
 * indoor play park" to everyone else; the customer half now says the second
 * to a member created on this sale.
 *
 * In the split view, at 1680 x 1050 and 1440 x 900: a ZZ TEST number nobody
 * knows, the customer half's Continue, the "New member?" box, and the
 * customer half still says "Welcome to Oto" once the member exists. The next
 * sale with the same number finds them, and welcomes them back. The separate
 * display's case is in smoke.spec.ts ("unknown phone offers the
 * create-member path").
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/new-member-greeting.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(150_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(800);
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

/** The till is handed back signed out, so the next case signs in afresh. */
async function signOut(page: Page): Promise<void> {
  try {
    if ((await page.request.get('/api/me').catch(() => null))?.status() === 200) {
      await page.request.post('/api/auth/sign-out').catch(() => undefined);
    }
  } finally {
    await page.goto('about:blank').catch(() => undefined);
  }
}

/** The customer half: the guest's language, the number's national digits on its keypad, Continue. */
async function identifyOnCustomerHalf(page: Page, digits: string): Promise<void> {
  await chooseLanguageFirst(page, 'en');
  for (const digit of digits) await page.getByRole('button', { name: digit, exact: true }).last().click();
  await page.getByRole('button', { name: 'Continue', exact: true }).last().click();
}

const FIRST_VISIT_LINE = "Thailand's happiest indoor play park. Let's get you ready to play!";
const suffix = Date.now().toString(36).slice(-4);

for (const size of [{ width: 1680, height: 1050 }, { width: 1440, height: 900 }]) {
  test(`at ${size.width} x ${size.height}: a member created at the New member box is welcomed as a first visit, and back on the next sale`, async ({ page }) => {
    requireFixture();
    await page.setViewportSize(size);
    await signIn(page);
    try {
      // A ZZ TEST number this run alone uses: 0 89 885 then four digits.
      const digits = `89885${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
      const name = `ZZ TEST 885 ${suffix}${size.width}`;
      const lookup = page.waitForResponse((r) => r.url().includes('/api/members/lookup?') && r.request().method() === 'GET');
      await identifyOnCustomerHalf(page, digits);
      expect((await (await lookup).json()).member).toBeNull();
      await expect(page.getByText('New member?', { exact: true })).toBeVisible({ timeout: 20_000 });

      await page.getByPlaceholder('e.g. Mali').fill(name);
      const created = page.waitForResponse((r) => r.url().endsWith('/api/members') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Create member', exact: true }).click();
      const response = await created;
      expect(response.ok()).toBe(true);
      expect((await response.json()).member?.nickname).toBe(name);
      await expect(page.getByText('Member created', { exact: true })).toBeVisible({ timeout: 20_000 });
      // The staff half has the member on the sale.
      await expect(page.getByRole('heading', { name: 'Select Customer Type', exact: true })).toBeVisible();
      await expect(page.getByText('No verified rate', { exact: true })).toBeVisible();

      // The customer half: the prototype's first-visit words, under the customer's name.
      await expect(page.getByRole('heading', { name: 'Welcome to Oto', exact: true })).toBeVisible();
      await expect(page.getByText(FIRST_VISIT_LINE, { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Welcome back/ })).toHaveCount(0);
      await expect(page.getByText(/Great to see you again/)).toHaveCount(0);
      await shot(page, `885-new-member-first-visit-${size.width}x${size.height}`);

      // The next sale: the same number is a member the check finds, welcomed back.
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });
      await identifyOnCustomerHalf(page, digits);
      await expect(page.getByRole('heading', { name: `Welcome back, ${name}!`, exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/Great to see you again/)).toBeVisible();
      await expect(page.getByText('New member?', { exact: true })).toHaveCount(0);
      await shot(page, `885-next-sale-welcome-back-${size.width}x${size.height}`);
    } finally {
      await signOut(page);
    }
  });
}
