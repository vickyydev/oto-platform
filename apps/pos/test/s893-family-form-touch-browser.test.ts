import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { startFamilyFormHarness } from './support/family-form-harness/server';

/**
 * SCRUM-893 / SCRUM-894 / SCRUM-943 — THE FAMILY'S FORM ON THE COUNTER'S TOUCH
 * MONITOR, IN A BROWSER.
 *
 * The counter display is a 10-inch touch monitor standing on its end (600 by
 * 1024 once turned), with no keyboard, opened with `?keyboard=screen`; the
 * ticket's short screen is 1024 by 600. On both, every text box of the
 * drop-off and nanny form opens the on-screen keyboard when touched, the box
 * and its keys are in view inside the form with the bottom bar (Still needed,
 * Ask the team, Back, Done) below them and never over them, and what is typed
 * on the keys is in the box and reaches the till. The same on the till's own
 * customer half. Then the small points a browser shows: at phone width the
 * language button stays off the heading (943 g); on a light display the camera
 * notice reads, and the dark look is as it was (943 f); the display tells the
 * till it has no camera, or that the camera was refused (943 a).
 *
 * Needs a browser: Edge, Chrome or Playwright's Chromium. With none it is
 * skipped and says so.
 */

const { harness, why } = await startFamilyFormHarness();
if (!harness) console.warn(`SCRUM-893 family form review skipped: no browser to touch in (${why})`);
afterAll(async () => { await harness?.close(); });

const SHAPES = [
  { name: 'the counter display standing (600 × 1024)', width: 600, height: 1024 },
  { name: 'a short screen (1024 × 600)', width: 1024, height: 600 },
] as const;
const DISPLAY_FIELDS = [
  { step: 'children', testId: 'consent-child-name', till: (t: Till) => t.prompt.slots[0]!.name },
  { step: 'care', testId: 'consent-allergies', till: (t: Till) => t.prompt.slots[0]!.allergiesMedical },
  { step: 'care', testId: 'consent-dietary', till: (t: Till) => t.prompt.slots[0]!.foodRestrictions },
  { step: 'agreements', testId: 'consent-guardian', till: (t: Till) => t.prompt.guardianName },
] as const;
interface Till {
  prompt: { slots: { name: string; allergiesMedical: string; foodRestrictions: string }[]; guardianName: string };
  heard: { action: string; camera?: string } | null;
}
/** Room for a few taps and a live fill on a busy runner; each settles well inside it. */
const TAPS = 60_000;

const keys = (page: Page) => page.getByTestId('screen-keyboard');
async function type(page: Page, letters: string) {
  for (const letter of letters) {
    await keys(page).getByRole('button', { name: letter === ' ' ? 'Space' : letter, exact: true }).click();
  }
}
const till = async (page: Page): Promise<Till> => JSON.parse((await page.locator('#till').textContent())!);

/** Where the box and its keys are, against the part of the form that scrolls and the bar under it. */
async function placing(page: Page, testId: string) {
  return page.evaluate((id) => {
    const field = document.querySelector(`[data-testid="${id}"]`)!;
    const keyboard = document.querySelector('[data-testid="screen-keyboard"]')!;
    let scroller = field.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
    // The form's own bottom bar: the half's Done bar, or the display's (Ask the team is only there).
    const bar = document.querySelector('[data-testid="consent-done-bar"]')
      ?? [...document.querySelectorAll('button')].find((button) => button.textContent === 'Ask the team')?.parentElement ?? null;
    const box = (el: Element) => el.getBoundingClientRect();
    const s = box(scroller!);
    const f = box(field);
    const k = box(keyboard);
    const b = bar ? box(bar) : null;
    const inside = (r: DOMRect) => r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
    return {
      fieldInView: inside(f), keysInView: inside(k), keysBelowField: k.top >= f.bottom - 1,
      clearOfBar: !b || (k.bottom <= b.top + 1 && f.bottom <= b.top + 1),
      detail: `scroller ${Math.round(s.top)}-${Math.round(s.bottom)}, field ${Math.round(f.top)}-${Math.round(f.bottom)}, keys ${Math.round(k.top)}-${Math.round(k.bottom)}, bar ${b ? Math.round(b.top) : 'none'}`,
    };
  }, testId);
}

describe.skipIf(!harness)('every box of the form on the paired display opens the keys (SCRUM-893, 894)', () => {
  for (const shape of SHAPES) {
    for (const field of DISPLAY_FIELDS) {
      it(`${shape.name}: ${field.testId} opens the keys in view above the bar, and typing reaches the till`, async () => {
        const page = await harness!.open(`screen=display&keyboard=screen&step=${field.step}`, shape);
        await expect(keys(page).count()).resolves.toBe(0);
        await page.getByTestId(field.testId).click();
        await expect.poll(() => keys(page).count()).toBe(1);
        const where = await placing(page, field.testId);
        expect(where.fieldInView, where.detail).toBe(true);
        expect(where.keysInView, where.detail).toBe(true);
        expect(where.keysBelowField, where.detail).toBe(true);
        expect(where.clearOfBar, where.detail).toBe(true);
        await type(page, 'PEA NUT');
        await expect.poll(() => page.getByTestId(field.testId).inputValue()).toBe('Pea Nut');
        await expect.poll(async () => field.till(await till(page)), { timeout: 5_000 }).toBe('Pea Nut');
        // Done puts the keys away.
        await keys(page).getByRole('button', { name: 'Done', exact: true }).click();
        await expect.poll(() => keys(page).count()).toBe(0);
      }, TAPS);
    }
  }

  it('one set of keys at a time: the dietary box’s keys put the allergies box’s away', async () => {
    const page = await harness!.open('screen=display&keyboard=screen&step=care', { width: 600, height: 1024 });
    await page.getByTestId('consent-allergies').click();
    await expect.poll(() => keys(page).count()).toBe(1);
    await page.getByTestId('consent-dietary').click();
    await expect.poll(() => keys(page).count()).toBe(1);
    const below = await page.evaluate(() => {
      const dietary = document.querySelector('[data-testid="consent-dietary"]')!.getBoundingClientRect();
      return document.querySelector('[data-testid="screen-keyboard"]')!.getBoundingClientRect().top >= dietary.bottom - 1;
    });
    expect(below).toBe(true);
  }, TAPS);

  it('without the flag the boxes are the plain ones, the system keyboard’s', async () => {
    const page = await harness!.open('screen=display&step=care', { width: 1024, height: 600 });
    await page.getByTestId('consent-allergies').click();
    await expect(keys(page).count()).resolves.toBe(0);
    await page.getByTestId('consent-allergies').fill('Peanuts');
    await expect.poll(async () => (await till(page)).prompt.slots[0]!.allergiesMedical, { timeout: 5_000 }).toBe('Peanuts');
  }, TAPS);
});

describe.skipIf(!harness)('the till’s own customer half with no keyboard (SCRUM-893)', () => {
  for (const testId of ['consent-child-name', 'consent-allergies', 'consent-dietary', 'consent-guardian']) {
    it(`${testId} opens the keys in view, and typing reaches the till`, async () => {
      const page = await harness!.open('screen=half&keyboard=screen', { width: 1180, height: 820 });
      await page.getByTestId(testId).click();
      await expect.poll(() => keys(page).count()).toBe(1);
      const where = await placing(page, testId);
      expect(where.fieldInView, where.detail).toBe(true);
      expect(where.keysInView, where.detail).toBe(true);
      expect(where.clearOfBar, where.detail).toBe(true);
      await type(page, 'MAI');
      await expect.poll(() => page.getByTestId(testId).inputValue()).toBe('Mai');
      const state = await till(page) as unknown as { slots: { name: string; allergiesMedical: string; foodRestrictions: string }[]; parentName: string };
      const value = testId === 'consent-child-name' ? state.slots[0]!.name : testId === 'consent-allergies' ? state.slots[0]!.allergiesMedical
        : testId === 'consent-dietary' ? state.slots[0]!.foodRestrictions : state.parentName;
      expect(value).toBe('Mai');
    }, TAPS);
  }
});

/** The heading's badge and the language button, as drawn. */
async function headingClear(page: Page) {
  return page.evaluate(() => {
    const badge = [...document.querySelectorAll('span')].find((span) => span.textContent === 'Playing with us today')!.getBoundingClientRect();
    const language = document.querySelector('[aria-label="Change language"]')!.getBoundingClientRect();
    const overlap = !(badge.right <= language.left || language.right <= badge.left || badge.bottom <= language.top || language.bottom <= badge.top);
    return { overlap, detail: `badge ${Math.round(badge.left)},${Math.round(badge.top)}-${Math.round(badge.right)},${Math.round(badge.bottom)} language ${Math.round(language.left)},${Math.round(language.top)}-${Math.round(language.right)},${Math.round(language.bottom)}` };
  });
}

describe.skipIf(!harness)('at phone width (SCRUM-943 g)', () => {
  it.each(['display', 'half'])('the language button stays off the heading on the %s form', async (screen) => {
    const page = await harness!.open(`screen=${screen}&step=agreements`, { width: 390, height: 844 });
    const clear = await headingClear(page);
    expect(clear.overlap, clear.detail).toBe(false);
  }, TAPS);

  it('and at the counter display’s width nothing moved', async () => {
    const page = await harness!.open('screen=display&step=children', { width: 600, height: 1024 });
    const top = await page.evaluate(() => getComputedStyle([...document.querySelectorAll('span')]
      .find((span) => span.textContent === 'Playing with us today')!.closest('div.shrink-0')!).paddingTop);
    expect(top).toBe('32px');
  }, TAPS);
});

/** WCAG contrast of an ink on a backdrop, the ink's own alpha laid over it. */
function contrast(ink: number[], backdrop: number[]): number {
  const [r, g, b, a = 1] = ink;
  const laid = [r! * a + backdrop[0]! * (1 - a), g! * a + backdrop[1]! * (1 - a), b! * a + backdrop[2]! * (1 - a)];
  const lum = (c: number[]) => {
    const [x, y, z] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * x! + 0.7152 * y! + 0.0722 * z!;
  };
  const [hi, lo] = [lum(laid), lum(backdrop)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
}

async function cameraNotice(page: Page) {
  await page.getByRole('button', { name: 'Start camera' }).click();
  await page.getByTestId('camera-notice').waitFor({ timeout: 10_000 });
  return page.evaluate(() => {
    const parse = (value: string) => {
      const found = value.match(/[\d.]+/g)!.map(Number);
      return found.length === 3 ? [...found, 1] : found;
    };
    const notice = document.querySelector('[data-testid="camera-notice"]')!;
    const [title, note] = [...notice.querySelectorAll('span')];
    return {
      title: parse(getComputedStyle(title!).color), note: parse(getComputedStyle(note!).color),
      veil: parse(getComputedStyle(notice).backgroundColor), frame: parse(getComputedStyle(notice.parentElement!).backgroundColor),
      words: `${title!.textContent} / ${note!.textContent}`,
    };
  });
}

describe.skipIf(!harness)('the camera notice on the display (SCRUM-943 a, f)', () => {
  /** The cream under the form on a light display (the middle of its gradient), and the dark one's. */
  const CREAM = [255, 238, 222];
  const lay = (top: number[], under: number[]) => {
    const a = top[3] ?? 1;
    return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a));
  };

  it('on a light display both lines read: dark ink on a pale veil', async () => {
    const page = await harness!.open('screen=display&step=care&theme=light&camera=refused', { width: 600, height: 1024 });
    const seen = await cameraNotice(page);
    expect(seen.words).toBe('Camera access blocked / Reception will take the photo of you both at the counter instead.');
    const backdrop = lay(seen.veil, lay(seen.frame, CREAM));
    expect(contrast(seen.title, backdrop)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(seen.note, backdrop)).toBeGreaterThanOrEqual(4.5);
  }, TAPS);

  it('on a dark display the look is as it was: amber-300 on the frame, the note at half strength, no veil', async () => {
    const page = await harness!.open('screen=display&step=care&theme=dark&camera=refused', { width: 600, height: 1024 });
    const seen = await cameraNotice(page);
    // The very colour the notice's text-amber-300 drew: Tailwind's amber-300, as this browser computes it.
    const amber300 = readFileSync(path.resolve(import.meta.dirname, '../node_modules/tailwindcss/theme.css'), 'utf8')
      .match(/--color-amber-300: ([^;]+);/)![1]!;
    const drawn = await page.evaluate((color) => {
      const probe = document.createElement('span');
      probe.style.color = color;
      document.body.append(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      return computed;
    }, amber300);
    expect(seen.title.slice(0, 3)).toEqual(drawn.match(/[\d.]+/g)!.map(Number).slice(0, 3));
    expect(seen.veil[3]).toBe(0);
    expect(seen.note[3]).toBeCloseTo(0.5, 2);
  }, TAPS);

  it('the till hears that the camera was refused, and that a display has none', async () => {
    const refused = await harness!.open('screen=display&step=care&theme=dark&camera=refused', { width: 600, height: 1024 });
    await cameraNotice(refused);
    await expect.poll(async () => (await till(refused)).heard?.camera, { timeout: 5_000 }).toBe('refused');
    const none = await harness!.open('screen=display&step=care&camera=none', { width: 600, height: 1024 });
    await expect.poll(async () => (await till(none)).heard?.camera, { timeout: 5_000 }).toBe('none');
  }, TAPS);
});
