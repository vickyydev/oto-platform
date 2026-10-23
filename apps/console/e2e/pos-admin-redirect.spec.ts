import { expect, test, type Page } from '@playwright/test';
import { OPERATOR_ADMIN, signIn } from './console';

const posPort = process.env.CONSOLE_E2E_POS_PORT;
const posOrigin = posPort ? `http://127.0.0.1:${posPort}` : '';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.beforeAll(() => {
  if (!posPort) throw new Error('The shared built POS server is required for this cross-app proof.');
});

function pause() {
  let release!: () => void;
  const promise = new Promise<void>(complete => { release = complete; });
  return { promise, release };
}
type Identity = { accountId: string; branchId: string | null };
async function identity(page: Page): Promise<Identity> {
  const response = await page.request.get(`${posOrigin}/api/me`);
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('account' in body) || !('branch' in body) ||
    typeof body.account !== 'object' || body.account === null || !('id' in body.account) || typeof body.account.id !== 'string') {
    throw new Error('The signed-in actor could not be read.');
  }
  const branch = body.branch;
  let branchId: string | null = null;
  if (branch !== null) {
    if (typeof branch !== 'object' || !('id' in branch) || typeof branch.id !== 'string') {
      throw new Error('The current park could not be read.');
    }
    branchId = branch.id;
  }
  return { accountId: body.account.id, branchId };
}
async function signedIn(page: Page): Promise<Identity> {
  await signIn(page);
  await expect.poll(() => new URL(page.url()).pathname === '/overview').toBe(true);
  return identity(page);
}
async function arrived(page: Page, baseURL: string | undefined, path: string) {
  if (!baseURL) throw new Error('The Console origin is required.');
  const origin = new URL(baseURL).origin;
  // Report booleans on failure, never a transient issued fragment or claim.
  await expect.poll(() => {
    const current = new URL(page.url());
    return current.origin === origin && current.pathname === path && current.hash === '';
  }, { timeout: 30_000 }).toBe(true);
}
async function cleanup(page: Page) {
  try { await page.request.post(`${posOrigin}/api/auth/sign-out`); }
  finally { await page.goto('about:blank'); }
}

test('a bookmarked POS admin address reaches the native Admin page as the same actor and park', async ({ page, baseURL }) => {
  const before = await signedIn(page);
  let issues = 0, exchanges = 0, businessWrites = 0;
  page.on('request', request => {
    if (request.method() === 'GET') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/handoff') { issues++; expect(request.postDataJSON()).toEqual({ app: 'console' }); }
    else if (path === '/api/auth/handoff/exchange') exchanges++;
    else if (!path.startsWith('/api/auth/')) businessWrites++;
  });
  try {
    await page.goto(`${posOrigin}/admin?panel=tickets&next=https%3A%2F%2Fignored.invalid`);
    await arrived(page, baseURL, '/catalogue/tickets');
    await expect(page.getByRole('heading', { name: 'Tickets', exact: true }).first()).toBeVisible();
    expect(await identity(page)).toEqual(before);
    expect(issues).toBe(1); expect(exchanges).toBe(1); expect(businessWrites).toBe(0);
  } finally { await cleanup(page); }
});

test('signed-out POS bookmarks retain sign-in and then open Admin without choosing a station', async ({ page, baseURL }) => {
  let issues = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/handoff') issues++; });
  try {
    await page.goto(`${posOrigin}/admin?panel=reports-sales`);
    await expect(page.getByRole('heading', { name: 'Sign in to open Admin', exact: true })).toBeVisible();
    expect(issues).toBe(0);
    await page.locator('input[type="tel"]').fill(OPERATOR_ADMIN.phone);
    await page.locator('input[type="password"]').fill(OPERATOR_ADMIN.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await arrived(page, baseURL, '/reports/sales');
    await expect(page.getByRole('heading', { name: 'Sales', exact: true }).first()).toBeVisible();
    expect(issues).toBe(1);
    await expect(page.getByRole('heading', { name: 'Which station are you on?', exact: true })).toHaveCount(0);
  } finally { await cleanup(page); }
});

test('the source withholds automatic issuance when the returned app-access offer is absent', async ({ page }) => {
  await signedIn(page);
  let issues = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/handoff') issues++; });
  await page.route(`${posOrigin}/api/me/permissions`, async route => {
    const response = await route.fetch();
    const body = await response.json() as { permissions: { permission: string }[] };
    await route.fulfill({ response, json: { ...body, permissions: body.permissions.filter(entry => entry.permission !== 'app:console:access') } });
  });
  try {
    await page.goto(`${posOrigin}/admin?panel=tax`);
    await expect(page.getByRole('heading', { name: 'Admin is not on your access', exact: true })).toBeVisible();
    expect(issues).toBe(0);
    await expect(page.getByRole('button', { name: 'Sign in as a different user', exact: true })).toBeVisible();
  } finally { await cleanup(page); }
});

test('a controlled handoff refusal remains readable at phone width and only an explicit retry makes a real arrival', async ({ page, baseURL }) => {
  const before = await signedIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  let issues = 0;
  await page.route(`${posOrigin}/api/auth/handoff`, async route => {
    issues++;
    if (issues === 1) return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST controlled refusal' } } });
    return route.continue();
  });
  try {
    await page.goto(`${posOrigin}/admin?panel=members`);
    await expect(page.getByRole('alert')).toHaveText('This account cannot open Admin. Ask an administrator for access.');
    expect(issues).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.getByRole('button', { name: 'Try opening Admin again', exact: true }).click();
    await arrived(page, baseURL, '/catalogue/members');
    await expect(page.getByRole('heading', { name: 'Members', exact: true }).first()).toBeVisible();
    expect(await identity(page)).toEqual(before); expect(issues).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  } finally { await cleanup(page); }
});

test('a phone bookmark change invalidates the old real issued response before the current request opens Admin', async ({ page, baseURL }) => {
  const before = await signedIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const firstRead = pause(), secondRead = pause(), releaseFirst = pause(), releaseSecond = pause();
  const firstFinished = pause();
  let issues = 0, exchanges = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/handoff/exchange') exchanges++; });
  await page.route(`${posOrigin}/api/auth/handoff`, async route => {
    const ordinal = ++issues;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (ordinal === 1) { firstRead.release(); await releaseFirst.promise; }
    else if (ordinal === 2) { secondRead.release(); await releaseSecond.promise; }
    await route.fulfill({ response });
    if (ordinal === 1) firstFinished.release();
  });
  try {
    await page.goto(`${posOrigin}/admin?panel=tax`); await firstRead.promise;
    await page.evaluate(() => { history.pushState(null, '', '/admin?panel=menu'); dispatchEvent(new PopStateEvent('popstate')); });
    await secondRead.promise; releaseFirst.release(); await firstFinished.promise;
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(new URL(page.url()).origin === posOrigin && new URL(page.url()).search === '?panel=menu').toBe(true);
    expect(exchanges).toBe(0);
    await expect(page.getByRole('status').filter({ hasText: 'Opening your Admin page' })).toBeVisible();
    releaseSecond.release(); await arrived(page, baseURL, '/catalogue/menu');
    await expect(page.getByRole('heading', { name: 'Menu', exact: true }).first()).toBeVisible();
    expect(await identity(page)).toEqual(before); expect(issues).toBe(2); expect(exchanges).toBe(1);
  } finally { releaseFirst.release(); releaseSecond.release(); await cleanup(page); }
});

test('the existing print-template kind is carried to its native Admin editor and close removes that query', async ({ page, baseURL }) => {
  const before = await signedIn(page);
  try {
    await page.goto(`${posOrigin}/admin?panel=templates&template=receipt&next=%2Fplatform`);
    await arrived(page, baseURL, '/catalogue/print-templates');
    expect(new URL(page.url()).searchParams.get('template') === 'receipt').toBe(true);
    await expect(page.getByRole('button', { name: 'Back to all templates', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to all templates', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has('template')).toBe(false);
    expect(await identity(page)).toEqual(before);
  } finally { await cleanup(page); }
});
