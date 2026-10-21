import { expect, test, type Page } from '@playwright/test';

const parks = [
  { id: '01900000-0000-7000-8000-000000000001', name: 'ZZ TEST Central', timezone: 'Asia/Bangkok',
    businessDayStart: '04:00:00', businessDate: '2026-10-22' },
  { id: '01900000-0000-7000-8000-000000000002', name: 'ZZ TEST West', timezone: 'Europe/London',
    businessDayStart: '04:00:00', businessDate: '2026-10-21' },
] as const;
const amounts = {
  revenueSatang: 123450, guests: 14, inParkNow: 9, bookingsToday: 3,
  inboxUnanswered: 2, openAlerts: 4, boxesOffline: 1,
};
const labels = ['Revenue today', 'Guests today', 'In park now', 'Bookings today',
  'Inbox unanswered', 'Open alerts', 'Boxes offline'];

function snapshot(branchId = '') {
  const selected = branchId ? parks.filter((park) => park.id === branchId) : parks;
  return {
    generatedAt: '2026-10-22T06:00:00.000Z', branches: parks,
    selectedBranchIds: selected.map((park) => park.id), totals: {
      ...amounts, revenueSatang: branchId ? 432100 : 123450,
    },
    parks: selected.map((park) => ({
      branchId: park.id, businessDate: park.businessDate, ...amounts,
      analyticsSource: 'oto_pos', provisional: true, lastRolledUpAt: '2026-10-22T05:55:00.000Z',
      occupancyAsOf: '2026-10-22T05:59:30.000Z', occupancyStale: true,
    })),
  };
}

async function session(page: Page, sourceAccess = true, overviewAccess = true) {
  // Every route is mocked: these browser controls exercise the actual built
  // Console without depending on whichever business figures a seed carries.
  await page.route('**/api/**', (route) => route.fulfill({ status: 403,
    json: { error: { code: 'PERMISSION_DENIED', message: 'Not on this fixture’s access.' } } }));
  await page.route('**/api/me', (route) => route.fulfill({ json: {
    account: { id: 'fixture', phone: '', status: 'active', mustChangePassword: false, operatorId: 'fixture' },
    employee: { id: 'fixture', name: 'ZZ TEST Overview', nickname: null }, branch: null,
    isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
  } }));
  const permissions = ['app:console:access', ...(overviewAccess ? ['console:overview:read'] : []),
    ...(sourceAccess ? ['app:pos:access', 'analytics:read', 'pos:checkin:read', 'pos:booking:read',
      'app:inbox:access', 'inbox:dashboard:read', 'admin:health:read', 'admin:station:read', 'admin:box:read'] : [])];
  await page.route('**/api/me/permissions', (route) => route.fulfill({ json: {
    permissions: permissions.map((permission) => ({ permission, scopeType: 'branch', scopeId: parks[0].id })),
  } }));
  await page.route('**/api/overview*', (route) => route.fulfill({
    json: snapshot(new URL(route.request().url()).searchParams.get('branchId') ?? ''),
  }));
}

test('Overview displays returned totals, selected parks and source freshness on desktop and phone', async ({ page }, testInfo) => {
  await session(page);
  const reads: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/overview') reads.push(request.url()); });
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  for (const label of labels) await expect(page.getByRole('article', { name: label, exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('1,234.50');
  const freshness = page.getByRole('list', { name: 'Park freshness' });
  await expect(freshness).toContainText('Business date 2026-10-22');
  await expect(freshness).toContainText('Business date 2026-10-21');
  await expect(freshness.getByText('Occupancy is stale', { exact: true })).toHaveCount(2);
  await expect(freshness.locator('time').first()).toHaveAttribute('datetime', '2026-10-22T05:55:00.000Z');
  await page.screenshot({ path: testInfo.outputPath('overview-desktop.png'), fullPage: true });

  const picker = page.getByRole('combobox', { name: 'Park', exact: true });
  await picker.selectOption(parks[1].id);
  await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('฿4,321');
  expect(new URL(reads.at(-1)!).searchParams.get('branchId')).toBe(parks[1].id);
  await expect(freshness).not.toContainText(parks[0].name);
  await expect(freshness).toContainText(parks[1].name);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(picker).toBeVisible();
  await picker.selectOption('');
  await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('1,234.50');
  await page.getByRole('article', { name: 'Boxes offline', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('article', { name: 'Boxes offline', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole('heading', { name: 'Overview', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('overview-phone.png'), fullPage: true });
});

test('Overview-only permission shows numbers while source offers and other page guards retain their permissions', async ({ page }) => {
  await session(page, false);
  await page.goto('/overview');
  await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('1,234.50');
  await expect(page.getByText('Source screen is not on your access.', { exact: true })).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Open Performance', exact: true })).toHaveCount(0);
  await page.goto('/watch/health');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  await session(page, false, false);
  let overviewReads = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/overview') overviewReads++; });
  await page.goto('/overview');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  expect(overviewReads).toBe(0);
});

test('a pending or failed summary has no invented figures and can be retried; no parks is a separate empty state', async ({ page }) => {
  await session(page);
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/overview*', async (route) => {
    attempts++;
    if (attempts === 1) {
      await wait;
      await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'The summary source did not answer.' } } });
    } else await route.fulfill({ json: snapshot() });
  });
  await page.goto('/overview');
  await expect(page.getByText('Loading today’s figures…', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  release!();
  await expect(page.getByText('Overview figures could not be read', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('1,234.50');
  await page.route('**/api/overview*', (route) => route.fulfill({ json: {
    ...snapshot(), branches: [], selectedBranchIds: [], parks: [],
  } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('No reachable parks', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
});

test('figure actions use the existing source pages and signed-in cross-app destinations', async ({ page }) => {
  await session(page);
  await page.route('https://source.example/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>ZZ TEST source</p>' }));
  const issuedFor: string[] = [];
  let unavailable = true;
  await page.route('**/api/auth/handoff', (route) => {
    issuedFor.push((route.request().postDataJSON() as { app: string }).app);
    if (unavailable) return route.fulfill({ status: 409, json: {
      error: { code: 'APP_UNAVAILABLE', message: 'This source app is not configured.' },
    } });
    return route.fulfill({ json: { launchUrl: 'https://source.example/#handoff=fixture' } });
  });
  await page.goto('/overview');
  await page.getByRole('article', { name: 'Revenue today', exact: true }).getByRole('button', { name: 'Open Performance', exact: true }).click();
  await expect(page.getByText('This source app is not configured.', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('1,234.50');
  unavailable = false;
  for (const [figure, action, app, target] of [
    ['Revenue today', 'Open Performance', 'pos', '/today'],
    ['In park now', 'Open POS occupancy', 'pos', '/today'],
    ['Inbox unanswered', 'Open unanswered Inbox', 'inbox', '/?unanswered=1'],
  ] as const) {
    await page.goto('/overview');
    await page.getByRole('article', { name: figure, exact: true }).getByRole('button', { name: action, exact: true }).click();
    await page.waitForURL(`https://source.example/#handoff=fixture&to=${encodeURIComponent(target)}`);
    expect(issuedFor.at(-1)).toBe(app);
  }
  await page.goto('/overview');
  for (const [label, path] of [['Open Bookings', '/reports/bookings'], ['Open Health', '/watch/health'], ['Open Devices', '/devices']] as const) {
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', path);
  }
});
