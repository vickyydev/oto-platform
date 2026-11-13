import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { KitchenLineReading } from './main';

/**
 * SCRUM-967 — serves this folder's page (`index.html`) as the split view's
 * harnesses serve theirs (`../splitfix-harness/server.ts`): the till's own
 * React and Tailwind set-up and its `@/` alias, on an ephemeral loopback port,
 * with no API, service worker or dev server behind it, and its own pre-bundle
 * cache.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const posRoot = path.resolve(here, '../../..');

export interface KitchenEditHarness {
  page: Page;
  /** Opens the Edit form at a window size and reads its kitchen and bar lines. */
  read: (query: string, size: { width: number; height: number }) => Promise<KitchenLineReading[]>;
  close: () => Promise<void>;
}

export async function startKitchenEditHarness(browser: Browser): Promise<KitchenEditHarness> {
  const server: ViteDevServer = await createServer({
    configFile: false,
    root: posRoot,
    cacheDir: path.join(posRoot, 'node_modules/.vite-kitchenedit-harness'),
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.join(posRoot, 'src') }, dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    optimizeDeps: { entries: [path.join(here, 'index.html')] },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo | null;
    if (!address) throw new Error('the SCRUM-967 measurement server did not start');
    const url = `http://127.0.0.1:${address.port}/test/support/kitchenedit-harness/index.html`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const settled = async (): Promise<KitchenLineReading[]> => {
      // Fonts and React's commit: two readings a frame apart agree.
      let last = '';
      for (let i = 0; i < 30; i++) {
        const now = JSON.stringify(await page.evaluate(() => window.__readKitchenLines!()));
        if (now === last) return JSON.parse(now) as KitchenLineReading[];
        last = now;
        await page.waitForTimeout(80);
      }
      return JSON.parse(last) as KitchenLineReading[];
    };
    return {
      page,
      async read(query, size) {
        await page.setViewportSize(size);
        // A fresh dev server can answer "504 Outdated Optimize Dep" while it
        // pre-bundles; a reload is what it asks for.
        for (let attempt = 1; ; attempt++) {
          errors.length = 0;
          await page.goto(`${url}?${query}`);
          try {
            await page.waitForFunction(
              () => !!window.__readKitchenLines && document.fonts.status === 'loaded' && document.documentElement.dataset.ready === '1',
              null,
              { timeout: 30_000 },
            );
            break;
          } catch (err) {
            if (attempt >= 5) throw new Error(`${(err as Error).message}; page errors: ${errors.join(' | ')}`);
          }
        }
        if (errors.length) throw new Error(`the page failed: ${errors.join(' | ')}`);
        return settled();
      },
      async close() {
        await page.close();
        await server.close();
      },
    };
  } catch (err) {
    await server.close();
    throw err;
  }
}
