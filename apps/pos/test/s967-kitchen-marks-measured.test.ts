import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './support/splitview-harness/server';
import { startKitchenEditHarness, type KitchenEditHarness } from './support/kitchenedit-harness/server';

/**
 * SCRUM-967 (point 11) — THE EDIT FORM'S KITCHEN MARKS ARE WHOLE, MEASURED IN
 * A BROWSER.
 *
 * Staging's proof of SCRUM-907 (docs/qa/proof-2026-11-13/SCRUM-907, picture
 * 05a, 1440 wide): the read-only name box of a kitchen line held the dish and
 * its marks on one line, so "ZZ TEST mango sticky rice · not on the till" and
 * "… kids only · not on the til…" lost the mark at the box's edge; on a real
 * dish the "adults" or "not on the till menu" is exactly what goes. The marks
 * now sit whole on a line of their own under the name box.
 *
 * `support/kitchenedit-harness` draws the real Edit form in the Events page's
 * frame with ZZ TEST dishes long enough to fill the box, as reception and as a
 * manager, at 1440 and 1024 wide and in half of a 1440 window (the split
 * view's staff half). What is read are relations (the marks' text inside its
 * own box, the box inside its card and on screen), which do not depend on the
 * machine's fonts, so the check is the same on CI's Linux runner.
 *
 * The browser is the machine's Edge or Chrome, or Playwright's Chromium; with
 * none the file is skipped and says so.
 */
const { browser, why } = await launchBrowser();
if (!browser) console.warn(`SCRUM-967 kitchen marks measurement skipped: no browser to lay the page out (${why})`);

const MARKS: Record<string, string> = {
  'ZZ TEST mango sticky rice with coconut cream': 'not on the till menu',
  'ZZ TEST grilled chicken skewers for the grown-ups': 'adults',
  'ZZ TEST mini cheese pizza for the kids table': 'kids only',
  'ZZ TEST calamari': 'kids only · not on the till menu',
  'ZZ TEST sparkling passion fruit soda pitcher': 'not on the till menu',
};

const CASES = [
  { size: { width: 1440, height: 900 }, split: false },
  { size: { width: 1024, height: 768 }, split: false },
  { size: { width: 1440, height: 900 }, split: true },
] as const;

let harness: KitchenEditHarness;
beforeAll(async () => {
  if (browser) harness = await startKitchenEditHarness(browser);
}, 180_000);
afterAll(async () => {
  await harness?.close();
  await browser?.close();
});

describe.skipIf(!browser)('SCRUM-967 — every kitchen and bar line’s mark is whole in the Edit form', () => {
  for (const who of ['reception', 'manager'] as const) {
    for (const { size, split } of CASES) {
      it(`${who}, ${size.width}${split ? ' in the split view' : ''}: the name box holds the dish, and its mark is whole under it`, async () => {
        const lines = await harness.read(`who=${who}&split=${split ? 1 : 0}`, size);
        expect(lines.map((l) => l.name).sort()).toEqual(Object.keys(MARKS).sort());
        for (const line of lines) {
          expect(line.name.includes('not on the till'), line.name).toBe(false);
          expect(line.marks, line.name).toBe(MARKS[line.name]);
          expect(line.marksWhole, `${line.name}: ${line.marks} laid out whole`).toBe(true);
          expect(line.marksInside, `${line.name}: ${line.marks} inside its card and on screen`).toBe(true);
        }
      }, 60_000);
    }
  }
});
