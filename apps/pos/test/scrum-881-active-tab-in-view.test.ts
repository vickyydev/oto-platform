import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startHeaderHarness, type HarnessServer } from './support/header-harness/server';
import type { HeaderReading } from './support/header-harness/measure';

/**
 * SCRUM-881 — THE TAB OF THE SURFACE THE TILL IS ON KEEPS ITS FULL NAME.
 *
 * On the Check-in board with one print job waiting, staging's header at 1680px
 * read "Check": the printer chip had taken its width out of the tab band, the
 * band was left scrolled at its start, and its edge fell through the fifth tab
 * — the one the till was on.
 *
 * The header's rule for a row that runs out is unchanged (`StationHeader`,
 * SCRUM-505): the clusters keep their content width and the tab band scrolls.
 * A scrolling band always ends part-way through some tab; what it must not do
 * is end part-way through the active one. So the band now scrolls to the
 * active tab, and again whenever its own width changes (the printer chip
 * arrives after its first read; a window is resized).
 *
 * Measured in a browser on the header measurement page (`support/header-harness`,
 * as `scrum-505-header-widths.test.ts` does), from the narrowest desktop till
 * (768px, where the station header takes over from the phone shell) to 1920px:
 * for every surface, the active tab's whole box is inside the band. The widths
 * between are the header's own breakpoints (lg 1024, xl 1280, 2xl 1536) and
 * the proof's 1680.
 *
 * `HEADER_SHOTS` names a folder to keep a picture of the header in, per width.
 */

const WIDTHS = [768, 1024, 1280, 1536, 1680, 1920] as const;
const SHOTS = process.env.HEADER_SHOTS ?? '';
const SHOT_TAG = process.env.HEADER_SHOTS_TAG ?? 'after';

/** The eight surfaces, by the header's own key and the tab's words. */
const SURFACES = [
  ['tickets', 'Tickets'],
  ['fnb', 'F&B'],
  ['merch', 'Shop'],
  ['parties', 'Events'],
  ['dropoff', 'Check-in'],
  ['history', 'History'],
  ['today', 'Today'],
  ['messages', 'Messages'],
] as const;

/** Staging's own header on the day: a long account name and station name beside the chip. */
const STAGING = 'operator=ZZ%20TEST%20SCRUM-863%20staff&station=ZZ%20TEST%20SCRUM-863%20till';

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
if (!browser) console.warn(`SCRUM-881 header measurement skipped: no browser to lay the page out (${why})`);

/** Opens the page; a fresh dev server may ask for a reload while it pre-bundles. */
async function open(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { timeout: 60_000 });
      await page.waitForFunction(() => !!window.__readHeader && document.fonts.status === 'loaded', null, {
        timeout: 30_000,
      });
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
    }
  }
}

/** The header at this width, once it has settled (the chips answer from a fetch). */
async function readAt(page: Page, width: number): Promise<HeaderReading> {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(() => document.documentElement.dataset.layout === 'till');
  let last = '';
  // Three reads in a row alike, 250ms apart: a freshly opened page settles
  // its chips and labels over a few hundred milliseconds, and the band
  // follows each change a frame later.
  let same = 0;
  for (let i = 0; i < 40; i++) {
    const now = JSON.stringify(await page.evaluate(() => window.__readHeader!()));
    same = now === last ? same + 1 : 0;
    if (same === 2) return JSON.parse(now) as HeaderReading;
    last = now;
    await page.waitForTimeout(250);
  }
  return JSON.parse(last) as HeaderReading;
}

async function picture(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  const { width } = page.viewportSize()!;
  await page.screenshot({ path: path.resolve(SHOTS, `${name}.png`), clip: { x: 0, y: 0, width, height: 140 } });
}

describe.skipIf(!browser)('SCRUM-881 — the active tab is whole in the band', () => {
  let server: HarnessServer;
  let page: Page;

  beforeAll(async () => {
    server = await startHeaderHarness();
    page = await browser!.newPage({ viewport: { width: 1680, height: 900 } });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  describe('the proof’s own case: the Check-in board, one job waiting, staging’s long names', () => {
    for (const theme of ['light', 'dark'] as const) {
      it(`reads "Check-in" whole at every width (${theme})`, async () => {
        await open(page, `${server.url}?active=dropoff&printer=waiting&theme=${theme}&${STAGING}`);
        for (const width of WIDTHS) {
          const r = await readAt(page, width);
          await picture(page, `881-${SHOT_TAG}-${theme}-${width}`);
          const nav = r.nav!;
          expect(nav.active?.label, `${width}px`).toBe('Check-in');
          expect(nav.active?.whole, `${width}px: the Check-in tab is cut by the band's edge`).toBe(true);
          // The chip is there and nothing is drawn over anything: the header's own rules still hold.
          expect(r.controls.some((c) => c.name.startsWith('Printers: 1 job waiting')), `${width}px`).toBe(true);
          expect(r.overlaps, `${width}px`).toEqual([]);
          expect(nav.rows).toBe(1);
          expect(nav.labelsWhole).toBe(true);
        }
      }, 120_000);
    }
  });

  describe('every surface, with a job waiting and with a printer fault', () => {
    for (const printer of ['waiting', 'bad'] as const) {
      for (const [surface, label] of SURFACES) {
        it(`${label} (${printer})`, async () => {
          await open(page, `${server.url}?active=${surface}&printer=${printer}&${STAGING}`);
          for (const width of WIDTHS) {
            const nav = (await readAt(page, width)).nav!;
            expect(nav.active?.label.endsWith(label), `${width}px`).toBe(true);
            expect(nav.active?.whole, `${width}px: the ${label} tab is cut by the band's edge`).toBe(true);
          }
        }, 120_000);
      }
    }
  });

  it('the first tab leaves the band where it starts: nothing scrolls for the Tickets till', async () => {
    await open(page, `${server.url}?active=tickets&printer=waiting&${STAGING}`);
    for (const width of WIDTHS) {
      const nav = (await readAt(page, width)).nav!;
      expect(nav.active?.scrollLeft, `${width}px`).toBe(0);
    }
  }, 120_000);

  it('follows the band when the window narrows and widens again', async () => {
    await open(page, `${server.url}?active=history&printer=waiting&${STAGING}`);
    for (const width of [1920, 1024, 768, 1280, 1680]) {
      const nav = (await readAt(page, width)).nav!;
      expect(nav.active?.whole, `${width}px`).toBe(true);
    }
  }, 120_000);
});
