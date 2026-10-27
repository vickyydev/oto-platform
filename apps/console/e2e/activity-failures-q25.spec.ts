import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * SCRUM-644 (planner ruling Q25) — the Activity export and the Failures mute
 * and recipient controls, against a fixture API. No real export, mute,
 * recipient or delivery reaches any server: every write is captured here.
 */

const OPERATOR = '01964000-0000-7000-8000-000000000644';
const ACCOUNT = '01964000-0000-7000-8000-000000000645';
const NOW = '2026-10-27T04:00:00.000Z';
const UNTIL = '2026-10-27T05:00:00.000Z';

const audit = (action: string, extra: Record<string, unknown> = {}) => ({ id: `zz-${action}`, action, entityType: 'ZZ TEST record',
  entityId: 'ZZ TEST record', actorAccountId: null, actorName: null, branchId: null, requestId: null,
  before: null, after: null, createdAt: NOW, app: null, targetApp: null, category: null, ...extra });
const group = (fingerprint: string) => ({ fingerprint, name: `zz.test.${fingerprint}`, kind: 'job', count: 3,
  firstSeenAt: NOW, lastSeenAt: NOW, lastError: 'ZZ_TEST: failure', lastRunId: null, retryable: false });

interface Fixture {
  permissions: string[];
  mutes: Array<Record<string, unknown>>;
  recipients: Array<Record<string, unknown>>;
  writes: Array<{ method: string; path: string; body: unknown }>;
  exports: URLSearchParams[];
}

async function fixture(page: Page, permissions: string[], extra: Partial<Fixture> = {}): Promise<Fixture> {
  const f: Fixture = { permissions, mutes: [], recipients: [], writes: [], exports: [], ...extra };
  await page.route('**/api/**', async (route) => {
    const request: Request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
    if (request.method() !== 'GET') {
      f.writes.push({ method: request.method(), path, body: request.postDataJSON() as unknown });
      if (path === '/ops/alert-mutes') {
        const body = request.postDataJSON() as { fingerprint: string; reason: string; minutes: number };
        const mute = { id: '01964000-0000-7000-8000-0000000006a1', fingerprint: body.fingerprint, scope: 'operator',
          reason: body.reason, startsAt: NOW, mutedUntil: UNTIL, createdByAccountId: ACCOUNT, createdByName: 'ZZ TEST admin', heldBack: 0 };
        f.mutes.push(mute);
        return route.fulfill({ json: { mute } });
      }
      return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_WRITE_BLOCKED', message: 'Not on fixture access.' } } });
    }
    if (path === '/me') return route.fulfill({ json: {
      account: { id: ACCOUNT, phone: '', status: 'active', mustChangePassword: false, operatorId: OPERATOR },
      employee: { id: ACCOUNT, name: 'ZZ TEST Q25 reader', nickname: null }, branch: null,
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
      operatorContext: { sessionId: ACCOUNT, homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
        operatorOverride: null, branchId: null, stationId: null, revision: 0 },
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: ['app:console:access', ...f.permissions]
      .map((permission) => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/audit') return route.fulfill({ json: { entries: [
      audit('zz.test.read', { category: 'data_access', app: 'console' }),
      audit('access.denied', { category: 'denial', targetApp: 'oto_app' }),
    ], nextCursor: null, masked: true } });
    if (path === '/audit/export') {
      f.exports.push(url.searchParams);
      return route.fulfill({ status: 200, body: '"id"\n', headers: { 'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="activity-zz.csv"', 'x-oto-export-rows': '2', 'x-oto-export-masked': 'true',
        'x-oto-next-cursor': 'zz-next' } });
    }
    if (path === '/ops/failures') return route.fulfill({ json: { groups: [group('zzmuted0001'), group('zzopen00001')], nextCursor: null } });
    if (path === '/ops/alert-mutes') return route.fulfill({ json: { mutes: f.mutes, defaultMinutes: 60, maxMinutes: 1440 } });
    if (path === '/ops/alert-recipients') return route.fulfill({ json: { recipients: f.recipients, deliveredChannels: ['console'],
      deliveryNote: 'Alerts are delivered to the console only. Email and webhook rows are kept, and recorded as not delivered, until a provider integration is built as its own ticket.' } });
    if (path === '/ops/quarantine') return route.fulfill({ json: { events: [], nextCursor: null, openCount: 0 } });
    if (path === '/accounts') return route.fulfill({ json: { accounts: [] } });
    if (path === '/branches') return route.fulfill({ json: { branches: [] } });
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Not on fixture access.' } } });
  });
  return f;
}

const exportButton = (page: Page) => page.getByRole('button', { name: 'Export', exact: true });
const groups = (page: Page) => page.getByRole('list', { name: 'Failure groups', exact: true });
const card = (page: Page, fingerprint: string) => groups(page).getByRole('listitem').filter({ hasText: `zz.test.${fingerprint}` });

test('the export control is offered only to a holder of console:activity:export', async ({ page }) => {
  await fixture(page, ['admin:audit:read']);
  await page.goto('/watch/activity');
  await expect(page.getByRole('main').getByText('zz.test.read', { exact: true })).toBeVisible();
  await expect(exportButton(page)).toHaveCount(0);
});

test('an export carries the server filters and format, downloads, and says more rows remain', async ({ page }) => {
  const f = await fixture(page, ['admin:audit:read', 'console:activity:export']);
  await page.goto('/watch/activity');
  await page.getByRole('button', { name: 'Denials', exact: true }).click();
  await page.getByRole('textbox', { name: 'Target app', exact: true }).fill('oto_app');
  await page.getByRole('combobox', { name: 'Export format', exact: true }).selectOption('ndjson');
  const download = page.waitForEvent('download');
  await exportButton(page).click();
  expect((await download).suggestedFilename()).toBe('activity-zz.csv');
  await expect(page.getByRole('status').filter({ hasText: 'Exported 2 rows, personal fields hidden' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export the next page', exact: true })).toBeVisible();
  const asked = f.exports.at(-1)!;
  expect(asked.get('category')).toBe('denial');
  expect(asked.get('targetApp')).toBe('oto_app');
  expect(asked.get('format')).toBe('ndjson');
  expect(asked.get('limit')).toBe('5000');
  expect(f.writes).toEqual([]);
});

test('a muted alert is still listed, marked as muted with its reason', async ({ page }) => {
  await fixture(page, ['admin:health:read'], { mutes: [{ id: '01964000-0000-7000-8000-0000000006a0', fingerprint: 'zzmuted0001',
    scope: 'operator', reason: 'ZZ TEST printer swap', startsAt: NOW, mutedUntil: UNTIL, createdByAccountId: ACCOUNT,
    createdByName: 'ZZ TEST admin', heldBack: 2 }] });
  await page.goto('/watch/failures');
  await expect(card(page, 'zzmuted0001')).toContainText('Muted until');
  await expect(card(page, 'zzmuted0001')).toContainText('ZZ TEST printer swap');
  await expect(card(page, 'zzmuted0001')).toContainText('2 held back');
  await expect(card(page, 'zzopen00001')).not.toContainText('Muted until');
  // A reader without console:alert:manage sees the state and no control to change it.
  await expect(groups(page).getByRole('button', { name: 'Mute', exact: true })).toHaveCount(0);
  await expect(groups(page).getByRole('button', { name: 'Unmute', exact: true })).toHaveCount(0);
});

test('muting needs a reason and offers nothing past 24 hours', async ({ page }) => {
  const f = await fixture(page, ['admin:health:read', 'console:alert:manage']);
  await page.goto('/watch/failures');
  await card(page, 'zzopen00001').getByRole('button', { name: 'Mute', exact: true }).click();
  const form = page.getByRole('form', { name: 'Mute this alert' });
  const submit = form.getByRole('button', { name: 'Mute', exact: true });
  await expect(submit).toBeDisabled();
  const durations = await form.getByRole('combobox', { name: 'For how long' }).locator('option').evaluateAll(
    (options) => options.map((o) => Number((o as HTMLOptionElement).value)));
  expect(Math.max(...durations)).toBe(1440);
  expect(await form.getByRole('combobox', { name: 'For how long' }).inputValue()).toBe('60');
  await form.getByRole('textbox', { name: 'Why mute it' }).fill('   ');
  await expect(submit).toBeDisabled();
  await form.getByRole('textbox', { name: 'Why mute it' }).fill('ZZ TEST planned swap');
  await form.getByRole('combobox', { name: 'For how long' }).selectOption('1440');
  await submit.click();
  await expect(card(page, 'zzopen00001')).toContainText('Muted until');
  expect(f.writes).toEqual([{ method: 'POST', path: '/ops/alert-mutes',
    body: { fingerprint: 'zzopen00001', reason: 'ZZ TEST planned swap', minutes: 1440 } }]);
});

test('recipients show the environment variable name and its state, never an address, and say delivery is console-only', async ({ page }) => {
  await fixture(page, ['admin:health:read', 'console:alert:manage'], { recipients: [
    { id: '01964000-0000-7000-8000-0000000006b0', scope: 'operator', branchId: null, category: 'ops.failing', channel: 'email',
      addressRef: 'ALERT_ONCALL_EMAIL', addressConfigured: true, delivered: false, label: null, createdAt: NOW, updatedAt: NOW },
    { id: '01964000-0000-7000-8000-0000000006b1', scope: 'operator', branchId: null, category: '*', channel: 'webhook',
      addressRef: 'ALERT_ONCALL_WEBHOOK', addressConfigured: false, delivered: false, label: null, createdAt: NOW, updatedAt: NOW },
  ] });
  await page.goto('/watch/failures');
  const list = page.getByRole('list', { name: 'Alert recipients', exact: true });
  await expect(list).toContainText('Reads ALERT_ONCALL_EMAIL (set on this deployment)');
  await expect(list).toContainText('Reads ALERT_ONCALL_WEBHOOK (not set on this deployment)');
  await expect(list).toContainText('not delivered on this build');
  await expect(page.getByRole('note').filter({ hasText: 'delivered to the console only' })).toBeVisible();
  const add = page.getByRole('form', { name: 'Add a recipient' });
  await add.getByRole('textbox', { name: 'Alert family' }).fill('ops.failing');
  await add.getByRole('combobox', { name: 'Channel' }).selectOption('email');
  await add.getByRole('textbox', { name: 'Address variable name' }).fill('oncall@example.test');
  await expect(add.getByRole('alert')).toContainText('never the address itself');
  await expect(add.getByRole('button', { name: 'Add recipient', exact: true })).toBeDisabled();
});
