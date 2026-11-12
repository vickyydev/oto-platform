import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * SCRUM-893 / 894 / 943 — serves `index.html` beside this with the till's own
 * React and Tailwind set-up and its `@/` alias, on an ephemeral loopback port:
 * no API, service worker or running dev server (the `consent-line-harness`
 * pattern). A browser is the machine's own Edge or Chrome, or Playwright's
 * Chromium where installed; `harness` is null (and `why` says so) when there
 * is none. Each `open` takes a fresh touch page at the size asked for.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const posRoot = path.resolve(here, '../../..');

export interface FamilyFormHarness {
  /** Opens the form with the query given (see `main.ts`) at that size, and waits for it to draw. */
  open: (query: string, viewport: { width: number; height: number }) => Promise<Page>;
  close: () => Promise<void>;
}

async function launch(): Promise<{ browser: Browser | null; why: string }> {
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

export async function startFamilyFormHarness(): Promise<{ harness: FamilyFormHarness | null; why: string }> {
  const { browser, why } = await launch();
  if (!browser) return { harness: null, why };
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      configFile: false, root: posRoot,
      cacheDir: path.join(posRoot, 'node_modules/.vite-family-form-harness'),
      logLevel: 'error', plugins: [react(), tailwindcss()],
      resolve: { alias: { '@': path.join(posRoot, 'src') }, dedupe: ['react', 'react-dom'] },
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      optimizeDeps: { entries: [path.join(here, 'index.html')] },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/test/support/family-form-harness/index.html`;
    const running = server;
    let page: Page | null = null;
    return {
      why: '',
      harness: {
        async open(query, viewport) {
          await page?.close();
          page = await browser.newPage({ viewport, hasTouch: true });
          // Vite can ask for a reload during its first dependency pre-bundle.
          for (let attempt = 0; ; attempt++) {
            await page.goto(`${url}?${query}`);
            try { await page.locator('#ready').waitFor({ timeout: 20_000 }); return page; }
            catch (error) { if (attempt === 2) throw error; }
          }
        },
        async close() { await browser.close(); await running.close(); },
      },
    };
  } catch (error) {
    await browser.close(); await server?.close(); throw error;
  }
}
