import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Reading } from './measure';

/**
 * SCRUM-884 — serves the split view measurement page (`index.html` beside
 * this) with the till's own React and Tailwind set-up and its `@/` alias, on
 * an ephemeral loopback port, without an API, a service worker or a running
 * dev server, and opens it in the machine's Edge or Chrome (Playwright's
 * `channel`) or Playwright's Chromium. Its own config, not `vite.config.ts`,
 * for the reasons `header-harness/server.ts` gives.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const posRoot = path.resolve(here, '../../..');

export interface SplitViewHarness {
  page: Page;
  /** Opens one screen of the page at a window size and reads it. */
  read: (query: string, size: { width: number; height: number }) => Promise<Reading>;
  /** Presses controls by their visible text, in turn (a payment tile is a card, not a button), then reads again. */
  pressAndRead: (...names: string[]) => Promise<Reading>;
  close: () => Promise<void>;
}

export async function launchBrowser(): Promise<{ browser: Browser | null; why: string }> {
  const tried: string[] = [];
  for (const channel of ['msedge', 'chrome', undefined] as const) {
    try {
      return { browser: await chromium.launch(channel ? { channel } : {}), why: '' };
    } catch (err) {
      tried.push(`${channel ?? 'chromium'}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return { browser: null, why: tried.join('; ') };
}

export async function startSplitViewHarness(browser: Browser): Promise<SplitViewHarness> {
  const server: ViteDevServer = await createServer({
    configFile: false,
    root: posRoot,
    cacheDir: path.join(posRoot, 'node_modules/.vite-splitview-harness'),
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.join(posRoot, 'src') }, dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    optimizeDeps: { entries: [path.join(here, 'index.html')] },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo | null;
    if (!address) throw new Error('the split view measurement server did not start');
    const url = `http://127.0.0.1:${address.port}/test/support/splitview-harness/index.html`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const settled = async (): Promise<Reading> => {
      // Fonts, the stock read and React's commit: two readings a frame apart agree.
      let last = '';
      for (let i = 0; i < 30; i++) {
        const now = JSON.stringify(await page.evaluate(() => window.__readSplitView!()));
        if (now === last) return JSON.parse(now) as Reading;
        last = now;
        await page.waitForTimeout(80);
      }
      return JSON.parse(last) as Reading;
    };
    return {
      page,
      async read(query, size) {
        await page.setViewportSize(size);
        // The first load of a fresh dev server can be answered "504 Outdated
        // Optimize Dep" while Vite pre-bundles; a reload is what it asks for.
        for (let attempt = 1; ; attempt++) {
          await page.goto(`${url}?${query}`);
          try {
            await page.waitForFunction(
              () => !!window.__readSplitView && document.fonts.status === 'loaded' && document.documentElement.dataset.ready === '1',
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
      async pressAndRead(...names) {
        for (const name of names) {
          await page.getByText(name, { exact: true }).first().click();
          await settled();
        }
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
