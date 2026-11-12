import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { SplitFixReading } from './measure';

/**
 * SCRUM-959 — serves this folder's measurement page (`index.html`) the way
 * `../splitview-harness/server.ts` serves SCRUM-884's: the till's own React
 * and Tailwind set-up and its `@/` alias, on an ephemeral loopback port, with
 * no API, service worker or dev server behind it. Its own pre-bundle cache,
 * so it never shares one with the other harnesses.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const posRoot = path.resolve(here, '../../..');

export interface SplitFixHarness {
  page: Page;
  /** Opens one screen of the page at a window size and reads it. */
  read: (query: string, size: { width: number; height: number }) => Promise<SplitFixReading>;
  close: () => Promise<void>;
}

export async function startSplitFixHarness(browser: Browser): Promise<SplitFixHarness> {
  const server: ViteDevServer = await createServer({
    configFile: false,
    root: posRoot,
    cacheDir: path.join(posRoot, 'node_modules/.vite-splitfix-harness'),
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.join(posRoot, 'src') }, dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    optimizeDeps: { entries: [path.join(here, 'index.html')] },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo | null;
    if (!address) throw new Error('the SCRUM-959 measurement server did not start');
    const url = `http://127.0.0.1:${address.port}/test/support/splitfix-harness/index.html`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const settled = async (): Promise<SplitFixReading> => {
      // Fonts, the stock read and React's commit: two readings a frame apart agree.
      let last = '';
      for (let i = 0; i < 30; i++) {
        const now = JSON.stringify(await page.evaluate(() => window.__readSplitFix!()));
        if (now === last) return JSON.parse(now) as SplitFixReading;
        last = now;
        await page.waitForTimeout(80);
      }
      return JSON.parse(last) as SplitFixReading;
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
              () => !!window.__readSplitFix && document.fonts.status === 'loaded' && document.documentElement.dataset.ready === '1',
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
