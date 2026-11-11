import { expect, request, test, type Browser, type Page } from '@playwright/test';
import { chooseLanguageFirst } from './walk-in';

/**
 * SCRUM-869 / SCRUM-870 — THE PAIRED DISPLAY THROUGH AN ORDER'S EDITS, AND
 * WHEN STAFF LEAVE THE TICKETS TAB.
 *
 * A till page and a separate, paired display page on one station.
 *
 *   - Three quick edits of the ticket order (each re-priced by the platform)
 *     never show the display its welcome screen, and never flip the staff
 *     layout to the split view: every frame published at the order stage is a
 *     priced order the display can draw (SCRUM-869).
 *   - Staff tapping Today give the station up, and the display returns to its
 *     welcome screen with nothing on it to answer; Tickets again puts the
 *     till's first screen back on it (SCRUM-870).
 *
 * Runs on the isolated harness:
 * `POS_E2E_BROWSER=chromium POS_E2E_BUILT=1 pnpm --filter @oto/pos e2e e2e/display-order-hold.spec.ts`
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const STATION_NAME = 'Reception Till 1';
/** A ZZ TEST number: the family at the counter, who is not a member. */
const FAMILY_PHONE = '0898690001';
const IDLE_LINE = 'Please follow the staff screen.';

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(180_000);

function requireLocalFixture(baseURL: string | undefined): asserts baseURL is string {
  if (process.env.POS_E2E_DATABASE_URL && (!PHONE || !PASSWORD || !ADMIN_PHONE || !ADMIN_PASSWORD)) {
    throw new Error('The isolated till harness must supply all four sign-in settings');
  }
  test.skip(!PHONE || !PASSWORD || !ADMIN_PHONE || !ADMIN_PASSWORD,
    'Set POS_E2E_PHONE, POS_E2E_PASSWORD, POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD');
  test.skip(!baseURL || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname),
    'This flow requires a disposable seeded local API');
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
  await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD);
  const signedIn = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-in') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await signedIn).status(), 'The real staff sign-in must succeed').toBe(200);
  const picker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect.poll(async () => (await picker.isVisible()) || (await page.getByText('Membership Check', { exact: true }).isVisible()),
    { timeout: 30_000 }).toBe(true);
  if (await picker.isVisible()) await page.getByRole('button', { name: new RegExp(STATION_NAME) }).click();
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });
}

/** A separate display paired to the staff page's station, through the Console's pairing. */
async function pairDisplay(browser: Browser, staff: Page, baseURL: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 } });
  const display = await context.newPage();
  const admin = await request.newContext({ baseURL });
  let credentialId: string | null = null;
  let stationId: string | null = null;
  /** The till's own lease, read off its claims, so the cleanup can give the station up by name. */
  let ownLeaseId: string | null = null;
  const observeLease = (response: import('@playwright/test').Response) => {
    if (!stationId || response.url().split('?')[0] !== new URL(`/api/box/v1/station/${stationId}/lease`, baseURL).href
      || response.request().method() !== 'POST' || response.status() !== 200) return;
    void response.json().then(body => { if (typeof body.lease?.leaseId === 'string') ownLeaseId = body.lease.leaseId; }).catch(() => undefined);
  };
  staff.on('response', observeLease);
  const releaseLease = async () => {
    if (!stationId || !ownLeaseId) return;
    const response = await staff.request.post(`/api/box/v1/station/${stationId}/lease/release`, {
      data: { leaseId: ownLeaseId }, headers: { 'Idempotency-Key': `display-hold-release-${crypto.randomUUID()}` },
    });
    expect(response.status()).toBe(200);
    ownLeaseId = null;
  };
  const cleanup = async () => {
    staff.off('response', observeLease);
    try {
      if (credentialId) {
        const revoked = await admin.post(`/api/credentials/${credentialId}/revoke`, {
          data: { reason: 'Local display order-hold check cleanup' },
          headers: { 'Idempotency-Key': `display-hold-revoke-${crypto.randomUUID()}` },
        });
        expect(revoked.status()).toBe(200);
      }
    } finally {
      await display.evaluate(async () => {
        const bearer = localStorage.getItem('oto.display.credential');
        if (bearer) await fetch('/api/display/pairing/expire', { method: 'POST', credentials: 'omit',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}' });
      }).catch(() => undefined);
      await display.goto('about:blank').catch(() => undefined);
      await context.close();
      await admin.post('/api/auth/sign-out').catch(() => undefined);
      await admin.dispose();
    }
  };
  try {
    expect((await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } })).status()).toBe(200);
    const link = await (await staff.request.get('/api/me/station/link')).json();
    expect(typeof link.stationId === 'string' && typeof link.boxId === 'string').toBe(true);
    stationId = link.stationId as string;
    expect((await admin.put('/api/me/session/station', { data: { stationId },
      headers: { 'Idempotency-Key': `display-hold-station-${crypto.randomUUID()}` } })).status()).toBe(200);
    await display.goto('/display');
    await expect(display.getByRole('heading', { name: 'Set up this display' })).toBeVisible();
    const code = await display.getByTestId('display-pairing-code').textContent();
    expect(typeof code === 'string' && /^\d{6}$/.test(code)).toBe(true);
    const published = staff.waitForResponse(response => response.url().endsWith(`/api/box/v1/station/${stationId}/intents`)
      && response.request().method() === 'POST' && response.status() === 200
      && response.request().postDataJSON()?.type === 'session.publish_display'
      && response.request().postDataJSON()?.payload?.stage === 'identify').catch(() => null);
    const claimed = await admin.post(`/api/stations/${stationId}/displays/claim`, {
      data: { pairingCode: code, name: `Local hold check display ${crypto.randomUUID().slice(0, 8)}` },
      headers: { 'Idempotency-Key': `display-hold-claim-${crypto.randomUUID()}` },
    });
    expect(claimed.status()).toBe(200);
    credentialId = (await claimed.json()).device.id as string;
    expect(await published, 'The staff till publishes its first screen to the paired display').not.toBeNull();
    await expect(display.getByTestId('display-station')).toContainText(STATION_NAME, { timeout: 20_000 });
    await expect(display.getByTestId('language-choice')).toBeVisible({ timeout: 20_000 });
    return { display, stationId, cleanup, releaseLease };
  } catch (error) {
    try { await releaseLease(); } finally { await cleanup(); }
    throw error;
  }
}

/** Count, from now on, every time `text` appears in the page: a flash the eye would catch. */
async function watchForText(page: Page, text: string): Promise<() => Promise<number>> {
  await page.evaluate((needle) => {
    const w = window as unknown as { __seen: number; __shown: boolean };
    w.__seen = 0;
    w.__shown = document.body.innerText.includes(needle);
    new MutationObserver(() => {
      const now = document.body.innerText.includes(needle);
      if (now && !w.__shown) w.__seen += 1;
      w.__shown = now;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, text);
  return () => page.evaluate(() => (window as unknown as { __seen: number }).__seen);
}

/** Count, from now on, every time the staff column leaves full width for the split view. */
async function watchForSplit(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __split: number };
    w.__split = 0;
    const column = [...document.querySelectorAll('div')].find(div => div.className === 'w-full h-full min-w-0');
    if (!column) throw new Error('the staff column is not at full width to begin with');
    new MutationObserver(() => { if (column.className.includes('w-1/2')) w.__split += 1; })
      .observe(column, { attributes: true, attributeFilter: ['class'] });
  });
  return () => page.evaluate(() => (window as unknown as { __split: number }).__split);
}

test('three quick edits keep the order on the paired display; Today returns it to welcome', async ({ page, browser, baseURL }) => {
  requireLocalFixture(baseURL);
  await signIn(page);
  const fixture = await pairDisplay(browser, page, baseURL);
  const { display, stationId } = fixture;
  const frames: Array<{ stage: string; cart: { supported?: boolean } | null }> = [];
  page.on('request', req => {
    if (!req.url().endsWith(`/api/box/v1/station/${stationId}/intents`) || req.method() !== 'POST') return;
    const body = req.postDataJSON();
    if (body?.type === 'session.publish_display') frames.push(body.payload);
  });
  try {
    // The family at the display: their language, then their number.
    await chooseLanguageFirst(display, 'en');
    for (const digit of FAMILY_PHONE) await display.getByRole('button', { name: digit, exact: true }).click();
    const answered = display.waitForResponse(response => response.url().endsWith('/display/intents')
      && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'display.identify');
    await display.getByRole('button', { name: 'Continue', exact: true }).click();
    expect((await answered).status()).toBe(200);
    const offer = page.getByRole('button', { name: 'Continue as walk-in', exact: true });
    const tiers = page.getByRole('heading', { name: 'Tourist', exact: true });
    await expect.poll(async () => (await offer.isVisible()) || (await tiers.isVisible()), { timeout: 20_000 }).toBe(true);
    if (await offer.isVisible()) await offer.click();

    // A ticket on the till: the display shows the priced order.
    await tiers.click();
    await page.getByRole('heading', { name: '1 Hour Play', exact: true }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: /^Configure:/ })).toBeVisible({ timeout: 15_000 });
    await expect(display.getByText('Your Order', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(display.getByText(IDLE_LINE, { exact: true })).toHaveCount(0);

    // SCRUM-869 — three edits, each re-priced by the platform.
    const idleFlashes = await watchForText(display, IDLE_LINE);
    const splits = await watchForSplit(page);
    const order = page.getByRole('heading', { name: 'Current Order' }).locator('../..');
    const before = frames.length;
    for (const label of ['Kids', 'Adults', 'Kids'] as const) {
      const republished = page.waitForResponse(response => response.url().endsWith(`/api/box/v1/station/${stationId}/intents`)
        && response.request().method() === 'POST' && response.status() === 200
        && response.request().postDataJSON()?.type === 'session.publish_display'
        && response.request().postDataJSON()?.payload?.stage === 'order');
      await order.getByRole('button', { name: `Add one ${label}` }).first().click();
      await republished;
    }
    await expect(display.getByText('Your Order', { exact: true })).toBeVisible();
    expect(await idleFlashes(), 'the display never showed its welcome screen between two quotes').toBe(0);
    expect(await splits(), 'the staff layout never jumped to the split view').toBe(0);
    const edited = frames.slice(before);
    expect(edited.length).toBeGreaterThanOrEqual(3);
    for (const frame of edited) {
      expect(frame.stage).toBe('order');
      expect(frame.cart?.supported).toBe(true);
    }

    // SCRUM-870 — staff tap Today: the station is given up and the display returns to welcome.
    const released = page.waitForResponse(response => response.url().endsWith(`/api/box/v1/station/${stationId}/lease/release`)
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    expect((await released).status()).toBe(200);
    await expect(display.getByRole('heading', { name: 'Welcome to OTO Park', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(display.getByText(IDLE_LINE, { exact: true })).toBeVisible();
    await expect(display.getByText('Your Order', { exact: true })).toHaveCount(0);
    await expect(display.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);

    // Back to Tickets: the till takes the station again and its first screen is on the display.
    const republished = page.waitForResponse(response => response.url().endsWith(`/api/box/v1/station/${stationId}/intents`)
      && response.request().method() === 'POST' && response.status() === 200
      && response.request().postDataJSON()?.type === 'session.publish_display'
      && response.request().postDataJSON()?.payload?.stage === 'identify');
    await page.getByRole('button', { name: 'Tickets', exact: true }).click();
    await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });
    await republished;
    await expect(display.getByTestId('language-choice')).toBeVisible({ timeout: 20_000 });
    await expect(display.getByRole('heading', { name: 'Welcome to OTO Park', exact: true })).toHaveCount(0);
  } finally {
    try {
      await page.goto('about:blank').catch(() => undefined);
      await fixture.releaseLease();
    } finally {
      try { await fixture.cleanup(); } finally {
        await page.request.post('/api/auth/sign-out').catch(() => undefined);
      }
    }
  }
});
