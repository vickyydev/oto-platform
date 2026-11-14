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
  if (browser) {
    harness = await startSplitFixHarness(browser);
    // The recorded receipt is a weekday cart. Pin Date before its first navigation,
    // clear of the branch's 05:00 rollover, without freezing rendering/timeout timers.
    await harness.page.clock.setFixedTime(new Date('2026-11-12T05:00:00Z'));
  }
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

/**
 * The faults found, less those that are not cuts: a text in `except` (a
 * category scrolled past its row's edge), and a word that breaks after its
 * own hyphen ("Thai-" over "International"), as type set by hand does.
 */
const faultsOf = (reading: SplitFixReading, except: readonly string[] = []) =>
  reading.faults
    .filter((f) => !except.includes(f.text))
    .filter((f) => !(f.kind === 'brokenWord' && /^"[^"\s]+-[^"\s]+" is drawn on 2 lines$/.test(f.detail)))
    .map((f) => `${f.kind}: ${f.text} — ${f.detail}`);

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
      // The proof line is two text nodes: the proof's name, then the words.
      for (const text of ['ZZ TEST 884 Expat Verified Member', 'Tourist', 'Expat', 'Thai', 'Passport', '— no proof needed', 'Proof required — verify now']) {
        expect(r.textInView[text], `"${text}" on screen`).toBe(true);
      }
      // The verified card's proof line on one line beside its badge.
      expect(r.textLines['— no proof needed']).toBe(1);
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
      // The caption ("1 Hour", "•", the ticket's name) is not cut: no fault above
      // says so, and at 1440 it takes a second line rather than an ellipsis.
      if (size.width === 1440) expect(r.textLines['1 Hour Play']).toBe(2);
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
      // The band's code is the one word allowed to break: inside its own line.
      expect(faultsOf(r).filter((f) => !f.includes('"Z88401229PF69WPVWDEXKX7PTKWSVQEHH.G8F379S6EPK3M2Q"'))).toEqual([]);
      // (Its line starts with the check-in time, which is the machine's clock's: found by the code.)
      const codeLine = Object.entries(r.textLines).find(([text]) => text.includes('Z88401229PF69'));
      expect(codeLine?.[1], 'the code breaks inside its line').toBeGreaterThan(1);
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

/**
 * SCRUM-963 (points 7 and 8 of SCRUM-969) — THE ONE-ROW CATEGORIES WITH A
 * MOUSE. At 1440 in the split view a plain wheel did not move the row, only
 * Breakfast and Sides showed whole and nothing said the row went on (the
 * proof's 05a, 05b). In that state the wheel moves it sideways (and is the
 * page's again at the row's end), an arrow shows at each end while there is
 * more that way, and the chosen category comes into view. Full width wraps as
 * before: no arrow, no wheel taken.
 */
interface RowState { left: number; end: number; width: number; wraps: boolean; lastWhole: boolean; chosenWhole: boolean }
const rowState = (last: string) => harness.page.getByTestId('category-row').evaluate((row, lastName) => {
  const box = row.getBoundingClientRect();
  const whole = (el: Element | null | undefined) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.left >= box.left - 1 && r.right <= box.right + 1;
  };
  const buttons = Array.from(row.querySelectorAll('button'));
  return {
    left: Math.round(row.scrollLeft), end: row.scrollWidth - row.clientWidth, width: row.clientWidth,
    wraps: getComputedStyle(row).flexWrap !== 'nowrap',
    lastWhole: whole(buttons.find((b) => b.textContent?.trim() === lastName)),
    chosenWhole: whole(row.querySelector('[data-chosen="true"]')),
  };
}, last) as Promise<RowState>;
const arrows = async () => ({
  before: await harness.page.getByRole('button', { name: 'Earlier categories', exact: true }).count(),
  after: await harness.page.getByRole('button', { name: 'More categories', exact: true }).count(),
});
const wheelTaken = () => harness.page.evaluate(() => (window as unknown as { __lastWheelTaken?: boolean }).__lastWheelTaken ?? null);
/** Turns the wheel over the middle of the row, and waits for the row to settle. */
async function wheel(dx: number, dy: number) {
  const box = (await harness.page.getByTestId('category-row').boundingBox())!;
  await harness.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await harness.page.mouse.wheel(dx, dy);
  await harness.page.waitForTimeout(120);
}
/** Waits until the row stops moving (the arrows' and the chosen category's moves are smooth). */
async function settledRow(last: string): Promise<RowState> {
  let was = '';
  for (let i = 0; i < 40; i++) {
    const now = JSON.stringify(await rowState(last));
    if (now === was) break;
    was = now;
    await harness.page.waitForTimeout(100);
  }
  return JSON.parse(was) as RowState;
}

describe.skipIf(!browser || RECORD)('SCRUM-963 (9): the one-row categories move with a mouse in the split view', () => {
  for (const [screen, last] of [['fnb-menu', 'Beer'], ['merch-grid', 'Workshop']] as const) {
    it(`${screen} at 1440x900: the wheel moves the row and gives the page back at its ends`, async () => {
      await harness.read(`screen=${screen}&split=1`, { width: 1440, height: 900 });
      const start = await settledRow(last);
      expect(start.wraps).toBe(false);
      expect(start.left).toBe(0);
      expect(start.end, 'the row goes on past its width').toBeGreaterThan(0);
      expect(start.lastWhole).toBe(false);
      expect(await arrows()).toEqual({ before: 0, after: 1 });
      // At its start, a wheel up is the page's.
      await wheel(0, -120);
      expect(await wheelTaken()).toBe(false);
      expect((await rowState(last)).left).toBe(0);
      // A wheel down moves the row sideways, and the row takes it.
      await wheel(0, 120);
      expect(await wheelTaken()).toBe(true);
      const moved = await rowState(last);
      expect(moved.left).toBeGreaterThan(0);
      expect(await arrows()).toEqual({ before: 1, after: 1 });
      // The mouse alone reaches the last category.
      for (let i = 0; i < 40 && (await rowState(last)).left < (await rowState(last)).end - 1; i++) await wheel(0, 200);
      const end = await settledRow(last);
      expect(end.left).toBeGreaterThanOrEqual(end.end - 1);
      expect(end.lastWhole, `${last} whole in the row`).toBe(true);
      expect(await arrows()).toEqual({ before: 1, after: 0 });
      // At its end, a wheel down is the page's again.
      await wheel(0, 120);
      expect(await wheelTaken()).toBe(false);
      // A trackpad's sideways swipe is the browser's own, and still moves it.
      await wheel(-150, 0);
      expect(await wheelTaken()).toBe(false);
      expect((await settledRow(last)).left).toBeLessThan(end.left);
    }, 120_000);

    it(`${screen} at 1440x900: the arrows move it about a row's width, show and hide, and reach the last category`, async () => {
      await harness.read(`screen=${screen}&split=1`, { width: 1440, height: 900 });
      const start = await settledRow(last);
      let presses = 0;
      while ((await arrows()).after === 1 && presses < 30) {
        const was = (await settledRow(last)).left;
        await harness.page.getByRole('button', { name: 'More categories', exact: true }).click();
        presses += 1;
        const now = await settledRow(last);
        // About one row's width each time (less the arrows), or to the end.
        expect(now.left - was).toBeGreaterThanOrEqual(Math.min(start.width / 2, now.end - was) - 1);
      }
      const end = await settledRow(last);
      expect(end.left).toBeGreaterThanOrEqual(end.end - 1);
      expect(end.lastWhole).toBe(true);
      expect(await arrows()).toEqual({ before: 1, after: 0 });
      await harness.page.getByRole('button', { name: 'Earlier categories', exact: true }).click();
      expect((await settledRow(last)).left).toBeLessThan(end.left);
      expect(await arrows()).toEqual({ before: 1, after: 1 });
    }, 120_000);
  }

  it('fnb-menu at 1440x900: the chosen category comes back into view when the row returns after a search', async () => {
    await harness.read('screen=fnb-menu&split=1', { width: 1440, height: 900 });
    for (let i = 0; i < 40 && (await rowState('Beer')).left < (await rowState('Beer')).end - 1; i++) await wheel(0, 200);
    await harness.page.getByTestId('category-row').getByRole('button', { name: 'Beer', exact: true }).click();
    expect((await settledRow('Beer')).chosenWhole).toBe(true);
    // Back to the start with the wheel: the chosen Beer is out of view.
    for (let i = 0; i < 40 && (await rowState('Beer')).left > 0; i++) await wheel(0, -200);
    expect((await settledRow('Beer')).chosenWhole).toBe(false);
    // A search hides the row; clearing it brings it back, Beer in view.
    await harness.page.getByPlaceholder('Search dish…').fill('French');
    await expect.poll(() => harness.page.getByTestId('category-row').count()).toBe(0);
    await harness.page.getByPlaceholder('Search dish…').fill('');
    await harness.page.getByTestId('category-row').waitFor();
    expect((await settledRow('Beer')).chosenWhole).toBe(true);
  }, 120_000);

  it('full width at 1440x900: the categories wrap as before, with no arrows, and the wheel is the page’s', async () => {
    for (const screen of ['fnb-menu', 'merch-grid'] as const) {
      await harness.read(`screen=${screen}&split=0`, { width: 1440, height: 900 });
      const state = await settledRow('Beer');
      expect(state.wraps, screen).toBe(true);
      expect(state.end, screen).toBeLessThanOrEqual(0);
      expect(await arrows(), screen).toEqual({ before: 0, after: 0 });
      await wheel(0, 120);
      expect(await wheelTaken(), screen).toBe(false);
    }
  }, 120_000);
});

/**
 * SCRUM-975 (point 10) — THE ARROWS AT THE ROW'S OWN ENDS. In its one-row
 * state the row reaches 8 pixels past its column each side (`-mx-2 px-2`)
 * and the arrows stood at the column's ends, so a sliver of the next tile
 * showed outside each (the proof's 08b, 08sb2). They stand at the row's ends.
 */
describe.skipIf(!browser || RECORD)('SCRUM-975 (10): the category arrows sit at the row’s ends', () => {
  const ends = () => harness.page.getByTestId('category-row').evaluate((row) => {
    const box = row.getBoundingClientRect();
    const holder = row.parentElement!;
    const arrow = (name: string) => holder.querySelector(`button[aria-label="${name}"]`)?.getBoundingClientRect() ?? null;
    const before = arrow('Earlier categories');
    const after = arrow('More categories');
    return {
      row: [box.left, box.right],
      before: before ? [before.left, before.right] : null,
      after: after ? [after.left, after.right] : null,
    };
  });

  for (const [screen, last] of [['fnb-menu', 'Beer'], ['merch-grid', 'Workshop']] as const) {
    it(`${screen} at 1440x900: both arrows meet the row's ends, with no tile outside them`, async () => {
      await harness.read(`screen=${screen}&split=1`, { width: 1440, height: 900 });
      await settledRow(last);
      await wheel(0, 120);
      await settledRow(last);
      expect(await arrows()).toEqual({ before: 1, after: 1 });
      const seen = await ends();
      const detail = JSON.stringify(seen);
      expect(Math.abs(seen.before![0]! - seen.row[0]!), detail).toBeLessThanOrEqual(0.5);
      expect(Math.abs(seen.after![1]! - seen.row[1]!), detail).toBeLessThanOrEqual(0.5);
    }, 120_000);
  }
});
