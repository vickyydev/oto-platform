import { expect, test } from '@playwright/test';

/**
 * The CLAUDE.md §8 smoke flow: lock → sign-in → membership lookup → child
 * confirm — plus sign-out back to the lock screen. Runs against the seeded
 * dev database (reception account, member Mali +66811111111 with 2 children).
 */
test('lock → sign in → membership lookup → child confirm → sign out', async ({ page }) => {
  await page.goto('/');

  // Lock screen with the phone + password form (SCRUM-19 UI addition).
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill('0900000002');
  await page.locator('input[type="password"]').fill('reception1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Till home: operator badge + API-driven pricing chip.
  await expect(page.getByText('Membership Check')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Weekday pricing|Weekend pricing/).first()).toBeVisible();

  // Customer display: enter Mali's phone on the keypad, find membership.
  for (const digit of '0811111111') {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.getByRole('button', { name: 'Find my membership' }).click();

  // SCRUM-30: member found via the API; SCRUM-32: children re-confirm modal.
  await expect(page.getByText("Who's visiting today?")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Nong Ploy')).toBeVisible();
  await expect(page.getByText('Nong Tan')).toBeVisible();
  await page.getByRole('button', { name: /Confirm 2 children/ }).click();
  await expect(page.getByText('Visit confirmed')).toBeVisible({ timeout: 15_000 });

  // Verified tier auto-applied from the member record.
  await expect(page.getByText('Thai · verified')).toBeVisible();

  // SCRUM-24: sign out returns to the lock screen.
  await page.getByLabel('Lock screen').click();
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
});

test('unknown phone offers the create-member path (SCRUM-31)', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill('0900000002');
  await page.locator('input[type="password"]').fill('reception1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Membership Check')).toBeVisible({ timeout: 15_000 });

  const unknown = `06${String(Math.floor(10000000 + Math.random() * 89999999))}`;
  for (const digit of unknown) {
    await page.getByRole('button', { name: digit, exact: true }).first().click();
  }
  await page.getByRole('button', { name: 'Find my membership' }).click();

  await expect(page.getByText('New member?')).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder('e.g. Mali').fill('Smoke Test');
  await page.getByRole('button', { name: 'Create member', exact: true }).click();
  await expect(page.getByText('Member created')).toBeVisible({ timeout: 15_000 });
});
