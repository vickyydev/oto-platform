import { expect, test, type Page } from '@playwright/test';

const PARK = '01900000-0000-7000-8000-000000000001';
const departments = () => [
  { id: 'reception', name: 'ZZ TEST Reception', branch: { id: PARK, name: 'ZZ TEST Central' }, memberCount: 17,
    source: 'otoapp', externalId: 'zz-source-reception', archivedAt: null },
  { id: 'marketing', name: 'ZZ TEST Marketing', branch: null, memberCount: 0,
    source: 'platform', externalId: null, archivedAt: '2026-10-24T08:00:00.000Z' },
];

async function fixture(page: Page, allowed = true, sourceAccess = false) {
  const reads: string[] = [];
  const writes: string[] = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    if (path === '/me') return route.fulfill({ json: {
      account: { id: 'caller', phone: '', status: 'active', mustChangePassword: false, operatorId: 'operator' },
      employee: { id: 'caller', name: 'ZZ TEST Admin', nickname: null }, branch: null,
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', ...(allowed ? ['admin:account:read'] : []), ...(sourceAccess ? ['app:oto_app:access'] : []),
    ].map((permission) => ({ permission, scopeType: 'branch', scopeId: PARK })) } });
    if (path === '/departments' || path === '/departments/') {
      reads.push(url.searchParams.get('q') ?? '');
      return route.fulfill({ json: { departments: departments() } });
    }
    return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'Not on fixture access.' } } });
  });
  return { reads, writes };
}

test('Departments shows current core names, park coverage and returned member counts without write controls', async ({ page }, testInfo) => {
  const seen = await fixture(page);
  await page.goto('/people/departments');
  await expect(page.getByRole('heading', { name: 'Departments', exact: true })).toBeVisible();
  const list = page.getByRole('list', { name: 'Departments', exact: true });
  const reception = list.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'ZZ TEST Reception', exact: true }) });
  await expect(reception).toContainText('ZZ TEST Central');
  await expect(reception).toContainText('Member count');
  await expect(reception.getByText('OTO App', { exact: true })).toBeVisible();
  await expect(reception.getByText('17', { exact: true })).toBeVisible();
  const marketing = list.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'ZZ TEST Marketing', exact: true }) });
  await expect(marketing).toContainText('Operator-wide · no park');
  await expect(marketing.getByText('Platform', { exact: true })).toBeVisible();
  await expect(marketing.getByText('Archived', { exact: true })).toBeVisible();
  await expect(marketing.getByText('0', { exact: true })).toBeVisible();
  await expect(page.getByText(/current employee links/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Departments', exact: true })).toHaveAttribute('href', '/people/departments');
  await expect(page.getByRole('button', { name: /create|invite|edit|save|delete|sync|open in oto app/i })).toHaveCount(0);
  expect(seen.reads).toEqual(['']);
  expect(seen.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('departments-desktop.png'), fullPage: true });
  await page.goto('/departments');
  await expect(page.getByRole('heading', { name: 'Departments', exact: true })).toBeVisible();
});

test('source navigation is explicit, single-flight and retryable without changing the directory', async ({ page }) => {
  const seen = await fixture(page, true, true);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const handoffs: Array<{ body: unknown; key: string | undefined }> = [];
  await page.route('**/api/auth/handoff', async (route) => {
    handoffs.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    if (handoffs.length === 1) {
      await delayed;
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'ZZ TEST source unavailable.' } } });
    }
    return route.fulfill({ json: { launchUrl: 'https://oto-source.test/#handoff=zz-local-placeholder' } });
  });
  await page.route('https://oto-source.test/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>ZZ TEST OTO source</h1>' }));
  await page.goto('/people/departments');
  const open = page.getByRole('button', { name: 'Open in OTO App', exact: true });
  await expect(open).toBeVisible();
  expect(handoffs).toEqual([]);
  await open.click();
  const pending = page.getByRole('button', { name: 'Opening OTO App…', exact: true });
  await expect(pending).toBeDisabled();
  await pending.dispatchEvent('click');
  expect(handoffs).toHaveLength(1);
  release!();
  await expect(page.getByRole('alert')).toContainText('ZZ TEST source unavailable.');
  await expect(page.getByRole('heading', { name: 'ZZ TEST Reception', exact: true })).toBeVisible();
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page).toHaveURL(/https:\/\/oto-source\.test\/#handoff=/);
  expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('to')).toBe('/departments');
  expect(handoffs).toHaveLength(2);
  expect(handoffs.every(row => JSON.stringify(row.body) === JSON.stringify({ app: 'oto_app' }) && Boolean(row.key))).toBe(true);
  expect(handoffs[0]!.key).not.toBe(handoffs[1]!.key);
  expect(seen.writes).toEqual([]);
});

test('Departments navigation and direct page keep account-read permission and never read without it', async ({ page }) => {
  const seen = await fixture(page, false);
  await page.goto('/people/departments');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Departments', exact: true })).toHaveCount(0);
  expect(seen.reads).toEqual([]);
  expect(seen.writes).toEqual([]);
});

test('pending, failed, reachable-empty and search-empty department reads remain separate and retryable', async ({ page }) => {
  await fixture(page);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/departments*', async (route) => {
    if (++attempts === 1) {
      await delayed;
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'The department source did not answer.' } } });
    }
    return route.fulfill({ json: { departments: attempts === 2 ? departments() : [] } });
  });
  await page.goto('/people/departments');
  await expect(page.getByRole('status')).toContainText('Loading departments');
  await expect(page.getByText('No departments in your reach', { exact: true })).toHaveCount(0);
  release!();
  await expect(page.getByRole('alert')).toContainText('The department source did not answer.');
  await expect(page.getByRole('list', { name: 'Departments', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ZZ TEST Reception', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('No departments in your reach', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search departments', exact: true }).fill('Nobody');
  await expect(page.getByText('No matching departments', { exact: true })).toBeVisible();
});

test('department search sends the selected query and a late older result cannot replace it', async ({ page }) => {
  await fixture(page);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const queries: string[] = [];
  await page.route('**/api/departments*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    queries.push(query);
    if (query === 'Old') {
      await delayed;
      return route.fulfill({ json: { departments: [{ ...departments()[0], name: 'ZZ TEST Old department' }] } });
    }
    return route.fulfill({ json: { departments: [{ ...departments()[0], name: query ? 'ZZ TEST New department' : 'ZZ TEST Reception' }] } });
  });
  await page.goto('/people/departments');
  await expect(page.getByRole('heading', { name: 'ZZ TEST Reception', exact: true })).toBeVisible();
  const search = page.getByRole('textbox', { name: 'Search departments', exact: true });
  await search.fill('Old');
  await expect(page.getByRole('status')).toContainText('Loading departments');
  await expect(page.getByRole('heading', { name: 'ZZ TEST Reception', exact: true })).toHaveCount(0);
  await search.fill('New & team');
  await expect(page.getByRole('heading', { name: 'ZZ TEST New department', exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get('q') === 'Old');
  release!();
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('heading', { name: 'ZZ TEST New department', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ZZ TEST Old department', exact: true })).toHaveCount(0);
  expect(queries).toEqual(['', 'Old', 'New & team']);
});

test('a server permission refusal remains a visible error and cannot become an empty department count', async ({ page }) => {
  const seen = await fixture(page);
  await page.route('**/api/departments*', (route) => route.fulfill({ status: 403,
    json: { error: { code: 'PERMISSION_DENIED', message: 'Department access was refused at this park.' } } }));
  await page.goto('/people/departments');
  await expect(page.getByRole('alert')).toContainText('Department access was refused at this park.');
  await expect(page.getByRole('list', { name: 'Departments', exact: true })).toHaveCount(0);
  await expect(page.getByText('No departments in your reach', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(seen.writes).toEqual([]);
});

test('long department and park names and returned counts fit a 390px phone', async ({ page }, testInfo) => {
  const seen = await fixture(page);
  const long = 'ZZ TEST ' + 'LongDepartmentParkName'.repeat(6);
  await page.route('**/api/departments*', (route) => route.fulfill({ json: { departments: [
    { id: 'long', name: long, branch: { id: PARK, name: long }, memberCount: 23014 }, departments()[1],
  ] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/people/departments');
  await expect(page.getByRole('heading', { name: long, exact: true })).toBeVisible();
  await expect(page.getByText('23,014', { exact: true })).toBeVisible();
  await expect(page.getByText('Operator-wide · no park', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const bounds = await page.getByRole('textbox', { name: 'Search departments', exact: true }).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(seen.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('departments-phone.png'), fullPage: true });
});
