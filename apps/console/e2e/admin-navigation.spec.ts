import { expect, test } from '@playwright/test';
import { signIn } from './console';

const areas = ['Overview', 'People & access', 'Organisation', 'Catalogue & money',
  'Devices & places', 'Channels & assistant', 'Staff & HR', 'Reports', 'Watch', 'Platform'];

test('Admin opens on Overview, and all ten areas work at desktop and phone width', async ({ page }) => {
  await signIn(page);
  await page.waitForURL(/\/overview$/);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Admin', exact: true });
  for (const label of areas) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  for (const label of areas) {
    await nav.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', {
      name: label === 'Devices & places' ? 'Devices' : label, exact: true,
    })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Health', exact: true }).click();
  await expect(page).toHaveURL(/\/watch\/health$/);
  await expect(page.getByRole('heading', { name: 'Health', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  for (const label of areas) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Platform', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Platform', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await nav.getByRole('link', { name: 'People & access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'People & access', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('old page addresses open their pages; new navigation keeps the page permissions', async ({ page }) => {
  await signIn(page);
  await page.waitForURL(/\/overview$/);
  for (const [path, heading] of [
    ['/health', 'Health'], ['/failures', 'Failures'], ['/activity', 'Activity'],
    ['/devices', 'Devices'], ['/booths', 'Booths'], ['/branches', 'Branches'],
    ['/bookings', 'Bookings'], ['/booth-report', 'Booth report'],
    ['/vouchers', 'Vouchers'], ['/voucher-types', 'Voucher types'], ['/integrations', 'Integrations'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
  }
});

test('partial access hides areas and child links; the area gate never replaces an existing page guard', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 403,
    json: { error: { code: 'PERMISSION_DENIED', message: 'No read access in this fixture.' } } }));
  await page.route('**/api/me', (route) => route.fulfill({ json: {
    account: { id: 'fixture', phone: '', status: 'active', mustChangePassword: false, operatorId: 'fixture' },
    employee: { id: 'fixture', name: 'ZZ TEST Navigation', nickname: null }, branch: null,
    isPlatformAdmin: false, photoFileId: null, sessionLocked: false,
  } }));
  await page.route('**/api/me/permissions', (route) => route.fulfill({ json: { permissions:
    ['app:console:access', 'admin:audit:read', 'pos:booking:read'].map((permission) => ({
      permission, scopeType: 'branch', scopeId: 'fixture',
    })),
  } }));
  await page.goto('/watch');
  const nav = page.getByRole('navigation', { name: 'Admin', exact: true });
  await expect(nav.getByRole('link', { name: 'Watch', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Activity', exact: true })).toBeVisible();
  for (const label of ['Health', 'Failures', 'Integrations', 'Reports', 'Platform', 'Staff & HR']) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }
  await page.goto('/watch/health');
  await expect(page.getByText('This page is not on your access', { exact: true })).toBeVisible();
  await page.goto('/platform');
  await expect(page.getByText('This area is not on your access.', { exact: true })).toBeVisible();
  // The Reports gate hides navigation, but the existing Bookings permission still opens its old URL.
  await page.goto('/bookings');
  await expect(page.getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
});
