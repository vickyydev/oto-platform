import { expect, type Page } from '@playwright/test';

/**
 * SCRUM-762 — A WALK-IN STARTS WITH THEIR PHONE NUMBER.
 *
 * The membership check has no Skip any more: the number is required, for the
 * child's safety. A family who is not a member types it on the customer half,
 * presses Continue, and goes on at the default rate with the number on the
 * sale. The till then offers to make them a member; a walk-in declines.
 *
 * SCRUM-763 — before the number, the customer half asks the guest's language
 * (once per sale). These specs read the till in English, so the guest chooses
 * English, and the phone-number step follows.
 *
 * `digits` is the national number after the country code, typed on the
 * customer half's keypad (the last copy of each key on the page: the staff
 * half has none at this step). Give each spec its own, so no run finds a
 * member another one made.
 */
export async function walkInByPhone(page: Page, digits: string): Promise<void> {
  await chooseLanguageFirst(page, 'en');
  for (const digit of digits) {
    await page.getByRole('button', { name: digit, exact: true }).last().click();
  }
  await page.getByRole('button', { name: 'Continue', exact: true }).last().click();
  const offer = page.getByRole('button', { name: 'Continue as walk-in', exact: true });
  const tiers = page.getByRole('heading', { name: 'Tourist', exact: true });
  await expect.poll(async () => (await offer.isVisible()) || (await tiers.isVisible()), { timeout: 15_000 }).toBe(true);
  if (await offer.isVisible()) await offer.click();
}

/** SCRUM-763 — the sale's first customer screen: the guest presses their language. */
export async function chooseLanguageFirst(page: Page, lang: 'en' | 'zh' | 'th' | 'ru' | 'fr'): Promise<void> {
  const choice = page.getByTestId('language-choice').last();
  await expect(choice).toBeVisible({ timeout: 20_000 });
  await choice.getByTestId(`language-choice-${lang}`).click();
  await expect(page.getByTestId('language-choice')).toHaveCount(0);
}
