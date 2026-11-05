import { expect, type Page } from '@playwright/test';

/**
 * SCRUM-762 — A WALK-IN STARTS WITH THEIR PHONE NUMBER.
 *
 * The membership check has no Skip any more: the number is required, for the
 * child's safety. A family who is not a member types it on the customer half,
 * presses Continue, and goes on at the default rate with the number on the
 * sale. The till then offers to make them a member; a walk-in declines.
 *
 * `digits` is the national number after the country code, typed on the
 * customer half's keypad (the last copy of each key on the page: the staff
 * half has none at this step). Give each spec its own, so no run finds a
 * member another one made.
 */
export async function walkInByPhone(page: Page, digits: string): Promise<void> {
  for (const digit of digits) {
    await page.getByRole('button', { name: digit, exact: true }).last().click();
  }
  await page.getByRole('button', { name: 'Continue', exact: true }).last().click();
  const offer = page.getByRole('button', { name: 'Continue as walk-in', exact: true });
  const tiers = page.getByRole('heading', { name: 'Tourist', exact: true });
  await expect.poll(async () => (await offer.isVisible()) || (await tiers.isVisible()), { timeout: 15_000 }).toBe(true);
  if (await offer.isVisible()) await offer.click();
}
