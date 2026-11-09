import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * SCRUM-767 — serves `index.html` beside this with the till's own React and
 * Tailwind set-up and its `@/` alias, on an ephemeral loopback port: no API,
 * service worker, camera or running dev server. A browser is the machine's own
 * Edge or Chrome, or Playwright's Chromium where installed; `browser` is null
 * (and `why` says so) when there is none.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const posRoot = path.resolve(here, '../../..');

export interface ConsentLineHarness {
  page: Page;
  /** Opens one screen (`till`, `staff`, `staff-readonly`, `display`) and waits for it to draw. */
  open: (screen: string) => Promise<void>;
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

export async function startConsentLineHarness(): Promise<{ harness: ConsentLineHarness | null; why: string }> {
  const { browser, why } = await launch();
  if (!browser) return { harness: null, why };
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      configFile: false, root: posRoot,
      cacheDir: path.join(posRoot, 'node_modules/.vite-consent-line-harness'),
      logLevel: 'error', plugins: [react(), tailwindcss()],
      resolve: { alias: { '@': path.join(posRoot, 'src') }, dedupe: ['react', 'react-dom'] },
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      optimizeDeps: { entries: [path.join(here, 'index.html')] },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/test/support/consent-line-harness/index.html`;
    // The till's iPad, landscape: the consent screen is the right half.
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    const running = server;
    return {
      why: '',
      harness: {
        page,
        async open(screen) {
          // Vite can ask for a reload during its first dependency pre-bundle.
          for (let attempt = 0; ; attempt++) {
            await page.goto(`${url}?screen=${screen}`);
            try { await page.locator('#ready').waitFor({ timeout: 15_000 }); return; }
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
