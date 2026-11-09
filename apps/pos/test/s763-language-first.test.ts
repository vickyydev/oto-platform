import * as React from 'react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cartQuote } from './support/fixtures';
import { CustomerDisplay, type CustomerStage } from '@/components/till/CustomerDisplay';
import { CustomerLanguageChoice } from '@/components/till/CustomerLanguageChoice';
import { tFor } from '@/i18n/LanguageContext';
import { DICTIONARY } from '@/i18n/dictionary';
import { LANGUAGES, type SupportedLang } from '@/i18n/types';
import {
  languageChoiceMade,
  languageChoiceOpen,
  languageChoiceStart,
  settleLanguageChoice,
  type LanguageChoiceState,
} from '@/lib/languageChoice';
import type { CartLine, Sale } from '@/types';

/**
 * SCRUM-763 — THE GUEST CHOOSES THEIR LANGUAGE FIRST.
 *
 * Suggested by the tester and agreed by the owner on 30 October: before the
 * phone number, and before anything else at the start of a sale, the customer
 * display asks for the guest's language, so every screen after it — the phone
 * number's safety line included — is in that language. Once per customer, not
 * between steps; the small language button stays on the later screens.
 *
 * The screen is drawn as the display draws it, under the display's language,
 * which a press on the choice really changes (`setLang`), and the first-screen
 * gate is the one the till and the paired display hold (`lib/languageChoice`).
 */

/** The display's language: what `useLanguage` answers, and what a press changes. */
const seam = vi.hoisted(() => ({ lang: 'en' as 'en' | 'zh' | 'th' | 'ru' | 'fr' }));
vi.mock('@/i18n/LanguageContext', async () => {
  const actual = await vi.importActual<typeof import('@/i18n/LanguageContext')>('@/i18n/LanguageContext');
  return {
    ...actual,
    useLanguage: () => ({ lang: seam.lang, setLang: (next: SupportedLang) => { seam.lang = next; }, t: actual.tFor(seam.lang) }),
  };
});

// The runner compiles JSX to React.createElement; the till's build needs no such global.
beforeEach(() => { seam.lang = 'en'; vi.stubGlobal('React', React); });
afterEach(() => vi.unstubAllGlobals());

/** The way `renderToStaticMarkup` writes an apostrophe. */
const inMarkup = (text: string) => text.replace(/'/g, '&#x27;');

const ticket = {
  id: 'ticket-1', name: '1 Hour Play', durationLabel: '1 hour', hours: 1,
  translations: { ru: { name: 'Игра 1 час' }, th: { name: 'เล่น 1 ชั่วโมง' } },
  prices: { tourist: { weekday: 200, weekend: 300 } },
  adultRules: { tourist: { kind: 'free_adults', freeAdults: 1, overflow: 'same_as_kid' } },
} as unknown as CartLine['ticketType'];
const line = { id: 'line-1', ticketType: ticket, tier: 'tourist', kids: 1, adults: 1, socks: 0, lineTotal: 200, addOns: [] } as unknown as CartLine;
const sale = {
  id: 'sale-763', operatorId: 'private', operatorName: 'Private', tier: 'tourist', total: 200, lines: [line],
  manualDiscounts: [], creditGrants: [], bracelets: { adults: 1, children: 1 }, createdAt: '', status: 'open', refunds: [],
} as unknown as Sale;
const totals = cartQuote(200).totals;

const draw = (stage: CustomerStage, chooseLanguage?: boolean, onLanguageChosen?: () => void): string =>
  renderToStaticMarkup(createElement(CustomerDisplay, {
    stage, sale: stage === 'identify' || stage === 'welcome' ? { ...sale, lines: [] } : sale,
    phone: '', nickname: '', member: null, totals, showGrantQr: false,
    onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
    onCustomerDone: () => undefined, chooseLanguage, onLanguageChosen,
  }));

type Node = React.ReactElement<Record<string, unknown>>;
function nodes(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as React.ReactNode)];
}

/** A guest's press on their language, on the choice exactly as it is drawn. */
function press(lang: SupportedLang, onChosen: (chosen: SupportedLang) => void): void {
  const tree = CustomerLanguageChoice({ onChosen });
  const button = nodes(tree).find((node) => node.type === 'button' && node.props['data-testid'] === `language-choice-${lang}`);
  if (typeof button?.props.onClick !== 'function') throw new Error(`no button for ${lang}`);
  (button.props.onClick as () => void)();
}

/**
 * One customer screen through a visit, holding the gate the way
 * `useLanguageChoice` does: drawn from the state as it stands, settled after.
 * `saleKey` is the sale's name: the till's own, or the one a paired display
 * reads off the first screen; a paired display behind an older till has none.
 */
function screen(saleKey: string | null) {
  let gate: LanguageChoiceState = languageChoiceStart(saleKey);
  let key = saleKey;
  return {
    show(stage: CustomerStage): string {
      const atStart = stage === 'identify';
      const open = languageChoiceOpen(gate, atStart, key);
      const html = draw(stage, open, () => { gate = languageChoiceMade(key); });
      gate = settleLanguageChoice(gate, atStart, key);
      return html;
    },
    choose(lang: SupportedLang): void { press(lang, () => { gate = languageChoiceMade(key); }); },
    newSale(next: string): void { key = next; },
  };
}

const CHOICE = 'data-testid="language-choice"';
const PHONE_STEP = 'data-testid="identify-safety"';
const OTHER: SupportedLang[] = ['zh', 'th', 'ru', 'fr'];

describe('the first screen of a sale is the language choice', () => {
  it('five languages, each named in its own language with a line in it, and no phone number yet', () => {
    const html = draw('identify', true);
    expect(html).toContain(CHOICE);
    for (const option of LANGUAGES) {
      expect(html, option.code).toContain(`data-testid="language-choice-${option.code}"`);
      expect(html, option.code).toContain(`lang="${option.code}"`);
      expect(html, option.code).toContain(`>${option.nativeLabel}<`);
      expect(html, option.code).toContain(tFor(option.code)('display.language.continue'));
    }
    // The phone number, its safety line, its keypad and Continue all come after.
    expect(html.includes(inMarkup(tFor('en')('till.identify.title')))).toBe(false);
    expect(html.includes(PHONE_STEP)).toBe(false);
    expect(html.includes('aria-label="Select country code"')).toBe(false);
    expect(html.includes(`>${tFor('en')('common.continue')}<`)).toBe(false);
    // The language button is not drawn over the choice it would duplicate.
    expect(html.includes(`aria-label="${tFor('en')('common.changeLanguage')}"`)).toBe(false);
  });

  it('says what it asks in the screen’s language, and the same in the other four', () => {
    for (const lang of LANGUAGES.map((option) => option.code)) {
      seam.lang = lang;
      const html = draw('identify', true);
      expect(html, lang).toContain(`<h2 class="text-5xl font-black">${tFor(lang)('display.language.title')}</h2>`);
      for (const other of LANGUAGES.filter((option) => option.code !== lang)) {
        expect(html, `${lang} → ${other.code}`).toContain(`<span lang="${other.code}">`);
        expect(html, `${lang} → ${other.code}`).toContain(tFor(other.code)('display.language.title'));
      }
    }
  });

  it('a caller that does not ask for it keeps the phone number as its first screen', () => {
    for (const choose of [undefined, false]) {
      const html = draw('identify', choose);
      expect(html.includes(CHOICE)).toBe(false);
      expect(html).toContain(PHONE_STEP);
    }
  });

  it('is the first screen only: no other screen of the sale becomes the choice', () => {
    for (const stage of ['welcome', 'order', 'input', 'payment', 'thankyou'] as const) {
      expect(draw(stage, true).includes(CHOICE), stage).toBe(false);
    }
  });
});

describe('the chosen language carries into the phone number and every screen after it', () => {
  it.each(OTHER)('%s: a press sets the language, and the phone-number step follows in it', (lang) => {
    const display = screen('sale-1');
    expect(display.show('identify')).toContain(CHOICE);
    display.choose(lang);
    expect(seam.lang).toBe(lang);
    const t = tFor(lang);
    const html = display.show('identify');
    expect(html.includes(CHOICE)).toBe(false);
    for (const key of ['till.identify.title', 'till.identify.subtitle', 'till.identify.safety', 'common.continue']) {
      expect(html, key).toContain(inMarkup(t(key)));
    }
    expect(html.includes(inMarkup(tFor('en')('till.identify.safety')))).toBe(false);
    // The language button is back, named in the language just chosen.
    expect(html).toContain(`aria-label="${t('common.changeLanguage')}"`);
    expect(html).toContain(LANGUAGES.find((option) => option.code === lang)!.nativeLabel);
  });

  it.each(OTHER)('%s: the welcome, the order, the details, the payment and the thank-you', (lang) => {
    const display = screen('sale-1');
    display.show('identify');
    display.choose(lang);
    const t = tFor(lang);
    const expected: Record<Exclude<CustomerStage, 'identify'>, string> = {
      welcome: t('till.welcome.title'), order: t('till.order.yourOrder'), input: t('till.input.enterDetails'),
      payment: t('common.pleasePay'), thankyou: t('till.thankyou.title'),
    };
    for (const [stage, words] of Object.entries(expected) as [Exclude<CustomerStage, 'identify'>, string][]) {
      const html = display.show(stage);
      expect(html, stage).toContain(inMarkup(words));
      expect(html.includes(CHOICE), stage).toBe(false);
    }
  });

  it('the new words are in all five languages, and only English reads like English', () => {
    for (const key of ['display.language.title', 'display.language.continue']) {
      const entry = DICTIONARY[key]!;
      for (const lang of ['en', ...OTHER] as const) expect(entry[lang], `${key} ${lang}`).toBeTruthy();
      for (const lang of OTHER) expect(entry[lang], `${key} ${lang}`).not.toBe(entry.en);
      expect(new Set(Object.values(entry)).size, key).toBe(5);
    }
  });
});

describe('once per customer, not between steps', () => {
  it('a guest who chose and is typing their number is not asked again', () => {
    const display = screen('sale-1');
    display.show('identify');
    display.choose('th');
    for (let i = 0; i < 3; i += 1) expect(display.show('identify')).toContain(PHONE_STEP);
  });

  it('the till: a completed or cancelled sale starts the next, and the next guest chooses again', () => {
    const display = screen('sale-1');
    display.show('identify');
    display.choose('ru');
    for (const stage of ['welcome', 'order', 'payment', 'thankyou'] as const) expect(display.show(stage).includes(CHOICE)).toBe(false);
    display.newSale('sale-2');
    const next = display.show('identify');
    expect(next).toContain(CHOICE);
    // Until the next guest presses, the screen is in the last guest's language.
    expect(next).toContain(tFor('ru')('display.language.title'));
    display.choose('fr');
    expect(display.show('identify')).toContain(inMarkup(tFor('fr')('till.identify.title')));
  });

  it('the till: a sale thrown away on its first screen still opens the choice for the next guest', () => {
    const display = screen('sale-1');
    display.show('identify');
    display.choose('zh');
    expect(display.show('identify')).toContain(PHONE_STEP);
    display.newSale('sale-2');
    expect(display.show('identify')).toContain(CHOICE);
  });

  it('a paired display the till names its sale to: Back to the first screen inside it is the same guest, in their language', () => {
    const display = screen('sale-1');
    display.show('identify');
    display.choose('th');
    display.show('welcome');
    const back = display.show('identify');
    expect(back.includes(CHOICE)).toBe(false);
    expect(back).toContain(inMarkup(tFor('th')('till.identify.title')));
    display.newSale('sale-2'); // cancelled on its first screen: the stage never moved
    expect(display.show('identify')).toContain(CHOICE);
  });

  it('a paired display behind an older till, told the stage and not the sale: back at the first screen is the next guest', () => {
    const display = screen(null);
    expect(display.show('identify')).toContain(CHOICE);
    display.choose('th');
    expect(display.show('identify')).toContain(PHONE_STEP);
    for (const stage of ['welcome', 'order', 'input', 'payment', 'thankyou'] as const) expect(display.show(stage).includes(CHOICE)).toBe(false);
    expect(display.show('identify')).toContain(CHOICE);
  });

  it('a guest who never chose (the team moved the sale on) leaves the choice for the next one', () => {
    const display = screen(null);
    display.show('identify');
    display.show('order');
    expect(display.show('identify')).toContain(CHOICE);
  });
});

describe('both customer screens ask for it', () => {
  const source = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

  it('the till’s customer half, once per sale', () => {
    const till = source('pages/Till.tsx');
    expect(till).toContain("useLanguageChoice(customerStage === 'identify', `${saleEpochRef.current}`)");
    expect(till).toMatch(/const resetSale = \(\) => \{\s+saleEpochRef\.current \+= 1;/);
    expect(till).toMatch(/<CustomerDisplay\s+stage=\{customerStage\}[\s\S]*?chooseLanguage=\{customerLanguage\.open\}\s+onLanguageChosen=\{customerLanguage\.choose\}/);
  });

  it('the paired display (and the counter box’s screen, which is the same page), once per sale the till names', () => {
    const display = source('pages/Display.tsx');
    expect(display).toContain("const firstScreen = view?.stage === 'identify';");
    expect(display).toContain('const saleKey = useHeldSaleKey(firstScreen, view?.saleKey);');
    expect(display).toContain('const language = useLanguageChoice(firstScreen, saleKey);');
    expect(display).toContain('chooseLanguage={language.open} onLanguageChosen={language.choose}');
    expect(readFileSync(path.resolve(import.meta.dirname, '..', 'box-display/main.tsx'), 'utf8')).toContain("import Display from '../src/pages/Display'");
  });

  it('both tills name each sale for the paired display: once on load, again on every reset, never the epoch', () => {
    for (const rel of ['pages/Till.tsx', 'components/mobile/MobileTill.tsx']) {
      const till = source(rel);
      expect(till, rel).toContain('const [firstSaleKey] = useState(() => crypto.randomUUID());');
      expect(till, rel).toContain('const saleKeyRef = useRef(firstSaleKey);');
      const reset = till.slice(till.indexOf('const resetSale = () => {'));
      expect(reset.slice(0, reset.indexOf('\n  };')), rel).toContain('saleKeyRef.current = crypto.randomUUID();');
      const publish = till.slice(till.indexOf('const linkedDisplay = useTicketDisplay(station?.stationId ?? null, {'));
      expect(publish.slice(0, publish.indexOf('\n  }, ')), rel).toContain('\n    saleKey: saleKeyRef.current,\n');
    }
  });
});
