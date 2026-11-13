import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { lookup } from '@/i18n/dictionary';
import { startFamilyFormHarness } from './support/family-form-harness/server';

/**
 * SCRUM-977 and SCRUM-975 — IN A BROWSER: THE PHONE TILL TURNED ON ITS SIDE,
 * ITS FAMILY FORM ON A SHORT SCREEN, AND THE COUNTER DISPLAY'S LEFTOVERS.
 *
 * 1. A phone till (a finger screen, 390 by 844) turned to 844 by 390 stayed
 *    844 wide and became the desk till: the family's form and the sale went.
 *    The till's own choice (`lib/tillChoice.ts`, as App.tsx's gate reads it)
 *    keeps the phone till on its side and back, the form as typed, the sale's
 *    lines and the step; a 360 by 740 phone too; and a desk window (a mouse)
 *    resized from 1440 to 700 and back with a sale open keeps the desk till
 *    and its lines, while one with nothing open shows the phone till at 700,
 *    as today.
 * 2. On a phone held sideways the family's form had 140 of 360 pixels: it now
 *    has at least half, every word of "Still needed" whole beside Done; the
 *    upright phone keeps its bars as they were.
 * 7. The returning family's "Ask the team to remove a child" reads on a dark
 *    display (it was about 1.9 to 1) and is the red it was on a light one;
 *    the "new child" badge reads on a light display (about 3 to 1) and is the
 *    primary it was on a dark one.
 * 8. The form's first line never runs under the language button, in any of
 *    the five languages, at 600 and at 1024 wide.
 * 11. The form's reconnecting line is one line at 600 wide in all five.
 *
 * Measured lines load the till's own fonts (`&fonts=1`), so they read the
 * same on Linux. Needs a browser: Edge, Chrome or Playwright's Chromium.
 */

const { harness, why } = await startFamilyFormHarness();
if (!harness) console.warn(`SCRUM-977 phone turn review skipped: no browser (${why})`);
afterAll(async () => { await harness?.close(); });

const TAPS = 60_000;
const LANGS = ['en', 'th', 'zh', 'ru', 'fr'] as const;
const NATIVE: Record<(typeof LANGS)[number], string> = { en: 'English', th: 'ไทย', zh: '中文', ru: 'Русский', fr: 'Français' };
const word = (key: string, lang: (typeof LANGS)[number] = 'en') => lookup(key, lang)!;

const tillKind = (page: Page) => page.locator('[data-till]').getAttribute('data-till');
const fontsReady = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => document.fonts.status));

/** What the phone's form holds, as the till has it and as it is drawn. */
async function phoneForm(page: Page) {
  return page.evaluate(() => {
    const till = JSON.parse(document.querySelector('#till')!.textContent!) as { slots: { name: string }[]; parentName: string };
    const field = document.querySelector<HTMLInputElement>('[data-testid="consent-child-name"]');
    return {
      field: field?.value ?? null, tillName: till.slots[0]!.name,
      sale: [...document.querySelectorAll('[data-testid="phone-sale"] li')].map((li) => li.textContent),
      // The step: the form is handed over (the customer's screen), on its first step.
      handedOver: !!field && [...document.querySelectorAll('button')].some((b) => b.textContent === 'Return phone to staff'),
    };
  });
}

describe.skipIf(!harness)('SCRUM-977 (1): which till a device shows does not change when it is turned', () => {
  it('a finger screen and its own size: the pointer is coarse and the screen is the window, as on a phone', async () => {
    const page = await harness!.open('screen=turn', { width: 390, height: 844 });
    const seen = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, w: screen.width, h: screen.height }));
    expect(seen).toEqual({ coarse: true, w: 390, h: 844 });
  }, TAPS);

  for (const phone of [{ width: 390, height: 844 }, { width: 360, height: 740 }] as const) {
    it(`${phone.width}x${phone.height} turned on its side and back: the phone till, the form as typed, the sale and the step`, async () => {
      const page = await harness!.open('screen=turn', phone);
      expect(await tillKind(page)).toBe('phone');
      await page.getByRole('button', { name: 'Ring up', exact: true }).click();
      await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
      await page.getByTestId('consent-child-name').fill('ZZ TEST Turn');
      await expect.poll(async () => (await phoneForm(page)).tillName).toBe('ZZ TEST Turn');
      const before = await phoneForm(page);
      expect(before.handedOver).toBe(true);
      expect(before.sale).toHaveLength(2);
      // On its side: the screen turns with the window, as a phone's does.
      await page.setViewportSize({ width: phone.height, height: phone.width });
      await page.waitForTimeout(300);
      expect(await tillKind(page)).toBe('phone');
      expect(await phoneForm(page)).toEqual(before);
      // And back upright.
      await page.setViewportSize(phone);
      await page.waitForTimeout(300);
      expect(await tillKind(page)).toBe('phone');
      expect(await phoneForm(page)).toEqual(before);
    }, TAPS);
  }

  it('a desk window (a mouse) resized from 1440 to 700 and back with a sale open keeps the desk till and its lines', async () => {
    const page = await harness!.open('screen=turn', { width: 1440, height: 900 }, { touch: false });
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
    expect(await tillKind(page)).toBe('desk');
    await page.getByRole('button', { name: 'Add a line', exact: true }).click();
    await page.getByRole('button', { name: 'Add a line', exact: true }).click();
    await expect.poll(() => page.getByTestId('desk-line').count()).toBe(2);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.waitForTimeout(300);
    expect(await tillKind(page)).toBe('desk');
    expect(await page.getByTestId('desk-line').allTextContents()).toEqual(['ZZ TEST desk line 1', 'ZZ TEST desk line 2']);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    expect(await tillKind(page)).toBe('desk');
    expect(await page.getByTestId('desk-line').count()).toBe(2);
  }, TAPS);

  it('a desk window with nothing open shows the phone till at 700, as today, and the desk till again at 1440', async () => {
    const page = await harness!.open('screen=turn', { width: 1440, height: 900 }, { touch: false });
    expect(await tillKind(page)).toBe('desk');
    await page.setViewportSize({ width: 700, height: 900 });
    await expect.poll(() => tillKind(page)).toBe('phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => tillKind(page)).toBe('desk');
  }, TAPS);
});

/** The phone form's scrolling part, its two bars and its Still needed line, as drawn. */
async function phoneBars(page: Page) {
  return page.evaluate(() => {
    let scroller = document.querySelector('[data-testid="consent-child-name"]')!.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
    const done = document.querySelector('[data-testid="consent-done-bar"]')!;
    const line = document.querySelector<HTMLElement>('[data-testid="consent-missing"]')!;
    const doneButton = [...done.querySelectorAll('button')].find((b) => b.textContent === 'Done')!;
    const back = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Return phone to staff')!;
    const box = (el: Element) => el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(line);
    const words = range.getBoundingClientRect();
    const reach = (el: Element) => {
      const r = box(el);
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return r.top >= -1 && r.bottom <= innerHeight + 1 && !!hit && (el.contains(hit) || el.parentElement!.contains(hit));
    };
    return {
      share: scroller!.clientHeight / innerHeight,
      lineWhole: line.scrollWidth <= line.clientWidth + 1 && line.scrollHeight <= line.clientHeight + 1
        && words.left >= box(line).left - 1 && words.right <= box(line).right + 1,
      lineText: line.textContent,
      lineBesideDone: box(line).right <= box(doneButton).left + 1 && box(line).bottom > box(doneButton).top,
      lineAboveDone: box(line).bottom <= box(doneButton).top + 1,
      doneReached: reach(doneButton), backReached: reach(back),
      backHeight: Math.round(box(back).height), backBar: Math.round(box(back.parentElement!).height),
      doneBarPadding: getComputedStyle(done).paddingTop,
      detail: `scroller ${Math.round(scroller!.clientHeight)} of ${innerHeight}; done bar ${Math.round(box(done).height)}; back bar ${Math.round(box(back.parentElement!).height)}`,
    };
  });
}

describe.skipIf(!harness)('SCRUM-977 (2): the sideways phone’s form has at least half the screen', () => {
  for (const shape of [{ width: 740, height: 360 }, { width: 844, height: 390 }] as const) {
    it(`${shape.width}x${shape.height}: half the height or more, "Still needed" whole beside Done, both bars reachable`, async () => {
      const page = await harness!.open('screen=phone&fonts=1', shape);
      await fontsReady(page);
      await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
      await page.getByTestId('consent-child-name').waitFor();
      const seen = await phoneBars(page);
      expect(seen.share, seen.detail).toBeGreaterThanOrEqual(0.5);
      expect(seen.lineWhole, seen.detail).toBe(true);
      expect(seen.lineText?.length).toBeGreaterThan(10);
      expect(seen.lineBesideDone, seen.detail).toBe(true);
      expect(seen.doneReached).toBe(true);
      expect(seen.backReached).toBe(true);
    }, TAPS);
  }

  it('390x844 upright: the bars as they were: the line over Done on its own row, the hand-back button 56 in its 16-pixel bar', async () => {
    const page = await harness!.open('screen=phone&fonts=1', { width: 390, height: 844 });
    await fontsReady(page);
    await page.getByRole('button', { name: 'Customer is ready', exact: true }).click();
    await page.getByTestId('consent-child-name').waitFor();
    const seen = await phoneBars(page);
    expect(seen.lineAboveDone, seen.detail).toBe(true);
    expect(seen.backHeight).toBe(56);
    // p-4 round the button, and the bar's top border.
    expect(seen.backBar).toBe(56 + 32 + 1);
    // The narrow bar's own padding (NARROW_BAR, py-3), not the short screen's.
    expect(seen.doneBarPadding).toBe('12px');
  }, TAPS);
});

/** WCAG contrast of two painted sRGB colours. */
const ratio = (a: number[], b: number[]) => {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** The review's remove line and new badge: their ink laid on their card, read back through a canvas. */
async function reviewInks(page: Page, removeWords: string, newWords: string) {
  const seen = await page.evaluate(([remove, fresh]) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const paint = (layers: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const colour of layers) { ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); }
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const screenPaint = document.querySelector('.dark') ? '#020617' : '#ffe2cc';
    const read = (el: Element) => {
      const card = el.closest('[data-testid="saved-child-review-card"]')!;
      const layers = [screenPaint, getComputedStyle(card).backgroundColor];
      for (let at: Element | null = el; at && at !== card; at = at.parentElement) layers.splice(2, 0, getComputedStyle(at).backgroundColor);
      const back = paint(layers);
      return { back, ink: paint([`rgb(${back.join(',')})`, getComputedStyle(el).color]), colour: getComputedStyle(el).color };
    };
    const removeButton = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === remove)!;
    const badge = [...document.querySelectorAll('div')].find((d) => d.textContent?.trim() === fresh && d.querySelector('svg'))!;
    const probe = (cls: string) => {
      const span = document.createElement('span');
      span.className = cls;
      removeButton.parentElement!.append(span);
      const colour = getComputedStyle(span).color;
      span.remove();
      return colour;
    };
    return { remove: read(removeButton), fresh: read(badge), destructive: probe('text-destructive'), primary: probe('text-primary') };
  }, [removeWords, newWords] as const);
  return { ...seen, removeRatio: ratio(seen.remove.ink, seen.remove.back), newRatio: ratio(seen.fresh.ink, seen.fresh.back) };
}

describe.skipIf(!harness)('SCRUM-975 (7): the returning family’s remove line and new badge read on both looks', () => {
  const remove = word('childReview.askRemove');
  const fresh = word('childReview.chooseOrAsk');
  it('dark: "Ask the team to remove a child" reads (4.5 to 1 or more); the new badge is the primary it was', async () => {
    const page = await harness!.open('screen=review&theme=dark&newChild=1', { width: 600, height: 1024 });
    const seen = await reviewInks(page, remove, fresh);
    expect(seen.removeRatio, JSON.stringify(seen)).toBeGreaterThanOrEqual(4.5);
    expect(seen.fresh.colour).toBe(seen.primary);
  }, TAPS);

  it('light: the new badge reads (4.5 to 1 or more); "Ask the team to remove a child" is the red it was', async () => {
    const page = await harness!.open('screen=review&theme=light&newChild=1', { width: 600, height: 1024 });
    const seen = await reviewInks(page, remove, fresh);
    expect(seen.newRatio, JSON.stringify(seen)).toBeGreaterThanOrEqual(4.5);
    expect(seen.remove.colour).toBe(seen.destructive);
  }, TAPS);
});

/** Chooses a language on the display's form with its own button. */
async function choose(page: Page, from: (typeof LANGS)[number], to: (typeof LANGS)[number]) {
  if (from === to) return;
  await page.getByRole('button', { name: word('common.changeLanguage', from), exact: true }).click();
  await page.getByRole('button', { name: NATIVE[to], exact: true }).click();
  await page.getByRole('button', { name: word('common.changeLanguage', to), exact: true }).waitFor();
}

describe.skipIf(!harness)('SCRUM-975 (8): the form’s first line never runs under the language button', () => {
  for (const shape of [{ width: 600, height: 1024 }, { width: 1024, height: 600 }] as const) {
    it(`${shape.width}x${shape.height}: in all five languages the line's words are clear of the button`, async () => {
      const page = await harness!.open('screen=display&step=children&fonts=1', shape);
      await fontsReady(page);
      let at: (typeof LANGS)[number] = 'en';
      for (const lang of LANGS) {
        await choose(page, at, lang);
        at = lang;
        const seen = await page.evaluate(([line, label]) => {
          const span = [...document.querySelectorAll('span')].find((s) => s.textContent === line)!;
          const button = document.querySelector(`[aria-label="${label}"]`)!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(span);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0);
          const under = rects.some((r) => !(r.right <= button.left || button.right <= r.left || r.bottom <= button.top || button.bottom <= r.top));
          return { under, lines: new Set(rects.map((r) => Math.round(r.top))).size,
            detail: `button ${Math.round(button.left)}-${Math.round(button.right)}; words ${rects.map((r) => `${Math.round(r.left)}-${Math.round(r.right)}@${Math.round(r.top)}`).join(' ')}` };
        }, [word('superviseConsent.playingToday', lang), word('common.changeLanguage', lang)] as const);
        expect(seen.under, `${lang}: ${seen.detail}`).toBe(false);
        // Only the French wraps, and only on the counter display standing.
        expect(seen.lines, `${lang}: ${seen.detail}`).toBe(lang === 'fr' && shape.width === 600 ? 2 : 1);
      }
    }, TAPS);
  }
});

describe.skipIf(!harness)('SCRUM-975 (11): the form’s reconnecting line is one line at 600 wide', () => {
  it('in all five languages, and still clear of the language button', async () => {
    const page = await harness!.open('screen=display&step=agreements&reconnecting=1&fonts=1', { width: 600, height: 1024 });
    await fontsReady(page);
    let at: (typeof LANGS)[number] = 'en';
    for (const lang of LANGS) {
      await choose(page, at, lang);
      at = lang;
      await expect.poll(() => page.getByTestId('display-form-reconnecting').textContent()).toBe(word('display.reconnectingSendsItself', lang));
      const seen = await page.evaluate((label) => {
        const line = document.querySelector('[data-testid="display-form-reconnecting"]')!;
        const button = document.querySelector(`[aria-label="${label}"]`)!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(line);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        return {
          lines: new Set(rects.map((r) => Math.round(r.top))).size,
          over: rects.some((r) => !(r.right <= button.left || button.right <= r.left || r.bottom <= button.top || button.bottom <= r.top)),
          detail: rects.map((r) => `${Math.round(r.left)}-${Math.round(r.right)}@${Math.round(r.top)}`).join(' '),
        };
      }, word('common.changeLanguage', lang));
      expect(seen.lines, `${lang}: ${seen.detail}`).toBe(1);
      expect(seen.over, `${lang}: ${seen.detail}`).toBe(false);
    }
  }, TAPS);
});
