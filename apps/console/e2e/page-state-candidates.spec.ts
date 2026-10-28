import { expect, test, type Page } from '@playwright/test';
import type { AuditEntry } from '../src/api/observability';
import type { BoxRow } from '../src/api/fleet';
import { signInAndWait } from './console';

const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const frames = async (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const entry = (n: number, requestId: string, action = 'zz.test.related.selected'): AuditEntry => ({
  id: `018f1d2c-0000-7000-8000-${String(3000 + n).padStart(12, '0')}`, createdAt: '2026-10-29T00:00:00.000Z', action,
  entityType: 'ZZ TEST record', entityId: 'ZZ TEST record', actorAccountId: null, actorName: null,
  branchId: null, requestId, before: null, after: null, outcome: 'success', app: null, targetApp: null, category: null,
});

test('Activity: a held export cannot download or announce an abandoned filter', async ({ page }) => {
  const hold = deferred(), answered = deferred();
  let requested = false;
  await page.route(/\/api\/audit\/?\?/, route => {
    const action = new URL(route.request().url()).searchParams.get('action') ?? 'zz.test.original';
    return route.fulfill({ json: { entries: [entry(1, 'zz-test-export', action)], nextCursor: null, masked: true } });
  });
  await page.route(/\/api\/audit\/export\?/, async route => {
    requested = true;
    await hold.promise;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="zz-test-audit.csv"',
      'x-oto-export-rows': '1', 'x-oto-export-masked': 'true' }, body: 'action\nzz.test.original\n' });
    answered.release();
  });
  await signInAndWait(page);
  await page.goto('/watch/activity');
  await expect(page.getByRole('button', { name: /zz.test.original/ })).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  try {
    await page.getByLabel('Action', { exact: true }).fill('zz.test.current');
    await expect(page.getByRole('button', { name: /zz.test.current/ })).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 1500 }).then(() => true, () => false);
    hold.release();
    await answered.promise;
    expect(await download).toBe(false);
    await expect(page.getByRole('status').filter({ hasText: /Exported 1 row/ })).toHaveCount(0);
  } finally { hold.release(); }
});

test('Activity: a capped Related read never claims the selected request had only one row', async ({ page }) => {
  let relatedRead = false;
  const answered = deferred();
  await page.route(/\/api\/audit\/?\?/, async route => {
    const related = new URL(route.request().url()).searchParams.has('requestId');
    relatedRead ||= related;
    await route.fulfill({ json: { entries: related ? Array.from({ length: 200 }, (_, n) => entry(n + 2, 'zz-test-other-request', 'zz.test.unrelated'))
      : [entry(1, 'zz-test-selected-request')], nextCursor: related ? 'zz-test-more-recorded-rows' : null, masked: true } });
    if (related) answered.release();
  });
  await signInAndWait(page);
  await page.goto('/watch/activity');
  await page.getByRole('button', { name: /zz.test.related.selected/ }).click();
  const drawer = page.getByRole('dialog', { name: 'zz.test.related.selected', exact: true });
  await drawer.getByRole('button', { name: 'Related', exact: true }).click();
  await expect.poll(() => relatedRead).toBe(true);
  await answered.promise;
  await frames(page);
  await expect(drawer.getByText('This was the only row for that request', { exact: true })).toHaveCount(0);
  await expect(drawer.getByText(/latest 200|older related rows/i)).toBeVisible();
});

test('Apps: an old maintenance save cannot close a replacement app draft', async ({ page }) => {
  const hold = deferred(), answered = deferred();
  let requested = false;
  await page.route(/\/api\/console\/apps$/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    const apps = ['pos', 'oto_app'].map((key, n) => {
      const app = body.apps.find((row: { key: string }) => row.key === key);
      expect(app).toBeTruthy();
      return { ...app, name: n ? 'ZZ TEST Second app' : 'ZZ TEST First app', storedState: 'open', effectiveState: 'open', maintenance: null };
    });
    await route.fulfill({ response, json: { ...body, apps } });
  });
  await page.route(/\/api\/console\/apps\/pos\/maintenance$/, async route => {
    expect(route.request().method()).toBe('PUT');
    const body = route.request().postDataJSON() as { message: string; expiresAt: string; expectedRevision: number };
    requested = true;
    await hold.promise;
    await route.fulfill({ json: { app: { appKey: 'pos', tileState: 'maintenance', maintenanceMessage: body.message,
      maintenanceExpiresAt: body.expiresAt, maintenanceRestoreState: 'open', revision: body.expectedRevision + 1 } } });
    answered.release();
  });
  await signInAndWait(page);
  await page.goto('/organisation/apps');
  const first = page.getByRole('heading', { name: 'ZZ TEST First app', exact: true }).locator('xpath=ancestor::section[1]');
  await first.getByRole('button', { name: 'Start maintenance…', exact: true }).click();
  const firstDrawer = page.getByRole('dialog', { name: 'ZZ TEST First app maintenance', exact: true });
  await firstDrawer.getByLabel(/Message on the tile/).fill('ZZ TEST fixture maintenance');
  await firstDrawer.getByLabel(/^Reason/).fill('ZZ TEST local continuation regression');
  await firstDrawer.getByLabel(/Type to confirm/).fill('pos');
  await firstDrawer.getByRole('button', { name: 'Start maintenance', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  try {
    await firstDrawer.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('heading', { name: 'ZZ TEST Second app', exact: true }).locator('xpath=ancestor::section[1]')
      .getByRole('button', { name: 'Start maintenance…', exact: true }).click();
    const secondDrawer = page.getByRole('dialog', { name: 'ZZ TEST Second app maintenance', exact: true });
    await secondDrawer.getByLabel(/Message on the tile/).fill('ZZ TEST newer app draft');
    hold.release();
    await answered.promise;
    await frames(page);
    await expect(secondDrawer).toBeVisible();
    await expect(secondDrawer.getByLabel(/Message on the tile/)).toHaveValue('ZZ TEST newer app draft');
  } finally { hold.release(); }
});

test('Devices: returning to park A cannot publish park B rows while its child-device read is held', async ({ page }) => {
  const holdChild = deferred(), childAnswered = deferred(), holdReturn = deferred(), returnAnswered = deferred();
  const foreignName = 'ZZ TEST Other park pending-child fleet';
  const boxId = '018f1d2c-0000-7000-8000-000000009997';
  let parks: { id: string; name: string }[] = [];
  let firstBox: BoxRow | null = null;
  let armed = false, returning = false, childHeld = false, returnHeld = false;
  await page.route(/\/api\/branches\/?(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    parks = body.branches.filter((branch: { archived: boolean }) => !branch.archived);
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/branches\/[^/]+\/boxes(?:\?|$)/, async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    if (armed && id === parks[1]?.id) {
      expect(firstBox).not.toBeNull();
      await route.fulfill({ json: { boxes: [{ ...firstBox, id: boxId, branchId: id, name: foreignName }] } });
      return;
    }
    if (returning && id === parks[0]?.id) { returnHeld = true; await holdReturn.promise; }
    const response = await route.fetch();
    const body = await response.json();
    if (id === parks[0]?.id) {
      expect(body.boxes.length).toBeGreaterThan(0);
      firstBox = body.boxes[0];
      body.boxes[0].name = 'ZZ TEST First park round-trip fleet';
    }
    await route.fulfill({ response, json: body });
    if (returning && id === parks[0]?.id) returnAnswered.release();
  });
  await page.route(new RegExp(`/api/boxes/${boxId}/devices(?:\\?|$)`), async route => {
    childHeld = true;
    await holdChild.promise;
    await route.fulfill({ json: { devices: [] } });
    childAnswered.release();
  });
  await signInAndWait(page);
  await page.goto('/devices');
  await expect.poll(() => parks.length).toBeGreaterThan(1);
  const picker = page.getByLabel('Branch');
  if (await picker.inputValue() !== parks[0]!.id) await picker.selectOption(parks[0]!.id);
  await expect(page.getByText('ZZ TEST First park round-trip fleet', { exact: true }).first()).toBeVisible();
  armed = true;
  try {
    await picker.selectOption(parks[1]!.id);
    await expect.poll(() => childHeld).toBe(true);
    // Observe every native DOM publication, including a wrong row removed by
    // the following passive effect before a normal polling assertion runs.
    await picker.evaluate((element, { firstPark, foreignName }) => {
      const select = element as HTMLSelectElement;
      const probe = { foreignPublished: false };
      Object.assign(window, { __s681FleetProbe: probe });
      new MutationObserver(records => {
        if (select.value !== firstPark) return;
        for (const record of records) {
          if ([...record.addedNodes].some(node => node.textContent?.includes(foreignName))
            || (record.type === 'characterData' && record.target.textContent?.includes(foreignName))) probe.foreignPublished = true;
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, { firstPark: parks[0]!.id, foreignName });
    returning = true;
    await picker.selectOption(parks[0]!.id);
    await expect.poll(() => returnHeld).toBe(true);
    await frames(page);
    expect(await page.evaluate(() => (window as unknown as { __s681FleetProbe: { foreignPublished: boolean } }).__s681FleetProbe.foreignPublished)).toBe(false);
    await expect(page.getByText(foreignName, { exact: true })).toHaveCount(0);
  } finally {
    holdChild.release(); holdReturn.release();
    if (childHeld) await childAnswered.promise;
    if (returnHeld) await returnAnswered.promise;
  }
});
