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
 * SCRUM-963, at the end: the real display page with its connection dropped
 * and a language chosen (1); the language list's and the returning family's
 * badges' contrast at both looks (2, 3); the finger-sized presses (4); the
 * number box clear of the language button (5); the phone's gate (6) and a
 * phone held sideways (7).
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

// --- SCRUM-963: the family's form after its second proof (points 2 to 4 of SCRUM-962) -------------

/** The stand-in box behind `?screen=paired` (`support/family-form-harness/station.ts`). */
interface Boxed {
  __zzBox: { document: { language: string; prompt: { slots?: { allergiesMedical: string }[] } }; heard: { type: string }[]; drop: () => void; restore: () => void };
}
const held = (page: Page) => page.evaluate(() => {
  const box = (window as unknown as Boxed).__zzBox;
  return { language: box.document.language, allergies: box.document.prompt.slots?.[0]?.allergiesMedical ?? '', heard: box.heard.map((intent) => intent.type) };
});
/** What the paired display shows round its form: a bar above it, a lock on it, a line under it. */
const formState = (page: Page) => page.evaluate(() => ({
  alerts: document.querySelectorAll('[role="alert"]').length,
  locked: !!document.querySelector('[data-testid="display-consent"]')?.closest('[inert]'),
  waitLine: !!document.querySelector('[data-testid="display-consent-wait"]'),
}));

describe.skipIf(!harness)('SCRUM-963 (1): a language chosen while the display reconnects leaves the form open', () => {
  it('the counter display standing: no Retry bar, nothing locked or moved, and it goes by itself when the line returns', async () => {
    const page = await harness!.open('screen=paired&keyboard=screen&step=care&theme=dark', { width: 600, height: 1024 });
    await page.getByTestId('consent-allergies').waitFor({ timeout: 20_000 });
    const before = await headingTop(page);
    // The line drops, as the proof dropped it.
    await page.evaluate(() => (window as unknown as Boxed).__zzBox.drop());
    await page.getByTestId('display-form-reconnecting').waitFor({ timeout: 10_000 });
    // The family chooses Thai: the screen is in Thai at once.
    await page.getByRole('button', { name: LANGUAGE_BUTTON.en, exact: true }).click();
    await page.getByRole('button', { name: 'ไทย', exact: true }).click();
    await expect.poll(() => page.getByTestId('display-form-reconnecting').textContent()).toContain('กำลังเชื่อมต่อใหม่');
    // The send failed against the dropped line by now (picture 06a's moment).
    await page.waitForTimeout(1_500);
    expect(await formState(page)).toEqual({ alerts: 0, locked: false, waitLine: false });
    expect(await headingTop(page)).toBe(before);
    // A box still takes a press: the allergies box opens its keys and takes a letter.
    await page.getByTestId('consent-allergies').click();
    await expect.poll(() => keys(page).count()).toBe(1);
    await type(page, 'X');
    await expect.poll(() => page.getByTestId('consent-allergies').inputValue()).toMatch(/x/i);
    expect((await held(page)).language).toBe('en');
    // The line returns: the box is told the language, then takes what was typed.
    await page.evaluate(() => (window as unknown as Boxed).__zzBox.restore());
    await expect.poll(async () => (await held(page)).language, { timeout: 10_000 }).toBe('th');
    await expect.poll(async () => (await held(page)).allergies, { timeout: 10_000 }).toMatch(/x/i);
    await expect.poll(() => page.getByTestId('display-form-reconnecting').count(), { timeout: 5_000 }).toBe(0);
    expect(await formState(page)).toEqual({ alerts: 0, locked: false, waitLine: false });
    const heard = (await held(page)).heard;
    expect(heard.indexOf('display.set_language')).toBeGreaterThanOrEqual(0);
    expect(heard.indexOf('display.set_language')).toBeLessThan(heard.indexOf('display.consent'));
  }, TAPS);
});

/**
 * The language list as drawn: the list's paint, and each choice's ink laid on
 * its own paint over the list's, read back through a canvas so any colour the
 * browser computes (oklch, a colour mix) is the sRGB it puts on the screen.
 */
async function languageList(page: Page) {
  await page.getByRole('button', { name: LANGUAGE_BUTTON.en, exact: true }).click();
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const paint = (layers: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const colour of layers) { ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); }
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const css = (c: number[]) => `rgb(${c.join(',')})`;
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi! + 0.05) / (lo! + 0.05); };
    const pill = document.querySelector('[aria-label="Change language"]')!;
    const list = pill.nextElementSibling!;
    const listPaint = paint(['#ffffff', getComputedStyle(list).backgroundColor]);
    // The screen's own primary, read in the list (where the chosen language used to take it).
    const probe = document.createElement('span');
    probe.className = 'text-primary';
    list.append(probe);
    const primary = paint([css(listPaint), getComputedStyle(probe).color]);
    probe.remove();
    return {
      list: listPaint, primary,
      choices: Array.from(list.querySelectorAll('button')).map((choice) => {
        const style = getComputedStyle(choice);
        const back = paint([css(listPaint), style.backgroundColor]);
        const ink = paint([css(back), style.color]);
        return { text: choice.textContent!.trim(), ratio: Math.round(ratio(ink, back) * 100) / 100, back, ink,
          height: Math.round(choice.getBoundingClientRect().height * 10) / 10 };
      }),
    };
  });
}

/** A colour as this browser paints it, on white. */
const painted = (page: Page, colour: string) => page.evaluate((value) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
  return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
}, colour);
const tailwindColour = (name: string) => readFileSync(path.resolve(import.meta.dirname, '../node_modules/tailwindcss/theme.css'), 'utf8')
  .match(new RegExp(`--color-${name}: ([^;]+);`))![1]!;

describe.skipIf(!harness)('SCRUM-963 (2): the language list reads on the display’s look, light and dark', () => {
  for (const screen of ['display', 'half'] as const) {
    const size = screen === 'display' ? { width: 600, height: 1024 } : { width: 1180, height: 820 };
    it(`${screen}, light: every language reads on the list, the chosen one still marked`, async () => {
      const seen = await languageList(await harness!.open(`screen=${screen}&step=children&theme=light`, size));
      const detail = JSON.stringify(seen);
      expect(seen.choices.map((c) => c.text)).toEqual(['English', '中文', 'ไทย', 'Русский', 'Français']);
      for (const choice of seen.choices) expect(choice.ratio, `${choice.text}: ${detail}`).toBeGreaterThanOrEqual(4.5);
      const [chosen, ...others] = seen.choices;
      for (const other of others) expect(other.back, detail).not.toEqual(chosen!.back);
      // A light list on a light display, not the navy one of picture 04c.
      expect(seen.list.every((v) => v > 200), detail).toBe(true);
    }, TAPS);

    it(`${screen}, dark: the list as it always was — slate-900, the chosen language in primary`, async () => {
      const page = await harness!.open(`screen=${screen}&step=children&theme=dark`, size);
      const seen = await languageList(page);
      const detail = JSON.stringify(seen);
      expect(seen.list, detail).toEqual(await painted(page, tailwindColour('slate-900')));
      const [chosen, ...others] = seen.choices;
      expect(chosen!.ink, detail).toEqual(seen.primary);
      for (const other of others) expect(other.ratio, `${other.text}: ${detail}`).toBeGreaterThanOrEqual(4.5);
    }, TAPS);
  }

  it('the display’s form has its choices a finger’s height; the till’s own half keeps 40', async () => {
    for (const shape of SHAPES) {
      const seen = await languageList(await harness!.open('screen=display&keyboard=screen&step=children', shape));
      for (const choice of seen.choices) expect(choice.height, `${shape.name}: ${choice.text}`).toBeGreaterThanOrEqual(44);
    }
    const half = await languageList(await harness!.open('screen=half', { width: 1180, height: 820 }));
    expect(half.choices.map((c) => c.height)).toEqual([40, 40, 40, 40, 40]);
  }, TAPS);
});

/** The two badges of the returning family's review, their ink on what lies under them. */
async function reviewBadges(page: Page) {
  await page.getByText('Confirmed', { exact: true }).waitFor({ timeout: 10_000 });
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const paint = (layers: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const colour of layers) { ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); }
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi! + 0.05) / (lo! + 0.05); };
    // The darkest stop of the light screen's cream gradient, and the dark one's.
    const screenPaint = document.querySelector('.dark') ? '#020617' : '#ffe2cc';
    const read = (words: string) => {
      const badge = Array.from(document.querySelectorAll('div')).find((el) => el.textContent?.trim() === words && el.querySelector('svg'))!;
      const card = badge.closest('[data-testid="saved-child-review-card"]')!;
      const back = paint([screenPaint, getComputedStyle(card).backgroundColor, getComputedStyle(badge).backgroundColor]);
      const ink = paint([`rgb(${back.join(',')})`, getComputedStyle(badge).color]);
      return { ratio: Math.round(ratio(ink, back) * 100) / 100, ink, colour: getComputedStyle(badge).color };
    };
    return { check: read('Saved — still correct?'), done: read('Confirmed') };
  });
}

describe.skipIf(!harness)('SCRUM-963 (3): the returning family’s badges', () => {
  it('read on a light display (picture 04h)', async () => {
    const seen = await reviewBadges(await harness!.open('screen=review&theme=light', { width: 600, height: 1024 }));
    expect(seen.check.ratio, JSON.stringify(seen)).toBeGreaterThanOrEqual(4.5);
    expect(seen.done.ratio, JSON.stringify(seen)).toBeGreaterThanOrEqual(4.5);
  }, TAPS);

  it('are amber-300 and emerald-300 on a dark display, as before', async () => {
    const page = await harness!.open('screen=review&theme=dark', { width: 600, height: 1024 });
    const seen = await reviewBadges(page);
    const drawn = await page.evaluate((colours) => colours.map((colour) => {
      const probe = document.createElement('span');
      probe.style.color = colour;
      document.body.append(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      return computed;
    }), [tailwindColour('amber-300'), tailwindColour('emerald-300')]);
    expect([seen.check.colour, seen.done.colour]).toEqual(drawn);
  }, TAPS);
});

/** The age picker's own presses: its close, its crumbs and (after an age) its back. */
async function pickerPresses(page: Page) {
  await page.locator('button', { hasText: /yrs|Tap to set age/ }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 10_000 });
  // Read once the dialog has finished opening (it zooms in from 95 per cent).
  const settled = () => page.waitForFunction(() => document.querySelector('[role="dialog"]')!.getAnimations({ subtree: true })
    .every((animation) => animation.playState === 'finished'), null, { timeout: 10_000 });
  const read = async () => { await settled(); return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')!;
    const close = dialog.lastElementChild!;
    const header = dialog.firstElementChild!;
    const crumbs = Array.from(header.querySelectorAll(':scope > div button'));
    const back = header.querySelector('[aria-label="Back"]');
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 }; };
    const d = dialog.getBoundingClientRect();
    return { close: box(close), crumbs: crumbs.map(box), back: back ? box(back) : null, inWindow: d.top >= 0 && d.bottom <= innerHeight };
  }); };
  const atAge = await read();
  await page.getByRole('dialog').getByRole('button', { name: '6', exact: true }).click();
  const atMonth = await read();
  return { atAge, atMonth };
}

const channelHeights = (page: Page) => page.evaluate(() => ['WhatsApp', 'Telegram', 'LINE']
  .map((name) => Math.round(document.querySelector(`button[title="${name}"]`)!.getBoundingClientRect().height * 10) / 10));

describe.skipIf(!harness)('SCRUM-963 (4): a finger’s presses on the display’s form', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: the age picker’s close, crumbs and back are 44 pixels or more, and it fits the screen`, async () => {
      const seen = await pickerPresses(await harness!.open('screen=display&keyboard=screen&step=children&theme=light', shape));
      const detail = JSON.stringify(seen);
      for (const step of [seen.atAge, seen.atMonth]) {
        expect(step.close.width, detail).toBeGreaterThanOrEqual(44);
        expect(step.close.height, detail).toBeGreaterThanOrEqual(44);
        expect(step.crumbs, detail).toHaveLength(3);
        for (const crumb of step.crumbs) {
          expect(crumb.height, detail).toBeGreaterThanOrEqual(44);
          expect(crumb.width, detail).toBeGreaterThanOrEqual(44);
        }
        expect(step.inWindow, detail).toBe(true);
      }
      expect(seen.atMonth.back!.height, detail).toBeGreaterThanOrEqual(44);
      expect(seen.atMonth.back!.width, detail).toBeGreaterThanOrEqual(44);
    }, TAPS);

    it(`${shape.name}: WhatsApp, Telegram and LINE are 44 pixels tall`, async () => {
      const heights = await channelHeights(await harness!.open('screen=display&keyboard=screen&step=agreements', shape));
      for (const height of heights) expect(height, JSON.stringify(heights)).toBeGreaterThanOrEqual(44);
    }, TAPS);
  }

  it('the phone till’s form draws the channel pills 44 pixels tall too', async () => {
    const page = await harness!.open('screen=phone', { width: 390, height: 844 });
    await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
    await page.locator('button[title="WhatsApp"]').waitFor();
    const heights = await channelHeights(page);
    for (const height of heights) expect(height, JSON.stringify(heights)).toBeGreaterThanOrEqual(44);
  }, TAPS);

  it('the till’s own customer half at a desk keeps its sizes: crumbs 28, the close 16, back 36, the pills 28', async () => {
    const page = await harness!.open('screen=half', { width: 1180, height: 820 });
    expect(await channelHeights(page)).toEqual([28, 28, 28]);
    const seen = await pickerPresses(page);
    expect(seen.atAge.close).toEqual({ width: 16, height: 16 });
    expect(seen.atAge.crumbs.map((c) => c.height)).toEqual([28, 28, 28]);
    expect(seen.atMonth.back).toEqual({ width: 36, height: 36 });
  }, TAPS);
});

/**
 * The phone number box against the language button on the display's first
 * screen, at every place the screen can be scrolled to: the part of the box
 * on screen never meets the button.
 */
async function numberBoxClear(page: Page) {
  return page.evaluate(() => {
    const box = Array.from(document.querySelectorAll('div')).find((el) => el.classList.contains('h-16') && el.textContent?.includes('8X XXX XXXX'))!;
    const button = document.querySelector('[aria-label="Change language"]')!;
    let scroller = box.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
    const was = scroller!.scrollTop;
    const end = scroller!.scrollHeight - scroller!.clientHeight;
    const overlaps: string[] = [];
    for (let at = 0; at <= end + 8; at += 8) {
      scroller!.scrollTop = Math.min(at, end);
      const s = scroller!.getBoundingClientRect();
      const r = box.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      const top = Math.max(r.top, s.top);
      const bottom = Math.min(r.bottom, s.bottom);
      if (bottom <= top) continue;
      const meets = Math.min(r.right, b.right) - Math.max(r.left, b.left) > 0.5 && Math.min(bottom, b.bottom) - Math.max(top, b.top) > 0.5;
      if (meets) overlaps.push(`scrolled ${scroller!.scrollTop}: box ${Math.round(r.left)},${Math.round(top)}-${Math.round(r.right)},${Math.round(bottom)} button ${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}`);
    }
    scroller!.scrollTop = was;
    return { overlaps, scrolls: end > 0 };
  });
}

describe.skipIf(!harness)('SCRUM-963 (5): the language button clear of the number box on the first screen', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: with the keys closed and open, scrolled anywhere`, async () => {
      const page = await harness!.open('screen=paired&doc=identify&keyboard=screen&theme=dark', shape);
      await page.getByTestId('language-choice-en').click({ timeout: 20_000 });
      const nickname = page.getByPlaceholder('e.g. Mama, John');
      await nickname.waitFor();
      expect((await numberBoxClear(page)).overlaps).toEqual([]);
      await nickname.click();
      await expect.poll(() => keys(page).count()).toBe(1);
      const open = await numberBoxClear(page);
      expect(open.overlaps).toEqual([]);
      // With the keys open the screen does scroll, so every place was tried.
      expect(open.scrolls).toBe(true);
    }, TAPS);
  }
});

describe.skipIf(!harness)('SCRUM-963 (6): the phone till’s gate gives the child’s name its room', () => {
  for (const phone of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    it(`${phone.width}x${phone.height}: the whole name shows, the card is whole on screen, Back and Continue reachable`, async () => {
      const page = await harness!.open('screen=gate', phone);
      await page.getByPlaceholder("Child's name").fill('ZZ TEST PHONE P');
      const seen = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('input[placeholder="Child\'s name"]')!;
        const card = input.closest('.rounded-2xl')!;
        const r = card.getBoundingClientRect();
        let clipped = '';
        for (let at = card.parentElement; at; at = at.parentElement) {
          const style = getComputedStyle(at);
          if (style.overflowY === 'visible' && style.overflowX === 'visible') continue;
          const box = at.getBoundingClientRect();
          if (r.top < box.top - 1 || r.bottom > box.bottom + 1) clipped = `card ${Math.round(r.top)}-${Math.round(r.bottom)} cut at ${Math.round(box.top)}-${Math.round(box.bottom)}`;
        }
        const reach = (name: string) => {
          const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === name)!;
          const b = button.getBoundingClientRect();
          const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
          return b.bottom <= innerHeight + 1 && b.top >= 0 && !!hit && (button.contains(hit) || button.parentElement!.contains(hit));
        };
        return { fits: input.scrollWidth <= input.clientWidth, width: Math.round(input.clientWidth), clipped,
          back: reach('Back'), go: reach('Continue to payment'), sideways: document.documentElement.scrollWidth > innerWidth };
      });
      expect(seen.fits, `input ${seen.width}px`).toBe(true);
      expect(seen.clipped).toBe('');
      expect(seen.back).toBe(true);
      expect(seen.go).toBe(true);
      expect(seen.sideways).toBe(false);
    }, TAPS);
  }

  it('the counter till’s gate is as before: the name and the 144-pixel age button on one row', async () => {
    const page = await harness!.open('screen=gate&desk=1', { width: 1440, height: 900 });
    const seen = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="Child\'s name"]')!.getBoundingClientRect();
      const age = Array.from(document.querySelectorAll('button')).find((b) => /yrs|Tap to set age/.test(b.textContent ?? ''))!.getBoundingClientRect();
      return { sameRow: Math.abs(input.top + input.height / 2 - (age.top + age.height / 2)) < 2, ageWidth: Math.round(age.width) };
    });
    expect(seen).toEqual({ sameRow: true, ageWidth: 144 });
  }, TAPS);
});

describe.skipIf(!harness)('SCRUM-963 (7): a phone held sideways lets the heading scroll away', () => {
  it('844x390: the form has most of the screen, and the heading leaves it as the family scrolls', async () => {
    const page = await harness!.open('screen=phone', { width: 844, height: 390 });
    await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
    await page.getByTestId('consent-child-name').waitFor();
    const seen = await page.evaluate(() => {
      let scroller = document.querySelector('[data-testid="consent-child-name"]')!.parentElement;
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
      const heading = Array.from(document.querySelectorAll('span')).find((span) => span.textContent === 'Playing with us today')!;
      const room = scroller!.clientHeight;
      scroller!.scrollTop = scroller!.scrollHeight;
      const gone = heading.getBoundingClientRect().bottom <= scroller!.getBoundingClientRect().top + 1;
      return { room, gone, sideways: document.documentElement.scrollWidth > innerWidth };
    });
    // The heading stood and left the form 50 pixels.
    expect(seen.room).toBeGreaterThanOrEqual(150);
    expect(seen.gone).toBe(true);
    expect(seen.sideways).toBe(false);
  }, TAPS);
});
