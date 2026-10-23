import { expect, test, type Page, type Response } from '@playwright/test';
import type { RoutingRules, RoutingTeams } from '../src/api/inbox-routing';

const PARK = '01950000-0000-7000-8000-000000000101';
const OTHER = '01950000-0000-7000-8000-000000000102';
const OPERATOR = '01950000-0000-7000-8000-000000000103';
const ACTOR = '01950000-0000-7000-8000-000000000104';
const NEXT_ACTOR = '01950000-0000-7000-8000-000000000105';
const TEAM = '01950000-0000-7000-8000-000000000106';
const GLOBAL_TEAM = '01950000-0000-7000-8000-000000000107';
const OTHER_TEAM = '01950000-0000-7000-8000-000000000108';
const RULE = '01950000-0000-7000-8000-000000000109';
const PERSON = '01950000-0000-7000-8000-000000000110';
const BACKUP = '01950000-0000-7000-8000-000000000111';
const DEPARTMENT = '01950000-0000-7000-8000-000000000112';
const NEW_RULE = '01950000-0000-7000-8000-000000000113';
const NOW = '2026-10-23T00:00:00.000Z';
const pause = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };

async function fixture(page: Page, options: { branchOnly?: boolean; routing?: boolean; missingTeam?: boolean } = {}) {
  const branches = [{ id: PARK, name: 'ZZ TEST Routing park' }, { id: OTHER, name: 'ZZ TEST Sibling park' }];
  const teams: RoutingTeams['teams'] = [
    { id: TEAM, key: 'reception', name: 'ZZ TEST Reception', branchId: PARK, branchName: branches[0]!.name,
      departmentId: DEPARTMENT, departmentName: 'ZZ TEST Reception department', colour: 'sky', sortOrder: 0, createdAt: NOW, updatedAt: NOW },
    { id: OTHER_TEAM, key: 'reception', name: 'ZZ TEST Sibling reception', branchId: OTHER, branchName: branches[1]!.name,
      departmentId: null, departmentName: null, colour: 'sky', sortOrder: 1, createdAt: NOW, updatedAt: NOW },
    { id: GLOBAL_TEAM, key: 'birthdays', name: 'ZZ TEST Birthdays', branchId: null, branchName: null,
      departmentId: null, departmentName: null, colour: 'pink', sortOrder: 2, createdAt: NOW, updatedAt: NOW },
  ];
  const rules: RoutingRules['rules'] = [{ id: RULE, teamId: TEAM, teamName: 'ZZ TEST Reception', category: 'general', language: null,
    branchId: PARK, branchName: branches[0]!.name, primaryKind: 'team', primaryAccountId: null, primaryAccountName: null,
    backupAccountId: BACKUP, backupAccountName: 'ZZ TEST Backup', autoAddBackup: true, priority: -10, active: true,
    archivedAt: null, createdAt: NOW, updatedAt: NOW }];
  const control = {
    actor: ACTOR, name: 'ZZ TEST Reception', longNames: false, readRefused: false,
    grants: ['app:console:access', ...(options.routing === false ? [] : ['inbox:routing:manage'])],
    kbBranchOnly: false,
    holds: [] as { path: string; method?: string; remaining: number; promise: Promise<void> }[],
    outcomes: [] as { status: number; code?: string; message?: string; abort?: boolean }[],
    handoff: false,
  };
  const calls: { path: string; method: string; actor: string; key: string | null; body: Record<string, unknown> | null }[] = [];
  const errors: string[] = [];
  let externalNavigations = 0;
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) externalNavigations++;
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    const path = url.pathname.slice(4).replace(/\/$/, ''), method = request.method();
    const actor = control.actor;
    const body = method === 'GET' ? null : request.postDataJSON() as Record<string, unknown> | null;
    calls.push({ path, method, actor, body, key: request.headers()['idempotency-key'] ?? null });
    if (path === '/me') return route.fulfill({ json: { account: { id: actor, operatorId: OPERATOR, phone: '', status: 'active', mustChangePassword: false },
      employee: { id: actor, name: actor === ACTOR ? 'ZZ TEST Manager A' : 'ZZ TEST Manager B', nickname: null },
      branch: { ...branches[0], code: 'zz-routing', timezone: 'Asia/Bangkok' }, isPlatformAdmin: false, photoFileId: null,
      sessionLocked: false, preferences: { theme: 'light', language: 'en' } } });
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: control.grants.map(permission => ({ permission,
      scopeType: options.branchOnly && permission === 'inbox:routing:manage' || control.kbBranchOnly && permission === 'inbox:kb:manage' ? 'branch' : 'operator',
      scopeId: options.branchOnly && permission === 'inbox:routing:manage' || control.kbBranchOnly && permission === 'inbox:kb:manage' ? PARK : OPERATOR })) } });
    if (path === '/auth/sign-in') return route.fulfill({ json: { accountId: actor, mustChangePassword: false } });
    if (path === '/auth/sign-out') return route.fulfill({ json: { ok: true } });
    if (path === '/inbox/teams' && method === 'GET') {
      if (control.readRefused) return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST Routing source refused.' } } });
      const visible = teams.filter(team => !options.branchOnly || team.branchId === PARK);
      const references = teams.filter(team => !options.branchOnly || team.branchId === PARK || team.branchId === null)
        .filter(team => !options.missingTeam || team.id !== TEAM);
      const answer: RoutingTeams = {
        operatorWide: !options.branchOnly, branches: options.branchOnly ? branches.slice(0, 1) : branches,
        departments: [{ id: DEPARTMENT, name: 'ZZ TEST Reception department', branchId: PARK }],
        accounts: [{ id: PERSON, displayName: 'ZZ TEST Primary', status: 'active' }, { id: BACKUP, displayName: 'ZZ TEST Backup', status: 'inactive' }],
        teamReferences: references.map(team => ({ id: team.id, key: team.key, name: team.name, branchId: team.branchId })),
        teams: visible.filter(team => !options.missingTeam || team.id !== TEAM).map(team => ({ ...team,
          name: team.id === TEAM ? control.name + (control.longNames ? ' long team name'.repeat(30) : '') : team.name })),
      };
      const held = control.holds.find(item => item.path === path && (!item.method || item.method === method) && item.remaining > 0);
      if (held) { held.remaining--; await held.promise; }
      return route.fulfill({ json: answer });
    }
    if (path === '/inbox/routing-rules' && method === 'GET') {
      const answer: RoutingRules = { rules: structuredClone(rules.filter(rule => !options.branchOnly || rule.branchId === PARK)) };
      const held = control.holds.find(item => item.path === path && (!item.method || item.method === method) && item.remaining > 0);
      if (held) { held.remaining--; await held.promise; }
      return route.fulfill({ json: answer });
    }
    if (path === '/auth/handoff') {
      const issued = control.handoff;
      const held = control.holds.find(item => item.path === path && item.remaining > 0);
      if (held) { held.remaining--; await held.promise; }
      return issued ? route.fulfill({ json: { launchUrl: 'https://inbox.invalid/#handoff=ZZ-TEST-synthetic' } }) :
        route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST Inbox settings refused.' } } });
    }
    if (path.startsWith('/inbox/') && method !== 'GET') {
      const held = control.holds.find(item => item.path === path && (!item.method || item.method === method) && item.remaining > 0);
      const outcome = control.outcomes.shift();
      if (held) { held.remaining--; await held.promise; }
      if (outcome?.abort) return route.abort();
      if (outcome && outcome.status !== 200) return route.fulfill({ status: outcome.status,
        json: { error: { code: outcome.code ?? 'ZZ_TEST_REFUSED', message: outcome.message ?? 'ZZ TEST Save refused.' } } });
      if (path === `/inbox/teams/${TEAM}` && method === 'PATCH') {
        Object.assign(teams[0]!, body); control.name = String(body?.name ?? control.name);
        return route.fulfill({ json: { team: teams[0] } });
      }
      if (path === '/inbox/teams' && method === 'POST') return route.fulfill({ json: { team: { ...teams[0], ...body } } });
      if (path === '/inbox/routing-rules' && method === 'POST') {
        const value = { ...rules[0]!, ...body, id: NEW_RULE, teamName: teams.find(team => team.id === body?.teamId)?.name ?? null,
          branchName: branches.find(branch => branch.id === body?.branchId)?.name ?? null };
        rules.push(value); return route.fulfill({ json: { rule: value } });
      }
      if (path === `/inbox/routing-rules/${RULE}` && method === 'PATCH') {
        Object.assign(rules[0]!, body); return route.fulfill({ json: { rule: rules[0] } });
      }
      if (path === `/inbox/routing-rules/${RULE}` && method === 'DELETE') {
        Object.assign(rules[0]!, { active: false, archivedAt: NOW }); return route.fulfill({ json: { ok: true } });
      }
    }
    return route.fulfill({ status: 403, json: { error: { code: 'ZZ_TEST_OUTSIDE', message: 'ZZ TEST Unrelated route refused.' } } });
  });
  page.on('pageerror', error => errors.push(error.name));
  return { control, calls, errors, teams, rules, externalNavigations: () => externalNavigations };
}

const drawer = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const writes = (state: Awaited<ReturnType<typeof fixture>>) => state.calls.filter(call => call.path.startsWith('/inbox/') && call.method !== 'GET');
async function reloadSession(page: Page) {
  const next = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/permissions');
  await page.evaluate(() => window.dispatchEvent(new Event('oto:session-locked')));
  await (await next).finished();
}
async function ready(page: Page) {
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible();
}

test('canonical team details edit without changing identity or requiring another directory permission', async ({ page }) => {
  const state = await fixture(page); await page.goto('/channels/teams-routing'); await ready(page);
  await page.getByRole('button', { name: 'Edit team', exact: true }).first().click();
  const form = drawer(page, 'Edit team');
  await expect(form.getByText(/key and park stay fixed/)).toBeVisible();
  await form.getByLabel('Team name', { exact: true }).fill('ZZ TEST Renamed reception');
  await form.getByLabel('Sort order', { exact: true }).fill('-3');
  await form.getByRole('button', { name: 'Save team', exact: true }).click();
  await expect(form).toHaveCount(0); await expect(page.getByRole('heading', { name: 'ZZ TEST Renamed reception', exact: true })).toBeVisible();
  expect(writes(state).map(call => [call.method, call.path, call.body])).toEqual([['PATCH', `/inbox/teams/${TEAM}`,
    { name: 'ZZ TEST Renamed reception', colour: 'sky', sortOrder: -3, departmentId: DEPARTMENT }]]);
  expect(state.calls.some(call => ['/branches', '/accounts', '/departments'].includes(call.path))).toBe(false);
  await expect(page.getByRole('button', { name: 'Delete team' })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('rule creation preserves signed priority, custom language, nullable wildcard and explicit people', async ({ page }) => {
  const state = await fixture(page); await page.goto('/teams-routing'); await ready(page);
  await page.getByRole('button', { name: 'Add routing rule', exact: true }).click();
  const form = drawer(page, 'Add routing rule');
  await form.getByRole('combobox', { name: 'Category', exact: true }).selectOption('birthdays');
  await form.getByRole('textbox', { name: /^Language / }).fill('custom-LANG');
  await form.getByRole('spinbutton', { name: /^Priority / }).fill('-10');
  await form.getByRole('combobox', { name: 'Primary', exact: true }).selectOption('account');
  await form.getByRole('combobox', { name: 'Primary person', exact: true }).selectOption(PERSON);
  await form.getByRole('combobox', { name: /^Backup person / }).selectOption(PERSON);
  await expect(form.getByText('Primary and backup must be different people.')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Save routing rule', exact: true })).toBeDisabled();
  await form.getByRole('combobox', { name: /^Backup person / }).selectOption(BACKUP);
  await form.getByRole('button', { name: 'Save routing rule', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(writes(state)[0]).toMatchObject({ method: 'POST', path: '/inbox/routing-rules', body: {
    category: 'birthdays', language: 'custom-LANG', branchId: null, priority: -10, primaryKind: 'account',
    primaryAccountId: PERSON, backupAccountId: BACKUP, autoAddBackup: true, active: true,
  } });
  expect(state.errors).toEqual([]);
});

test('archiving retains rule history and creates no team deletion or thread reassignment request', async ({ page }) => {
  const state = await fixture(page); await page.goto('/channels/teams-routing'); await ready(page);
  await page.getByRole('button', { name: 'Archive rule', exact: true }).click();
  const form = drawer(page, 'Archive routing rule');
  await expect(form.getByText(/Existing conversations keep their assignments/)).toBeVisible();
  await form.getByRole('button', { name: 'Confirm archive', exact: true }).click();
  await expect(form).toHaveCount(0); await expect(page.getByRole('button', { name: 'Edit rule', exact: true })).toHaveCount(0);
  await page.getByLabel('Show archived routing rules').check();
  await expect(page.getByText('Priority -10', { exact: false })).toBeVisible();
  await expect(page.getByText('Archived', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit rule', exact: true })).toHaveCount(0);
  expect(writes(state).map(call => [call.method, call.path, call.key !== null])).toEqual([['DELETE', `/inbox/routing-rules/${RULE}`, true]]);
});

test('missing canonical identities are the only team creates offered and branch-only routing needs no Channels navigation grant', async ({ page }) => {
  const state = await fixture(page, { branchOnly: true, missingTeam: true });
  await page.goto('/channels/teams-routing'); await ready(page);
  await expect(page.getByRole('link', { name: 'Channels & assistant', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create missing team', exact: true }).click();
  const form = drawer(page, 'Create missing team');
  await expect(form.getByRole('combobox', { name: 'System team identity', exact: true }).locator('option')).toHaveCount(1);
  await expect(form.getByRole('combobox', { name: 'System team identity', exact: true })).toContainText('Reception · ZZ TEST Routing park');
  await form.getByLabel('Team name', { exact: true }).fill('ZZ TEST Created reception');
  await form.getByRole('textbox', { name: /^Colour / }).fill('sky');
  await form.getByRole('button', { name: 'Save team', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(writes(state)[0]).toMatchObject({ method: 'POST', path: '/inbox/teams', body: { key: 'reception', branchId: PARK } });
  await page.getByRole('button', { name: 'Add routing rule', exact: true }).click();
  await expect(drawer(page, 'Add routing rule').getByRole('combobox', { name: /^Park / }).locator('option')).toHaveCount(1);
  await expect(drawer(page, 'Add routing rule').getByRole('combobox', { name: /^Park / })).toHaveValue(PARK);
  expect(state.calls.some(call => ['/accounts', '/branches', '/departments'].includes(call.path))).toBe(false);
});

test('read refusal and direct-address denial never become an empty successful editor', async ({ page }) => {
  const state = await fixture(page); state.control.readRefused = true;
  await page.goto('/channels/teams-routing');
  await expect(page.getByRole('alert')).toContainText('ZZ TEST Routing source refused.');
  await expect(page.getByText('No teams in this scope', { exact: true })).toHaveCount(0);
  state.control.grants = ['app:console:access']; await reloadSession(page);
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  const reads = state.calls.filter(call => call.path === '/inbox/teams').length;
  await page.reload(); await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.path === '/inbox/teams')).toHaveLength(reads);
  expect(writes(state)).toEqual([]);
});

test('old lists disappear immediately on filter refresh and late A-to-B-to-A responses cannot overwrite current rows', async ({ page }) => {
  const state = await fixture(page); await page.goto('/channels/teams-routing'); await ready(page);
  const first = pause(), second = pause();
  state.control.holds.push({ path: '/inbox/teams', remaining: 1, promise: first.promise });
  await page.getByRole('combobox', { name: 'Routing scope', exact: true }).selectOption(OTHER);
  await expect(page.getByRole('heading', { name: 'ZZ TEST Reception', exact: true })).toHaveCount(0);
  await expect(page.getByText('Loading teams and routing…', { exact: true })).toBeVisible();
  state.control.holds.push({ path: '/inbox/teams', remaining: 1, promise: second.promise });
  await page.getByRole('combobox', { name: 'Routing scope', exact: true }).selectOption(PARK);
  await expect.poll(() => state.calls.filter(call => call.path === '/inbox/teams').length).toBe(3);
  state.control.name = 'ZZ TEST Current collection';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ZZ TEST Current collection', exact: true })).toBeVisible();
  const lateReplies = new Promise<void>(resolve => {
    let received = 0;
    const listener = async (response: Response) => {
      if (new URL(response.url()).pathname !== '/api/inbox/teams') return;
      await response.finished();
      if (++received === 2) { page.off('response', listener); resolve(); }
    };
    page.on('response', listener);
  });
  second.release(); first.release();
  await lateReplies;
  await nextFrame(page);
  await expect(page.getByRole('heading', { name: 'ZZ TEST Current collection', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ZZ TEST Reception', exact: true })).toHaveCount(0);
});

test('uncertain saves freeze their payload and key through duplicate presses and an in-flight retry', async ({ page }) => {
  const state = await fixture(page); await page.goto('/channels/teams-routing'); await ready(page);
  await page.getByRole('button', { name: 'Edit rule', exact: true }).click();
  const form = drawer(page, 'Edit routing rule');
  await form.getByRole('textbox', { name: /^Language / }).fill('ZZ-LANG');
  state.control.outcomes.push({ status: 503, message: 'ZZ TEST Lost result.' }, { status: 409, code: 'IDEMPOTENCY_IN_FLIGHT', message: 'ZZ TEST Still saving.' });
  const held = pause(); state.control.holds.push({ path: `/inbox/routing-rules/${RULE}`, method: 'PATCH', remaining: 1, promise: held.promise });
  await form.getByRole('button', { name: 'Save routing rule', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => writes(state).length).toBe(1); held.release();
  await expect(form.getByRole('button', { name: 'Retry same save', exact: true })).toBeVisible();
  await expect(form.getByRole('textbox', { name: /^Language / })).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Retry same save', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('ZZ TEST Still saving.');
  await form.getByRole('button', { name: 'Retry same save', exact: true }).click();
  await expect(form).toHaveCount(0);
  const attempts = writes(state);
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts.map(call => call.key)).size).toBe(1);
  expect(attempts.every(call => JSON.stringify(call.body) === JSON.stringify(attempts[0]!.body))).toBe(true);
  expect(attempts[0]!.body).toMatchObject({ language: 'ZZ-LANG', priority: -10 });
});

test('a definite save refusal permits correction with a new intent and stale authority save completion cannot close a current editor', async ({ page }) => {
  const state = await fixture(page); await page.goto('/channels/teams-routing'); await ready(page);
  await page.getByRole('button', { name: 'Edit rule', exact: true }).click();
  let form = drawer(page, 'Edit routing rule');
  state.control.outcomes.push({ status: 403, message: 'ZZ TEST Rule target refused.' });
  await form.getByRole('button', { name: 'Save routing rule', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('ZZ TEST Rule target refused.');
  await expect(form.getByRole('textbox', { name: /^Language / })).toBeEnabled();
  await form.getByRole('textbox', { name: /^Language / }).fill('corrected');
  const held = pause(); state.control.holds.push({ path: `/inbox/routing-rules/${RULE}`, method: 'PATCH', remaining: 1, promise: held.promise });
  await form.getByRole('button', { name: 'Save routing rule', exact: true }).click();
  await expect.poll(() => writes(state).length).toBe(2);
  expect(writes(state)[0]!.key).not.toBe(writes(state)[1]!.key);
  state.control.actor = NEXT_ACTOR; state.control.name = 'ZZ TEST Current actor team'; await reloadSession(page);
  await expect(page.getByRole('heading', { name: 'ZZ TEST Current actor team', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit team', exact: true }).first().click(); form = drawer(page, 'Edit team');
  await form.getByLabel('Team name', { exact: true }).fill('ZZ TEST Current unsaved draft');
  const late = page.waitForResponse(response => new URL(response.url()).pathname === `/api/inbox/routing-rules/${RULE}`);
  held.release(); await (await late).finished();
  await nextFrame(page);
  await expect(form).toBeVisible(); await expect(form.getByLabel('Team name', { exact: true })).toHaveValue('ZZ TEST Current unsaved draft');
  expect(state.errors).toEqual([]);
});

test('Channels settings respect their own gates and a deliberate duplicate press issues only one acting-user handoff', async ({ page }) => {
  const state = await fixture(page); state.control.grants.push('inbox:channel:manage');
  await page.goto('/channels');
  await expect(page.getByRole('button', { name: /^Open (Numbers|Templates|Knowledge base|Examples)$/ })).toHaveCount(0);
  state.control.grants.push('app:inbox:access', 'inbox:kb:manage', 'inbox:template:manage');
  state.control.kbBranchOnly = true; await reloadSession(page);
  await expect(page.getByRole('button', { name: 'Open Knowledge base', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Templates', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Examples', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Numbers', exact: true })).toHaveCount(0);
  expect(state.calls.some(call => call.path === '/auth/handoff')).toBe(false);
  const held = pause(); state.control.holds.push({ path: '/auth/handoff', remaining: 1, promise: held.promise });
  await page.getByRole('button', { name: 'Open Templates', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => state.calls.filter(call => call.path === '/auth/handoff').length).toBe(1);
  held.release(); await expect(page.getByText('ZZ TEST Inbox settings refused.', { exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.path === '/auth/handoff').map(call => call.body)).toEqual([{ app: 'inbox' }]);
  expect(state.externalNavigations()).toBe(0);
});

test('a late Inbox handoff cannot navigate after an actor and grant A-to-B-to-A lifetime', async ({ page }) => {
  const state = await fixture(page); state.control.grants.push('app:inbox:access', 'inbox:ai:manage'); state.control.handoff = true;
  await page.goto('/channels'); await expect(page.getByRole('button', { name: 'Open Numbers', exact: true })).toBeVisible();
  const held = pause(); state.control.holds.push({ path: '/auth/handoff', remaining: 1, promise: held.promise });
  await page.getByRole('button', { name: 'Open Numbers', exact: true }).click();
  await expect.poll(() => state.calls.filter(call => call.path === '/auth/handoff').length).toBe(1);
  state.control.actor = NEXT_ACTOR; state.control.grants = state.control.grants.filter(permission => permission !== 'inbox:ai:manage');
  state.control.grants.push('inbox:channel:manage'); await reloadSession(page);
  await expect(page.getByRole('button', { name: 'Open Numbers', exact: true })).toHaveCount(0);
  state.control.actor = ACTOR; state.control.grants.push('inbox:ai:manage'); await reloadSession(page);
  await expect(page.getByRole('button', { name: 'Open Numbers', exact: true })).toBeVisible();
  const late = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/handoff');
  held.release(); await (await late).finished();
  await nextFrame(page);
  await expect(page).toHaveURL(/\/channels$/);
  expect(state.externalNavigations()).toBe(0);
});

async function nextFrame(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

test('team and rule controls remain bounded on a 390px phone with long native labels', async ({ page }) => {
  const state = await fixture(page); state.control.longNames = true;
  await page.setViewportSize({ width: 390, height: 1000 }); await page.goto('/channels/teams-routing'); await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: 'Edit team', exact: true }).first().click();
  for (const title of ['Edit team', 'Add routing rule']) {
    if (title === 'Add routing rule') { await drawer(page, 'Edit team').getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('button', { name: 'Add routing rule', exact: true }).click(); }
    const form = drawer(page, title);
    await expect.poll(async () => {
      const bounds = await form.getByRole('button', { name: 'Close', exact: true }).boundingBox();
      return bounds ? bounds.x + bounds.width : Infinity;
    }).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    for (const input of await form.locator('input,select,button').all()) {
      const bounds = await input.boundingBox(); expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    }
  }
  expect(state.errors).toEqual([]); expect(writes(state)).toEqual([]);
});
