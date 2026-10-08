import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startHeaderHarness, type HarnessServer } from './support/header-harness/server';
import type { ControlBox, HeaderReading } from './support/header-harness/measure';

/**
 * SCRUM-505 — THE TILL HEADER, MEASURED IN A BROWSER AT NINE WIDTHS.
 *
 * On an upright tablet (768-820px) the header drew the Cash button over the
 * park chip, squeezed the logo to a sliver and left the tab band 8px wide, so
 * no tab showed. The cause was the row itself: its two clusters were allowed
 * to shrink under their own content, and the actions cluster, aligned to the
 * end, spilled leftwards over the park chip. `StationHeader` now keeps each
 * cluster at its content width and wraps the row instead; its comment has the
 * three rules and the numbers.
 *
 * Unlike the rest of this runner, this file needs a layout engine, so it
 * brings one. `support/header-harness` serves a page that draws the header
 * `App` draws for a signed-in till at the window's width — the station
 * header from 768px, the phone shell below — from the till's own source, with
 * only the three contexts it reads and the platform's answers given rather
 * than fetched. The browser is the machine's own Edge or Chrome (Playwright's
 * `channel`), or Playwright's Chromium where installed; with none of them the
 * file is skipped and says so.
 *
 * At every width it reads the boxes the browser laid out — not class names —
 * and asserts:
 *  - no two header controls overlap, and none is drawn outside the window
 *    (from 768px; the phone bar is below);
 *  - the logo is drawn at its own width, not squeezed;
 *  - the tab band shows at least two whole tabs, every label on one line,
 *    and scrolls to the rest;
 *  - the park's name is whole on two lines from 768px (SCRUM-443) and on its
 *    one line in the phone bar.
 *
 * THE PHONE BAR'S OWN WIDTH, recorded rather than asserted: at 360 and 400px
 * the phone top bar (`MobileShell`, untouched here) is wider than the phone —
 * 501px with a live count and Som, 601px with staging's "no gate" and Khun
 * Anan — and the shell's `overflow-hidden` cuts its end off: the lock button
 * with Som; the settings button as well with staging's content, and at 360
 * the theme button too. Nothing overlaps. The prototype's own phone bar does
 * the same at both widths (its lock button lies past the edge), so it is a
 * rule of its own to make, not part of this fix.
 */

const WIDTHS = [360, 400, 768, 790, 820, 900, 1024, 1280, 1600] as const;
const PHONE_BELOW = 768;
const PARK = 'Oto Play Park, Central Floresta';

interface Variant {
  label: string;
  query: string;
  /** From xl (1280) up this content keeps the prototype's one 64px row. */
  oneRowFromXl: boolean;
}

const VARIANTS: Variant[] = [
  { label: "staging's own header (no gate reporting, Khun Anan)", query: '', oneRowFromXl: true },
  { label: 'a live gate and a short name (Som)', query: 'gate=live&operator=Som', oneRowFromXl: true },
  {
    label: 'everything long at once (a printer fault, a holiday, a stale gate)',
    query: 'printer=bad&pricing=holiday&gate=stale',
    oneRowFromXl: false,
  },
];

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

const { browser, why } = await launch();
if (!browser) console.warn(`SCRUM-505 header measurement skipped: no browser to lay the page out (${why})`);

/**
 * Opens the page. The first load of a fresh dev server can be answered "504
 * Outdated Optimize Dep" while Vite pre-bundles what it found on the way, and
 * a reload is what it asks for.
 */
async function open(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.goto(url);
    try {
      await page.waitForFunction(() => !!window.__readHeader && document.fonts.status === 'loaded', null, {
        timeout: 30_000,
      });
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
    }
  }
}

async function readAt(page: Page, width: number): Promise<HeaderReading> {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(
    (want) => document.documentElement.dataset.layout === want,
    width < PHONE_BELOW ? 'phone' : 'till',
  );
  // The occupancy chip, the pricing chip and the printer chip each answer from
  // a fetch; wait until two reads a frame apart agree.
  let last = '';
  for (let i = 0; i < 20; i++) {
    const now = JSON.stringify(await page.evaluate(() => window.__readHeader!()));
    if (now === last) return JSON.parse(now) as HeaderReading;
    last = now;
    await page.waitForTimeout(100);
  }
  return JSON.parse(last) as HeaderReading;
}

const named = (reading: HeaderReading, name: string): ControlBox | undefined =>
  reading.controls.find((c) => c.name === name);

describe.skipIf(!browser)('SCRUM-505 — the header at nine widths', () => {
  let server: HarnessServer;
  let page: Page;

  beforeAll(async () => {
    server = await startHeaderHarness();
    page = await browser!.newPage({ viewport: { width: 1600, height: 900 } });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  for (const variant of VARIANTS) {
    describe(variant.label, () => {
      const readings = new Map<number, HeaderReading>();

      beforeAll(async () => {
        await open(page, `${server.url}${variant.query ? `?${variant.query}` : ''}`);
        for (const width of WIDTHS) readings.set(width, await readAt(page, width));
      }, 180_000);

      for (const width of WIDTHS) {
        it(`${width}px`, () => {
          const r = readings.get(width)!;
          // Nothing is drawn over anything, at any width.
          expect(r.overlaps).toEqual([]);

          if (width < PHONE_BELOW) {
            // The phone shell's top bar: the park's name on its one line, as on main.
            expect(r.layout).toBe('phone');
            expect(r.chip.text).toBe(PARK);
            expect(r.chip.lines).toBe(1);
            expect(r.row.height).toBeCloseTo(56, 0);
            return;
          }

          expect(r.layout).toBe('till');
          expect(r.outside).toEqual([]);
          expect(r.row.scrollWidth).toBeLessThanOrEqual(r.row.width + 0.5);
          // The logo at its own width, not squeezed.
          expect(r.logo.width).toBeGreaterThanOrEqual(r.logo.natural - 0.5);
          // The park's name whole, on two lines (SCRUM-443).
          expect(r.chip.text).toBe(PARK);
          expect(r.chip.lines).toBe(2);
          expect(r.chip.clipped).toBe(false);
          // The Cash action is there, on screen, and not under anything.
          expect(named(r, 'Paid-out or safe drop')).toBeDefined();
          // The tab band: two whole tabs at least, every label on one line,
          // and the rest reachable by scrolling it.
          const nav = r.nav!;
          expect(nav.tabs).toBe(8);
          expect(nav.wholeTabsVisible).toBeGreaterThanOrEqual(2);
          expect(nav.rows).toBe(1);
          expect(nav.labelsWhole).toBe(true);
          if (nav.scrollWidth > nav.width + 0.5) expect(nav.overflowX).toBe('auto');

          const band = named(r, 'tab band')!;
          const logo = named(r, 'Oto home')!;
          if (width < 1024) {
            // An upright tablet: the tabs have a row of their own under the bar.
            expect(band.top).toBeGreaterThanOrEqual(logo.bottom);
          }
          if (width >= 1280 && variant.oneRowFromXl) {
            // The prototype's one 64px row, tabs between the clusters.
            expect(r.row.height).toBeCloseTo(64, 0);
            expect(band.left).toBeGreaterThan(logo.right);
          }
        });
      }
    });
  }
});
