import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const posRoot = path.resolve(here, '../../..');
export interface ConsentHarness { page: Page; open: (query?: string) => Promise<void>; close: () => Promise<void> }

/** Serve the actual dialog on an ephemeral loopback port, without an API,
 * service worker, camera, or dependency on a running development server. */
export async function startConsentHarness(): Promise<ConsentHarness> {
  const server = await createServer({
    configFile: false, root: posRoot,
    cacheDir: path.join(posRoot, 'node_modules/.vite-consent-harness'),
    logLevel: 'error', plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.join(posRoot, 'src') }, dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    optimizeDeps: { entries: [path.join(here, 'index.html')] },
  });
  let browser: Browser | undefined;
  try {
    await server.listen();
    for (const channel of ['msedge', 'chrome', undefined] as const) {
      try { browser = await chromium.launch(channel ? { channel } : {}); break; }
      catch { /* Try the next installed browser; absence is a failure, never a skip. */ }
    }
    if (!browser) throw new Error('Consent review requires Edge, Chrome or Playwright Chromium');
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const address = server.httpServer!.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/test/support/consent-harness/index.html`;
    return {
      page,
      async open(query = '') {
        // Vite can ask for a reload during its first dependency pre-bundle.
        for (let attempt = 0; ; attempt++) {
          await page.goto(`${url}${query}`);
          try { await page.getByRole('dialog').waitFor({ timeout: 10_000 }); return; }
          catch (error) { if (attempt === 2) throw error; }
        }
      },
      async close() { await browser!.close(); await server.close(); },
    };
  } catch (error) {
    await browser?.close(); await server.close(); throw error;
  }
}
