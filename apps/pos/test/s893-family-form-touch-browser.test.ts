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
        // The keys' own button puts them away (SCRUM-954: it reads Hide, the form's Done is the only Done).
        await keys(page).getByRole('button', { name: 'Hide', exact: true }).click();
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

  /**
   * SCRUM-954 — the steps share one scrolling part, and it kept the last
   * step's place: a family at the bottom of the care step who pressed Continue
   * landed on the confirmations with the guardian's name and number above the
   * screen. Each step opens at its top.
   */
  it('a step opens at its top: after the bottom of the care step, Continue shows the guardian box', async () => {
    const page = await harness!.open('screen=display&keyboard=screen&step=care', { width: 1024, height: 600 });
    const scrolled = await page.evaluate(() => {
      let scroller = document.querySelector('[data-testid="consent-allergies"]')!.parentElement;
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
      scroller!.scrollTop = scroller!.scrollHeight;
      return scroller!.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => page.getByTestId('consent-guardian').count()).toBe(1);
    const after = await page.evaluate(() => {
      const field = document.querySelector('[data-testid="consent-guardian"]')!;
      let scroller = field.parentElement;
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
      const s = scroller!.getBoundingClientRect();
      const f = field.getBoundingClientRect();
      return { top: scroller!.scrollTop, inView: f.top >= s.top - 1 && f.bottom <= s.bottom + 1 };
    });
    expect(after.top).toBe(0);
    expect(after.inView).toBe(true);
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

// --- SCRUM-954: the small points from the counter display and phone proofs ------------------

describe.skipIf(!harness)('SCRUM-954 (2): one Done on the counter display', () => {
  it('with the keys open the form’s Done is the only Done, and the keys’ own button is a plain key', async () => {
    const page = await harness!.open('screen=display&keyboard=screen&step=agreements', { width: 600, height: 1024 });
    await page.getByTestId('consent-guardian').click();
    await expect.poll(() => keys(page).count()).toBe(1);
    const seen = await page.evaluate(() => {
      const keyboard = document.querySelector('[data-testid="screen-keyboard"]')!;
      const named = (name: string) => [...document.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name);
      const done = named('Done');
      const hide = keyboard.querySelector('[data-testid="screen-keyboard-hide"]')!;
      const space = keyboard.querySelector('[aria-label="Space"]')!;
      const paint = (el: Element) => getComputedStyle(el).backgroundColor;
      return {
        dones: done.length, doneInKeys: done.some((b) => keyboard.contains(b)),
        hideName: hide.getAttribute('aria-label'), hideWords: hide.textContent?.trim(),
        hidePaint: paint(hide), spacePaint: paint(space), donePaint: done[0] ? paint(done[0]) : '',
      };
    });
    expect(seen.dones).toBe(1);
    expect(seen.doneInKeys).toBe(false);
    expect([seen.hideName, seen.hideWords]).toEqual(['Hide', 'Hide']);
    // Drawn as Space is, not as the blue Done below.
    expect(seen.hidePaint).toBe(seen.spacePaint);
    expect(seen.hidePaint).not.toBe(seen.donePaint);
    // It still puts the keys away.
    await keys(page).getByRole('button', { name: 'Hide', exact: true }).click();
    await expect.poll(() => keys(page).count()).toBe(0);
  }, TAPS);
});

/** The language button's name in each language the test reads. */
const LANGUAGE_BUTTON: Record<'en' | 'th', string> = { en: 'Change language', th: 'เปลี่ยนภาษา' };

async function lineAndButton(page: Page, lang: 'en' | 'th') {
  return page.evaluate((label) => {
    const line = document.querySelector<HTMLElement>('[data-testid="display-form-reconnecting"]')!;
    const button = document.querySelector(`[aria-label="${label}"]`)!;
    const range = document.createRange();
    range.selectNodeContents(line);
    const words = [...range.getClientRects()].filter((r) => r.width > 0);
    const b = button.getBoundingClientRect();
    const wordsOverButton = words.some((r) => !(r.right <= b.left || b.right <= r.left || r.bottom <= b.top || b.bottom <= r.top));
    // What is drawn on top at the button's middle: the line takes no touch,
    // so it is made to take one for this reading only.
    line.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    line.style.pointerEvents = '';
    const style = getComputedStyle(line);
    return {
      wordsOverButton, buttonOnTop: !!hit && button.contains(hit), position: style.position, touch: style.pointerEvents,
      detail: `button ${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}; words ${words.map((r) => `${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`).join(' ')}; hit ${hit?.tagName}`,
    };
  }, LANGUAGE_BUTTON[lang]);
}

const headingTop = (page: Page) => page.evaluate(() => [...document.querySelectorAll('span')]
  .find((span) => /^(Playing with us today|มาเล่นกับเราวันนี้)$/.test(span.textContent ?? ''))!.getBoundingClientRect().top);

describe.skipIf(!harness)('SCRUM-954 (3): the reconnecting line leaves the language button in sight', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: the button is drawn over the line, the line's words clear of it, and the form not moved`, async () => {
      const page = await harness!.open('screen=display&keyboard=screen&step=agreements&reconnecting=1', shape);
      const seen = await lineAndButton(page, 'en');
      expect(seen.buttonOnTop, seen.detail).toBe(true);
      expect(seen.wordsOverButton, seen.detail).toBe(false);
      // SCRUM-943: still laid over the form, taking no touch.
      expect([seen.position, seen.touch]).toEqual(['absolute', 'none']);
      const withLine = await headingTop(page);
      const plain = await harness!.open('screen=display&keyboard=screen&step=agreements', shape);
      expect(withLine).toBe(await headingTop(plain));
    }, TAPS);
  }

  it('the button can be pressed while the line shows, and the line follows into Thai, still clear of it', async () => {
    const page = await harness!.open('screen=display&step=agreements&reconnecting=1', { width: 600, height: 1024 });
    await page.getByRole('button', { name: LANGUAGE_BUTTON.en, exact: true }).click();
    await page.getByRole('button', { name: 'ไทย', exact: true }).click();
    await expect.poll(() => page.getByTestId('display-form-reconnecting').textContent()).toContain('กำลังเชื่อมต่อใหม่');
    const seen = await lineAndButton(page, 'th');
    expect(seen.buttonOnTop, seen.detail).toBe(true);
    expect(seen.wordsOverButton, seen.detail).toBe(false);
  }, TAPS);
});

/** Heights of the presses SCRUM-954 (4) names, as the browser drew them. */
async function pressHeights(page: Page) {
  return page.evaluate((label) => {
    const height = (el: Element) => Math.round(el.getBoundingClientRect().height * 10) / 10;
    const language = document.querySelector(`[aria-label="${label}"]`);
    const pills = [...document.querySelectorAll('[data-testid="consent-steps"] button')];
    const done = document.querySelector('[data-testid="consent-done-bar"]');
    const bar = done ?? [...document.querySelectorAll('button')].find((b) => b.textContent === 'Ask the team')?.parentElement ?? null;
    const presses = bar ? [...bar.querySelectorAll('button')] : [];
    return {
      language: language ? height(language) : null,
      pills: pills.map(height),
      bar: presses.map((b) => `${b.textContent?.trim()} ${height(b)}`),
      barHeights: presses.map(height),
    };
  }, LANGUAGE_BUTTON.en);
}

describe.skipIf(!harness)('SCRUM-954 (4): every press of the display’s form is a finger’s height', () => {
  for (const shape of SHAPES) {
    for (const step of ['children', 'care', 'agreements'] as const) {
      it(`${shape.name}, ${step}: the bar's buttons, the step pills and the language button are 44px or taller`, async () => {
        const page = await harness!.open(`screen=display&keyboard=screen&step=${step}`, shape);
        const seen = await pressHeights(page);
        const detail = JSON.stringify(seen);
        expect(seen.language, detail).toBeGreaterThanOrEqual(44);
        expect(seen.pills, detail).toHaveLength(3);
        for (const pill of seen.pills) expect(pill, detail).toBeGreaterThanOrEqual(44);
        expect(seen.barHeights.length, detail).toBeGreaterThanOrEqual(2);
        for (const press of seen.barHeights) expect(press, detail).toBeGreaterThanOrEqual(44);
      }, TAPS);
    }
  }

  it('the till’s own customer half keeps its sizes, at a desk and at phone width', async () => {
    for (const size of [{ width: 1180, height: 820 }, { width: 1680, height: 1050 }, { width: 390, height: 844 }]) {
      const page = await harness!.open('screen=half', size);
      const seen = await pressHeights(page);
      expect(seen, `${size.width}x${size.height}`).toEqual({ language: 34, pills: [], bar: ['Done 38'], barHeights: [38] });
    }
  }, TAPS);
});

/** The age picker's look against the look of the screen its button sits on. */
async function pickerLook(page: Page) {
  await page.locator('button', { hasText: /yrs|Tap to set age/ }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 10_000 });
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')!;
    const trigger = [...document.querySelectorAll('button')].find((b) => /yrs|Tap to set age/.test(b.textContent ?? ''))!;
    const token = (el: Element) => getComputedStyle(el).getPropertyValue('--background').trim();
    const surface = trigger.closest('.dark, .light');
    return { dialog: token(dialog), screen: token(trigger), surface: surface?.classList.contains('dark') ? 'dark' : 'light',
      dialogPaint: getComputedStyle(dialog).backgroundColor };
  });
}

describe.skipIf(!harness)('SCRUM-954 (5): the age picker wears the display’s look', () => {
  for (const screen of ['display', 'half'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      it(`${screen}, ${theme}: the picker is drawn ${theme}, as its screen is`, async () => {
        const size = screen === 'display' ? { width: 600, height: 1024 } : { width: 1180, height: 820 };
        const look = await pickerLook(await harness!.open(`screen=${screen}&step=children&theme=${theme}`, size));
        expect(look.surface).toBe(theme);
        expect(look.dialog, JSON.stringify(look)).toBe(look.screen);
      }, TAPS);
    }
  }

  it('on a dark display the picker is not the light one it was', async () => {
    const dark = await pickerLook(await harness!.open('screen=display&step=children&theme=dark', { width: 600, height: 1024 }));
    const light = await pickerLook(await harness!.open('screen=display&step=children&theme=light', { width: 600, height: 1024 }));
    expect(dark.dialogPaint).not.toBe(light.dialogPaint);
  }, TAPS);
});

describe.skipIf(!harness)('SCRUM-954 (6): the phone till’s form has the phone', () => {
  const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 740 }] as const;
  /** Where an element is once scrolled to, and whether it is what a finger there would touch. */
  async function reachable(page: Page, target: { testId: string } | { name: string }) {
    const found = 'testId' in target ? page.getByTestId(target.testId).first() : page.getByRole('button', { name: target.name, exact: true }).first();
    await found.scrollIntoViewIfNeeded();
    return found.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      // A disabled button takes no touch: what is under it must then be its own bar.
      const holder = (el as HTMLButtonElement).disabled ? el.parentElement! : el;
      return {
        inside: r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
        reached: !!hit && (el.contains(hit) || holder.contains(hit)),
        box: `${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`,
      };
    });
  }

  for (const phone of PHONES) {
    it(`${phone.width}x${phone.height}: the form scrolls in most of the screen, and every press is reachable`, async () => {
      const page = await harness!.open('screen=phone', phone);
      await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
      await page.getByTestId('consent-child-name').waitFor();
      const share = await page.evaluate(() => {
        let scroller = document.querySelector('[data-testid="consent-child-name"]')!.parentElement;
        while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
        const r = scroller!.getBoundingClientRect();
        return { share: scroller!.clientHeight / innerHeight, box: `${Math.round(r.top)}-${Math.round(r.bottom)} of ${innerHeight}`,
          sideways: document.documentElement.scrollWidth > innerWidth };
      });
      // The heading, the bar and "Return phone to staff" left the form under half of a 390x844 phone.
      expect(share.share, share.box).toBeGreaterThan(0.6);
      expect(share.sideways).toBe(false);
      for (const target of [
        { name: 'Start camera' }, { testId: 'consent-contact-confirm' }, { testId: 'consent-missing' },
        { name: 'Done' }, { name: 'Return phone to staff' },
      ]) {
        const where = await reachable(page, target);
        expect(where.inside, `${JSON.stringify(target)} at ${where.box}`).toBe(true);
        expect(where.reached, `${JSON.stringify(target)} at ${where.box}`).toBe(true);
      }
    }, TAPS);
  }
});
