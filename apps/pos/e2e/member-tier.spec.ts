import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chooseLanguageFirst } from './walk-in';

/**
 * SCRUM-858 — TIERS AT THE TILL: A REGISTERED MEMBER SEES ONLY THEIR OWN RATE.
 *
 * The owner's words (8 and 12 November 2026): "Registered members should not
 * see other ticket types. Show only their relevant ticket until their
 * document expires. For example if a registered member is already confirmed
 * Thai from the first visit, on the next visit when he enters the number just
 * show the Thai tier and rates instead of showing all types again."
 *
 * Against the seeded park: James (Expat, passport in date) and Siti (Thai)
 * each see one card; Alex, who holds no verified rate, sees all three; a
 * ZZ TEST member whose passport expiry is pushed into the past sees all three
 * beside "Document expired — re-verify". "Show all rates" brings every rate
 * back for this sale, and the member's stored rate is read back unchanged.
 * The customer half says "Member rate applied" exactly while the member's
 * own rate is the sale's.
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/member-tier.spec.ts`.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const DATABASE_URL = process.env.POS_E2E_DATABASE_URL ?? '';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
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

/**
 * The customer half of the split view: the guest's language, their number
 * (the national digits after +66, on the half's keypad — the last copy of
 * each key on the page), then Continue. The staff half lands on the
 * customer type step.
 */
async function identifyOnCustomerHalf(page: Page, digits: string): Promise<void> {
  await chooseLanguageFirst(page, 'en');
  for (const digit of digits) await page.getByRole('button', { name: digit, exact: true }).last().click();
  await page.getByRole('button', { name: 'Continue', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Select Customer Type', exact: true })).toBeVisible({ timeout: 20_000 });
}

/** The tier cards on the step, by their headings. */
async function tierCards(page: Page): Promise<string[]> {
  const shown: string[] = [];
  for (const name of ['Tourist', 'Expat', 'Thai']) {
    if ((await page.getByRole('heading', { name, exact: true }).count()) > 0) shown.push(name);
  }
  return shown;
}

/** The member's stored rate, as the till's lookup reads it back. */
async function storedTier(page: Page, phone: string): Promise<string | null> {
  const answer = await page.request.get('/api/members/lookup', { params: { phone } });
  expect(answer.status(), await answer.text()).toBe(200);
  const member = (await answer.json()).member as { tierVerification: { tier: string } | null } | null;
  return member?.tierVerification?.tier ?? null;
}

const key = () => `s858-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test('a verified expat with a valid document sees only Expat; "Show all rates" is for this sale and changes nothing stored', async ({ page }) => {
  requireFixture();
  // A laptop in the split view: the staff panel is at its narrowest here.
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  try {
    expect(await storedTier(page, '0822222222')).toBe('expat');
    await identifyOnCustomerHalf(page, '822222222');
    await expect(page.getByText('Expat · verified')).toBeVisible();
    expect(await tierCards(page)).toEqual(['Expat']);
    await expect(page.getByText('Passport — no proof needed')).toBeVisible();
    // The customer half: the member's own rate is the sale's.
    await expect(page.getByRole('heading', { name: 'Welcome back, James!', exact: true })).toBeVisible();
    await expect(page.getByText('Member rate applied', { exact: true })).toBeVisible();

    // The one way back: every rate for this sale, the control gone, the stored rate untouched.
    const showAll = page.getByRole('button', { name: 'Show all rates', exact: true });
    await expect(showAll).toBeVisible();
    // Readable at this width: the control ends inside the member banner (so
    // inside the staff panel, which clips what overflows it), and the
    // member's name keeps its room beside the badge.
    const banner = page.getByText('Expat · verified').locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]');
    const bannerBox = await banner.boundingBox();
    const showAllBox = await showAll.boundingBox();
    const nameBox = await banner.getByText('James', { exact: true }).boundingBox();
    expect(bannerBox && showAllBox && nameBox).toBeTruthy();
    expect(showAllBox!.x + showAllBox!.width).toBeLessThanOrEqual(bannerBox!.x + bannerBox!.width);
    expect(nameBox!.width).toBeGreaterThan(40);
    await showAll.click();
    await expect.poll(() => tierCards(page)).toEqual(['Tourist', 'Expat', 'Thai']);
    await expect(showAll).toHaveCount(0);
    await expect(page.getByText('Expat · verified')).toBeVisible();
    expect(await storedTier(page, '0822222222')).toBe('expat');

    // A guest of the member at the tourist rate: the sale goes on at it and the
    // customer half no longer says "member rate"; the member keeps expat.
    await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add to Sale', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Member rate applied', { exact: true })).toHaveCount(0);
    expect(await storedTier(page, '0822222222')).toBe('expat');
  } finally {
    await signOut(page);
  }
});

test('a member confirmed Thai sees only Thai, and the sale continues at it as if staff had picked it', async ({ page }) => {
  requireFixture();
  await signIn(page);
  try {
    expect(await storedTier(page, '0833333333')).toBe('thai');
    await identifyOnCustomerHalf(page, '833333333');
    await expect(page.getByText('Thai · verified')).toBeVisible();
    expect(await tierCards(page)).toEqual(['Thai']);
    await expect(page.getByRole('button', { name: 'Show all rates', exact: true })).toBeVisible();
    await expect(page.getByText('re-verify')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Welcome back, Siti!', exact: true })).toBeVisible();
    await expect(page.getByText('Member rate applied', { exact: true })).toBeVisible();
    await page.getByRole('heading', { name: 'Thai', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add to Sale', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Member rate applied', { exact: true })).toBeVisible();
    expect(await storedTier(page, '0833333333')).toBe('thai');
  } finally {
    await signOut(page);
  }
});

test('a member with no verified rate sees every tier, as before', async ({ page }) => {
  requireFixture();
  await signIn(page);
  try {
    expect(await storedTier(page, '0844444444')).toBeNull();
    await identifyOnCustomerHalf(page, '844444444');
    await expect(page.getByText('No verified rate')).toBeVisible();
    expect(await tierCards(page)).toEqual(['Tourist', 'Expat', 'Thai']);
    await expect(page.getByRole('button', { name: 'Show all rates', exact: true })).toHaveCount(0);
    await expect(page.getByText('Member rate applied', { exact: true })).toHaveCount(0);
  } finally {
    await signOut(page);
  }
});

test('an expat whose document has expired sees every tier beside the re-verify prompt', async ({ page }) => {
  requireFixture();
  test.skip(!DATABASE_URL, 'The expired document is written straight into the isolated database');
  await signIn(page);
  try {
    // A ZZ TEST member, verified Expat on a passport in date (the route refuses
    // a past expiry), whose recorded expiry is then pushed into the past the
    // way time itself would.
    const phone = '+66891858858';
    const created = await page.request.post('/api/members', {
      data: { phone, nickname: 'ZZ TEST 858 expired' },
      headers: { 'Idempotency-Key': key() },
    });
    expect([200, 201], await created.text()).toContain(created.status());
    const memberId = (await created.json()).member.id as string;
    const verified = await page.request.post(`/api/members/${memberId}/tier-verification`, {
      data: { toTier: 'expat', evidenceType: 'Passport', evidenceExpiresAt: '2030-01-01' },
      headers: { 'Idempotency-Key': key() },
    });
    expect(verified.status(), await verified.text()).toBe(200);
    const { Pool } = createRequire(resolve(import.meta.dirname, '../../../packages/db/package.json'))('pg');
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      const expired = await pool.query(
        'update crm.member_tier_verification set evidence_expires_at = $1 where member_id = $2',
        ['2020-01-01T00:00:00Z', memberId],
      );
      expect(expired.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
    expect(await storedTier(page, phone)).toBe('expat');

    await identifyOnCustomerHalf(page, '891858858');
    await expect(page.getByRole('button', { name: 'Document expired — re-verify', exact: true })).toBeVisible();
    await expect(page.getByText('Expat · verified')).toBeVisible();
    expect(await tierCards(page)).toEqual(['Tourist', 'Expat', 'Thai']);
    await expect(page.getByRole('button', { name: 'Show all rates', exact: true })).toHaveCount(0);
  } finally {
    await signOut(page);
  }
});
