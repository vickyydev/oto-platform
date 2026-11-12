import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupportedLang } from '@/i18n/types';

/**
 * SCRUM-863 — THE DROP-OFF AND NANNY FORMS ASK FOR THE NUMBER AGAIN.
 *
 * The owner, 12 November: "its important to ask and confirm drop off whatsapp
 * or telegram number so bring it back and same for nanny if prototype had it."
 * Asking the number once (SCRUM-762) is the ordinary ticket sale's rule only.
 *
 * The prototype's form (imports/oto-pos/.../components/till/ConsentCapture.tsx
 * 281-298) shows, in the parent's block after the guardian's name and before
 * the consent tick, the phone field with the channel choice; one form serves
 * every child who needs consent, a nanny child and a drop-off child alike.
 * The till starts it from the number and channel given on the first screen.
 *
 * This file is the till's own customer half (and the staff copy). The paired
 * display's form is in s863-dropoff-number-display.test.ts.
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
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-863', children: element }));
};

const form = (requirement: 'nanny' | 'drop_off', extra: Record<string, unknown> = {}) => createElement(ConsentCapture, {
  slots: [{ id: 's1', name: 'ZZ TEST Mai', age: '6', waived: false, optIn: false, allergiesMedical: '', foodRestrictions: '' }],
  parentName: 'ZZ TEST guardian', consentAck: false,
  policy: {
    bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement }],
    siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [],
  },
  parentPhone: '+66898020001', parentContactMethod: 'telegram',
  onParentPhoneChange: () => undefined, onParentContactMethodChange: () => undefined,
  onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
  acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined,
  ...extra,
} as never);

/** The channel pill with this name, as drawn. */
const pill = (html: string, name: string): string => html.match(new RegExp(`<button\\b[^>]*title="${name}"[^>]*>`))?.[0] ?? '';

describe('the family’s side of the form, on the till’s customer half', () => {
  it.each([['a nanny child', 'nanny'], ['a drop-off child', 'drop_off']] as const)(
    '%s: the parent’s block asks for the number with the channel choice, starting from the ones given at the start', (_who, requirement) => {
      const html = under('en', form(requirement));
      // After the guardian's name and before the consent, as the prototype places it.
      const name = html.indexOf(tFor('en')('superviseConsent.parentGuardianName'));
      const label = html.indexOf(tFor('en')('superviseConsent.phoneNumber'));
      const field = html.search(/<input type="tel"[^>]*value="898020001"/);
      const consent = html.indexOf('data-testid="consent-ack"');
      expect(name).toBeGreaterThan(-1);
      expect(label).toBeGreaterThan(name);
      expect(field).toBeGreaterThan(label);
      expect(consent).toBeGreaterThan(field);
      // The three channels, the one from the first screen chosen.
      for (const channel of ['WhatsApp', 'Telegram', 'LINE']) expect(pill(html, channel), channel).not.toBe('');
      expect(pill(html, 'Telegram')).toContain('bg-sky-500/15');
      expect(pill(html, 'WhatsApp')).toContain('bg-transparent');
      expect(pill(html, 'LINE')).toContain('bg-transparent');
      // Nothing fixes the number on this form any more.
      expect(html).not.toContain('data-testid="consent-kept-phone"');
      expect(html).not.toContain(tFor('en')('till.input.phoneKept'));
      expect(html).not.toMatch(/<input type="tel"[^>]* disabled=""/);
    });

  it.each(['en', 'zh', 'th', 'ru', 'fr'] as const)('%s: the field is there in the customer’s language, without the "number you gave at the start" line', (lang) => {
    const t = tFor(lang);
    const html = under(lang, form('drop_off'));
    expect(html).toContain(t('superviseConsent.phoneNumber'));
    expect(html).toMatch(/<input type="tel"[^>]*value="898020001"/);
    expect(html).toContain(`aria-label="${t('phoneInput.selectCountry').replace(/'/g, '&#x27;')}"`);
    expect(html).not.toContain(t('till.input.phoneKept'));
  });

  it('no new wording: the label is the prototype’s, and the fixed-number line stays in the dictionary for the step before payment', () => {
    expect(DICTIONARY['superviseConsent.phoneNumber']!.en).toBe('Phone number');
    expect(DICTIONARY['till.input.phoneKept']).toBeDefined();
    const display = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'components', 'till', 'CustomerDisplay.tsx'), 'utf8');
    expect(display).toContain("t('till.input.phoneKept')");
    expect(display).toContain('data-testid="input-kept-phone"');
  });

  it('a family with no number given still gets the empty field', () => {
    const html = under('en', form('nanny', { parentPhone: '', parentContactMethod: 'whatsapp' }));
    expect(html).toMatch(/<input type="tel"[^>]*value=""/);
    expect(pill(html, 'WhatsApp')).toContain('bg-emerald-500/15');
  });

  it('a child who needs no supervision has no parent’s block, so no number is asked: the prototype’s rule', () => {
    const html = under('en', form('nanny', {
      policy: {
        bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'none' }],
        siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [],
      },
    }));
    expect(html).not.toContain('type="tel"');
  });

  it('staff’s own copy shows the same number and channel, in English, to correct', () => {
    const html = under('th', form('drop_off', { staffScreen: true }));
    expect(html).toContain('Phone number');
    expect(html).toMatch(/<input type="tel"[^>]*value="898020001"/);
    expect(pill(html, 'Telegram')).toContain('bg-sky-500/15');
  });
});

describe('what the till does with it', () => {
  const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
  const form_ = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'components', 'till', 'ConsentCapture.tsx'), 'utf8');

  it('the form starts from the number and channel given on the first screen', () => {
    expect(till).toMatch(/setSuperParentPhone\(customerPhone\.trim\(\) \|\| member\?\.phone \|\| ''\);\s*setSuperParentContactMethod\(customerContactChannel\);/);
  });

  it('both copies of the form write the registration’s contact, and nothing fixes the customer’s copy', () => {
    // SCRUM-914 — through the rule that withdraws the confirmation, which
    // writes the registration's contact (never the customer's own number).
    expect(till.match(/onParentPhoneChange=\{changeGuardianPhone\}/g)).toHaveLength(2);
    expect(till.match(/onParentContactMethodChange=\{changeGuardianChannel\}/g)).toHaveLength(2);
    expect(till).toMatch(/const changeGuardianPhone = \(next: string\) => \{[\s\S]{0,200}?setSuperParentPhone\(next\);/);
    expect(till).toMatch(/const changeGuardianChannel = \(next: ContactChannel\) => \{[\s\S]{0,200}?setSuperParentContactMethod\(next\);/);
    expect(till).not.toMatch(/parentPhoneKept|gatePhoneKept/);
    expect(form_).not.toMatch(/parentPhoneKept|consent-kept-phone|till\.input\.phoneKept/);
    // The field is the prototype's: the shared input, translated on the customer's side.
    expect(form_).toMatch(/<PhoneInput\s+value=\{parentPhone \?\? ''\}\s+onChange=\{onParentPhoneChange\}\s+label=""[\s\S]*?channel=\{onParentContactMethodChange \? parentContactMethod : undefined\}\s+onChannelChange=\{onParentContactMethodChange\}\s+translate=\{!staffScreen\}/);
  });

  it('the registration is written with what the form holds', () => {
    expect(till).toMatch(/guardianName: superParentName\.trim\(\),\s*guardianPhone: superParentPhone\.trim\(\) \|\| null,\s*contactChannel: superParentContactMethod,/);
  });

  it('the form never writes the sale’s own customer number or channel', () => {
    expect(till).not.toMatch(/setCustomerPhone\(superParentPhone/);
    expect(till).not.toMatch(/onParentPhoneChange=\{setCustomerPhone\}/);
    const taken = till.match(/takeConsentAction\(action\.data, \{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(taken).toMatch(/setGuardianPhone: setSuperParentPhone,\s*setContactChannel: setSuperParentContactMethod,/);
    expect(taken).not.toMatch(/setCustomerPhone|handleCustomerContactChannelChange|setCustomerContactChannel/);
  });

  it('a paired display is sent the number and the channel with the form', () => {
    expect(till).toMatch(/guardianPhone: superParentPhone\.trim\(\)\.slice\(0, 32\),[\s\S]{0,240}?contactChannel: superParentContactMethod,\s*fees:/);
  });
});
