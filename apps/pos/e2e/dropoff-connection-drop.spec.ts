import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-887 — A CONNECTION DROP DURING A DROP-OFF REGISTRATION DOES NOT LEAVE
 * THE FAMILY STUCK ON THE BOX.
 *
 * The SCRUM-871 staging proof: a walk-in family, two children and no adult,
 * the drop-off form filled on the customer half. Continue creates the
 * guardian and both children on the platform; then the registration request
 * reaches nothing (the browser aborts it). The till used to move to its box,
 * which answered "Member not found" for the guardian written seconds before.
 *
 * Here the same abort, on the isolated harness, whose Reception Till 1 sits on
 * the seed's virtual box: the till says the connection dropped and that it is
 * retrying, sends the SAME registration again to the platform, and goes on to
 * payment in that one press. The box is never asked to register anyone, the
 * guardian holds each child once and there is one registration.
 *
 * The long-outage test is the staging proof's point 2: the link stays down past
 * the held retries, the till gives up ("press Continue again") and its other
 * calls move it to the box. The link comes back for the till while the box's
 * status still keeps the lane on the box. Continue again finishes the
 * registration online, and the family's sale, its cash press and the door
 * choice go online too: the box is never asked to price, sell or check in.
 *
 * SCRUM-897 — the same window, on the payment step: the sale written online
 * is not said to be working through the counter box (Hold sale can be
 * pressed), and the Held sales list, which could not be read while the link
 * was down, is read again as soon as the platform answers the till.
 *
 * `pnpm --filter @oto/pos e2e e2e/dropoff-connection-drop.spec.ts`;
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const FAMILY_DIGITS = '898870001';
const LONG_OUTAGE_DIGITS = '898870002';
const PAYMENT_STEP_DIGITS = '898970003';

test.use({ trace: 'off', video: 'off', screenshot: 'off', viewport: { width: 1680, height: 1100 } });
test.setTimeout(180_000);

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  const landed = page.getByTestId('language-choice');
  await expect.poll(async () => (await picker.isVisible()) || (await landed.isVisible()), { timeout: 30_000 }).toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
  await expect(landed.last()).toBeVisible({ timeout: 30_000 });
}

/** The customer half of the split view that holds `locator`. */
const halfOf = (locator: Locator) =>
  locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');

async function setKids(page: Page, kids: number): Promise<void> {
  await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
  await page.getByRole('heading', { name: '1 Hour Play', exact: true }).first().click();
  const add = page.getByRole('button', { name: 'Add one Kids', exact: true }).first();
  const remove = page.getByRole('button', { name: 'Remove one Adults', exact: true }).first();
  const value = (button: Locator) => button.locator('xpath=preceding-sibling::span[1]');
  for (let i = 0; i < 8 && Number(await value(add).textContent()) < kids; i++) await add.click();
  const adults = page.getByRole('button', { name: 'Add one Adults', exact: true }).first();
  for (let i = 0; i < 8 && Number(await value(adults).textContent()) > 0; i++) await remove.click();
  await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
}

async function setAge(page: Page, card: Locator, age: number): Promise<void> {
  await card.getByRole('button', { name: /Tap to set age/ }).last().click();
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: String(age), exact: true }).click();
  await page.waitForTimeout(300);
  await dialog.getByRole('button', { name: /^Jan/ }).first().click();
  await page.waitForTimeout(300);
  await dialog.getByRole('button', { name: '1', exact: true }).first().click();
  await page.waitForTimeout(300);
  await dialog.getByRole('button', { name: /Confirm/ }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function fillGate(page: Page, children: { name: string; age: number; allergies?: string }[], parent: string) {
  await expect(page.getByRole('heading', { name: 'Children playing alone', exact: true })).toBeVisible({ timeout: 30_000 });
  const first = page.getByPlaceholder('Full name', { exact: true }).first();
  await first.waitFor();
  const half = halfOf(first);
  const cards = () => half.locator('div.rounded-3xl').filter({ has: page.getByPlaceholder('Full name', { exact: true }) });
  await expect(cards()).toHaveCount(children.length);
  for (let i = 0; i < children.length; i++) {
    const card = cards().nth(i);
    await card.getByPlaceholder('Full name', { exact: true }).fill(children[i]!.name);
    await setAge(page, card, children[i]!.age);
  }
  const cardOf = async (name: string) => {
    for (let i = 0; i < (await cards().count()); i++) {
      if ((await cards().nth(i).getByPlaceholder('Full name', { exact: true }).inputValue()) === name) return cards().nth(i);
    }
    throw new Error(`no card for ${name}`);
  };
  await half.getByPlaceholder('Your full name', { exact: true }).fill(parent);
  for (const child of children) {
    const card = await cardOf(child.name);
    const start = card.getByRole('button', { name: 'Start camera', exact: true });
    if (await start.count()) {
      await start.click();
      await card.getByRole('button', { name: 'Take photo', exact: true }).click();
      await card.getByAltText('Captured', { exact: true }).waitFor();
    }
    if (child.allergies) await card.locator('textarea').first().fill(child.allergies);
  }
  for (const checkbox of await half.getByRole('checkbox').all()) await checkbox.check();
}

/** A camera the consent photo can use, as the smoke's local frame does. */
async function withCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    Object.defineProperty(devices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#285646';
        context.fillRect(0, 0, 320, 240);
        const stream = canvas.captureStream(5);
        const repaint = window.setInterval(() => context.fillRect(0, 0, 320, 240), 100);
        stream.getVideoTracks()[0]!.addEventListener('ended', () => window.clearInterval(repaint), { once: true });
        return stream;
      },
    });
  });
}

// Runs first: the short-drop case below leaves its sale rung up at the payment
// step, and the till resumes such a sale at the next sign-in at this station
// (resumeSale), which would take the screen from under this walk-in.
test('the link stays down past the retries: after Continue again the sale, the cash press and the check-in go online while the lane says box', async ({ page }) => {
  test.skip(!PHONE || !PASSWORD || !process.env.POS_E2E_DATABASE_URL, 'Runs on the isolated harness (e2e/run.mjs)');
  await withCamera(page);

  // What the box is asked to write or price after the link is back, and what the platform answered.
  let restored = false;
  const boxWrites: string[] = [];
  const answered: { path: string; status: number }[] = [];
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!restored || request.method() !== 'POST') return;
    if (/^\/api\/box\/v1\/station\/[^/]+\/intents$/.test(path)) {
      const type = (request.postDataJSON() as { type?: string } | null)?.type ?? '';
      if (/^(member|child|visit|checkin|waiver|sale|cart)\./.test(type)) boxWrites.push(type);
    }
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (!restored || response.request().method() !== 'POST') return;
    if (path === '/api/sales' || /^\/api\/sales\/[^/]+\/finalise$/.test(path) || path === '/api/checkin/check-in-now') {
      answered.push({ path: path.replace(/^\/api\/sales\/[^/]+\//, '/api/sales/:id/'), status: response.status() });
    }
  });

  await signIn(page);
  await walkInByPhone(page, LONG_OUTAGE_DIGITS);
  await setKids(page, 2);
  await fillGate(page, [{ name: 'ZZ TEST Mali 887', age: 7 }, { name: 'ZZ TEST Ton 887', age: 8 }], 'ZZ TEST guardian 887 long');

  // From the registration request on, every /api request reaches nothing, until the till gives up.
  let down = false;
  const outage = async (route: Route) => {
    const request = route.request();
    if (!down && request.method() === 'POST' && new URL(request.url()).pathname === '/api/checkin/registrations') down = true;
    if (down) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  };
  await page.route('**/api/**', outage);
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await expect(page.getByText("Couldn't register these children", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/The connection dropped and has not come back yet/).first()).toBeVisible();
  await shot(page, '887-11-gave-up-press-continue-again');

  // The link is back for the till. The box has not seen it yet: its status
  // read still finds nothing, so the lane stays on the box until it does.
  let probes = 0;
  await page.route('**/api/box/v1/station/*/status', async (route) => {
    probes += 1;
    await route.abort('failed');
  });
  await page.unroute('**/api/**', outage);
  down = false;
  restored = true;
  // The till asks its box for the lane only while it works through the box.
  await expect.poll(() => probes, { timeout: 40_000, message: 'the lane never moved to the box' }).toBeGreaterThan(0);

  const registered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST' && r.status() === 200,
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  const reg = (await (await registered).json()) as { id: string };
  await expect(page.getByTestId('payment-step')).toBeVisible({ timeout: 30_000 });
  // Entering the payment step is the Pay press: the sale is written online.
  await expect.poll(() => answered.filter((a) => a.path === '/api/sales' && a.status === 200).length, { timeout: 30_000 }).toBe(1);
  await expect(page.getByText('This sale has not been saved.')).toHaveCount(0);
  await shot(page, '887-12-payment-online-lane-on-box');

  await page.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = page.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  await expect(page.getByText('Payment Successful', { exact: true })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Check in now', exact: true }).click();
  await expect.poll(() => answered.filter((a) => a.path === '/api/checkin/check-in-now' && a.status === 200).length, { timeout: 30_000 }).toBe(1);
  await shot(page, '887-13-paid-and-checked-in-online');

  // Still on the box lane all along: the box's status was asked again, and it was never asked to price, sell or check in.
  expect(probes).toBeGreaterThan(0);
  expect(boxWrites).toEqual([]);
  expect(answered).toEqual([
    { path: '/api/sales', status: 200 },
    { path: '/api/sales/:id/finalise', status: 200 },
    { path: '/api/checkin/check-in-now', status: 200 },
  ]);
  await expect(page.getByText('Member not found')).toHaveCount(0);
  await expect(page.getByText(/no copy of that child/)).toHaveCount(0);

  // The platform holds the family once, checked in, on one finalised sale.
  const read = await page.request.get(`/api/checkin/registrations/${reg.id}`);
  expect(read.status()).toBe(200);
  const registration = (await read.json()) as { children: { childName: string; status: string }[] };
  expect(registration.children.map((c) => [c.childName, c.status]).sort()).toEqual([
    ['ZZ TEST Mali 887', 'in_park'],
    ['ZZ TEST Ton 887', 'in_park'],
  ]);
  const lookup = await page.request.get(`/api/members/lookup?phone=${encodeURIComponent(`0${LONG_OUTAGE_DIGITS}`)}`);
  const member = (await lookup.json()).member as { children: { name: string }[] };
  expect(member.children.map((c) => c.name).sort()).toEqual(['ZZ TEST Mali 887', 'ZZ TEST Ton 887']);
});

// SCRUM-897 — finishes its sale and checks the family in, so the short-drop
// case below finds nothing rung up at this station.
test('after the long outage the payment step follows the online sale: no counter-box note under Hold sale, and Held sales read again at once', async ({ page }) => {
  test.skip(!PHONE || !PASSWORD || !process.env.POS_E2E_DATABASE_URL, 'Runs on the isolated harness (e2e/run.mjs)');
  await withCamera(page);

  let restored = false;
  const boxWrites: string[] = [];
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!restored || request.method() !== 'POST') return;
    if (/^\/api\/box\/v1\/station\/[^/]+\/intents$/.test(path)) {
      const type = (request.postDataJSON() as { type?: string } | null)?.type ?? '';
      if (/^(member|child|visit|checkin|waiver|sale|cart)\./.test(type)) boxWrites.push(type);
    }
  });

  await signIn(page);
  await walkInByPhone(page, PAYMENT_STEP_DIGITS);
  await setKids(page, 2);
  await fillGate(page, [{ name: 'ZZ TEST Fah 897', age: 6 }, { name: 'ZZ TEST Kai 897', age: 9 }], 'ZZ TEST guardian 897');

  // From the registration request on, every /api request reaches nothing, until the till gives up.
  let down = false;
  const outage = async (route: Route) => {
    const request = route.request();
    if (!down && request.method() === 'POST' && new URL(request.url()).pathname === '/api/checkin/registrations') down = true;
    if (down) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  };
  await page.route('**/api/**', outage);
  // Once armed, the next timed read of the Held sales list fails as well, and
  // after it the platform answers the list again.
  let heldDown = false;
  let heldFailed = false;
  const heldReads = async (route: Route) => {
    if (heldDown) {
      await route.abort('failed');
      heldDown = false;
      heldFailed = true;
      return;
    }
    await route.fallback();
  };
  await page.route((url) => url.pathname === '/api/sales/held', heldReads);
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await expect(page.getByText("Couldn't register these children", { exact: true }).first()).toBeVisible({ timeout: 60_000 });

  // The link is back for the till; the box's status read still finds nothing, so the lane stays on the box.
  let probes = 0;
  await page.route('**/api/box/v1/station/*/status', async (route) => {
    probes += 1;
    await route.abort('failed');
  });
  await page.unroute('**/api/**', outage);
  down = false;
  restored = true;
  await expect.poll(() => probes, { timeout: 40_000, message: 'the lane never moved to the box' }).toBeGreaterThan(0);

  // A timed read of the list fails while the lane is on the box, so the list
  // holds "could not be read" (its panel is drawn with the order, at payment).
  // Its next timed read is 20 seconds away; Continue again is pressed at once.
  heldDown = true;
  await expect.poll(() => heldFailed, { timeout: 30_000, message: 'no timed read of Held sales' }).toBe(true);
  const heldAnswered = page
    .waitForResponse((r) => new URL(r.url()).pathname === '/api/sales/held' && r.status() === 200, { timeout: 10_000 })
    .then(() => true, () => false);

  // Continue again: the family is finished online and the sale is rung up online while the lane says box.
  const sold = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST' && r.status() === 200,
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await expect(page.getByTestId('payment-step')).toBeVisible({ timeout: 30_000 });
  await sold;

  // Checked softly, well inside the 20 seconds before the list's next timed
  // read, so each is reported on its own. The list was read again from the
  // platform the moment it answered the gate: its panel says nothing stale.
  await expect.soft(page.getByText(/Held sales could not be read/)).toHaveCount(0, { timeout: 3_000 });
  expect.soft(await heldAnswered, 'Held sales read again once the platform answered').toBe(true);
  // The sale is online: Hold sale can be pressed, and nothing says the till is working through its box.
  await expect.soft(page.getByRole('button', { name: 'Hold sale', exact: true })).toBeEnabled({ timeout: 10_000 });
  await expect.soft(page.getByText(/working through its counter box/)).toHaveCount(0);
  expect(test.info().errors).toEqual([]);
  await shot(page, '897-01-payment-online-lane-on-box');

  await page.getByRole('heading', { name: 'Cash', exact: true }).first().click();
  const confirm = page.getByRole('button', { name: 'Confirm Payment Received', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  await expect(page.getByText('Payment Successful', { exact: true })).toBeVisible({ timeout: 60_000 });
  const checkedIn = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/checkin/check-in-now' && r.status() === 200,
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Check in now', exact: true }).click();
  await checkedIn;
  await shot(page, '897-02-paid-and-checked-in-online');

  expect(probes).toBeGreaterThan(0);
  expect(boxWrites).toEqual([]);
});

test('the registration request drops after the guardian and children were written: the till retries online and reaches payment', async ({ page }) => {
  test.skip(!PHONE || !PASSWORD || !process.env.POS_E2E_DATABASE_URL, 'Runs on the isolated harness (e2e/run.mjs)');
  await withCamera(page);

  const boxWrites: string[] = [];
  const registrationIds: string[] = [];
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'POST') return;
    if (/^\/api\/box\/v1\/station\/[^/]+\/intents$/.test(path)) {
      const type = (request.postDataJSON() as { type?: string } | null)?.type ?? '';
      if (/^(member|child|visit|checkin|waiver)\./.test(type)) boxWrites.push(type);
    }
    if (path === '/api/checkin/registrations') registrationIds.push(String((request.postDataJSON() as { id?: string }).id));
  });

  await signIn(page);
  await walkInByPhone(page, FAMILY_DIGITS);
  await setKids(page, 2);
  await fillGate(page, [{ name: 'ZZ TEST Bua 887', age: 6, allergies: 'ZZ TEST peanuts' }, { name: 'ZZ TEST Nok 887', age: 9 }], 'ZZ TEST guardian 887');
  await shot(page, '887-01-form-filled');

  // The first registration request reaches nothing, as a dropped link does.
  let aborted = 0;
  await page.route('**/api/checkin/registrations', async (route) => {
    if (route.request().method() === 'POST' && aborted === 0) {
      aborted += 1;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const registered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/checkin/registrations' && r.request().method() === 'POST' && r.status() === 200,
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await expect(page.getByText('Connection dropped — retrying', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, '887-02-connection-dropped-retrying');
  const reg = (await (await registered).json()) as { id: string; memberId: string | null; children: { childId: string | null }[] };
  await expect(page.getByTestId('payment-step')).toBeVisible({ timeout: 30_000 });
  await shot(page, '887-03-payment-reached-online');

  expect(aborted).toBe(1);
  // The same registration both times, on the platform; the box was never asked to write anything.
  expect(new Set(registrationIds)).toEqual(new Set([reg.id]));
  expect(registrationIds.length).toBe(2);
  expect(boxWrites).toEqual([]);
  await expect(page.getByText('Member not found')).toHaveCount(0);
  await expect(page.getByText(/rung up on the counter box/)).toHaveCount(0);

  // The guardian holds each child once, and the registration names those records.
  const lookup = await page.request.get(`/api/members/lookup?phone=${encodeURIComponent(`0${FAMILY_DIGITS}`)}`);
  expect(lookup.status()).toBe(200);
  const member = (await lookup.json()).member as { id: string; children: { id: string; name: string }[] };
  expect(member.children.map((c) => c.name).sort()).toEqual(['ZZ TEST Bua 887', 'ZZ TEST Nok 887']);
  expect(reg.memberId).toBe(member.id);
  const ids = new Set(member.children.map((c) => c.id));
  expect(reg.children.filter((c) => c.childId && ids.has(c.childId))).toHaveLength(reg.children.length);
});
