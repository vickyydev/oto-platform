import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * SCRUM-744 — A TILL LOCKED BY THE INACTIVITY TIMEOUT, THEN RELOADED.
 *
 * The lock and the unlock are the prototype's and stay as they are. What this
 * pins is the reload in between: the page comes back at the lock screen, and
 * once the password is entered the till is back on the station it had — not
 * at "Which station are you on?" with the lock's refusal printed on it.
 *
 * The till is a ZZ TEST station on the seed's virtual box, as on staging, and
 * the run is made at desktop and at phone width. Everything is local: the
 * isolated harness (`e2e/run.mjs`) owns the database, the api and the accounts.
 */

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const PICKER = 'Which station are you on?';
const LOCKED_LINE = 'This session is locked';
const VIRTUAL_BOX = 'Virtual box 1';

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

async function capture(page: Page, name: string): Promise<void> {
  const directory = process.env.POS_E2E_EVIDENCE_DIR;
  if (!directory) return;
  // A screen taken while it is still fading in shows half of it.
  await expect.poll(() => page.evaluate(() => document.body.getAnimations({ subtree: true })
    .every(animation => animation.effect?.getComputedTiming().iterations === Infinity
      || !animation.pending && animation.playState !== 'running')), { timeout: 5000 }).toBe(true);
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => {
    const stamp = document.createElement('div');
    stamp.dataset.localCheck = 'true';
    stamp.textContent = 'LOCAL CHECK';
    stamp.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 12px;background:#111;color:#fff;font:700 14px sans-serif';
    document.body.append(stamp);
  });
  try {
    await page.screenshot({ path: resolve(directory, name), fullPage: true, mask: [page.locator('input[type="password"]')] });
  } finally {
    await page.locator('[data-local-check="true"]').evaluateAll(elements => elements.forEach(element => element.remove()));
  }
}

/** A ZZ TEST till on the branch's virtual box, made by the local administrator. */
async function zzTestTill(admin: APIRequestContext, branchId: string, name: string): Promise<string> {
  const boxes = await admin.get(`/api/branches/${branchId}/boxes`);
  expect(boxes.status()).toBe(200);
  const box = ((await boxes.json()).boxes as Array<{ id: string; name: string; role: string }>)
    .find(candidate => candidate.name === VIRTUAL_BOX && candidate.role === 'virtual');
  if (!box) throw new Error(`${VIRTUAL_BOX} is not seeded at the staff branch`);
  const created = await admin.post(`/api/branches/${branchId}/stations`, {
    // A till is ready to sell with a receipt prefix (a random one keeps two runs
    // apart) and card and QR taken by hand, since this till has no terminal.
    data: {
      name, kind: 'till', boxId: box.id, capabilities: ['tickets', 'fnb'], accessScope: 'all_staff',
      codePrefix: `Z${crypto.randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`,
      paymentRouting: { card: 'manual', qr: 'none' },
    },
    headers: { 'Idempotency-Key': `s744-station-${crypto.randomUUID()}` },
  });
  expect(created.status()).toBe(200);
  const { station } = await created.json() as { station: { id: string; ready?: boolean; reasons?: string[] } };
  expect(station.ready, `The ZZ TEST till is ready to sell: ${(station.reasons ?? []).join('; ')}`).not.toBe(false);
  return station.id;
}

/** The station this device remembers, as the till keeps it across a reload. */
async function rememberedStation(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('oto.pos.station.')) {
        return (JSON.parse(localStorage.getItem(key) ?? '{}') as { id?: string }).id ?? null;
      }
    }
    return null;
  });
}

const WIDTHS = [
  { name: 'desktop', viewport: { width: 1440, height: 1024 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
] as const;

for (const width of WIDTHS) {
  test(`SCRUM-744: a till locked by the timeout and reloaded unlocks onto its own station (${width.name})`, async ({ browser, baseURL }) => {
    requireLocalFixture(baseURL);
    const context = await browser.newContext({ baseURL, viewport: width.viewport });
    const page = await context.newPage();
    const admin = await request.newContext({ baseURL });
    const picks: string[] = [];
    page.on('request', sent => {
      if (sent.method() === 'PUT' && new URL(sent.url()).pathname === '/api/me/session/station') {
        picks.push((sent.postDataJSON() as { stationId?: string } | null)?.stationId ?? '');
      }
    });
    try {
      // The inactivity timer is the page's own; the clock lets the test reach it.
      await page.clock.install();
      await page.goto('/');

      // Sign in as reception and stand at the picker.
      await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
      await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE);
      await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD);
      const signedIn = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-in')
        && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      expect((await signedIn).status()).toBe(200);
      await expect(page.getByRole('heading', { name: PICKER })).toBeVisible({ timeout: 20_000 });

      // The ZZ TEST till, on the virtual box at the branch this session is on.
      const me = await page.request.get('/api/me');
      expect(me.status()).toBe(200);
      const branchId = (await me.json()).branch?.id as string;
      expect(typeof branchId).toBe('string');
      const adminSignedIn = await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } });
      expect(adminSignedIn.status()).toBe(200);
      const stationName = `ZZ TEST SCRUM-744 ${width.name} ${crypto.randomUUID().slice(0, 8)} till`;
      const stationId = await zzTestTill(admin, branchId, stationName);

      await page.getByRole('button', { name: 'Refresh' }).click();
      const firstPick = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/session/station'
        && response.request().method() === 'PUT');
      await page.getByRole('button', { name: new RegExp(stationName) }).click();
      expect((await firstPick).status()).toBe(200);
      await expect(page.getByLabel('Lock screen')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('heading', { name: PICKER })).toBeHidden();
      expect(await rememberedStation(page)).toBe(stationId);

      // Lock by the inactivity timeout, as a till left alone does.
      const locked = page.waitForResponse(response => response.url().endsWith('/api/auth/lock')
        && response.request().method() === 'POST');
      await page.clock.fastForward('02:05');
      expect((await locked).status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();

      // Reload at the lock screen: the page comes back locked.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible({ timeout: 20_000 });
      await capture(page, `${width.name}-1-locked-after-reload.png`);

      // Unlock: the till is back on its own station, with no locked line and no picker.
      picks.length = 0;
      await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD);
      const unlocked = page.waitForResponse(response => response.url().endsWith('/api/auth/unlock')
        && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      expect((await unlocked).status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeHidden({ timeout: 20_000 });
      // What the till settles on is the evidence, kept before it is judged.
      await expect(page.getByRole('heading', { name: PICKER }).or(page.getByLabel('Lock screen')).first())
        .toBeVisible({ timeout: 20_000 });
      await capture(page, `${width.name}-2-after-unlock.png`);
      await expect(page.getByLabel('Lock screen')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('heading', { name: PICKER })).toBeHidden();
      await expect(page.getByText(LOCKED_LINE)).toHaveCount(0);
      expect(picks).toEqual([stationId]);
      expect(await rememberedStation(page)).toBe(stationId);
      if (width.name === 'desktop') await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();

      // And it stays there: the defect was still on screen fifteen seconds later.
      await page.waitForTimeout(15_000);
      await expect(page.getByRole('heading', { name: PICKER })).toBeHidden();
      await expect(page.getByText(LOCKED_LINE)).toHaveCount(0);
      await expect(page.getByLabel('Lock screen')).toBeVisible();
      expect(picks).toEqual([stationId]);
      await capture(page, `${width.name}-3-after-15s.png`);

      const link = await page.request.get('/api/me/station/link');
      expect(link.status()).toBe(200);
      expect((await link.json()).stationId).toBe(stationId);
    } finally {
      await page.request.post('/api/auth/sign-out').catch(() => undefined);
      await admin.post('/api/auth/sign-out').catch(() => undefined);
      await admin.dispose();
      await context.close();
    }
  });
}
