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

test('Devices: a display code is cleared after refusal and claim, and the paired screen can be revoked', async ({
  page,
}) => {
  await signInAndWait(page);
  const displayId = crypto.randomUUID();
  const displayName = 'Smoke display 201';
  let claimed = false;
  let revoked = false;
  let claimCount = 0;
  let validRequest = false;
  let submittedCode = '';
  let chosenStationId = '';
  let chosenStationName = '';

  await page.route('**/api/branches/*/credentials', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (claimed && !revoked) {
      body.credentials.push({
        id: displayId,
        kind: 'display',
        label: displayName,
        stationId: chosenStationId,
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
        pairingOutstanding: false,
        revokedAt: null,
        scopes: ['display:read', 'display:intents'],
      });
    }
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/stations/*/displays/claim', async (route) => {
    const body = route.request().postDataJSON();
    claimCount += 1;
    submittedCode = body.pairingCode;
    validRequest =
      route.request().method() === 'POST' &&
      new URL(route.request().url()).pathname.endsWith(
        `/stations/${chosenStationId}/displays/claim`,
      ) &&
      /^[0-9]{6}$/.test(body.pairingCode) &&
      body.name === displayName &&
      Boolean(route.request().headers()['idempotency-key']);
    if (claimCount === 1) {
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'DISPLAY_PAIRING_INVALID',
            message: `Unavailable code: ${body.pairingCode}`,
          },
        },
      });
    } else {
      claimed = true;
      await route.fulfill({
        json: {
          station: { id: chosenStationId, name: chosenStationName, kind: 'till' },
          device: { id: displayId, name: displayName },
        },
      });
    }
  });
  await page.route(`**/api/credentials/${displayId}/revoke`, async (route) => {
    revoked = true;
    await route.fulfill({ json: { ok: true } });
  });

  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);
  const pairedScreens = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Paired screens', exact: true }),
  });
  await pairedScreens.getByRole('button', { name: 'Pair a display', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair a display', exact: true });
  const station = dialog.getByRole('combobox', { name: 'Station', exact: true });
  chosenStationId = await station.inputValue();
  chosenStationName = await station.locator('option:checked').innerText();
  await dialog.getByLabel('Display name').fill(` ${displayName} `);
  const code = dialog.getByLabel('Pairing code');
  const submit = dialog.getByRole('button', { name: 'Pair the display', exact: true });
  await expect(code).toHaveAttribute('type', 'password');
  await expect(code).toHaveAttribute('inputmode', 'numeric');
  await code.fill(String(Math.floor(Math.random() * 90_000) + 10_000));
  await expect(submit).toBeDisabled();
  expect(claimCount).toBe(0);
  await code.fill(String(Math.floor(Math.random() * 900_000) + 100_000));
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText('Get a new code on the display');
  expect((await code.inputValue()) === '').toBe(true);
  expect((await dialog.innerText()).includes(submittedCode)).toBe(false);
  expect(validRequest).toBe(true);

  await code.fill(String(Math.floor(Math.random() * 900_000) + 100_000));
  await submit.click();
  await expect(dialog.getByRole('status')).toContainText(
    `${displayName} is paired to ${chosenStationName}`,
  );
  expect(claimCount).toBe(2);
  expect(validRequest).toBe(true);
  await expect(code).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const row = pairedScreens.getByRole('listitem').filter({ hasText: displayName });
  await expect(row).toBeVisible();
  await expect(row).toContainText(chosenStationName);
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(revoked).toBe(true);
});

test('Devices: a display pairing grant for another branch does not offer this park a claim', async ({
  page,
}) => {
  await signInAndWait(page);
  await page.route('**/api/me/permissions', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.permissions = body.permissions.filter(
      (grant: { permission: string }) => grant.permission !== 'admin:device:pair',
    );
    body.permissions.push({
      permission: 'admin:device:pair',
      scopeType: 'branch',
      scopeId: crypto.randomUUID(),
    });
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await openSection(page, 'Devices');
  await chooseBranch(page, CENTRAL_FLORESTA);
  await expect(page.getByRole('heading', { name: 'Paired screens', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair a display', exact: true })).toHaveCount(0);
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
