import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './support/splitview-harness/server';
import { startSplitFixHarness, type SplitFixHarness } from './support/splitfix-harness/server';
import type { Box } from './support/splitview-harness/measure';
import type { SplitFixReading } from './support/splitfix-harness/measure';

/**
 * SCRUM-959 / SCRUM-960 — THE SPLIT VIEW AFTER ITS PROOF, MEASURED IN A BROWSER.
 *
 * Staging's proof of SCRUM-884 on 12 November (docs/qa/proof-2026-11-12/
 * SCRUM-884) found, in the split view at 1440x900 and 1680x1050: the Thai rate
 * card's last line below the window when the member's name takes two lines
 * (01b), the Membership Check's "Nickname" past its card (20b), "1 Hour • 1 H…"
 * on Payment Successful and "Credit Grants Issued" run into "1 TOTAL" (03d,
 * 06d), the F&B categories filling the column before any dish and dish tiles
 * 89px wide with the count badge on the name and the plus on the price (20c,
 * 14a), the Shop's the same with "Your Sale" under the language button (16a,
 * 16e); History's placeholder cut (14f); and on the phone's End of Day a long
 * band code widening the page past Close Day (17b).
 *
 * `support/splitfix-harness` draws each of those screens with the till's own
 * components in its page's frame (the frames' classes are pinned below against
 * the pages) and reads the boxes and line boxes the browser laid out. In the
 * split view: nothing clipped, no word broken, no label out of its button or
 * its card, no name under a badge or price under a plus, the named things on
 * screen. At full width (a separate customer display) every text and control
 * sits exactly where it sat before SCRUM-959 (`full-width-layout.json`,
 * recorded on the base commit), as SCRUM-884's pin does for its own screens.
 *
 * WHERE THE BOXES ARE EXACT. As in `s884-split-view-measured.test.ts`: the
 * fixture names the platform it was recorded on (Windows); elsewhere (CI's
 * Linux runner) the same texts and controls in the same order on as many lines
 * are pinned without the fonts, and the split-view checks are of relations
 * (inside, clear of, on screen), which do not depend on a face's exact width.
 *
 * The browser is the machine's Edge or Chrome, or Playwright's Chromium; with
 * none the file is skipped and says so. Re-record the full-width layout only
 * for a deliberate change to it, on Windows, from the commit before the
 * change: SPLITFIX_RECORD=1.
 */
const RECORD = process.env.SPLITFIX_RECORD === '1';
const SHOTS = process.env.SPLITFIX_SHOTS;
const FIXTURE = path.join(import.meta.dirname, 'support', 'splitfix-harness', 'full-width-layout.json');

const SPLIT_SIZES = [
  { width: 1440, height: 900 },
  { width: 1680, height: 1050 },
] as const;
const FULL_SIZES = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  ...SPLIT_SIZES,
] as const;
/** The screens drawn in a till frame, pinned at full width. */
const PINNED = ['tiers-two-line', 'identify', 'confirm', 'fnb-menu', 'fnb-search', 'merch-grid'] as const;
type Pinned = (typeof PINNED)[number];

const { browser, why } = await launchBrowser();
if (!browser) console.warn(`SCRUM-959 split view measurement skipped: no browser to lay the page out (${why})`);

interface Fixture {
  platform: NodeJS.Platform;
  layouts: Record<string, { key: string; box: Box }[]>;
  lines: Record<string, Record<string, number>>;
}
const recorded: Fixture = { platform: process.platform, layouts: {}, lines: {} };
const fixture: Fixture | null = existsSync(FIXTURE) && !RECORD ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture) : null;
const EXACT = fixture?.platform === process.platform;
if (browser && fixture && !EXACT) {
  console.warn(`SCRUM-959 full-width pin: boxes recorded on ${fixture.platform}, read on ${process.platform}: compared without the fonts`);
}

let harness: SplitFixHarness;
beforeAll(async () => {
  if (browser) harness = await startSplitFixHarness(browser);
}, 180_000);
afterAll(async () => {
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 1)}\n`);
  await harness?.close();
  await browser?.close();
});

/** Opens a screen; `fnb-search` is the F&B menu with "French" typed into its search. */
async function readScreen(screen: string, split: boolean, size: { width: number; height: number }): Promise<SplitFixReading> {
  const name = screen === 'fnb-search' ? 'fnb-menu' : screen;
  let reading = await harness.read(`screen=${name}&split=${split ? 1 : 0}`, size);
  if (screen === 'fnb-search') {
    await harness.page.getByPlaceholder('Search dish…').fill('French');
    reading = await settle();
  }
  if (SHOTS) {
    await harness.page.screenshot({ path: path.join(SHOTS, `${screen}@${size.width}${split ? '-split' : '-full'}.png`) });
  }
  return reading;
}

async function settle(): Promise<SplitFixReading> {
  let last = '';
  for (let i = 0; i < 30; i++) {
    const now = JSON.stringify(await harness.page.evaluate(() => window.__readSplitFix!()));
    if (now === last) break;
    last = now;
    await harness.page.waitForTimeout(80);
  }
  return JSON.parse(last) as SplitFixReading;
}

function pinLayout(id: string, reading: SplitFixReading): void {
  if (RECORD) {
    recorded.layouts[id] = reading.layout;
    recorded.lines[id] = reading.textLines;
    return;
  }
  const before = fixture?.layouts[id];
  expect(before, `a recorded layout for ${id}`).toBeDefined();
  expect(reading.layout.map((l) => l.key)).toEqual(before!.map((l) => l.key));
  expect(reading.textLines).toEqual(fixture!.lines[id]);
  if (!EXACT) return;
  const moved = reading.layout.flatMap((now, i) => {
    const was = before![i]!.box;
    const off = (['left', 'top', 'width', 'height'] as const).some((k) => Math.abs(now.box[k] - was[k]) > 0.5);
    return off ? [`${now.key}: ${JSON.stringify(was)} -> ${JSON.stringify(now.box)}`] : [];
  });
  expect(moved).toEqual([]);
}

const faultsOf = (reading: SplitFixReading, except: readonly string[] = []) =>
  reading.faults.filter((f) => !except.includes(f.text)).map((f) => `${f.kind}: ${f.text} — ${f.detail}`);

/** The tiles whose name, badge, price or plus are not where they belong. */
const badTiles = (reading: SplitFixReading) =>
  reading.tiles
    .filter((t) => !t.nameInside || !t.nameClearOfBadge || !t.priceClearOfPlus || !t.plusInside)
    .map((t) => `${t.name} (${t.width}px): inside ${t.nameInside}, clear of badge ${t.nameClearOfBadge}, price clear of plus ${t.priceClearOfPlus}, plus inside ${t.plusInside}`);

/** Staging's F&B categories and the Shop's: a scrolling row cuts the ones scrolled past its edge. */
const CATEGORY_LABELS = [
  'Breakfast', 'Sides', 'Sharing', 'Soup', 'Salads', 'Pasta', 'Pizza', 'Mains', 'Asian Food', 'Kids', 'Desserts',
  'Coffee', 'Iced Coffee', 'Chocolate', 'Soda', 'Smoothies', 'Juice', 'Tea pot', 'Soft drinks', 'Kids juice', 'Wine', 'Beer',
  'All', 'Tickets & passes', 'Balloons', 'Merchandise', 'Workshop',
];

describe.skipIf(!browser || RECORD)('SCRUM-959 in the split view: every label whole, inside its box, and on screen', () => {
  for (const size of SPLIT_SIZES) {
    const at = `${size.width}x${size.height}`;

    it(`(1) a two-line member name leaves all three rate cards whole on screen, ${at}`, async () => {
      const r = await readScreen('tiers-two-line', true, size);
      expect(r.region.width).toBe(size.width / 2 - 362);
      expect(faultsOf(r)).toEqual([]);
      if (size.width === 1440) expect(r.textLines['ZZ TEST 884 Expat Verified Member'], 'the name takes two lines, as on staging').toBe(2);
      for (const text of ['ZZ TEST 884 Expat Verified Member', 'Tourist', 'Expat', 'Thai', 'Passport — no proof needed', 'Proof required — verify now']) {
        expect(r.textInView[text], `"${text}" on screen`).toBe(true);
      }
      // The verified card's proof line on one line beside its badge.
      expect(r.textLines['Passport — no proof needed']).toBe(1);
    }, 120_000);

    it(`(3) the Membership Check's Phone and Nickname inside their cards, ${at}`, async () => {
      const r = await readScreen('identify', true, size);
      expect(faultsOf(r)).toEqual([]);
      expect(r.outsideCard).toEqual([]);
      expect(r.textLines['Nickname']).toBe(1);
    }, 120_000);

    it(`(5) Payment Successful: the captions whole, each heading clear of its count, ${at}`, async () => {
      const r = await readScreen('confirm', true, size);
      expect(faultsOf(r)).toEqual([]);
      expect(r.headingGaps.map((g) => g.heading)).toEqual(['Bracelets to Print', 'Credit Grants Issued']);
      for (const g of r.headingGaps) expect(g.gap, `"${g.heading}" and "${g.count}"`).toBeGreaterThanOrEqual(8);
      expect(r.textInView['1 Hour • 1 Hour Play']).toBe(true);
    }, 120_000);

    it(`(6) F&B: one row of categories, dishes on screen, every name clear of its badge and price of its plus, ${at}`, async () => {
      const r = await readScreen('fnb-menu', true, size);
      expect(faultsOf(r, CATEGORY_LABELS)).toEqual([]);
      expect(r.categoryRows).toBe(1);
      expect(r.tiles.length).toBe(5);
      expect(badTiles(r)).toEqual([]);
      expect(r.tiles[0]!.inView, 'the first dish on screen').toBe(true);
      expect(r.tiles.find((t) => t.name === 'Pancakes')).toBeDefined();
    }, 120_000);

    it(`(6) F&B search results: every name clear of its badge and price of its plus, ${at}`, async () => {
      const r = await readScreen('fnb-search', true, size);
      expect(faultsOf(r)).toEqual([]);
      expect(r.tiles.map((t) => t.name)).toEqual(['French fries']);
      expect(badTiles(r)).toEqual([]);
    }, 120_000);

    it(`(7) the Shop: one row of categories, every name whole, the plus inside its tile, ${at}`, async () => {
      const r = await readScreen('merch-grid', true, size);
      expect(faultsOf(r, CATEGORY_LABELS)).toEqual([]);
      expect(r.categoryRows).toBe(1);
      expect(r.tiles.length).toBe(10);
      expect(badTiles(r)).toEqual([]);
      expect(r.tiles[0]!.inView).toBe(true);
    }, 120_000);

    it(`(7) the Shop's customer half: "Your Sale" clear of the language button, ${at}`, async () => {
      const r = await readScreen('merch-display', true, size);
      expect(r.textInView['Your Sale']).toBe(true);
      expect(r.underLanguage).toEqual([]);
    }, 120_000);
  }

  for (const size of FULL_SIZES) {
    it(`(8) History's placeholder reads whole, ${size.width}x${size.height}`, async () => {
      const r = await readScreen('history-search', false, size);
      expect(r.placeholders.length).toBe(1);
      const [p] = r.placeholders;
      expect(p!.needs, `"${p!.text}" needs ${p!.needs}px of ${p!.room}px`).toBeLessThanOrEqual(p!.room);
    }, 120_000);
  }

  for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    it(`SCRUM-960 (3) the phone's End of Day stays the phone's width with a long band code, ${size.width}x${size.height}`, async () => {
      const r = await readScreen('stranded', false, size);
      expect(r.page.scrollWidth).toBeLessThanOrEqual(r.page.innerWidth);
      expect(r.rightmost).toBeLessThanOrEqual(size.width);
      for (const name of ['Left without scanning', 'Band lost', 'Gate fault', 'Close Day']) {
        const control = r.controls.find((c) => c.name === name);
        expect(control?.box.right, `${name} inside the window`).toBeLessThanOrEqual(size.width - 16);
      }
      expect(faultsOf(r)).toEqual([]);
    }, 120_000);
  }
});

describe.skipIf(!browser)('full width (a separate customer display): the layout is exactly as before', () => {
  for (const size of FULL_SIZES) {
    for (const screen of PINNED) {
      const id = `${screen}@${size.width}x${size.height}`;
      it(id, async () => {
        const reading = await readScreen(screen as Pinned, false, size);
        pinLayout(id, reading);
      }, 120_000);
    }
  }
});

describe("the harness draws each page's own frame", () => {
  // If a page's frame changes, the measurement above is of the wrong frame:
  // this fails first, and the harness is brought back in line.
  const source = (...rel: string[]) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', ...rel), 'utf8');
  const harnessPage = readFileSync(path.join(import.meta.dirname, 'support', 'splitfix-harness', 'main.ts'), 'utf8');
  // [page, its path, the class, whether the harness draws it too]
  const pins: [string, string[], string, boolean?][] = [
    ['pages/Till.tsx', ['pages', 'Till.tsx'], 'flex-1 overflow-hidden relative p-6'],
    ['pages/Till.tsx', ['pages', 'Till.tsx'], 'w-[360px] min-w-0 bg-sidebar flex flex-col p-6 overflow-y-auto'],
    ['pages/Till.tsx', ['pages', 'Till.tsx'], 'flex h-full min-h-0 flex-col'],
    ['pages/Till.tsx', ['pages', 'Till.tsx'], "'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0"],
    ['pages/OrderStation.tsx', ['pages', 'OrderStation.tsx'], 'flex-1 min-w-0 flex flex-col p-6 border-r bg-card/20'],
    ['pages/OrderStation.tsx', ['pages', 'OrderStation.tsx'], 'w-[380px] shrink-0 bg-sidebar p-6 overflow-y-auto'],
    ['pages/OrderStation.tsx', ['pages', 'OrderStation.tsx'], 'h-full w-full flex flex-col bg-background text-foreground overflow-hidden'],
    // The Shop's desk column is the F&B one's classes in another order: the harness draws it once.
    ['pages/MerchStation.tsx', ['pages', 'MerchStation.tsx'], 'min-w-0 flex flex-col bg-card/20', false],
    ['pages/MerchStation.tsx', ['pages', 'MerchStation.tsx'], "'flex-1 p-6 border-r'", false],
    ['pages/MerchStation.tsx', ['pages', 'MerchStation.tsx'], "'w-[380px] p-6 overflow-y-auto'", false],
    ['pages/History.tsx', ['pages', 'History.tsx'], 'mx-auto h-full max-w-5xl flex flex-col min-h-0'],
    ['pages/History.tsx', ['pages', 'History.tsx'], 'shrink-0 mb-4 flex items-center gap-3'],
    ['pages/History.tsx', ['pages', 'History.tsx'], 'w-full h-12 pl-12 pr-12 placeholder-shown:pr-4 rounded-xl bg-muted/50 border border-border text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40'],
    ['pages/History.tsx', ['pages', 'History.tsx'], 'h-12 pl-9 pr-3 rounded-xl bg-muted/50 border border-border text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40'],
    ['MobileTodayPage', ['components', 'mobile', 'today', 'MobileTodayPage.tsx'], 'flex-1 min-h-0'],
    ['MobileEndOfDayTab', ['components', 'mobile', 'today', 'MobileEndOfDayTab.tsx'], 'space-y-3 pb-4'],
  ];
  for (const [file, rel, cls, drawn = true] of pins) {
    it(`${file}: ${cls}`, () => {
      expect(source(...rel)).toContain(cls);
      if (drawn) expect(harnessPage).toContain(cls);
    });
  }
});
