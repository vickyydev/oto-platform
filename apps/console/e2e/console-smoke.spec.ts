import { expect, test } from '@playwright/test';
import {
  CENTRAL_FLORESTA,
  ROBINSON_CHALONG,
  chooseBranch,
  openSection,
  signIn,
  signInAndWait,
} from './console';

/**
 * The Console, on the three things it is opened for and the one thing it has
 * to refuse.
 *
 * Nothing here is a screenshot test. Each case names a reading somebody acts
 * on — how many spins a booth has had today, which parks exist, whether a
 * password was accepted — and the page either produces it from the platform or
 * it does not.
 */

/**
 * BOOTHS — SCRUM-257's surface.
 *
 * "Spins today" is the line a manager looks at to decide whether the wheel is
 * still playing, and it is read from what the booth's box last reported rather
 * than from anything this page asks it now. The assertion is deliberately on
 * the SHAPE of the reading — a number, today's business date — and not on a
 * particular count: a seeded booth has had no spins, and a case that insisted
 * on "0" would start failing the moment somebody demonstrates the wheel
 * against the same seed.
 */
test('Booths: Booth 1 at Central Floresta says how many spins it has had today', async ({ page }) => {
  await signInAndWait(page);
  await openSection(page, 'Booths');
  await chooseBranch(page, CENTRAL_FLORESTA);

  const booth = page.getByRole('button', { name: /Booth 1/ });
  await expect(booth).toBeVisible({ timeout: 30_000 });
  await booth.click();

  await expect(page.getByRole('heading', { name: 'What this booth is running' })).toBeVisible({
    timeout: 30_000,
  });
  // Case-insensitive: the label is upper-cased by CSS, not in the markup.
  const spinsToday = page.getByText(/^spins today \(\d{4}-\d{2}-\d{2}\)$/i);
  await expect(spinsToday).toBeVisible();
  // The figure beside the label: a count, or "n of cap" where the booth has one.
  await expect(spinsToday.locator('xpath=following-sibling::dd[1]')).toHaveText(/\d+( of \d+)?/);
});

/**
 * BRANCHES — the estate, which is the page every branch-scoped picker is fed
 * from. Both seeded parks, by name.
 */
test('Branches: both parks are listed', async ({ page }) => {
  await signInAndWait(page);
  await openSection(page, 'Branches');

  await expect(page.getByText(CENTRAL_FLORESTA, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(ROBINSON_CHALONG, { exact: true })).toBeVisible();
});

/**
 * A WRONG PASSWORD.
 *
 * The console is a back-office door and this is the one case about it being
 * shut. The message is the API's own — "Phone or password is incorrect", which
 * names neither half on purpose (SCRUM-251) — and what matters as much as the
 * message is that the sign-in panel is still what is on screen afterwards.
 */
test('a wrong password is refused, and the console stays shut', async ({ page }) => {
  await signIn(page, 'not-the-password');

  await expect(page.getByText('Phone or password is incorrect')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});
