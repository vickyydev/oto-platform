import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
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
 * `pnpm --filter @oto/pos e2e e2e/dropoff-connection-drop.spec.ts`;
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const FAMILY_DIGITS = '898870001';

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

test('the registration request drops after the guardian and children were written: the till retries online and reaches payment', async ({ page }) => {
  test.skip(!PHONE || !PASSWORD || !process.env.POS_E2E_DATABASE_URL, 'Runs on the isolated harness (e2e/run.mjs)');
  // A camera the consent photo can use, as the smoke's local frame does.
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
