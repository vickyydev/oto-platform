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
    // Below @xl the amount, Back and Confirm tighten so Confirm stays on screen.
    expect(markup).toContain('mb-4 @xl:mb-8 text-center');
    expect(markup).toContain('sm:w-24 @xl:w-32');
    expect(markup).toContain('px-4 @xl:px-8 whitespace-normal text-lg @xl:text-xl');
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
  // Closing the browser and the dev server can take a while on a loaded machine.
  afterAll(async () => { await markup?.close(); }, 60_000);

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

  it('Confirm Payment Received reads on two lines beside Back in the split view panel', async () => {
    await page.place(html(), 310);
    const confirm = await page.page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('#markup button')).find((b) => /Confirm Payment Received/.test(b.textContent ?? '')) as HTMLElement;
      const back = Array.from(document.querySelectorAll('#markup button')).find((b) => b.textContent?.trim() === 'Back') as HTMLElement;
      const style = getComputedStyle(button);
      const text = button.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      return { lines: Math.round(text / parseFloat(style.lineHeight)), sameRow: button.getBoundingClientRect().left >= back.getBoundingClientRect().right };
    });
    expect(confirm).toEqual({ lines: 2, sameRow: true });
  });

  // SCRUM-912 — CI's Linux Chromium broke "พร้อมเพย์" onto two lines at 576px:
  // its runner has no Thai font, so Thai came from whatever the system found.
  // The till now draws Thai from its own face ('Till Thai', src/fonts.css), so
  // the platform's fonts are never asked: the label lays out exactly as it
  // does when the page is told to use that face and nothing else.
  it('Thai is drawn from the till\'s own face, whatever Thai font the platform has (SCRUM-912)', async () => {
    await page.place(html(), 576);
    const read = await page.page.evaluate(async (label) => {
      const tile = Array.from(document.querySelectorAll('#markup .grid h3'))[2] as HTMLElement;
      tile.textContent = label;
      await document.fonts.load(`700 24px 'Till Thai'`, label);
      await document.fonts.ready;
      const measure = () => {
        const probe = document.createElement('span');
        probe.textContent = label;
        probe.style.cssText = 'white-space:nowrap;font:inherit;position:absolute;visibility:hidden';
        tile.appendChild(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      };
      const stack = getComputedStyle(tile).fontFamily;
      const asShown = measure();
      tile.style.fontFamily = `'Till Thai'`;
      const tillFaceOnly = measure();
      tile.style.fontFamily = '';
      const faces = Array.from(document.fonts)
        .filter((f) => f.family.replace(/["']/g, '') === 'Till Thai')
        .map((f) => `${f.weight} ${f.status}`)
        .sort();
      const lines = Math.round(tile.getBoundingClientRect().height / parseFloat(getComputedStyle(tile).lineHeight));
      return { stack, asShown, tillFaceOnly, faces, lines, overflow: tile.scrollWidth - tile.clientWidth };
    }, lookup('book.payment.promptpayTitle', 'th')!);
    expect(read.stack).toMatch(/^Inter, "?Till Thai"?, sans-serif$/);
    expect(read.faces).toContain('700 loaded');
    expect(read.asShown).toBeCloseTo(read.tillFaceOnly, 1);
    expect(read).toMatchObject({ lines: 1 });
    expect(read.overflow).toBeLessThanOrEqual(1);
  });

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
