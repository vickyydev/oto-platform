import { expect, test, type Page, type Route } from '@playwright/test';

const PARK_A = '01900000-0000-7000-8000-000000000001';
const PARK_B = '01900000-0000-7000-8000-000000000002';
const company = '01900000-0000-7000-8000-000000000003';
const permissionNames = ['app:console:access', 'app:oto_app:access', 'admin:account:read'];
const targets = [
  ['On shift now', '/timekeeping-review?tab=live'],
  ['Attendance issues', '/timekeeping-review?tab=issues'],
  ['Leave entries today', '/scheduling'],
  ['Payroll month status', '/payroll'],
] as const;

function summary(branchId = PARK_A, working = 11) {
  const metric = (count: number): { status: string; count: number | null; asOf: string | null } =>
    ({ status: 'ready', count, asOf: '2026-10-25T01:30:00.000Z' });
  return {
    generatedAt: '2026-10-25T01:30:02.000Z',
    branches: [
      { id: PARK_A, name: 'ZZ TEST Central', timezone: 'Asia/Bangkok' },
      { id: PARK_B, name: 'ZZ TEST Riverside with a longer park name', timezone: 'Asia/Bangkok' },
    ],
    selectedBranchId: branchId, date: '2026-10-25', source: 'ready',
    working: metric(working), attendance: metric(4), leave: metric(0),
    payroll: { status: 'ready', month: '2026-10' as string | null, entities: [
      { id: company, name: 'ZZ TEST Paying company', version: 2, status: 'draft' },
    ] },
  };
}

async function fixture(page: Page, options: {
  read?: (route: Route, branchId: string | null, index: number) => Promise<unknown>;
  permissionRows?: () => Array<{ permission: string; scopeType: string; scopeId: string }>;
} = {}) {
  // Model a backend session separately from its immutable account identity.
  let fixtureSessionActor: string | null = null, fixtureSessionId = '';
  const fixtureOperatorContext = (actor: string, operatorId: string, branchId: string | null) => {
    if (fixtureSessionActor !== actor) {
      fixtureSessionActor = actor;
      fixtureSessionId = crypto.randomUUID();
    }
    return { sessionId: fixtureSessionId, homeOperatorId: operatorId, effectiveOperatorId: operatorId,
      operatorOverride: null, branchId, stationId: null, revision: 0 };
  };

  const seen = {
    permissions: [...permissionNames],
    reads: [] as Array<string | null>,
    writes: [] as string[],
    handoffs: [] as Array<{ body: unknown; key: string | undefined }>,
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/api/, '');
    if (path === '/me') return route.fulfill({ json: {
      operatorContext: fixtureOperatorContext('01964000-0000-7000-8000-00000000f121', '01964000-0000-7000-8000-00000000f122', ({ id: PARK_A, name: 'ZZ TEST Central', code: 'ZZ', timezone: 'Asia/Bangkok' })?.id ?? null),
      account: { id: '01964000-0000-7000-8000-00000000f121', phone: '', status: 'active', mustChangePassword: false, operatorId: '01964000-0000-7000-8000-00000000f122' },
      employee: { id: '01964000-0000-7000-8000-00000000f121', name: 'ZZ TEST Admin', nickname: null },
      branch: { id: PARK_A, name: 'ZZ TEST Central', code: 'ZZ', timezone: 'Asia/Bangkok' },
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: options.permissionRows?.() ?? seen.permissions.map(permission => ({
      permission, scopeType: 'branch', scopeId: PARK_A,
    })) } });
    if (path === '/staff/summary') {
      expect(request.method()).toBe('GET');
      const branchId = url.searchParams.get('branchId');
      seen.reads.push(branchId);
      return options.read ? options.read(route, branchId, seen.reads.length) : route.fulfill({ json: summary(branchId ?? PARK_A) });
    }
    if (path === '/auth/handoff' && request.method() === 'POST') {
      seen.handoffs.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
      return route.fulfill({ json: { launchUrl: 'https://oto-staff.test/#handoff=zz-local-placeholder' } });
    }
    if (request.method() !== 'GET') seen.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 403, json: { error: { code: 'FIXTURE_REFUSED', message: 'Not on fixture access.' } } });
  });
  await page.route('https://oto-staff.test/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>ZZ TEST native destination</h1>' }));
  return seen;
}

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('Staff opens its four read-only headlines at the existing area address with returned source dates', async ({ page }) => {
  const seen = await fixture(page);
  await page.goto('/staff');
  await expect(page.getByRole('heading', { name: 'Staff & HR', exact: true })).toBeVisible();
  for (const [name] of targets) await expect(card(page, name)).toBeVisible();
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toBeVisible();
  await expect(card(page, 'Attendance issues').getByText('4', { exact: true })).toBeVisible();
  await expect(card(page, 'Leave entries today').getByText('0', { exact: true })).toBeVisible();
  await expect(card(page, 'Payroll month status')).toContainText('ZZ TEST Paying company');
  await expect(card(page, 'Payroll month status')).toContainText('Draft');
  await expect(card(page, 'Payroll month status')).toContainText('Version 2');
  await expect(card(page, 'Payroll month status')).toContainText(/company|park.group/i);
  await expect(card(page, 'Payroll month status')).toContainText(/not filtered by.*park/i);
  await expect(page.locator('time[datetime="2026-10-25T01:30:00.000Z"]').first()).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Park', exact: true })).toHaveValue(PARK_A);
  await expect(page.getByText('Management panels are not available in this area yet.', { exact: true })).toHaveCount(0);
  expect(seen.reads).toEqual([null]);
  expect(seen.writes).toEqual([]);
  expect(seen.handoffs).toEqual([]);
});

test('both Staff permissions gate the direct page and prevent all summary or handoff requests', async ({ page }) => {
  const seen = await fixture(page);
  for (const allowed of [['admin:account:read'], ['app:oto_app:access'], []]) {
    seen.permissions = ['app:console:access', ...allowed];
    await page.goto('/staff');
    await expect(page.getByText(/not on your access/i).first()).toBeVisible();
    await expect(card(page, 'On shift now')).toHaveCount(0);
  }
  expect(seen.reads).toEqual([]);
  expect(seen.handoffs).toEqual([]);
  expect(seen.writes).toEqual([]);
});

test('failed summary read is retryable and never presented as a zero or an empty successful source', async ({ page }) => {
  const seen = await fixture(page, { read: async (route, _park, index) => index === 1
    ? route.fulfill({ status: 503, json: { error: { code: 'SOURCE_UNAVAILABLE', message: 'ZZ TEST staff source unavailable.' } } })
    : route.fulfill({ json: summary() }) });
  await page.goto('/staff');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(card(page, 'On shift now').getByText('0', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(seen.reads).toHaveLength(2);
  expect(seen.writes).toEqual([]);
});

test('zero, forbidden and unavailable are distinct and payroll never borrows another headline authority', async ({ page }) => {
  const answer = summary(PARK_A, 0);
  answer.attendance = { status: 'forbidden', count: null, asOf: null };
  answer.leave = { status: 'unavailable', count: null, asOf: null };
  answer.payroll = { status: 'forbidden', month: null, entities: [] };
  await fixture(page, { read: route => route.fulfill({ json: answer }) });
  await page.goto('/staff');
  await expect(card(page, 'On shift now').getByText('0', { exact: true })).toBeVisible();
  await expect(card(page, 'Attendance issues')).toContainText('Not on your access');
  await expect(card(page, 'Leave entries today')).toContainText('Unavailable');
  await expect(card(page, 'Payroll month status')).toContainText('Not on your access');
  for (const name of ['Attendance issues', 'Leave entries today', 'Payroll month status']) {
    await expect(card(page, name).getByText('0', { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText('ZZ TEST Paying company', { exact: true })).toHaveCount(0);
});

test('park A to B to A clears old figures and refuses a delayed B response', async ({ page }) => {
  let releaseB!: () => void;
  const pendingB = new Promise<void>(resolve => { releaseB = resolve; });
  let returnedB = false;
  const seen = await fixture(page, { read: async (route, branchId, index) => {
    if (branchId === PARK_B) {
      await pendingB;
      try { await route.fulfill({ json: summary(PARK_B, 99) }); } finally { returnedB = true; }
      return;
    }
    return route.fulfill({ json: summary(PARK_A, index === 1 ? 11 : 21) });
  } });
  await page.goto('/staff');
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toBeVisible();
  const park = page.getByRole('combobox', { name: 'Park', exact: true });
  await park.selectOption(PARK_B);
  await expect.poll(() => seen.reads.includes(PARK_B)).toBe(true);
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toHaveCount(0);
  await park.selectOption(PARK_A);
  await expect(card(page, 'On shift now').getByText('21', { exact: true })).toBeVisible();
  releaseB();
  await expect.poll(() => returnedB).toBe(true);
  await expect(card(page, 'On shift now').getByText('21', { exact: true })).toBeVisible();
  await expect(card(page, 'On shift now').getByText('99', { exact: true })).toHaveCount(0);
  expect(seen.reads).toEqual([null, PARK_B, PARK_A]);
});

test('Refresh clears the old figures until its fresh canonical answer arrives', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const seen = await fixture(page, { read: async (route, branchId, index) => {
    if (index === 2) await pending;
    return route.fulfill({ json: summary(branchId ?? PARK_A, index === 1 ? 11 : 23) });
  } });
  await page.goto('/staff');
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => seen.reads.length).toBe(2);
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toHaveCount(0);
  release();
  await expect(card(page, 'On shift now').getByText('23', { exact: true })).toBeVisible();
});

test('each source button issues a fresh acting-user handoff only to its fixed native destination', async ({ page }) => {
  const seen = await fixture(page);
  for (const [label, target] of targets) {
    await page.goto('/staff');
    await expect(card(page, label)).toBeVisible();
    const prior = seen.handoffs.length;
    await card(page, label).getByRole('button', { name: 'Open in OTO App', exact: true }).click();
    await expect.poll(() => new URL(page.url()).origin).toBe('https://oto-staff.test');
    const destination = new URL(page.url());
    expect(new URLSearchParams(destination.hash.slice(1)).get('to')).toBe(target);
    expect(seen.handoffs).toHaveLength(prior + 1);
    expect(seen.handoffs.at(-1)?.body).toEqual({ app: 'oto_app' });
    expect(Boolean(seen.handoffs.at(-1)?.key)).toBe(true);
  }
  expect(new Set(seen.handoffs.map(row => row.key)).size).toBe(4);
  expect(seen.writes).toEqual([]);
});

test('Staff cards, long park/company names and source actions fit at phone width without business controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const answer = summary();
  answer.payroll.entities[0]!.name = 'ZZ TEST PayingCompanyWithOneLongUnbrokenNameForPhoneWrapping';
  const seen = await fixture(page, { read: route => route.fulfill({ json: answer }) });
  await page.goto('/staff');
  for (const [label] of targets) {
    const region = card(page, label);
    await expect(region).toBeVisible();
    const box = await region.boundingBox();
    expect(Boolean(box && box.x >= 0 && box.x + box.width <= 391)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: /^(Create|Invite|Save|Submit|Pay|Approve|Lock|Start)\b/i })).toHaveCount(0);
  expect(seen.writes).toEqual([]);
});

test('a narrowed authority resets an explicit unreachable park and recovers the remaining reachable park', async ({ page }) => {
  let reduced = false, refusedReads = 0;
  const seen = await fixture(page, {
    permissionRows: () => permissionNames.map(permission => ({
      permission, scopeType: reduced ? 'branch' : 'operator', scopeId: reduced ? PARK_A : '01964000-0000-7000-8000-00000000f122',
    })),
    read: async (route, branchId) => {
      if (reduced && branchId === PARK_B) {
        refusedReads++;
        return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Not on this park access.' } } });
      }
      const data = summary(branchId ?? PARK_A, branchId === PARK_B ? 12 : 11);
      if (reduced) data.branches = data.branches.filter(branch => branch.id === PARK_A);
      return route.fulfill({ json: data });
    },
  });
  await page.goto('/staff');
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toBeVisible();
  const park = page.getByRole('combobox', { name: 'Park', exact: true });
  await park.selectOption(PARK_B);
  await expect(card(page, 'On shift now').getByText('12', { exact: true })).toBeVisible();
  expect(seen.reads).toEqual([null, PARK_B]);

  reduced = true;
  // The existing session provider re-reads /me and /me/permissions on this event.
  // It remains signed in and unlocked, so this exercises the same Staff mount.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('oto:session-locked')));
  await expect.poll(() => seen.reads.length).toBe(3);
  expect(seen.reads.at(-1)).toBeNull();
  await expect(park).toBeEnabled();
  await expect(park).toHaveValue(PARK_A);
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(park.getByRole('option', { name: 'ZZ TEST Riverside with a longer park name', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => seen.reads.length).toBe(4);
  await expect(card(page, 'On shift now').getByText('11', { exact: true })).toBeVisible();
  expect(seen.reads).toEqual([null, PARK_B, null, null]);
  expect(refusedReads).toBe(0);
  expect(seen.writes).toEqual([]);
});
