import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './support/splitview-harness/server';
import { startSplitFixHarness, type SplitFixHarness } from './support/splitfix-harness/server';
import { GROUPED_MENU, groupedDishes, LONG_SUB_NAME, withLongName, type SubRowsReading } from './support/splitfix-harness/sub-rows';

/**
 * SCRUM-994 — THE F&B SUB-CATEGORIES IN ALIGNED ROWS, MEASURED IN A BROWSER.
 *
 * On 13 November the owner sent a picture of the staging till: the tabs Food,
 * Drinks and Special, and under Drinks the sub-categories Coffee, Iced
 * Coffee, Chocolate, … on ONE row with a sideways scrollbar, "Tea po…" cut at
 * its edge. His words: "scroll is not good here. it can slow the process. show
 * all of them in rows. with aligned clean elegant UI and staff experience".
 * The prototype draws the same scrolling row; this is a deliberate change from
 * it on his word (`components/fnb/MenuGrid.tsx`, SUB_CATEGORY_GRID).
 *
 * `support/splitfix-harness` draws staging's grouping (`GROUPED_MENU`) with the
 * till's own `MenuGrid`: in the desk's order stage beside the customer half
 * (the split view at 1440 and 1680), at full width (1024, 1280, 1440), and in
 * the phone till's frame (360x740, 390x844). On the Drinks tab (twelve
 * sub-categories) and the Food tab (ten), the reading says: nothing between a
 * chip and the menu column scrolls sideways or clips; every chip is inside the
 * column and on screen; all have one width and one height; every chip's left
 * edge is on one of the first row's column lines, and the columns are as many
 * as the column's width gives; no label is cut, and none takes more than two
 * lines; the dishes still start on screen; a press on the last chip shows its
 * dishes and marks it pressed.
 *
 * A name as long as the platform takes (40 characters, `long=1`) needs more
 * than two lines in a narrow column: its row grows to hold it, its label stays
 * inside its chip, no row runs over the next and the columns stay aligned.
 *
 * On a short screen, with the staff banners of a scanned band above the menu
 * (the allergy alert, "Food not authorized", the prepaid entitlements) on the
 * phones and in a 1366x768 split view, the rows hold and the first dishes,
 * the last chip and its dishes are on screen or come on screen when the menu
 * is scrolled up and down, as staff would.
 *
 * FONT-INDEPENDENT, as `s884` and `s959` keep their split-view checks: these
 * are relations (inside, equal, on a line, fits), and the column counts come
 * from the frames' widths alone, so CI's Linux runner reads what Windows reads.
 *
 * The browser is the machine's Edge or Chrome, or Playwright's Chromium; with
 * none the file is skipped and says so. SPLITFIX_SHOTS=<folder> saves pictures
 * of the Drinks tab, light and dark.
 */
const SHOTS = process.env.SPLITFIX_SHOTS;

interface Frame {
  name: string;
  query: string;
  size: { width: number; height: number };
  /** The columns the menu column's width gives (`repeat(auto-fill, minmax(…, 1fr))`). */
  columns: number;
}

/** The frames, and the columns each one's menu column gives: 290px (split 1440), 410px, 595px, 851px, 1011px, 328px, 358px. */
const FRAMES: Frame[] = [
  { name: 'split', query: 'split=1', size: { width: 1440, height: 900 }, columns: 3 },
  { name: 'split', query: 'split=1', size: { width: 1680, height: 1050 }, columns: 4 },
  { name: 'full', query: 'split=0', size: { width: 1024, height: 768 }, columns: 5 },
  { name: 'full', query: 'split=0', size: { width: 1280, height: 800 }, columns: 7 },
  { name: 'full', query: 'split=0', size: { width: 1440, height: 900 }, columns: 8 },
  { name: 'phone', query: 'frame=phone', size: { width: 360, height: 740 }, columns: 3 },
  { name: 'phone', query: 'frame=phone', size: { width: 390, height: 844 }, columns: 3 },
];
const TABS = ['Drinks', 'Food'] as const;

/**
 * Short screens, once a band is scanned: the staff banners above the menu
 * (`banners=`) on the phones and in a 1366x768 split view, whose 255px menu
 * column gives two columns, so twelve chips stand in six rows.
 */
const SHORT_FRAMES: Frame[] = [
  { name: 'phone', query: 'frame=phone', size: { width: 360, height: 740 }, columns: 3 },
  { name: 'phone', query: 'frame=phone', size: { width: 390, height: 844 }, columns: 3 },
  { name: 'split', query: 'split=1', size: { width: 1366, height: 768 }, columns: 2 },
];
const BANNER_SETS = ['allergy', 'allergy,noauth', 'allergy,prepaid'] as const;

const { browser, why } = await launchBrowser();
if (!browser) console.warn(`SCRUM-994 sub-category rows measurement skipped: no browser to lay the page out (${why})`);

let harness: SplitFixHarness;
beforeAll(async () => {
  if (browser) harness = await startSplitFixHarness(browser);
}, 180_000);
afterAll(async () => {
  await harness?.close();
  await browser?.close();
});

/** Reads the chips until two readings a frame apart agree (fonts, and a press's scale settling back). */
async function readRows(names: string[]): Promise<SubRowsReading> {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = JSON.stringify(await harness.page.evaluate((n) => window.__readSubRows!(n), names));
    if (now === last) break;
    last = now;
    await harness.page.waitForTimeout(80);
  }
  return JSON.parse(last) as SubRowsReading;
}

/**
 * Opens the grouped menu in a frame, on a tab (Food is the first, chosen when
 * the menu opens). `extra` adds to the page's query (`&theme=dark`, `&long=1`).
 */
async function open(frame: Frame, tab: (typeof TABS)[number], extra = '', names = GROUPED_MENU[tab]!): Promise<SubRowsReading> {
  await harness.read(`screen=fnb-menu-grouped&${frame.query}${extra}`, frame.size);
  if (tab !== 'Food') {
    await harness.page.getByTestId('category-row').getByRole('button', { name: tab, exact: true }).click({ timeout: 10_000 });
  }
  return readRows(names);
}

const at = (frame: Frame) => `${frame.name} ${frame.size.width}x${frame.size.height}`;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/** The first row of dish tiles not whole on screen (all of it with no dish). */
const firstDishesCut = (r: SubRowsReading): string[] =>
  r.tiles.length === 0 ? ['no dish'] : r.tiles.filter((t) => near(t.top, r.tiles[0]!.top) && !t.inView).map((t) => t.name);

/**
 * Under the staff banners on a short phone, the first row of dish tiles
 * neither whole on screen nor showing as much of itself as a dish whose name
 * takes one line (the tile's own `min-height`): a dish whose name takes three
 * lines is taller than all the room the banners leave, so it is reached, not
 * whole, there.
 */
const firstDishesOutOfReach = (r: SubRowsReading): string[] =>
  r.tiles.length === 0
    ? ['no dish']
    : r.tiles
      .filter((t) => near(t.top, r.tiles[0]!.top) && !t.inView && t.visible < Math.min(t.height, t.minHeight) - 0.5)
      .map((t) => `${t.name}: ${t.visible} of ${t.height} on screen`);

/** The numbers behind a dish check, for its message: the first tile's box and the scroll that holds it. */
const dishBox = (r: SubRowsReading): string =>
  `first tile ${r.tiles[0] ? `${r.tiles[0].top} +${r.tiles[0].height}, ${r.tiles[0].visible} on screen` : 'none'}, its scroll ${JSON.stringify(r.dishScroll)}`;

/**
 * Brings a chip (by its name) or, with null, the first row of dishes on
 * screen as staff would: nothing to do when it is whole on screen already,
 * else the box around it that scrolls up and down is scrolled to it
 * (`revealInMenu`). The reading after.
 */
async function bringUp(names: string[], chip: string | null): Promise<SubRowsReading> {
  const now = await readRows(names);
  const whole = chip === null ? firstDishesCut(now).length === 0 : now.chips.find((c) => c.name === chip)?.inView === true;
  if (whole) return now;
  await harness.page.evaluate((c) => window.__revealInMenu!(c), chip);
  return readRows(names);
}

/** What holds of the chips whatever their names: in order, in the column, no sideways scroll, one width, on the column lines, every label whole. */
function expectColumns(r: SubRowsReading, names: string[], frame: Frame): void {
  expect(r.chips.map((c) => c.name), 'every sub-category, in order').toEqual(names);
  // No sideways scroll: the block, and nothing between it and a chip, scrolls or clips sideways.
  expect(r.block, 'the chips sit in one block under the menu').not.toBeNull();
  expect(r.sideways).toEqual([]);
  expect(r.block!.overflowX).toBe('visible');
  expect(r.block!.scrollWidth).toBeLessThanOrEqual(r.block!.clientWidth);
  expect(r.block!.testId).toBe('sub-category-grid');
  // Every chip inside the menu column.
  const outside = r.chips.filter((c) => c.left < r.column.left - 0.5 || c.left + c.width > r.column.right + 0.5);
  expect(outside.map((c) => `${c.name}: ${c.left}..${c.left + c.width} in ${r.column.left}..${r.column.right}`)).toEqual([]);
  // One width.
  const widths = r.chips.map((c) => c.width);
  expect(Math.max(...widths) - Math.min(...widths), `widths ${widths.join(', ')}`).toBeLessThanOrEqual(0.5);
  // Aligned columns: the first row's left edges are the column lines, every chip starts on one.
  const lines = r.chips.filter((c) => near(c.top, r.chips[0]!.top)).map((c) => c.left);
  expect(lines.length, `columns in a ${r.column.width}px menu column, ${at(frame)}`).toBe(frame.columns);
  const offLine = r.chips.filter((c) => !lines.some((l) => near(l, c.left)));
  expect(offLine.map((c) => `${c.name} at ${c.left}`), `column lines ${lines.join(', ')}`).toEqual([]);
  const rows = new Set(r.chips.map((c) => Math.round(c.top))).size;
  expect(rows).toBe(Math.ceil(names.length / frame.columns));
  // No label cut.
  const cut = r.chips.filter((c) => c.scrollWidth > c.clientWidth || c.scrollHeight > c.clientHeight || !c.labelInside);
  expect(cut.map((c) => `${c.name}: ${c.scrollWidth}/${c.clientWidth} x ${c.scrollHeight}/${c.clientHeight}, inside ${c.labelInside}`)).toEqual([]);
}

/** Everything that must hold of staging's chips as drawn, whichever is chosen. */
function expectRows(r: SubRowsReading, names: string[], frame: Frame): void {
  expectColumns(r, names, frame);
  // Every chip on screen.
  expect(r.chips.filter((c) => !c.inView).map((c) => c.name), 'every chip on screen at once').toEqual([]);
  // One height.
  const heights = r.chips.map((c) => c.height);
  expect(Math.max(...heights) - Math.min(...heights), `heights ${heights.join(', ')}`).toBeLessThanOrEqual(0.5);
  // None on more than two lines.
  expect(r.chips.filter((c) => c.lines < 1 || c.lines > 2).map((c) => `${c.name}: ${c.lines} lines`)).toEqual([]);
  // The dishes still start on screen: the first row of tiles whole.
  expect(r.tiles.length, 'the chosen sub-category has dishes').toBeGreaterThan(0);
  const firstRow = r.tiles.filter((t) => near(t.top, r.tiles[0]!.top));
  expect(firstRow.filter((t) => !t.inView).map((t) => t.name), 'the first row of dishes whole on screen').toEqual([]);
}

/**
 * A name too long for two lines: its row grows to hold it. The chips of a row
 * share one height, a row starts below the end of the one above (nothing
 * spills over the next row's chips), and every row without the long name
 * keeps the height the others have.
 */
function expectGrownRows(r: SubRowsReading, names: string[], frame: Frame, long: string): void {
  expectColumns(r, names, frame);
  expect(r.chips.filter((c) => c.lines < 1).map((c) => c.name), 'every label drawn').toEqual([]);
  const tops = [...new Set(r.chips.map((c) => c.top))].sort((a, b) => a - b);
  const rows = tops.map((top) => r.chips.filter((c) => c.top === top));
  for (const row of rows) {
    const heights = row.map((c) => c.height);
    expect(Math.max(...heights) - Math.min(...heights), `one height in the row of ${row[0]!.name}: ${heights.join(', ')}`).toBeLessThanOrEqual(0.5);
  }
  const overlaps = rows.slice(1).filter((row, i) => row[0]!.top < rows[i]![0]!.top + rows[i]![0]!.height - 0.5);
  expect(overlaps.map((row) => `${row[0]!.name} at ${row[0]!.top}`), 'every row starts below the one above').toEqual([]);
  const others = rows.filter((row) => !row.some((c) => c.name === long)).map((row) => row[0]!.height);
  expect(Math.max(...others) - Math.min(...others), `the other rows' heights ${others.join(', ')}`).toBeLessThanOrEqual(0.5);
}

describe.skipIf(!browser)('SCRUM-994: the F&B sub-categories stand in aligned rows, with no sideways scroll', () => {
  for (const frame of FRAMES) {
    for (const tab of TABS) {
      const names = GROUPED_MENU[tab]!;
      it(`${tab} (${names.length}), ${at(frame)}: rows of equal chips on the column lines, every label whole, the dishes in view`, async () => {
        const r = await open(frame, tab);
        expectRows(r, names, frame);
        // The first sub-category is chosen when the tab opens, and shows its dishes.
        expect(r.chips.map((c) => c.pressed)).toEqual(names.map((_, i) => String(i === 0)));
        expect(r.tiles.map((t) => t.name)).toEqual(groupedDishes(names[0]!));
      }, 120_000);

      it(`${tab}, ${at(frame)}: pressing the last row's last chip shows its dishes and marks it pressed`, async () => {
        await open(frame, tab);
        const last = names[names.length - 1]!;
        await harness.page.getByTestId('sub-category-grid').getByRole('button', { name: last, exact: true }).click({ timeout: 10_000 });
        const r = await readRows(names);
        expectRows(r, names, frame);
        const lastChip = r.chips[r.chips.length - 1]!;
        expect(Math.round(lastChip.top), 'the last chip is on the last row').toBe(Math.round(Math.max(...r.chips.map((c) => c.top))));
        expect(r.chips.map((c) => c.pressed)).toEqual(names.map((n) => String(n === last)));
        expect(r.tiles.map((t) => t.name)).toEqual(groupedDishes(last));
      }, 120_000);
    }
  }
});

describe.skipIf(!browser)('SCRUM-994: a sub-category name as long as the platform takes grows its row, never spills', () => {
  const names = withLongName(GROUPED_MENU.Drinks!);
  it('the name is 40 characters, the most `MenuCategoryBodySchema` takes', () => {
    expect(LONG_SUB_NAME).toHaveLength(40);
  });
  for (const frame of FRAMES) {
    it(`Drinks with a 40-character name, ${at(frame)}: every label inside its chip, the row grows, the columns stay, the dishes come on screen`, async () => {
      const r = await open(frame, 'Drinks', '&long=1', names);
      expectGrownRows(r, names, frame, LONG_SUB_NAME);
      const dishes = await bringUp(names, null);
      expect(firstDishesCut(dishes), `the first row of dishes whole on screen, or once the menu is scrolled to it; ${dishBox(dishes)}`).toEqual([]);
    }, 120_000);
  }
});

describe.skipIf(!browser)('SCRUM-994: under the staff banners of a scanned band, every chip and the dishes can still be reached', () => {
  // With the chips standing above the dishes' scroll, a 360x740 phone with
  // the allergy alert left the dishes 77px and with the prepaid entitlements
  // too 0px, and a 1366x768 split view with both 0px: no dish at all.
  const names = GROUPED_MENU.Drinks!;
  const last = names[names.length - 1]!;
  for (const frame of SHORT_FRAMES) {
    for (const set of BANNER_SETS) {
      it(`Drinks, ${at(frame)}, banners ${set}: the rows hold; the first dishes, the last chip and its dishes come on screen`, async () => {
        const r = await open(frame, 'Drinks', `&banners=${set}`);
        expectColumns(r, names, frame);
        const heights = r.chips.map((c) => c.height);
        expect(Math.max(...heights) - Math.min(...heights), `heights ${heights.join(', ')}`).toBeLessThanOrEqual(0.5);
        expect(r.chips.filter((c) => c.lines < 1 || c.lines > 2).map((c) => `${c.name}: ${c.lines} lines`)).toEqual([]);
        // The first row of dishes (one-line names): whole on screen, or once the menu is scrolled to it.
        const dishes = await bringUp(names, null);
        expect(firstDishesCut(dishes), `the first row of dishes whole on screen, or once the menu is scrolled to it; ${dishBox(dishes)}`).toEqual([]);
        // The last chip the same way; pressed, it shows its dishes, which come on screen the same way. Their
        // names take three lines in a phone's tile, a tile taller than the room the allergy alert and the
        // entitlements leave at 360x740: there, as much of it as a one-line dish tile shows at a time.
        const chip = await bringUp(names, last);
        expect(chip.chips.find((c) => c.name === last)?.inView, `${last} on screen, or once the menu is scrolled to it`).toBe(true);
        await harness.page.getByTestId('sub-category-grid').getByRole('button', { name: last, exact: true }).click({ timeout: 10_000 });
        const after = await bringUp(names, null);
        expect(after.chips.map((c) => c.pressed)).toEqual(names.map((n) => String(n === last)));
        expect(after.tiles.map((t) => t.name)).toEqual(groupedDishes(last));
        expect(firstDishesOutOfReach(after), `${last}'s first dishes on screen once the menu is scrolled to them; ${dishBox(after)}`).toEqual([]);
      }, 120_000);
    }
  }
});

/** The pictures for the owner: Drinks in the split view, at a desk, on an iPad-wide column and on phones, light and dark. */
describe.skipIf(!browser || !SHOTS)('SCRUM-994 pictures (SPLITFIX_SHOTS)', () => {
  const shotFrames = FRAMES.filter((f) =>
    (f.name === 'split' && f.size.width === 1440) || (f.name === 'full' && f.size.width !== 1280) || f.name === 'phone');
  for (const frame of shotFrames) {
    for (const theme of ['light', 'dark'] as const) {
      it(`Drinks, ${at(frame)}, ${theme}`, async () => {
        const r = await open(frame, 'Drinks', theme === 'dark' ? '&theme=dark' : '');
        expectRows(r, GROUPED_MENU.Drinks!, frame);
        await shoot(`s994-drinks-${frame.name}-${frame.size.width}x${frame.size.height}-${theme}`, r);
      }, 120_000);
    }
  }
  // The short screens under the staff banners and the 40-character name: at rest, and scrolled to the first dishes when they are not whole.
  const cases: [Frame, string, string][] = [
    [SHORT_FRAMES[0]!, '&banners=allergy,prepaid', 'banners-allergy-prepaid'],
    [SHORT_FRAMES[2]!, '&banners=allergy,prepaid', 'banners-allergy-prepaid'],
    [FRAMES[0]!, '&long=1', 'long-name'],
    [FRAMES[5]!, '&long=1', 'long-name'],
  ];
  for (const [frame, query, label] of cases) {
    it(`Drinks, ${at(frame)}, ${label}, light`, async () => {
      const names = query === '&long=1' ? withLongName(GROUPED_MENU.Drinks!) : GROUPED_MENU.Drinks!;
      const r = await open(frame, 'Drinks', query, names);
      const name = `s994-drinks-${frame.name}-${frame.size.width}x${frame.size.height}-${label}`;
      await shoot(name, r);
      const scrolled = await bringUp(names, null);
      if ((scrolled.dishScroll?.scrollTop ?? 0) > 0) await shoot(`${name}-scrolled`, scrolled);
    }, 120_000);
  }
});

/** Saves a picture of the page, and beside it what the picture shows in numbers: the column, each chip's box and lines, the dishes. */
async function shoot(name: string, r: SubRowsReading): Promise<void> {
  await harness.page.screenshot({ path: path.join(SHOTS!, `${name}.png`) });
  writeFileSync(path.join(SHOTS!, `${name}.json`), `${JSON.stringify(r, null, 1)}\n`);
}

describe("the harness draws the phone till's own frame", () => {
  // If the phone till's frame changes, the phone measurement above is of the
  // wrong frame: this fails first, and the harness is brought back in line.
  const source = (...rel: string[]) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', ...rel), 'utf8');
  const harnessPage = readFileSync(path.join(import.meta.dirname, 'support', 'splitfix-harness', 'main.ts'), 'utf8');
  // [where, its path, the class, whether the harness draws it too]
  const pins: [string, string[], string, boolean?][] = [
    ['MobileShell', ['components', 'mobile', 'MobileShell.tsx'], 'h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden'],
    ['MobileShell', ['components', 'mobile', 'MobileShell.tsx'], 'shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30'],
    ['MobileShell', ['components', 'mobile', 'MobileShell.tsx'], 'flex-1 min-h-0 overflow-hidden'],
    ['MobileShell', ['components', 'mobile', 'MobileShell.tsx'], 'shrink-0 grid border-t bg-card/30'],
    ['MobileShell', ['components', 'mobile', 'MobileShell.tsx'], 'w-full flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-semibold transition-colors'],
    ['MobileOrderStation', ['components', 'mobile', 'order-station', 'MobileOrderStation.tsx'], 'h-full flex flex-col bg-background text-foreground overflow-hidden'],
    ['MobileOrderStation', ['components', 'mobile', 'order-station', 'MobileOrderStation.tsx'], 'flex-1 min-h-0 flex flex-col'],
    ['MobileOrderStation', ['components', 'mobile', 'order-station', 'MobileOrderStation.tsx'], 'shrink-0 px-4 pt-2 pb-1'],
    ['MobileOrderStation', ['components', 'mobile', 'order-station', 'MobileOrderStation.tsx'], 'w-full flex items-center gap-2 h-9 px-3 rounded-xl border text-sm transition-colors cursor-pointer select-none'],
    ['MobileOrderStation', ['components', 'mobile', 'order-station', 'MobileOrderStation.tsx'], 'flex-1 min-h-0 px-4 pt-2 pb-1'],
    ['MobileFnbCartSheet', ['components', 'mobile', 'order-station', 'MobileFnbCartSheet.tsx'], 'w-full flex items-center justify-between gap-3 bg-card border-t px-4 py-3 active:bg-muted transition-colors'],
    // The party F&B draws the menu in columns as wide as the desk's and the phone's: measured above through them.
    ['PartyFnbModal', ['components', 'parties', 'PartyFnbModal.tsx'], 'flex-1 min-w-0 p-6 border-r bg-card/20', false],
    ['PartyFnbModal', ['components', 'parties', 'PartyFnbModal.tsx'], 'w-[380px] shrink-0 bg-sidebar p-6', false],
    ['MobilePartyFnb', ['components', 'mobile', 'parties', 'MobilePartyFnb.tsx'], 'flex-1 min-h-0 overflow-y-auto p-4', false],
  ];
  for (const [file, rel, cls, drawn = true] of pins) {
    it(`${file}: ${cls}`, () => {
      expect(source(...rel)).toContain(cls);
      if (drawn) expect(harnessPage).toContain(cls);
    });
  }
});

describe("the harness draws the till's own staff banners above the menu", () => {
  // If the banners a scanned band brings change, the short-screen measurement
  // above is of the wrong banners: this fails first.
  const source = (...rel: string[]) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', ...rel), 'utf8');
  const harnessPage = readFileSync(path.join(import.meta.dirname, 'support', 'splitfix-harness', 'main.ts'), 'utf8');
  const desk = ['pages', 'OrderStation.tsx'];
  const phone = ['components', 'mobile', 'order-station', 'MobileOrderStation.tsx'];
  // [where, its path, the text, whether the harness draws it word for word too]
  const pins: [string, string[], string, boolean?][] = [
    ['OrderStation', desk, 'flex-1 min-w-0 flex flex-col p-6 border-r bg-card/20'],
    ['OrderStation', desk, '<FoodSafetyBanner wristband={wristband} />', false],
    ['OrderStation', desk, 'mb-4 shrink-0 rounded-xl border border-amber-500/50 bg-amber-500/15 px-4 py-3 text-amber-900 dark:text-amber-100'],
    ['OrderStation', desk, 'text-sm font-bold uppercase tracking-wide text-amber-800 dark:text-amber-200', false],
    ['OrderStation', desk, 'mb-4 shrink-0 rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-3'],
    ['MobileOrderStation', phone, 'shrink-0 px-4 pt-3 space-y-2'],
    ['MobileOrderStation', phone, '<FoodSafetyBanner wristband={wristband} compact />', false],
    ['MobileOrderStation', phone, 'rounded-xl border border-amber-500/50 bg-amber-500/15 px-4 py-3 text-amber-900 dark:text-amber-100'],
    ['MobileOrderStation', phone, 'text-xs font-bold uppercase tracking-wide text-amber-800 dark:text-amber-200', false],
    ['MobileOrderStation', phone, 'shrink-0 px-4 pt-3'],
    ['MobileOrderStation', phone, 'rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-3'],
    ...[desk, phone].flatMap((rel): [string, string[], string][] => [
      [rel[rel.length - 1]!, rel, 'flex items-start gap-2.5'],
      [rel[rel.length - 1]!, rel, 'mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300'],
      [rel[rel.length - 1]!, rel, 'Parent did not authorize food orders for this child.'],
      [rel[rel.length - 1]!, rel, 'flex items-center gap-2 mb-2.5'],
      [rel[rel.length - 1]!, rel, 'w-4 h-4 text-violet-700 dark:text-violet-300 shrink-0'],
      [rel[rel.length - 1]!, rel, 'text-xs font-bold uppercase tracking-wide text-violet-800 dark:text-violet-200'],
      [rel[rel.length - 1]!, rel, 'flex flex-wrap gap-2'],
      [rel[rel.length - 1]!, rel, 'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all'],
      [rel[rel.length - 1]!, rel, 'border-violet-500/50 text-violet-900 dark:text-violet-100 bg-violet-500/15 hover:bg-violet-500/25 active:scale-[0.97]'],
    ]),
  ];
  for (const [file, rel, text, drawn = true] of pins) {
    it(`${file}: ${text}`, () => {
      expect(source(...rel)).toContain(text);
      if (drawn) expect(harnessPage).toContain(text);
    });
  }
});
