import { expect, test, type Page } from '@playwright/test';

const PARK = '01940000-0000-7000-8000-000000000001', OTHER = '01940000-0000-7000-8000-000000000002';
const OPERATOR = '01940000-0000-7000-8000-000000000003', ACTOR = '01940000-0000-7000-8000-000000000004';
const TEMPLATE = '01940000-0000-7000-8000-000000000005', PERSON = '01940000-0000-7000-8000-000000000006';
const SECOND = '01940000-0000-7000-8000-000000000007', CREDENTIAL = '01940000-0000-7000-8000-000000000008';
const access = ['app:console:access', 'admin:branch:read', 'catalog:package:read', 'catalog:menu:read', 'pos:checkin:read', 'catalog:package:update', 'pos:print:read', 'admin:branch:update', 'admin:box:command', 'admin:benefit:read', 'admin:benefit:manage', 'admin:benefit:credential_issue'];
const TODAY = '2026-10-23';
const hold = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
const config = (weekday = 12345) => ({ policy: { bands: [{ id: 'zz-band', label: 'ZZ TEST All ages', minAge: 0, maxAge: null, requirement: 'none' }], siblingWaiver: { enabled: false, guardianMinAge: 12, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [{ id: 'zz-consent', text: 'ZZ TEST Consent', required: true, order: 0 }] }, pricing: { oneTimeFee: { weekday, weekend: 16789 }, nannyHourly: { weekday: 23456, weekend: 27890 }, extraHour: { weekday: 34567, weekend: 38901 }, fullDayHours: 8, nannyRatioSoftMax: 4, prepaidFoodUnused: 'refund' }, photoRetentionDays: 30 });
type Body = Record<string, unknown>;
async function fixture(page: Page, options: { branchOnly?: boolean; command?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; query: string; body: Body | undefined; key: string | undefined }> = [];
  const control = { refused: new Set<string>(), pending: new Map<string, Promise<void>>(), uncertainOnce: new Set<string>(), credentialForFirst: false };
  const parks = [PARK, OTHER].map((id, i) => ({ id, name: i ? 'ZZ TEST Other care park' : 'ZZ TEST Care park', code: 'zz-care-' + i, timezone: 'Asia/Bangkok', country: 'TH', archived: false, address: null, openingHours: null, businessDayStart: '05:00:00' }));
  const configurations: Record<string, ReturnType<typeof config>> = { [PARK]: config(), [OTHER]: config(99999) };
  const templates = parks.map((park, i) => ({ id: i ? SECOND : TEMPLATE, branchId: park.id, type: 'receipt', name: i ? 'ZZ TEST Other receipt' : 'ZZ TEST Receipt', showLogo: true, headerText: 'ZZ TEST Header', footerText: 'ZZ TEST Footer', fields: { items: true, total: true }, version: 1, updatedAt: '2026-10-23T00:00:00.000Z' }));
  const profile = { credit: { amountSatang: 12345, period: 'daily' } };
  const version = { id: '01940000-0000-7000-8000-000000000009', effectiveFrom: TODAY, effectiveTo: null, createdAt: '2026-10-23T00:00:00.000Z', createdBy: { accountId: ACTOR, name: 'ZZ TEST Care administrator' } };
  const benefitTemplates = ['owner', 'manager', 'staff'].map(role => ({ role, name: role[0]!.toUpperCase() + role.slice(1), current: { ...version, profile }, upcoming: [] }));
  const staff = [PERSON, SECOND].map((employeeId, i) => ({ employeeId, name: i ? 'ZZ TEST Bea' : 'ZZ TEST Ada', nickname: null, branchId: i ? OTHER : PARK, branchName: parks[i]!.name, source: 'platform', current: { ...version, benefitRole: 'staff', override: null }, upcoming: [], effectiveProfile: profile }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, ''), method = request.method();
    const body = request.postData() ? request.postDataJSON() as Body : undefined;
    calls.push({ method, path, query: url.search, body, key: request.headers()['idempotency-key'] });
    await control.pending.get(method + ' ' + path + url.search);
    await control.pending.get(method + ' ' + path);
    if (control.refused.has(method + ' ' + path)) return route.fulfill({ status: 409, json: { error: { code: 'ZZ_TEST_REFUSED', message: 'ZZ TEST Keep this care draft.' } } });
    if (control.uncertainOnce.delete(method + ' ' + path)) return route.abort('failed');
    if (path === '/me') return route.fulfill({ json: { account: { id: ACTOR, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false }, employee: { id: ACTOR, name: 'ZZ TEST Care administrator', nickname: null }, branch: parks[0], isPlatformAdmin: false, photoFileId: null, sessionLocked: false, preferences: { theme: 'light', language: 'en' } } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: access.filter(permission => options.command !== false || permission !== 'admin:box:command').map(permission => ({ permission, scopeType: options.branchOnly ? 'branch' : 'operator', scopeId: options.branchOnly ? PARK : OPERATOR })) } });
    if (path === '/branches') return route.fulfill({ json: { branches: parks } });
    if (/^\/branches\/[^/]+\/menu$/.test(path)) return route.fulfill({ json: { branchId: PARK, categories: [], products: [], modifierGroups: [] } });
    if (path.startsWith('/checkin/config')) {
      const current = configurations[url.searchParams.get('branchId') ?? PARK]!;
      if (method === 'PUT') {
        if (path.endsWith('/pricing')) current.pricing = body as typeof current.pricing;
        if (path.endsWith('/policy')) Object.assign(current.policy, body);
        if (path.endsWith('/confirmations')) current.policy.confirmations = body!.items as typeof current.policy.confirmations;
      }
      return route.fulfill({ json: method === 'GET' ? { ...current, nannies: [] } : current });
    }
    const templateList = /^\/branches\/([^/]+)\/print-templates$/.exec(path);
    if (templateList) return route.fulfill({ json: { templates: templates.filter(row => row.branchId === templateList[1]) } });
    const template = /^\/print-templates\/([^/]+)(?:\/(preview\.png|test-print-target|test-print))?$/.exec(path);
    if (template) {
      if (template[2] === 'preview.png') return route.fulfill({ contentType: 'image/png', body: png });
      if (template[2] === 'test-print-target') return route.fulfill({ json: { printer: { deviceId: CREDENTIAL, label: 'ZZ TEST Mock printer' }, note: null, widthDots: 576 } });
      if (template[2] === 'test-print') return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_NO_HARDWARE', message: 'ZZ TEST No physical command.' } } });
      const row = templates.find(item => item.id === template[1])!;
      Object.assign(row, body, { version: row.version + 1 }); return route.fulfill({ json: { template: row } });
    }
    if (path === '/benefits/templates') return route.fulfill({ json: { today: TODAY, templates: benefitTemplates } });
    const benefitTemplate = /^\/benefits\/templates\/([^/]+)$/.exec(path);
    if (benefitTemplate) {
      const row = benefitTemplates.find(item => item.role === benefitTemplate[1])!;
      if (method === 'GET') return route.fulfill({ json: { today: TODAY, template: row, versions: [row.current] } });
      row.current = { ...row.current, profile: body!.profile as typeof profile }; return route.fulfill({ json: { changed: true, template: row } });
    }
    if (path === '/benefits/profiles') return route.fulfill({ json: { today: TODAY, staff } });
    const person = /^\/benefits\/profiles\/([^/]+)$/.exec(path);
    if (person) {
      const row = staff.find(item => item.employeeId === person[1])!;
      if (method === 'GET') return route.fulfill({ json: { today: TODAY, staff: row, versions: [row.current] } });
      Object.assign(row.current, body); return route.fulfill({ json: { changed: true, staff: row } });
    }
    if (path === '/benefits/credentials') return route.fulfill({ json: { credentials: control.credentialForFirst && url.searchParams.get('employeeId') === PERSON ? [{ id: CREDENTIAL, employeeId: PERSON, employeeName: 'ZZ TEST Ada', kid: 'zz-test-public-key-id', version: 1, status: 'active', issuedAt: '2026-10-23T00:00:00.000Z', expiresAt: '2027-10-23T00:00:00.000Z', issuedBy: { accountId: ACTOR, name: 'ZZ TEST Care administrator' }, revokedAt: null, revokedBy: null, lastSeenAt: null }] : [] } });
    if (path === '/benefits/applications') return route.fulfill({ json: { applications: [] } });
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_OUTSIDE', message: 'ZZ TEST Outside this care fixture.' } } });
  });
  return { calls, control, configurations, templates, staff, benefitTemplates };
}
const cardOf = (page: Page, name: string) => page.getByText(name, { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
const pricingForm = (page: Page) => page.locator('form').filter({ has: page.getByRole('heading', { name: 'Drop-off & nanny pricing', exact: true }) });

test('Care, print and staff benefits open their approved native panels and aliases without writes', async ({ page }) => {
  const state = await fixture(page);
  for (const [path, heading] of [['/catalogue/care', 'Drop-off & nanny pricing'], ['/catalogue/print-templates', 'Print templates'], ['/catalogue/staff-benefits', 'Role templates'], ['/care', 'Age bands'], ['/print-templates', 'Print templates'], ['/staff-benefits', 'Staff']]) {
    await page.goto(path!); await expect(page.getByRole('heading', { name: heading, exact: true, ...(heading === 'Print templates' ? { level: 2 } : {}) })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 1000 }); await page.goto('/catalogue/care');
  await expect(page.getByRole('heading', { name: 'Drop-off & nanny pricing', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(state.calls.filter(call => call.method !== 'GET' && !call.path.endsWith('/preview.png')).length).toBe(0);
});

test('branch offers retain care and template editing but separate operator benefits and physical-print authority', async ({ page }) => {
  const state = await fixture(page, { branchOnly: true, command: false });
  await page.goto('/catalogue/care'); await expect(page.getByRole('heading', { name: 'Drop-off & nanny pricing', exact: true })).toBeVisible();
  await expect(pricingForm(page).getByRole('spinbutton').first()).toBeEnabled();
  await page.goto('/catalogue/print-templates'); await page.getByRole('button', { name: 'Edit ZZ TEST Receipt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Print test', exact: true })).toBeDisabled();
  await page.goto('/catalogue/staff-benefits'); await expect(page.getByRole('heading', { name: 'Role templates', exact: true })).toBeVisible();
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Role templates', exact: true }) });
  await expect(section.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  for (const fieldset of await section.locator('fieldset').all()) {
    await expect(fieldset).toHaveAttribute('disabled', '');
    for (const control of await fieldset.locator('input,button,select,textarea').all()) await expect(control).toBeDisabled();
  }
  await expect(cardOf(page, 'ZZ TEST Ada').getByRole('button', { name: 'QR', exact: true })).toBeEnabled();
  expect(state.calls.some(call => call.path.endsWith('/test-print') || call.path.endsWith('/qr'))).toBe(false);
});

test('pricing refusal preserves exact fractions and a successful old response preserves a newer draft', async ({ page }) => {
  const state = await fixture(page), path = '/checkin/config/pricing'; state.control.refused.add('PUT ' + path);
  await page.goto('/catalogue/care'); const form = pricingForm(page), first = form.getByRole('spinbutton').first();
  await expect(first).toHaveValue('123.45'); await first.fill('234.56'); await form.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('ZZ TEST Keep this care draft.', { exact: true })).toBeVisible(); await expect(first).toHaveValue('234.56');
  expect(state.calls.find(call => call.method === 'PUT' && call.path === path)?.body?.oneTimeFee).toEqual({ weekday: 23456, weekend: 16789 });
  state.control.refused.delete('PUT ' + path); const held = hold(); state.control.pending.set('PUT ' + path, held.promise);
  await form.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect.poll(() => state.calls.filter(call => call.method === 'PUT' && call.path === path).length).toBe(2);
  await first.fill('456.78'); const response = page.waitForResponse(answer => answer.request().method() === 'PUT' && new URL(answer.url()).pathname.endsWith(path)); held.release(); await (await response).finished();
  await expect(first).toHaveValue('456.78'); await expect(form.getByText('Saved — live in the till.', { exact: true })).toHaveCount(0);
});

test('a policy save cannot dispatch its confirmation continuation after navigation to another native page', async ({ page }) => {
  const state = await fixture(page), held = hold(); state.control.pending.set('PUT /checkin/config/policy', held.promise);
  await page.goto('/catalogue/care'); await page.getByRole('textbox', { name: 'Band label', exact: true }).fill('ZZ TEST Edited all ages');
  await page.getByRole('button', { name: 'Save changes', exact: true }).last().click();
  await expect.poll(() => state.calls.filter(call => call.method === 'PUT' && call.path === '/checkin/config/policy').length).toBe(1);
  await page.getByRole('link', { name: 'Print templates', exact: true }).first().click(); await expect(page.getByRole('heading', { name: 'Print templates', level: 1, exact: true })).toBeVisible();
  const response = page.waitForResponse(answer => answer.request().method() === 'PUT' && new URL(answer.url()).pathname.endsWith('/checkin/config/policy')); held.release(); await (await response).finished();
  expect(state.calls.filter(call => call.method === 'PUT' && call.path === '/checkin/config/confirmations').length).toBe(0);
  await expect(page.getByRole('heading', { name: 'Print templates', level: 1, exact: true })).toBeVisible();
});

test('an old-park pricing response cannot replace the currently selected park', async ({ page }) => {
  const state = await fixture(page), held = hold(); state.control.pending.set('PUT /checkin/config/pricing', held.promise);
  await page.goto('/catalogue/care'); const form = pricingForm(page); await form.getByRole('spinbutton').first().fill('234.56');
  await form.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect.poll(() => state.calls.filter(call => call.method === 'PUT').length).toBe(1);
  await page.getByRole('combobox', { name: 'Park', exact: true }).selectOption(OTHER); await expect(pricingForm(page).getByRole('spinbutton').first()).toHaveValue('999.99');
  const response = page.waitForResponse(answer => answer.request().method() === 'PUT'); held.release(); await (await response).finished();
  await expect(pricingForm(page).getByRole('spinbutton').first()).toHaveValue('999.99');
  expect(state.calls.filter(call => call.method === 'PUT').map(call => call.query)).toEqual(['?branchId=' + PARK]);
});

test('template failure retains its draft, and retry saves content without a print command', async ({ page }) => {
  const state = await fixture(page), path = '/print-templates/' + TEMPLATE; state.control.refused.add('PATCH ' + path);
  await page.goto('/catalogue/print-templates'); await page.getByRole('button', { name: 'Edit ZZ TEST Receipt', exact: true }).click();
  await page.getByRole('button', { name: /More options/ }).click(); const footer = page.locator('#tpl-footer'); await footer.fill('ZZ TEST Retained footer');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.getByText('ZZ TEST Keep this care draft.', { exact: true })).toBeVisible(); await expect(footer).toHaveValue('ZZ TEST Retained footer');
  state.control.refused.delete('PATCH ' + path); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => state.templates[0]!.footerText).toBe('ZZ TEST Retained footer');
  expect(state.calls.filter(call => call.path.endsWith('/test-print')).length).toBe(0);
});

test('benefit template uncertain retry retains one key and late override A cannot close editor B', async ({ page }) => {
  const state = await fixture(page), path = '/benefits/templates/staff'; state.control.uncertainOnce.add('PUT ' + path);
  await page.goto('/catalogue/staff-benefits'); const template = page.locator('#benefit-from-staff').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  await template.getByRole('spinbutton').first().fill('234.56'); await template.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.method === 'PUT' && call.path === path).length).toBe(1);
  await expect(template.getByRole('button', { name: 'Save', exact: true })).toBeEnabled(); await template.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.method === 'PUT' && call.path === path).length).toBe(2);
  const writes = state.calls.filter(call => call.method === 'PUT' && call.path === path); expect(typeof writes[0]!.key === 'string' && /^[a-f0-9-]{36}$/i.test(writes[0]!.key)).toBe(true); expect(writes[1]!.key === writes[0]!.key).toBe(true); expect(writes[1]!.body).toEqual(writes[0]!.body);
  const held = hold(), target = '/benefits/profiles/' + PERSON; state.control.pending.set('PUT ' + target, held.promise);
  await cardOf(page, 'ZZ TEST Ada').getByRole('button', { name: 'Override', exact: true }).click(); await page.getByRole('dialog').locator('#benefit-person-from').fill('2026-10-24'); await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.method === 'PUT' && call.path === target).length).toBe(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await cardOf(page, 'ZZ TEST Bea').getByRole('button', { name: 'Override', exact: true }).click();
  await page.getByRole('dialog').locator('#benefit-person-from').fill('2026-10-25'); const response = page.waitForResponse(answer => answer.request().method() === 'PUT' && new URL(answer.url()).pathname.endsWith(target)); held.release(); await (await response).finished();
  await expect(page.getByRole('dialog')).toContainText('ZZ TEST Bea — benefit override'); await expect(page.getByRole('dialog').locator('#benefit-person-from')).toHaveValue('2026-10-25');
});

test('old employee credential metadata cannot start a QR read or populate a newly opened employee dialog', async ({ page }) => {
  const state = await fixture(page), held = hold(), path = '/benefits/credentials'; state.control.credentialForFirst = true; state.control.pending.set('GET ' + path + '?employeeId=' + PERSON, held.promise);
  await page.goto('/catalogue/staff-benefits'); await cardOf(page, 'ZZ TEST Ada').getByRole('button', { name: 'QR', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.path === path && call.query === '?employeeId=' + PERSON).length).toBe(1);
  await page.keyboard.press('Escape'); await cardOf(page, 'ZZ TEST Bea').getByRole('button', { name: 'QR', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('ZZ TEST Bea'); await expect(page.getByText('No benefit QR has been issued.', { exact: true })).toBeVisible();
  const response = page.waitForResponse(answer => new URL(answer.url()).pathname.endsWith(path) && new URL(answer.url()).searchParams.get('employeeId') === PERSON); held.release(); await (await response).finished();
  await expect(page.getByRole('dialog')).toContainText('ZZ TEST Bea'); await expect(page.getByRole('dialog').getByRole('img')).toHaveCount(0);
  expect(state.calls.filter(call => call.path.endsWith('/qr')).length).toBe(0);
});
