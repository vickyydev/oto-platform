import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-888 — THE CANCEL BOOKING BUTTON FITS IN THE FAMILY CARD.
 *
 * Found in the SCRUM-871 staging proof (picture 03e): in the Add drop-off
 * child window at 1680 wide, a waiting family's "Cancel booking" (SCRUM-862)
 * was cut off at the card's right edge ("Cancel book"). Radix laid the
 * window's list out as a table as wide as its narrowest possible layout, and
 * a long family name with two buttons beside it made that wider than the
 * window.
 *
 * Two ZZ TEST families wait, registered through the route the till calls: a
 * name as long as the proof's and a short one. At 1680 x 1050 and 1440 x 900
 * on the counter till, and on the phone till, each card sits inside the
 * window and both its buttons inside the card, whole. On the counter the
 * short name keeps the card as it was, one row with the name beside both
 * buttons; the long name stays whole beside Add to sale, and Cancel booking
 * goes under it. On the phone the buttons sit under the name, at the right.
 *
 * Runs on the isolated harness: `pnpm --filter @oto/pos e2e e2e/dropoff-picker-fits.spec.ts`.
 * `POS_E2E_SHOTS` names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const SHOTS = process.env.POS_E2E_SHOTS ?? '';
const BRANCH_CODE = 'hkt-central';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(150_000);

function requireFixture(): void {
  test.skip(!PHONE || !PASSWORD, 'Set POS_E2E_PHONE and POS_E2E_PASSWORD (a reception account)');
}

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
  const ready = () => page.getByText('Membership Check', { exact: true }).or(page.getByRole('heading', { name: 'Tourist', exact: true }));
  await expect.poll(async () => (await picker.isVisible()) || (await ready().first().isVisible()), { timeout: 30_000 }).toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: /Reception Till 1/ }).first().click();
  await expect(ready().first()).toBeVisible({ timeout: 30_000 });
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

/** A family registered for drop-off through the route the till calls; nobody pays. */
async function registerWaiting(page: Page, parentName: string, childName: string): Promise<string> {
  const answer = await page.evaluate(
    async ({ parentName, childName, branchCode }) => {
      const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
      const catalog = await (await fetch(`/api/public/branches/${branchCode}/catalog`)).json();
      const confirmations = catalog.supervision.policy.confirmations
        .filter((c: { required: boolean }) => c.required)
        .map((c: { id: string }) => c.id);
      const registrationId = crypto.randomUUID();
      const res = await fetch('/api/checkin/registrations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s888-${crypto.randomUUID()}` },
        body: JSON.stringify({
          id: registrationId,
          branchId: me.branch.id,
          stationId: me.operatorContext.stationId,
          guardianName: parentName,
          guardianPhone: '0898880888',
          contactChannel: 'whatsapp',
          consentAcknowledged: true,
          acknowledgedConfirmationIds: confirmations,
          children: [
            {
              checkinId: crypto.randomUUID(),
              name: childName,
              ageYears: 5,
              service: 'drop_off',
              allergies: null,
              foodRestrictions: null,
              foodProvision: { mode: 'none', paidSatang: 0 },
            },
          ],
        }),
      });
      if (res.status !== 200) return { error: `registration ${res.status} ${await res.text()}` };
      return { registrationId };
    },
    { parentName, childName, branchCode: BRANCH_CODE },
  );
  expect('error' in answer ? answer.error : null).toBeNull();
  return (answer as { registrationId: string }).registrationId;
}

/** Each case leaves the list as it found it: its families are cancelled. */
async function cancelWaiting(page: Page, registrationIds: string[]): Promise<void> {
  for (const id of registrationIds) {
    await page.request.post(`/api/checkin/registrations/${id}/cancel`, {
      data: { reason: 'ZZ TEST SCRUM-888 layout check' },
      headers: { 'Idempotency-Key': `s888-cancel-${crypto.randomUUID()}` },
    }).catch(() => undefined);
  }
}

interface Box { left: number; right: number; top: number; bottom: number }
interface CardFit {
  window: Box;
  list: Box;
  card: Box;
  name: Box & { whole: boolean };
  add: Box & { whole: boolean };
  cancel: Box & { whole: boolean };
}

/** Where the card, its name and its two buttons are drawn, read from the page. */
async function measure(card: Locator): Promise<CardFit> {
  return card.evaluate((element) => {
    const box = (node: Element): Box => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const button = (words: string) => {
      const found = [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === words);
      if (!found) throw new Error(`No "${words}" button on the card`);
      return { ...box(found), whole: found.scrollWidth <= found.clientWidth + 1 };
    };
    const name = element.querySelector('.font-bold.truncate');
    if (!name) throw new Error('No family name on the card');
    return {
      window: box(element.closest('[role="dialog"]')!),
      list: box(element.closest('[data-radix-scroll-area-viewport]')!),
      card: box(element),
      name: { ...box(name), whole: name.scrollWidth <= name.clientWidth + 1 },
      add: button('Add to sale'),
      cancel: button('Cancel booking'),
    };
  });
}

/** Inside the card's padding (p-4 is 16 px), the card inside the list, the list inside the window. */
function expectFits(fit: CardFit, label: string): void {
  expect(fit.card.right, `${label}: card right edge inside the list`).toBeLessThanOrEqual(fit.list.right + 0.5);
  expect(fit.card.left, `${label}: card left edge inside the list`).toBeGreaterThanOrEqual(fit.list.left - 0.5);
  expect(fit.list.right, `${label}: list inside the window`).toBeLessThanOrEqual(fit.window.right + 0.5);
  for (const [name, button] of [['Add to sale', fit.add], ['Cancel booking', fit.cancel]] as const) {
    expect(button.right, `${label}: ${name} inside the card`).toBeLessThanOrEqual(fit.card.right - 16 + 1);
    expect(button.left, `${label}: ${name} inside the card`).toBeGreaterThanOrEqual(fit.card.left + 16 - 1);
    expect(button.whole, `${label}: ${name} reads whole`).toBe(true);
  }
}

/** The family's card in the window, by its name and its Add sibling button. */
function cardOf(windowLocator: Locator, page: Page, parent: string): Locator {
  return windowLocator
    .locator('div')
    .filter({ hasText: `${parent}'s booking` })
    .filter({ has: page.getByRole('button', { name: 'Add sibling' }) })
    .last();
}

const suffix = Date.now().toString(36).slice(-4);

for (const size of [
  { width: 1680, height: 1050, till: 'counter', code: 'a' },
  { width: 1440, height: 900, till: 'counter', code: 'b' },
  { width: 390, height: 844, till: 'phone', code: 'c' },
] as const) {
  test(`${size.till} till at ${size.width} x ${size.height}: Cancel booking fits inside the family card`, async ({ page }) => {
    requireFixture();
    await page.setViewportSize({ width: size.width, height: size.height });
    await signIn(page);
    // As long as the proof's "ZZ TEST SCRUM-871 guardian nanny05", and this run's own.
    const tag = `${suffix}${size.code}`;
    const long = `ZZ TEST SCRUM-888 guardian n${tag}`;
    const short = `ZZ TEST Ploy ${tag}`;
    const waiting: string[] = [];
    try {
      waiting.push(await registerWaiting(page, long, `ZZ TEST Kai 888-${tag}`));
      waiting.push(await registerWaiting(page, short, `ZZ TEST Mint 888-${tag}`));

      if (size.till === 'counter') await walkInByPhone(page, `81288${String(size.width).padStart(4, '0')}`);
      await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
      await page.getByRole('button', { name: 'Add drop-off child' }).click();
      const picker = page.getByRole('dialog').filter({ hasText: 'Add drop-off child' });
      const longCard = cardOf(picker, page, long);
      const shortCard = cardOf(picker, page, short);
      await expect(longCard.getByRole('button', { name: 'Cancel booking' })).toBeVisible({ timeout: 20_000 });
      await expect(shortCard.getByRole('button', { name: 'Cancel booking' })).toBeVisible();
      // The window's entrance animation scales it; read the boxes once it has settled.
      await expect.poll(() => picker.evaluate((el) => getComputedStyle(el).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, [^)]*\))$/);

      // The station's "… is yours" note closes on its own; the picture is of the window.
      await expect(page.getByText(/ is yours$/)).toHaveCount(0, { timeout: 15_000 });
      const longFit = await measure(longCard);
      const shortFit = await measure(shortCard);
      expectFits(longFit, 'long name');
      expectFits(shortFit, 'short name');

      expect(shortFit.name.whole, 'short name: the name reads whole').toBe(true);
      if (size.till === 'counter') {
        // The short name keeps the card's one row: the name beside both buttons.
        expect(Math.abs(shortFit.cancel.top - shortFit.add.top), 'short name: both buttons on one row').toBeLessThanOrEqual(1);
        expect(Math.abs(shortFit.add.top - shortFit.name.top), 'short name: the buttons on the row of the name').toBeLessThanOrEqual(8);
        expect(shortFit.add.left, 'short name: the buttons to the right of the name').toBeGreaterThan(shortFit.name.right);
        // The proof's long name stays whole, Add to sale keeps its place beside it,
        // and Cancel booking goes under Add to sale, at the same right edge.
        expect(longFit.name.whole, 'long name: the name reads whole').toBe(true);
        expect(longFit.add.left, 'long name: Add to sale stays to the right of the name').toBeGreaterThan(longFit.name.right);
        expect(Math.abs(longFit.add.top - longFit.name.top), 'long name: Add to sale on the row of the name').toBeLessThanOrEqual(8);
        expect(longFit.cancel.top, 'long name: Cancel booking under Add to sale').toBeGreaterThanOrEqual(longFit.add.bottom - 1);
        expect(Math.abs(longFit.cancel.right - longFit.add.right), 'long name: both at the right edge').toBeLessThanOrEqual(1);
      } else {
        // The phone till: the buttons under the name, side by side, at the card's right.
        for (const [label, fit] of [['short name', shortFit], ['long name', longFit]] as const) {
          expect(fit.add.top, `${label}: the buttons under the name`).toBeGreaterThanOrEqual(fit.name.bottom);
          expect(Math.abs(fit.cancel.top - fit.add.top), `${label}: both buttons on one row`).toBeLessThanOrEqual(1);
          expect(fit.cancel.right, `${label}: at the card's right`).toBeGreaterThanOrEqual(fit.card.right - 16 - 1);
        }
      }

      await longCard.scrollIntoViewIfNeeded();
      await shot(page, `888-add-dropoff-child-${size.till}-${size.width}x${size.height}`);
    } finally {
      await cancelWaiting(page, waiting);
      await signOut(page);
    }
  });
}
