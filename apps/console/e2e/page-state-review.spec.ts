import { expect, test, type Page } from '@playwright/test';
import { signInAndWait } from './console';

const secondId = '018f1d2c-0000-7000-8000-000000009998';
const version = (note: string, number: number) => ({ id: `018f1d2c-0000-7000-8000-${String(number).padStart(12, '0')}`,
  version: number, publishedAt: '2026-10-28T10:00:00.000Z', bundleHash: '0123456789abcdef', note, publishedByAccountId: null });
const frames = async (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test('AUDIT: late booth A version history cannot replace selected booth B history', async ({ page }) => {
  let firstId = '';
  let armed = false;
  let heldRequests = 0;
  let release!: () => void;
  let answered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { answered = resolve; });
  await page.route(/\/api\/branches\/[^/]+\/booths(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    expect(body.booths.length).toBeGreaterThan(0);
    firstId = body.booths[0].id;
    await route.fulfill({ response, json: { ...body, booths: [body.booths[0], { ...body.booths[0], id: secondId, name: 'ZZ TEST Audit second booth' }] } });
  });
  await page.route(new RegExp(`/api/booths/${secondId}/`), async route => {
    const response = await route.fetch({ url: route.request().url().replace(secondId, firstId) });
    if (!response.headers()['content-type']?.includes('json')) return route.fulfill({ response });
    const body = await response.json();
    await route.fulfill({ response, json: body.booth ? { ...body, booth: { ...body.booth, id: secondId, name: 'ZZ TEST Audit second booth' } } : body });
  });
  await page.route(/\/api\/booths\/[^/]+\/versions(?:\?|$)/, async route => {
    const target = new URL(route.request().url()).pathname.split('/').at(-2);
    if (target === secondId) return route.fulfill({ json: { versions: [version('ZZ TEST Current booth history', 2)] } });
    if (armed) {
      heldRequests++;
      await waiting;
      await route.fulfill({ json: { versions: [version('ZZ TEST Previous booth late history', 1)] } });
      answered();
      return;
    }
    await route.fulfill({ json: { versions: [version('ZZ TEST Initial booth history', 1)] } });
  });
  await signInAndWait(page);
  await page.goto('/devices/booths');
  await expect(page.getByText(/ZZ TEST Initial booth history/)).toBeVisible();
  armed = true;
  await page.locator('header').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => heldRequests).toBeGreaterThan(0);
  try {
    await page.getByRole('group', { name: 'Booth', exact: true }).getByRole('button', { name: /ZZ TEST Audit second booth/ }).click();
    await expect(page.getByText(/ZZ TEST Current booth history/)).toBeVisible();
    release();
    await completed;
    await frames(page);
    await expect(page.getByText(/ZZ TEST Current booth history/)).toBeVisible();
    await expect(page.getByText(/ZZ TEST Previous booth late history/)).toHaveCount(0);
  } finally { release(); }
});

test('AUDIT: a real missing booth404 keeps the native resource reason instead of claiming an undeployed route', async ({ page }) => {
  await page.route(/\/api\/booths\/[^/]+\/draft(?:\?|$)/, route => route.fulfill({ status: 404,
    json: { error: { code: 'BOOTH_NOT_FOUND', message: 'No booth with that id' } } }));
  await signInAndWait(page);
  await page.goto('/devices/booths');
  // The GET exists; its selected record is missing. This is the actual native service reason.
  await expect(page.getByText('No booth with that id', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/The draft route is not deployed here yet/)).toHaveCount(0);
});

test('AUDIT: shrinking voucher data does not show an impossible current-page range', async ({ page }) => {
  const row = (n: number) => ({ id: `018f1d2c-0000-7000-8000-${String(2000 + n).padStart(12, '0')}`,
    issuedAt: '2026-10-28T10:00:00.000Z', businessDate: '2026-10-28', type: { id: '018f1d2c-0000-7000-8000-000000001999', code: 'audit-type', nameEn: 'ZZ TEST Audit voucher', nameTh: null, kind: 'amount' },
    prize: null, value: { kind: 'money', text: '100 THB', redeemedSatang: null }, place: { kind: 'counter', stationId: null, name: 'Counter' },
    issuedBy: null, codeLast4: '0000', source: 'counter', status: 'issued', printCount: 0, expiresAt: null, redeemed: null });
  await page.route(/\/api\/vouchers\?/, route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? 0);
    return route.fulfill({ json: { range: { from: '2026-10-28', to: '2026-10-28' },
      total: offset ? 1 : 51, rows: offset ? [] : Array.from({ length: 50 }, (_, n) => row(n)), totals: [] } });
  });
  await signInAndWait(page);
  await page.goto('/catalogue/vouchers');
  await expect(page.getByText('1–50 of 51', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('No matching vouchers', { exact: true })).toBeVisible();
  await expect(page.getByText('51–50 of 1', { exact: true })).toHaveCount(0);
});

test('AUDIT: choosing another park hides the previous park fleet while its own read is pending', async ({ page }) => {
  let parks: { id: string; name: string }[] = [];
  let firstBoxName = '';
  let held = false;
  let release!: () => void;
  let answered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { answered = resolve; });
  await page.route(/\/api\/branches\/?(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    parks = body.branches.filter((branch: { archived: boolean }) => !branch.archived);
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/branches\/[^/]+\/boxes(?:\?|$)/, async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    if (id === parks[1]?.id) { held = true; await waiting; }
    const response = await route.fetch();
    const body = await response.json();
    if (id === parks[0]?.id) {
      expect(body.boxes.length).toBeGreaterThan(0);
      firstBoxName = 'ZZ TEST Original park fleet';
      body.boxes[0].name = firstBoxName;
    }
    await route.fulfill({ response, json: body });
    if (id === parks[1]?.id) answered();
  });
  await signInAndWait(page);
  await page.goto('/devices');
  await expect.poll(() => parks.length).toBeGreaterThan(1);
  const picker = page.getByLabel('Branch');
  if (await picker.inputValue() !== parks[0]!.id) await picker.selectOption(parks[0]!.id);
  await expect(page.getByText('ZZ TEST Original park fleet', { exact: true }).first()).toBeVisible();
  try {
    await picker.selectOption(parks[1]!.id);
    await expect.poll(() => held).toBe(true);
    await expect(picker).toHaveValue(parks[1]!.id);
    await expect(page.getByText(firstBoxName, { exact: true })).toHaveCount(0);
  } finally { release(); if (held) await completed; }
});

for (const [resource, falseEmpty] of [['boxes', 'No box at this branch yet'], ['stations', 'No stations yet']] as const) {
  test(`AUDIT: a failed first ${resource} read cannot claim an empty park register`, async ({ page }) => {
    const reason = `ZZ TEST audit ${resource} read refused`;
    await page.route(new RegExp(`/api/branches/[^/]+/${resource}(?:\\?|$)`), route => route.fulfill({ status: 500,
      json: { error: { code: 'INTERNAL', message: reason } } }));
    await signInAndWait(page);
    await page.goto('/devices');
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.getByText(falseEmpty, { exact: true })).toHaveCount(0);
  });
}
