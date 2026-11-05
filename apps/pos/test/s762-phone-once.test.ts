import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerDisplay, type CustomerStage } from '@/components/till/CustomerDisplay';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { StepIdentify } from '@/components/till/StepIdentify';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupportedLang } from '@/i18n/types';
import { routeToPayment } from '@/lib/customerContact';
import type { Sale } from '@/types';

// The add-on grid reads a live store with no server snapshot, and says nothing of what is tested here.
vi.mock('@/components/till/AddOnsGrid', () => ({ AddOnsGrid: () => null }));

/**
 * SCRUM-762 — THE PHONE NUMBER IS ASKED ONCE, AT THE START, AND IT IS REQUIRED.
 *
 * Agreed by the park on 30 October: the customer screen asks for the number at
 * the very beginning with no Skip and a line saying why it is needed; a member
 * is recognised from it; the same number is used at payment and on the
 * drop-off and nanny forms and the family is not asked for it again.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const under = (lang: SupportedLang, element: ReactElement): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => lang, setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-762', children: element }));
};

const sale = {
  id: 'sale-762', operatorId: 'private', operatorName: 'Private', tier: 'tourist', total: 0, lines: [],
  manualDiscounts: [], creditGrants: [], bracelets: { adults: 0, children: 0 }, createdAt: '', status: 'open', refunds: [],
} as unknown as Sale;

const display = (lang: SupportedLang, stage: CustomerStage, props: { phone?: string; nickname?: string; fixedPhone?: string } = {}) =>
  under(lang, createElement(CustomerDisplay, {
    stage, sale, phone: props.phone ?? '', nickname: props.nickname ?? '', member: null,
    onPhoneChange: () => undefined, onNicknameChange: () => undefined, onIdentify: () => undefined,
    onCustomerDone: () => undefined, fixedPhone: props.fixedPhone,
  }));

/** The text of every button on the screen, in order. */
const buttons = (html: string): string[] =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());
const continueButton = (html: string): string => {
  const all = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  const hit = all.find((m) => m[2]!.replace(/<[^>]+>/g, '').trim() === tFor('en')('common.continue'));
  return hit?.[1] ?? '';
};

describe('the first customer screen', () => {
  it.each(['en', 'th', 'ru'] as const)('%s: asks for the number with the safety line, and offers no skip', (lang) => {
    const t = tFor(lang);
    const html = display(lang, 'identify');
    expect(html).toContain(t('till.identify.title').replace(/'/g, '&#x27;'));
    expect(html).toContain(t('till.identify.safety').replace(/'/g, '&#x27;'));
    expect(html).toContain('data-testid="identify-safety"');
    expect(buttons(html)).toContain(t('common.continue'));
    // No way past this screen without a number, in any language.
    for (const word of ['skip', 'Skip', 'пропустить', 'ข้าม']) expect(html.includes(word), word).toBe(false);
  });

  it('keeps Continue off until a number is typed', () => {
    expect(continueButton(display('en', 'identify'))).toContain(" disabled=\"\"");
    expect(continueButton(display('en', 'identify', { phone: '0812345678' }))).not.toContain(" disabled=\"\"");
  });

  it('the old skip wording and the "find my membership" button are gone from every language', () => {
    expect(DICTIONARY['till.identify.skip']).toBeUndefined();
    expect(DICTIONARY['till.identify.findMembership']).toBeUndefined();
    for (const key of ['till.identify.title', 'till.identify.subtitle', 'till.identify.safety', 'till.input.phoneKept']) {
      const entry = DICTIONARY[key]!;
      for (const lang of ['en', 'zh', 'th', 'ru', 'fr'] as const) expect(entry[lang], `${key} ${lang}`).toBeTruthy();
      for (const lang of ['zh', 'th', 'ru', 'fr'] as const) expect(entry[lang], `${key} ${lang}`).not.toBe(entry.en);
      expect(entry.en.toLowerCase()).not.toContain('skip');
    }
  });
});

describe('the details screen before payment', () => {
  it('shows the number given at the start instead of asking for it again', () => {
    const html = display('ru', 'input', { phone: '+66812345678', fixedPhone: '+66812345678' });
    expect(html).toContain('data-testid="input-kept-phone"');
    expect(html).toContain('+66812345678');
    expect(html).toContain(tFor('ru')('till.input.phoneKept'));
    // The keypad the number is typed on is not there.
    expect(html).not.toContain('aria-label="Select country code"');
  });

  it('still asks for a number nobody has given', () => {
    const html = display('en', 'input');
    expect(html).not.toContain('data-testid="input-kept-phone"');
    expect(html).toContain('aria-label="Select country code"');
  });
});

describe('where Pay takes the order (routeToPayment)', () => {
  const base = { hasMember: false, supervisionResolved: false, phone: '', nickname: '', verificationPending: false };
  it('a member or a resolved supervision flow goes straight to payment', () => {
    expect(routeToPayment({ ...base, hasMember: true })).toBe('payment');
    expect(routeToPayment({ ...base, supervisionResolved: true, phone: '0812345678' })).toBe('payment');
  });
  it('a number given at the start is reused: the details step is not shown', () => {
    expect(routeToPayment({ ...base, phone: '0812345678' })).toBe('contact_known');
    expect(routeToPayment({ ...base, phone: '0812345678', nickname: 'Mama', verificationPending: true })).toBe('contact_known');
  });
  it('the details step opens only for what is missing', () => {
    expect(routeToPayment(base)).toBe('details');
    // A verified rate needs a name before a new profile can hold it.
    expect(routeToPayment({ ...base, phone: '0812345678', verificationPending: true })).toBe('details');
  });
});

describe('the drop-off and nanny forms', () => {
  const consentProps = {
    slots: [{ id: 's1', name: 'Mai', age: '6', waived: false, optIn: false, allergiesMedical: '', foodRestrictions: '' }],
    parentName: '', consentAck: false,
    policy: {
      bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'nanny' }],
      siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [],
    },
    parentPhone: '+66812345678', onParentPhoneChange: () => undefined,
    onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
    acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined,
  };

  it('the customer sees the number from the start and is not asked for it', () => {
    const html = under('th', createElement(ConsentCapture, { ...consentProps, parentPhoneKept: true } as never));
    expect(html).toContain('data-testid="consent-kept-phone"');
    expect(html).toContain('+66812345678');
    expect(html).toContain(tFor('th')('till.input.phoneKept'));
  });

  it('staff can still correct it on their own copy', () => {
    const html = under('en', createElement(ConsentCapture, { ...consentProps, parentPhoneKept: true, staffScreen: true } as never));
    expect(html).not.toContain('data-testid="consent-kept-phone"');
  });
});

describe('the till', () => {
  const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');

  it('has no walk-in skip at the membership check, from its own screen or from the display', () => {
    expect(till).not.toMatch(/handleSkipIdentify/);
    expect(till).not.toMatch(/skip_identify/);
    const html = renderToStaticMarkup(createElement(StepIdentify, { phone: '', nickname: '', member: null }));
    expect(html).not.toMatch(/Skip/);
    expect(html).toContain('data-testid="identify-phone-required"');
  });

  it('offers the customer screen when nothing else can take the number', () => {
    const html = renderToStaticMarkup(createElement(StepIdentify, {
      phone: '', nickname: '', member: null, onShowCustomerScreen: () => undefined,
    }));
    expect(html).toContain('Show customer screen to enter the phone');
  });

  it('starts the drop-off and nanny forms from the number given at the start', () => {
    expect(till).toMatch(/setSuperParentPhone\(customerPhone\.trim\(\) \|\| member\?\.phone \|\| ''\)/);
    expect(till).toMatch(/setSuperParentContactMethod\(customerContactChannel\)/);
    expect(till).toMatch(/parentPhoneKept=\{gatePhoneKept\}/);
  });
});
