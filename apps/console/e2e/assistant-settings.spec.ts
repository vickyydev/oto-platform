import { expect, test, type Page } from '@playwright/test';

// Entirely synthetic, on the actual built Console. No engine, channel, provider or real API request is dispatched.
const OPERATOR = '01960000-0000-7000-8000-000000000001';
const OTHER_OPERATOR = '01960000-0000-7000-8000-000000000002';
const ACTOR = '01960000-0000-7000-8000-000000000003';
const OTHER_ACTOR = '01960000-0000-7000-8000-000000000004';
const PARK = '01960000-0000-7000-8000-000000000005';
const OTHER_PARK = '01960000-0000-7000-8000-000000000006';
const NOW = '2026-10-25T08:00:00.000Z';
const ADDRESS = '/channels/assistant-settings';
const defaults = {
  internal: { personDailyCap: 21, dailyAskCap: 300, dailyTokenCap: 10_000, concurrentPerPerson: 3, concurrentPerOperator: 8 },
  inbox: { dailyTurnCap: 400, dailyTokenCap: 20_000, debounceSeconds: 2, debounceMaxSeconds: 8, firstBubbleMs: 300, bubbleGapMs: 600 },
};
type Overrides = { internal: Partial<typeof defaults.internal>; inbox: Partial<typeof defaults.inbox> };
type Rate = { model: string; effectiveFrom: string; inputUsdPerMillion: number; outputUsdPerMillion: number; cacheReadUsdPerMillion: number };
type Document = { operatorId: string; schemaVersion: 1; overrides: Overrides; effective: typeof defaults; rates: Rate[];
  source: 'environment' | 'operator' | 'invalid'; revision: number; updatedAt: string | null; updatedBy: string | null };
type Body = { expectedRevision: number; schemaVersion: 1; overrides: Overrides; rates: Rate[] };
type Outcome = { status: number; code?: string; message?: string; commit?: boolean; abort?: boolean };
const initial = (operatorId = OPERATOR): Document => ({ operatorId, schemaVersion: 1, overrides: { internal: {}, inbox: {} },
  effective: structuredClone(defaults), rates: [], source: 'environment', revision: 0, updatedAt: null, updatedBy: null });
const oldRate: Rate = { model: 'zz-test-model', effectiveFrom: '2026-01-01T00:00:00.000Z', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.5 };
const pause = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

async function fixture(page: Page) {
  const documents = new Map([[OPERATOR, initial()], [OTHER_OPERATOR, initial(OTHER_OPERATOR)]]);
  const control = { actor: ACTOR, operatorId: OPERATOR, branchId: PARK, locked: false, status: 'active', mustChange: false,
    scope: 'operator' as 'operator' | 'null' | 'branch' | 'foreign' | 'none',
    extraGrants: [] as string[], getOutcomes: [] as Outcome[], putOutcomes: [] as Outcome[],
    holds: [] as { method: 'GET' | 'PUT'; remaining: number; promise: Promise<void> }[] };
  const calls: { path: string; method: string; actor: string; operatorId: string; rawBody: string | null; body: Body | null; key: string | null }[] = [];
  const unexpected: { path: string; method: string }[] = [], errors: string[] = [];
  const cache = new Map<string, { rawBody: string; answer: Document }>(); let ownOrigin: string | null = null;
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (!ownOrigin && request.isNavigationRequest() && request.frame() === page.mainFrame()
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ownOrigin = url.origin;
    if (url.origin !== ownOrigin) return route.abort();
    if (!url.pathname.startsWith('/api/')) {
      if (method === 'GET') return route.fallback();
      unexpected.push({ path: url.pathname, method }); return route.abort();
    }
    const path = url.pathname.slice(4), actor = control.actor, operatorId = control.operatorId;
    const rawBody = request.postData(), body = rawBody ? JSON.parse(rawBody) as Body : null;
    const key = request.headers()['idempotency-key'] ?? null;
    calls.push({ path, method, actor, operatorId, rawBody, body, key });
    if (method === 'GET' && !url.search && path === '/me') return route.fulfill({ json: {
      account: { id: actor, operatorId, phone: '', status: control.status, mustChangePassword: control.mustChange },
      employee: { id: actor, name: 'ZZ TEST Settings editor', nickname: null }, branch: { id: control.branchId, name: 'ZZ TEST Settings park', code: 'zz-settings', timezone: 'Asia/Bangkok' },
      isPlatformAdmin: false, photoFileId: null, sessionLocked: control.locked, preferences: { theme: 'light', language: 'en' },
    } });
    if (method === 'GET' && !url.search && path === '/me/permissions') return route.fulfill({ json: { permissions: [
      ...['app:console:access', ...control.extraGrants].map(permission => ({ permission, scopeType: 'operator', scopeId: operatorId })),
      ...(control.scope === 'none' ? [] : [{ permission: 'inbox:ai:manage', scopeType: control.scope === 'branch' ? 'branch' : 'operator',
        scopeId: control.scope === 'null' ? null : control.scope === 'branch' ? PARK : control.scope === 'foreign' ? OTHER_OPERATOR : operatorId }]),
    ] } });
    if (method === 'GET' && !url.search && path === '/ready') return route.fulfill({ json: { ok: true } });
    if (path !== '/assistant-settings' || url.search || !['GET', 'PUT'].includes(method)) {
      unexpected.push({ path, method }); return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_OUTSIDE', message: 'ZZ TEST Unrelated request refused.' } } });
    }
    const current = structuredClone(documents.get(operatorId)!), outcome = (method === 'GET' ? control.getOutcomes : control.putOutcomes).shift();
    const held = control.holds.find(h => h.method === method && h.remaining > 0); if (held) { held.remaining--; await held.promise; }
    if (method === 'GET') return outcome ? route.fulfill({ status: outcome.status,
      json: { error: { code: outcome.code ?? 'ZZ_TEST_READ', message: outcome.message ?? 'ZZ TEST Source unavailable.' } } }) : route.fulfill({ json: current });
    expect(key).toMatch(/^[a-f0-9-]{36}$/i); expect(body).not.toBeNull();
    expect(Object.keys(body!).sort()).toEqual(['expectedRevision', 'overrides', 'rates', 'schemaVersion']);
    expect(Object.keys(body!.overrides).sort()).toEqual(['inbox', 'internal']);
    const cached = cache.get(key!);
    if (cached) expect(rawBody).toBe(cached.rawBody);
    let answer = cached?.answer;
    if (!answer && (!outcome || outcome.commit)) {
      if (body!.expectedRevision !== current.revision) return route.fulfill({ status: 409,
        json: { error: { code: 'SETTINGS_REVISION_CONFLICT', message: 'ZZ TEST Settings changed. Reload and review.' } } });
      const effective = { internal: { ...defaults.internal, ...body!.overrides.internal }, inbox: { ...defaults.inbox, ...body!.overrides.inbox } };
      effective.inbox.debounceMaxSeconds = Math.max(effective.inbox.debounceSeconds, effective.inbox.debounceMaxSeconds);
      answer = { operatorId, schemaVersion: 1, overrides: structuredClone(body!.overrides), effective, rates: structuredClone(body!.rates),
        source: 'operator', revision: current.revision + 1, updatedAt: NOW, updatedBy: actor };
      documents.set(operatorId, answer); cache.set(key!, { rawBody: rawBody!, answer });
    }
    if (outcome?.abort) return route.abort();
    if (outcome && outcome.status !== 200) return route.fulfill({ status: outcome.status,
      json: { error: { code: outcome.code ?? 'ZZ_TEST_SAVE', message: outcome.message ?? 'ZZ TEST Save refused.' } } });
    return route.fulfill({ json: answer });
  });
  page.on('pageerror', error => errors.push(error.name));
  return { control, documents, calls, unexpected, errors };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const writes = (f: Fixture) => f.calls.filter(c => c.path === '/assistant-settings' && c.method === 'PUT');
const reads = (f: Fixture) => f.calls.filter(c => c.path === '/assistant-settings' && c.method === 'GET');
const internal = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Internal assistant', exact: true }) });
const inbox = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Inbox assistant', exact: true }) });
const person = (page: Page) => internal(page).getByRole('spinbutton', { name: /^Per-person daily asks/ });
const save = (page: Page) => page.getByRole('button', { name: 'Save settings', exact: true });
async function ready(page: Page) {
  await expect(page.getByRole('heading', { name: 'Assistant settings', exact: true })).toBeVisible();
  await expect(person(page)).toBeVisible();
}
async function refreshSession(page: Page) {
  const next = page.waitForResponse(r => new URL(r.url()).pathname === '/api/me/permissions');
  await page.evaluate(() => window.dispatchEvent(new Event('oto:session-locked'))); await (await next).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}
async function finishReply(page: Page, held: ReturnType<typeof pause>, method: string) {
  const next = page.waitForResponse(r => new URL(r.url()).pathname === '/api/assistant-settings' && r.request().method() === method);
  held.release(); await (await next).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}
const clean = (f: Fixture) => { expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]); };

test('Channels offers the canonical native settings page independently of Inbox entry and keeps Teams routing', async ({ page }) => {
  const f = await fixture(page); f.control.extraGrants.push('inbox:routing:manage'); await page.goto('/channels');
  const link = page.locator('main').getByRole('link', { name: /Assistant settings/ });
  await expect(link).toHaveAttribute('href', ADDRESS);
  await expect(page.locator('main').getByRole('link', { name: /Teams & routing/ })).toHaveAttribute('href', '/channels/teams-routing');
  await expect(page.getByRole('button', { name: /^Open (Numbers|Templates|Knowledge base|Examples)$/ })).toHaveCount(0);
  await link.click(); await ready(page); expect(reads(f)).toHaveLength(1); expect(writes(f)).toEqual([]); clean(f);
});

test('only an own or null operator grant offers Assistant settings in Channels and the sidebar; older Channels links stay unchanged', async ({ page }) => {
  const f = await fixture(page); f.control.extraGrants.push('inbox:channel:manage', 'inbox:routing:manage'); f.control.scope = 'branch';
  await page.goto('/channels');
  const tile = page.locator('main').getByRole('link', { name: /Assistant settings/ });
  const nav = page.locator('aside nav').getByRole('link', { name: 'Assistant settings', exact: true });
  for (const scope of ['branch', 'foreign', 'none', 'operator', 'null'] as const) {
    f.control.scope = scope; if (scope !== 'branch') await refreshSession(page);
    await expect(page.locator('main').getByRole('link', { name: /Teams & routing/ })).toHaveAttribute('href', '/channels/teams-routing');
    await expect(page.locator('aside nav').getByRole('link', { name: 'Teams & routing', exact: true })).toHaveAttribute('href', '/channels/teams-routing');
    if (scope === 'operator' || scope === 'null') {
      await expect(tile).toHaveAttribute('href', ADDRESS); await expect(nav).toHaveAttribute('href', ADDRESS);
    } else { await expect(tile).toHaveCount(0); await expect(nav).toHaveCount(0); }
    await expect(page.getByRole('button', { name: /^Open (Numbers|Templates|Knowledge base|Examples)$/ })).toHaveCount(0);
    expect(reads(f)).toEqual([]); expect(writes(f)).toEqual([]);
  }
  await tile.click(); await ready(page); expect(reads(f)).toHaveLength(1); clean(f);
});

test('eleven native knobs show units and defaults; blank omits an override while explicit zero is saved', async ({ page }, info) => {
  const f = await fixture(page); await page.goto(ADDRESS); await ready(page);
  await expect(internal(page).getByRole('spinbutton')).toHaveCount(5); await expect(inbox(page).getByRole('spinbutton')).toHaveCount(6);
  for (const label of ['Per-person daily asks', 'Operator daily asks', 'Operator daily tokens', 'Concurrent asks per person', 'Concurrent asks per operator'])
    await expect(internal(page).getByRole('spinbutton', { name: new RegExp('^' + label) })).toBeVisible();
  for (const label of ['Daily turns', 'Daily tokens', 'Debounce (seconds)', 'Maximum debounce (seconds)', 'First bubble (milliseconds)', 'Bubble gap (milliseconds)'])
    await expect(inbox(page).getByRole('spinbutton', { name: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible();
  await expect(person(page)).toHaveValue(''); await expect(internal(page)).toContainText('Deployment default'); await expect(internal(page)).toContainText('21');
  await person(page).fill('0'); await internal(page).getByRole('spinbutton', { name: /^Operator daily asks/ }).fill('0');
  await save(page).click(); await expect(page.getByRole('status')).toContainText('Settings saved.');
  expect(writes(f)[0]!.body).toEqual({ expectedRevision: 0, schemaVersion: 1, overrides: { internal: { personDailyCap: 0, dailyAskCap: 0 }, inbox: {} }, rates: [] });
  await expect(person(page)).toHaveValue('0'); await person(page).fill(''); await save(page).click();
  expect(writes(f)[1]!.body).toEqual({ expectedRevision: 1, schemaVersion: 1, overrides: { internal: { dailyAskCap: 0 }, inbox: {} }, rates: [] });
  expect(writes(f)[1]!.key).not.toBe(writes(f)[0]!.key); await expect(person(page)).toHaveValue('');
  await page.screenshot({ path: info.outputPath('assistant-settings-desktop.png'), fullPage: true }); clean(f);
});

test('native integer bounds are enforced without inventing a maximum cap or rejecting debounce normalization', async ({ page }) => {
  const f = await fixture(page); await page.goto(ADDRESS); await ready(page);
  for (const value of ['-1', '1.5', '9007199254740992']) { await person(page).fill(value); await expect(save(page)).toBeDisabled(); }
  await person(page).fill('9000000000000'); await expect(save(page)).toBeEnabled(); await person(page).fill('');
  for (const [container, label, invalid, valid] of [
    [internal(page), /^Concurrent asks per person/, '0', '2'], [internal(page), /^Concurrent asks per person/, '101', '2'],
    [internal(page), /^Concurrent asks per operator/, '1001', '10'], [inbox(page), /^Debounce \(seconds\)/, '601', '10'],
    [inbox(page), /^Maximum debounce \(seconds\)/, '3601', '2'], [inbox(page), /^First bubble \(milliseconds\)/, '120001', '0'],
    [inbox(page), /^Bubble gap \(milliseconds\)/, '60001', '0'],
  ] as const) { const input = container.getByRole('spinbutton', { name: label }); await input.fill(invalid); await expect(save(page)).toBeDisabled(); await input.fill(valid); }
  await expect(save(page)).toBeEnabled(); await save(page).click(); await expect(page.getByRole('status')).toContainText('Settings saved.');
  expect(writes(f)[0]!.body!.overrides.inbox).toMatchObject({ debounceSeconds: 10, debounceMaxSeconds: 2, firstBubbleMs: 0, bubbleGapMs: 0 });
  await expect(inbox(page)).toContainText('10'); clean(f);
});

test('rate history stays immutable and ordinary UTC/model/USD fields add a later version without engine controls', async ({ page }) => {
  const f = await fixture(page), doc = f.documents.get(OPERATOR)!; Object.assign(doc, { rates: [structuredClone(oldRate)], source: 'operator', revision: 3, updatedAt: NOW, updatedBy: ACTOR });
  await page.goto(ADDRESS); await ready(page);
  const history = page.getByRole('list', { name: 'Saved rate versions', exact: true });
  await expect(history).toContainText(oldRate.model); await expect(history.getByRole('textbox')).toHaveCount(0); await expect(history.getByRole('spinbutton')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Edit|Delete) rate/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /^(API key|Provider key|JSON)/i })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /mode|model/i })).toHaveCount(0);
  await expect(page.getByText(/excludes.*cache writes/i)).toBeVisible();
  await page.getByRole('textbox', { name: /^Pricing model/ }).fill('zz-test-model');
  await page.getByLabel('Effective from (UTC)', { exact: true }).fill('2025-01-01T00:00');
  for (const [label, value] of [['Input USD per million', '0'], ['Output USD per million', '2.25'], ['Cache-read USD per million', '0.25']])
    await page.getByRole('spinbutton', { name: label, exact: true }).fill(value!);
  await expect(page.getByRole('button', { name: 'Add rate version', exact: true })).toBeDisabled();
  await page.getByLabel('Effective from (UTC)', { exact: true }).fill('2026-11-01T00:00');
  await page.getByRole('button', { name: 'Add rate version', exact: true }).click(); expect(writes(f)).toEqual([]);
  await save(page).click(); await expect(page.getByRole('status')).toContainText('Settings saved.');
  expect(writes(f)[0]!.body!.rates).toEqual([oldRate, { model: oldRate.model, effectiveFrom: '2026-11-01T00:00:00.000Z', inputUsdPerMillion: 0, outputUsdPerMillion: 2.25, cacheReadUsdPerMillion: 0.25 }]);
  await expect(history.getByRole('listitem')).toHaveCount(2); clean(f);
});

test('unknown/no-rate and invalid-storage states are explicit rather than a price zero or raw JSON editor', async ({ page }) => {
  const f = await fixture(page); Object.assign(f.documents.get(OPERATOR)!, { source: 'invalid', revision: 2, updatedAt: NOW, updatedBy: ACTOR }); await page.goto(ADDRESS); await ready(page);
  await expect(page.getByText(/Stored settings.*invalid/i)).toBeVisible(); await expect(page.getByText(/deployment defaults/i)).toBeVisible();
  await expect(page.getByText(/no rates configured/i)).toBeVisible(); await expect(page.getByText(/unpriced tokens/i)).toBeVisible();
  await expect(page.getByRole('textbox', { name: /raw|json/i })).toHaveCount(0); await expect(person(page)).toHaveValue(''); expect(writes(f)).toEqual([]); clean(f);
});

test('an operator-only own or null grant works, while branch, foreign and missing grants refuse before GET or PUT', async ({ page }) => {
  const f = await fixture(page); f.control.scope = 'branch'; await page.goto(ADDRESS);
  for (const scope of ['branch', 'foreign', 'none'] as const) {
    f.control.scope = scope; if (scope !== 'branch') await refreshSession(page);
    await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible(); await expect(save(page)).toHaveCount(0);
    expect(reads(f)).toEqual([]); expect(writes(f)).toEqual([]);
  }
  f.control.scope = 'null'; await refreshSession(page); await ready(page); expect(reads(f)).toHaveLength(1);
  await person(page).fill('0'); await save(page).click(); await expect(page.getByRole('status')).toContainText('Settings saved.'); clean(f);
});

test('loading and a failed read never fabricate editable defaults; retry is GET-only', async ({ page }) => {
  const f = await fixture(page), held = pause(); f.control.holds.push({ method: 'GET', remaining: 1, promise: held.promise });
  f.control.getOutcomes.push({ status: 503 }); await page.goto(ADDRESS);
  await expect(page.getByText('Loading assistant settings…', { exact: true })).toBeVisible(); await expect(person(page)).toHaveCount(0);
  await finishReply(page, held, 'GET'); await expect(page.getByRole('alert')).toContainText('ZZ TEST Source unavailable.'); await expect(person(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(page); expect(reads(f)).toHaveLength(2); expect(writes(f)).toEqual([]); clean(f);
});

test('uncertain saves freeze byte-identical body/key through duplicate presses and in-flight retry', async ({ page }) => {
  const f = await fixture(page); await page.goto(ADDRESS); await ready(page); await person(page).fill('37');
  const held = pause(); f.control.holds.push({ method: 'PUT', remaining: 1, promise: held.promise });
  f.control.putOutcomes.push({ status: 503, commit: true, message: 'ZZ TEST Lost result.' }, { status: 409, code: 'IDEMPOTENCY_IN_FLIGHT', message: 'ZZ TEST Still saving.' });
  await save(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => writes(f).length).toBe(1); await expect(person(page)).toBeDisabled(); await finishReply(page, held, 'PUT');
  const retry = page.getByRole('button', { name: 'Retry same save', exact: true }); await expect(retry).toBeVisible(); await expect(person(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
  await retry.click(); await expect(page.getByRole('alert')).toContainText('ZZ TEST Still saving.'); await retry.click();
  await expect(page.getByRole('status')).toContainText('Settings saved.'); expect(writes(f)).toHaveLength(3);
  expect(new Set(writes(f).map(c => c.key)).size).toBe(1); expect(new Set(writes(f).map(c => c.rawBody)).size).toBe(1);
  await expect(person(page)).toBeEnabled(); await expect(person(page)).toHaveValue('37'); clean(f);
});

test('confirmed PUT response is the canonical readback and a later GET failure does not turn the save into failure', async ({ page }) => {
  const f = await fixture(page); await page.goto(ADDRESS); await ready(page); await person(page).fill('44');
  f.control.getOutcomes.push({ status: 503, message: 'ZZ TEST Refresh unavailable.' }); await save(page).click();
  await expect(page.getByRole('status')).toContainText('Settings saved.'); await expect(person(page)).toHaveValue('44');
  expect(reads(f)).toHaveLength(1); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ZZ TEST Refresh unavailable.'); await expect(page.getByRole('status')).toContainText('Settings saved.');
  await expect(person(page)).toHaveValue('44'); expect(writes(f)).toHaveLength(1); clean(f);
});

test('revision conflicts demand reload/review and definite refusals permit a corrected new keyed save', async ({ page }) => {
  const f = await fixture(page); await page.goto(ADDRESS); await ready(page); await person(page).fill('31');
  f.control.putOutcomes.push({ status: 409, code: 'SETTINGS_REVISION_CONFLICT', message: 'ZZ TEST Settings changed. Reload and review.' });
  await save(page).click(); await expect(page.getByRole('alert')).toContainText('Reload and review.'); await expect(page.getByRole('button', { name: 'Retry same save', exact: true })).toHaveCount(0);
  await expect(save(page)).toBeDisabled();
  const changed = f.documents.get(OPERATOR)!; changed.revision = 4; changed.source = 'operator'; changed.overrides.internal.personDailyCap = 55; changed.effective.internal.personDailyCap = 55;
  await page.getByRole('button', { name: 'Reload and review', exact: true }).click(); await expect(person(page)).toHaveValue('55');
  await person(page).fill('56'); f.control.putOutcomes.push({ status: 403, code: 'PERMISSION_DENIED', message: 'ZZ TEST Save refused.' }); await save(page).click();
  await expect(page.getByRole('alert')).toContainText('ZZ TEST Save refused.'); await expect(person(page)).toBeEnabled(); await person(page).fill('57'); await save(page).click();
  await expect(page.getByRole('status')).toContainText('Settings saved.'); expect(writes(f).map(w => w.body!.expectedRevision)).toEqual([0, 4, 4]);
  expect(new Set(writes(f).map(w => w.key)).size).toBe(3); clean(f);
});

test('late read from actor/operator A cannot repopulate an A-to-B-to-A editor or replace its fresh draft', async ({ page }) => {
  const f = await fixture(page), held = pause(); f.documents.get(OPERATOR)!.overrides.internal.personDailyCap = 99; f.documents.get(OPERATOR)!.effective.internal.personDailyCap = 99;
  Object.assign(f.documents.get(OPERATOR)!, { source: 'operator', revision: 1, updatedAt: NOW, updatedBy: ACTOR });
  f.control.holds.push({ method: 'GET', remaining: 1, promise: held.promise }); await page.goto(ADDRESS); await expect.poll(() => reads(f).length).toBe(1);
  f.control.actor = OTHER_ACTOR; f.control.operatorId = OTHER_OPERATOR; f.control.branchId = OTHER_PARK; await refreshSession(page); await ready(page); await expect(person(page)).toHaveValue('');
  f.control.actor = ACTOR; f.control.operatorId = OPERATOR; f.control.branchId = PARK; f.documents.get(OPERATOR)!.overrides.internal.personDailyCap = 41; f.documents.get(OPERATOR)!.effective.internal.personDailyCap = 41;
  await refreshSession(page); await expect(person(page)).toHaveValue('41'); await person(page).fill('52');
  await finishReply(page, held, 'GET'); await expect(person(page)).toHaveValue('52'); await expect(page.getByRole('alert')).toHaveCount(0); expect(writes(f)).toEqual([]); clean(f);
});

test('a late successful save cannot replace the next actor draft or emit a stale success', async ({ page }) => {
  const f = await fixture(page); await page.goto(ADDRESS); await ready(page); await person(page).fill('61');
  const held = pause(); f.control.holds.push({ method: 'PUT', remaining: 1, promise: held.promise }); await save(page).click(); await expect.poll(() => writes(f).length).toBe(1);
  f.control.actor = OTHER_ACTOR; await refreshSession(page); await ready(page); await person(page).fill('72');
  await finishReply(page, held, 'PUT'); await expect(person(page)).toHaveValue('72'); await expect(page.getByText('Settings saved.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry same save', exact: true })).toHaveCount(0); expect(writes(f)).toHaveLength(1); clean(f);
});

test('grant/seat A-to-B-to-A invalidates uncertain intents; lock and inactive/password states mask the editor', async ({ page }) => {
  const f = await fixture(page); await page.goto(ADDRESS); await ready(page); await person(page).fill('61');
  const held = pause(); f.control.holds.push({ method: 'PUT', remaining: 1, promise: held.promise }); f.control.putOutcomes.push({ status: 503, message: 'ZZ TEST Old uncertain save.' });
  await save(page).click(); await expect.poll(() => writes(f).length).toBe(1);
  f.control.scope = 'branch'; f.control.branchId = OTHER_PARK; await refreshSession(page); await expect(person(page)).toHaveCount(0);
  f.control.scope = 'operator'; f.control.branchId = PARK; await refreshSession(page); await ready(page); await person(page).fill('83');
  await finishReply(page, held, 'PUT'); await expect(person(page)).toHaveValue('83'); await expect(page.getByRole('button', { name: 'Retry same save', exact: true })).toHaveCount(0);
  await expect(page.getByText('ZZ TEST Old uncertain save.', { exact: true })).toHaveCount(0);
  for (const state of ['locked', 'inactive', 'password'] as const) {
    const before = reads(f).length; f.control.locked = state === 'locked'; f.control.status = state === 'inactive' ? 'inactive' : 'active'; f.control.mustChange = state === 'password';
    await refreshSession(page); await expect(person(page)).toHaveCount(0); expect(reads(f)).toHaveLength(before);
    f.control.locked = false; f.control.status = 'active'; f.control.mustChange = false; await refreshSession(page); await ready(page); await expect(person(page)).toHaveValue('');
  }
  expect(writes(f)).toHaveLength(1); clean(f);
});

test('unmount discards a late save and a fresh visit starts from the canonical document rather than a retained draft', async ({ page }) => {
  const f = await fixture(page); await page.goto(ADDRESS); await ready(page); await person(page).fill('93');
  const held = pause(); f.control.holds.push({ method: 'PUT', remaining: 1, promise: held.promise }); f.control.putOutcomes.push({ status: 503, message: 'ZZ TEST Unmounted save.' });
  await save(page).click(); await expect.poll(() => writes(f).length).toBe(1);
  await page.getByRole('link', { name: 'Channels & assistant', exact: true }).click(); await expect(page).toHaveURL(/\/channels$/);
  await finishReply(page, held, 'PUT'); await expect(page.getByText('ZZ TEST Unmounted save.', { exact: true })).toHaveCount(0);
  await page.locator('main').getByRole('link', { name: /Assistant settings/ }).click(); await ready(page); await expect(person(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Retry same save', exact: true })).toHaveCount(0); expect(writes(f)).toHaveLength(1); clean(f);
});

test('all knobs, rates and save controls remain inside a 390px native phone viewport', async ({ page }, info) => {
  const f = await fixture(page); f.documents.get(OPERATOR)!.rates = [{ ...oldRate, model: 'zz-test-' + 'long-model-name-'.repeat(11) }];
  Object.assign(f.documents.get(OPERATOR)!, { source: 'operator', revision: 1, updatedAt: NOW, updatedBy: ACTOR });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(ADDRESS); await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  for (const input of await page.locator('main input,main select,main button').all()) {
    if (!await input.isVisible()) continue; const box = await input.boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await person(page).fill('0'); await save(page).scrollIntoViewIfNeeded(); await expect(save(page)).toBeEnabled();
  await page.screenshot({ path: info.outputPath('assistant-settings-phone.png'), fullPage: true }); expect(writes(f)).toEqual([]); clean(f);
});
