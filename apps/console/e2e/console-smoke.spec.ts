import { expect, test } from '@playwright/test';
import {
  CENTRAL_FLORESTA,
  ROBINSON_CHALONG,
  chooseBranch,
  openSection,
  pressLandsOn,
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
 * DEVICES — adding a box, with a real mouse rather than a dispatched event.
 *
 * SCRUM-377: the dialog behind "Add a box" rendered inside the Boxes panel,
 * and that panel's `backdrop-blur` made it the containing block and the
 * stacking context for everything fixed inside it — so the dialog was sized to
 * the panel instead of the viewport and the Stations card painted over its
 * foot. It LOOKED right in a screenshot and read as visible to a locator;
 * Cancel and "Add the box" simply could not be pressed, and an administrator
 * could not add a box from the Console at all.
 *
 * Which is why this case asserts where a press lands before it asserts what a
 * press does: `toBeVisible` was true throughout the bug. Cancel is pressed
 * first and must add nothing — a dialog that closes on Cancel but files the
 * form anyway is the other half of the same button working.
 */
test('Devices: a box is added by pressing the dialog, and Cancel adds nothing', async ({ page }) => {
  await signInAndWait(page);
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);

  const boxes = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Boxes', exact: true }) });
  const trigger = boxes.getByRole('button', { name: 'Add a box', exact: true });
  await expect(trigger).toBeVisible({ timeout: 30_000 });

  // Named for this case, so the row asserted at the end is this run's own.
  const dialog = page.getByRole('dialog', { name: 'Add a box' });
  const added = boxes.getByRole('button', { name: 'Smoke box 377', exact: true });
  const openFilledIn = async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByLabel('Name').fill('Smoke box 377');
    await dialog.getByLabel('Slot').fill('smoke-377');
  };

  await openFilledIn();
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const add = dialog.getByRole('button', { name: 'Add the box', exact: true });
  expect(await pressLandsOn(cancel)).toBe('button “Cancel”');
  expect(await pressLandsOn(add)).toBe('button “Add the box”');

  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(added).toHaveCount(0);

  await openFilledIn();
  await add.click();
  // The claim code, which is the dialog's whole point: it is shown once and
  // only its hash is kept, so "Done" is the only way out of this step.
  const done = dialog.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await done.click();
  await expect(added).toBeVisible({ timeout: 30_000 });
});

/**
 * THE CARD TERMINALS — SCRUM-206's Console surface.
 *
 * These buttons are what makes the tender ticket's hard cases demonstrable at
 * all: a host that declines, one that approves less than was asked, one that
 * says nothing and leaves a till blocked. None of them can be rehearsed on a
 * real EDC in Phuket from here.
 *
 * The case is about the seam this panel does NOT share with the ones around
 * it. Every other simulator control rides the box command queue and answers
 * "queued"; this one cannot — `terminal.outcome` can carry the approval code
 * the terminal will print, and a command payload is stored and rendered — so
 * it posts to `/payments/terminal-simulator` and the answer is immediate and
 * says whether it LANDED. The harness runs the api with the `edge` role
 * (`playwright.config.ts`), so the virtual box and its two simulated EDCs are
 * in that process and can actually be reached; a press that answered "sent"
 * over a simulator nobody set would pass a weaker assertion than this one.
 */
test('Devices: a simulated card terminal can be told what to do with the next tender', async ({
  page,
}) => {
  await signInAndWait(page);
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);

  const terminals = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Card terminals', exact: true }) });
  // The park's NEXGO, by its own label — the seeded row this branch's till
  // routes a card tender to.
  const row = terminals.getByRole('listitem').filter({ hasText: 'EDC 1' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The dialect, so the panel is naming the real device and not a placeholder.
  await expect(row).toContainText('GHL LinkPOS');

  await row.getByRole('button', { name: 'Decline', exact: true }).click();

  // The platform's own answer, not a queue receipt: it either reached the
  // simulator or it did not.
  await expect(
    terminals.getByText('EDC 1 will decline the next tender.'),
  ).toBeVisible({ timeout: 30_000 });
  // And the row says the setting is still standing, because it is chosen
  // before a tender is sent and stays until it is changed.
  await expect(row).toContainText('next: Decline');
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
