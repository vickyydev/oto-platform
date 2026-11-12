import { chromium, type Browser, type Page } from '@playwright/test';
import { startHeaderHarness, type HarnessServer } from './header-harness/server';

/**
 * A browser page with the till's own stylesheet (Tailwind as the till builds
 * it, the Inter face, the light and dark tokens), for laying out a piece of
 * markup rendered by the real component and measuring it (SCRUM-880, 882).
 *
 * The page is the header measurement page (`header-harness`), which loads
 * `src/index.css`; the markup is placed in a box of a given width beside it.
 * `null` when no browser is installed, so a test can skip and say why.
 */
export interface MarkupPage {
  page: Page;
  /** Puts `html` in a box `width` px wide on the given theme; returns once laid out. */
  place: (html: string, width: number, theme?: 'light' | 'dark') => Promise<void>;
  close: () => Promise<void>;
}

export async function openMarkupPage(): Promise<{ markup: MarkupPage | null; why: string }> {
  const tried: string[] = [];
  let browser: Browser | null = null;
  for (const channel of ['msedge', 'chrome', undefined] as const) {
    try {
      browser = await chromium.launch(channel ? { channel } : {});
      break;
    } catch (err) {
      tried.push(`${channel ?? 'chromium'}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  if (!browser) return { markup: null, why: tried.join('; ') };
  const server: HarnessServer = await startHeaderHarness();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // A fresh dev server may ask for a reload while it pre-bundles.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(server.url, { timeout: 60_000 });
      await page.waitForFunction(() => !!window.__readHeader && document.fonts.status === 'loaded', null, { timeout: 30_000 });
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
    }
  }
  const place: MarkupPage['place'] = async (html, width, theme = 'light') => {
    await page.evaluate(
      ({ html, width, theme }) => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        document.documentElement.classList.toggle('light', theme === 'light');
        let box = document.getElementById('markup');
        if (!box) {
          box = document.createElement('div');
          box.id = 'markup';
          document.body.appendChild(box);
        }
        box.style.cssText = `width:${width}px;position:absolute;left:0;top:200px;`;
        box.innerHTML = html;
      },
      { html, width, theme },
    );
    await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => r(null)))));
  };
  return {
    markup: {
      page,
      place,
      close: async () => {
        await browser.close();
        await server.close();
      },
    },
    why: '',
  };
}
