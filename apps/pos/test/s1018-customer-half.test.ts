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
 * SCRUM-1018 — THE TILL'S OWN CUSTOMER HALF FOR A RETURNING FAMILY (the
 * owner's answers of 19 November), where no display is paired: the number
 * shown with no tick and only the app to choose, the parent's name from the
 * profile, the saved children shown rather than asked, and no camera for a
 * child whose last photo staff compare on the till. Staff's own copy
 * (Private child details) keeps every field to change.
 */

const PHONE = '+66898020001'; // ZZ TEST number, used only by this fixture.

describe('the till’s own customer half', () => {
  const under = (lang: SupportedLang, element: ReactElement): string => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => lang, setItem: () => undefined },
      location: { search: '' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    return renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-1018-half', children: element }));
  };
  const policy = {
    bands: [{ id: 'b', label: 'All', minAge: 0, maxAge: null, requirement: 'drop_off' }],
    siblingWaiver: { enabled: false, guardianMinAge: 18, waivableRequirement: 'drop_off', staffOnly: true },
    confirmations: [{ id: 'zz-confirm', text: 'ZZ TEST rule', required: true, order: 0 }],
  };
  const slot = { id: 's1', name: 'ZZ TEST Mai', age: '6', waived: false, optIn: true, allergiesMedical: 'ZZ TEST peanuts',
    foodRestrictions: '', savedChildId: 'zz-child-mai' };
  const half = (extra: Record<string, unknown> = {}) => createElement(ConsentCapture, {
    slots: [slot], parentName: 'ZZ TEST Ploy', consentAck: false, policy,
    parentPhone: PHONE, parentContactMethod: 'whatsapp',
    onParentPhoneChange: () => undefined, onParentContactMethodChange: () => undefined,
    onParentNameChange: () => undefined, onConsentAckChange: () => undefined, onUpdateChild: () => undefined,
    acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined,
    parentPhoneFixed: true, parentNameFixed: true, agreementsOnly: true, photoAtTillFor: ['s1'],
    onDone: () => undefined, doneReady: false,
    ...extra,
  } as never);

  it('shows the number with no tick and no box to type it, the app still to choose, in each language', () => {
    for (const lang of ['en', 'th', 'zh', 'ru', 'fr'] as const) {
      const html = under(lang, half());
      const t = tFor(lang);
      expect(html).toContain('data-testid="consent-kept-phone"');
      expect(html).not.toContain('type="tel"');
      expect(html).not.toContain('data-testid="consent-contact-confirm"');
      expect(html).toContain('WhatsApp');
      expect(html).toContain('Telegram');
      expect(html).toContain(t('till.input.phoneKept').replace(/'/g, '&#x27;'));
    }
  });

  it('shows the parent’s name from the profile and the saved child, not boxes to type them', () => {
    const html = under('en', half());
    expect(html).toContain('data-testid="consent-kept-guardian"');
    expect(html).toContain('ZZ TEST Ploy');
    expect(html).not.toContain('data-testid="consent-guardian"');
    expect(html).toContain('data-testid="consent-child-shown"');
    expect(html).not.toContain('data-testid="consent-child-name"');
    // The care notes stay on the profile (the screen says to tell the team).
    expect(html).toContain('data-testid="consent-care-saved"');
    expect(html).not.toContain('ZZ TEST peanuts');
    // The agreements are asked.
    expect(html).toContain('data-testid="consent-ack"');
    expect(html).toContain('ZZ TEST rule');
  });

  it('asks no photo of a child whose last photo staff compare on the till; asks it once staff take a new one', () => {
    const t = tFor('en');
    expect(under('en', half())).not.toContain(t('superviseConsent.photoTitle'));
    expect(under('en', half({ photoAtTillFor: [] }))).toContain(t('superviseConsent.photoTitle'));
  });

  it('after a waiver, with nobody to register, nothing is asked: the family is told all is set', () => {
    const waiverPolicy = {
      bands: [
        { id: 'b5', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
        { id: 'b9', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
      ],
      siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
      confirmations: [{ id: 'zz-confirm', text: 'ZZ TEST rule', required: true, order: 0 }],
    };
    const html = under('en', half({
      policy: waiverPolicy, parentPhoneFixed: undefined, parentNameFixed: undefined, agreementsOnly: undefined, photoAtTillFor: undefined,
      slots: [{ ...slot, id: 'mai', savedChildId: undefined, waived: true },
        { ...slot, id: 'tom', name: 'ZZ TEST Tom', age: '10', savedChildId: undefined, optIn: false }],
      doneReady: true,
    }));
    expect(html).not.toContain('ZZ TEST rule');
    expect(html).not.toContain('data-testid="consent-ack"');
    expect(html).toContain(tFor('en')('superviseConsent.allSetTitle').replace(/'/g, '&#x27;'));
    expect(html).not.toContain('data-testid="consent-missing"');
  });

  it('staff’s own copy keeps every field to change, as before', () => {
    const html = under('en', half({ staffScreen: true, parentPhoneFixed: undefined, parentNameFixed: undefined,
      agreementsOnly: undefined, photoAtTillFor: undefined, onDone: undefined }));
    expect(html).toMatch(/<input type="tel"[^>]*value="898020001"/);
    expect(html).toContain('data-testid="consent-guardian"');
    expect(html).toContain('data-testid="consent-child-name"');
    expect(html).toContain('ZZ TEST peanuts');
  });
});
