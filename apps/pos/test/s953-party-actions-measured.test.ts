import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './support/splitview-harness/server';
import { startKitchenEditHarness, type KitchenEditHarness } from './support/kitchenedit-harness/server';

/**
 * SCRUM-953 (the party-page part of point 6) — THE PARTY PAGE'S BUTTON ROW
 * WITH A SETTLEMENT OPEN, MEASURED. Six buttons (Message parent, Edit party,
 * Resume settlement, Cancel settlement, Add F&B to party, Take balance) ran
 * past the party page's column in one row. The row now wraps inside it
 * (`PARTY_ACTIONS_ROW`, `components/parties/partyLayout.ts`), every button
 * whole, at 1440 and at 1024, in the Events page's frame (`p-6` round
 * `mx-auto max-w-5xl`), with the till's own fonts.
 */
const { browser, why } = await launchBrowser();
if (!browser) console.warn(`SCRUM-953 party actions measurement skipped: no browser to lay the page out (${why})`);

interface ActionsReading {
  column: [number, number];
  pageScrolls: boolean;
  buttons: { text: string; left: number; right: number; top: number; whole: boolean }[];
}

let harness: KitchenEditHarness;
beforeAll(async () => {
  if (browser) harness = await startKitchenEditHarness(browser);
}, 180_000);
afterAll(async () => {
  await harness?.close();
  await browser?.close();
});

describe.skipIf(!browser)('SCRUM-953 — the party page’s buttons stay inside its column with a settlement open', () => {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }] as const) {
    it(`${size.width}x${size.height}: all six inside the column, each whole, the page not scrolling sideways`, async () => {
      await harness.read('screen=actions', size);
      const seen = await harness.page.evaluate(() => window.__readActionsRow!()) as ActionsReading;
      const detail = JSON.stringify(seen);
      expect(seen.buttons.map((b) => b.text)).toEqual(['Message parent', 'Edit party', 'Resume settlement ฿18010',
        'Cancel settlement', 'Add F&B to party', 'Take balance ฿18010']);
      for (const b of seen.buttons) {
        expect(b.left, `${b.text} ${detail}`).toBeGreaterThanOrEqual(seen.column[0] - 0.5);
        expect(b.right, `${b.text} ${detail}`).toBeLessThanOrEqual(seen.column[1] + 0.5);
        expect(b.whole, b.text).toBe(true);
      }
      expect(seen.pageScrolls).toBe(false);
    }, 120_000);
  }
});
