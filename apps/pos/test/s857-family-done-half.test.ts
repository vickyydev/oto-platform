import * as React from 'react';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { LanguageProvider, tFor } from '@/i18n/LanguageContext';
import type { SupportedLang } from '@/i18n/types';

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

/**
 * SCRUM-857 / SCRUM-875 — THE FAMILY'S DONE ON THE TILL'S OWN CUSTOMER HALF.
 *
 * The owner's ruling of 8 November: no staff confirmation once the family
 * has filled everything in and every check passes. The customer half of the
 * till's split screen gets the Done the paired display already has, in the
 * same style: it waits for every check (the till's own reading), a short line
 * in the customer's language says what is still missing, and while the till
 * writes the registration the bar says so. Staff's private copy has none.
 * The paired display is in s857-family-done-form.test.ts.
 */

const PHONE = '+66898020001'; // ZZ TEST numbers, used only by this fixture.

describe('the till’s own customer half', () => {
  const under = (lang: SupportedLang, element: ReactElement): string => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => lang, setItem: () => undefined },
      location: { search: '' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-857-done', children: element }));
  };
  const policy = {
    bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'drop_off' }],
    siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true },
    confirmations: [{ id: 'zz-confirm', text: 'ZZ TEST rule', required: true, order: 0 }],
  };
  const slot = { id: 's1', name: 'ZZ TEST Mai', age: '6', waived: false, optIn: false, allergiesMedical: '', foodRestrictions: '',
    childPhotoUrl: 'data:image/png;base64,AAAA' };
  const half = (extra: Record<string, unknown> = {}) => createElement(ConsentCapture, {
    slots: [slot], parentName: 'ZZ TEST guardian', consentAck: true, policy,
    parentPhone: PHONE, parentContactMethod: 'whatsapp',
    onParentPhoneChange: () => undefined, onParentContactMethodChange: () => undefined,
    onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
    acknowledgedConfirmationIds: ['zz-confirm'], onToggleConfirmation: () => undefined,
    contactConfirmed: true, onContactConfirmedChange: () => undefined,
    onDone: () => undefined, doneReady: true,
    ...extra,
  } as never);
  const doneButton = (html: string): string => html.match(/<div[^>]*data-testid="consent-done-bar"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';

  it('a finished form offers Done, with no line', () => {
    const html = under('en', half());
    expect(doneButton(html)).toContain('>Done</button>');
    expect(doneButton(html)).not.toContain('disabled=""');
    expect(html).not.toContain('data-testid="consent-missing"');
  });

  it.each([
    ['the number not confirmed', { contactConfirmed: false, doneReady: false }, 'superviseConsent.missingContact'],
    ['no photo yet', { slots: [{ ...slot, childPhotoUrl: undefined }], doneReady: false }, 'superviseConsent.missingPhoto'],
    ['the consent not ticked', { consentAck: false, doneReady: false }, 'superviseConsent.missingConsent'],
    ['a confirmation not ticked', { acknowledgedConfirmationIds: [], doneReady: false }, 'superviseConsent.missingConfirmations'],
    ['no name', { parentName: '', doneReady: false }, 'superviseConsent.missingGuardianName'],
  ] as const)('%s: Done waits and the line names it, in the customer’s language', (_name, extra, key) => {
    for (const lang of ['en', 'th', 'zh', 'ru', 'fr'] as const) {
      const html = under(lang, half(extra));
      const t = tFor(lang);
      expect(doneButton(html)).toContain('disabled=""');
      const line = html.match(/data-testid="consent-missing"[^>]*>([^<]*)</)?.[1] ?? '';
      expect(line.length).toBeGreaterThan(0);
      expect(html).toContain(t(key, { channel: 'WhatsApp' }).replace(/'/g, '&#x27;'));
      expect(line).not.toContain('superviseConsent.');
    }
  });

  it('while the till saves, the bar says so; a Done that could not be saved says that', () => {
    expect(under('en', half({ doneBusy: true }))).toContain(tFor('en')('superviseConsent.finishing'));
    expect(under('en', half({ doneBusy: true }))).not.toContain('>Done</button>');
    expect(under('en', half({ doneNotSaved: true }))).toContain(tFor('en')('superviseConsent.notSaved').replace(/'/g, '&#x27;'));
  });

  it('staff’s private copy, and any form given no Done, has no Done bar', () => {
    expect(under('en', half({ onDone: undefined }))).not.toContain('consent-done-bar');
    expect(under('en', half({ onDone: undefined, staffScreen: true }))).not.toContain('consent-done-bar');
  });
});
