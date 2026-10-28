import { expect, test, type Page, type Route } from '@playwright/test';

const OPERATOR = '01965000-0000-7000-8000-000000000001';
const ACTOR = '01965000-0000-7000-8000-000000000002';
const NEXT_ACTOR = '01965000-0000-7000-8000-000000000003';
const SESSION = '01965000-0000-7000-8000-000000000004';
const PARK = '01965000-0000-7000-8000-000000000005';
const SECOND_PARK = '01965000-0000-7000-8000-000000000006';
const BOX = '01965000-0000-7000-8000-000000000007';
const SECOND_BOX = '01965000-0000-7000-8000-000000000008';
const NOW = '2026-10-27T05:00:00.000Z';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const park = (id = PARK, name = 'ZZ TEST Health park') => ({ id, name, code: 'zz-test', timezone: 'Asia/Bangkok',
  businessDayStart: '05:00:00', country: 'TH', archived: false, openingHours: null, address: null });
const box = (id = BOX, branchId = PARK, name = 'ZZ TEST Health box') => ({
  id, name, slot: 'zz-test-counter', role: 'counter', status: 'online', state: 'ok', branchId,
  branchName: branchId === PARK ? 'ZZ TEST Health park' : 'ZZ TEST Second park', openingHours: 'not_set',
  agentVersion: '2.0.0', minAgentVersion: '1.0.0', agentBelowMinimum: false,
  lastHeartbeatAt: NOW, heartbeatAgeSeconds: 10, uptimeSeconds: 120, outboxDepth: 0,
  oldestUnackedAgeS: null as number | null, quarantineOpen: 0, lastSyncAt: NOW,
  clockOffsetMs: 0, tempC: null, currentEpoch: 1, configVersion: 'zz-test-config',
  devices: [{ id: id === BOX ? '01965000-0000-7000-8000-000000000009' : '01965000-0000-7000-8000-00000000000a',
    kind: 'receipt_printer', label: `ZZ TEST Printer ${id === BOX ? 'one' : 'two'}`,
    reachability: 'reachable', paperStatus: 'ok', lastError: null, lastSeenAt: NOW }],
  booths: [], conditions: [] as string[], detail: null as string | null,
});

type Read = (route: Route) => Promise<unknown>;
async function fixture(page: Page) {
  const state = { actor: ACTOR, revision: 0, directoryStatus: 200, integrationStatus: 200,
    boxes: [box()], parks: [park()], failingBoxBranch: '', failingDeviceBox: '', healthReads: 0,
    providers: [{ key: 'zz-test', name: 'ZZ TEST Integration', purpose: 'Local fixture only.', category: 'Storage',
      state: 'configured', missingVars: [] as string[], endpoint: null, lastDeliveryAt: null,
      lastDeliveryOutcome: null, detail: null }] };
  const writes: string[] = [];
  const healthReply = () => ({ status: state.boxes.some(item => item.state === 'down') ? 'down' : 'ok',
    checks: [{ key: 'database', label: 'Database', status: 'ok', value: 1, unit: 'ms', detail: null }],
    jobs: [], boxes: structuredClone(state.boxes), alerts: [], watchdogAgeSeconds: 10, generatedAt: NOW,
    reach: { scope: 'operator', branches: [] }, rollups: [] });
  const reads = { health: (async route => { state.healthReads++; return route.fulfill({ json: healthReply() }); }) as Read };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_WRITE_BLOCKED', message: 'No fixture writes.' } } });
    }
    if (path === '/me') return route.fulfill({ json: {
      account: { id: state.actor, phone: '', status: 'active', mustChangePassword: false, operatorId: OPERATOR },
      employee: { id: state.actor, name: 'ZZ TEST Health reader', nickname: null }, branch: null,
      isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
      operatorContext: { sessionId: SESSION, homeOperatorId: OPERATOR, effectiveOperatorId: OPERATOR,
        operatorOverride: null, branchId: null, stationId: null, revision: state.revision },
    } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
      'app:console:access', 'admin:health:read',
    ].map(permission => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
    if (path === '/ready') return route.fulfill({ json: { status: 'ready', checks: {
      database: { ok: true, latencyMs: 1 }, pool: { total: 1, idle: 1, waiting: 0, max: 10 },
      jobs: { configured: true, watchdogAgeS: 10, staleAfterS: 90, stale: false },
      stationChannels: { stations: 0, connections: 0, perStation: {} },
    } } });
    if (path === '/ops/health') return reads.health(route);
    if (path === '/ops/failures') return route.fulfill({ json: { groups: [], nextCursor: null } });
    if (path === '/ops/kiosks') return route.fulfill({ json: { kiosks: [] } });
    if (path === '/ops/integrations') return state.integrationStatus === 200
      ? route.fulfill({ json: { providers: state.providers, variables: [
        { name: 'ZZ_TEST_SETTING', present: true, required: true, provider: 'zz-test', purpose: 'Local fixture only.' },
      ] } })
      : route.fulfill({ status: state.integrationStatus,
        json: { error: { code: 'ZZ_TEST_UNAVAILABLE', message: 'ZZ TEST integrations unavailable' } } });
    if (path === '/branches') return state.directoryStatus === 200 ? route.fulfill({ json: { branches: state.parks } })
      : route.fulfill({ status: state.directoryStatus, json: { error: { code: 'ZZ_TEST_DIRECTORY_REFUSED', message: 'ZZ TEST directory refused' } } });
    const boxes = path.match(/^\/branches\/([^/]+)\/boxes$/);
    if (boxes) return boxes[1] === state.failingBoxBranch
      ? route.fulfill({ status: 503, json: { error: { code: 'ZZ_TEST_FLEET_READ', message: 'ZZ TEST box list unavailable' } } })
      : route.fulfill({ json: { boxes: state.boxes.filter(item => item.branchId === boxes[1]).map(item => ({ ...item, archived: false })) } });
    const devices = path.match(/^\/boxes\/([^/]+)\/devices$/);
    if (devices) return devices[1] === state.failingDeviceBox
      ? route.fulfill({ status: 503, json: { error: { code: 'ZZ_TEST_DEVICE_READ', message: 'ZZ TEST device list unavailable' } } })
      : route.fulfill({ json: { devices: (state.boxes.find(item => item.id === devices[1])?.devices ?? [])
        .map(item => ({ ...item, boxId: devices[1], transport: 'simulated', archived: false })) } });
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_UNOFFERED', message: 'Not on fixture access.' } } });
  });
  return { state, reads, writes, healthReply };
}

const card = (page: Page, title: string) => page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
const command = (page: Page, title: string) => page.locator('header').filter({ has: page.getByRole('heading', { level: 1, name: title, exact: true }) });
const refresh = (page: Page, title: string) => command(page, title).getByRole('button', { name: 'Refresh', exact: true }).click();
const retryIntegrations = (page: Page) => page.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true })
  .locator('xpath=ancestor::div[./button[normalize-space(.)="Try again"]][1]').getByRole('button', { name: 'Try again', exact: true }).click();

test('Health refresh adopts current native box devices and sync facts rather than retaining its first fleet read', async ({ page }, testInfo) => {
  const f = await fixture(page);
  await page.goto('/watch/health');
  await expect(card(page, 'The boxes')).toContainText('ZZ TEST Printer one');
  const current = f.state.boxes[0]!;
  current.devices[0]!.paperStatus = 'out'; current.outboxDepth = 7; current.oldestUnackedAgeS = 125;
  current.clockOffsetMs = 120_000;
  current.state = 'down'; current.conditions = [`device.paper:${current.devices[0]!.id}`, `box.clock:${current.id}`];
  current.detail = 'ZZ TEST Printer is out of paper.';
  await refresh(page, 'Health'); await expect.poll(() => f.state.healthReads).toBe(2);
  await expect(card(page, 'The boxes')).toContainText('paper out');
  await expect(card(page, 'The boxes')).toContainText('outbox 7');
  await expect(card(page, 'The boxes')).toContainText('oldest waiting 2m');
  await expect(card(page, 'The boxes')).toContainText('clock 2 min ahead');
  await expect(card(page, 'The boxes')).toContainText('minimum agent 1.0.0');
  await page.screenshot({ path: testInfo.outputPath('health-current-telemetry-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1100 });
  await card(page, 'The boxes').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('health-current-telemetry-phone.png'), fullPage: true });
  expect(f.writes).toEqual([]);
});

test('Health-only readers see canonical reachable boxes when the separate directory read is refused', async ({ page }) => {
  const f = await fixture(page); f.state.directoryStatus = 403;
  await page.goto('/watch/health');
  await expect(card(page, 'The boxes').getByRole('link', { name: 'ZZ TEST Health box', exact: true })).toBeVisible();
  await expect(card(page, 'The boxes').getByText('No box is registered', { exact: true })).toHaveCount(0);
  expect(f.writes).toEqual([]);
});

test('failed ancillary box or device reads cannot erase rows already returned by the canonical health snapshot', async ({ page }) => {
  const f = await fixture(page);
  f.state.parks.push(park(SECOND_PARK, 'ZZ TEST Second park'));
  f.state.boxes.push(box(SECOND_BOX, SECOND_PARK, 'ZZ TEST Second box'));
  f.state.failingBoxBranch = PARK; f.state.failingDeviceBox = SECOND_BOX;
  await page.goto('/watch/health');
  await expect(card(page, 'The boxes')).toContainText('ZZ TEST Health box');
  await expect(card(page, 'The boxes')).toContainText('ZZ TEST Second box');
  await expect(card(page, 'The boxes')).toContainText('ZZ TEST Printer two');
  expect(f.writes).toEqual([]);
});

test('a native down box prevents an all-healthy headline before the watchdog has opened an alert', async ({ page }) => {
  const f = await fixture(page), down = f.state.boxes[0]!;
  down.state = 'down'; down.conditions = ['device.paper:zz-test']; down.devices[0]!.paperStatus = 'out';
  down.detail = 'ZZ TEST Printer is out of paper.';
  await page.goto('/watch/health');
  await expect(card(page, 'The boxes')).toContainText('paper out');
  await expect(command(page, 'Health').getByText('Everything is healthy', { exact: true })).toHaveCount(0);
  await expect(command(page, 'Health')).toContainText('One thing needs attention');
  expect(f.writes).toEqual([]);
});

test('an initial integration read failure is not a declaration that no services exist', async ({ page }) => {
  const f = await fixture(page); f.state.integrationStatus = 500;
  await page.goto('/watch/integrations');
  await expect(page.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true })).toBeVisible();
  await expect(page.getByText('No services declared', { exact: true })).toHaveCount(0);
  f.state.integrationStatus = 200; f.state.providers = [];
  await retryIntegrations(page);
  await expect(page.getByText('No services declared', { exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('a refused integration refresh cannot keep claiming that everything is currently provisioned', async ({ page }, testInfo) => {
  const f = await fixture(page);
  await page.goto('/watch/integrations');
  await expect(command(page, 'Integrations')).toContainText('Everything provisioned');
  await expect(card(page, 'Variables to provision')).toContainText('Everything is set');
  f.state.integrationStatus = 503;
  await refresh(page, 'Integrations');
  await expect(page.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true })).toBeVisible();
  await expect(page.getByText('Everything provisioned', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Everything is set', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('integrations-failed-read.png'), fullPage: true });
  f.state.integrationStatus = 200;
  const held = deferred(); let retryStarted = false;
  await page.route('**/api/ops/integrations', async route => {
    retryStarted = true; await held.promise;
    return route.fulfill({ json: { providers: f.state.providers, variables: [
      { name: 'ZZ_TEST_SETTING', present: true, required: true, provider: 'zz-test', purpose: 'Local fixture only.' },
    ] } });
  });
  await retryIntegrations(page); await expect.poll(() => retryStarted).toBe(true);
  try {
    await expect(page.getByText('Everything provisioned', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Everything is set', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Service details below are from the last successful read.', { exact: true })).toBeVisible();
  } finally {
    const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/ops/integrations');
    held.release(); await (await response).finished();
  }
  await expect(command(page, 'Integrations')).toContainText('Everything provisioned');
  await expect(card(page, 'Variables to provision')).toContainText('Everything is set');
  expect(f.writes).toEqual([]);
});

test('genuine empty native fleet and healthy reads retain their existing truthful empty and healthy states', async ({ page }) => {
  const f = await fixture(page); f.state.boxes = []; f.state.parks = [];
  await page.goto('/health');
  await expect(card(page, 'The boxes').getByText('No box is registered', { exact: true })).toBeVisible();
  await expect(command(page, 'Health')).toContainText('Everything is healthy');
  await expect(card(page, 'Alerts').getByText('Nothing needs you right now', { exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('the existing canonical fence rejects a late old-actor health refusal without clearing current boxes', async ({ page }) => {
  const f = await fixture(page), held = deferred(); let originalStarted = false;
  f.reads.health = async route => {
    if (f.state.actor === ACTOR) { originalStarted = true; await held.promise; return route.fulfill({ status: 401,
      json: { error: { code: 'ZZ_TEST_OLD_SESSION', message: 'ZZ TEST previous health session ended' } } }); }
    return route.fulfill({ json: f.healthReply() });
  };
  await page.goto('/watch/health'); await expect.poll(() => originalStarted).toBe(true);
  f.state.actor = NEXT_ACTOR; f.state.revision++; f.state.boxes[0]!.name = 'ZZ TEST Current actor box';
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('oto:session-locked')));
  await expect(card(page, 'The boxes')).toContainText('ZZ TEST Current actor box');
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/ops/health');
  held.release(); await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(card(page, 'The boxes')).toContainText('ZZ TEST Current actor box');
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByText('ZZ TEST previous health session ended', { exact: true })).toHaveCount(0);
  expect(f.writes).toEqual([]);
});

test('a failed canonical health refresh does not keep a green current verdict from the previous snapshot', async ({ page }) => {
  const f = await fixture(page); let available = true;
  f.reads.health = async route => available ? route.fulfill({ json: f.healthReply() })
    : route.fulfill({ status: 503, json: { error: { code: 'ZZ_TEST_HEALTH_UNAVAILABLE', message: 'ZZ TEST health read unavailable' } } });
  await page.goto('/watch/health');
  await expect(command(page, 'Health')).toContainText('Everything is healthy');
  available = false; await refresh(page, 'Health');
  const message = page.getByText('The service returned an unexpected error. Read the current state before trying again.', { exact: true });
  await expect(message).toBeVisible();
  await expect(command(page, 'Health').getByText('Everything is healthy', { exact: true })).toHaveCount(0);
  available = true; await message.locator('xpath=ancestor::div[./button[normalize-space(.)="Try again"]][1]').getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(command(page, 'Health')).toContainText('Everything is healthy');
  expect(f.writes).toEqual([]);
});

test('a contract-valid unknown health verdict remains unknown rather than healthy', async ({ page }) => {
  const f = await fixture(page);
  f.reads.health = async route => route.fulfill({ json: { ...f.healthReply(), status: 'unknown' } });
  await page.goto('/watch/health');
  await expect(card(page, 'The boxes')).toContainText('ZZ TEST Health box');
  await expect(command(page, 'Health').getByText('Everything is healthy', { exact: true })).toHaveCount(0);
  await expect(command(page, 'Health')).toContainText(/unknown|not known/i);
  expect(f.writes).toEqual([]);
});

test('acknowledging a matching alert does not hide a still-down box from the current problem count', async ({ page }) => {
  const f = await fixture(page), down = f.state.boxes[0]!;
  const condition = `device.paper:${down.devices[0]!.id}`;
  down.state = 'down'; down.conditions = [condition, `box.clock:${down.id}`];
  down.clockOffsetMs = 120_000; down.devices[0]!.paperStatus = 'out';
  down.detail = 'ZZ TEST Printer is still out of paper.';
  f.reads.health = async route => route.fulfill({ json: { ...f.healthReply(), alerts: [{
    id: '01965000-0000-7000-8000-00000000000b', key: condition, severity: 'critical',
    title: 'ZZ TEST Acknowledged printer alert', detail: null, openedAt: NOW,
    acknowledgedAt: NOW, resolvedAt: null, count: 1,
  }] } });
  await page.goto('/watch/health');
  await expect(card(page, 'Alerts')).toContainText('ZZ TEST Acknowledged printer alert');
  await expect(card(page, 'The boxes')).toContainText('paper out');
  await expect(command(page, 'Health')).toContainText('One thing needs attention');
  await expect(card(page, 'Alerts')).toContainText('ZZ TEST Printer is still out of paper.');
  expect(f.writes).toEqual([]);
});

test('Services retains readiness station totals and each station count for this API instance without inventing absent readings', async ({ page }) => {
  const f = await fixture(page);
  const firstStation = '01965000-0000-7000-8000-00000000000c';
  const secondStation = '01965000-0000-7000-8000-00000000000d';
  let reported = true, readyReads = 0;
  await page.route('**/api/ready', route => {
    readyReads++;
    return route.fulfill({ json: { status: 'ready', checks: {
      database: { ok: true, latencyMs: 1 },
      pool: { total: 1, idle: 1, waiting: 0, max: 10 },
      jobs: { configured: true, watchdogAgeS: 10, staleAfterS: 90, stale: false },
      ...(reported ? { stationChannels: { stations: 2, connections: 7,
        perStation: { [firstStation]: 2, [secondStation]: 5 } } } : {}),
    } } });
  });
  await page.goto('/watch/health');
  await expect(card(page, 'The boxes')).toContainText('ZZ TEST Health box');
  const services = card(page, 'Services');
  const channels = services.getByRole('listitem').filter({ hasText: 'Station connections' });
  await expect(channels).toHaveCount(1);
  await expect(channels).toContainText('7 connections / 2 stations');
  await expect(channels).toContainText('This API instance only');
  await expect(channels).toContainText(`${firstStation}: 2 connections`);
  await expect(channels).toContainText(`${secondStation}: 5 connections`);
  await expect(services.getByText('Database', { exact: true })).toHaveCount(1);
  await expect(command(page, 'Health')).toContainText('Everything is healthy');
  await page.setViewportSize({ width: 390, height: 1100 });
  await services.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  reported = false;
  await refresh(page, 'Health'); await expect.poll(() => readyReads).toBe(2);
  await expect(channels).toContainText('Unknown');
  await expect(channels).toContainText('Station connection counts were not recorded.');
  await expect(channels).not.toContainText('0 connections');
  await expect(channels).not.toContainText('7 connections');
  await expect(channels).not.toContainText(firstStation);
  expect(f.writes).toEqual([]);
});
