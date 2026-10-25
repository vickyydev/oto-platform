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

function snapshot(branchId = '', narrow = false, marker = 'ZZ TEST current summary') {
  const reachable = narrow ? parks.slice(0, 1) : [...parks];
  const selected = branchId ? reachable.filter((park) => park.id === branchId) : reachable;
  const generatedAt = '2026-10-22T06:00:00.000Z', period = { from: '2026-10-23', to: '2026-10-23' };
  const envelope = { generatedAt, branches: reachable, selectedBranchIds: selected.map(park => park.id) };
  const visits = { visits: 12, draftVisits: 2, activeVisits: 7, closedVisits: 3, visitingMembers: 7 };
  const bookings = { bookings: 8, bookedValueSatang: 543210, redeemedBookings: 6 };
  const metrics = { count: 5, inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, totalTokens: 20,
    spendEstimate: null, reason: 'no_rate_configured', unpricedTokens: 20 };
  const usage = { ...envelope, period, basis: 'created-at-bangkok', coverage: 'retained-records', currency: 'USD', excludesCacheWrites: true,
    totals: metrics, parks: selected.map(park => ({ branchId: park.id, totals: metrics, rows: [{ date: period.from, ...metrics }] })),
    operatorWide: branchId || narrow ? null : { totals: { ...metrics, count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, unpricedTokens: 0 },
      rows: [{ date: period.from, ...metrics, count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, unpricedTokens: 0 }] } };
  const fleet = { boxes: 8, online: 3, offline: 2, unclaimed: 1, disabled: 2 };
  const items = [
    { key: 'pendingPayments', label: 'Old unresolved payment attempts', status: 'available', count: 2, basis: 'native-pending-attempt-threshold' },
    { key: 'syncQuarantine', label: 'Open sync quarantine', status: 'available', count: 0, basis: 'open-owned-selected-park-boxes' },
    { key: 'cashVariances', label: 'Cash variance lines', status: 'unavailable', count: null, basis: 'saved-current-business-date-off-lines' },
    { key: 'latePayments', label: 'Late payment alerts', status: 'available', count: 1, basis: 'unresolved-native-late-payment-alerts' },
    { key: 'strandedOccupants', label: 'End-of-day review rows still inside', status: 'available', count: 4, basis: 'current-business-date-native-end-of-day-rows' },
    { key: 'erasureRequests', label: 'Erasure requests', status: 'not-built', count: null, basis: 'not-built' },
    { key: 'approvalRequests', label: 'Approval requests', status: 'not-built', count: null, basis: 'not-built' },
  ];
  return {
    generatedAt, branches: reachable,
    selectedBranchIds: selected.map((park) => park.id), totals: {
      ...amounts, revenueSatang: branchId ? 432100 : 123450,
    },
    parks: selected.map((park) => ({
      branchId: park.id, businessDate: park.businessDate, ...amounts,
      analyticsSource: 'oto_pos', provisional: true, lastRolledUpAt: '2026-10-22T05:55:00.000Z',
      occupancyAsOf: '2026-10-22T05:59:30.000Z', occupancyStale: true,
    })),
    aggregates: {
      members: { ...envelope, period, basis: 'visit-date', totals: visits,
        parks: selected.map(park => ({ branchId: park.id, totals: { ...visits, visitingMembers: 5 }, rows: [{ date: period.from, ...visits, visitingMembers: 5 }] })) },
      bookings: { ...envelope, period, basis: 'booking-date', valueBasis: 'priced-booking-value', redemptionBasis: 'booking-date-cohort', totals: bookings,
        parks: selected.map(park => ({ branchId: park.id, totals: bookings, rows: [{ date: period.from, ...bookings }] })) },
      assistantUsage: { ...usage, attribution: 'seat-at-ask', retentionDays: 90 },
      inboxAiUsage: { ...usage, attribution: 'current-conversation-branch', retentionDays: null },
      fleet: { ...envelope, basis: 'current-snapshot', asOf: generatedAt, totals: fleet, parks: selected.map(park => ({ branchId: park.id, ...fleet })) },
    },
    decisions: { generatedAt, items, parks: selected.map(park => ({ branchId: park.id, items })) },
    statusSummary: `${marker}\n${selected.map(park => park.name).join(', ')}\nBangkok calendar 2026-10-23\nAI price unavailable in USD; no_rate_configured;20 unpriced tokens; excludes cache writes.`,
  };
}

async function session(page: Page, sourceAccess = true, overviewAccess = true) {
  const control = { actor: 'fixture', operator: 'fixture', locked: false, narrow: false, marker: 'ZZ TEST current summary',
    overrideRevenue: null as number | null, writes: [] as string[],
    permissions: ['app:console:access', ...(overviewAccess ? ['console:overview:read'] : []),
      ...(sourceAccess ? ['app:pos:access', 'analytics:read', 'pos:checkin:read', 'pos:booking:read',
        'app:inbox:access', 'inbox:dashboard:read', 'admin:health:read', 'admin:station:read', 'admin:box:read'] : [])],
    holds: [] as Promise<void>[], reads: [] as { actor: string; branchId: string }[] };
  page.on('request', request => { const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET') control.writes.push(`${request.method()} ${url.pathname}`);
  });
  // Every route is mocked: these browser controls exercise the actual built
  // Console without depending on whichever business figures a seed carries.
  await page.route('**/api/**', (route) => route.fulfill({ status: 403,
    json: { error: { code: 'PERMISSION_DENIED', message: 'Not on this fixture’s access.' } } }));
  await page.route('**/api/me', (route) => route.fulfill({ json: {
    account: { id: control.actor, phone: '', status: 'active', mustChangePassword: false, operatorId: control.operator },
    employee: { id: 'fixture', name: 'ZZ TEST Overview', nickname: null }, branch: null,
    isPlatformAdmin: false, photoFileId: null, sessionLocked: control.locked,
  } }));
  await page.route('**/api/me/permissions', (route) => route.fulfill({ json: {
    permissions: control.permissions.map((permission) => ({ permission,
      scopeType: permission === 'console:overview:read' && !control.narrow ? 'operator' : 'branch',
      scopeId: permission === 'console:overview:read' && !control.narrow ? control.operator : parks[0].id })),
  } }));
  await page.route('**/api/overview*', async route => {
    const branchId = new URL(route.request().url()).searchParams.get('branchId') ?? '';
    control.reads.push({ actor: control.actor, branchId });
    const body = snapshot(branchId, control.narrow, control.marker), wait = control.holds.shift();
    if (control.overrideRevenue !== null) body.totals.revenueSatang = control.overrideRevenue;
    if (wait) await wait;
    if (control.narrow && branchId === parks[1].id) return route.fulfill({ status: 403,
      json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST old park no longer reachable.' } } });
    return route.fulfill({ json: body });
  });
  return control;
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
  for (const [figure, label, path] of [
    ['Bookings today', 'Open Bookings', '/reports/bookings'],
    ['Open alerts', 'Open Health', '/watch/health'],
    ['Boxes offline', 'Open Devices', '/devices'],
  ] as const) {
    await expect(page.getByRole('article', { name: figure, exact: true }).getByRole('link', { name: label, exact: true })).toHaveAttribute('href', path);
  }
});

const group = (page: Page, title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
function pause() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function refreshSession(page: Page) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/me/permissions');
  await page.evaluate(() => window.dispatchEvent(new Event('oto:session-locked')));
  await (await response).finished();
}
async function legacyReady(page: Page) {
  await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('1,234.50');
}

test('Overview v2 renders returned aggregate dates, distinct members and unavailable USD on desktop and phone', async ({ page }) => {
  const state = await session(page); await page.goto('/overview'); await legacyReady(page);
  for (const title of ['Members & visits', 'Booking activity', 'Internal assistant', 'Inbox AI', 'Fleet', 'Needs a decision'])
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 5000 });
  await expect(group(page, 'Members & visits')).toContainText('Visiting members');
  await expect(group(page, 'Members & visits')).toContainText('7');
  await expect(group(page, 'Members & visits')).toContainText('Bangkok calendar');
  await expect(group(page, 'Members & visits')).toContainText('2026-10-23');
  await expect(group(page, 'Booking activity')).toContainText('Priced booking value');
  await expect(group(page, 'Booking activity')).toContainText('5,432.10');
  await expect(group(page, 'Fleet')).toContainText('Current snapshot');
  for (const title of ['Internal assistant', 'Inbox AI']) {
    await expect(group(page, title)).toContainText('Price unavailable'); await expect(group(page, title)).toContainText('USD');
    await expect(group(page, title)).toContainText('no_rate_configured'); await expect(group(page, title)).toContainText('20 unpriced tokens');
    await expect(group(page, title)).toContainText('excludes cache writes'); await expect(group(page, title)).not.toContainText('USD 0.00');
  }
  await expect(page.getByRole('list', { name: 'Park freshness' })).toContainText('Business date 2026-10-21');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Needs a decision', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Copy status summary', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(state.writes).toEqual([]);
});

test('decision rows distinguish a real zero, missing cash close and unbuilt requests without an overdue-person claim', async ({ page }) => {
  const state = await session(page); await page.goto('/overview');
  const decisions = group(page, 'Needs a decision'); await expect(decisions).toBeVisible({ timeout: 5000 });
  const row = (label: string) => decisions.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
  await expect(row('Open sync quarantine')).toContainText('0');
  await expect(row('Cash variance lines')).toContainText('Unavailable');
  await expect(row('Erasure requests')).toContainText('Not built'); await expect(row('Approval requests')).toContainText('Not built');
  await expect(row('End-of-day review rows still inside')).toContainText('4');
  await expect(decisions).not.toContainText('Overdue people'); await expect(decisions).not.toContainText('No decisions needed');
  expect(state.writes).toEqual([]);
});

test('Copy status summary writes the exact current server text to the native clipboard and makes no business request', async ({ page }) => {
  const state = await session(page); await page.goto('/overview');
  const copy = page.getByRole('button', { name: 'Copy status summary', exact: true });
  await expect(copy).toBeEnabled({ timeout: 5000 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await page.evaluate(() => navigator.clipboard.writeText('ZZ TEST clipboard sentinel'));
  await copy.click();
  const expected = snapshot().statusSummary;
  // Return only a boolean: a failed copy must not reveal the machine's unrelated clipboard.
  await expect.poll(() => page.evaluate(async text => (await navigator.clipboard.readText()) === text, expected)).toBe(true);
  await expect(page.getByText('Status summary copied.', { exact: true })).toBeVisible();
  const picker = page.getByRole('combobox', { name: 'Park', exact: true }); await picker.selectOption(parks[1].id);
  await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('4,321');
  await copy.click();
  await expect.poll(() => page.evaluate(async text => (await navigator.clipboard.readText()) === text, snapshot(parks[1].id).statusSummary)).toBe(true);
  expect(state.writes).toEqual([]);
});

test('actor/operator A to B to A discards both earlier reads and masks their figures before effect cleanup', async ({ page }) => {
  const state = await session(page), first = pause(), second = pause(), current = pause(); state.holds.push(first.promise);
  try {
    await page.goto('/overview'); await expect.poll(() => state.reads.length).toBe(1);
    state.actor = 'fixture-b'; state.operator = 'fixture-operator-b'; state.overrideRevenue = 888888; state.holds.push(second.promise);
    await refreshSession(page); await expect.poll(() => state.reads.length, { timeout: 5000 }).toBe(2);
    state.actor = 'fixture'; state.operator = 'fixture'; state.overrideRevenue = 77777; state.holds.push(current.promise);
    await refreshSession(page); await expect.poll(() => state.reads.length, { timeout: 5000 }).toBe(3);
    first.release(); second.release();
    await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy status summary', exact: true })).toBeDisabled();
    current.release(); await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('777.77');
    expect(state.reads.map(read => read.actor)).toEqual(['fixture', 'fixture-b', 'fixture']); expect(state.writes).toEqual([]);
  } finally { first.release(); second.release(); current.release(); }
});

test('grant narrowing drops an obsolete selected park before reading the current default', async ({ page }) => {
  const state = await session(page), narrowed = pause();
  try {
    await page.goto('/overview'); await legacyReady(page);
    await page.getByRole('combobox', { name: 'Park', exact: true }).selectOption(parks[1].id);
    await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toContainText('4,321');
    state.narrow = true; state.holds.push(narrowed.promise); await refreshSession(page);
    await expect.poll(() => state.reads.length, { timeout: 5000 }).toBe(3); expect(state.reads.at(-1)?.branchId).toBe('');
    await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toHaveCount(0);
    narrowed.release(); await legacyReady(page);
    await expect(page.getByRole('combobox', { name: 'Park', exact: true }).getByRole('option', { name: parks[1].name, exact: true })).toHaveCount(0);
    expect(state.writes).toEqual([]);
  } finally { narrowed.release(); }
});

for (const change of ['actor-ABA', 'lock'] as const) {
  test(`a pending source handoff cannot navigate after ${change}`, async ({ page }) => {
    const state = await session(page), held = pause(); let issued = 0, navigations = 0;
    await page.route('https://source.example/**', route => { navigations++; return route.fulfill({ contentType: 'text/html', body: '<p>ZZ TEST intercepted source</p>' }); });
    await page.route('**/api/auth/handoff', async route => { issued++; await held.promise;
      return route.fulfill({ json: { launchUrl: 'https://source.example/#handoff=ZZ-TEST-only' } }); });
    try {
      await page.goto('/overview'); await legacyReady(page);
      await page.getByRole('article', { name: 'Revenue today', exact: true }).getByRole('button', { name: 'Open Performance', exact: true }).click();
      await expect.poll(() => issued).toBe(1);
      if (change === 'lock') { state.locked = true; await refreshSession(page);
        await expect(page.getByRole('article', { name: 'Revenue today', exact: true })).toHaveCount(0);
      } else { state.actor = 'fixture-b'; await refreshSession(page); state.actor = 'fixture'; await refreshSession(page); }
      const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/auth/handoff');
      held.release(); await (await response).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(navigations).toBe(0); expect(new URL(page.url()).pathname).toBe('/overview');
      expect(state.writes).toEqual(['POST /api/auth/handoff']);
    } finally { held.release(); }
  });
}
