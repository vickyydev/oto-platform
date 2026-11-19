import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { typedTextClass } from '@/components/till/TouchText';
import { startFamilyFormHarness } from './support/family-form-harness/server';

/**
 * SCRUM-1059 (6) — WHAT A FAMILY TYPES IS THE BOX'S OWN SIZE AT EVERY WIDTH,
 * MEASURED IN A BROWSER.
 *
 * Staging's pictures of one form on three displays (m3 at 768, m4 at 600, m5
 * at 1024): the parent's name typed into the large name box read 24px on the
 * 600 counter display and 14px on the other two. The till's plain `Input` and
 * `Textarea` drop their type to `md:text-sm` from 768px up, which the box's
 * own `text-2xl` (a name) or `text-lg` (the allergies, the dietary notes) did
 * not override; with the on-screen keys every one-line box took `md:text-2xl`
 * whatever its size. `TouchText` now repeats the box's own size at `md:`
 * (`typedTextClass`), and the prepaid credit amount of the till's own form
 * does the same.
 *
 * `support/family-form-harness` draws the family's form with the till's own
 * components in a real browser (Edge, Chrome or Playwright's Chromium; with
 * none the file is skipped and says so), at each display's size, with and
 * without the on-screen keys, and reads the type size the browser gives
 * what is typed. FAMILYFORM_SHOTS=<dir> also writes each screen to look at.
 */
const SHOTS = process.env.FAMILYFORM_SHOTS;
const { harness, why } = await startFamilyFormHarness();
if (!harness) console.warn(`SCRUM-1059 typed text measurement skipped: no browser to lay the form out (${why})`);
afterAll(async () => { await harness?.close(); });

/** The family's displays: the counter's upright 600, tablets upright and on their side. */
const DISPLAYS = [
  { width: 600, height: 1024 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
] as const;

/** Each box of the form, the step it is on, and the size its class gives it (text-2xl 24px, text-lg 18px). */
const BOXES = [
  { testId: 'consent-child-name', step: 'children', px: 24, typed: 'ZZ TEST Mai' },
  { testId: 'consent-allergies', step: 'care', px: 18, typed: 'ZZ TEST peanuts' },
  { testId: 'consent-dietary', step: 'care', px: 18, typed: 'ZZ TEST halal' },
  { testId: 'consent-guardian', step: 'agreements', px: 24, typed: 'ZZ TEST guardian' },
] as const;

const typedSize = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((box) => getComputedStyle(box).fontSize);

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

describe('SCRUM-1059 (6): the box keeps its own type size at md and up', () => {
  it('repeats the size the box was given; a box with none is left alone', () => {
    expect(typedTextClass('mt-2 h-14 px-4 text-2xl text-foreground')).toContain('md:text-2xl');
    expect(typedTextClass('mt-2 h-12 px-4 text-lg text-foreground')).toContain('md:text-lg');
    expect(typedTextClass('mt-2 h-12 px-4 text-foreground')).toBe('mt-2 h-12 px-4 text-foreground');
    expect(typedTextClass(undefined)).toBeUndefined();
  });
});

describe.skipIf(!harness)('the family\'s form on its displays (SCRUM-1059 6)', () => {
  for (const display of DISPLAYS) {
    for (const keys of ['', '&keyboard=screen'] as const) {
      const which = `${display.width}x${display.height}${keys ? ' with the on-screen keys' : ''}`;
      it(`at ${which}, what is typed is the box's own size`, async () => {
        const sizes: Record<string, string> = {};
        for (const step of ['children', 'care', 'agreements'] as const) {
          const page = await harness!.open(`screen=display&step=${step}${keys}`, display);
          for (const box of BOXES.filter((b) => b.step === step)) {
            await page.getByTestId(box.testId).fill(box.typed);
            sizes[box.testId] = await typedSize(page, box.testId);
          }
          if (!keys) await shot(page, `display-${step}-${display.width}x${display.height}`);
        }
        expect(sizes).toEqual(Object.fromEntries(BOXES.map((b) => [b.testId, `${b.px}px`])));
      }, 120_000);
    }
  }

  it('on a light display too (the size does not follow the theme)', async () => {
    const page = await harness!.open('screen=display&step=agreements&theme=light', { width: 768, height: 1024 });
    await page.getByTestId('consent-guardian').fill('ZZ TEST guardian');
    expect(await typedSize(page, 'consent-guardian')).toBe('24px');
    await shot(page, 'display-agreements-768x1024-light');
  }, 60_000);
});

describe.skipIf(!harness)("the till's own customer half (SCRUM-1059 6)", () => {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }] as const) {
    it(`at ${size.width}x${size.height}: the names, the notes and the prepaid credit amount`, async () => {
      const page = await harness!.open('screen=half', size);
      for (const box of BOXES) await page.getByTestId(box.testId).fill(box.typed);
      const sizes = Object.fromEntries(await Promise.all(BOXES.map(async (b) => [b.testId, await typedSize(page, b.testId)] as const)));
      expect(sizes).toEqual(Object.fromEntries(BOXES.map((b) => [b.testId, `${b.px}px`])));
      await page.getByRole('button', { name: 'Prepaid credit' }).click();
      const amount = page.locator('input[type="number"]');
      await amount.fill('200');
      expect(await amount.evaluate((box) => getComputedStyle(box).fontSize)).toBe('24px');
      await amount.scrollIntoViewIfNeeded();
      await shot(page, `half-${size.width}x${size.height}`);
    }, 120_000);
  }
});
