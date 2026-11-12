import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneInput, keypadReadoutSize } from '@/components/shared/PhoneInput';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { COUNTRIES } from '@/data/countries';
import { openMarkupPage, type MarkupPage } from './support/markup-page';

/**
 * SCRUM-880 — A NUMBER TYPED WITH ITS LEADING ZERO FITS ITS BOX.
 *
 * On the customer's first screen the keypad readout is the prototype's
 * `text-3xl tracking-wider` box beside the country picker, in the display's
 * `max-w-md` column (448px: the split view's half at 1440px and a separate
 * display are both wider than that). "+66 0898630041" wrapped onto two lines
 * there and ran out of the box.
 *
 * The readout now keeps to one line (`whitespace-nowrap`) and its type steps
 * down through the till's sizes as the number grows (`keypadReadoutSize`);
 * the prototype's size is kept for "+66" and a nine-digit mobile.
 *
 * Measured in a browser with the till's stylesheet: the real component's
 * markup, every dial-code length the country list has, every number length
 * the keypad accepts (it stops at 15), each typed with the widest digit.
 */

// The components are compiled for a global React; the runner puts globals back after each test.
beforeEach(() => { vi.stubGlobal('React', React); });
// What the keypad accepts (`PhoneInput` hands `NumberKeypad` maxLength 15).
const MAX_DIGITS = 15;
const COLUMN = 448;

function readoutHtml(value: string): string {
  return renderToStaticMarkup(
    React.createElement(LanguageProvider, null,
      React.createElement(PhoneInput, { value, onChange: () => {}, showKeypad: true, label: '' })),
  );
}

describe('SCRUM-880 — the readout size steps', () => {
  it('keeps the prototype size for a Thai mobile without its 0', () => {
    expect(keypadReadoutSize('66', '898630041')).toBe('text-3xl');
    expect(readoutHtml('+66898630041')).toMatch(/h-16 flex-1[^"]*text-3xl/);
  });

  it('steps down for the number typed with its leading 0, and keeps it on one line', () => {
    expect(keypadReadoutSize('66', '0898630041')).toBe('text-2xl');
    const html = readoutHtml('+660898630041');
    expect(html).toMatch(/h-16 flex-1[^"]*text-2xl/);
    expect(html).toContain('<span class="whitespace-nowrap">');
  });

  it('never grows as a number gets longer', () => {
    const order = ['text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl'];
    for (const dial of ['1', '66', '880', '1876']) {
      let last = order.length - 1;
      for (let n = 0; n <= MAX_DIGITS; n++) {
        const step = order.indexOf(keypadReadoutSize(dial, '8'.repeat(n)));
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThanOrEqual(last);
        last = step;
      }
    }
  });
});

const { markup, why } = await openMarkupPage();
if (!markup) console.warn(`SCRUM-880 readout measurement skipped: no browser to lay the page out (${why})`);

describe.skipIf(!markup)('SCRUM-880 — measured: one line, inside the box', () => {
  let page: MarkupPage;
  beforeAll(() => { page = markup!; });
  afterAll(async () => { await markup?.close(); });

  // One country per dial-code length the list carries, the longest first found.
  const dials = [...new Set(COUNTRIES.map((c) => c.dialCode.length))].sort().map(
    (len) => COUNTRIES.find((c) => c.dialCode.length === len)!.dialCode,
  );

  for (const theme of ['light', 'dark'] as const) {
    it(`every dial-code length, every number length (${theme})`, async () => {
      const misfits: string[] = [];
      for (const dial of dials) {
        for (let n = 1; n <= MAX_DIGITS; n++) {
          const value = `+${dial}${'8'.repeat(n)}`;
          await page.place(`<div class="mx-auto w-full max-w-md">${readoutHtml(value)}</div>`, COLUMN, theme);
          const r = await page.page.evaluate(() => {
            const box = document.querySelector('#markup div.h-16.flex-1') as HTMLElement;
            const span = box.querySelector('span.whitespace-nowrap') as HTMLElement | null;
            const style = getComputedStyle(box);
            const b = box.getBoundingClientRect();
            const s = span?.getBoundingClientRect();
            return {
              shown: span?.textContent ?? '',
              lines: s ? Math.round(s.height / parseFloat(style.lineHeight)) : 0,
              room: b.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) - (s?.right ?? Infinity),
              size: style.fontSize,
            };
          });
          if (r.lines !== 1 || r.room < -0.5) misfits.push(`${r.shown} at ${r.size}: ${r.lines} lines, ${r.room.toFixed(1)}px room`);
        }
      }
      expect(misfits).toEqual([]);
    }, 120_000);
  }

  it('the defect: at the prototype size, "+66 0898630041" does not fit', async () => {
    const html = readoutHtml('+660898630041').replace(/(h-16 flex-1[^"]*)text-2xl/, '$1text-3xl').replace('<span class="whitespace-nowrap">', '<span>');
    await page.place(`<div class="mx-auto w-full max-w-md">${html}</div>`, COLUMN);
    const lines = await page.page.evaluate(() => {
      const box = document.querySelector('#markup div.h-16.flex-1') as HTMLElement;
      const span = box.querySelector('span') as HTMLElement;
      return Math.round(span.getBoundingClientRect().height / parseFloat(getComputedStyle(box).lineHeight));
    });
    expect(lines).toBe(2);
  });
});
