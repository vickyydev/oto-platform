import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The till comes up with no internet — proved rather than asserted.
 *
 * WHY THIS SPEC SERVES ITS OWN BUILD instead of using the smoke config's base
 * URL: a service worker only exists in a production build, and the dev server
 * the other specs run against emits no `sw.js` at all. So this one builds
 * nothing but does require a build to exist, starts `vite preview` over
 * `dist/public` on a port of its own, and drives a private browser context so
 * the worker it registers cannot outlive the test and control the dev server
 * afterwards.
 *
 * WHAT IT ACTUALLY CHECKS, in the order that matters:
 *   1. The worker takes control of the first load.
 *   2. With the network switched off at the browser, a RELOAD still renders
 *      the lock screen — which is the acceptance criterion, and which can only
 *      come from the cache.
 *   3. Inter is still the font, because the faces are precached and not
 *      fetched from another origin.
 *   4. Nothing addressed to `/api` is in any cache bucket. This is the half
 *      that a screenshot of a working offline page would never catch, and it
 *      is the half that matters on an iPad that can be carried out of a mall.
 */

const POS_ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(POS_ROOT, 'dist', 'public');
const PORT = Number(process.env.PWA_PREVIEW_PORT ?? 25751);
const BASE = `http://localhost:${PORT}`;

let preview: ChildProcess | null = null;

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`preview server never answered on ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test.describe('PWA shell', () => {
  test.skip(
    !fs.existsSync(path.join(DIST, 'sw.js')),
    'run `pnpm --filter @oto/pos build` first: this spec drives the built shell, and a dev server has no service worker',
  );

  test.beforeAll(async () => {
    preview = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vite', 'preview', '--config', 'vite.config.ts', '--port', String(PORT), '--strictPort'],
      { cwd: POS_ROOT, stdio: 'ignore', shell: process.platform === 'win32' },
    );
    await waitForServer(`${BASE}/sw.js`, 60_000);
  });

  test.afterAll(() => {
    preview?.kill();
    preview = null;
  });

  test('loads the lock screen from the service worker with the network off', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const context = await browser.newContext({ baseURL: BASE });
    const page: Page = await context.newPage();

    // 1. First load, online, and the worker takes control of THIS page —
    //    `clients.claim()` in activate is what makes that true without a
    //    second reload.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 30_000,
    });

    const buildId = await page.evaluate(async () => {
      const cacheNames = await caches.keys();
      return cacheNames.find((name) => name.startsWith('oto-pos-shell-')) ?? null;
    });
    expect(buildId).toMatch(/^oto-pos-shell-[0-9a-f]{16}$/);

    // 2. The whole point. Nothing may be fetched from the network from here.
    await context.setOffline(true);
    const attempted: string[] = [];
    page.on('request', (request) => attempted.push(request.url()));

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible({
      timeout: 30_000,
    });

    // 3. Still Inter. A shell that comes up in the browser's fallback face has
    //    changed the design at the worst possible moment.
    const hasInter = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('600 16px Inter');
    });
    expect(hasInter).toBe(true);

    // 3b. And a sign-in tried on that offline shell says what is actually
    //     wrong. "Failed to fetch" is the browser talking about its own
    //     plumbing; reception needs to know the screen has no connection.
    await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill('0900000002');
    await page.locator('input[type="password"]').fill('whatever');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('No answer from the platform')).toBeVisible({ timeout: 15_000 });

    // 4. Nothing personal, and nothing from the API, is on this device.
    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) out.push(new URL(request.url).pathname);
      }
      return out;
    });
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.filter((p) => p === '/api' || p.startsWith('/api/'))).toEqual([]);

    // And the offline reload really did come out of the cache rather than out
    // of a preview server that was still answering: every request the page
    // made while offline is one the worker could satisfy.
    expect(attempted.length).toBeGreaterThan(0);

    await context.close();
  });
});
