import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepPayment } from '@/components/till/StepPayment';
import { lookup } from '@/i18n/dictionary';
import type { SupportedLang } from '@/i18n/types';
import { openMarkupPage, type MarkupPage } from './support/markup-page';

/**
 * SCRUM-882 — THE PAYMENT TILES KEEP THEIR NAMES WHOLE IN THE SPLIT VIEW.
 *
 * At the payment step in the split view (1440x900) the step's panel is about
 * 310px, but the tiles took their columns, padding and type from the WINDOW
 * (`sm:`): three prototype-sized tiles in 310px, with `break-words`, read
 * "Promp / tPay", "Ca / sh", "Car / d", and the tall tiles pushed Confirm
 * Payment Received and Back below the window.
 *
 * Now the step is a container (`@container`, as the customer-type cards
 * are) and the tiles follow the panel: below `@xl` (576px) the phone's two
 * columns and sizes, from `@xl` the prototype's row of three at its sizes.
 * `break-words` is gone, so a name wraps only between words.
 *
 * Measured in a browser with the till's stylesheet, from the real step's
 * markup, with the method names in all five languages the till carries, at
 * the panel widths the till has: the phone (343), the split view at 1440 and
 * 1680 (310, 430), the prototype row's edge (576) and a full-width till.
 */

// The components are compiled for a global React; the runner puts globals back after each test.
beforeEach(() => { vi.stubGlobal('React', React); });

const LANGS: SupportedLang[] = ['en', 'th', 'zh', 'ru', 'fr'];
const names = (lang: SupportedLang) => [
  lookup('common.cash', lang)!,
  lookup('common.card', lang)!,
  lookup('book.payment.promptpayTitle', lang)!,
];
const PANELS = [310, 343, 430, 576, 760, 1000];

const html = () => renderToStaticMarkup(React.createElement(StepPayment, {
  total: 1040, selectedMethod: null, onSelectMethod: () => {}, onComplete: () => {}, onBack: () => {},
}));

describe('SCRUM-882 — the classes', () => {
  it('the step is the container and the tiles key to it, not to the window', () => {
    const markup = html();
    expect(markup).toMatch(/data-testid="payment-step" class="@container /);
    expect(markup).toContain('grid gap-3 @xl:gap-4 grid-cols-2 @xl:grid-cols-3');
    expect(markup).toContain('p-3 @xl:p-6');
    expect(markup).toContain('text-lg @xl:text-2xl');
    expect(markup).not.toMatch(/sm:(grid-cols|p-6|h-20|text-2xl)/);
  });

  it('a method name has no mid-word break opportunity', () => {
    const tile = html().match(/<h3 class="([^"]*)">Cash<\/h3>/);
    expect(tile?.[1]).toBeDefined();
    expect(tile![1]).not.toMatch(/break-words|break-all|wrap-anywhere|hyphens-auto/);
  });
});

const { markup, why } = await openMarkupPage();
if (!markup) console.warn(`SCRUM-882 tile measurement skipped: no browser to lay the page out (${why})`);

describe.skipIf(!markup)('SCRUM-882 — measured: every name whole, every language, every panel', () => {
  let page: MarkupPage;
  beforeAll(() => { page = markup!; });
  afterAll(async () => { await markup?.close(); });

  for (const theme of ['light', 'dark'] as const) {
    it(`the three seeded methods (${theme})`, async () => {
      const broken: string[] = [];
      for (const width of PANELS) {
        for (const lang of LANGS) {
          await page.place(html(), width, theme);
          const read = await page.page.evaluate((labels) => {
            const tiles = Array.from(document.querySelectorAll('#markup .grid h3')) as HTMLElement[];
            tiles.forEach((h, i) => { h.textContent = labels[i] ?? h.textContent; });
            return tiles.map((h) => {
              const lineHeight = parseFloat(getComputedStyle(h).lineHeight);
              return {
                name: h.textContent ?? '',
                lines: Math.round(h.getBoundingClientRect().height / lineHeight),
                overflow: h.scrollWidth - h.clientWidth,
                columns: getComputedStyle(h.parentElement!.parentElement!).gridTemplateColumns.split(' ').length,
              };
            });
          }, names(lang));
          for (const r of read) {
            // A one-word name on one line, never spilling out of its tile.
            if (r.lines !== 1 || r.overflow > 1) broken.push(`${width}px ${lang} "${r.name}": ${r.lines} lines, ${r.overflow}px over`);
          }
          const columns = read[0]!.columns;
          expect(columns, `${width}px`).toBe(width >= 576 ? 3 : 2);
        }
      }
      expect(broken).toEqual([]);
    }, 120_000);
  }

  it('the defect: with the old window-keyed classes, the split view broke the names mid-word', async () => {
    const old = html()
      .replace('grid gap-3 @xl:gap-4 grid-cols-2 @xl:grid-cols-3', 'grid gap-3 gap-4 grid-cols-3')
      .replaceAll('p-3 @xl:p-6', 'p-6')
      .replaceAll('text-lg @xl:text-2xl', 'break-words text-2xl');
    await page.place(old, 310);
    const lines = await page.page.evaluate(() => Array.from(document.querySelectorAll('#markup .grid h3')).map((h) =>
      Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight))));
    expect(Math.max(...lines)).toBeGreaterThan(1);
  });
});
