import { expect, test, type Page } from '@playwright/test';

type Theme = 'light' | 'dark' | 'system';
type Preferences = { theme: Theme; language: 'en' | 'th' };
type Write = { body: Record<string, unknown>; key: string | undefined };

async function fixture(page: Page, initial: Preferences, options: { rejectPreference?: number; omitPreferences?: boolean } = {}) {
  let preferences = { ...initial }, accountId = 'theme-account-a', signedIn = true;
  let preferenceRequests = 0;
  const writes: Write[] = [];
  const otherWrites: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api/, '').replace(/\/$/, '');
    if (path === '/me' && request.method() === 'GET') {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Sign in again.' } } });
      return route.fulfill({ json: {
        account: { id: accountId, phone: '', status: 'active', mustChangePassword: false, operatorId: 'theme-operator' },
        employee: { id: 'theme-employee', name: 'ZZ TEST Theme', nickname: null }, branch: null,
        isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
        ...(options.omitPreferences ? {} : { preferences }),
      } });
    }
    if (path === '/me/permissions') return route.fulfill({ json: { permissions: ['app:console:access', 'admin:audit:read'].map(permission => ({ permission, scopeType: 'operator', scopeId: 'theme-operator' })) } });
    if (path === '/me/preferences' && request.method() === 'PUT') {
      writes.push({ body: request.postDataJSON() as Record<string, unknown>, key: request.headers()['idempotency-key'] });
      if (++preferenceRequests === 1 && options.rejectPreference) {
        if (options.rejectPreference === 401) signedIn = false;
        return route.fulfill({ status: options.rejectPreference, json: { error: { code: options.rejectPreference === 401 ? 'UNAUTHORIZED' : 'UNAVAILABLE', message: 'Preference save did not complete.' } } });
      }
      preferences = { ...preferences, ...writes.at(-1)!.body } as Preferences;
      return route.fulfill({ json: { preferences } });
    }
    if (path === '/auth/sign-out' && request.method() === 'POST') {
      signedIn = false; return route.fulfill({ json: { ok: true } });
    }
    if (path === '/auth/sign-in' && request.method() === 'POST') {
      signedIn = true; return route.fulfill({ json: { accountId, mustChangePassword: false } });
    }
    if (request.method() !== 'GET') otherWrites.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Outside this theme fixture.' } } });
  });
  return { writes, otherWrites, preferences: () => preferences, nextAccount: (next: Preferences) => { accountId = 'theme-account-b'; preferences = { ...next }; } };
}

const themeButton = (page: Page) => page.getByRole('button', { name: /^Theme:/ }).filter({ visible: true }).first();

test('Console adopts the account dark theme on resume and reload without saving or changing language', async ({ page }) => {
  const seen = await fixture(page, { theme: 'dark', language: 'th' });
  await page.goto('/watch');
  await expect(page.getByRole('heading', { name: 'Watch', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(themeButton(page)).toHaveAccessibleName('Theme: Dark — switch to system');
  expect(seen.writes).toEqual([]);
  await page.reload();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'dark');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  expect(seen.writes).toEqual([]);
  expect(seen.preferences().language).toBe('th');
  expect(seen.otherWrites).toEqual([]);
});

test('System follows the device, the sidebar cycles all three choices, and a save retry keeps its action key and language', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const seen = await fixture(page, { theme: 'system', language: 'th' }, { rejectPreference: 503 });
  await page.goto('/watch');
  await expect(themeButton(page)).toHaveAccessibleName('Theme: System — switch to light');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass(/\blight\b/);
  expect(seen.writes).toEqual([]);
  await themeButton(page).click();
  await expect.poll(() => seen.writes.length).toBe(2);
  expect(seen.writes[0]!.body).toEqual({ theme: 'light' });
  expect(seen.writes[1]).toEqual(seen.writes[0]);
  expect(seen.writes[0]!.key).toBeTruthy();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\blight\b/);
  await expect(themeButton(page)).toHaveAccessibleName('Theme: Light — switch to dark');
  await themeButton(page).click();
  await expect.poll(() => seen.writes.length).toBe(3);
  await expect(themeButton(page)).toHaveAccessibleName('Theme: Dark — switch to system');
  await themeButton(page).click();
  await expect.poll(() => seen.writes.length).toBe(4);
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'system');
  expect(seen.writes.map(row => row.body)).toEqual([{ theme: 'light' }, { theme: 'light' }, { theme: 'dark' }, { theme: 'system' }]);
  expect(new Set(seen.writes.map(row => row.key)).size).toBe(3);
  expect(seen.preferences().language).toBe('th');
  const nav = page.getByRole('navigation', { name: 'Admin', exact: true });
  await expect(nav.getByRole('link', { name: 'Watch', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'People & access', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Platform', exact: true })).toHaveCount(0);
  expect(seen.otherWrites).toEqual([]);
});

test('sign-out releases write-back and the next account adopts its own preference', async ({ page }) => {
  const seen = await fixture(page, { theme: 'dark', language: 'th' });
  await page.goto('/watch');
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'dark');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('input[type=password]')).toBeVisible();
  await themeButton(page).click();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'system');
  expect(seen.writes).toEqual([]);
  seen.nextAccount({ theme: 'light', language: 'en' });
  await page.locator('input[type=tel]').fill('+66800000002');
  await page.locator('input[type=password]').fill('synthetic-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Watch', exact: true })).toBeVisible();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'light');
  await expect(page.locator('html')).toHaveClass(/\blight\b/);
  expect(seen.writes).toEqual([]);
  expect(seen.preferences().language).toBe('en');
  expect(seen.otherWrites).toEqual([]);
});

test('a preference-save401 releases the account before its retry or a signed-out toggle can write', async ({ page }) => {
  const seen = await fixture(page, { theme: 'light', language: 'th' }, { rejectPreference: 401 });
  await page.goto('/watch');
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'light');
  await themeButton(page).click();
  await expect(page.locator('input[type=password]')).toBeVisible();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'dark');
  await themeButton(page).click();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'system');
  // The approved controller retries once after1500ms; release must cancel it.
  await page.waitForTimeout(1700);
  expect(seen.writes).toHaveLength(1);
  expect(seen.writes[0]!.body).toEqual({ theme: 'dark' });
  expect(seen.preferences().language).toBe('th');
  expect(seen.otherWrites).toEqual([]);
});

test('a legacy me response without preferences adopts defensively and still allows an explicit theme-only save', async ({ page }) => {
  const seen = await fixture(page, { theme: 'dark', language: 'th' }, { omitPreferences: true });
  await page.goto('/watch');
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'light');
  expect(seen.writes).toEqual([]);
  await themeButton(page).click();
  await expect.poll(() => seen.writes.length).toBe(1);
  expect(seen.writes[0]!.body).toEqual({ theme: 'dark' });
  expect(seen.preferences().language).toBe('th');
});

test('a late permissions response cannot adopt or rebind an account after the unauthorized event', async ({ page }) => {
  const seen = await fixture(page, { theme: 'dark', language: 'th' });
  let release!: () => void, waiting = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/me/permissions', async route => {
    waiting = true; await pending;
    await route.fulfill({ json: { permissions: ['app:console:access', 'admin:audit:read'].map(permission => ({ permission, scopeType: 'operator', scopeId: 'theme-operator' })) } });
  });
  await page.goto('/watch');
  await expect.poll(() => waiting).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('oto:unauthorized')));
  await expect(page.locator('input[type=password]')).toBeVisible();
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/permissions');
  release(); await (await lateResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('input[type=password]')).toBeVisible();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'light');
  await themeButton(page).click();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'dark');
  expect(seen.writes).toEqual([]);
  expect(seen.otherWrites).toEqual([]);
});

test('an expired handoff keeps its existing explanation after the anonymous me401 and leaves theme writes released', async ({ page }) => {
  const writes: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api/, '');
    if (path === '/auth/handoff/exchange' && request.method() === 'POST') {
      return route.fulfill({ status: 401, json: { error: { code: 'HANDOFF_EXPIRED', message: 'The sign-in expired.', details: { reason: 'expired' } } } });
    }
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Sign in again.' } } });
  });
  await page.goto('/#handoff=synthetic-fixture');
  await expect(page.locator('input[type=password]')).toBeVisible();
  await expect(page).not.toHaveURL(/#/);
  await expect(page.getByText('The sign-in from the launcher took too long and expired. Sign in here to open the console.', { exact: true })).toBeVisible();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'light');
  await themeButton(page).click();
  await expect(themeButton(page)).toHaveAttribute('data-theme-preference', 'dark');
  expect(writes).toEqual([]);
});
