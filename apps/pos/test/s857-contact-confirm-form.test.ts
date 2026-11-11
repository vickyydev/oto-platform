import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentCapture, ConsentTicksStatus } from '@/components/till/ConsentCapture';
import { SupervisionGate } from '@/components/till/SupervisionGate';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import { DICTIONARY } from '@/i18n/dictionary';
import type { SupportedLang } from '@/i18n/types';

/**
 * SCRUM-857 — THE FAMILY CONFIRMS THE MESSAGING NUMBER ON THE TILL'S OWN FORM.
 *
 * The owner's ruling of 8 November: the drop-off and nanny form shows the
 * number the child's messages go to, and the family must explicitly confirm
 * it is the one for WhatsApp, Telegram or LINE. On the till's customer half
 * that is a tick-box line under the number, in the form's own style, naming
 * the chosen channel, in the customer's language. Staff's copy shows whether
 * it is confirmed; they tick it only when the till says the family's screen
 * cannot (the display is unavailable, or does not know the tick). The staff
 * gate lists it among what blocks payment. The paired display's form is in
 * s857-contact-confirm-display.test.ts.
 */

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const PHONE = '+66898020001'; // ZZ TEST numbers, used only by this fixture.

const under = (lang: SupportedLang, element: ReactElement): string => {
  vi.stubGlobal('window', {
    localStorage: { getItem: () => lang, setItem: () => undefined },
    location: { search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-857', children: element }));
};

const policy = (requirement: 'nanny' | 'drop_off' | 'none') => ({
  bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement }],
  siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true }, confirmations: [],
});
const slot = { id: 's1', name: 'ZZ TEST Mai', age: '6', waived: false, optIn: false, allergiesMedical: '', foodRestrictions: '' };

const form = (extra: Record<string, unknown> = {}) => createElement(ConsentCapture, {
  slots: [slot], parentName: 'ZZ TEST guardian', consentAck: false, policy: policy('drop_off'),
  parentPhone: PHONE, parentContactMethod: 'whatsapp',
  onParentPhoneChange: () => undefined, onParentContactMethodChange: () => undefined,
  onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
  acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined,
  contactConfirmed: false, onContactConfirmedChange: () => undefined,
  ...extra,
} as never);

/** The confirmation tick-box as drawn. */
const tick = (html: string): string => html.match(/<button\b[^>]*data-testid="consent-contact-confirm"[^>]*>/)?.[0] ?? '';

describe('the family’s side of the form, on the till’s customer half', () => {
  it.each([['WhatsApp', 'whatsapp'], ['Telegram', 'telegram'], ['LINE', 'line']] as const)(
    'under the number, a tick-box line names the chosen channel: %s', (name, channel) => {
      const html = under('en', form({ parentContactMethod: channel }));
      const field = html.search(/<input type="tel"[^>]*value="898020001"/);
      const line = html.indexOf(tFor('en')('superviseConsent.confirmContact', { channel: name }));
      const consent = html.indexOf('data-testid="consent-ack"');
      expect(field).toBeGreaterThan(-1);
      expect(line).toBeGreaterThan(field);
      expect(consent).toBeGreaterThan(line);
      expect(tick(html)).not.toBe('');
      expect(tick(html)).not.toContain('disabled=""');
      expect(tick(html)).toContain('data-state="unchecked"');
    });

  it.each(['en', 'zh', 'th', 'ru', 'fr'] as const)('%s: the line is in the customer’s language, never a raw key', (lang) => {
    const t = tFor(lang);
    const html = under(lang, form({ parentContactMethod: 'telegram' }));
    const line = t('superviseConsent.confirmContact', { channel: 'Telegram' });
    expect(line).not.toBe('superviseConsent.confirmContact');
    expect(line).toContain('Telegram');
    expect(html).toContain(line.replace(/'/g, '&#x27;'));
    expect(html).not.toContain('superviseConsent.confirmContact');
    for (const key of ['superviseConsent.confirmContact', 'superviseConsent.phoneNeeded', 'superviseConsent.phoneInvalid']) {
      expect(DICTIONARY[key]![lang], `${key} ${lang}`).toBeTruthy();
    }
  });

  it('shows the tick as given', () => {
    const html = under('en', form({ contactConfirmed: true }));
    expect(tick(html)).toContain('data-state="checked"');
  });

  it('cannot be ticked without a number, and says to add one', () => {
    const html = under('en', form({ parentPhone: '' }));
    expect(tick(html)).toContain('disabled=""');
    expect(html).toContain('data-testid="consent-contact-needed"');
    expect(html).toContain(tFor('en')('superviseConsent.phoneNeeded'));
    expect(html).not.toContain('data-testid="consent-contact-invalid"');
  });

  it.each(['+6689', '+6621234567', '0112345678'])('cannot be ticked for %s, which cannot take messages, and says so', (parentPhone) => {
    const html = under('th', form({ parentPhone }));
    expect(tick(html)).toContain('disabled=""');
    expect(html).toContain('data-testid="consent-contact-invalid"');
    expect(html).toContain(tFor('th')('superviseConsent.phoneInvalid'));
    expect(html).not.toContain('data-testid="consent-contact-needed"');
  });

  it('is not on a form whose till does not take the tick, nor where no number is asked', () => {
    expect(under('en', form({ onContactConfirmedChange: undefined }))).not.toContain('consent-contact-confirm');
    expect(under('en', form({ onParentPhoneChange: undefined, onContactConfirmedChange: undefined }))).not.toContain('consent-contact-confirm');
    // A child who needs no supervision has no parent's block at all.
    expect(under('en', form({ policy: policy('none') }))).not.toContain('consent-contact-confirm');
  });

  it('a nanny child’s form asks the same', () => {
    expect(tick(under('en', form({ policy: policy('nanny') })))).not.toBe('');
  });

  it('no visible label is renamed: the number field and the consent read as before', () => {
    expect(DICTIONARY['superviseConsent.phoneNumber']!.en).toBe('Phone number');
    const html = under('en', form());
    expect(html).toContain(tFor('en')('superviseConsent.phoneNumber'));
    expect(html).toContain(tFor('en')('superviseConsent.consentText').replace(/'/g, '&#x27;'));
  });
});

describe('staff’s copy of the form', () => {
  const staff = (extra: Record<string, unknown> = {}) => form({
    staffScreen: true, ticksReadOnly: true, contactConfirmTickable: false,
    onContactConfirmedChange: () => { throw new Error('staff ticked'); },
    ...extra,
  });

  it('shows whether the family has confirmed; staff cannot tick it while the family’s screen can', () => {
    const open = under('th', staff());
    expect(tick(open)).toContain('disabled=""');
    expect(open).toContain('the family confirms this on their screen');
    expect(open).toContain('This is my WhatsApp number');
    const confirmed = under('th', staff({ contactConfirmed: true }));
    expect(tick(confirmed)).toContain('data-state="checked"');
    expect(confirmed).toContain('confirmed by the family');
  });

  it('is tickable when the till says the family’s screen cannot show the tick, with the family beside them', () => {
    const html = under('en', staff({ contactConfirmTickable: true, onContactConfirmedChange: () => undefined }));
    expect(tick(html)).not.toContain('disabled=""');
    expect(html).toContain('ask the family, then tick with them');
  });

  it('even then, not for a number that cannot take messages', () => {
    const html = under('en', staff({ contactConfirmTickable: true, onContactConfirmedChange: () => undefined, parentPhone: '021234567' }));
    expect(tick(html)).toContain('disabled=""');
    expect(html).toContain('data-testid="consent-contact-invalid"');
  });
});

describe('the agreements status on the till', () => {
  const status = (contact: Record<string, unknown>, consentRequired = true) => renderToStaticMarkup(createElement(ConsentTicksStatus, {
    consentRequired, consentAcknowledged: true, confirmations: [], contact,
  } as never));

  it('names the channel and the number, and whether the family confirmed it', () => {
    const html = status({ phone: PHONE, channel: 'telegram', confirmed: true, by: 'family', problem: null });
    expect(html).toContain('data-testid="consent-contact-status"');
    expect(html).toContain('Telegram number +66 89 802 0001');
    expect(html).toContain('confirmed by the family');
  });

  it('says when staff gave the tick with the family, when it is not given yet, and what is wrong with the number', () => {
    expect(status({ phone: PHONE, channel: 'whatsapp', confirmed: true, by: 'staff', problem: null })).toContain('confirmed by staff with the family');
    expect(status({ phone: PHONE, channel: 'whatsapp', confirmed: false, by: null, problem: null })).toContain('not confirmed yet');
    expect(status({ phone: '', channel: 'whatsapp', confirmed: false, by: null, problem: 'empty' })).toContain('no number yet');
    // The till renders the apostrophe escaped.
    expect(status({ phone: '021234567', channel: 'line', confirmed: false, by: null, problem: 'invalid' })).toContain('doesn&#x27;t look like a mobile');
  });

  it('is not shown where no registration will be written, nor on a till that passes none', () => {
    expect(status({ phone: PHONE, channel: 'whatsapp', confirmed: false, by: null, problem: null }, false)).not.toContain('consent-contact-status');
    expect(renderToStaticMarkup(createElement(ConsentTicksStatus, { consentRequired: true, consentAcknowledged: false, confirmations: [] })))
      .not.toContain('consent-contact-status');
  });
});

describe('the staff gate before payment', () => {
  const gate = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SupervisionGate, {
    slots: [{ ...slot, childPhotoUrl: 'data:image/png;base64,zz' }], parentName: 'ZZ TEST guardian', consentAck: true, policy: policy('drop_off'),
    acknowledgedConfirmationIds: [], onUpdateSlot: () => undefined, onToggleWaiver: () => undefined, onBack: () => undefined, onContinue: () => undefined,
    ...extra,
  } as never));
  const continueButton = (html: string) => html.match(/<button[^>]*>Continue to payment<\/button>/)?.[0] ?? '';

  it('blocks payment until the family has confirmed the number', () => {
    const html = gate({ contactConfirmed: false, contactPhoneProblem: null });
    expect(html).toContain('Parent must confirm that the number is the one for their messaging channel on the customer screen.');
    expect(continueButton(html)).toContain('disabled=""');
  });

  it('and while the number is missing or cannot take messages, saying which', () => {
    const missing = gate({ contactConfirmed: false, contactPhoneProblem: 'empty' });
    expect(missing).toContain('Parent must give the number for messages about their child on the customer screen.');
    expect(continueButton(missing)).toContain('disabled=""');
    const wrong = gate({ contactConfirmed: true, contactPhoneProblem: 'invalid' });
    expect(wrong).toContain('doesn&#x27;t look like a mobile that can receive messages');
    expect(continueButton(wrong)).toContain('disabled=""');
  });

  it('lets payment through once confirmed for a number that can take messages', () => {
    const html = gate({ contactConfirmed: true, contactPhoneProblem: null });
    expect(html).not.toContain('messaging channel');
    expect(continueButton(html)).not.toContain('disabled=""');
  });

  it('a till that passes neither (the phone till) is gated as before', () => {
    expect(continueButton(gate())).not.toContain('disabled=""');
  });

  it('asks nothing of a group that needs no supervision', () => {
    const html = gate({ policy: policy('none'), slots: [{ ...slot, age: '12' }], contactConfirmed: false, contactPhoneProblem: 'empty' });
    expect(html).not.toContain('messaging');
    expect(continueButton(html)).not.toContain('disabled=""');
  });
});

describe('what the till does with it', () => {
  const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
  const client = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'api', 'checkin.ts'), 'utf8');

  it('every gate starts unconfirmed', () => {
    expect(till).toMatch(/setSuperParentContactMethod\(customerContactChannel\);[\s\S]{0,200}?setSuperContactConfirmation\(null\);\s*setConsentContactLegacy\(false\);/);
  });

  it('the confirmation stands for the number and channel the form holds, so an edit un-confirms it', () => {
    expect(till).toMatch(/const contactConfirmed = contactConfirmationStands\(superContactConfirmation, superParentPhone, superParentContactMethod\);/);
    // The setters are the plain ones (SCRUM-863): nothing clears by hand.
    expect(till.match(/onParentPhoneChange=\{setSuperParentPhone\}/g)).toHaveLength(2);
    expect(till.match(/onParentContactMethodChange=\{setSuperParentContactMethod\}/g)).toHaveLength(2);
  });

  it('the family ticks on the customer half, staff on their copy only when the display cannot', () => {
    expect(till).toMatch(/onContactConfirmedChange=\{\(confirmed\) => setSuperContactConfirmation\(confirmed\s*\? \{ at: new Date\(\)\.toISOString\(\), by: 'family',/);
    expect(till).toMatch(/contactConfirmTickable=\{staffTicks \|\| consentContactLegacy\}/);
    expect(till).toMatch(/by: 'staff', phone: consentFormPhone\(superParentPhone\), channel: superParentContactMethod/);
  });

  it('the registration is written with the confirmation when it stands, on the platform path only', () => {
    expect(till).toMatch(/acknowledgedConfirmationIds: superAcknowledgedConfirmationIds,[\s\S]{0,300}?contactConfirmation: superContactConfirmation && contactConfirmationStands\(superContactConfirmation, superParentPhone, superParentContactMethod\)\s*\? \{ confirmedAt: superContactConfirmation\.at, by: superContactConfirmation\.by \}\s*: null,/);
    // The counter box's own registration (an older box refuses a field it does not know) is not sent it.
    const boxSide = client.match(/BRIDGE_CHECKIN_INTENTS\.create, \{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(boxSide).not.toContain('contactConfirmation');
    expect(boxSide).toContain('contactChannel: body.contactChannel');
  });

  it('the form sent to the display carries the tick only when a registration will be written, outside canContinue', () => {
    expect(till).toMatch(/&& consentConfirmations\.every\(item => !item\.required \|\| item\.acknowledged\),\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*\.\.\.\(consentRequired \? \{ contactConfirmed \} : \{\}\),\s*\};/);
  });

  it('the staff gate and the agreements status are told', () => {
    expect(till).toMatch(/busy=\{gateSaving\}\s*contactConfirmed=\{contactConfirmed\}\s*contactPhoneProblem=\{consentContactProblem\}/);
    expect(till).toMatch(/<ConsentTicksStatus consentRequired=\{consentRequired\}[\s\S]{0,200}?contact=\{consentRequired \? \{ phone: superParentPhone, channel: superParentContactMethod, confirmed: contactConfirmed,/);
  });

  it('a Done while unconfirmed is taken as not finished, never refused for ever', () => {
    expect(till).toMatch(/const unconfirmedDone = action\.data\.action === 'done' && prompt\.data\.contactConfirmed === false\s*&& consentActionAllowed\(\{ \.\.\.prompt\.data, contactConfirmed: true \}, action\.data\);\s*if \(!unconfirmedDone && !consentActionAllowed\(prompt\.data, action\.data\)\) return false;/);
    const taken = till.match(/takeConsentAction\(action\.data, \{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(taken).toMatch(/asksContactConfirmation: prompt\.data\.contactConfirmed !== undefined,\s*contactConfirmed: prompt\.data\.contactConfirmed === true,/);
    expect(taken).toMatch(/contactConfirmationUnsupported: \(\) => setConsentContactLegacy\(true\),/);
    expect(till).toContain('The display cannot show the number confirmation: open Private child details and confirm the messaging number with the family here.');
  });
});
