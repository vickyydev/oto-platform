import { expect, request, test, type Browser, type Page, type Request, type Response } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const PHONE = process.env.POS_E2E_PHONE ?? '';
const PASSWORD = process.env.POS_E2E_PASSWORD ?? '';
const ADMIN_PHONE = process.env.POS_E2E_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = process.env.POS_E2E_ADMIN_PASSWORD ?? '';
const MEMBER_PHONE = '0811111111';
const STATION_NAME = 'Reception Till 1';
const signedOutPages = new WeakSet<Page>();

// Playwright's failure DOM attachment is unmasked even when trace/video are off.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(120_000);

function requireLocalFixture(baseURL: string | undefined): asserts baseURL is string {
  test.skip(!PHONE || !PASSWORD || !ADMIN_PHONE || !ADMIN_PASSWORD,
    'Set POS_E2E_PHONE, POS_E2E_PASSWORD, POS_E2E_ADMIN_PHONE and POS_E2E_ADMIN_PASSWORD');
  test.skip(!baseURL || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname),
    'This smoke flow requires a disposable seeded local API');
}

async function signIn(page: Page): Promise<void> {
  signedOutPages.delete(page);
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(PHONE)
    .catch(() => { throw new Error('The staff phone field could not be filled'); });
  await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD)
    .catch(() => { throw new Error('The staff password field could not be filled'); });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const stationPicker = page.getByRole('heading', { name: 'Which station are you on?' });
  await expect.poll(async () => (await stationPicker.isVisible())
    || (await page.getByText('Membership Check', { exact: true }).isVisible())).toBe(true);
  if (await stationPicker.isVisible()) {
    await page.getByRole('button', { name: new RegExp(STATION_NAME) }).click();
  }
  await expect(page.getByText('Membership Check', { exact: true })).toBeVisible({ timeout: 20_000 });
}

async function unlock(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
  await page.locator('input[type="password"][autocomplete="current-password"]').fill(PASSWORD)
    .catch(() => { throw new Error('The unlock password field could not be filled'); });
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeHidden({ timeout: 20_000 });
  await expect(page.getByLabel('Lock screen')).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByLabel('Lock screen').click();
  const completed = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-out')
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: /Sign out and hand over the till/ }).click();
  expect((await completed).status()).toBe(200);
  signedOutPages.add(page);
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible();
}

async function clearStaffPage(page: Page): Promise<void> {
  try {
    if (!signedOutPages.has(page)) {
      const session = await page.request.get('/api/me').catch(() => null);
      if (session?.status() === 200) await page.request.post('/api/auth/sign-out').catch(() => undefined);
    }
  } finally {
    await page.goto('about:blank').catch(() => undefined);
  }
}

async function displayPrompt(page: Page, expectedId?: string): Promise<string> {
  const response = await page.waitForResponse(async candidate => {
    if (!candidate.url().endsWith('/api/display/session') || candidate.request().method() !== 'GET'
      || candidate.status() !== 200) return false;
    return expectedId === undefined || (await candidate.json()).document?.prompt?.requestId === expectedId;
  });
  const body = await response.json();
  expect(typeof body.document?.prompt?.requestId === 'string').toBe(true);
  return body.document.prompt.requestId;
}

async function typePhone(page: Page, phone: string): Promise<void> {
  for (const digit of phone) await page.getByRole('button', { name: digit, exact: true }).click();
}

async function captureLocalCheck(page: Page, name: string): Promise<void> {
  const directory = process.env.POS_E2E_EVIDENCE_DIR;
  if (!directory) return;
  await expect.poll(() => page.evaluate(() => document.body.getAnimations({ subtree: true })
    .every(animation => animation.effect?.getComputedTiming().iterations === Infinity
      || !animation.pending && animation.playState !== 'running')
    && Array.from(document.querySelectorAll('.animate-in'))
      .filter(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
      .every(element => Number(getComputedStyle(element).opacity) >= 0.99)), { timeout: 5000 }).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => {
    const stamp = document.createElement('div');
    stamp.dataset.localCheck = 'true';
    stamp.textContent = 'LOCAL CHECK';
    stamp.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 12px;background:#111;color:#fff;font:700 14px sans-serif';
    document.body.append(stamp);
  });
  try {
    await page.screenshot({ path: resolve(directory, name), fullPage: true,
      mask: [page.getByTestId('display-pairing-code'), page.locator('input[type="password"]')] });
  } finally {
    await page.locator('[data-local-check="true"]').evaluateAll(elements => elements.forEach(element => element.remove()));
  }
}

async function pairedDisplay(browser: Browser, staff: Page, baseURL: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 } });
  const display = await context.newPage();
  const admin = await request.newContext({ baseURL });
  let credentialId: string | null = null;
  let stationId: string | null = null;
  let ownLeaseId: string | null = null;
  const pendingClaims = new Set<Promise<void>>();
  const observeLease = (response: Response) => {
    if (!stationId || response.url().split('?')[0] !== new URL(`/api/stations/${stationId}/lease`, baseURL).href
      || response.request().method() !== 'POST' || response.status() !== 200) return;
    const pending = response.json().then(body => {
      if (body.document?.stationId === stationId && typeof body.lease?.leaseId === 'string') ownLeaseId = body.lease.leaseId;
    }).catch(() => undefined);
    pendingClaims.add(pending);
    void pending.finally(() => pendingClaims.delete(pending));
  };
  staff.on('response', observeLease);
  const releaseLease = async () => {
    await Promise.allSettled([...pendingClaims]);
    if (!stationId || !ownLeaseId) return;
    const response = await staff.request.post(`/api/stations/${stationId}/lease/release`, {
      data: { leaseId: ownLeaseId }, headers: { 'Idempotency-Key': `display-smoke-release-${crypto.randomUUID()}` },
    });
    expect(response.status()).toBe(200);
    ownLeaseId = null;
  };
  let revoked = false;
  const revoke = async () => {
    if (!credentialId || revoked) return;
    const response = await admin.post(`/api/credentials/${credentialId}/revoke`, {
      data: { reason: 'Local separate-display smoke cleanup' },
      headers: { 'Idempotency-Key': `display-smoke-revoke-${crypto.randomUUID()}` },
    });
    expect(response.status()).toBe(200);
    revoked = true;
  };
  const cleanup = async () => {
    let revokeFailed = false;
    try { await revoke(); } catch { revokeFailed = true; }
    // The browser-held credential never leaves this context or enters an artifact.
    await display.evaluate(async () => {
      const bearer = localStorage.getItem('oto.display.credential');
      if (bearer) await fetch('/api/display/pairing/expire', {
        method: 'POST', credentials: 'omit',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: '{}',
      });
    }).catch(() => undefined);
    await display.goto('about:blank').catch(() => undefined);
    await context.close();
    staff.off('response', observeLease);
    await admin.post('/api/auth/sign-out').catch(() => undefined);
    await admin.dispose();
    if (revokeFailed) throw new Error('The dedicated display credential could not be revoked');
  };
  try {
    const signedIn = await admin.post('/api/auth/sign-in', { data: { phone: ADMIN_PHONE, password: ADMIN_PASSWORD } })
      .catch(() => { throw new Error('The local setup account could not sign in'); });
    expect(signedIn.status()).toBe(200);
    const meResponse = await staff.request.get('/api/me');
    expect(meResponse.status()).toBe(200);
    const me = await meResponse.json();
    expect(typeof me.branch?.id === 'string').toBe(true);
    const linkResponse = await staff.request.get('/api/me/station/link');
    expect(linkResponse.status()).toBe(200);
    const link = await linkResponse.json();
    expect(typeof link.stationId === 'string' && typeof link.boxId === 'string' && link.offline === false).toBe(true);
    stationId = link.stationId;
    const stationResponse = await admin.get(`/api/stations/${link.stationId}`);
    expect(stationResponse.status()).toBe(200);
    const { station } = await stationResponse.json();
    expect(station.name === STATION_NAME && station.branchId === me.branch.id && station.boxId === link.boxId).toBe(true);
    const selected = await admin.put('/api/me/session/station', {
      data: { stationId: link.stationId }, headers: { 'Idempotency-Key': `display-smoke-station-${crypto.randomUUID()}` },
    });
    expect(selected.status()).toBe(200);

    await display.goto('/display');
    await expect(display.getByRole('heading', { name: 'Set up this display' })).toBeVisible();
    const code = await display.getByTestId('display-pairing-code').textContent();
    expect(typeof code === 'string' && /^\d{6}$/.test(code)).toBe(true);
    const publication = staff.waitForResponse(response => response.url().endsWith(`/api/stations/${link.stationId}/intents`)
      && response.request().method() === 'POST' && response.status() === 200
      && response.request().postDataJSON()?.type === 'session.publish_display'
      && response.request().postDataJSON()?.payload?.stage === 'identify').catch(() => null);
    const claimed = await admin.post(`/api/stations/${link.stationId}/displays/claim`, {
      data: { pairingCode: code, name: `Local smoke display ${crypto.randomUUID().slice(0, 8)}` },
      headers: { 'Idempotency-Key': `display-smoke-claim-${crypto.randomUUID()}` },
    }).catch(() => { throw new Error('The dedicated display pairing request failed'); });
    expect(claimed.status()).toBe(200);
    const paired = await claimed.json();
    expect(typeof paired.device?.id === 'string').toBe(true);
    credentialId = paired.device.id;
    expect(paired.station?.id === link.stationId).toBe(true);
    const published = await publication;
    expect(published !== null).toBe(true);
    if (!published) throw new Error('The staff till did not publish its new display prompt');
    const payload = published.request().postDataJSON()?.payload;
    expect(payload?.stage === 'identify' && typeof payload.prompt?.requestId === 'string').toBe(true);
    await displayPrompt(display, payload.prompt.requestId);
    await expect(display.getByTestId('display-station')).toContainText(STATION_NAME, { timeout: 20_000 });
    await expect(display.getByRole('button', { name: 'Find my membership', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByRole('button', { name: 'Find my membership', exact: true })).toHaveCount(0);
    expect((await display.request.get('/api/me')).status()).toBe(401);
    return { display, admin, revoke, releaseLease, cleanup };
  } catch (error) {
    try {
      await releaseLease();
    } finally {
      try { await cleanup(); } finally {
        await clearStaffPage(staff);
      }
    }
    throw error;
  }
}

// Seeded member Mali and the two saved children must survive the independent staff lock.
test('lock → sign in → membership lookup → child confirm → sign out', async ({ page, browser, baseURL }) => {
  requireLocalFixture(baseURL);
  await page.goto('/');
  await signIn(page);
  await expect(page.getByText(/Weekday pricing|Weekend pricing/).first()).toBeVisible();
  const fixture = await pairedDisplay(browser, page, baseURL);
  try {
    const originalResponse = await page.request.get('/api/members/lookup', { params: { phone: MEMBER_PHONE } });
    expect(originalResponse.status()).toBe(200);
    const original = (await originalResponse.json()).member;
    expect(original.nickname === 'Mali' && original.children?.length === 2).toBe(true);
    const originalChildIds = original.children.map((child: { id: string }) => child.id).sort();
    const promptId = await displayPrompt(fixture.display);
    await typePhone(fixture.display, MEMBER_PHONE);
    await page.getByLabel('Lock screen').click();
    await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
    expect((await displayPrompt(fixture.display)) === promptId).toBe(true);
    const answered = fixture.display.waitForResponse((response) => response.url().endsWith('/api/display/intents')
      && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'display.identify');
    await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
    expect((await answered).status()).toBe(200);
    await expect(page.getByText("Who's visiting today?", { exact: true })).toHaveCount(0);
    const lookup = page.waitForResponse((response) => response.url().includes('/api/members/lookup?') && response.status() === 200);
    await unlock(page);
    const found = (await (await lookup).json()).member;
    expect(found.id === original.id && JSON.stringify(found.children.map((child: { id: string }) => child.id).sort())
      === JSON.stringify(originalChildIds)).toBe(true);
    await expect(page.getByText("Who's visiting today?", { exact: true })).toBeVisible({ timeout: 20_000 });
    const childrenDialog = page.getByRole('dialog');
    await expect(childrenDialog.getByText('Nong Ploy', { exact: true })).toBeVisible();
    await expect(childrenDialog.getByText('Nong Tan', { exact: true })).toBeVisible();
    await expect(fixture.display.getByText('Nong Ploy', { exact: true })).toHaveCount(0);
    await expect(fixture.display.getByText('Nong Tan', { exact: true })).toHaveCount(0);
    const details = childrenDialog.getByRole('button', { name: /^Details/ });
    await expect(details).toHaveCount(2);
    for (const button of await details.all()) {
      if (await button.getAttribute('aria-expanded') === 'true') await button.click();
    }
    await expect(childrenDialog.getByText('Nong Ploy', { exact: true })).toBeInViewport();
    await expect(childrenDialog.getByText('Nong Tan', { exact: true })).toBeInViewport();
    await expect(childrenDialog.getByRole('button', { name: /Confirm 2 children/ })).toBeInViewport();
    await captureLocalCheck(page, 'ticket-children-local.png');
    await page.getByRole('button', { name: /Confirm 2 children/ }).click();
    await expect(page.getByText('Visit confirmed', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Thai · verified')).toBeVisible();
    await expect(fixture.display.getByRole('heading', { name: 'Welcome back, Mali!', exact: true })).toBeVisible({ timeout: 20_000 });
    await captureLocalCheck(fixture.display, 'ticket-display-welcome-local.png');
    await page.getByLabel('Lock screen').click();
    await unlock(page);
    await expect(page.getByRole('heading', { name: 'Select Customer Type', exact: true })).toBeVisible();
    await expect(page.getByText('Mali', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Thai · verified')).toBeVisible();
    await signOut(page);
    await fixture.display.reload();
    await expect(fixture.display.getByTestId('display-station')).toContainText(STATION_NAME, { timeout: 20_000 });
    await signIn(page);
    const rejected = fixture.display.waitForResponse((response) => response.url().endsWith('/api/display/session') && response.status() === 401);
    await fixture.revoke();
    expect((await rejected).status()).toBe(401);
    await expect(fixture.display.getByRole('heading', { name: 'Set up this display' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Membership Check', { exact: true })).toBeVisible();
    await signOut(page);
  } finally {
    try {
      if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
      if (await page.getByLabel('Lock screen').isVisible()) {
        await fixture.releaseLease();
        await signOut(page);
      }
    } finally {
      try { await fixture.cleanup(); } finally {
        await clearStaffPage(page);
      }
    }
  }
});

test('unknown phone offers the create-member path (SCRUM-31)', async ({ page, browser, baseURL }) => {
  requireLocalFixture(baseURL);
  await page.goto('/');
  await signIn(page);
  const fixture = await pairedDisplay(browser, page, baseURL);
  let createdMemberId: string | null = null;
  try {
    await captureLocalCheck(fixture.display, 'ticket-fresh-display-local.png');
    const unknown = `06${String(Math.floor(10000000 + Math.random() * 89999999))}`;
    const expectedPhone = `+66${unknown.slice(1)}`;
    await typePhone(fixture.display, unknown.slice(1));
    const answered = fixture.display.waitForResponse(response => response.url().endsWith('/api/display/intents')
      && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'display.identify');
    const lookup = page.waitForResponse(response => response.url().includes('/api/members/lookup?')
      && response.request().method() === 'GET').catch(() => null);
    await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
    const answer = await answered;
    expect(answer.status()).toBe(200);
    expect(answer.request().postDataJSON()?.payload?.phone === expectedPhone).toBe(true);
    const lookedUp = await lookup;
    expect(lookedUp?.status() === 200).toBe(true);
    if (!lookedUp) throw new Error('The staff till did not look up the entered phone');
    expect(new URL(lookedUp.url()).searchParams.get('phone') === expectedPhone).toBe(true);
    expect((await lookedUp.json()).member === null).toBe(true);
    await expect(page.getByText('New member?', { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByPlaceholder('e.g. Mali').fill('Smoke visitor');
    const created = page.waitForResponse((response) => response.url().endsWith('/api/members') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create member', exact: true }).click();
    const response = await created;
    expect(response.ok()).toBe(true);
    const member = (await response.json()).member;
    expect(typeof member?.id === 'string').toBe(true);
    createdMemberId = member.id;
    expect(member.nickname === 'Smoke visitor').toBe(true);
    await expect(page.getByText('Member created', { exact: true })).toBeVisible({ timeout: 20_000 });
    await signOut(page);
  } finally {
    try {
      if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
      if (await page.getByLabel('Lock screen').isVisible()) {
        await fixture.releaseLease();
        await signOut(page);
      }
      if (createdMemberId) {
        const archived = await fixture.admin.delete(`/api/members/${createdMemberId}`, {
          headers: { 'Idempotency-Key': `display-smoke-member-cleanup-${crypto.randomUUID()}` },
        });
        expect(archived.ok()).toBe(true);
      }
    } finally {
      try { await fixture.cleanup(); } finally {
        await clearStaffPage(page);
      }
    }
  }
});

test('separate display saved-child review persists before Done and retries a lost save reply', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  requireLocalFixture(baseURL);
  await page.goto('/');
  await signIn(page);
  const fixture = await pairedDisplay(browser, page, baseURL);
  let releaseLostReply: (() => void) | undefined;
  let restoredChild: { id: string; name: string; dateOfBirth: string | null; ageYears: number | null } | undefined;
  let unrelatedWrites = 0;
  const observeReviewWrite = (request: Request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (/^\/api\/(sales?|payments|children|check-?ins?|visits|checkout)(\/|$)/.test(pathname)
      || /^\/api\/members\/[^/]+\/children(\/|$)/.test(pathname)) unrelatedWrites += 1;
  };
  try {
    const lookup = page.waitForResponse(response => response.url().includes('/api/members/lookup?') && response.status() === 200);
    await typePhone(fixture.display, MEMBER_PHONE);
    await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
    const original = (await (await lookup).json()).member;
    expect(Array.isArray(original?.children) && original.children.length === 2).toBe(true);
    await expect(page.getByText("Who's visiting today?", { exact: true })).toBeVisible({ timeout: 20_000 });
    for (const button of await page.getByRole('dialog').getByRole('button', { name: /^Details/ }).all()) {
      if (await button.getAttribute('aria-expanded') === 'true') await button.click();
    }
    await page.getByRole('button', { name: /Confirm 2 children/ }).click();
    await expect(page.getByText('Visit confirmed', { exact: true })).toBeVisible();
    await page.getByRole('heading', { name: 'Thai', exact: true }).click();
    await page.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
    await page.getByRole('button', { name: 'Remove one Adults', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add one Kids', exact: true }).first().click();
    const publishedReview = fixture.display.waitForResponse(async response => response.url().endsWith('/api/display/session')
      && response.status() === 200 && (await response.json()).document?.prompt?.kind === 'child_review');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const prompt = (await (await publishedReview).json()).document.prompt;
    expect(prompt.slots?.length === 2 && prompt.choices?.length === 2 && prompt.save?.status === 'idle').toBe(true);
    expect(prompt.slots.every((slot: Record<string, unknown>) => Object.keys(slot).every(key =>
      ['id', 'savedChildId', 'name', 'dateOfBirth', 'ageYears', 'confirmed'].includes(key)))).toBe(true);
    const review = fixture.display.getByTestId('display-child-review');
    await expect(review).toBeVisible({ timeout: 20_000 });
    page.on('request', observeReviewWrite);
    fixture.display.on('request', observeReviewWrite);
    for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
      await fixture.display.setViewportSize(viewport);
      expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await fixture.display.setViewportSize({ width: 1024, height: 768 });
    await expect(review.getByText(/allergies|medical|dietary|food|photo|waiver/i)).toHaveCount(0);
    await expect(review.locator('video, canvas, input[type="file"]')).toHaveCount(0);
    const cards = review.getByTestId('saved-child-review-card');
    const firstName = review.getByLabel('Child 1 name', { exact: true });
    const secondName = review.getByLabel('Child 2 name', { exact: true });
    const childId = prompt.slots[0].savedChildId;
    const initialChild = original.children.find((child: { id: string }) => child.id === childId);
    expect(typeof childId === 'string' && initialChild !== undefined).toBe(true);
    restoredChild = { id: childId, name: initialChild.name, dateOfBirth: initialChild.dateOfBirth, ageYears: initialChild.ageYears };

    // A declared saved profile is explicitly selected; the other slot's draft survives its acknowledgement.
    await secondName.fill('Other child local draft');
    const selected = fixture.display.waitForResponse(response => response.url().endsWith('/api/display/intents')
      && response.request().postDataJSON()?.payload?.action === 'select');
    await review.getByLabel('Child 1 saved profile', { exact: true }).selectOption(childId);
    expect((await selected).status()).toBe(200);
    await expect(firstName).toBeEnabled({ timeout: 20_000 });
    await expect(secondName).toHaveValue('Other child local draft');
    await firstName.fill('Local child correction');
    await cards.first().getByRole('button', { name: /yrs/ }).click();
    const picker = fixture.display.getByRole('dialog');
    await picker.getByRole('button', { name: '8', exact: true }).click();
    await picker.getByRole('button', { name: 'Jan', exact: true }).click();
    await picker.getByRole('button', { name: '15', exact: true }).click();
    await picker.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();

    let firstPatchBody: unknown;
    let firstPatchKey: string | undefined;
    let patchCount = 0;
    let signalCommitted: (() => void) | undefined;
    const committed = new Promise<void>(resolve => { signalCommitted = resolve; });
    const lostReply = new Promise<void>(resolve => { releaseLostReply = resolve; });
    await page.route(`**/api/members/children/${childId}`, async route => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      patchCount += 1;
      const body = route.request().postDataJSON();
      const key = route.request().headers()['idempotency-key'];
      expect(Object.keys(body).every(field => ['name', 'dateOfBirth', 'ageYears'].includes(field))).toBe(true);
      if (patchCount === 1) {
        firstPatchBody = body;
        firstPatchKey = key;
        const actual = await route.fetch();
        expect(actual.status()).toBe(200);
        signalCommitted?.();
        await lostReply;
        await route.abort('failed');
      } else {
        expect(typeof key === 'string' && key === firstPatchKey && JSON.stringify(body) === JSON.stringify(firstPatchBody)).toBe(true);
        await route.continue();
      }
    });
    await cards.first().getByRole('button', { name: 'Confirm', exact: true }).click();
    await committed;
    await expect(fixture.display.getByText('Please wait for the team to confirm this change.', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(firstName).toBeDisabled();
    await expect(secondName).toBeDisabled();
    await expect(review.getByLabel('Child 1 saved profile', { exact: true })).toBeDisabled();
    await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
    const profile = await fixture.admin.get(`/api/members/${original.id}`);
    expect(profile.status()).toBe(200);
    const saved = (await profile.json()).member.children.find((child: { id: string }) => child.id === childId);
    const submitted = firstPatchBody as { name: string; dateOfBirth: string; ageYears: number };
    expect(saved?.name === submitted.name && saved?.dateOfBirth === submitted.dateOfBirth && saved?.ageYears === submitted.ageYears).toBe(true);
    await captureLocalCheck(fixture.display, 'ticket-display-child-save-pending-local.png');
    releaseLostReply?.();
    await expect(review.getByRole('button', { name: 'Retry child save', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(firstName).toBeDisabled();
    await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
    await captureLocalCheck(fixture.display, 'ticket-display-child-retry-local.png');
    const replay = page.waitForResponse(response => response.url().endsWith(`/api/members/children/${childId}`)
      && response.request().method() === 'PATCH' && response.status() === 200);
    await review.getByRole('button', { name: 'Retry child save', exact: true }).click();
    await replay;
    await expect(cards.first().getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(patchCount === 2).toBe(true);
    await expect(secondName).toHaveValue('Other child local draft');
    await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
    await secondName.fill(prompt.slots[1].name);
    await cards.nth(1).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(cards.nth(1).getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    // Editing a confirmed record stays local and cannot use the old confirmation to continue.
    await firstName.fill('Another unsaved draft');
    await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
    await firstName.fill('Local child correction');
    await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    await captureLocalCheck(fixture.display, 'ticket-display-child-confirmed-local.png');
    await review.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Children playing alone', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(fixture.display.getByTestId('display-consent')).toBeVisible({ timeout: 20_000 });
    await expect(fixture.display.getByTestId('display-child-review')).toHaveCount(0);
    expect(unrelatedWrites === 0).toBe(true);
  } finally {
    releaseLostReply?.();
    page.off('request', observeReviewWrite);
    fixture.display.off('request', observeReviewWrite);
    try {
      if (restoredChild) {
        await page.unroute(`**/api/members/children/${restoredChild.id}`);
        const restored = await fixture.admin.patch(`/api/members/children/${restoredChild.id}`, {
          data: { name: restoredChild.name, dateOfBirth: restoredChild.dateOfBirth, ageYears: restoredChild.ageYears },
          headers: { 'Idempotency-Key': `display-smoke-child-cleanup-${crypto.randomUUID()}` },
        });
        expect(restored.status()).toBe(200);
      }
      if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
      if (await page.getByLabel('Lock screen').isVisible()) { await fixture.releaseLease(); await signOut(page); }
    } finally {
      try { await fixture.cleanup(); } finally { await clearStaffPage(page); }
    }
  }
});

test('separate display guest F&B uses the captured order through lock, cash payment and pickup', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  requireLocalFixture(baseURL);
  await page.goto('/');
  await signIn(page);
  const fixture = await pairedDisplay(browser, page, baseURL);
  const fnbSession = (stage: string, discounted = false) => {
    let lastStatus: number | null = null;
    let lastStage = 'none';
    let lastKind = 'none';
    let lastSupported = false;
    return fixture.display.waitForResponse(async response => {
      if (!response.url().endsWith('/api/display/session')) return false;
      lastStatus = response.status();
      if (lastStatus !== 200) return false;
      const document = (await response.json().catch(() => null))?.document;
      lastStage = ['identify', 'welcome', 'order', 'input', 'payment', 'thankyou'].includes(document?.stage) ? document.stage : 'other';
      lastKind = document?.cart?.kind === 'fnb' ? 'fnb' : 'other';
      lastSupported = document?.cart?.supported === true;
      return document?.stage === stage && lastKind === 'fnb' && lastSupported
        && (!discounted || document.cart.manualDiscounts?.length === 1);
    }).catch(() => {
      throw new Error(`F&B display ${stage} response missing (status=${lastStatus}, stage=${lastStage}, kind=${lastKind}, supported=${lastSupported})`);
    });
  };
  try {
    const welcome = fnbSession('welcome');
    await page.getByRole('button', { name: 'F&B', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Scan Wristband', exact: true })).toBeVisible();
    await welcome;
    const publicFnb = fixture.display.getByTestId('display-fnb');
    await expect(publicFnb.getByRole('heading', { name: 'Order here', exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
    await page.getByPlaceholder('Search dish…').fill('French Fries');
    await page.getByRole('button', { name: /French Fries/ }).click();
    const options = page.getByRole('dialog');
    await options.getByRole('button', { name: /Cheese sauce/ }).click();
    await options.getByRole('button', { name: 'Add one French Fries', exact: true }).click();
    await options.getByPlaceholder('e.g. no pickles, extra crispy').fill('Local menu note');
    const added = fnbSession('order');
    await options.getByRole('button', { name: /^Add to order/ }).click();
    await added;
    await expect(publicFnb.getByTestId('fnb-display-line')).toHaveCount(1, { timeout: 20_000 });
    await expect(publicFnb.getByText('Cheese sauce', { exact: true })).toBeVisible();
    await expect(publicFnb.getByText('Local menu note', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add manual discount', exact: true }).click();
    const discount = page.getByRole('dialog');
    await discount.getByRole('button', { name: '1', exact: true }).click();
    await discount.getByRole('button', { name: '0', exact: true }).click();
    await discount.getByText(/^Reason/).locator('..').getByRole('button').first().click();
    const quoted = page.waitForResponse(response => response.url().endsWith('/api/sales/quote')
      && response.request().method() === 'POST' && response.status() === 200
      && response.request().postDataJSON()?.manualDiscounts?.length === 1);
    const discounted = fnbSession('order', true);
    await discount.getByRole('button', { name: /^Apply/ }).click();
    const quote = (await (await quoted).json()).quote;
    const document = (await (await discounted).json()).document;
    const line = document.cart.lines[0];
    expect(document.step === null && document.member === null && document.prompt === null).toBe(true);
    expect(line.qty === 2 && line.name === 'French Fries' && line.basePrice === 90
      && line.modifiers.some((modifier: { optionName: string; price: number }) => modifier.optionName === 'Cheese sauce' && modifier.price === 25)).toBe(true);
    expect(Math.round(document.totals.total * 100) === quote.totals.grossSatang).toBe(true);
    const discountId = document.cart.manualDiscounts[0].id;
    expect(document.totals.manualAmounts[discountId] > 0).toBe(true);
    await expect(publicFnb.getByText(`฿${line.basePrice} base`, { exact: true })).toBeVisible();
    await expect(publicFnb.getByText(`฿${line.lineTotal}`, { exact: true })).toBeVisible();
    await expect(publicFnb.getByText(`−฿${document.totals.manualAmounts[discountId]}`, { exact: true })).toBeVisible();
    await expect(publicFnb.getByText(`฿${document.totals.total}`, { exact: true })).toBeVisible();
    await expect(publicFnb.getByText(/credit balance|remaining credit|allergy|medical|prepaid|staff benefit/i)).toHaveCount(0);
    for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
      await fixture.display.setViewportSize(viewport);
      expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await fixture.display.setViewportSize({ width: 1024, height: 768 });
    await captureLocalCheck(fixture.display, 'fnb-display-order-local.png');

    await page.getByLabel('Lock screen').click();
    await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
    const locked = (await (await fnbSession('order', true)).json()).document;
    expect(JSON.stringify(locked.cart) === JSON.stringify(document.cart)
      && JSON.stringify(locked.totals) === JSON.stringify(document.totals)).toBe(true);
    await unlock(page);
    await expect(page.getByRole('button', { name: `Charge ฿${document.totals.total}`, exact: true })).toBeVisible();
    await expect(publicFnb.getByText('Local menu note', { exact: true })).toBeVisible();
    await publicFnb.getByLabel('Change language').click();
    const languageSet = fixture.display.waitForResponse(response => response.url().endsWith('/api/display/intents')
      && response.request().postDataJSON()?.type === 'display.set_language'
      && response.request().postDataJSON()?.payload?.language === 'fr' && response.status() === 200);
    await publicFnb.getByRole('button', { name: 'Français', exact: true }).click();
    // The publisher may advance the sequence before the language gesture.
    // The display rehydrates and retries; prove the eventual accepted response.
    expect((await (await languageSet).json()).document?.language === 'fr').toBe(true);
    await expect(publicFnb.getByText('Frites', { exact: true })).toBeVisible();
    await publicFnb.getByLabel('Change language').click();
    const languageReset = fixture.display.waitForResponse(response => response.url().endsWith('/api/display/intents')
      && response.request().postDataJSON()?.type === 'display.set_language'
      && response.request().postDataJSON()?.payload?.language === 'en' && response.status() === 200);
    await publicFnb.getByRole('button', { name: 'English', exact: true }).click();
    expect((await (await languageReset).json()).document?.language === 'en').toBe(true);

    const payment = fnbSession('payment');
    await page.getByRole('button', { name: `Charge ฿${document.totals.total}`, exact: true }).click();
    const pickup = page.getByRole('dialog', { name: 'Pick-up Code', exact: true });
    await pickup.getByRole('button', { name: '1', exact: true }).click();
    await pickup.getByRole('button', { name: '2', exact: true }).click();
    await pickup.getByRole('button', { name: /^Continue to Payment/ }).click();
    const paymentDocument = (await (await payment).json()).document;
    expect(paymentDocument.cart.completion === null && paymentDocument.prompt === null
      && paymentDocument.payment.amountSatang === Math.round(document.totals.total * 100)).toBe(true);
    await expect(publicFnb.getByText('Amount to pay', { exact: true })).toBeVisible({ timeout: 20_000 });
    await captureLocalCheck(fixture.display, 'fnb-display-payment-local.png');
    await page.getByRole('button', { name: /^Cash / }).click();
    await page.getByLabel('Cash received', { exact: true }).fill((document.totals.total + 10).toFixed(2));
    const finalised = page.waitForResponse(response => /\/api\/sales\/[^/]+\/finalise$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST' && response.status() === 200);
    const thankyou = fnbSession('thankyou');
    await page.getByRole('button', { name: 'Record cash', exact: true }).click();
    const finalResponse = await finalised;
    const written = (await finalResponse.json()).sale;
    expect(written?.status === 'finalised' && written.totals.grossSatang === quote.totals.grossSatang).toBe(true);
    const completed = (await (await thankyou).json()).document;
    const summary = completed.cart.completion;
    expect(summary?.saleId === written.id && typeof summary.pickupCode === 'string' && summary.pickupCode.length > 0
      && Math.round(summary.total * 100) === written.totals.grossSatang
      && summary.payment.cash === summary.total && summary.payment.card === 0 && summary.payment.promptpay === 0).toBe(true);
    await expect(page.getByRole('heading', { name: 'Order Confirmed', exact: true })).toBeVisible();
    await expect(publicFnb.getByRole('heading', { name: 'Thank you!', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(publicFnb.getByText(summary.pickupCode, { exact: true })).toBeVisible();
    await expect(publicFnb.getByText('Cash', { exact: true })).toBeVisible();
    await expect(publicFnb.getByText(/credit balance|remaining credit|fnb credit/i)).toHaveCount(0);
    await captureLocalCheck(fixture.display, 'fnb-display-completed-local.png');
  } finally {
    try {
      if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
      if (await page.getByLabel('Lock screen').isVisible()) { await fixture.releaseLease(); await signOut(page); }
    } finally {
      try { await fixture.cleanup(); } finally { await clearStaffPage(page); }
    }
  }
});

test('separate display guardian acknowledgement retains lock and retry, while staff authorises private readiness', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  requireLocalFixture(baseURL);
  await page.goto('/');
  await signIn(page);
  const fixture = await pairedDisplay(browser, page, baseURL);
  let blockRead = false;
  let publicWrites = 0;
  let businessWrites = 0;
  const observe = (request: Request) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) return;
    const pathname = new URL(request.url()).pathname;
    if (/^\/api\/(payments|check-?ins?|registrations?|visits|checkout)(\/|$)/.test(pathname)
      || pathname === '/api/sales' || /^\/api\/sales\/[^/]+\/finalise$/.test(pathname)
      || /^\/api\/members\/[^/]+\/children(\/|$)/.test(pathname)) businessWrites += 1;
  };
  const readConsent = (ready?: boolean, completed?: boolean) => fixture.display.waitForResponse(async response => {
    if (!response.url().endsWith('/api/display/session') || response.status() !== 200) return false;
    const document = (await response.json()).document;
    return document?.prompt?.kind === 'consent' && (ready === undefined || document.prompt.canContinue === ready)
      && (completed === undefined || document.prompt.completed === completed);
  });
  try {
    const lookup = page.waitForResponse(response => response.url().includes('/api/members/lookup?') && response.status() === 200);
    await typePhone(fixture.display, MEMBER_PHONE);
    await fixture.display.getByRole('button', { name: 'Find my membership', exact: true }).click();
    await lookup;
    await expect(page.getByText("Who's visiting today?", { exact: true })).toBeVisible({ timeout: 20_000 });
    for (const button of await page.getByRole('dialog').getByRole('button', { name: /^Details/ }).all()) {
      if (await button.getAttribute('aria-expanded') === 'true') await button.click();
    }
    await page.getByRole('button', { name: /Confirm 2 children/ }).click();
    await page.getByRole('heading', { name: 'Thai', exact: true }).click();
    await page.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
    await page.getByRole('button', { name: 'Remove one Adults', exact: true }).first().click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const review = fixture.display.getByTestId('display-child-review');
    await expect(review).toBeVisible({ timeout: 20_000 });
    await review.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(review.getByRole('button', { name: 'Done', exact: true })).toBeEnabled({ timeout: 20_000 });
    const opened = readConsent(false);
    await review.getByRole('button', { name: 'Done', exact: true }).click();
    const document = (await (await opened).json()).document;
    expect(document.step === null && document.prompt.slots.length === 1 && document.prompt.staffReady === false).toBe(true);
    const consent = fixture.display.getByTestId('display-consent');
    await expect(consent).toBeVisible({ timeout: 20_000 });
    expect(document.prompt.slots.every((slot: Record<string, unknown>) => Object.keys(slot).every(key =>
      ['id', 'name', 'ageYears', 'requirement'].includes(key)))).toBe(true);
    expect(/allergies|medical|foodRestrictions|childPhotoUrl|waived|savedChildId|policy/.test(JSON.stringify(document))).toBe(false);
    await expect(consent.locator('video, canvas, input[type="file"]')).toHaveCount(0);
    for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
      await fixture.display.setViewportSize(viewport);
      expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await fixture.display.setViewportSize({ width: 1024, height: 768 });
    page.on('request', observe); fixture.display.on('request', observe);
    await consent.getByLabel('Parent / guardian name', { exact: true }).fill('Local guardian');
    for (const checkbox of await consent.getByRole('checkbox').all()) await checkbox.check();
    await page.getByLabel('Lock screen').click();
    await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
    await expect(consent.getByLabel('Parent / guardian name', { exact: true })).toHaveValue('Local guardian');
    let originalGesture: { actionId: string; payload: unknown } | undefined;
    await fixture.display.route('**/api/display/session', async route => {
      if (blockRead) await route.abort('failed'); else await route.continue();
    });
    await fixture.display.route('**/api/display/intents', async route => {
      const body = route.request().postDataJSON();
      if (body.type !== 'display.consent' || body.payload.action !== 'acknowledge') { await route.continue(); return; }
      publicWrites += 1;
      if (publicWrites === 1) {
        originalGesture = { actionId: body.actionId, payload: body.payload };
        blockRead = true;
        const actual = await route.fetch();
        expect(actual.status()).toBe(200);
        await route.abort('failed');
      } else {
        expect(body.actionId === originalGesture?.actionId && JSON.stringify(body.payload) === JSON.stringify(originalGesture?.payload)).toBe(true);
        blockRead = false;
        await route.continue();
      }
    });
    await consent.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(fixture.display.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({ timeout: 20_000 });
    await fixture.display.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => publicWrites).toBe(2);
    await unlock(page);
    await expect(consent.getByLabel('Parent / guardian name', { exact: true })).toHaveValue('Local guardian');
    await expect(consent.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
    await captureLocalCheck(fixture.display, 'ticket-display-consent-pending-local.png');

    // This deterministic local camera frame exercises the existing staff-only capture component.
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const context = canvas.getContext('2d')!; context.fillStyle = '#285646'; context.fillRect(0, 0, 320, 240);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        const stream = canvas.captureStream(5);
        const repaint = window.setInterval(() => context.fillRect(0, 0, 320, 240), 100);
        stream.getVideoTracks()[0].addEventListener('ended', () => window.clearInterval(repaint), { once: true });
        return stream;
      } });
    });
    await page.getByRole('button', { name: 'Private child details', exact: true }).click();
    const privateForm = page.getByRole('dialog', { name: 'Private child details', exact: true });
    await expect(privateForm.getByPlaceholder('Your full name', { exact: true })).toHaveValue('Local guardian', { timeout: 20_000 });
    await privateForm.getByPlaceholder(/^e.g. peanut allergy/).fill('Private local health marker');
    await privateForm.getByRole('button', { name: 'Start camera', exact: true }).click();
    await privateForm.getByRole('button', { name: 'Take photo', exact: true }).click();
    await expect(privateForm.getByAltText('Captured', { exact: true })).toBeVisible();
    const ready = readConsent(true);
    await privateForm.getByRole('button', { name: 'Close', exact: true }).click();
    const valid = (await (await ready).json()).document;
    expect(valid.prompt.staffReady === true && valid.prompt.consentAcknowledged === true
      && valid.prompt.confirmations.every((item: { required: boolean; acknowledged: boolean }) => !item.required || item.acknowledged)).toBe(true);
    expect(/Private local health marker|childPhotoUrl|data:image|medical|foodRestrictions|waived/.test(JSON.stringify(valid))).toBe(false);
    await expect(consent.getByRole('button', { name: 'Done', exact: true })).toBeEnabled({ timeout: 20_000 });
    const finished = readConsent(true, true);
    await consent.getByRole('button', { name: 'Done', exact: true }).click();
    await finished;
    await expect(page.getByRole('heading', { name: 'Children playing alone', exact: true })).toBeVisible();
    await expect(consent.getByText('Thank you. The team will complete the staff checks.', { exact: true })).toBeVisible();
    expect(businessWrites === 0).toBe(true);
    await captureLocalCheck(fixture.display, 'ticket-display-consent-complete-local.png');

    await page.getByRole('button', { name: 'Private child details', exact: true }).click();
    await privateForm.getByPlaceholder('Your full name', { exact: true }).fill('Local guardian updated');
    await privateForm.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(consent.getByRole('button', { name: 'Ask the team', exact: true })).toBeVisible({ timeout: 20_000 });
    await consent.getByRole('button', { name: 'Ask the team', exact: true }).click();
    await expect(fixture.display.getByText('Please follow the staff screen.', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByPlaceholder('Your full name', { exact: true })).toBeVisible();
    expect(businessWrites === 0).toBe(true);
  } catch (error) {
    await captureLocalCheck(page, 'consent-failure-staff-local.png').catch(() => undefined);
    throw error;
  } finally {
    blockRead = false;
    page.off('request', observe); fixture.display.off('request', observe);
    try {
      await fixture.releaseLease();
    } finally {
      try { await fixture.cleanup(); } finally { await clearStaffPage(page); }
    }
  }
});

test('separate display guest shop uses captured sizes, lock retention, disconnect fallback and settled cash split', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  requireLocalFixture(baseURL);
  await page.goto('/');
  await signIn(page);
  const fixture = await pairedDisplay(browser, page, baseURL);
  const shopSession = (stage: string, quantity?: number, amountSatang?: number) => {
    let lastStatus: number | null = null;
    let lastStage = 'none';
    let lastSupported = false;
    return fixture.display.waitForResponse(async response => {
      if (!response.url().endsWith('/api/display/session')) return false;
      lastStatus = response.status();
      if (lastStatus !== 200) return false;
      const document = (await response.json().catch(() => null))?.document;
      lastStage = ['welcome', 'order', 'payment', 'thankyou'].includes(document?.stage) ? document.stage : 'other';
      lastSupported = document?.cart?.kind === 'merch' && document.cart.supported === true;
      return lastStage === stage && lastSupported
        && (quantity === undefined || document.cart.lines[0]?.qty === quantity)
        && (amountSatang === undefined || document.payment?.amountSatang === amountSatang);
    }).catch(() => { throw new Error(`Shop display ${stage} response missing (status=${lastStatus}, stage=${lastStage}, supported=${lastSupported})`); });
  };
  try {
    const welcome = shopSession('welcome');
    await page.getByRole('button', { name: 'Shop', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Retail Sale', exact: true })).toBeVisible();
    await welcome;
    const publicShop = fixture.display.getByTestId('display-merch');
    await expect(publicShop.getByRole('heading', { name: 'Oto Shop', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(publicShop.getByText(/wristband|credit balance|remaining credit/i)).toHaveCount(0);
    await page.getByRole('button', { name: /No wristband.*continue as guest/ }).click();
    await page.getByRole('button', { name: /Grip Socks/ }).click();
    const picked = shopSession('order', 1);
    await page.getByRole('dialog', { name: 'Choose size — Grip Socks', exact: true })
      .getByRole('button', { name: 'M', exact: true }).click();
    await picked;
    const quoted = page.waitForResponse(response => response.url().endsWith('/api/sales/quote')
      && response.request().method() === 'POST' && response.status() === 200
      && response.request().postDataJSON()?.items?.some((item: { quantity: number }) => item.quantity === 2));
    const doubled = shopSession('order', 2);
    await page.getByRole('button', { name: 'Add one Grip Socks', exact: true }).click();
    const quote = (await (await quoted).json()).quote;
    const document = (await (await doubled).json()).document;
    const line = document.cart.lines[0];
    const captured = Object.values(quote.itemPresentation)[0] as { name: string; basePriceSatang: number };
    expect(line.qty === 2 && line.name === captured.name && line.name.includes('Grip Socks') && line.name.includes('M')
      && Math.round(line.unitPrice * 100) === captured.basePriceSatang
      && Math.round(line.lineTotal * 100) === captured.basePriceSatang * 2
      && Math.round(document.totals.total * 100) === quote.totals.grossSatang
      && document.step === null && document.member === null && document.prompt === null).toBe(true);
    await expect(publicShop.getByTestId('merch-display-line')).toHaveCount(1);
    await expect(publicShop.getByText(line.name, { exact: true })).toBeVisible();
    await expect(publicShop.getByText(`฿${line.unitPrice} each`, { exact: true })).toBeVisible();
    await expect(publicShop.getByText(`฿${document.totals.total}`, { exact: true }).last()).toBeVisible();
    await expect(publicShop.getByText(/medical|allergy|wallet|remaining credit|stock|cost/i)).toHaveCount(0);
    for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
      await fixture.display.setViewportSize(viewport);
      expect(await fixture.display.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await fixture.display.setViewportSize({ width: 1024, height: 768 });
    await captureLocalCheck(fixture.display, 'shop-display-order-local.png');

    await page.getByLabel('Lock screen').click();
    await expect(page.getByRole('heading', { name: 'Locked', exact: true })).toBeVisible();
    const locked = (await (await shopSession('order', 2)).json()).document;
    expect(JSON.stringify(locked.cart) === JSON.stringify(document.cart)
      && JSON.stringify(locked.totals) === JSON.stringify(document.totals)).toBe(true);
    await unlock(page);
    await expect(page.getByRole('button', { name: `Charge ฿${document.totals.total}`, exact: true })).toBeVisible();

    await fixture.display.context().setOffline(true);
    await expect(page.getByTestId('merch-display-line')).toHaveCount(1, { timeout: 25_000 });
    await expect(page.getByTestId('merch-display-line').getByText(line.name, { exact: true })).toBeVisible();
    await captureLocalCheck(page, 'shop-display-disconnected-inline-local.png');
    const reconnected = shopSession('order', 2);
    await fixture.display.context().setOffline(false);
    await reconnected;
    await expect(page.getByText(/Display connected:/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('merch-display-line')).toHaveCount(0, { timeout: 20_000 });

    const payment = shopSession('payment', 2);
    await page.getByRole('button', { name: `Charge ฿${document.totals.total}`, exact: true }).click();
    await payment;
    await expect(publicShop.getByText('Amount to pay', { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Cash / }).click();
    await page.getByLabel('Payment amount', { exact: true }).fill('100.00');
    await page.getByLabel('Cash received', { exact: true }).fill('110.00');
    const partial = page.waitForResponse(response => /\/api\/sales\/[^/]+\/finalise$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST' && response.status() === 200);
    const remainingSatang = quote.totals.grossSatang - 10_000;
    const remainder = shopSession('payment', 2, remainingSatang);
    await page.getByRole('button', { name: 'Record cash', exact: true }).click();
    const part = (await (await partial).json());
    expect(part.sale?.status === 'tendering' && part.outstandingSatang === remainingSatang).toBe(true);
    const unpaid = (await (await remainder).json()).document;
    expect(unpaid.cart.completion === null && unpaid.payment.amountSatang === remainingSatang).toBe(true);
    await expect(page.getByRole('heading', { name: 'Sale Confirmed', exact: true })).toHaveCount(0);
    await expect(publicShop.getByRole('heading', { name: 'Thank you!', exact: true })).toHaveCount(0);
    await captureLocalCheck(fixture.display, 'shop-display-payment-partial-local.png');
    await page.getByRole('button', { name: /^Cash / }).click();
    await page.getByLabel('Cash received', { exact: true }).fill((remainingSatang / 100 + 10).toFixed(2));
    const finalised = page.waitForResponse(response => /\/api\/sales\/[^/]+\/finalise$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST' && response.status() === 200);
    const thankyou = shopSession('thankyou', 2);
    await page.getByRole('button', { name: 'Record cash', exact: true }).click();
    const written = (await (await finalised).json()).sale;
    const completed = (await (await thankyou).json()).document;
    const summary = completed.cart.completion;
    expect(written?.status === 'finalised' && summary?.saleId === written.id
      && Math.round(summary.total * 100) === written.totals.grossSatang
      && summary.payment.cash === summary.total && summary.payment.card === 0 && summary.payment.promptpay === 0).toBe(true);
    await expect(page.getByRole('heading', { name: 'Sale Confirmed', exact: true })).toBeVisible();
    await expect(publicShop.getByRole('heading', { name: 'Thank you!', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(publicShop.getByText('Cash', { exact: true })).toBeVisible();
    await expect(publicShop.getByText(/wallet|remaining credit|credit balance/i)).toHaveCount(0);
    await captureLocalCheck(fixture.display, 'shop-display-completed-local.png');
  } finally {
    await fixture.display.context().setOffline(false).catch(() => undefined);
    try {
      if (await page.getByRole('heading', { name: 'Locked', exact: true }).isVisible()) await unlock(page);
      if (await page.getByLabel('Lock screen').isVisible()) { await fixture.releaseLease(); await signOut(page); }
    } finally {
      try { await fixture.cleanup(); } finally { await clearStaffPage(page); }
    }
  }
});
