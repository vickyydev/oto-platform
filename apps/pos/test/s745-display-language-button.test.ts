import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerDisplay, type CustomerStage } from '@/components/till/CustomerDisplay';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import type { SupportedLang } from '@/i18n/types';
import type { Sale } from '@/types';

// The add-on grid reads a live store with no server snapshot, and says nothing of what is tested here.
vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

/**
 * SCRUM-745 — THE LANGUAGE BUTTON SITS BESIDE "YOUR ORDER", NEVER OVER IT.
 *
 * The prototype floated the button in the display's top-right corner, which on
 * the order screen is where its "Your Order" heading sits, so the button
 * covered the heading in every language and most of the Thai one. On the
 * order screen the button now follows the heading in the header row; every
 * other screen, whose heading is centred, keeps the corner button.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const sale = {
  id: 'sale-745', operatorId: 'private', operatorName: 'Private', tier: 'tourist', total: 0, lines: [],
  manualDiscounts: [], creditGrants: [], bracelets: { adults: 0, children: 0 }, createdAt: '', status: 'open', refunds: [],
} as unknown as Sale;

const screen = (lang: SupportedLang, stage: CustomerStage): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => lang, setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, {
    storageKey: 'zz-test-745',
    children: createElement(CustomerDisplay, {
      stage, sale, phone: '', nickname: '', member: null,
      onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
      onCustomerDone: () => undefined,
    }),
  }));
};

const CORNER = 'absolute top-4 right-4 z-40';
const languageButtons = (html: string, lang: SupportedLang) =>
  html.split(`aria-label="${tFor(lang)('common.changeLanguage')}"`).length - 1;

describe('s745 — the order screen', () => {
  it.each(['en', 'th', 'ru'] as const)('%s: one language button, after the heading and not in the corner', (lang) => {
    const html = screen(lang, 'order');
    const heading = `<span class="text-lg text-foreground/60">${tFor(lang)('till.order.yourOrder')}</span>`;
    expect(html).toContain(heading);
    expect(html).not.toContain(CORNER);
    expect(languageButtons(html, lang)).toBe(1);
    const after = html.slice(html.indexOf(heading) + heading.length);
    expect(after.startsWith('<div class="relative z-40 ">')).toBe(true);
  });
});

describe('s745 — every other screen keeps the corner button', () => {
  it.each(['identify', 'welcome', 'input', 'payment', 'thankyou'] as const)('%s', (stage) => {
    const html = screen('th', stage);
    expect(html).toContain(CORNER);
    expect(languageButtons(html, 'th')).toBe(1);
  });
});
