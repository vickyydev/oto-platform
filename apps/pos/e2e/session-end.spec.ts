import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkInByPhone } from './walk-in';

/**
 * SCRUM-878 — A STAFF SESSION THAT ENDS DURING A LONG SHIFT KEEPS THE SALE AND
 * SAYS WHAT HAPPENED.
 *
 * On the real till against the isolated harness (`e2e/run.mjs`): reception
 * starts a ticket cart for a walk-in, and the platform ends the session behind
 * it — through its own "Sign out everywhere" route for the account, never a
 * database write. The till's minute heartbeat is refused (sent at once here by
 * the browser's own `online` event, which the heartbeat listens for), and the
 * till must:
 *
 *  - keep the cart under the lock and draw nothing of it;
 *  - show the sign-in form with one line saying the session ended — "after
 *    twelve hours" when the page's own clock is past the end `/me` gave
 *    (moved with Playwright's clock, never waited out), "has ended" when it
 *    was ended earlier;
 *  - bring the same cart back when the same person signs in again, at the
 *    same station, with no picker;
 *  - offer it to a different person who may sell — who started it and when —
 *    to continue (their sale from the next press) or to discard.
 *
 * `pnpm --filter @oto/pos e2e e2e/session-end.spec.ts`; `POS_E2E_EVIDENCE_DIR`
 * names a folder to keep the screens in.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const STATION = /Reception Till 1/;
const PICKER = 'Which station are you on?';
const PACKAGE = '2 Hours Play';
const TWELVE_HOURS_MS = 12 * 3_600_000;

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(240_000);

function requireLocalFixture(baseURL: string | undefined): asserts baseURL is string {
  if (process.env.POS_E2E_DATABASE_URL && (!PHONE || !PASSWORD || !ADMIN_PHONE || !ADMIN_PASSWORD)) {
    throw new Error('The isolated till harness must supply all four sign-in settings');
  }
  test.skip(!PHONE || !PASSWORD || !ADMIN_PHONE || !ADMIN_PASSWORD,
    'Set POS_E2E_PHONE, POS_E2E_PASSWORD, POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD');
  test.skip(!baseURL || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname),
    'This flow requires a disposable seeded local API');
}

async function capture(page: Page, name: string): Promise<void> {
  const directory = process.env.POS_E2E_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name), fullPage: true, mask: [page.locator('input[type="password"]')] });
}

/** The sign-in form, as the lock screen draws it. */
async function signInOnTheForm(page: Page, phone: string, password: string): Promise<void> {
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(phone);
  await page.locator('input[type="password"]').first().fill(password);
  const signedIn = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-in')
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await signedIn).status()).toBe(200);
}

/** Reception at Reception Till 1 with a walk-in's ticket cart on screen. */
async function cartOnScreen(page: Page, digits: string): Promise<{ accountId: string }> {
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible({ timeout: 30_000 });
  await signInOnTheForm(page, PHONE, PASSWORD);
  const picker = page.getByRole('heading', { name: PICKER });
  const till = page.getByText('Membership Check', { exact: true });
  await expect.poll(async () => (await picker.isVisible()) || (await till.isVisible()), { timeout: 30_000 }).toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: STATION }).first().click();
  await expect(till).toBeVisible({ timeout: 30_000 });
  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(200);
  const body = await me.json() as { account: { id: string }; sessionEnd: { inSeconds: number; afterHours: number } | null };
  expect(body.sessionEnd?.afterHours).toBe(12);

  await walkInByPhone(page, digits);
  await page.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await page.getByRole('heading', { name: PACKAGE }).click();
  await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^Pay ฿/ })).toBeEnabled({ timeout: 20_000 });
  return { accountId: body.account.id };
}

/** "Sign out everywhere" for the account, as a manager presses it in the Console. */
async function endSessionsOf(admin: APIRequestContext, accountId: string): Promise<void> {
  const signedIn = await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } });
  expect(signedIn.status()).toBe(200);
  const ended = await admin.post(`/api/accounts/${accountId}/sessions/revoke`, {
    headers: { 'Idempotency-Key': `s878-revoke-${crypto.randomUUID()}` },
  });
  expect(ended.status(), await ended.text()).toBe(200);
  expect((await ended.json() as { sessionsEnded: number }).sessionsEnded).toBeGreaterThanOrEqual(1);
}

/** The till's heartbeat, sent now: the browser's `online` event is one of its triggers. */
async function heartbeatNow(page: Page): Promise<void> {
  const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/station/heartbeat',
    { timeout: 20_000 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect((await refused).status()).toBe(401);
}

/** Nothing of the cart is on the page while nobody is signed in. */
async function nothingOfTheSale(page: Page): Promise<void> {
  await expect(page.getByText(PACKAGE)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Pay ฿/ })).toHaveCount(0);
  expect((await page.content()).includes(PACKAGE)).toBe(false);
}

test('SCRUM-878: the twelve-hour mark mid-cart — the sign-in says why, and the same person gets the same cart back', async ({ page, baseURL }) => {
  requireLocalFixture(baseURL);
  const admin = await request.newContext({ baseURL });
  const picks: string[] = [];
  page.on('request', sent => {
    if (sent.method() === 'PUT' && new URL(sent.url()).pathname === '/api/me/session/station') picks.push(sent.url());
  });
  try {
    const { accountId } = await cartOnScreen(page, '812087801');
    await capture(page, '1-cart-on-screen.png');

    // The session ends on the platform, and the page's clock is past the end /me gave.
    await endSessionsOf(admin, accountId);
    const now = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(now + TWELVE_HOURS_MS + 60_000);
    await heartbeatNow(page);

    const line = page.getByTestId('lock-session-ended');
    await expect(line).toBeVisible({ timeout: 15_000 });
    await expect(line).toHaveText(/^The session of .+ ended after twelve hours\. Sign in again to carry on\. The sale in progress is kept on this till\.$/);
    await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
    await expect(page.getByText('still signed in')).toHaveCount(0);
    await nothingOfTheSale(page);
    await capture(page, '2-session-ended-sign-in.png');

    picks.length = 0;
    await signInOnTheForm(page, PHONE, PASSWORD);
    // The same cart, at the same station, with no picker on the way.
    await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(PACKAGE).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pay ฿/ })).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: PICKER })).toHaveCount(0);
    await expect(page.getByTestId('lock-session-ended')).toHaveCount(0);
    await expect.poll(() => picks.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await capture(page, '3-same-cart-back.png');
  } finally {
    await page.request.post('/api/auth/sign-out').catch(() => undefined);
    await admin.post('/api/auth/sign-out').catch(() => undefined);
    await admin.dispose();
  }
});

test('SCRUM-878: a locked till at the end — the right password is not answered "Not signed in"', async ({ page, baseURL }) => {
  requireLocalFixture(baseURL);
  const admin = await request.newContext({ baseURL });
  try {
    const { accountId } = await cartOnScreen(page, '812087802');
    await page.getByRole('button', { name: 'Lock screen' }).click();
    await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible({ timeout: 15_000 });

    await endSessionsOf(admin, accountId);
    const now = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(now + TWELVE_HOURS_MS + 60_000);
    // The password typed and Unlock pressed before the next heartbeat lands.
    await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD);
    const unlock = page.waitForResponse(response => response.url().endsWith('/api/auth/unlock')
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    expect((await unlock).status()).toBe(401);
    await expect(page.getByTestId('lock-session-ended')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('lock-session-ended')).toContainText('ended after twelve hours');
    await expect(page.getByText('Not signed in', { exact: true })).toHaveCount(0);
    await expect(page.getByText('still signed in')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toHaveCount(0);
    await nothingOfTheSale(page);
    await capture(page, '4-locked-unlock-says-ended.png');

    await signInOnTheForm(page, PHONE, PASSWORD);
    await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(PACKAGE).first()).toBeVisible();
  } finally {
    await page.request.post('/api/auth/sign-out').catch(() => undefined);
    await admin.post('/api/auth/sign-out').catch(() => undefined);
    await admin.dispose();
  }
});

test('SCRUM-878: a different person who may sell is offered the cart, and it is theirs from the next press', async ({ page, baseURL }) => {
  requireLocalFixture(baseURL);
  const admin = await request.newContext({ baseURL });
  try {
    const { accountId } = await cartOnScreen(page, '812087803');
    // Ended earlier than its twelve hours ("Sign out everywhere"): it has ended.
    await endSessionsOf(admin, accountId);
    await heartbeatNow(page);
    await expect(page.getByTestId('lock-session-ended')).toHaveText(
      /^The session of .+ has ended\. Sign in again to carry on\. The sale in progress is kept on this till\.$/,
      { timeout: 15_000 });
    await nothingOfTheSale(page);

    // The manager signs in at the same till.
    await signInOnTheForm(page, ADMIN_PHONE.replace(/^\+66/, ''), ADMIN_PASSWORD);
    await expect(page.getByRole('heading', { name: 'A sale is open on this till' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('kept-sale-offer')).toHaveText(/^.+ started this sale at \d\d:\d\d\. The session of .+ ended at \d\d:\d\d\.$/);
    // Still nothing of the sale on the page until they choose.
    await nothingOfTheSale(page);
    await capture(page, '5-offer-to-the-next-person.png');

    await page.getByRole('button', { name: 'Continue this sale', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(PACKAGE).first()).toBeVisible();
    const me = await page.request.get('/api/me');
    const managerId = ((await me.json()) as { account: { id: string } }).account.id;
    expect(managerId).not.toBe(accountId);

    // Rung up from here, the sale is the manager's.
    const written = page.waitForResponse(r => new URL(r.url()).pathname === '/api/sales' && r.request().method() === 'POST',
      { timeout: 30_000 });
    await page.getByRole('button', { name: /^Pay ฿/ }).click();
    // A walk-in hands the display over for a phone number; Done hands it back.
    const done = page.getByRole('button', { name: 'Done', exact: true });
    const due = page.getByRole('heading', { name: 'Amount Due' });
    await expect.poll(async () => (await done.isVisible()) || (await due.isVisible()), { timeout: 20_000 }).toBe(true);
    if (await done.isVisible()) await done.click();
    const sale = (await (await written).json()) as { sale: { id: string; status: string; soldBy?: { accountId: string } | null } };
    expect(sale.sale.status).toBe('tendering');
    // The sales list is the read that names who sold each sale.
    const listed = await page.request.get('/api/sales?limit=50');
    expect(listed.status()).toBe(200);
    const row = ((await listed.json()) as { sales: Array<{ id: string; soldBy: { accountId: string } | null }> }).sales
      .find(candidate => candidate.id === sale.sale.id);
    expect(row?.soldBy?.accountId).toBe(managerId);
    await capture(page, '6-continued-and-rung-up.png');
  } finally {
    await page.request.post('/api/auth/sign-out').catch(() => undefined);
    await admin.post('/api/auth/sign-out').catch(() => undefined);
    await admin.dispose();
  }
});

test.describe('the phone till', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('SCRUM-878: on the phone till the cart is kept the same way, and comes back for the same person', async ({ page, baseURL }) => {
    requireLocalFixture(baseURL);
    const admin = await request.newContext({ baseURL });
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible({ timeout: 30_000 });
      await signInOnTheForm(page, PHONE, PASSWORD);
      const picker = page.getByRole('heading', { name: PICKER });
      const tourist = page.getByRole('heading', { name: 'Tourist', exact: true });
      await expect.poll(async () => (await picker.isVisible()) || (await tourist.isVisible()), { timeout: 30_000 }).toBe(true);
      if (await picker.isVisible()) await page.getByRole('button', { name: STATION }).first().click();
      await expect(tourist).toBeVisible({ timeout: 30_000 });
      const me = await page.request.get('/api/me');
      const accountId = ((await me.json()) as { account: { id: string } }).account.id;

      // The phone's ticket cart: a package and more children on it.
      await tourist.click();
      await page.getByText('1 Hour Play', { exact: true }).click();
      const configure = page.getByRole('heading', { name: 'Configure: 1 Hour Play' });
      await expect(configure).toBeVisible({ timeout: 15_000 });
      const addKid = page.getByRole('button', { name: 'Add one Kids', exact: true });
      await addKid.click();
      await addKid.click();
      const kids = page.getByRole('button', { name: 'Remove one Kids', exact: true }).locator('xpath=following-sibling::span[1]');
      const counted = (await kids.textContent())?.trim() ?? '';
      expect(Number(counted)).toBeGreaterThanOrEqual(2);
      // The cart button names its items and its amount.
      const cart = page.getByRole('button', { name: /^Open cart/ });
      await expect(cart).toContainText('฿', { timeout: 20_000 });
      const cartSaid = (await cart.textContent())?.trim() ?? '';
      await capture(page, '7-phone-cart.png');

      await endSessionsOf(admin, accountId);
      await heartbeatNow(page);
      await expect(page.getByTestId('lock-session-ended')).toHaveText(
        /^The session of .+ has ended\. Sign in again to carry on\. The sale in progress is kept on this till\.$/,
        { timeout: 15_000 });
      // Nothing of the cart on the page while nobody is signed in.
      await expect(configure).toHaveCount(0);
      await expect(cart).toHaveCount(0);
      await expect(addKid).toHaveCount(0);
      expect((await page.content()).includes('1 Hour Play')).toBe(false);
      await capture(page, '8-phone-session-ended.png');

      await signInOnTheForm(page, PHONE, PASSWORD);
      // The same cart, the same children, the same amount, at the same station with no picker.
      await expect(configure).toBeVisible({ timeout: 30_000 });
      await expect(kids).toHaveText(counted);
      await expect(cart).toHaveText(cartSaid);
      await expect(page.getByRole('heading', { name: PICKER })).toHaveCount(0);
      await expect(page.getByTestId('lock-session-ended')).toHaveCount(0);
      await capture(page, '9-phone-same-cart-back.png');
    } finally {
      await page.request.post('/api/auth/sign-out').catch(() => undefined);
      await admin.post('/api/auth/sign-out').catch(() => undefined);
      await admin.dispose();
    }
  });
});

test('SCRUM-878: the next person may discard it and start a new sale', async ({ page, baseURL }) => {
  requireLocalFixture(baseURL);
  const admin = await request.newContext({ baseURL });
  try {
    const { accountId } = await cartOnScreen(page, '812087804');
    await endSessionsOf(admin, accountId);
    await heartbeatNow(page);
    await expect(page.getByTestId('lock-session-ended')).toBeVisible({ timeout: 15_000 });
    await signInOnTheForm(page, ADMIN_PHONE.replace(/^\+66/, ''), ADMIN_PASSWORD);
    await expect(page.getByRole('heading', { name: 'A sale is open on this till' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Discard it and start a new sale', exact: true }).click();
    await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(PACKAGE)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Configure:/ })).toHaveCount(0);
  } finally {
    await page.request.post('/api/auth/sign-out').catch(() => undefined);
    await admin.post('/api/auth/sign-out').catch(() => undefined);
    await admin.dispose();
  }
});
