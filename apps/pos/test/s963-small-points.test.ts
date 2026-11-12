import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { partPaidDialogWords } from '@/components/fnb/FnbPayment';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { DISPLAY_TOUCH } from '@/components/till/consentFormLayout';
import { LanguageProvider } from '@/i18n/LanguageContext';

/**
 * SCRUM-963 — THE COUNTER DISPLAY'S FAMILY FORM AFTER ITS SECOND PROOF, AND
 * THE SHOP'S DIALOG: what the source and the markup say. The layout, contrast
 * and wheel points are measured in a browser (`s893-family-form-touch-browser`,
 * `s959-split-view-measured`); the send queue in `s963-display-language-offline`;
 * the receipt number in `s963-receipt-at-once`.
 *
 *   (2) the customer screens' language list follows the screen's look, and in
 *       dark it is the very slate and primary it always was;
 *   (3) the returning family's badges read on a light screen, as before in dark;
 *   (4) WhatsApp, Telegram and LINE a finger's height on the display's form and
 *       the phone till's, the till's own customer half as before; the age
 *       picker's presses and the language list's on the display's form;
 *   (10) the Shop's "Save as partly paid" says sale, F&B's order.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');
const css = src('index.css');
/** The `.light` (with `:root`) and `.dark` blocks of the till's theme. */
const block = (selector: ':root,\n.light {' | '.dark {') => {
  const at = selector === '.dark {' ? css.indexOf('\n.dark {') : css.search(/:root,\r?\n\.light \{/);
  return css.slice(at, css.indexOf('\n}', at + 1));
};
const tailwind = (name: string) => readFileSync(path.resolve(import.meta.dirname, '../node_modules/tailwindcss/theme.css'), 'utf8')
  .match(new RegExp(`--color-${name}: ([^;]+);`))![1]!;

const under = (element: ReactElement): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => 'en', setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-963', children: element }));
};

describe('SCRUM-963 (2) — the language list follows the screen’s look', () => {
  it('the customer screens’ list reads its colours from the screen’s tokens, the /book list as before', () => {
    const switcher = src('components/shared/LanguageSwitcher.tsx');
    expect(switcher).toContain("? 'bg-(--cd-menu) border-foreground/15 text-foreground'");
    expect(switcher).not.toContain('bg-slate-900');
    expect(switcher).toContain("variant === 'dark' ? 'bg-primary/15 text-(--cd-menu-chosen)' : 'bg-primary/15 text-primary'");
    // The light /book flow's own list is untouched.
    expect(switcher).toContain(": 'bg-white border-slate-200 text-slate-900';");
  });

  it('in dark the very slate-900 and primary it always drew; on a light screen the card’s cream and a deeper coral', () => {
    expect(block('.dark {')).toContain(`--cd-menu: ${tailwind('slate-900')};`);
    expect(block('.dark {')).toContain('--cd-menu-chosen: hsl(var(--primary));');
    expect(block(':root,\n.light {')).toContain('--cd-menu: hsl(var(--popover));');
    expect(block(':root,\n.light {')).toContain(`--cd-menu-chosen: ${tailwind('orange-800')};`);
  });

  it('the display’s form gives its choices the finger’s height its pill has', () => {
    expect(src('components/shared/LanguageSwitcher.tsx')).toContain("}${buttonClassName ? ` ${buttonClassName}` : ''}`}");
    expect(src('components/till/PublicConsentCapture.tsx')).toContain('<LanguageSwitcher variant="dark" buttonClassName={DISPLAY_TOUCH} />');
  });
});

describe('SCRUM-963 (3) — the returning family’s badges read on a light screen', () => {
  it('“Saved — still correct?” and “Confirmed” take the screen’s inks: amber-300 and emerald-300 in dark, as before', () => {
    const review = src('components/shared/SavedChildrenReview.tsx');
    expect(review).toContain('px-3 py-1.5 text-base text-(--cd-badge-check)">');
    expect(review).toContain('bg-emerald-500/20 px-3 py-1.5 text-base text-(--cd-badge-done)">');
    expect(review).not.toContain('text-amber-300');
    expect(review).not.toContain('text-emerald-300');
    expect(block('.dark {')).toContain(`--cd-badge-check: ${tailwind('amber-300')};`);
    expect(block('.dark {')).toContain(`--cd-badge-done: ${tailwind('emerald-300')};`);
    expect(block(':root,\n.light {')).toContain(`--cd-badge-check: ${tailwind('amber-800')};`);
    expect(block(':root,\n.light {')).toContain(`--cd-badge-done: ${tailwind('emerald-800')};`);
  });
});

describe('SCRUM-963 (4) — a finger’s presses on the family’s screens', () => {
  /** The channel pills, as drawn. */
  const pills = (html: string) => ['WhatsApp', 'Telegram', 'LINE']
    .map((name) => html.match(new RegExp(`<button\\b[^>]*title="${name}"[^>]*>`))?.[0] ?? '');

  it('the channel pills take the class they are given, on the keypad and the plain field alike', () => {
    for (const showKeypad of [true, false]) {
      const html = under(createElement(PhoneInput, { value: '+66898963001', onChange: () => undefined, showKeypad,
        channel: 'whatsapp', onChannelChange: () => undefined, channelClassName: DISPLAY_TOUCH }));
      for (const pill of pills(html)) expect(pill, String(showKeypad)).toContain('min-h-11');
    }
    // Given nothing, as they were.
    const plain = under(createElement(PhoneInput, { value: '+66898963001', onChange: () => undefined,
      channel: 'whatsapp', onChannelChange: () => undefined }));
    for (const pill of pills(plain)) {
      expect(pill).not.toContain('min-h-11');
      expect(pill).toContain('h-7 px-2.5 text-xs');
    }
  });

  const form = (extra: Record<string, unknown> = {}) => createElement(ConsentCapture, {
    slots: [{ id: 's1', name: 'ZZ TEST Aya', age: '6', waived: false, optIn: false, allergiesMedical: '', foodRestrictions: '' }],
    parentName: 'ZZ TEST guardian', consentAck: false,
    policy: {
      bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'drop_off' }],
      siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [],
    },
    parentPhone: '+66898963001', parentContactMethod: 'whatsapp',
    onParentPhoneChange: () => undefined, onParentContactMethodChange: () => undefined,
    onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
    acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined,
    ...extra,
  } as never);

  it('the phone till’s form draws them a finger’s height; the till’s own customer half as before', () => {
    for (const pill of pills(under(form({ phoneScroll: true })))) expect(pill).toContain('min-h-11');
    for (const pill of pills(under(form()))) expect(pill).not.toContain('min-h-11');
  });

  it('the display’s own form gives them its touch size, and its age picker the touch presses; its read-only copy does not', () => {
    const display = src('components/till/PublicConsentCapture.tsx');
    expect(display).toContain('channelClassName={touch}');
    expect(display).toContain('disabled={locked} className="mt-2" matchSurface touch={!mirror}');
    expect(src('components/till/ConsentCapture.tsx')).toContain('channelClassName={phoneScroll ? DISPLAY_TOUCH : undefined}');
    // The returning family's review on the display; not the till's own copy of it.
    expect(src('components/shared/SavedChildrenReview.tsx')).toMatch(/matchSurface\r?\n[^\n]*\n\s*touch=\{publicMode\}/);
    const picker = src('components/shared/ChildDobPicker.tsx');
    expect(picker).toContain("const TOUCH_PRESS = 'min-h-11 min-w-11';");
    expect(picker).toContain('[&>button:last-child]:h-11 ');
    expect(picker).toContain('[&>button:last-child]:w-11 ');
    expect(picker.match(/touch=\{touch\}/g)).toHaveLength(3);
  });
});

describe('SCRUM-963 (10) — the Shop’s “Save as partly paid” says sale', () => {
  it('the words, the Shop’s and F&B’s', () => {
    expect(partPaidDialogWords('฿30', '฿145', 'sale')).toBe('฿30 paid, balance ฿145. The sale is left as it is: History lists it as Partly paid with its balance, '
      + 'and a manager can refund what was paid from there. Nothing is printed for it, and this screen starts a new sale.');
    expect(partPaidDialogWords('฿30', '฿145')).toBe('฿30 paid, balance ฿145. The order is left as it is: History lists it as Partly paid with its balance, '
      + 'and a manager can refund what was paid from there. Nothing is printed for it, and this screen starts a new order.');
  });

  it('the Shop asks for its word; F&B, at the desk and on the phone, keeps order', () => {
    expect(src('pages/MerchStation.tsx')).toContain('saleWord="sale"');
    expect(src('pages/OrderStation.tsx')).not.toContain('saleWord=');
    expect(src('components/mobile/order-station/MobileOrderStation.tsx')).not.toContain('saleWord=');
    expect(src('components/fnb/FnbPayment.tsx')).toContain('{partPaidDialogWords(paid, balance, saleWord)}');
  });
});
