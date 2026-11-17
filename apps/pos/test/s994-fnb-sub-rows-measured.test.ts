import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './support/splitview-harness/server';
import { startSplitFixHarness, type SplitFixHarness } from './support/splitfix-harness/server';
import { GROUPED_MENU, groupedDishes, type SubRowsReading } from './support/splitfix-harness/sub-rows';

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

/** Opens the grouped menu in a frame, on a tab (Food is the first, chosen when the menu opens). */
async function open(frame: Frame, tab: (typeof TABS)[number], theme = ''): Promise<SubRowsReading> {
  await harness.read(`screen=fnb-menu-grouped&${frame.query}${theme}`, frame.size);
  if (tab !== 'Food') {
    await harness.page.getByTestId('category-row').getByRole('button', { name: tab, exact: true }).click({ timeout: 10_000 });
  }
  return readRows(GROUPED_MENU[tab]!);
}

const at = (frame: Frame) => `${frame.name} ${frame.size.width}x${frame.size.height}`;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/** Everything that must hold of the chips as drawn, whichever is chosen. */
function expectRows(r: SubRowsReading, names: string[], frame: Frame): void {
  expect(r.chips.map((c) => c.name), 'every sub-category, in order').toEqual(names);
  // No sideways scroll: the block, and nothing between it and a chip, scrolls or clips sideways.
  expect(r.block, 'the chips sit in one block under the menu').not.toBeNull();
  expect(r.sideways).toEqual([]);
  expect(r.block!.overflowX).toBe('visible');
  expect(r.block!.scrollWidth).toBeLessThanOrEqual(r.block!.clientWidth);
  expect(r.block!.testId).toBe('sub-category-grid');
  // Every chip inside the menu column, and on screen.
  const outside = r.chips.filter((c) => c.left < r.column.left - 0.5 || c.left + c.width > r.column.right + 0.5);
  expect(outside.map((c) => `${c.name}: ${c.left}..${c.left + c.width} in ${r.column.left}..${r.column.right}`)).toEqual([]);
  expect(r.chips.filter((c) => !c.inView).map((c) => c.name), 'every chip on screen at once').toEqual([]);
  // One width and one height.
  const widths = r.chips.map((c) => c.width);
  const heights = r.chips.map((c) => c.height);
  expect(Math.max(...widths) - Math.min(...widths), `widths ${widths.join(', ')}`).toBeLessThanOrEqual(0.5);
  expect(Math.max(...heights) - Math.min(...heights), `heights ${heights.join(', ')}`).toBeLessThanOrEqual(0.5);
  // Aligned columns: the first row's left edges are the column lines, every chip starts on one.
  const lines = r.chips.filter((c) => near(c.top, r.chips[0]!.top)).map((c) => c.left);
  expect(lines.length, `columns in a ${r.column.width}px menu column, ${at(frame)}`).toBe(frame.columns);
  const offLine = r.chips.filter((c) => !lines.some((l) => near(l, c.left)));
  expect(offLine.map((c) => `${c.name} at ${c.left}`), `column lines ${lines.join(', ')}`).toEqual([]);
  const rows = new Set(r.chips.map((c) => Math.round(c.top))).size;
  expect(rows).toBe(Math.ceil(names.length / frame.columns));
  // No label cut, none on more than two lines.
  const cut = r.chips.filter((c) => c.scrollWidth > c.clientWidth || c.scrollHeight > c.clientHeight || !c.labelInside);
  expect(cut.map((c) => `${c.name}: ${c.scrollWidth}/${c.clientWidth} x ${c.scrollHeight}/${c.clientHeight}, inside ${c.labelInside}`)).toEqual([]);
  expect(r.chips.filter((c) => c.lines < 1 || c.lines > 2).map((c) => `${c.name}: ${c.lines} lines`)).toEqual([]);
  // The dishes still start on screen: the first row of tiles whole.
  expect(r.tiles.length, 'the chosen sub-category has dishes').toBeGreaterThan(0);
  const firstRow = r.tiles.filter((t) => near(t.top, r.tiles[0]!.top));
  expect(firstRow.filter((t) => !t.inView).map((t) => t.name), 'the first row of dishes whole on screen').toEqual([]);
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

/** The pictures for the owner: Drinks in the split view, at a desk, on an iPad-wide column and on phones, light and dark. */
describe.skipIf(!browser || !SHOTS)('SCRUM-994 pictures (SPLITFIX_SHOTS)', () => {
  const shotFrames = FRAMES.filter((f) =>
    (f.name === 'split' && f.size.width === 1440) || (f.name === 'full' && f.size.width !== 1280) || f.name === 'phone');
  for (const frame of shotFrames) {
    for (const theme of ['light', 'dark'] as const) {
      it(`Drinks, ${at(frame)}, ${theme}`, async () => {
        const r = await open(frame, 'Drinks', theme === 'dark' ? '&theme=dark' : '');
        expectRows(r, GROUPED_MENU.Drinks!, frame);
        const name = `s994-drinks-${frame.name}-${frame.size.width}x${frame.size.height}-${theme}`;
        await harness.page.screenshot({ path: path.join(SHOTS!, `${name}.png`) });
        // What the picture shows, in numbers: the column, each chip's box and lines.
        writeFileSync(path.join(SHOTS!, `${name}.json`), `${JSON.stringify(r, null, 1)}\n`);
      }, 120_000);
    }
  }
});

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
