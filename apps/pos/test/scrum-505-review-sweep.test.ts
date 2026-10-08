import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startHeaderHarness, type HarnessServer } from './support/header-harness/server';
import type { HeaderReading } from './support/header-harness/measure';

/**
 * SCRUM-505 review — THE HEADER AT THE WIDTHS REAL DEVICES HAVE, WITH THE
 * CONTENT THE FIRST TEST DID NOT DRAW.
 *
 * `scrum-505-header-widths.test.ts` measures nine widths with three sets of
 * content. The review swept 360-1600px in 20px steps with fourteen sets and
 * found nothing drawn over anything on the fixed header; this file keeps the
 * part of that sweep the first test does not already hold:
 *  - the widths where the header changes shape (1023/1024 for the tab row,
 *    1279/1280 for the labels, 1535/1536 for the station name) and the widths
 *    of the tablets the till runs on (820 upright, 1112 and 1194 landscape,
 *    1366);
 *  - content the first test does not draw: a short park name, a long
 *    nickname beside a stale gate, a printer low on paper, a single park
 *    with no Cash action, and a long full name with every chip at its
 *    longest;
 *  - text drawn over text, read from the line boxes the browser laid out and
 *    clipped where an ancestor clips them, which the control boxes alone do
 *    not show;
 *  - from 1280px up, the prototype's labels are on screen ("Cash", "in park",
 *    the pricing words), so the fix changes nothing visible there.
 *
 * Same page and server as the first test (`support/header-harness`), same
 * browser search; skipped, with a warning, where no browser can be started.
 */

const WIDTHS = [768, 820, 896, 960, 1023, 1024, 1112, 1194, 1279, 1280, 1366, 1440, 1535, 1536, 1600] as const;

interface Variant {
  label: string;
  query: string;
  /** The park's name fits one line: the chip may use one line or two. */
  shortPark?: boolean;
  /** No account permission for a paid-out: the Cash button is not drawn. */
  noCash?: boolean;
  /** Usual content: from 1280 up the header is the prototype's one 64px row. */
  oneRowFromXl?: boolean;
}

const VARIANTS: Variant[] = [
  { label: 'a short park name, Som, a live gate', query: 'park=HKT%20Central&gate=live&operator=Som', shortPark: true, oneRowFromXl: true },
  { label: 'a long nickname beside a stale gate', query: 'operator=Khun%20Siriporn&gate=stale' },
  { label: 'a printer low on paper', query: 'printer=low&gate=live&operator=Som' },
  { label: 'one park, no Cash action', query: 'parks=one&cash=no&gate=live&operator=Som', noCash: true, oneRowFromXl: true },
  {
    label: 'a long full name with every chip at its longest',
    query: 'operator=Siriporn%20Wattanakulchai&printer=bad&pricing=holiday&gate=stale',
  },
];

/**
 * Runs in the page, as a string so no compiler helper rides along into it:
 * every text run's line boxes in the header row, clipped to any ancestor that
 * clips them, and the pairs of runs from different elements that share more
 * than a pixel each way. A scrolled-away tab is clipped by the band and drops
 * out; a label drawn over a chip does not.
 */
const TEXT_OVERLAPS = `(() => {
  const row = document.querySelector('#till > div');
  if (!row) return ['no till header row'];
  const runs = [];
  for (const el of Array.from(row.querySelectorAll('*'))) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    let x1 = -Infinity, x2 = Infinity, y1 = -Infinity, y2 = Infinity;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const as = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      if (as.overflowX !== 'visible') { x1 = Math.max(x1, ar.left); x2 = Math.min(x2, ar.right); }
      if (as.overflowY !== 'visible') { y1 = Math.max(y1, ar.top); y2 = Math.min(y2, ar.bottom); }
    }
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== 3 || !(n.textContent || '').trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const q of Array.from(range.getClientRects())) {
        const r = { l: Math.max(q.left, x1), r: Math.min(q.right, x2), t: Math.max(q.top, y1), b: Math.min(q.bottom, y2) };
        if (r.r - r.l > 0 && r.b - r.t > 0) runs.push({ el, text: n.textContent.trim().slice(0, 30), r });
      }
    }
  }
  const out = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.el === b.el) continue;
    const x = Math.min(a.r.r, b.r.r) - Math.max(a.r.l, b.r.l);
    const y = Math.min(a.r.b, b.r.b) - Math.max(a.r.t, b.r.t);
    if (x > 1 && y > 1) out.push(a.text + ' / ' + b.text);
  }
  return out;
})()`;

/** Which of the prototype's labels are on screen in the header row. */
const LABELS_SHOWN = `(() => {
  const row = document.querySelector('#till > div');
  const shown = (pred) => Array.from(row.querySelectorAll('span, button')).some((el) => {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (!pred(own)) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  });
  return {
    cash: shown((t) => t === 'Cash'),
    inPark: shown((t) => t === 'in park'),
    pricing: shown((t) => /pricing/i.test(t)),
  };
})()`;

interface Reading {
  header: HeaderReading;
  textOverlaps: string[];
  labels: { cash: boolean; inPark: boolean; pricing: boolean };
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

const { browser, why } = await launch();
if (!browser) console.warn(`SCRUM-505 review sweep skipped: no browser to lay the page out (${why})`);

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

async function readAt(page: Page, width: number): Promise<Reading> {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(() => document.documentElement.dataset.layout === 'till');
  let last = '';
  for (let i = 0; i < 20; i++) {
    const now = JSON.stringify({
      header: await page.evaluate(() => window.__readHeader!()),
      textOverlaps: await page.evaluate(TEXT_OVERLAPS),
      labels: await page.evaluate(LABELS_SHOWN),
    });
    if (now === last) return JSON.parse(now) as Reading;
    last = now;
    await page.waitForTimeout(100);
  }
  return JSON.parse(last) as Reading;
}

describe.skipIf(!browser)('SCRUM-505 review — the header at the widths that change its shape', () => {
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
      const readings = new Map<number, Reading>();

      beforeAll(async () => {
        await open(page, `${server.url}?${variant.query}`);
        for (const width of WIDTHS) readings.set(width, await readAt(page, width));
      }, 180_000);

      for (const width of WIDTHS) {
        it(`${width}px`, () => {
          const { header: r, textOverlaps, labels } = readings.get(width)!;
          expect(r.layout).toBe('till');
          // Nothing drawn over anything: no control over a control, no text over text.
          expect(r.overlaps).toEqual([]);
          expect(textOverlaps).toEqual([]);
          // Nothing pushed off the window, and the row never scrolls sideways.
          expect(r.outside).toEqual([]);
          expect(r.row.scrollWidth).toBeLessThanOrEqual(r.row.width + 0.5);
          // The logo at its own width.
          expect(r.logo.width).toBeGreaterThanOrEqual(r.logo.natural - 0.5);
          // The park's name whole: two lines for the long names (SCRUM-443),
          // one or two for a short one, never cut.
          expect(r.chip.clipped).toBe(false);
          if (variant.shortPark) expect(r.chip.lines).toBeLessThanOrEqual(2);
          else expect(r.chip.lines).toBe(2);
          // Two whole tabs at least, each label on one line, the rest a scroll away.
          const nav = r.nav!;
          expect(nav.wholeTabsVisible).toBeGreaterThanOrEqual(2);
          expect(nav.rows).toBe(1);
          expect(nav.labelsWhole).toBe(true);
          if (nav.scrollWidth > nav.width + 0.5) expect(nav.overflowX).toBe('auto');
          // The Cash action is drawn exactly when the account may use it.
          expect(r.controls.some((c) => c.name === 'Paid-out or safe drop')).toBe(!variant.noCash);

          const band = r.controls.find((c) => c.name === 'tab band')!;
          const logo = r.controls.find((c) => c.name === 'Oto home')!;
          if (width < 1024) expect(band.top).toBeGreaterThanOrEqual(logo.bottom);
          else expect(band.top).toBeLessThan(logo.bottom);

          if (width >= 1280) {
            // The prototype's labels, as it drew them from 1280 up.
            expect(labels).toEqual({ cash: !variant.noCash, inPark: true, pricing: true });
            if (variant.oneRowFromXl) expect(r.row.height).toBeCloseTo(64, 0);
          }
        });
      }
    });
  }
});
